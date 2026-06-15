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
