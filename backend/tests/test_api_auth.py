import os

os.environ.setdefault("GROQ_API_KEY", "test-key")
os.environ.setdefault("FIREBASE_WEB_API_KEY", "test-web-key")
os.environ.setdefault("FIREBASE_AUTH_DOMAIN", "test-project.firebaseapp.com")

import pytest
from fastapi.testclient import TestClient

import auth
import main


@pytest.fixture
def client():
    return TestClient(main.app)


@pytest.fixture
def signed_in(client):
    main.app.dependency_overrides[auth.get_current_uid] = lambda: "uid-1"
    yield client
    main.app.dependency_overrides.clear()


def test_hint_requires_auth(client):
    res = client.post("/hint", json={"code": "x=1", "question": "help"})
    assert res.status_code == 401


def test_reset_requires_auth(client):
    assert client.post("/reset").status_code == 401


def test_badges_requires_auth(client):
    assert client.get("/badges").status_code == 401


def test_scan_requires_auth(client):
    assert client.post("/scan", json={"code": "x=1"}).status_code == 401


def test_line_hint_requires_auth(client):
    assert client.post("/line-hint", json={"code": "x=1", "line": 1}).status_code == 401


def test_health_stays_public(client):
    assert client.get("/health").status_code == 200


def test_auth_config_stays_public(client):
    assert client.get("/auth/config").status_code == 200


def test_reset_uses_uid_from_token(signed_in):
    res = signed_in.post("/reset")
    assert res.status_code == 200
    assert res.json() == {"status": "reset", "user_id": "uid-1"}


def test_badges_returns_list_for_token_uid(signed_in):
    res = signed_in.get("/badges")
    assert res.status_code == 200
    assert isinstance(res.json(), list)
