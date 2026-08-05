"""Per-user token-bucket rate limiting.

EduPeer runs on the Groq free tier. The inline tutor fires /scan and
/line-hint on a timer, so a single stuck client can drain the daily quota for
everyone. These buckets bound that: a burst is fine, a runaway loop is not.

State is in-process and per uid. Restarting the server resets every bucket,
which is acceptable for a quota guard (it is not a security control).
"""

import time
from collections import OrderedDict
from typing import Dict, Tuple

# Beyond this many tracked users the oldest buckets are dropped. A dropped
# bucket just means that user starts full again - it never denies them.
MAX_BUCKETS = 5000


class RateLimiter:
    """`capacity` requests per bucket, refilled evenly over `per_seconds`."""

    def __init__(self, capacity: int, per_seconds: float):
        if capacity <= 0 or per_seconds <= 0:
            raise ValueError("capacity and per_seconds must be positive")
        self.capacity = float(capacity)
        self.per_seconds = float(per_seconds)
        self._refill_rate = self.capacity / self.per_seconds
        self._buckets: "OrderedDict[str, Tuple[float, float]]" = OrderedDict()

    def _now(self) -> float:
        return time.monotonic()

    def check(self, key: str) -> Tuple[bool, float]:
        """Try to spend one token.

        Returns (allowed, retry_after_seconds). retry_after is 0.0 when
        allowed, and otherwise the wait until one whole token is available.
        """
        now = self._now()
        tokens, last_seen = self._buckets.get(key, (self.capacity, now))
        tokens = min(self.capacity, tokens + (now - last_seen) * self._refill_rate)

        if tokens >= 1.0:
            self._buckets[key] = (tokens - 1.0, now)
            allowed, retry_after = True, 0.0
        else:
            self._buckets[key] = (tokens, now)
            allowed = False
            retry_after = round((1.0 - tokens) / self._refill_rate, 3)

        self._buckets.move_to_end(key)
        while len(self._buckets) > MAX_BUCKETS:
            self._buckets.popitem(last=False)
        return allowed, retry_after

    def reset(self, key: str) -> None:
        self._buckets.pop(key, None)

    def clear(self) -> None:
        self._buckets.clear()


class RateLimiterRegistry:
    """Named limiters, so each endpoint group gets its own budget."""

    def __init__(self, budgets: Dict[str, Tuple[int, float]]):
        self._limiters = {
            name: RateLimiter(capacity, per) for name, (capacity, per) in budgets.items()
        }

    def check(self, name: str, key: str) -> Tuple[bool, float]:
        limiter = self._limiters.get(name)
        if limiter is None:
            return True, 0.0
        return limiter.check(key)

    def clear(self) -> None:
        for limiter in self._limiters.values():
            limiter.clear()
