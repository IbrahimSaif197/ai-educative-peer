import pytest

from ratelimit import MAX_BUCKETS, RateLimiter, RateLimiterRegistry


def limiter_with_clock(capacity=3, per_seconds=60.0):
    limiter = RateLimiter(capacity, per_seconds)
    state = {"now": 1000.0}
    limiter._now = lambda: state["now"]
    return limiter, state


class TestRateLimiter:
    def test_rejects_nonsense_budgets(self):
        with pytest.raises(ValueError):
            RateLimiter(0, 60.0)
        with pytest.raises(ValueError):
            RateLimiter(5, 0)

    def test_allows_up_to_capacity(self):
        limiter, _ = limiter_with_clock(capacity=3)
        assert [limiter.check("u")[0] for _ in range(3)] == [True, True, True]

    def test_denies_past_capacity(self):
        limiter, _ = limiter_with_clock(capacity=3)
        for _ in range(3):
            limiter.check("u")
        allowed, retry_after = limiter.check("u")
        assert allowed is False
        assert retry_after > 0

    def test_retry_after_matches_refill_rate(self):
        # 3 per 60s means one token every 20s.
        limiter, _ = limiter_with_clock(capacity=3, per_seconds=60.0)
        for _ in range(3):
            limiter.check("u")
        _, retry_after = limiter.check("u")
        assert retry_after == pytest.approx(20.0, abs=0.01)

    def test_refills_over_time(self):
        limiter, state = limiter_with_clock(capacity=3, per_seconds=60.0)
        for _ in range(3):
            limiter.check("u")
        assert limiter.check("u")[0] is False
        state["now"] += 20.0
        assert limiter.check("u")[0] is True

    def test_refill_is_capped_at_capacity(self):
        limiter, state = limiter_with_clock(capacity=3, per_seconds=60.0)
        limiter.check("u")
        state["now"] += 100_000
        assert [limiter.check("u")[0] for _ in range(4)] == [True, True, True, False]

    def test_buckets_are_per_user(self):
        limiter, _ = limiter_with_clock(capacity=2)
        limiter.check("alice")
        limiter.check("alice")
        assert limiter.check("alice")[0] is False
        assert limiter.check("bob")[0] is True

    def test_reset_restores_a_users_budget(self):
        limiter, _ = limiter_with_clock(capacity=1)
        limiter.check("u")
        assert limiter.check("u")[0] is False
        limiter.reset("u")
        assert limiter.check("u")[0] is True

    def test_bucket_map_stays_bounded(self):
        limiter, _ = limiter_with_clock(capacity=1)
        for i in range(MAX_BUCKETS + 100):
            limiter.check(f"user-{i}")
        assert len(limiter._buckets) <= MAX_BUCKETS

    def test_evicted_bucket_starts_full_again(self):
        # Dropping a bucket must never deny a user; it only forgets their spend.
        limiter, _ = limiter_with_clock(capacity=1)
        limiter.check("victim")
        for i in range(MAX_BUCKETS + 10):
            limiter.check(f"filler-{i}")
        assert limiter.check("victim")[0] is True


class TestRateLimiterRegistry:
    def test_named_budgets_are_independent(self):
        registry = RateLimiterRegistry({"hint": (1, 60.0), "inline": (5, 60.0)})
        assert registry.check("hint", "u")[0] is True
        assert registry.check("hint", "u")[0] is False
        assert registry.check("inline", "u")[0] is True

    def test_unknown_bucket_allows_through(self):
        registry = RateLimiterRegistry({"hint": (1, 60.0)})
        assert registry.check("does-not-exist", "u") == (True, 0.0)

    def test_clear_resets_every_limiter(self):
        registry = RateLimiterRegistry({"hint": (1, 60.0)})
        registry.check("hint", "u")
        assert registry.check("hint", "u")[0] is False
        registry.clear()
        assert registry.check("hint", "u")[0] is True
