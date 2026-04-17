import os
import hashlib
from typing import Dict, Tuple, List

from dotenv import load_dotenv

load_dotenv()
# Also attempt to load a sibling .env two levels up (project root)
_root_env = os.path.join(os.path.dirname(os.path.dirname(__file__)), ".env")
if os.path.exists(_root_env):
    load_dotenv(_root_env, override=False)

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware

from models import (
    HintRequest,
    HintResponse,
    HealthResponse,
    ResetSessionRequest,
    ScanRequest,
    ScanResponse,
    LineFlag,
    LineHintRequest,
    LineHintResponse,
)
from hinting_engine import build_engine
from firebase_service import FirebaseService


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


_session_state: Dict[Tuple[str, str], int] = {}
_session_started: Dict[str, bool] = {}


def _code_fingerprint(code: str) -> str:
    normalized = "\n".join(line.rstrip() for line in code.strip().splitlines())
    return hashlib.sha1(normalized.encode("utf-8")).hexdigest()


def _next_hint_level(user_id: str, code: str) -> int:
    key = (user_id, _code_fingerprint(code))
    current = _session_state.get(key, 0)
    new_level = min(3, current + 1)
    _session_state[key] = new_level
    return new_level


@app.get("/health", response_model=HealthResponse)
async def health() -> HealthResponse:
    return HealthResponse(status="ok", service="edupeer-backend")


@app.post("/hint", response_model=HintResponse)
async def hint(req: HintRequest) -> HintResponse:
    if not req.question.strip():
        raise HTTPException(status_code=400, detail="question must not be empty")

    level = _next_hint_level(req.user_id, req.code)

    try:
        hint_text, concept_tags = engine.generate_hint(req.code, req.question, level)
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"LLM error: {e}")

    is_new_session = not _session_started.get(req.user_id, False)
    _session_started[req.user_id] = True

    firebase.fire_and_forget(
        user_id=req.user_id,
        code_snippet=req.code,
        question=req.question,
        hint_level_used=level,
        concept_tags=concept_tags,
        new_session=is_new_session,
    )

    return HintResponse(hint=hint_text, hint_level=level, concept_tags=concept_tags)


@app.post("/reset")
async def reset_session(req: ResetSessionRequest):
    prefix = req.user_id
    keys_to_remove = [k for k in _session_state.keys() if k[0] == prefix]
    for k in keys_to_remove:
        _session_state.pop(k, None)
    _session_started.pop(prefix, None)
    return {"status": "reset", "user_id": req.user_id}


@app.get("/badges/{user_id}")
async def get_badges(user_id: str) -> List[str]:
    return firebase.get_user_badges_sync(user_id)


@app.post("/scan", response_model=ScanResponse)
async def scan(req: ScanRequest) -> ScanResponse:
    if not req.code.strip():
        return ScanResponse(flags=[])
    try:
        raw_flags = engine.scan_code(req.code)
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"LLM error: {e}")
    return ScanResponse(flags=[LineFlag(**f) for f in raw_flags])


@app.post("/line-hint", response_model=LineHintResponse)
async def line_hint(req: LineHintRequest) -> LineHintResponse:
    if not req.code.strip():
        return LineHintResponse(hint="", concept="general")
    try:
        hint_text, concept = engine.generate_line_hint(req.code, req.line)
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"LLM error: {e}")
    return LineHintResponse(hint=hint_text, concept=concept)
