import sys
import os
from unittest.mock import MagicMock

import pytest

# Allow "import models", "import hinting_engine", etc. from the backend/ directory
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))


def _stub_firebase() -> None:
    """Replace `firebase_admin` before any test module can import `main`.

    `main.py` calls `load_dotenv()` at import and then builds
    `store = build_session_store(firebase)`. With the real `firebase_admin`
    present that resolves the credentials in `.env` and binds a *live*
    FirestoreSessionStore for the whole session — so the suite was quietly
    talking to the production database, and every `/hint` test paid real
    network round trips for peek, commit and begin_session.

    `test_main.py` already stubbed this, but only from its own module import.
    Whichever test file imports `main` first wins, and `test_api_auth.py`
    sorts earlier and does not stub — so on a full run the live store always
    won. It looked fine while Firestore answered quickly; it presents as a
    suite that hangs with no output the moment it does not.

    conftest is imported before any test module, so doing it here is the only
    placement that actually holds. `setdefault` keeps the existing stubs in
    `test_main.py` working as no-ops.
    """
    admin = MagicMock()
    admin._apps = {}
    firestore_mod = MagicMock()
    firestore_mod.SERVER_TIMESTAMP = "SERVER_TS"
    sys.modules.setdefault("firebase_admin", admin)
    sys.modules.setdefault("firebase_admin.credentials", MagicMock())
    sys.modules.setdefault("firebase_admin.firestore", firestore_mod)


_stub_firebase()

# The same reason `main` must not reach Firestore: a test that reaches the
# network is slow when it works and a hang when it does not.
os.environ.setdefault("GROQ_API_KEY", "test-key")
os.environ.setdefault("FIREBASE_PROJECT_ID", "test-project")
os.environ.setdefault("FIREBASE_PRIVATE_KEY", "test-pk")
os.environ.setdefault("FIREBASE_CLIENT_EMAIL", "test@test.iam.gserviceaccount.com")


def _clear_shared_state():
    # Only touch `main` if a test module has already imported it: importing it
    # here would run before those modules stub firebase_admin and the env vars.
    main = sys.modules.get("main")
    if main is None:
        return
    main.limiters.clear()
    main.SCAN_CACHE.clear()
    main.LINE_HINT_CACHE.clear()
    # The 60-second profile cache is global too, and it is the sneakiest of the
    # three: a test that monkeypatches a profile leaves it cached for the next
    # test, which then silently exercises the wrong student.
    main._profile_cache.clear()
    # Session/hint-level state is per-process when Firestore is unavailable, so
    # one test's hint ladder would otherwise start the next test at level 2.
    store = getattr(main, "store", None)
    if hasattr(store, "_levels"):
        store._levels.clear()
        store._active.clear()


def pytest_configure(config):
    config.addinivalue_line(
        "markers",
        "real_backend: exercise AnthropicBackend/GroqBackend directly, with a "
        "faked transport underneath. Opts out of `no_real_provider_calls`.",
    )


@pytest.fixture(autouse=True)
def no_real_provider_calls(request, monkeypatch):
    """Fail loudly if a test reaches a real LLM provider.

    Some test paths were quietly making live calls with a fake key. Against
    Groq that failed fast enough that nobody noticed; the Anthropic SDK
    retries with backoff instead, which turned the same leak into a suite that
    hung for minutes with no output. A leaked call is a bug either way - the
    fake belongs in front of it - so this makes it an immediate, named error
    rather than a stall or a slow test.

    Only the two network methods are blocked. Constructing a backend is
    harmless and several tests do it deliberately.
    """
    if request.node.get_closest_marker("real_backend"):
        # These tests ARE the backend's tests: they build one and hand it a
        # fake `_client`, so the network is already stubbed a layer lower.
        return

    import hinting_engine

    def refuse(name):
        def _refuse(self, *_args, **_kwargs):
            raise AssertionError(
                f"{name} tried to reach the real provider. A test is missing "
                "its fake - set `engine.client` to a RecordingBackend, or pass "
                "one via HintingEngine(client=...)."
            )
        return _refuse

    for backend in (hinting_engine.AnthropicBackend, hinting_engine.GroqBackend):
        monkeypatch.setattr(backend, "complete", refuse(backend.__name__), raising=True)
        monkeypatch.setattr(backend, "stream", refuse(backend.__name__), raising=True)


@pytest.fixture(autouse=True)
def reset_shared_state():
    """Rate-limit buckets, response caches and session state are process-global.

    Every test calls the API as the same uid, so without this one test's
    requests would exhaust the next one's budget, or be served another test's
    cached reply. Tests that exercise the limiter drive it directly instead.
    """
    _clear_shared_state()
    yield
    _clear_shared_state()
