"""Liveness and readiness, kept apart on purpose.

``/healthz``  liveness. No disk, no upstream, no dependencies. This is what the
              load balancer polls, and it must answer while the instance is
              degraded — a readiness failure should take an instance out of
              rotation, not have it killed and restarted into the same failure.

``/readyz``   readiness. 503 when this instance genuinely cannot serve: the
              cache is unreadable, a required key is missing, or the routing
              server is unreachable.

``/api/health`` stays the rich human diagnostic and is not a probe.

The routing probe is **cached**. A load balancer polls readiness every few
seconds, and an unauthenticated request to the router on every one of those is
load the router did not need — worse against the hosted API, where it would be
metered.
"""

from __future__ import annotations

import time
from dataclasses import dataclass
from urllib.parse import urlsplit

import httpx

from . import config
from .config import HTTP_CONNECT_TIMEOUT_S, graphhopper_is_self_hosted
from .logging_setup import get_logger

log = get_logger(__name__)

# Long enough that a 1 s liveness poll does not become a 1 s upstream poll,
# short enough that a router coming back is noticed quickly.
PROBE_TTL_S = 8.0
PROBE_TIMEOUT_S = min(5.0, HTTP_CONNECT_TIMEOUT_S)


@dataclass
class _Probe:
    ok: bool
    detail: str
    checked_at: float


_last: _Probe | None = None


def routing_probe_url() -> str:
    """GraphHopper's own health endpoint, derived from the routing URL.

    Read through the module rather than a `from` import so it resolves at call
    time — the same stale-binding trap that made the self-hosted flag untestable.
    """
    split = urlsplit(config.GRAPHHOPPER_URL)
    return f"{split.scheme}://{split.netloc}/health"


def reset_probe_cache() -> None:
    """Test hook."""
    global _last
    _last = None


async def check_routing(now: float | None = None) -> tuple[bool, str]:
    """Is the routing server reachable? Cached for PROBE_TTL_S.

    Only a self-hosted server is probed. The hosted API has no free liveness
    endpoint — every call is metered — so probing it on a readiness schedule
    would spend the quota this service exists to protect. Reported as
    "not probed" rather than as healthy, so the distinction survives.
    """
    global _last
    now = time.monotonic() if now is None else now

    if not graphhopper_is_self_hosted():
        return True, "hosted_api_not_probed"

    if _last is not None and (now - _last.checked_at) < PROBE_TTL_S:
        return _last.ok, _last.detail

    # A dedicated short-lived client rather than the shared one: a readiness
    # probe must not queue behind in-flight routing requests on a shared
    # connection pool, which is exactly when readiness matters most.
    ok, detail = False, "unreachable"
    try:
        async with httpx.AsyncClient(timeout=PROBE_TIMEOUT_S) as client:
            response = await client.get(routing_probe_url())
        ok = response.status_code < 400
        detail = "ok" if ok else f"http_{response.status_code}"
    except httpx.HTTPError as exc:
        detail = type(exc).__name__

    if not ok:
        log.warning("routing_probe_failed", extra={"detail": detail})

    _last = _Probe(ok=ok, detail=detail, checked_at=now)
    return ok, detail
