import pytest
from fastapi import HTTPException

import auth


def test_missing_header_raises_401():
    with pytest.raises(HTTPException) as exc:
        auth.get_current_uid("")
    assert exc.value.status_code == 401


def test_non_bearer_scheme_raises_401():
    with pytest.raises(HTTPException) as exc:
        auth.get_current_uid("Basic abc123")
    assert exc.value.status_code == 401


def test_valid_token_returns_uid(monkeypatch):
    monkeypatch.setattr(auth.firebase_auth, "verify_id_token", lambda t: {"uid": "user-123"})
    assert auth.get_current_uid("Bearer good-token") == "user-123"


def test_invalid_token_raises_401(monkeypatch):
    def boom(_):
        raise ValueError("expired")

    monkeypatch.setattr(auth.firebase_auth, "verify_id_token", boom)
    with pytest.raises(HTTPException) as exc:
        auth.get_current_uid("Bearer bad-token")
    assert exc.value.status_code == 401


def test_token_without_uid_raises_401(monkeypatch):
    monkeypatch.setattr(auth.firebase_auth, "verify_id_token", lambda t: {})
    with pytest.raises(HTTPException) as exc:
        auth.verify_token("weird-token")
    assert exc.value.status_code == 401
