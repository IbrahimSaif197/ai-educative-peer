# Session-State Persistence Design

**Date:** 2026-06-15
**Status:** Approved (pending spec review)

## Problem

The backend tracks per-student tutoring state in two in-memory dictionaries in
`backend/main.py`:

- `_session_state: Dict[(user_id, code_fingerprint), int]` — the current hint
  level (1→2→3) for each student + code snippet.
- `_session_started: Dict[user_id, bool]` — whether a student has an active
  session (used to count "new sessions" for the Persistent Learner badge).

This has three problems:

1. **Restart wipes state.** Any redeploy, crash, or `--reload` resets every
   student to hint level 1.
2. **Unbounded growth.** Entries are never evicted, so memory climbs over time.
3. **Not shared across processes.** Multiple workers would each keep their own
   copy, making progression nondeterministic.

For this project the deployment target is **a single server that may restart**,
and we want hint levels + session counts to survive restarts. Firebase/Firestore
is already wired in for badges, so we reuse it. Cost is a non-issue (testing-only
usage, well within Firestore's free tier).

## Goals

- Hint-level progression and session-started state survive backend restarts.
- No new infrastructure or environment variables.
- Graceful fallback to in-memory state when Firestore is not configured (local
  dev, tests).
- Existing tutoring behavior is preserved exactly.

## Non-Goals

- Multi-worker / horizontal scaling correctness (single server only).
- Changing the "edit code → hint level resets to 1" behavior. The level is keyed
  on a code fingerprint today; that is preserved. Smoothing this (e.g. not
  resetting on tiny edits) is a separate future task.
- Redis or any external cache.

## Approach

Introduce a small `SessionStore` abstraction with two implementations, and have
`main.py` depend on the interface rather than on raw dictionaries.

### New module: `backend/session_store.py`

Interface (informal — duck-typed, no ABC required):

```python
def next_hint_level(user_id: str, code_fingerprint: str) -> int
    # Read current level, increment, cap at 3, persist, return new level.

def begin_session(user_id: str) -> bool
    # Mark the user's session active. Return True if this STARTS a new session
    # (i.e. it was not already active), else False.

def reset(user_id: str) -> None
    # Clear all of the user's hint-level entries and their session-active flag.
```

`_code_fingerprint(code)` moves from `main.py` into this module (callers pass the
fingerprint, or a helper computes it — see wiring below).

### `InMemorySessionStore`

- Holds the two dicts internally (current behavior, extracted verbatim).
- Adds a bounded capacity for the level dict (simple cap with oldest-entry
  eviction) so the long-running fallback cannot leak unboundedly. Default cap
  generous (e.g. 10,000 entries); never an issue in practice but closes the leak.
- Used when Firestore is unavailable and in unit tests.

### `FirestoreSessionStore`

Backed by the existing Firestore client (obtained from `FirebaseService`).

- **Collection `sessions`**, document id `f"{user_id}__{fingerprint}"`, fields:
  `{ user_id, fingerprint, hint_level: int, updated_at: SERVER_TIMESTAMP }`.
- `next_hint_level`: plain **read-then-write** (no transaction — single server,
  negligible contention). Read doc → `level = min(3, current + 1)` → set doc.
- `begin_session`: read/maintain an `active` flag on a per-user meta document
  (`sessions_meta/{user_id}` with `{ active: bool }`). Returns True when it
  transitions inactive→active.
- `reset`: query `sessions` where `user_id == uid`, batch-delete the results,
  and clear the `active` flag on the meta doc.
- Every Firestore call is wrapped in try/except and logs on failure, matching
  the existing `FirebaseService` style. On error it degrades safely (returns a
  sensible default rather than raising into the request path).

### Wiring in `main.py`

- Add `build_session_store(firebase) -> SessionStore`: returns
  `FirestoreSessionStore` when `firebase.enabled`, else `InMemorySessionStore`.
- Remove `_session_state`, `_session_started`, and `_next_hint_level`.
- `/hint` calls `store.next_hint_level(...)` and `store.begin_session(...)`.
- `/reset` calls `store.reset(user_id)`.

## Data Flow (`/hint`)

1. Validate question (unchanged).
2. `level = store.next_hint_level(user_id, fingerprint)`.
3. Generate hint via the engine (unchanged).
4. `is_new_session = store.begin_session(user_id)`.
5. Fire-and-forget interaction log + badge update (unchanged).
6. Return hint + level + tags (unchanged).

## Behavior Preserved

- Levels escalate 1→2→3 per `(user, code fingerprint)`, capped at 3.
- A different code snippet starts again at level 1.
- Reset clears the user's progression and session flag; the next hint counts as
  a new session.

## Error Handling

- Firestore failures in the store are caught and logged; the request still
  succeeds. If a read fails, treat current level as 0 (so the student gets
  level 1) rather than erroring.
- When Firestore is not configured at all, the in-memory store is used
  transparently.

## Testing

- **New `backend/tests/test_session_store.py`**:
  - `InMemorySessionStore`: increment, cap at 3, per-key isolation, reset,
    new-session flag transitions, eviction cap.
  - `FirestoreSessionStore`: against a fake/mock Firestore client — verifies
    read-then-write increment, cap, reset (batch delete + flag clear), and the
    new-session flag.
- **`backend/tests/test_main.py`**: fixture injects a fresh
  `InMemorySessionStore` into `main` per test (replacing today's dict-clearing),
  keeping endpoint tests fast and deterministic while exercising the real
  fallback implementation. All existing `/hint` and `/reset` assertions remain
  valid unchanged.

## Operational Note (optional, not built)

A Firestore TTL policy on `sessions.updated_at` could auto-expire stale session
docs. Not required for this project; documented for future ops.
