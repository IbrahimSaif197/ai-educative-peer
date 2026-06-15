import hashlib
from collections import OrderedDict
from typing import Dict, Tuple

from firebase_admin import firestore


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

    def __init__(self, client):
        self._client = client

    def _doc_id(self, user_id: str, fingerprint: str) -> str:
        return f"{user_id}__{fingerprint}"

    def next_hint_level(self, user_id: str, fingerprint: str) -> int:
        try:
            ref = self._client.collection(self.SESSIONS).document(
                self._doc_id(user_id, fingerprint)
            )
            snap = ref.get(timeout=self.TIMEOUT)
            current = int(snap.to_dict().get("hint_level", 0)) if snap.exists else 0
            new_level = min(3, current + 1)
            ref.set(
                {
                    "user_id": user_id,
                    "fingerprint": fingerprint,
                    "hint_level": new_level,
                    "updated_at": firestore.SERVER_TIMESTAMP,
                },
                timeout=self.TIMEOUT,
            )
            return new_level
        except Exception as e:
            print(f"[session] next_hint_level failed: {e}")
            return 1

    def begin_session(self, user_id: str) -> bool:
        try:
            ref = self._client.collection(self.META).document(user_id)
            snap = ref.get(timeout=self.TIMEOUT)
            active = bool(snap.to_dict().get("active", False)) if snap.exists else False
            if active:
                return False
            ref.set(
                {"active": True, "updated_at": firestore.SERVER_TIMESTAMP},
                merge=True,
                timeout=self.TIMEOUT,
            )
            return True
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
                {"active": False}, merge=True, timeout=self.TIMEOUT
            )
        except Exception as e:
            print(f"[session] reset failed: {e}")


def build_session_store(firebase):
    """Return a Firestore-backed store when Firestore is configured, else an
    in-memory store."""
    if getattr(firebase, "enabled", False):
        return FirestoreSessionStore(firebase.client)
    return InMemorySessionStore()
