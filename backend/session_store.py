import hashlib
import time
from collections import OrderedDict
from typing import Dict, Tuple

from firebase_admin import firestore


def code_fingerprint(code: str) -> str:
    normalized = "\n".join(line.rstrip() for line in code.strip().splitlines())
    return hashlib.sha1(normalized.encode("utf-8")).hexdigest()


def raw_code_hash(code: str) -> str:
    """An exact hash of the code, byte for byte.

    `code_fingerprint` deliberately ignores whitespace, which is right for the
    hint ladder ("is this the same problem?") and wrong for anything that
    caches absolute line numbers: adding a blank line at the top shifts every
    line without changing the fingerprint. Caches keyed on line numbers use
    this instead.
    """
    return hashlib.sha1(code.encode("utf-8")).hexdigest()


# A student who has walked away and come back is starting a new session, even
# though they never pressed Reset. Without this, `sessions` freezes at 1 after
# the first hint and the Persistent/Marathon/Scholar badges are unreachable.
SESSION_IDLE_SECONDS = 1800.0


def resolve_level(current: int, escalate: bool) -> int:
    """The level an ask should answer at, given the level already spent.

    Escalating advances by one and stops at 3. Not escalating re-uses the
    level, with a floor of 1 so a first-ever non-escalating ask still gets a
    level-1 hint.
    """
    if escalate:
        return min(3, current + 1)
    return max(1, min(3, current))


class InMemorySessionStore:
    """In-memory session store. Used when Firestore is not configured and in
    tests. Bounded so a long-running process cannot leak unboundedly."""

    def __init__(self, max_entries: int = 10000, idle_seconds: float = SESSION_IDLE_SECONDS):
        self._levels: "OrderedDict[Tuple[str, str], int]" = OrderedDict()
        # uid -> monotonic time of the last activity in the open session.
        self._active: Dict[str, float] = {}
        self._max_entries = max_entries
        self._idle_seconds = idle_seconds

    def peek_hint_level(self, user_id: str, fingerprint: str, escalate: bool = True) -> int:
        """What the next ask should answer at, WITHOUT spending the level.

        Callers commit only once the hint has actually been produced, so a
        failed LLM call cannot walk a student down the hint ladder.
        """
        return resolve_level(self._levels.get((user_id, fingerprint), 0), escalate)

    def commit_hint_level(self, user_id: str, fingerprint: str, level: int) -> None:
        """Record that `level` was actually delivered for this code."""
        key = (user_id, fingerprint)
        self._levels[key] = max(1, min(3, int(level)))
        self._levels.move_to_end(key)
        while len(self._levels) > self._max_entries:
            self._levels.popitem(last=False)

    def next_hint_level(self, user_id: str, fingerprint: str) -> int:
        """Peek and commit in one step. Kept for callers that have already
        produced their hint."""
        level = self.peek_hint_level(user_id, fingerprint, escalate=True)
        self.commit_hint_level(user_id, fingerprint, level)
        return level

    def current_hint_level(self, user_id: str, fingerprint: str) -> int:
        """The level for this code without advancing it.

        Used when the student asks again without editing anything: they get
        the same depth of hint back rather than a free escalation.
        """
        level = self.peek_hint_level(user_id, fingerprint, escalate=False)
        self.commit_hint_level(user_id, fingerprint, level)
        return level

    def begin_session(self, user_id: str) -> bool:
        """True when this ask opens a new session.

        A session stays open while the student keeps working and lapses after
        `idle_seconds` of silence, so a student who returns tomorrow is counted
        again without having to press Reset.
        """
        now = time.monotonic()
        last = self._active.get(user_id)
        self._active[user_id] = now
        return last is None or (now - last) >= self._idle_seconds

    def reset(self, user_id: str) -> None:
        keys = [k for k in self._levels if k[0] == user_id]
        for k in keys:
            self._levels.pop(k, None)
        self._active.pop(user_id, None)


class FirestoreSessionStore:
    """Firestore-backed session store. Survives backend restarts.

    Uses plain read-then-write (no transaction); the deployment target is a
    single server where contention is negligible. All Firestore calls are
    wrapped so a backend failure never breaks the request path."""

    SESSIONS = "sessions"
    META = "sessions_meta"
    # Bounded so a slow/unreachable Firestore fails fast and degrades to safe
    # defaults instead of hanging the request indefinitely.
    TIMEOUT = 5.0

    def __init__(self, client, idle_seconds: float = SESSION_IDLE_SECONDS):
        self._client = client
        self._idle_seconds = idle_seconds

    def _doc_id(self, user_id: str, fingerprint: str) -> str:
        """A Firestore-safe document ID for one (user, problem) pair.

        Hashed rather than interpolated, because `fingerprint` is whatever the
        client sent as `problem_key` — and that is a document URI,
        `file:///c%3A/.../demo.py#average`. Firestore reads "/" as a path
        separator, so the raw ID produced a resource name with an odd number
        of segments and the server rejected every read and write with
        "lacks a collection id". Both call sites below swallow their
        exceptions, so nothing surfaced: `peek_hint_level` fell through to its
        hardcoded `return 1` and `commit_hint_level` stored nothing. The
        ladder answered every ask at level 1 forever, so the student was asked
        a fresh guiding question each time and never reached level 2 — the
        rung that names the line and explains the concept.

        Nothing needs this ID to be legible: `commit_hint_level` writes the
        readable key as the `fingerprint` field and `reset` queries on
        `user_id`. The NUL separator keeps the two halves from bleeding into
        each other, so ("u1__x", "y") and ("u1", "x__y") stay distinct.
        """
        return hashlib.sha1(f"{user_id}\x00{fingerprint}".encode("utf-8")).hexdigest()

    def peek_hint_level(self, user_id: str, fingerprint: str, escalate: bool = True) -> int:
        """What the next ask should answer at, WITHOUT spending the level.

        Read-only: nothing is written, so a failed LLM call leaves the ladder
        exactly where it was.
        """
        try:
            ref = self._client.collection(self.SESSIONS).document(
                self._doc_id(user_id, fingerprint)
            )
            snap = ref.get(timeout=self.TIMEOUT)
            current = int(snap.to_dict().get("hint_level", 0)) if snap.exists else 0
            return resolve_level(current, escalate)
        except Exception as e:
            print(f"[session] peek_hint_level failed: {e}")
            return 1

    def commit_hint_level(self, user_id: str, fingerprint: str, level: int) -> None:
        """Record that `level` was actually delivered for this code."""
        try:
            ref = self._client.collection(self.SESSIONS).document(
                self._doc_id(user_id, fingerprint)
            )
            ref.set(
                {
                    "user_id": user_id,
                    "fingerprint": fingerprint,
                    "hint_level": max(1, min(3, int(level))),
                    "updated_at": firestore.SERVER_TIMESTAMP,
                },
                timeout=self.TIMEOUT,
            )
        except Exception as e:
            print(f"[session] commit_hint_level failed: {e}")

    def next_hint_level(self, user_id: str, fingerprint: str) -> int:
        """Peek and commit in one step."""
        level = self.peek_hint_level(user_id, fingerprint, escalate=True)
        self.commit_hint_level(user_id, fingerprint, level)
        return level

    def current_hint_level(self, user_id: str, fingerprint: str) -> int:
        """The level for this code without advancing it (see the in-memory twin)."""
        level = self.peek_hint_level(user_id, fingerprint, escalate=False)
        self.commit_hint_level(user_id, fingerprint, level)
        return level

    def begin_session(self, user_id: str) -> bool:
        """True when this ask opens a new session (see the in-memory twin).

        `last_active_at` is written as plain epoch seconds rather than
        SERVER_TIMESTAMP so the idle comparison never has to reason about the
        sentinel value or a timezone-aware Firestore type on read-back.
        """
        try:
            now = time.time()
            ref = self._client.collection(self.META).document(user_id)
            snap = ref.get(timeout=self.TIMEOUT)
            data = snap.to_dict() if snap.exists else None
            active = bool(data.get("active", False)) if data else False
            try:
                last = float(data.get("last_active_at", 0.0)) if data else 0.0
            except (TypeError, ValueError):
                last = 0.0
            is_new = (not active) or last <= 0.0 or (now - last) >= self._idle_seconds
            ref.set(
                {
                    "active": True,
                    "last_active_at": now,
                    "updated_at": firestore.SERVER_TIMESTAMP,
                },
                merge=True,
                timeout=self.TIMEOUT,
            )
            return is_new
        except Exception as e:
            print(f"[session] begin_session failed: {e}")
            return False

    def reset(self, user_id: str) -> None:
        try:
            refs = self._client.collection(self.SESSIONS).where(
                "user_id", "==", user_id
            ).stream(timeout=self.TIMEOUT)
            batch = self._client.batch()
            count = 0
            for doc in refs:
                batch.delete(doc.reference)
                count += 1
            if count:
                batch.commit(timeout=self.TIMEOUT)
            self._client.collection(self.META).document(user_id).set(
                {"active": False, "last_active_at": 0.0}, merge=True, timeout=self.TIMEOUT
            )
        except Exception as e:
            print(f"[session] reset failed: {e}")


def build_session_store(firebase):
    """Return a Firestore-backed store when Firestore is configured, else an
    in-memory store."""
    if getattr(firebase, "enabled", False):
        return FirestoreSessionStore(firebase.client)
    return InMemorySessionStore()
