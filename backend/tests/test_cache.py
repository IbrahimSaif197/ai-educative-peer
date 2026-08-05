from cache import TtlCache


class FakeClock:
    """Drives TtlCache's monotonic clock so tests never sleep."""

    def __init__(self):
        self.now = 1000.0

    def advance(self, seconds):
        self.now += seconds


def cache_with_clock(ttl=300.0, max_entries=1000):
    clock = FakeClock()
    cache = TtlCache(ttl_seconds=ttl, max_entries=max_entries)
    cache._now = lambda: clock.now
    return cache, clock


class TestTtlCache:
    def test_miss_returns_none(self):
        cache, _ = cache_with_clock()
        assert cache.get("nothing") is None

    def test_set_then_get(self):
        cache, _ = cache_with_clock()
        cache.set("k", [1, 2, 3])
        assert cache.get("k") == [1, 2, 3]

    def test_entry_expires_after_ttl(self):
        cache, clock = cache_with_clock(ttl=10.0)
        cache.set("k", "v")
        clock.advance(9.9)
        assert cache.get("k") == "v"
        clock.advance(0.2)
        assert cache.get("k") is None

    def test_expired_entry_is_evicted_not_just_hidden(self):
        cache, clock = cache_with_clock(ttl=10.0)
        cache.set("k", "v")
        clock.advance(11)
        cache.get("k")
        assert len(cache) == 0

    def test_evicts_least_recently_used_past_capacity(self):
        cache, _ = cache_with_clock(max_entries=2)
        cache.set("a", 1)
        cache.set("b", 2)
        cache.get("a")  # 'a' is now the most recently used
        cache.set("c", 3)
        assert cache.get("b") is None
        assert cache.get("a") == 1
        assert cache.get("c") == 3

    def test_never_exceeds_capacity(self):
        cache, _ = cache_with_clock(max_entries=5)
        for i in range(50):
            cache.set(f"k{i}", i)
        assert len(cache) == 5

    def test_overwrite_replaces_value_and_resets_age(self):
        cache, clock = cache_with_clock(ttl=10.0)
        cache.set("k", "old")
        clock.advance(9)
        cache.set("k", "new")
        clock.advance(5)
        assert cache.get("k") == "new"

    def test_tuple_keys_are_distinct(self):
        cache, _ = cache_with_clock()
        cache.set(("alice", "python", "fp"), "a-value")
        cache.set(("bob", "python", "fp"), "b-value")
        # Same code fingerprint, different user: no cross-user leakage.
        assert cache.get(("alice", "python", "fp")) == "a-value"
        assert cache.get(("bob", "python", "fp")) == "b-value"

    def test_falsy_values_round_trip(self):
        cache, _ = cache_with_clock()
        cache.set("empty", [])
        assert cache.get("empty") == []

    def test_clear_empties_the_cache(self):
        cache, _ = cache_with_clock()
        cache.set("k", "v")
        cache.clear()
        assert cache.get("k") is None
        assert len(cache) == 0
