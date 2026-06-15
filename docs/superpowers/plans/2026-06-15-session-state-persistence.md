# Session-State Persistence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move per-student hint-level and session-started state out of in-memory dicts in `main.py` into a `SessionStore` abstraction, with a Firestore-backed implementation that survives restarts and an in-memory fallback for local/test use.

**Architecture:** A new `backend/session_store.py` exposes `code_fingerprint()` plus two duck-typed stores (`InMemorySessionStore`, `FirestoreSessionStore`) sharing the methods `next_hint_level(user_id, fingerprint)`, `begin_session(user_id)`, and `reset(user_id)`. A `build_session_store(firebase)` factory returns the Firestore store when Firestore is configured, else the in-memory store. `main.py` depends only on the interface.

**Tech Stack:** Python, FastAPI, firebase-admin (Firestore), pytest.

**Reference spec:** `docs/superpowers/specs/2026-06-15-session-state-persistence-design.md`

---

### Task 1: `code_fingerprint` + `InMemorySessionStore`

**Files:**
- Create: `backend/session_store.py`
- Test: `backend/tests/test_session_store.py`

- [ ] **Step 1: Write the failing tests**

Create `backend/tests/test_session_store.py`:

```python
from session_store import code_fingerprint, InMemorySessionStore


class TestCodeFingerprint:
    def test_same_code_same_fingerprint(self):
        assert code_fingerprint("x = 1\n") == code_fingerprint("x = 1")

    def test_trailing_whitespace_ignored(self):
        assert code_fingerprint("x = 1   \n") == code_fingerprint("x = 1")

    def test_different_code_different_fingerprint(self):
        assert code_fingerprint("x = 1") != code_fingerprint("x = 2")


class TestInMemorySessionStore:
    def test_level_starts_at_1(self):
        store = InMemorySessionStore()
        assert store.next_hint_level("u1", "fp1") == 1

    def test_level_increments(self):
        store = InMemorySessionStore()
        store.next_hint_level("u1", "fp1")
        assert store.next_hint_level("u1", "fp1") == 2

    def test_level_caps_at_3(self):
        store = InMemorySessionStore()
        for _ in range(5):
            level = store.next_hint_level("u1", "fp1")
        assert level == 3

    def test_different_fingerprint_independent(self):
        store = InMemorySessionStore()
        store.next_hint_level("u1", "fp1")
        store.next_hint_level("u1", "fp1")
        assert store.next_hint_level("u1", "fp2") == 1

    def test_different_user_independent(self):
        store = InMemorySessionStore()
        store.next_hint_level("u1", "fp1")
        store.next_hint_level("u1", "fp1")
        assert store.next_hint_level("u2", "fp1") == 1

    def test_begin_session_returns_true_first_time(self):
        store = InMemorySessionStore()
        assert store.begin_session("u1") is True

    def test_begin_session_returns_false_when_active(self):
        store = InMemorySessionStore()
        store.begin_session("u1")
        assert store.begin_session("u1") is False

    def test_reset_clears_levels(self):
        store = InMemorySessionStore()
        store.next_hint_level("u1", "fp1")
        store.next_hint_level("u1", "fp1")
        store.reset("u1")
        assert store.next_hint_level("u1", "fp1") == 1

    def test_reset_clears_session_flag(self):
        store = InMemorySessionStore()
        store.begin_session("u1")
        store.reset("u1")
        assert store.begin_session("u1") is True

    def test_reset_only_affects_target_user(self):
        store = InMemorySessionStore()
        store.next_hint_level("u1", "fp1")
        store.next_hint_level("u2", "fp1")
        store.reset("u1")
        assert store.next_hint_level("u2", "fp1") == 2

    def test_eviction_drops_oldest(self):
        store = InMemorySessionStore(max_entries=2)
        store.next_hint_level("u1", "fp1")  # key A
        store.next_hint_level("u1", "fp2")  # key B
        store.next_hint_level("u1", "fp3")  # key C -> evicts A
        # A was evicted, so it restarts at level 1
        assert store.next_hint_level("u1", "fp1") == 1
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `python -m pytest tests/test_session_store.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'session_store'`

- [ ] **Step 3: Write minimal implementation**

Create `backend/session_store.py`:

```python
import hashlib
from collections import OrderedDict
from typing import Dict, Tuple


def code_fingerprint(code: str) -> str:
    normalized = "\n".join(line.rstrip() for line in code.strip().splitlines())
    return hashlib.sha1(normalized.encode("utf-8")).hexdigest()


class InMemorySessionStore:
    """In-memory session store. Used when Firestore is not configured and in
    tests. Bounded so a long-running process cannot leak unboundedly."""

    def __init__(self, max_entries: int = 10000):
        self._levels: "OrderedDict[Tuple[str, str], int]" = OrderedDict()
        self._active: Dict[str, bool] = {}
        self._max_entries = max_entries

    def next_hint_level(self, user_id: str, fingerprint: str) -> int:
        key = (user_id, fingerprint)
        current = self._levels.get(key, 0)
        new_level = min(3, current + 1)
        self._levels[key] = new_level
        self._levels.move_to_end(key)
        while len(self._levels) > self._max_entries:
            self._levels.popitem(last=False)
        return new_level

    def begin_session(self, user_id: str) -> bool:
        if self._active.get(user_id, False):
            return False
        self._active[user_id] = True
        return True

    def reset(self, user_id: str) -> None:
        keys = [k for k in self._levels if k[0] == user_id]
        for k in keys:
            self._levels.pop(k, None)
        self._active.pop(user_id, None)
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `python -m pytest tests/test_session_store.py -v`
Expected: PASS (14 tests)

- [ ] **Step 5: Commit**

```bash
git add backend/session_store.py backend/tests/test_session_store.py
git commit -m "Add code_fingerprint and InMemorySessionStore"
```

---

### Task 2: `FirestoreSessionStore` + `build_session_store`

**Files:**
- Modify: `backend/session_store.py`
- Modify: `backend/firebase_service.py` (add `client` property)
- Test: `backend/tests/test_session_store.py`

- [ ] **Step 1: Write the failing tests**

Append to `backend/tests/test_session_store.py`:

```python
from session_store import FirestoreSessionStore, build_session_store


# --- Minimal in-memory fake Firestore client ---------------------------------

class _FakeSnap:
    def __init__(self, data):
        self._data = data
        self.exists = data is not None

    def to_dict(self):
        return dict(self._data) if self._data is not None else {}


class _FakeDocRef:
    def __init__(self, col, doc_id):
        self._col = col
        self._id = doc_id
        self.reference = self

    def get(self):
        return _FakeSnap(self._col._docs.get(self._id))

    def set(self, data, merge=False):
        if merge and self._id in self._col._docs:
            self._col._docs[self._id].update(data)
        else:
            self._col._docs[self._id] = dict(data)

    def delete(self):
        self._col._docs.pop(self._id, None)


class _FakeQuery:
    def __init__(self, refs):
        self._refs = refs

    def stream(self):
        return list(self._refs)


class _FakeCollection:
    def __init__(self):
        self._docs = {}  # doc_id -> data dict

    def document(self, doc_id):
        return _FakeDocRef(self, doc_id)

    def where(self, field, op, value):
        refs = [
            _FakeDocRef(self, doc_id)
            for doc_id, data in self._docs.items()
            if op == "==" and data.get(field) == value
        ]
        return _FakeQuery(refs)


class _FakeBatch:
    def __init__(self):
        self._ops = []

    def delete(self, ref):
        self._ops.append(ref)

    def commit(self):
        for ref in self._ops:
            ref.delete()
        self._ops = []


class FakeFirestore:
    def __init__(self):
        self._cols = {}

    def collection(self, name):
        return self._cols.setdefault(name, _FakeCollection())

    def batch(self):
        return _FakeBatch()


# --- FirestoreSessionStore tests ---------------------------------------------

class TestFirestoreSessionStore:
    def _store(self):
        return FirestoreSessionStore(FakeFirestore())

    def test_level_starts_at_1(self):
        store = self._store()
        assert store.next_hint_level("u1", "fp1") == 1

    def test_level_increments_and_persists(self):
        store = self._store()
        store.next_hint_level("u1", "fp1")
        assert store.next_hint_level("u1", "fp1") == 2

    def test_level_caps_at_3(self):
        store = self._store()
        for _ in range(5):
            level = store.next_hint_level("u1", "fp1")
        assert level == 3

    def test_different_fingerprint_independent(self):
        store = self._store()
        store.next_hint_level("u1", "fp1")
        store.next_hint_level("u1", "fp1")
        assert store.next_hint_level("u1", "fp2") == 1

    def test_begin_session_first_time_true(self):
        store = self._store()
        assert store.begin_session("u1") is True

    def test_begin_session_active_false(self):
        store = self._store()
        store.begin_session("u1")
        assert store.begin_session("u1") is False

    def test_reset_clears_levels(self):
        store = self._store()
        store.next_hint_level("u1", "fp1")
        store.next_hint_level("u1", "fp1")
        store.reset("u1")
        assert store.next_hint_level("u1", "fp1") == 1

    def test_reset_clears_session_flag(self):
        store = self._store()
        store.begin_session("u1")
        store.reset("u1")
        assert store.begin_session("u1") is True

    def test_reset_only_affects_target_user(self):
        store = self._store()
        store.next_hint_level("u1", "fp1")
        store.next_hint_level("u2", "fp1")
        store.reset("u1")
        assert store.next_hint_level("u2", "fp1") == 2


class TestBuildSessionStore:
    def test_returns_firestore_when_enabled(self):
        class _FB:
            enabled = True
            client = FakeFirestore()
        store = build_session_store(_FB())
        assert isinstance(store, FirestoreSessionStore)

    def test_returns_in_memory_when_disabled(self):
        class _FB:
            enabled = False
            client = None
        store = build_session_store(_FB())
        assert isinstance(store, InMemorySessionStore)
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `python -m pytest tests/test_session_store.py -v`
Expected: FAIL — `ImportError: cannot import name 'FirestoreSessionStore' from 'session_store'`

- [ ] **Step 3: Write minimal implementation**

Add to the top imports of `backend/session_store.py`:

```python
from firebase_admin import firestore
```

Append to `backend/session_store.py`:

```python
class FirestoreSessionStore:
    """Firestore-backed session store. Survives backend restarts.

    Uses plain read-then-write (no transaction); the deployment target is a
    single server where contention is negligible. All Firestore calls are
    wrapped so a backend failure never breaks the request path."""

    SESSIONS = "sessions"
    META = "sessions_meta"

    def __init__(self, client):
        self._client = client

    def _doc_id(self, user_id: str, fingerprint: str) -> str:
        return f"{user_id}__{fingerprint}"

    def next_hint_level(self, user_id: str, fingerprint: str) -> int:
        try:
            ref = self._client.collection(self.SESSIONS).document(
                self._doc_id(user_id, fingerprint)
            )
            snap = ref.get()
            current = int(snap.to_dict().get("hint_level", 0)) if snap.exists else 0
            new_level = min(3, current + 1)
            ref.set(
                {
                    "user_id": user_id,
                    "fingerprint": fingerprint,
                    "hint_level": new_level,
                    "updated_at": firestore.SERVER_TIMESTAMP,
                }
            )
            return new_level
        except Exception as e:
            print(f"[session] next_hint_level failed: {e}")
            return 1

    def begin_session(self, user_id: str) -> bool:
        try:
            ref = self._client.collection(self.META).document(user_id)
            snap = ref.get()
            active = bool(snap.to_dict().get("active", False)) if snap.exists else False
            if active:
                return False
            ref.set(
                {"active": True, "updated_at": firestore.SERVER_TIMESTAMP}, merge=True
            )
            return True
        except Exception as e:
            print(f"[session] begin_session failed: {e}")
            return False

    def reset(self, user_id: str) -> None:
        try:
            refs = self._client.collection(self.SESSIONS).where(
                "user_id", "==", user_id
            ).stream()
            batch = self._client.batch()
            count = 0
            for doc in refs:
                batch.delete(doc.reference)
                count += 1
            if count:
                batch.commit()
            self._client.collection(self.META).document(user_id).set(
                {"active": False}, merge=True
            )
        except Exception as e:
            print(f"[session] reset failed: {e}")


def build_session_store(firebase):
    """Return a Firestore-backed store when Firestore is configured, else an
    in-memory store."""
    if getattr(firebase, "enabled", False):
        return FirestoreSessionStore(firebase.client)
    return InMemorySessionStore()
```

Add the `client` property to `backend/firebase_service.py`, immediately after the existing `enabled` property (around line 39-41):

```python
    @property
    def client(self):
        return self._client
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `python -m pytest tests/test_session_store.py -v`
Expected: PASS (all tests, including the 11 new ones)

- [ ] **Step 5: Commit**

```bash
git add backend/session_store.py backend/firebase_service.py backend/tests/test_session_store.py
git commit -m "Add FirestoreSessionStore, build_session_store, and client accessor"
```

---

### Task 3: Wire the store into `main.py` and update endpoint tests

**Files:**
- Modify: `backend/main.py`
- Modify: `backend/tests/test_main.py`

- [ ] **Step 1: Update the endpoint-test fixture to inject the store**

In `backend/tests/test_main.py`, replace the `client` fixture (currently lines ~58-66) with:

```python
@pytest.fixture()
def client():
    from fastapi.testclient import TestClient
    import main as app_main
    from session_store import InMemorySessionStore
    # Fresh, isolated session state per test.
    app_main.store = InMemorySessionStore()
    with TestClient(app_main.app) as c:
        yield c
```

- [ ] **Step 2: Run the endpoint tests to verify they fail**

Run: `python -m pytest tests/test_main.py -v`
Expected: FAIL — `AttributeError: module 'main' has no attribute 'store'` (the fixture references `app_main.store`, which does not exist yet)

- [ ] **Step 3: Refactor `main.py` to use the store**

In `backend/main.py`:

Replace the import line `from typing import Dict, Tuple, List` with:

```python
from typing import List
```

Remove the `import hashlib` line.

Add to the imports (next to `from hinting_engine import build_engine`):

```python
from session_store import build_session_store, code_fingerprint
```

Replace the engine/firebase/session block (currently lines ~41-59, from `engine = build_engine()` through the end of `_next_hint_level`) with:

```python
engine = build_engine()
firebase = FirebaseService()
store = build_session_store(firebase)
```

Replace the body of the `hint` endpoint's level lookup. Change:

```python
    level = _next_hint_level(req.user_id, req.code)
```

to:

```python
    level = store.next_hint_level(req.user_id, code_fingerprint(req.code))
```

Change the new-session lines:

```python
    is_new_session = not _session_started.get(req.user_id, False)
    _session_started[req.user_id] = True
```

to:

```python
    is_new_session = store.begin_session(req.user_id)
```

Replace the entire `reset_session` endpoint body. Change:

```python
@app.post("/reset")
async def reset_session(req: ResetSessionRequest):
    prefix = req.user_id
    keys_to_remove = [k for k in _session_state.keys() if k[0] == prefix]
    for k in keys_to_remove:
        _session_state.pop(k, None)
    _session_started.pop(prefix, None)
    return {"status": "reset", "user_id": req.user_id}
```

to:

```python
@app.post("/reset")
async def reset_session(req: ResetSessionRequest):
    store.reset(req.user_id)
    return {"status": "reset", "user_id": req.user_id}
```

- [ ] **Step 4: Run the full backend suite to verify everything passes**

Run: `python -m pytest -q`
Expected: PASS (all tests — `test_session_store.py`, `test_main.py`, `test_hinting_engine.py`, `test_firebase_service.py`, `test_models.py`)

- [ ] **Step 5: Verify the dead helpers and imports are gone**

Run: `python -m pytest -q && grep -n "_session_state\|_session_started\|_next_hint_level\|_code_fingerprint\|import hashlib" backend/main.py`
Expected: tests PASS and the grep prints nothing (no matches).

- [ ] **Step 6: Commit**

```bash
git add backend/main.py backend/tests/test_main.py
git commit -m "Wire SessionStore into /hint and /reset, removing in-memory dicts"
```

---

## Self-Review

**Spec coverage:**
- `SessionStore` interface (`next_hint_level`, `begin_session`, `reset`) → Tasks 1-2. ✓
- `InMemorySessionStore` with bounded growth → Task 1 (`max_entries` + eviction test). ✓
- `FirestoreSessionStore` (read-then-write, `sessions` collection, `sessions_meta` flag, batch-delete reset, error-wrapped) → Task 2. ✓
- `build_session_store(firebase)` factory → Task 2. ✓
- `code_fingerprint` moved into the module → Task 1. ✓
- Wiring in `main.py`, removal of dicts/helpers → Task 3. ✓
- Behavior preserved (1→2→3 cap, per-fingerprint reset-to-1, reset semantics) → covered by Task 1/2 tests and the unchanged `test_main.py` assertions. ✓
- `test_main.py` fixture injects in-memory store → Task 3 Step 1. ✓
- New-session flag returned by `begin_session` feeds `firebase.fire_and_forget(new_session=...)` → preserved in Task 3 Step 3. ✓

**Placeholder scan:** No TBD/TODO/vague steps; every code step shows complete code. ✓

**Type/name consistency:** Method names `next_hint_level`, `begin_session`, `reset` and the factory `build_session_store` / helper `code_fingerprint` are used identically across Tasks 1-3 and the spec. The `client` property added in Task 2 is consumed by `build_session_store` in the same task. ✓
