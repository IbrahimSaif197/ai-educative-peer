import os
import asyncio
from typing import List

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
from languages import normalize_language
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


@app.get("/health", response_model=HealthResponse)
async def health() -> HealthResponse:
    return HealthResponse(status="ok", service="edupeer-backend")


@app.post("/hint", response_model=HintResponse)
async def hint(req: HintRequest) -> HintResponse:
    if not req.question.strip():
        raise HTTPException(status_code=400, detail="question must not be empty")

    level = await asyncio.to_thread(
        store.next_hint_level, req.user_id, code_fingerprint(req.code)
    )

    language = normalize_language(req.language)
    history = [turn.model_dump() for turn in req.history]
    try:
        hint_text, concept_tags = await asyncio.to_thread(
            engine.generate_hint, req.code, req.question, level, language, history
        )
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"LLM error: {e}")

    is_new_session = await asyncio.to_thread(store.begin_session, req.user_id)

    firebase.fire_and_forget(
        user_id=req.user_id,
        code_snippet=req.code,
        question=req.question,
        hint_level_used=level,
        concept_tags=concept_tags,
        new_session=is_new_session,
        language=language,
    )

    return HintResponse(hint=hint_text, hint_level=level, concept_tags=concept_tags)


@app.post("/reset")
async def reset_session(req: ResetSessionRequest):
    await asyncio.to_thread(store.reset, req.user_id)
    return {"status": "reset", "user_id": req.user_id}


@app.get("/badges/{user_id}")
async def get_badges(user_id: str) -> List[str]:
    return await asyncio.to_thread(firebase.get_user_badges_sync, user_id)


@app.post("/scan", response_model=ScanResponse)
async def scan(req: ScanRequest) -> ScanResponse:
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
async def line_hint(req: LineHintRequest) -> LineHintResponse:
    if not req.code.strip():
        return LineHintResponse(hint="", concept="general")
    try:
        hint_text, concept = await asyncio.to_thread(
            engine.generate_line_hint, req.code, req.line, normalize_language(req.language)
        )
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"LLM error: {e}")
    return LineHintResponse(hint=hint_text, concept=concept)
