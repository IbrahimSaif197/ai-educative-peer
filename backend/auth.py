from fastapi import Header, HTTPException
from firebase_admin import auth as firebase_auth


def verify_token(id_token: str) -> str:
    """Verify a Firebase ID token and return its uid.

    Raises HTTPException(401) on any verification failure so callers can use
    it directly inside request handlers.
    """
    try:
        decoded = firebase_auth.verify_id_token(id_token)
    except Exception:
        raise HTTPException(status_code=401, detail="invalid or expired token")
    uid = decoded.get("uid")
    if not uid:
        raise HTTPException(status_code=401, detail="token has no uid")
    return uid


def get_current_uid(authorization: str = Header(default="")) -> str:
    """FastAPI dependency: extract and verify the Bearer ID token."""
    if not authorization.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="missing bearer token")
    return verify_token(authorization[len("Bearer "):])
