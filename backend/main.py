import os
import asyncio
from typing import List

from dotenv import load_dotenv

load_dotenv()
# Also attempt to load a sibling .env two levels up (project root)
_root_env = os.path.join(os.path.dirname(os.path.dirname(__file__)), ".env")
if os.path.exists(_root_env):
    load_dotenv(_root_env, override=False)

from fastapi import Depends, FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import HTMLResponse

from models import (
    HintRequest,
    HintResponse,
    HealthResponse,
    ScanRequest,
    ScanResponse,
    LineFlag,
    LineHintRequest,
    LineHintResponse,
)
from auth import get_current_uid
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


@app.post("/hint", response_model=HintResponse)
async def hint(req: HintRequest, uid: str = Depends(get_current_uid)) -> HintResponse:
    if not req.question.strip():
        raise HTTPException(status_code=400, detail="question must not be empty")

    level = await asyncio.to_thread(
        store.next_hint_level, uid, code_fingerprint(req.code)
    )

    language = normalize_language(req.language)
    history = [turn.model_dump() for turn in req.history]
    try:
        hint_text, concept_tags = await asyncio.to_thread(
            engine.generate_hint, req.code, req.question, level, language, history
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


@app.post("/reset")
async def reset_session(uid: str = Depends(get_current_uid)):
    await asyncio.to_thread(store.reset, uid)
    return {"status": "reset", "user_id": uid}


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
