import os
import asyncio
import time
from datetime import datetime, timezone
from typing import Dict, List, Tuple

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
)
from auth import get_current_uid, verify_token
from hinting_engine import build_engine
from firebase_service import FirebaseService
from languages import normalize_language
from progress import build_progress, pacing_summary, review_due_concepts
from session_store import build_session_store, code_fingerprint


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


def _utc_today():
    return datetime.now(timezone.utc).date()


async def _cached_profile(uid: str) -> dict:
    now = time.monotonic()
    hit = _profile_cache.get(uid)
    if hit and now - hit[0] < PROFILE_TTL_SECONDS:
        return hit[1]
    data = await asyncio.to_thread(firebase.get_user_profile_sync, uid)
    _profile_cache[uid] = (now, data)
    if len(_profile_cache) > 5000:
        _profile_cache.clear()
    return data


@app.get("/health", response_model=HealthResponse)
async def health() -> HealthResponse:
    return HealthResponse(status="ok", service="edupeer-backend")


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


@app.post("/hint", response_model=HintResponse)
async def hint(req: HintRequest, uid: str = Depends(get_current_uid)) -> HintResponse:
    if not req.question.strip():
        raise HTTPException(status_code=400, detail="question must not be empty")

    if req.mode == "hint":
        level = await asyncio.to_thread(
            store.next_hint_level, uid, code_fingerprint(req.code)
        )
    else:
        level = req.hint_level

    language = normalize_language(req.language)
    history = [turn.model_dump() for turn in req.history]

    pacing = ""
    if req.mode == "hint":
        profile = await _cached_profile(uid)
        goal = profile.get("goal") or {}
        pacing = pacing_summary(
            profile.get("concept_stats"),
            goal_text=str(goal.get("text", "")) if isinstance(goal, dict) else "",
        )

    try:
        hint_text, concept_tags = await asyncio.to_thread(
            engine.generate_hint,
            req.code, req.question, level, language, history, req.mode, pacing,
        )
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"LLM error: {e}")

    is_new_session = await asyncio.to_thread(store.begin_session, uid)

    firebase.fire_and_forget(
        user_id=uid,
        code_snippet=req.code,
        question=req.question,
        hint_level_used=level,
        concept_tags=concept_tags,
        new_session=is_new_session,
        language=language,
    )

    return HintResponse(hint=hint_text, hint_level=level, concept_tags=concept_tags)


@app.post("/hint/stream")
async def hint_stream(req: HintRequest, uid: str = Depends(get_current_uid)):
    """Server-sent-events variant of /hint: meta, delta..., done."""
    if not req.question.strip():
        raise HTTPException(status_code=400, detail="question must not be empty")

    if req.mode == "hint":
        level = await asyncio.to_thread(
            store.next_hint_level, uid, code_fingerprint(req.code)
        )
    else:
        level = req.hint_level

    language = normalize_language(req.language)
    history = [turn.model_dump() for turn in req.history]

    pacing = ""
    if req.mode == "hint":
        profile = await _cached_profile(uid)
        goal = profile.get("goal") or {}
        pacing = pacing_summary(
            profile.get("concept_stats"),
            goal_text=str(goal.get("text", "")) if isinstance(goal, dict) else "",
        )

    def sse(payload: dict) -> str:
        return f"data: {json.dumps(payload)}\n\n"

    def event_source():
        yield sse({"type": "meta", "hint_level": level})
        done = None
        try:
            for event in engine.stream_hint(
                req.code, req.question, level, language, history, req.mode, pacing
            ):
                if event.get("type") == "done":
                    done = event
                yield sse(event)
        except Exception as e:
            yield sse({"type": "error", "message": f"LLM error: {e}"})
            return
        if done is not None:
            # This generator runs on a worker thread (no event loop), so log
            # synchronously here instead of via fire_and_forget.
            is_new_session = store.begin_session(uid)
            firebase._log_interaction_sync(
                uid, req.code, req.question, level, done["concept_tags"], language
            )
            firebase._update_user_and_award_badges_sync(
                uid, level, done["concept_tags"], is_new_session, language
            )

    return StreamingResponse(event_source(), media_type="text/event-stream")


@app.post("/reset")
async def reset_session(uid: str = Depends(get_current_uid)):
    summary = ""
    interactions = await asyncio.to_thread(firebase.get_recent_interactions_sync, uid, 10)
    if interactions:
        try:
            summary = await asyncio.to_thread(engine.summarize_session, interactions)
        except Exception as e:
            print(f"[reset] summary failed: {e}")
            summary = ""
        if summary:
            await asyncio.to_thread(firebase.append_session_summary_sync, uid, summary)
    await asyncio.to_thread(store.reset, uid)
    _profile_cache.pop(uid, None)
    return {"status": "reset", "user_id": uid, "summary": summary}


@app.get("/progress")
async def get_progress(uid: str = Depends(get_current_uid)):
    data = await asyncio.to_thread(firebase.get_user_profile_sync, uid)
    return build_progress(data, _utc_today())


@app.get("/review")
async def get_review(
    language: str = "python",
    exercise: bool = True,
    uid: str = Depends(get_current_uid),
):
    data = await _cached_profile(uid)
    concepts = review_due_concepts(data.get("concept_stats"), _utc_today())
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
async def set_goal(req: GoalRequest, uid: str = Depends(get_current_uid)):
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
async def scan(req: ScanRequest, uid: str = Depends(get_current_uid)) -> ScanResponse:
    if not req.code.strip():
        return ScanResponse(flags=[])
    try:
        raw_flags = await asyncio.to_thread(
            engine.scan_code, req.code, normalize_language(req.language)
        )
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"LLM error: {e}")
    return ScanResponse(flags=[LineFlag(**f) for f in raw_flags])


@app.post("/line-hint", response_model=LineHintResponse)
async def line_hint(req: LineHintRequest, uid: str = Depends(get_current_uid)) -> LineHintResponse:
    if not req.code.strip():
        return LineHintResponse(hint="", concept="general")
    try:
        hint_text, concept = await asyncio.to_thread(
            engine.generate_line_hint, req.code, req.line, normalize_language(req.language)
        )
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"LLM error: {e}")
    return LineHintResponse(hint=hint_text, concept=concept)
