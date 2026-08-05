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


@pytest.fixture(autouse=True)
def reset_shared_state():
    """Rate-limit buckets and response caches are process-global.

    Every test calls the API as the same uid, so without this one test's
    requests would exhaust the next one's budget, or be served another test's
    cached reply. Tests that exercise the limiter drive it directly instead.
    """
    _clear_shared_state()
    yield
    _clear_shared_state()
