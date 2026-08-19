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
    """The engine's provider backend, faked. Named for the provider it used to
    stand in for; it now fakes whichever backend `build_engine` picked."""
    from tests.test_hinting_engine import RecordingBackend

    return RecordingBackend(hint_text)


@pytest.fixture(autouse=True)
def _patch_groq_client(monkeypatch):
    """Prevent real Groq calls in every test."""
    hint_text = "Have you considered the type? What do you think should happen next?"
    mock_client = _make_groq_mock(hint_text)

    import hinting_engine
    monkeypatch.setattr(
        hinting_engine, "AnthropicBackend", lambda *_a, **_k: mock_client
    )
    monkeypatch.setattr(hinting_engine, "GroqBackend", lambda *_a, **_k: mock_client)

    # Also patch the already-created engine inside main
    import main as app_main
    app_main.engine.client = mock_client
    return mock_client


@pytest.fixture()
def client():
    from fastapi.testclient import TestClient
    import main as app_main
    import auth
    from session_store import InMemorySessionStore
    # Fresh, isolated session state per test.
    app_main.store = InMemorySessionStore()
    # Guard: endpoints must read this module-global store at request time.
    # If a refactor ever stops the override from applying, fail loudly here
    # instead of silently testing against the import-time Firestore mock.
    assert isinstance(app_main.store, InMemorySessionStore)
    # Override auth to return a fixed UID for testing
    app_main.app.dependency_overrides[auth.get_current_uid] = lambda: "test-user-1"
    with TestClient(app_main.app) as c:
        yield c
    # Clear overrides after test
    app_main.app.dependency_overrides.clear()


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

    def test_reports_firestore_state(self, client, monkeypatch):
        """A failed Firebase init must be visible here, not just in the logs."""
        import main

        monkeypatch.setattr(type(main.firebase), "enabled", property(lambda _: True))
        assert client.get("/health").json()["firestore"] == "ok"

        monkeypatch.setattr(type(main.firebase), "enabled", property(lambda _: False))
        assert client.get("/health").json()["firestore"] == "unavailable"

    def test_stays_ok_when_firestore_is_down(self, client, monkeypatch):
        """Render's health check and the extension's probe both key off
        `status`, so losing Firestore must not read as the service being down."""
        import main

        monkeypatch.setattr(type(main.firebase), "enabled", property(lambda _: False))
        res = client.get("/health")
        assert res.status_code == 200
        assert res.json()["status"] == "ok"


# ---------------------------------------------------------------------------
# /hint
# ---------------------------------------------------------------------------

VALID_HINT_PAYLOAD = {
    "code": "def add(a, b):\n    return a - b",
    "question": "Why is my add function wrong?",
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

    def test_hint_level_caps_at_4(self, client):
        for _ in range(5):
            res = client.post("/hint", json=VALID_HINT_PAYLOAD)
        assert res.json()["hint_level"] == 4

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

    def test_different_code_resets_counter(self, client):
        client.post("/hint", json=VALID_HINT_PAYLOAD)
        client.post("/hint", json=VALID_HINT_PAYLOAD)
        different_code_payload = {**VALID_HINT_PAYLOAD, "code": "x = 10"}
        res = client.post("/hint", json=different_code_payload)
        assert res.json()["hint_level"] == 1

    def test_different_user_independent_counter(self, client):
        import main as app_main
        import auth
        # User 1 requests
        client.post("/hint", json=VALID_HINT_PAYLOAD)
        client.post("/hint", json=VALID_HINT_PAYLOAD)
        # Switch to User 2
        app_main.app.dependency_overrides[auth.get_current_uid] = lambda: "test-user-2"
        res = client.post("/hint", json=VALID_HINT_PAYLOAD)
        assert res.json()["hint_level"] == 1
        # Reset to User 1
        app_main.app.dependency_overrides[auth.get_current_uid] = lambda: "test-user-1"

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


class TestTutorModesEndpoint:
    def test_mode_defaults_to_hint_and_advances_level(self, client):
        client.post("/hint", json=VALID_HINT_PAYLOAD)
        res = client.post("/hint", json=VALID_HINT_PAYLOAD)
        assert res.json()["hint_level"] == 2

    def test_non_hint_mode_does_not_advance_level(self, client):
        payload = {**VALID_HINT_PAYLOAD, "mode": "reflect"}
        client.post("/hint", json=payload)
        client.post("/hint", json=payload)
        # a subsequent real hint on the same code still starts at level 1
        res = client.post("/hint", json=VALID_HINT_PAYLOAD)
        assert res.json()["hint_level"] == 1

    def test_reflect_mode_uses_reflect_prompt(self, client, _patch_groq_client):
        payload = {**VALID_HINT_PAYLOAD, "mode": "reflect", "question": "quiz me"}
        res = client.post("/hint", json=payload)
        assert res.status_code == 200
        messages = _patch_groq_client.chat.completions.create.call_args.kwargs["messages"]
        assert "FIXED" in messages[0]["content"]

    def test_invalid_mode_rejected(self, client):
        payload = {**VALID_HINT_PAYLOAD, "mode": "cheat"}
        res = client.post("/hint", json=payload)
        assert res.status_code == 422


class TestHintStream:
    def _events(self, body: str):
        return [
            __import__("json").loads(line[len("data: "):])
            for line in body.splitlines()
            if line.startswith("data: ")
        ]

    def test_stream_emits_meta_deltas_and_done(self, client, monkeypatch):
        import main as app_main
        app_main._profile_cache.clear()

        def fake_stream(
            code, question, level, language, history, mode, pacing, edit_summary="",
            focus=None, view=None,
        ):
            yield {"type": "delta", "text": "Look at "}
            yield {"type": "delta", "text": "your loop."}
            yield {"type": "done", "hint": "Look at your loop. What do you think should happen next?",
                   "concept_tags": ["loops"]}

        monkeypatch.setattr(app_main.engine, "stream_hint", fake_stream)
        res = client.post("/hint/stream", json=VALID_HINT_PAYLOAD)
        assert res.status_code == 200
        assert res.headers["content-type"].startswith("text/event-stream")
        events = self._events(res.text)
        assert events[0] == {"type": "meta", "hint_level": 1, "mode": "hint"}
        assert events[1]["type"] == "delta"
        assert events[-1]["type"] == "done"
        assert events[-1]["concept_tags"] == ["loops"]

    def test_stream_advances_hint_level(self, client, monkeypatch):
        import main as app_main
        app_main._profile_cache.clear()

        def fake_stream(*args, **kwargs):
            yield {"type": "done", "hint": "h", "concept_tags": []}

        monkeypatch.setattr(app_main.engine, "stream_hint", fake_stream)
        client.post("/hint/stream", json=VALID_HINT_PAYLOAD)
        res = client.post("/hint/stream", json=VALID_HINT_PAYLOAD)
        assert self._events(res.text)[0]["hint_level"] == 2

    def test_stream_llm_failure_yields_error_event(self, client, monkeypatch):
        import main as app_main
        app_main._profile_cache.clear()

        def broken_stream(*args, **kwargs):
            raise RuntimeError("boom")
            yield  # pragma: no cover

        monkeypatch.setattr(app_main.engine, "stream_hint", broken_stream)
        res = client.post("/hint/stream", json=VALID_HINT_PAYLOAD)
        events = self._events(res.text)
        assert events[-1]["type"] == "error"

    def test_stream_empty_question_400(self, client):
        res = client.post("/hint/stream", json={**VALID_HINT_PAYLOAD, "question": " "})
        assert res.status_code == 400


class TestProgressEndpoints:
    def test_progress_returns_shape_for_new_user(self, client, monkeypatch):
        import main as app_main
        app_main._profile_cache.clear()
        # try_get_user_profile_sync is the single read; get_user_profile_sync
        # delegates to it, so patching here covers both the cached and the
        # uncached path.
        monkeypatch.setattr(app_main.firebase, "try_get_user_profile_sync", lambda uid: {})
        res = client.get("/progress")
        assert res.status_code == 200
        data = res.json()
        assert data["badges"] == []
        assert data["review_due"] is False

    def test_review_not_due_returns_no_exercise(self, client):
        import main as app_main
        app_main._profile_cache.clear()
        res = client.get("/review")
        assert res.status_code == 200
        assert res.json() == {"due": False, "concepts": [], "exercise": ""}

    def test_review_due_generates_exercise(self, client, monkeypatch, _patch_groq_client):
        import main as app_main
        from datetime import date, timedelta
        app_main._profile_cache.clear()
        struggled = (app_main._utc_today() - timedelta(days=4)).isoformat()
        monkeypatch.setattr(
            app_main.firebase,
            "try_get_user_profile_sync",
            lambda uid: {"concept_stats": {"loops": {
                "encounters": 3, "level_sum": 7, "max_level": 3,
                "last_seen": struggled, "last_struggled": struggled}}},
        )
        res = client.get("/review?language=python")
        assert res.status_code == 200
        data = res.json()
        assert data["due"] is True
        assert data["concepts"] == ["loops"]
        assert data["exercise"]

    def test_goal_round_trip(self, client, monkeypatch):
        import main as app_main
        app_main._profile_cache.clear()
        saved = {}
        monkeypatch.setattr(
            app_main.firebase, "set_goal_sync",
            lambda uid, text, concepts: saved.update(uid=uid, text=text, concepts=concepts),
        )
        monkeypatch.setattr(
            app_main.engine, "map_goal_to_concepts", lambda text, lang: ["recursion"]
        )
        res = client.post("/goal", json={"text": "get better at recursion"})
        assert res.status_code == 200
        assert res.json()["concepts"] == ["recursion"]
        assert saved["text"] == "get better at recursion"

    def test_goal_concepts_reach_the_tutor(self, client, monkeypatch):
        """The whole point of mapping a goal to tags.

        Until 1.7.0 `/goal` spent an LLM call turning free text into concept
        tags, stored them, showed them in a toast, and then read them from
        nowhere. The unit tests cover the shaping; this is the one that fails
        if the wiring is ever dropped again.
        """
        import main as app_main
        app_main._profile_cache.clear()
        monkeypatch.setattr(
            app_main.firebase,
            "try_get_user_profile_sync",
            lambda uid: {"goal": {"text": "get better at recursion",
                                  "concepts": ["recursion", "base-case"]}},
        )
        seen = {}

        def fake_stream(code, question, level, language, history, mode, pacing,
                        edit_summary="", focus=None, view=None):
            seen["pacing"] = pacing
            yield {"type": "done", "hint": "h", "concept_tags": []}

        monkeypatch.setattr(app_main.engine, "stream_hint", fake_stream)
        res = client.post("/hint/stream", json=VALID_HINT_PAYLOAD)
        assert res.status_code == 200

        assert "get better at recursion" in seen["pacing"]
        assert "In concept tags, that is: recursion, base-case." in seen["pacing"]
        # And the guard rail travels with them.
        assert "Never steer towards a concept the code does not raise." in seen["pacing"]

    def test_a_goal_reorders_what_comes_back_for_review(self, client, monkeypatch,
                                                        _patch_groq_client):
        import main as app_main
        from datetime import timedelta
        app_main._profile_cache.clear()
        struggled = (app_main._utc_today() - timedelta(days=4)).isoformat()

        def stat(encounters):
            return {"encounters": encounters, "level_sum": encounters * 3, "max_level": 3,
                    "last_seen": struggled, "last_struggled": struggled}

        monkeypatch.setattr(
            app_main.firebase,
            "try_get_user_profile_sync",
            lambda uid: {
                "concept_stats": {"loops": stat(9), "recursion": stat(2)},
                "goal": {"text": "recursion", "concepts": ["recursion"]},
            },
        )
        res = client.get("/review?language=python")
        assert res.status_code == 200
        # `loops` is far riper; the goal is what puts recursion first.
        assert res.json()["concepts"] == ["recursion", "loops"]

    def test_reset_returns_summary_field(self, client):
        res = client.post("/reset")
        assert res.status_code == 200
        assert "summary" in res.json()

    def test_reset_summarizes_recent_interactions(self, client, monkeypatch):
        import main as app_main
        monkeypatch.setattr(
            app_main.firebase, "get_recent_interactions_sync",
            lambda uid, limit=10: [{"question": "why loop?", "concept_tags": ["loops"],
                                    "hint_level_used": 2}],
        )
        monkeypatch.setattr(
            app_main.engine, "summarize_session",
            lambda items: "- You practised loops",
        )
        appended = {}
        monkeypatch.setattr(
            app_main.firebase, "append_session_summary_sync",
            lambda uid, s: appended.update(uid=uid, s=s),
        )
        res = client.post("/reset")
        assert res.json()["summary"] == "- You practised loops"
        assert appended["s"] == "- You practised loops"

    def test_the_session_is_cleared_even_when_the_summary_blows_up(self, client, monkeypatch):
        """The clear no longer sits downstream of the note.

        `store.reset` used to be the last of four serial steps, so a summary
        that raised took the reset down with it: the student pressed Reset, saw
        an error, and kept their old hint levels. The two are gathered now, so
        the reset happens whatever the LLM does.
        """
        import main as app_main

        cleared = []
        monkeypatch.setattr(
            app_main.firebase, "get_recent_interactions_sync",
            lambda uid, limit=10: [{"question": "why loop?", "concept_tags": ["loops"],
                                    "hint_level_used": 2}],
        )
        monkeypatch.setattr(app_main.store, "reset", lambda uid: cleared.append(uid))

        def boom(_items):
            raise RuntimeError("groq is down")

        monkeypatch.setattr(app_main.engine, "summarize_session", boom)
        res = client.post("/reset")
        assert res.status_code == 200
        assert res.json()["summary"] == ""
        assert cleared, "the session was never cleared"


class TestHintLanguageAndHistory:
    def test_language_field_accepted(self, client, _patch_groq_client):
        payload = {**VALID_HINT_PAYLOAD, "language": "java", "code": "int x = 1;"}
        res = client.post("/hint", json=payload)
        assert res.status_code == 200
        messages = _patch_groq_client.chat.completions.create.call_args.kwargs["messages"]
        assert "Java students" in messages[0]["content"]

    def test_unknown_language_falls_back_to_python(self, client, _patch_groq_client):
        payload = {**VALID_HINT_PAYLOAD, "language": "ruby"}
        res = client.post("/hint", json=payload)
        assert res.status_code == 200
        messages = _patch_groq_client.chat.completions.create.call_args.kwargs["messages"]
        assert "Python students" in messages[0]["content"]

    def test_missing_language_defaults_to_python(self, client, _patch_groq_client):
        res = client.post("/hint", json=VALID_HINT_PAYLOAD)
        assert res.status_code == 200
        messages = _patch_groq_client.chat.completions.create.call_args.kwargs["messages"]
        assert "Python students" in messages[0]["content"]

    def test_history_forwarded_to_engine(self, client, _patch_groq_client):
        payload = {
            **VALID_HINT_PAYLOAD,
            "history": [
                {"role": "student", "content": "why is it broken?"},
                {"role": "tutor", "content": "what does subtraction do?"},
            ],
        }
        res = client.post("/hint", json=payload)
        assert res.status_code == 200
        messages = _patch_groq_client.chat.completions.create.call_args.kwargs["messages"]
        assert {"role": "user", "content": "why is it broken?"} in messages
        assert {"role": "assistant", "content": "what does subtraction do?"} in messages

    def test_invalid_history_role_returns_422(self, client):
        payload = {
            **VALID_HINT_PAYLOAD,
            "history": [{"role": "assistant", "content": "nope"}],
        }
        res = client.post("/hint", json=payload)
        assert res.status_code == 422


# ---------------------------------------------------------------------------
# /reset
# ---------------------------------------------------------------------------

class TestResetEndpoint:
    def test_reset_clears_hint_level(self, client):
        client.post("/hint", json=VALID_HINT_PAYLOAD)
        client.post("/hint", json=VALID_HINT_PAYLOAD)
        client.post("/reset")
        res = client.post("/hint", json=VALID_HINT_PAYLOAD)
        assert res.json()["hint_level"] == 1

    def test_reset_returns_confirmation(self, client):
        res = client.post("/reset")
        assert res.status_code == 200
        data = res.json()
        assert data["status"] == "reset"
        assert data["user_id"] == "test-user-1"

    def test_reset_unknown_user_returns_200(self, client):
        res = client.post("/reset")
        assert res.status_code == 200


# ---------------------------------------------------------------------------
# /badges
# ---------------------------------------------------------------------------

class TestBadgesEndpoint:
    def test_returns_list(self, client):
        res = client.get("/badges")
        assert res.status_code == 200
        assert isinstance(res.json(), list)


# ---------------------------------------------------------------------------
# Event loop is not blocked by synchronous store / engine work
# ---------------------------------------------------------------------------

class TestEventLoopNotBlocked:
    @pytest.mark.asyncio
    async def test_hint_offloads_blocking_work_off_event_loop(self):
        """Synchronous store/engine work inside /hint must be offloaded to a
        worker thread so it cannot block the event loop. We verify this
        deterministically: the blocking calls must run on a thread other than
        the one running the event loop. Without offloading they would run on
        the event-loop thread and these assertions would fail."""
        import threading
        import httpx
        import main as app_main
        import auth
        from session_store import InMemorySessionStore

        loop_thread_id = threading.get_ident()
        seen = {}

        class _RecordingStore(InMemorySessionStore):
            def peek_hint_level(self, user_id, fingerprint, escalate=True):
                seen["peek_hint_level"] = threading.get_ident()
                return super().peek_hint_level(user_id, fingerprint, escalate)

            def commit_hint_level(self, user_id, fingerprint, level):
                seen["commit_hint_level"] = threading.get_ident()
                return super().commit_hint_level(user_id, fingerprint, level)

            def begin_session(self, user_id):
                seen["begin_session"] = threading.get_ident()
                return super().begin_session(user_id)

        original_store = app_main.store
        app_main.store = _RecordingStore()
        # Override auth for this test
        app_main.app.dependency_overrides[auth.get_current_uid] = lambda: "test-user-1"
        try:
            transport = httpx.ASGITransport(app=app_main.app)
            async with httpx.AsyncClient(transport=transport, base_url="http://t") as ac:
                res = await ac.post("/hint", json=VALID_HINT_PAYLOAD)
        finally:
            app_main.store = original_store
            app_main.app.dependency_overrides.clear()

        assert res.status_code == 200
        assert seen["peek_hint_level"] != loop_thread_id
        assert seen["commit_hint_level"] != loop_thread_id
        assert seen["begin_session"] != loop_thread_id


# ---------------------------------------------------------------------------
# escalate / edit_summary / confidence
# ---------------------------------------------------------------------------

class TestEscalationControl:
    def test_escalate_defaults_to_true_for_old_clients(self, client):
        client.post("/hint", json=VALID_HINT_PAYLOAD)
        res = client.post("/hint", json=VALID_HINT_PAYLOAD)
        assert res.json()["hint_level"] == 2

    def test_non_escalating_ask_reuses_the_level(self, client):
        client.post("/hint", json=VALID_HINT_PAYLOAD)
        payload = {**VALID_HINT_PAYLOAD, "escalate": False}
        assert client.post("/hint", json=payload).json()["hint_level"] == 1
        assert client.post("/hint", json=payload).json()["hint_level"] == 1

    def test_escalation_resumes_after_a_non_escalating_ask(self, client):
        client.post("/hint", json=VALID_HINT_PAYLOAD)
        client.post("/hint", json={**VALID_HINT_PAYLOAD, "escalate": False})
        assert client.post("/hint", json=VALID_HINT_PAYLOAD).json()["hint_level"] == 2

    def test_first_ever_ask_without_escalation_is_level_1(self, client):
        payload = {**VALID_HINT_PAYLOAD, "escalate": False}
        assert client.post("/hint", json=payload).json()["hint_level"] == 1

    def test_escalate_ignored_outside_hint_mode(self, client):
        payload = {**VALID_HINT_PAYLOAD, "mode": "reflect", "hint_level": 2, "escalate": False}
        assert client.post("/hint", json=payload).json()["hint_level"] == 2

    def test_stream_honours_escalate_false(self, client, monkeypatch):
        import main as app_main
        app_main._profile_cache.clear()

        def fake_stream(*args, **kwargs):
            yield {"type": "done", "hint": "h", "concept_tags": []}

        monkeypatch.setattr(app_main.engine, "stream_hint", fake_stream)
        client.post("/hint/stream", json=VALID_HINT_PAYLOAD)
        res = client.post("/hint/stream", json={**VALID_HINT_PAYLOAD, "escalate": False})
        assert 'data: {"type": "meta", "hint_level": 1, "mode": "hint"}' in res.text


class TestLadderWithTheRealProblemKey:
    """The production combination: a Firestore store and a URI `problem_key`.

    Every other ladder test here omits `problem_key`, so `_ladder_key` fell
    back to `code_fingerprint` — a SHA-1 hex string — and ran against the
    in-memory store. Neither half of what shipped was covered. The extension
    sends `doc.uri.toString()`, `_ladder_key` passes it through untouched, and
    `FirestoreSessionStore` used to interpolate it into a document ID, where
    "/" is a path separator. Every read and write was rejected and both errors
    were swallowed, so the student was answered at level 1 on every ask and
    never reached level 2 — the rung that explains rather than asks.
    """

    URI_KEY = "file:///c%3A/Users/s/proj/demos/demo.py#average"

    @pytest.fixture()
    def fs_client(self):
        from fastapi.testclient import TestClient
        import main as app_main
        import auth
        from session_store import FirestoreSessionStore
        from tests.test_session_store import FakeFirestore

        app_main.store = FirestoreSessionStore(FakeFirestore())
        app_main.app.dependency_overrides[auth.get_current_uid] = lambda: "test-user-1"
        with TestClient(app_main.app) as c:
            yield c
        app_main.app.dependency_overrides.clear()

    def _payload(self, **over):
        return {**VALID_HINT_PAYLOAD, "problem_key": self.URI_KEY, **over}

    def test_the_level_climbs_and_caps(self, fs_client):
        levels = [
            fs_client.post("/hint", json=self._payload()).json()["hint_level"]
            for _ in range(4)
        ]
        assert levels == [1, 2, 3, 4]

    def test_editing_the_code_deepens_the_hint(self, fs_client):
        # The reason the ladder is keyed on the URI at all: an edit must
        # advance the level, not restart it at 1.
        fs_client.post("/hint", json=self._payload())
        edited = self._payload(code="def add(a, b):\n    return a + b")
        assert fs_client.post("/hint", json=edited).json()["hint_level"] == 2

    def test_a_non_escalating_ask_holds_the_level_it_reached(self, fs_client):
        fs_client.post("/hint", json=self._payload())
        fs_client.post("/hint", json=self._payload())
        held = self._payload(escalate=False)
        assert fs_client.post("/hint", json=held).json()["hint_level"] == 2

    def test_two_functions_in_one_file_climb_separately(self, fs_client):
        fs_client.post("/hint", json=self._payload())
        fs_client.post("/hint", json=self._payload())
        other = self._payload(
            problem_key="file:///c%3A/Users/s/proj/demos/demo.py#total"
        )
        assert fs_client.post("/hint", json=other).json()["hint_level"] == 1

    def test_reset_clears_a_uri_keyed_ladder(self, fs_client):
        fs_client.post("/hint", json=self._payload())
        fs_client.post("/hint", json=self._payload())
        fs_client.post("/reset")
        assert fs_client.post("/hint", json=self._payload()).json()["hint_level"] == 1


class TestFailedHintDoesNotSpendALevel:
    """A hint the student never saw must not cost them a rung of the ladder."""

    def _break_engine(self, monkeypatch):
        import main as app_main

        def boom(*args, **kwargs):
            raise RuntimeError("groq is down")

        monkeypatch.setattr(app_main.engine, "generate_hint", boom)

    def test_llm_failure_leaves_the_level_untouched(self, client, monkeypatch):
        self._break_engine(monkeypatch)
        assert client.post("/hint", json=VALID_HINT_PAYLOAD).status_code == 502
        monkeypatch.undo()
        # The next successful ask is still the student's first hint.
        assert client.post("/hint", json=VALID_HINT_PAYLOAD).json()["hint_level"] == 1

    def test_repeated_failures_do_not_walk_down_the_ladder(self, client, monkeypatch):
        self._break_engine(monkeypatch)
        for _ in range(3):
            assert client.post("/hint", json=VALID_HINT_PAYLOAD).status_code == 502
        monkeypatch.undo()
        assert client.post("/hint", json=VALID_HINT_PAYLOAD).json()["hint_level"] == 1

    def test_failure_after_a_success_keeps_the_earned_level(self, client, monkeypatch):
        assert client.post("/hint", json=VALID_HINT_PAYLOAD).json()["hint_level"] == 1
        self._break_engine(monkeypatch)
        assert client.post("/hint", json=VALID_HINT_PAYLOAD).status_code == 502
        monkeypatch.undo()
        # Level 1 was spent and stays spent; the retry is level 2, not 3.
        assert client.post("/hint", json=VALID_HINT_PAYLOAD).json()["hint_level"] == 2

    def test_successful_hint_still_spends_the_level(self, client):
        assert client.post("/hint", json=VALID_HINT_PAYLOAD).json()["hint_level"] == 1
        assert client.post("/hint", json=VALID_HINT_PAYLOAD).json()["hint_level"] == 2
        assert client.post("/hint", json=VALID_HINT_PAYLOAD).json()["hint_level"] == 3

    def test_non_hint_mode_failure_touches_nothing(self, client, monkeypatch):
        self._break_engine(monkeypatch)
        payload = {**VALID_HINT_PAYLOAD, "mode": "reflect"}
        assert client.post("/hint", json=payload).status_code == 502
        monkeypatch.undo()
        assert client.post("/hint", json=VALID_HINT_PAYLOAD).json()["hint_level"] == 1

    def test_stream_failure_leaves_the_level_untouched(self, client, monkeypatch):
        import main as app_main
        app_main._profile_cache.clear()

        def failing_stream(*args, **kwargs):
            yield {"type": "delta", "text": "partial"}
            raise RuntimeError("groq died mid-stream")

        monkeypatch.setattr(app_main.engine, "stream_hint", failing_stream)
        res = client.post("/hint/stream", json=VALID_HINT_PAYLOAD)
        assert res.status_code == 200
        assert '"type": "error"' in res.text
        monkeypatch.undo()
        assert client.post("/hint", json=VALID_HINT_PAYLOAD).json()["hint_level"] == 1

    def test_stream_success_spends_the_level(self, client, monkeypatch):
        import main as app_main
        app_main._profile_cache.clear()

        def fake_stream(*args, **kwargs):
            yield {"type": "done", "hint": "h", "concept_tags": []}

        monkeypatch.setattr(app_main.engine, "stream_hint", fake_stream)
        client.post("/hint/stream", json=VALID_HINT_PAYLOAD)
        monkeypatch.undo()
        assert client.post("/hint", json=VALID_HINT_PAYLOAD).json()["hint_level"] == 2

    def test_a_failed_stream_then_a_hint_fallback_spends_only_one_level(
        self, client, monkeypatch
    ):
        # This is the exact path the extension takes: stream fails, it retries
        # /hint with the same body. Together they must cost one level, not two.
        import main as app_main
        app_main._profile_cache.clear()

        def failing_stream(*args, **kwargs):
            raise RuntimeError("stream unavailable")
            yield  # pragma: no cover - generator marker

        monkeypatch.setattr(app_main.engine, "stream_hint", failing_stream)
        client.post("/hint/stream", json=VALID_HINT_PAYLOAD)
        monkeypatch.undo()
        assert client.post("/hint", json=VALID_HINT_PAYLOAD).json()["hint_level"] == 1


class TestEditSummaryAndConfidence:
    def test_edit_summary_forwarded_to_the_engine(self, client, _patch_groq_client):
        payload = {**VALID_HINT_PAYLOAD, "edit_summary": "12 - old line\n12 + new line"}
        assert client.post("/hint", json=payload).status_code == 200
        messages = _patch_groq_client.chat.completions.create.call_args.kwargs["messages"]
        assert "12 + new line" in messages[-1]["content"]

    def test_oversized_edit_summary_rejected(self, client):
        from models import MAX_EDIT_SUMMARY_CHARS
        payload = {**VALID_HINT_PAYLOAD, "edit_summary": "x" * (MAX_EDIT_SUMMARY_CHARS + 1)}
        assert client.post("/hint", json=payload).status_code == 422

    def test_confidence_accepted_in_range(self, client):
        for value in (0, 1, 2, 3):
            payload = {**VALID_HINT_PAYLOAD, "confidence": value}
            assert client.post("/hint", json=payload).status_code == 200

    def test_confidence_out_of_range_rejected(self, client):
        assert client.post("/hint", json={**VALID_HINT_PAYLOAD, "confidence": 7}).status_code == 422
        assert client.post("/hint", json={**VALID_HINT_PAYLOAD, "confidence": -1}).status_code == 422

    def test_confidence_reaches_the_logger(self, client, monkeypatch):
        import main as app_main
        seen = {}
        monkeypatch.setattr(
            app_main.firebase,
            "fire_and_forget",
            lambda **kwargs: seen.update(kwargs),
        )
        client.post("/hint", json={**VALID_HINT_PAYLOAD, "confidence": 3})
        assert seen["confidence"] == 3


# ---------------------------------------------------------------------------
# focus
# ---------------------------------------------------------------------------

class TestFocusField:
    def test_hint_ignores_a_nonsense_focus_instead_of_refusing_the_request(self, client):
        """An optional enrichment field must never cost the student their hint."""
        # start > end: the extension would have to be buggy to send this, and the
        # student should still get tutored when it is.
        payload = {**VALID_HINT_PAYLOAD, "focus": {"start_line": 9, "end_line": 2}}
        res = client.post("/hint", json=payload)
        assert res.status_code == 200
        assert res.json()["hint"]

    def test_hint_ignores_a_null_label_instead_of_refusing_the_request(self, client):
        """A JS/TS client can easily spell "no label" as JSON null (`?? null`);
        that must not 422 the whole request either."""
        payload = {
            **VALID_HINT_PAYLOAD,
            "focus": {"start_line": 1, "end_line": 2, "label": None},
        }
        res = client.post("/hint", json=payload)
        assert res.status_code == 200
        assert res.json()["hint"]


# ---------------------------------------------------------------------------
# /trace
# ---------------------------------------------------------------------------

class TestTraceEndpoint:
    def _stub(self, monkeypatch, result):
        import main as app_main
        monkeypatch.setattr(
            app_main.engine, "design_trace_table", lambda snippet, language: result
        )

    def test_returns_the_designed_table(self, client, monkeypatch):
        self._stub(monkeypatch, (["i", "total"], 4, "Trace the loop."))
        res = client.post("/trace", json={"code": "for i in range(4): pass", "language": "python"})
        assert res.status_code == 200
        assert res.json() == {"variables": ["i", "total"], "steps": 4, "prompt": "Trace the loop."}

    def test_empty_body_returns_empty_exercise(self, client):
        res = client.post("/trace", json={"code": "", "selection": ""})
        assert res.status_code == 200
        assert res.json()["steps"] == 0

    def test_selection_wins_over_full_file(self, client, monkeypatch):
        import main as app_main
        seen = {}

        def fake(snippet, language):
            seen["snippet"] = snippet
            return ["i", "j"], 3, "Trace."

        monkeypatch.setattr(app_main.engine, "design_trace_table", fake)
        client.post("/trace", json={"code": "whole file", "selection": "just this bit"})
        assert seen["snippet"] == "just this bit"

    def test_falls_back_to_full_file_without_a_selection(self, client, monkeypatch):
        import main as app_main
        seen = {}

        def fake(snippet, language):
            seen["snippet"] = snippet
            return ["i", "j"], 3, "Trace."

        monkeypatch.setattr(app_main.engine, "design_trace_table", fake)
        client.post("/trace", json={"code": "whole file", "selection": "   "})
        assert seen["snippet"] == "whole file"

    def test_llm_failure_returns_502(self, client, monkeypatch):
        import main as app_main

        def boom(snippet, language):
            raise RuntimeError("groq is down")

        monkeypatch.setattr(app_main.engine, "design_trace_table", boom)
        res = client.post("/trace", json={"code": "x = 1"})
        assert res.status_code == 502

    def test_unknown_language_is_normalised(self, client, monkeypatch):
        import main as app_main
        seen = {}

        def fake(snippet, language):
            seen["language"] = language
            return ["i", "j"], 3, "Trace."

        monkeypatch.setattr(app_main.engine, "design_trace_table", fake)
        client.post("/trace", json={"code": "x = 1", "language": "brainfuck"})
        assert seen["language"] == "python"

    def test_trace_check_mode_accepted_by_hint(self, client):
        payload = {**VALID_HINT_PAYLOAD, "mode": "trace-check"}
        assert client.post("/hint", json=payload).status_code == 200

    def test_subgoal_label_mode_accepted_by_hint(self, client):
        payload = {**VALID_HINT_PAYLOAD, "mode": "subgoal-label"}
        assert client.post("/hint", json=payload).status_code == 200


# ---------------------------------------------------------------------------
# caching and rate limiting
# ---------------------------------------------------------------------------

class TestResponseCaching:
    def test_identical_scan_is_served_from_cache(self, client, monkeypatch):
        import main as app_main
        calls = []

        def fake_scan(code, language, focus=None, view=None):
            calls.append(code)
            return [{"line": 1, "end_line": 1, "question": "Why?", "concept": "loops",
                     "severity": "info", "kind": "bug"}]

        monkeypatch.setattr(app_main.engine, "scan_code", fake_scan)
        body = {"code": "x = 1\n", "language": "python"}
        first = client.post("/scan", json=body)
        second = client.post("/scan", json=body)
        assert first.json() == second.json()
        assert len(calls) == 1

    def test_changed_code_bypasses_the_cache(self, client, monkeypatch):
        import main as app_main
        calls = []
        monkeypatch.setattr(
            app_main.engine, "scan_code",
            lambda code, language, focus=None, view=None: calls.append(code) or [],
        )
        client.post("/scan", json={"code": "x = 1\n", "language": "python"})
        client.post("/scan", json={"code": "x = 2\n", "language": "python"})
        assert len(calls) == 2

    def test_different_language_is_a_different_cache_entry(self, client, monkeypatch):
        import main as app_main
        calls = []
        monkeypatch.setattr(
            app_main.engine, "scan_code",
            lambda code, language, focus=None, view=None: calls.append(language) or [],
        )
        client.post("/scan", json={"code": "x = 1\n", "language": "python"})
        client.post("/scan", json={"code": "x = 1\n", "language": "javascript"})
        assert calls == ["python", "javascript"]

    def test_line_hint_is_cached_per_line(self, client, monkeypatch):
        import main as app_main
        calls = []

        def fake_line_hint(code, line, language, focus=None, view=None):
            calls.append(line)
            return "Check the index", "indexing"

        monkeypatch.setattr(app_main.engine, "generate_line_hint", fake_line_hint)
        body = {"code": "a = 1\nb = 2\n", "line": 1, "language": "python"}
        client.post("/line-hint", json=body)
        client.post("/line-hint", json=body)
        client.post("/line-hint", json={**body, "line": 2})
        assert calls == [1, 2]

    def test_cached_scan_is_not_shared_between_users(self, client, monkeypatch):
        import main as app_main
        import auth
        calls = []
        monkeypatch.setattr(
            app_main.engine, "scan_code",
            lambda code, language, focus=None, view=None: calls.append(code) or [],
        )
        body = {"code": "x = 1\n", "language": "python"}
        client.post("/scan", json=body)
        app_main.app.dependency_overrides[auth.get_current_uid] = lambda: "someone-else"
        client.post("/scan", json=body)
        assert len(calls) == 2


class TestRateLimiting:
    def test_exceeding_the_hint_budget_returns_429(self, client):
        import main as app_main
        app_main.limiters.clear()
        statuses = [
            client.post("/hint", json=VALID_HINT_PAYLOAD).status_code for _ in range(31)
        ]
        assert statuses[:30] == [200] * 30
        assert statuses[30] == 429

    def test_429_carries_a_retry_after_header(self, client):
        import main as app_main
        app_main.limiters.clear()
        for _ in range(30):
            client.post("/hint", json=VALID_HINT_PAYLOAD)
        res = client.post("/hint", json=VALID_HINT_PAYLOAD)
        assert res.status_code == 429
        assert int(res.headers["Retry-After"]) >= 1

    def test_inline_budget_is_separate_from_hint_budget(self, client, monkeypatch):
        import main as app_main
        app_main.limiters.clear()
        monkeypatch.setattr(
            app_main.engine, "scan_code",
            lambda code, language, focus=None, view=None: [],
        )
        for _ in range(30):
            client.post("/hint", json=VALID_HINT_PAYLOAD)
        # /hint is now exhausted; /scan must still work.
        assert client.post("/scan", json={"code": "x=1", "language": "python"}).status_code == 200

    def test_budgets_are_per_user(self, client):
        import main as app_main
        import auth
        app_main.limiters.clear()
        for _ in range(30):
            client.post("/hint", json=VALID_HINT_PAYLOAD)
        assert client.post("/hint", json=VALID_HINT_PAYLOAD).status_code == 429
        app_main.app.dependency_overrides[auth.get_current_uid] = lambda: "fresh-user"
        assert client.post("/hint", json=VALID_HINT_PAYLOAD).status_code == 200

    def test_health_is_never_rate_limited(self, client):
        import main as app_main
        app_main.limiters.clear()
        for _ in range(30):
            client.post("/hint", json=VALID_HINT_PAYLOAD)
        assert client.get("/health").status_code == 200


class TestTheResponseCarriesItsEffectiveMode:
    """The panel labels a card from the response, not from its own request.

    Without this the backend can silently switch a level-4 ask to a worked
    example and the panel still prints "hint 4" over it.
    """

    def test_an_ordinary_hint_reports_hint_mode(self, client):
        res = client.post("/hint", json=VALID_HINT_PAYLOAD)
        assert res.json()["mode"] == "hint"

    def test_a_level_four_hint_reports_worked_example(self, client):
        # Four escalating asks walk 1 -> 2 -> 3 -> 4.
        for _ in range(4):
            res = client.post("/hint", json=VALID_HINT_PAYLOAD)
        assert res.json()["hint_level"] == 4
        assert res.json()["mode"] == "worked-example"

    def test_a_non_hint_mode_reports_itself(self, client):
        payload = {**VALID_HINT_PAYLOAD, "mode": "reflect"}
        assert client.post("/hint", json=payload).json()["mode"] == "reflect"

    def test_the_stream_meta_event_carries_the_mode(self, client, monkeypatch):
        import main as app_main
        app_main._profile_cache.clear()

        def fake_stream(*args, **kwargs):
            yield {"type": "done", "hint": "h", "concept_tags": []}

        monkeypatch.setattr(app_main.engine, "stream_hint", fake_stream)
        res = client.post("/hint/stream", json=VALID_HINT_PAYLOAD)
        assert '"mode": "hint"' in res.text


class TestAnswerModeEndpoint:
    def test_answer_mode_is_accepted(self, client):
        payload = {**VALID_HINT_PAYLOAD, "mode": "answer"}
        assert client.post("/hint", json=payload).status_code == 200

    def test_answer_mode_does_not_move_the_ladder(self, client):
        # Asking for the answer is neither an attempt nor a rung spent.
        client.post("/hint", json=VALID_HINT_PAYLOAD)  # level 1
        client.post("/hint", json={**VALID_HINT_PAYLOAD, "mode": "answer"})
        assert client.post("/hint", json=VALID_HINT_PAYLOAD).json()["hint_level"] == 2


# ---------------------------------------------------------------------------
# bands and view: the endpoints build the CodeView and hand it to the engine
# ---------------------------------------------------------------------------

class TestTheEndpointsHandDownTheDigest:
    """Bands are parsed once, at the boundary, and everything below asks it."""

    DIGEST = {
        "code": "import math\ndef deep(n):\n    return n - 1",
        "bands": [{"start": 1, "end": 1}, {"start": 173, "end": 174}],
        "total_lines": 241,
    }

    def test_scan_passes_the_focus_and_the_view_to_the_engine(self, client, monkeypatch):
        seen = {}

        def fake_scan(code, language="python", focus=None, view=None):
            seen["focus"] = focus
            seen["numbered"] = view.numbered() if view else None
            return []

        monkeypatch.setattr("main.engine.scan_code", fake_scan)
        res = client.post(
            "/scan",
            json={**self.DIGEST, "focus": {"start_line": 173, "end_line": 174, "label": "deep"}},
        )
        assert res.status_code == 200
        assert seen["focus"]["label"] == "deep"
        assert "173: def deep(n):" in seen["numbered"]

    def test_line_hint_passes_the_view(self, client, monkeypatch):
        seen = {}

        def fake_hint(code, line_number, language="python", focus=None, view=None):
            seen["line"] = line_number
            seen["holds"] = view.contains(line_number) if view else None
            return "ok", "loops"

        monkeypatch.setattr("main.engine.generate_line_hint", fake_hint)
        res = client.post("/line-hint", json={**self.DIGEST, "line": 174})
        assert res.status_code == 200
        assert seen["line"] == 174 and seen["holds"] is True

    def test_two_band_sets_over_identical_text_do_not_share_a_cache_entry(
        self, client, monkeypatch
    ):
        # Same digest text, different lines. Serving one against the other
        # puts a flag on the wrong function.
        calls = []

        def fake_scan(code, language="python", focus=None, view=None):
            calls.append(view.max_line if view else 0)
            return []

        monkeypatch.setattr("main.engine.scan_code", fake_scan)
        body = {"code": "a = 1\nb = 2", "total_lines": 90}
        client.post("/scan", json={**body, "bands": [{"start": 1, "end": 2}]})
        client.post("/scan", json={**body, "bands": [{"start": 40, "end": 41}]})
        assert calls == [2, 41]

    def test_a_request_with_no_bands_still_works(self, client, monkeypatch):
        seen = {}

        def fake_scan(code, language="python", focus=None, view=None):
            seen["view"] = view
            return []

        monkeypatch.setattr("main.engine.scan_code", fake_scan)
        assert client.post("/scan", json={"code": "x = 1"}).status_code == 200
        assert seen["view"] is None

    def test_hint_uses_the_view_for_numbering_and_the_focus_for_the_instruction(
        self, client, _patch_groq_client
    ):
        """`focus_instruction` runs independently of `view`: a request that
        carries both must number the code from the digest's absolute bands
        AND still tell the model which lines the student is working on -
        nothing exercised that combination before this task wired `view`
        into /hint."""
        payload = {
            **self.DIGEST,
            "question": "Why is deep wrong?",
            "focus": {"start_line": 173, "end_line": 174, "label": "deep"},
        }
        res = client.post("/hint", json=payload)
        assert res.status_code == 200
        sent = _patch_groq_client.last_messages[-1]["content"]
        assert "173: def deep(n):" in sent
        assert "The student is working on lines 173-174 (deep)" in sent

    def test_stream_passes_the_view_and_the_focus_to_the_engine(self, client, monkeypatch):
        """The wiring from /stream to `stream_hint` is its own call site,
        separate from /hint - confirm `view` actually arrives there too."""
        import main as app_main
        app_main._profile_cache.clear()
        seen = {}

        def fake_stream(code, question, level, language, history, mode, pacing,
                         edit_summary="", focus=None, view=None):
            seen["focus"] = focus
            seen["numbered"] = view.numbered() if view else None
            yield {"type": "done", "hint": "h", "concept_tags": []}

        monkeypatch.setattr(app_main.engine, "stream_hint", fake_stream)
        payload = {
            **self.DIGEST,
            "question": "Why is deep wrong?",
            "focus": {"start_line": 173, "end_line": 174, "label": "deep"},
        }
        res = client.post("/hint/stream", json=payload)
        assert res.status_code == 200
        assert seen["focus"]["label"] == "deep"
        assert "173: def deep(n):" in seen["numbered"]
