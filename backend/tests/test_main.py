import sys
import os
import types
import pytest
from unittest.mock import MagicMock, patch


# ---------------------------------------------------------------------------
# Patch heavy optional dependencies before importing the app
# ---------------------------------------------------------------------------

def _stub_firebase():
    admin_mock = MagicMock()
    admin_mock._apps = {}
    cred_mock = MagicMock()
    fs_mock = MagicMock()
    fs_mock.SERVER_TIMESTAMP = "SERVER_TS"
    sys.modules.setdefault("firebase_admin", admin_mock)
    sys.modules.setdefault("firebase_admin.credentials", cred_mock)
    sys.modules.setdefault("firebase_admin.firestore", fs_mock)
    return admin_mock, cred_mock, fs_mock


_stub_firebase()

os.environ.setdefault("GROQ_API_KEY", "test-groq-key")
os.environ.setdefault("FIREBASE_PROJECT_ID", "test-project")
os.environ.setdefault("FIREBASE_PRIVATE_KEY", "test-pk")
os.environ.setdefault("FIREBASE_CLIENT_EMAIL", "test@test.iam.gserviceaccount.com")


def _make_groq_mock(hint_text: str):
    message = MagicMock()
    message.content = hint_text
    choice = MagicMock()
    choice.message = message
    resp = MagicMock()
    resp.choices = [choice]
    client = MagicMock()
    client.chat.completions.create.return_value = resp
    return client


@pytest.fixture(autouse=True)
def _patch_groq_client(monkeypatch):
    """Prevent real Groq calls in every test."""
    hint_text = "Have you considered the type? What do you think should happen next?"
    mock_client = _make_groq_mock(hint_text)

    import hinting_engine
    monkeypatch.setattr(hinting_engine, "Groq", lambda **_: mock_client)

    # Also patch the already-created engine inside main
    import main as app_main
    app_main.engine.client = mock_client
    return mock_client


@pytest.fixture()
def client():
    from fastapi.testclient import TestClient
    import main as app_main
    from session_store import InMemorySessionStore
    # Fresh, isolated session state per test.
    app_main.store = InMemorySessionStore()
    with TestClient(app_main.app) as c:
        yield c


# ---------------------------------------------------------------------------
# /health
# ---------------------------------------------------------------------------

class TestHealth:
    def test_returns_ok(self, client):
        res = client.get("/health")
        assert res.status_code == 200
        data = res.json()
        assert data["status"] == "ok"
        assert data["service"] == "edupeer-backend"


# ---------------------------------------------------------------------------
# /hint
# ---------------------------------------------------------------------------

VALID_HINT_PAYLOAD = {
    "code": "def add(a, b):\n    return a - b",
    "question": "Why is my add function wrong?",
    "user_id": "test-user-1",
    "hint_level": 1,
}


class TestHintEndpoint:
    def test_valid_request_returns_200(self, client):
        res = client.post("/hint", json=VALID_HINT_PAYLOAD)
        assert res.status_code == 200

    def test_response_has_required_fields(self, client):
        res = client.post("/hint", json=VALID_HINT_PAYLOAD)
        data = res.json()
        assert "hint" in data
        assert "hint_level" in data
        assert "concept_tags" in data

    def test_hint_level_starts_at_1(self, client):
        res = client.post("/hint", json=VALID_HINT_PAYLOAD)
        assert res.json()["hint_level"] == 1

    def test_hint_level_increments_on_repeat(self, client):
        client.post("/hint", json=VALID_HINT_PAYLOAD)
        res2 = client.post("/hint", json=VALID_HINT_PAYLOAD)
        assert res2.json()["hint_level"] == 2

    def test_hint_level_caps_at_3(self, client):
        for _ in range(5):
            res = client.post("/hint", json=VALID_HINT_PAYLOAD)
        assert res.json()["hint_level"] == 3

    def test_empty_question_returns_400(self, client):
        payload = {**VALID_HINT_PAYLOAD, "question": ""}
        res = client.post("/hint", json=payload)
        assert res.status_code == 400

    def test_whitespace_question_returns_400(self, client):
        payload = {**VALID_HINT_PAYLOAD, "question": "   "}
        res = client.post("/hint", json=payload)
        assert res.status_code == 400

    def test_missing_question_returns_422(self, client):
        payload = {k: v for k, v in VALID_HINT_PAYLOAD.items() if k != "question"}
        res = client.post("/hint", json=payload)
        assert res.status_code == 422

    def test_missing_user_id_returns_422(self, client):
        payload = {k: v for k, v in VALID_HINT_PAYLOAD.items() if k != "user_id"}
        res = client.post("/hint", json=payload)
        assert res.status_code == 422

    def test_different_code_resets_counter(self, client):
        client.post("/hint", json=VALID_HINT_PAYLOAD)
        client.post("/hint", json=VALID_HINT_PAYLOAD)
        different_code_payload = {**VALID_HINT_PAYLOAD, "code": "x = 10"}
        res = client.post("/hint", json=different_code_payload)
        assert res.json()["hint_level"] == 1

    def test_different_user_independent_counter(self, client):
        client.post("/hint", json=VALID_HINT_PAYLOAD)
        client.post("/hint", json=VALID_HINT_PAYLOAD)
        payload_user2 = {**VALID_HINT_PAYLOAD, "user_id": "test-user-2"}
        res = client.post("/hint", json=payload_user2)
        assert res.json()["hint_level"] == 1

    def test_hint_contains_socratic_question(self, client):
        res = client.post("/hint", json=VALID_HINT_PAYLOAD)
        assert "What do you think should happen next?" in res.json()["hint"]

    def test_concept_tags_is_list(self, client):
        res = client.post("/hint", json=VALID_HINT_PAYLOAD)
        assert isinstance(res.json()["concept_tags"], list)

    def test_empty_code_accepted(self, client):
        payload = {**VALID_HINT_PAYLOAD, "code": ""}
        res = client.post("/hint", json=payload)
        assert res.status_code == 200


# ---------------------------------------------------------------------------
# /reset
# ---------------------------------------------------------------------------

class TestResetEndpoint:
    def test_reset_clears_hint_level(self, client):
        client.post("/hint", json=VALID_HINT_PAYLOAD)
        client.post("/hint", json=VALID_HINT_PAYLOAD)
        client.post("/reset", json={"user_id": VALID_HINT_PAYLOAD["user_id"]})
        res = client.post("/hint", json=VALID_HINT_PAYLOAD)
        assert res.json()["hint_level"] == 1

    def test_reset_returns_confirmation(self, client):
        res = client.post("/reset", json={"user_id": "u1"})
        assert res.status_code == 200
        data = res.json()
        assert data["status"] == "reset"
        assert data["user_id"] == "u1"

    def test_reset_unknown_user_returns_200(self, client):
        res = client.post("/reset", json={"user_id": "nobody"})
        assert res.status_code == 200


# ---------------------------------------------------------------------------
# /badges/{user_id}
# ---------------------------------------------------------------------------

class TestBadgesEndpoint:
    def test_returns_list(self, client):
        res = client.get("/badges/test-user-1")
        assert res.status_code == 200
        assert isinstance(res.json(), list)
