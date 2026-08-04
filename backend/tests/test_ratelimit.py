from __future__ import annotations

from backend.ratelimit import RateLimiter, client_digest


def test_allows_up_to_capacity_then_refuses() -> None:
    limiter = RateLimiter(capacity=3, refill_per_min=1.0, daily_ceiling=100)

    assert [limiter.check("1.2.3.4", now=0.0).allowed for _ in range(3)] == [True] * 3
    assert limiter.check("1.2.3.4", now=0.0).allowed is False


def test_refusal_names_a_wait_and_a_reason() -> None:
    limiter = RateLimiter(capacity=1, refill_per_min=6.0, daily_ceiling=100)
    limiter.check("1.2.3.4", now=0.0)

    decision = limiter.check("1.2.3.4", now=0.0)
    assert decision.reason == "per_ip"
    assert decision.retry_after_s > 0
    assert "wait" in decision.message.lower()


def test_buckets_are_per_client() -> None:
    limiter = RateLimiter(capacity=1, refill_per_min=1.0, daily_ceiling=100)
    limiter.check("1.1.1.1", now=0.0)

    assert limiter.check("2.2.2.2", now=0.0).allowed is True


def test_tokens_refill_over_time() -> None:
    limiter = RateLimiter(capacity=2, refill_per_min=60.0, daily_ceiling=100)
    limiter.check("1.2.3.4", now=0.0)
    limiter.check("1.2.3.4", now=0.0)
    assert limiter.check("1.2.3.4", now=0.0).allowed is False

    # 60 tokens/min == 1 token/s.
    assert limiter.check("1.2.3.4", now=1.5).allowed is True


def test_refill_never_exceeds_capacity() -> None:
    limiter = RateLimiter(capacity=2, refill_per_min=60.0, daily_ceiling=100)
    limiter.check("1.2.3.4", now=0.0)

    for _ in range(2):
        assert limiter.check("1.2.3.4", now=10_000.0).allowed is True
    assert limiter.check("1.2.3.4", now=10_000.0).allowed is False


def test_global_daily_ceiling_applies_across_all_clients() -> None:
    limiter = RateLimiter(capacity=10, refill_per_min=600.0, daily_ceiling=2)
    assert limiter.check("1.1.1.1", now=0.0).allowed is True
    assert limiter.check("2.2.2.2", now=0.0).allowed is True

    decision = limiter.check("3.3.3.3", now=0.0)
    assert decision.allowed is False
    assert decision.reason == "daily_ceiling"
    assert "tomorrow" in decision.message.lower()


def test_refund_returns_a_token_and_a_daily_slot() -> None:
    """A cache hit costs no upstream credit, so it must not cost the user one."""
    limiter = RateLimiter(capacity=1, refill_per_min=0.0, daily_ceiling=5)
    limiter.check("1.2.3.4", now=0.0)
    limiter.refund("1.2.3.4")

    assert limiter.check("1.2.3.4", now=0.0).allowed is True
    assert limiter.served_today() == 1


def test_client_digest_is_not_reversible_and_is_stable() -> None:
    a = client_digest("203.0.113.9")
    assert a == client_digest("203.0.113.9")
    assert "203.0.113.9" not in a
    assert a != client_digest("203.0.113.10")


def test_missing_ip_still_gets_a_bucket() -> None:
    limiter = RateLimiter(capacity=1, refill_per_min=1.0, daily_ceiling=10)

    assert limiter.check(None, now=0.0).allowed is True
    assert limiter.check(None, now=0.0).allowed is False
