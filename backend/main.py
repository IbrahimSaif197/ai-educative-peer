import os
import asyncio
import math
import time
from datetime import datetime, timezone
from typing import Dict, List, Optional, Tuple

from dotenv import load_dotenv

load_dotenv()
# Also attempt to load a sibling .env two levels up (project root)
_root_env = os.path.join(os.path.dirname(os.path.dirname(__file__)), ".env")
if os.path.exists(_root_env):
    load_dotenv(_root_env, override=False)

import json

from fastapi import Depends, FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import HTMLResponse, StreamingResponse

from models import (
    HintRequest,
    HintResponse,
    HealthResponse,
    ScanRequest,
    ScanResponse,
    LineFlag,
    LineHintRequest,
    LineHintResponse,
    MigrateRequest,
    GoalRequest,
    TraceRequest,
    TraceResponse,
)
from auth import get_current_uid, verify_token
from cache import TtlCache
from hinting_engine import build_engine, effective_mode, CodeView
from firebase_service import FirebaseService
from languages import normalize_language
from progress import (
    build_progress,
    goal_concepts_of,
    pacing_summary,
    review_due_concepts,
)
from ratelimit import RateLimiterRegistry
from session_store import build_session_store, code_fingerprint, raw_code_hash


app = FastAPI(title="EduPeer Backend", version="1.0.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)

engine = build_engine()
firebase = FirebaseService()
store = build_session_store(firebase)

# Short-lived per-user profile cache so /hint doesn't hit Firestore every call.
PROFILE_TTL_SECONDS = 60.0
_profile_cache: Dict[str, Tuple[float, dict]] = {}

# The inline tutor fires these two automatically as the student types, so an
# unchanged file must not cost a fresh LLM call. /hint is deliberately not
# cached: the same question deserves a fresh answer, and its level advances.
SCAN_CACHE = TtlCache(ttl_seconds=300.0, max_entries=1000)
LINE_HINT_CACHE = TtlCache(ttl_seconds=300.0, max_entries=2000)

# Per-user budgets protecting the Groq free tier: (requests, per seconds).
# Every endpoint that can reach the LLM has a bucket — /reset, /goal and
# /review each summarise or generate through Groq, so leaving them ungated
# would have let one user drain the shared free tier from three side doors.
limiters = RateLimiterRegistry(
    {
        "hint": (30, 60.0),
        "inline": (60, 60.0),
        "trace": (10, 60.0),
        "session": (10, 60.0),
        "review": (6, 60.0),
    }
)


def rate_limited(bucket: str):
    """FastAPI dependency: verify the token, then spend a rate-limit token."""

    async def dependency(uid: str = Depends(get_current_uid)) -> str:
        allowed, retry_after = limiters.check(bucket, uid)
        if not allowed:
            raise HTTPException(
                status_code=429,
                detail="EduPeer is getting a lot of questions from you — give it a moment.",
                headers={"Retry-After": str(max(1, math.ceil(retry_after)))},
            )
        return uid

    return dependency


def _utc_today():
    return datetime.now(timezone.utc).date()


async def _cached_profile(uid: str) -> dict:
    now = time.monotonic()
    hit = _profile_cache.get(uid)
    if hit and now - hit[0] < PROFILE_TTL_SECONDS:
        return hit[1]
    data = await asyncio.to_thread(firebase.try_get_user_profile_sync, uid)
    if data is None:
        # A failed read is not an empty profile. Caching it would blank the
        # student's pacing and review state for the whole TTL, so serve the
        # last good value (even if stale) and re-read on the next request.
        return hit[1] if hit else {}
    _profile_cache[uid] = (now, data)
    if len(_profile_cache) > 5000:
        _profile_cache.clear()
    return data


@app.get("/health", response_model=HealthResponse)
async def health() -> HealthResponse:
    # `status` stays "ok" whenever the process is serving, so Render's health
    # check and the extension's reachability probe keep their meaning. Firestore
    # is reported separately: a bad service-account key leaves every feature
    # working except persistence, which is otherwise invisible until a student
    # notices their progress never saved. The reason is deliberately not
    # exposed here — it goes to the logs, since this endpoint is public.
    return HealthResponse(
        status="ok",
        service="edupeer-backend",
        firestore="ok" if firebase.enabled else "unavailable",
    )


_STATIC_DIR = os.path.join(os.path.dirname(__file__), "static")


@app.get("/auth/config")
async def auth_config():
    """Public Firebase web-app config (not secrets) for the extension."""
    return {
        "apiKey": os.environ.get("FIREBASE_WEB_API_KEY", ""),
        "authDomain": os.environ.get("FIREBASE_AUTH_DOMAIN", ""),
    }


@app.get("/auth/login", response_class=HTMLResponse)
async def auth_login():
    with open(os.path.join(_STATIC_DIR, "auth.html"), encoding="utf-8") as f:
        html = f.read()
    html = html.replace("__FIREBASE_API_KEY__", os.environ.get("FIREBASE_WEB_API_KEY", ""))
    html = html.replace("__FIREBASE_AUTH_DOMAIN__", os.environ.get("FIREBASE_AUTH_DOMAIN", ""))
    return HTMLResponse(html)


@app.post("/auth/migrate")
async def migrate(req: MigrateRequest, uid: str = Depends(get_current_uid)):
    """Merge progress from a previous identity into the signed-in account.

    old_id_token proves ownership of the previous (anonymous) Firebase
    account. legacy_user_id covers pre-auth random IDs, which were never
    verifiable, so merging them is best-effort by design.
    """
    sources: List[str] = []
    if req.old_id_token:
        old_uid = verify_token(req.old_id_token)
        if old_uid != uid:
            sources.append(old_uid)
    # Legacy pre-auth IDs always start with "user-" (from the old
    # randomUserId()); real Firebase UIDs never do. Without this check, a
    # caller could pass another user's UID and have their doc merged away.
    if req.legacy_user_id and req.legacy_user_id != uid and req.legacy_user_id.startswith("user-"):
        sources.append(req.legacy_user_id)

    merged = 0
    for source in sources:
        if await asyncio.to_thread(firebase.merge_user_sync, source, uid):
            merged += 1
    return {"status": "ok", "merged": merged}


def _ladder_key(req: HintRequest) -> str:
    """What the hint ladder is keyed on: the problem, not the bytes.

    Keying on a hash of the code made editing the file reset the ladder to
    level 1 — the exact opposite of the promise the extension makes ("editing
    the code unlocks a deeper hint"), because any edit produced an unseen key.
    The client sends the document URI as `problem_key`, which stays stable
    across edits; `escalate` alone then decides whether the level advances.
    Older clients that send no key keep the previous code-fingerprint
    behaviour.
    """
    return req.problem_key.strip() or code_fingerprint(req.code)


async def _resolve_hint_level(req: HintRequest, uid: str) -> int:
    """The level this request should answer at, WITHOUT spending it.

    Only 'hint' mode is progressive, and it only advances when the client says
    the student actually changed something (`escalate`). Asking the same
    question again on untouched code re-uses the level instead of walking the
    student to a free pseudocode answer.

    Nothing is persisted here. `_commit_hint_level` runs only once a hint has
    actually been produced, so a failed LLM call never costs the student a
    level.
    """
    if req.mode != "hint":
        return req.hint_level
    return await asyncio.to_thread(
        store.peek_hint_level, uid, _ladder_key(req), req.escalate
    )


def _commit_hint_level(req: HintRequest, uid: str, level: int) -> None:
    """Spend the level, now that the student has the hint in hand."""
    if req.mode != "hint":
        return
    store.commit_hint_level(uid, _ladder_key(req), level)


async def _pacing_for(req: HintRequest, uid: str) -> str:
    if req.mode != "hint":
        return ""
    profile = await _cached_profile(uid)
    goal = profile.get("goal") or {}
    return pacing_summary(
        profile.get("concept_stats"),
        goal_text=str(goal.get("text", "")) if isinstance(goal, dict) else "",
        goal_concepts=goal_concepts_of(profile),
    )


def _view_for(req) -> Tuple[Optional[CodeView], Optional[tuple]]:
    """The request's code view, and a hashable key for the cache.

    Two different band sets over identical digest text describe different
    lines, so the bands are part of the key. Without bands there is no view
    and the engine falls back to whole-file numbering.
    """
    if not req.bands:
        return None, None
    bands = [b.model_dump() for b in req.bands]
    key = tuple((b["start"], b["end"]) for b in bands)
    return CodeView.of(req.code, bands, req.total_lines), key


@app.post("/hint", response_model=HintResponse)
async def hint(req: HintRequest, uid: str = Depends(rate_limited("hint"))) -> HintResponse:
    if not req.question.strip():
        raise HTTPException(status_code=400, detail="question must not be empty")

    level = await _resolve_hint_level(req, uid)
    language = normalize_language(req.language)
    history = [turn.model_dump() for turn in req.history]
    pacing = await _pacing_for(req, uid)
    # /hint is never cached (see SCAN_CACHE/LINE_HINT_CACHE above), so only
    # the view itself is needed here - the second, cache-key half of
    # `_view_for`'s return is for /scan and /line-hint to use.
    view, _ = _view_for(req)

    try:
        hint_text, concept_tags = await asyncio.to_thread(
            engine.generate_hint,
            req.code, req.question, level, language, history, req.mode, pacing,
            req.edit_summary, req.focus.model_dump() if req.focus else None,
            view=view,
        )
    except Exception as e:
        # The level was only peeked, never committed, so the student can retry
        # at the same depth.
        raise HTTPException(status_code=502, detail=f"LLM error: {e}")

    await asyncio.to_thread(_commit_hint_level, req, uid, level)
    is_new_session = await asyncio.to_thread(store.begin_session, uid)

    firebase.fire_and_forget(
        user_id=uid,
        code_snippet=req.code,
        question=req.question,
        hint_level_used=level,
        concept_tags=concept_tags,
        new_session=is_new_session,
        language=language,
        confidence=req.confidence,
        mode=req.mode,
    )

    return HintResponse(
        hint=hint_text,
        hint_level=level,
        concept_tags=concept_tags,
        mode=effective_mode(req.mode, level),
    )


@app.post("/hint/stream")
async def hint_stream(req: HintRequest, uid: str = Depends(rate_limited("hint"))):
    """Server-sent-events variant of /hint: meta, delta..., done."""
    if not req.question.strip():
        raise HTTPException(status_code=400, detail="question must not be empty")

    level = await _resolve_hint_level(req, uid)
    language = normalize_language(req.language)
    history = [turn.model_dump() for turn in req.history]
    pacing = await _pacing_for(req, uid)
    # Same reasoning as /hint: streaming is never cached, so only the view
    # itself is needed here.
    view, _ = _view_for(req)

    def sse(payload: dict) -> str:
        return f"data: {json.dumps(payload)}\n\n"

    def event_source():
        yield sse({"type": "meta", "hint_level": level, "mode": effective_mode(req.mode, level)})
        done = None
        try:
            for event in engine.stream_hint(
                req.code, req.question, level, language, history, req.mode, pacing,
                req.edit_summary, req.focus.model_dump() if req.focus else None,
                view=view,
            ):
                if event.get("type") == "done":
                    done = event
                yield sse(event)
        except Exception as e:
            yield sse({"type": "error", "message": f"LLM error: {e}"})
            return
        if done is not None:
            # This generator runs on a worker thread (no event loop), so log
            # synchronously here instead of via fire_and_forget. Reaching this
            # point is what spends the level: a stream that errored out above
            # returned early and committed nothing.
            _commit_hint_level(req, uid, level)
            is_new_session = store.begin_session(uid)
            firebase._log_interaction_sync(
                uid, req.code, req.question, level, done["concept_tags"], language,
                req.confidence, req.mode,
            )
            firebase._update_user_and_award_badges_sync(
                uid, level, done["concept_tags"], is_new_session, language,
                req.confidence, req.mode,
            )

    return StreamingResponse(event_source(), media_type="text/event-stream")


@app.post("/reset")
async def reset_session(uid: str = Depends(rate_limited("session"))):
    """Clear the session, and hand back a "what you learned" note if there is one.

    Four Firestore/LLM steps used to run one after another here, so pressing
    Reset cost six-to-eight serial round trips on a free-tier box. Two of them
    never depended on each other: reading the interactions to summarise, and
    wiping the session docs. They now run together, which takes a whole
    Firestore round trip out of the critical path.

    What is left is the summary itself, and that is a real LLM call the student
    does see. It stays awaited — the panel no longer waits on this response to
    clear itself (see `resetSession` in the extension), so the note arriving a
    second or two later costs nothing.
    """
    interactions, _ = await asyncio.gather(
        asyncio.to_thread(firebase.get_recent_interactions_sync, uid, 10),
        asyncio.to_thread(store.reset, uid),
    )
    _profile_cache.pop(uid, None)

    summary = ""
    if interactions:
        try:
            summary = await asyncio.to_thread(engine.summarize_session, interactions)
        except Exception as e:
            print(f"[reset] summary failed: {e}")
            summary = ""
        if summary:
            await asyncio.to_thread(firebase.append_session_summary_sync, uid, summary)
    return {"status": "reset", "user_id": uid, "summary": summary}


@app.get("/progress")
async def get_progress(uid: str = Depends(get_current_uid)):
    data = await asyncio.to_thread(firebase.get_user_profile_sync, uid)
    return build_progress(data, _utc_today())


@app.get("/review")
async def get_review(
    language: str = "python",
    exercise: bool = True,
    uid: str = Depends(rate_limited("review")),
):
    data = await _cached_profile(uid)
    concepts = review_due_concepts(
        data.get("concept_stats"), _utc_today(), goal_concepts=goal_concepts_of(data)
    )
    if not concepts:
        return {"due": False, "concepts": [], "exercise": ""}
    text = ""
    if exercise:
        question = (
            "Please give me one small review exercise about: " + ", ".join(concepts)
        )
        try:
            text, _ = await asyncio.to_thread(
                engine.generate_hint,
                "", question, 1, normalize_language(language), None, "review-exercise",
            )
        except Exception as e:
            raise HTTPException(status_code=502, detail=f"LLM error: {e}")
    return {"due": True, "concepts": concepts, "exercise": text}


@app.post("/goal")
async def set_goal(req: GoalRequest, uid: str = Depends(rate_limited("session"))):
    text = req.text.strip()
    concepts: List[str] = []
    if text:
        try:
            concepts = await asyncio.to_thread(
                engine.map_goal_to_concepts, text, normalize_language(req.language)
            )
        except Exception as e:
            print(f"[goal] concept mapping failed: {e}")
    await asyncio.to_thread(firebase.set_goal_sync, uid, text, concepts)
    _profile_cache.pop(uid, None)
    return {"status": "ok", "goal": text, "concepts": concepts}


@app.get("/badges")
async def get_badges(uid: str = Depends(get_current_uid)) -> List[str]:
    return await asyncio.to_thread(firebase.get_user_badges_sync, uid)


@app.post("/scan", response_model=ScanResponse)
async def scan(req: ScanRequest, uid: str = Depends(rate_limited("inline"))) -> ScanResponse:
    if not req.code.strip():
        return ScanResponse(flags=[])
    language = normalize_language(req.language)
    focus = req.focus.model_dump() if req.focus else None
    view, bands_key = _view_for(req)
    focus_key = (focus["start_line"], focus["end_line"]) if focus else None
    # uid is part of the key so one student's cached scan is never served to
    # another, even though the code hash alone would collide. The hash is the
    # exact one, not `code_fingerprint`: the cached flags carry absolute line
    # numbers, and a whitespace-insensitive key would serve them against a
    # file whose lines have shifted. bands_key is part of it for the same
    # reason `_view_for` exists at all: two band sets can describe identical
    # digest text but different editor lines, and serving one against the
    # other puts a flag on the wrong function.
    key = (uid, language, bands_key, focus_key, raw_code_hash(req.code))
    cached = SCAN_CACHE.get(key)
    if cached is not None:
        return ScanResponse(flags=[LineFlag(**f) for f in cached])
    try:
        raw_flags = await asyncio.to_thread(
            engine.scan_code, req.code, language, focus, view
        )
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"LLM error: {e}")
    SCAN_CACHE.set(key, raw_flags)
    return ScanResponse(flags=[LineFlag(**f) for f in raw_flags])


@app.post("/line-hint", response_model=LineHintResponse)
async def line_hint(
    req: LineHintRequest, uid: str = Depends(rate_limited("inline"))
) -> LineHintResponse:
    if not req.code.strip():
        return LineHintResponse(hint="", concept="general")
    language = normalize_language(req.language)
    focus = req.focus.model_dump() if req.focus else None
    view, bands_key = _view_for(req)
    # Exact hash, for the same reason as /scan: the entry is keyed to a line
    # number, so whitespace that shifts lines must miss the cache. focus_key
    # is part of it too, so two different focus blocks on the same line don't
    # collide and serve each other's cached answer. bands_key joins them for
    # the same reason it joins /scan's key: two band sets can describe
    # identical digest text but different editor lines, and serving one
    # against the other answers about the wrong line.
    focus_key = (focus["start_line"], focus["end_line"]) if focus else None
    key = (uid, language, req.line, focus_key, bands_key, raw_code_hash(req.code))
    cached = LINE_HINT_CACHE.get(key)
    if cached is not None:
        return LineHintResponse(hint=cached[0], concept=cached[1])
    try:
        hint_text, concept = await asyncio.to_thread(
            engine.generate_line_hint, req.code, req.line, language, focus, view
        )
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"LLM error: {e}")
    LINE_HINT_CACHE.set(key, (hint_text, concept))
    return LineHintResponse(hint=hint_text, concept=concept)


@app.post("/trace", response_model=TraceResponse)
async def trace(req: TraceRequest, uid: str = Depends(rate_limited("trace"))) -> TraceResponse:
    """Design a desk-check exercise: which variables to track, over how many steps.

    An empty response (steps == 0) means the snippet has no state worth
    tracing; the extension quietly falls back to a prediction exercise.
    """
    snippet = req.selection.strip() or req.code.strip()
    if not snippet:
        return TraceResponse()
    try:
        variables, steps, prompt = await asyncio.to_thread(
            engine.design_trace_table, snippet, normalize_language(req.language)
        )
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"LLM error: {e}")
    return TraceResponse(variables=variables, steps=steps, prompt=prompt)
