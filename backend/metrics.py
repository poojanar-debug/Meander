"""Privacy-safe aggregate counters.

The only thing resembling identity here is a per-day session digest computed
from a salt that is generated at process start and never written anywhere. The
digest is held in a set that is discarded when the day rolls over, so there is
no way to work backwards to an IP even with the process memory in hand.
"""

from __future__ import annotations

import hashlib
import os
import threading
from collections import Counter
from datetime import UTC, date, datetime
from typing import Any

# Regenerated on every process start. Restarting the backend deliberately
# destroys the ability to correlate today's sessions with yesterday's.
_SESSION_SALT = os.urandom(32)


class Metrics:
    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._counters: Counter[str] = Counter()
        self._day: date = datetime.now(UTC).date()
        self._sessions_today: set[bytes] = set()
        self._started_at = datetime.now(UTC)

    def _roll_day_locked(self) -> None:
        today = datetime.now(UTC).date()
        if today != self._day:
            self._day = today
            self._sessions_today = set()

    def incr(self, name: str, amount: int = 1) -> None:
        with self._lock:
            self._roll_day_locked()
            self._counters[name] += amount

    def note_session(self, ip: str | None, user_agent: str | None) -> None:
        """Count a unique session without retaining anything identifying.

        ``ip`` and ``user_agent`` are consumed here and immediately discarded;
        they are never stored, logged, or returned.
        """
        material = f"{ip or ''}|{user_agent or ''}".encode()
        digest = hashlib.blake2b(material, key=_SESSION_SALT, digest_size=16).digest()
        with self._lock:
            self._roll_day_locked()
            self._sessions_today.add(digest)

    # Every counter that exists, named here so a new one appears without anyone
    # having to remember this list. They start at zero rather than being absent,
    # so a dashboard reading the endpoint sees a series from the first scrape
    # instead of a key that materialises on the first failure.
    KNOWN_COUNTERS = (
        "route_requests_total",
        "routes_blocked_total",
        "cache_hits_total",
        "cache_misses_total",
        "segments_scored_total",
        "rate_limited_total",
        "upstream_failures_total",
        "narration_failures_total",
        "enrichment_failures_total",
        "unhandled_errors_total",
        "stream_failures_total",
        "request_deadline_exceeded_total",
        "overpass_truncated_total",
        "client_disconnects_total",
    )

    def snapshot(self) -> dict[str, Any]:
        """Every counter, not an eleven-name allowlist.

        ⚠ **Five counters were incremented and never read.** `snapshot()`
        hard-coded eleven names while `incr()` accepted any, so
        `unhandled_errors_total`, `stream_failures_total`,
        `request_deadline_exceeded_total`, `overpass_truncated_total` and
        `client_disconnects_total` were maintained perfectly and published
        nowhere.

        `overpass_truncated_total` is the one that matters most: it is the
        **only** signal that the 6,000-element cap was reached, which means a
        barrier survey with holes in it was presented as a complete look. The
        code that raised that cap from 200 explains exactly why that is
        dangerous, and then left the alarm unwired.

        Unknown names are included too. A counter that exists is a counter
        somebody wanted; silently dropping it is how these five were lost.
        """
        with self._lock:
            self._roll_day_locked()
            counters = {name: self._counters[name] for name in self.KNOWN_COUNTERS}
            counters.update(
                {k: v for k, v in self._counters.items() if k not in counters}
            )
            return {
                **counters,
                "unique_sessions_today": len(self._sessions_today),
                "uptime_s": int(
                    (datetime.now(UTC) - self._started_at).total_seconds()
                ),
            }

    def reset(self) -> None:
        with self._lock:
            self._counters.clear()
            self._sessions_today.clear()


metrics = Metrics()
