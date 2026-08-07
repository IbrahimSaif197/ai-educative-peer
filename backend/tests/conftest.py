import sys
import os

import pytest

# Allow "import models", "import hinting_engine", etc. from the backend/ directory
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))


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
