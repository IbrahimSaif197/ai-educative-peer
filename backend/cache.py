"""A tiny in-process TTL cache.

The extension fires /scan and /line-hint automatically as the student types.
Without a cache, re-opening the same unchanged file burns Groq calls for a
reply we already have. Entries are keyed on the uid as well as the content, so
one student's cached answer is never served to another.

Deliberately in-process: EduPeer is deployed as a single uvicorn server, and a
shared cache would mean another service to pay for.
"""

import time
from collections import OrderedDict
from typing import Any, Hashable, Optional


class TtlCache:
    """Bounded LRU cache whose entries expire after `ttl_seconds`."""

    def __init__(self, ttl_seconds: float = 300.0, max_entries: int = 1000):
        self._ttl = ttl_seconds
        self._max_entries = max_entries
        self._entries: "OrderedDict[Hashable, tuple]" = OrderedDict()

    def _now(self) -> float:
        # Monotonic: immune to wall-clock jumps (NTP, DST, manual changes).
        return time.monotonic()

    def get(self, key: Hashable) -> Optional[Any]:
        """The cached value, or None when absent or expired."""
        hit = self._entries.get(key)
        if hit is None:
            return None
        stored_at, value = hit
        if self._now() - stored_at >= self._ttl:
            self._entries.pop(key, None)
            return None
        self._entries.move_to_end(key)
        return value

    def set(self, key: Hashable, value: Any) -> None:
        self._entries[key] = (self._now(), value)
        self._entries.move_to_end(key)
        while len(self._entries) > self._max_entries:
            self._entries.popitem(last=False)

    def clear(self) -> None:
        self._entries.clear()

    def __len__(self) -> int:
        return len(self._entries)
