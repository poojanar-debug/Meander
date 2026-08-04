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

    def snapshot(self) -> dict[str, Any]:
        with self._lock:
            self._roll_day_locked()
            return {
                "route_requests_total": self._counters["route_requests_total"],
                "routes_blocked_total": self._counters["routes_blocked_total"],
                "cache_hits_total": self._counters["cache_hits_total"],
                "cache_misses_total": self._counters["cache_misses_total"],
                "segments_scored_total": self._counters["segments_scored_total"],
                "rate_limited_total": self._counters["rate_limited_total"],
                "upstream_failures_total": self._counters["upstream_failures_total"],
                "narration_failures_total": self._counters["narration_failures_total"],
                "enrichment_failures_total": self._counters["enrichment_failures_total"],
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
