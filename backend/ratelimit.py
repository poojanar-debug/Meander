"""Per-IP token bucket plus a global daily ceiling.

The service is public and sits on a 500-credit/day routing quota. Without a
limiter, one script drains the day for everybody in about three minutes.

No IP is ever stored. Buckets are keyed by a digest computed with a salt
generated at process start and never written anywhere, exactly as in metrics.py.
"""

from __future__ import annotations

import hashlib
import os
import threading
import time
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from datetime import time as dt_time

_BUCKET_SALT = os.urandom(32)

# Buckets idle for longer than this are dropped so the dict cannot grow without
# bound under a rotating-IP flood.
_IDLE_EVICTION_S = 3600.0
_MAX_BUCKETS = 20_000


def client_digest(ip: str | None) -> str:
    """Non-reversible per-process bucket id. The IP is consumed and discarded."""
    return hashlib.blake2b((ip or "unknown").encode(), key=_BUCKET_SALT, digest_size=12).hexdigest()


@dataclass
class _Bucket:
    tokens: float
    last_refill: float
    last_seen: float


@dataclass
class Decision:
    allowed: bool
    reason: str = ""
    message: str = ""
    retry_after_s: int = 0


@dataclass
class RateLimiter:
    capacity: int
    refill_per_min: float
    daily_ceiling: int

    _buckets: dict[str, _Bucket] = field(default_factory=dict)
    _lock: threading.Lock = field(default_factory=threading.Lock)
    # The UTC date, not a stopwatch started when the process did.
    #
    # A rolling 24-hour window anchored at process start means every deploy,
    # crash or scale event hands the service a fresh daily quota — and on ECS
    # that is a far more likely occurrence than the two-task case. It also made
    # the ceiling unpredictable: "resets at midnight" is something an operator
    # can reason about, "resets 24 hours after whenever this container last
    # started" is not.
    _day: str = field(default_factory=lambda: datetime.now(UTC).date().isoformat())
    _served_today: int = 0

    def _evict_locked(self, now: float) -> None:
        if len(self._buckets) < _MAX_BUCKETS:
            return
        stale = [k for k, b in self._buckets.items() if now - b.last_seen > _IDLE_EVICTION_S]
        for k in stale:
            del self._buckets[k]
        if len(self._buckets) >= _MAX_BUCKETS:
            # Still full of active buckets: drop the least recently seen half.
            ordered = sorted(self._buckets.items(), key=lambda kv: kv[1].last_seen)
            for k, _ in ordered[: len(ordered) // 2]:
                del self._buckets[k]

    def _roll_day_locked(self) -> None:
        today = datetime.now(UTC).date().isoformat()
        if today != self._day:
            self._day = today
            self._served_today = 0

    @staticmethod
    def _seconds_to_midnight_utc() -> int:
        now = datetime.now(UTC)
        midnight = datetime.combine(
            now.date() + timedelta(days=1), dt_time.min, tzinfo=UTC
        )
        return max(1, int((midnight - now).total_seconds()))

    def check(self, ip: str | None, now: float | None = None) -> Decision:
        """Consume one token. Does not raise; the caller shapes the response."""
        now = time.monotonic() if now is None else now
        key = client_digest(ip)

        with self._lock:
            self._roll_day_locked()

            if self._served_today >= self.daily_ceiling:
                return Decision(
                    allowed=False,
                    reason="daily_ceiling",
                    message=(
                        "Meander has used up its routing allowance for today. It runs on a free "
                        "tier with a fixed daily quota. Please try again tomorrow."
                    ),
                    retry_after_s=self._seconds_to_midnight_utc(),
                )

            bucket = self._buckets.get(key)
            if bucket is None:
                self._evict_locked(now)
                bucket = _Bucket(tokens=float(self.capacity), last_refill=now, last_seen=now)
                self._buckets[key] = bucket

            elapsed_min = max(0.0, now - bucket.last_refill) / 60.0
            bucket.tokens = min(
                float(self.capacity), bucket.tokens + elapsed_min * self.refill_per_min
            )
            bucket.last_refill = now
            bucket.last_seen = now

            if bucket.tokens < 1.0:
                deficit = 1.0 - bucket.tokens
                wait = int(deficit / max(self.refill_per_min, 0.01) * 60) + 1
                return Decision(
                    allowed=False,
                    reason="per_ip",
                    message=(
                        f"That is a lot of routes in a short time. Please wait about "
                        f"{wait} seconds and try again."
                    ),
                    retry_after_s=wait,
                )

            bucket.tokens -= 1.0
            self._served_today += 1
            return Decision(allowed=True)

    def refund(self, ip: str | None) -> None:
        """Give a token back when a request was served entirely from cache.

        A cache hit costs no upstream credits, so charging for it would limit
        users for free.
        """
        key = client_digest(ip)
        with self._lock:
            bucket = self._buckets.get(key)
            if bucket is not None:
                bucket.tokens = min(float(self.capacity), bucket.tokens + 1.0)
            self._served_today = max(0, self._served_today - 1)

    def served_today(self) -> int:
        """The single enforced "routes served today" number.

        There used to be two of these on two different clocks — this one on a
        window from process start, and metrics.daily_routes_served on the UTC
        date — reachable through three accessors, with only this one actually
        checked against the ceiling. The other has been removed rather than
        reconciled: two counters that agree by coincidence are worse than one.
        """
        with self._lock:
            self._roll_day_locked()
            return self._served_today

    def reset(self) -> None:
        with self._lock:
            self._buckets.clear()
            self._served_today = 0
            self._day = datetime.now(UTC).date().isoformat()
