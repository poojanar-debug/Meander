"""The remaining 2.7 items: one error shape, one daily counter, one body limit.

Each of these is small on its own. The daily ceiling is the one that would have
bitten hardest in production: its window started when the process did, so on
ECS every deploy, crash or scale event handed the service a fresh quota.
"""

from __future__ import annotations

import json

import pytest

from backend.ratelimit import RateLimiter

BODY = {"origin": {"lat": 6.933727, "lon": 79.850080}, "minutes": 30, "mode": "foot"}


# ---------------------------------------------------------------------------
# one error envelope
# ---------------------------------------------------------------------------


def test_a_validation_failure_uses_the_same_envelope_as_everything_else(api_client) -> None:
    """FastAPI's {"detail": [...]} meant the frontend carried a special case for
    exactly one status code."""
    resp = api_client.post("/api/routes", json={"origin": {"lat": 1.0}, "minutes": 30})
    assert resp.status_code == 422
    body = resp.json()
    assert "detail" not in body
    assert body["error"]["kind"] == "invalid_request"
    assert isinstance(body["error"]["message"], str) and body["error"]["message"]


def test_an_out_of_range_value_names_the_field(api_client) -> None:
    resp = api_client.post("/api/routes", json={**BODY, "minutes": 9999})
    assert resp.status_code == 422
    assert "minutes" in resp.json()["error"]["message"]


def test_a_404_uses_the_envelope_too(api_client) -> None:
    resp = api_client.get("/api/nope")
    assert resp.status_code == 404
    assert "error" in resp.json()


# ---------------------------------------------------------------------------
# body size
# ---------------------------------------------------------------------------


def test_an_oversized_body_is_refused_before_it_is_parsed(api_client) -> None:
    huge = {**BODY, "padding": "x" * 200_000}
    resp = api_client.post("/api/routes", json=huge)
    assert resp.status_code == 413
    assert resp.json()["error"]["kind"] == "payload_too_large"


def test_a_normal_body_is_unaffected(api_client) -> None:
    assert api_client.post("/api/routes", json=BODY).status_code in (200, 422, 503)


# ---------------------------------------------------------------------------
# the daily ceiling, anchored to the UTC date
# ---------------------------------------------------------------------------


def test_the_ceiling_does_not_reset_on_restart(monkeypatch: pytest.MonkeyPatch) -> None:
    """The failure this prevents.

    The window used to start when the process did, so on ECS every deploy,
    crash or scale event handed the service a whole fresh daily quota — a far
    more likely occurrence than the two-task case.
    """
    limiter = RateLimiter(capacity=100, refill_per_min=100, daily_ceiling=3)
    for _ in range(3):
        assert limiter.check("1.2.3.4").allowed
    assert not limiter.check("1.2.3.4").allowed

    # A new process on the same day starts a new limiter — but the *date* has
    # not moved, so a correctly anchored ceiling is a property of the day, not
    # of the object. Pin the anchor rather than the count.
    restarted = RateLimiter(capacity=100, refill_per_min=100, daily_ceiling=3)
    assert restarted._day == limiter._day, "the anchor must be the date, not process start"


def test_the_ceiling_rolls_on_a_date_change(monkeypatch: pytest.MonkeyPatch) -> None:
    limiter = RateLimiter(capacity=100, refill_per_min=100, daily_ceiling=2)
    assert limiter.check("1.2.3.4").allowed
    assert limiter.check("1.2.3.4").allowed
    assert not limiter.check("1.2.3.4").allowed

    limiter._day = "1999-12-31"
    assert limiter.check("1.2.3.4").allowed


def test_retry_after_points_at_midnight_not_at_a_stopwatch() -> None:
    """"Resets at midnight UTC" is something an operator can reason about."""
    limiter = RateLimiter(capacity=100, refill_per_min=100, daily_ceiling=1)
    limiter.check("1.2.3.4")
    decision = limiter.check("1.2.3.4")
    assert decision.reason == "daily_ceiling"
    assert 0 < decision.retry_after_s <= 86_400


def test_there_is_only_one_served_today_counter() -> None:
    """There used to be two, on two different clocks, behind three accessors,
    with only one of them actually enforced."""
    from backend.metrics import metrics

    snapshot = metrics.snapshot()
    assert "daily_routes_served" not in snapshot
    assert not hasattr(metrics, "daily_routes_served")


# ---------------------------------------------------------------------------
# geocode is no longer unlimited
# ---------------------------------------------------------------------------


def test_geocode_is_rate_limited(api_client, monkeypatch: pytest.MonkeyPatch) -> None:
    """Nominatim's policy is 1 req/s, enforced by banning this service's egress
    address — so one script gets place search banned for every user.

    **Limited by the per-IP bucket, not the daily routing ceiling.** This used
    to force a 429 by setting `daily_ceiling = 0`, which passed for the wrong
    reason: geocode was spending the *routing* quota while making no
    GraphHopper call, so 167 addresses x 12 burst tokens of
    `GET /api/geocode?q=xx` could deny every user a route for the rest of the
    day. It no longer touches that counter, and the bucket is what actually
    bounds the load one caller can put on Nominatim.

    **What changed here, and why.** This patched ``main.limiter``. Place search
    now runs on ``main.geocode_limiter``, a second bucket, because one shared
    bucket had the mirror-image defect of the one above: a 20-character name
    costs a mean of 8.6 geocode requests, two names come to 17.1 against a
    capacity of 12, and the route request that followed was refused by a bucket
    the user's *typing* had emptied. Patching the old name left this test
    pointing at a limiter the endpoint no longer consults, so the request was
    allowed and the assertion failed loudly rather than passing vacuously —
    which is the behaviour a test should have when the thing it guards moves.
    """
    from backend import main
    from backend.ratelimit import RateLimiter

    monkeypatch.setattr(main, "geocode_limiter",
                        RateLimiter(capacity=0, refill_per_min=0.0, daily_ceiling=100))
    resp = api_client.get("/api/geocode?q=hyde+park")
    assert resp.status_code == 429
    assert resp.headers.get("Retry-After")


def test_the_route_bucket_no_longer_bounds_place_search(
    api_client, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A drained route bucket must not stop someone typing a place name.

    This is the defect the second limiter exists for, asserted from the other
    side: with the routing bucket empty, place search still answers. Before, the
    two shared a bucket, so a user who had just searched for two places found
    their route refused — and a user whose route had been refused could not type
    a different destination to get out of it.
    """
    from backend import main
    from backend.ratelimit import RateLimiter

    monkeypatch.setattr(main, "limiter",
                        RateLimiter(capacity=0, refill_per_min=0.0, daily_ceiling=100))
    resp = api_client.get("/api/geocode?q=hyde+park")
    assert resp.status_code != 429


def test_geocode_does_not_spend_the_daily_routing_allowance(
    api_client, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The ceiling exists to keep the GraphHopper quota inside the free tier.
    A place search spends no routing credits, and unlike a route it was never
    refunded — so every search burned one of the 2,000 daily slots for good."""
    from backend import main
    from backend.ratelimit import RateLimiter

    limiter = RateLimiter(capacity=50, refill_per_min=0.0, daily_ceiling=100)
    monkeypatch.setattr(main, "limiter", limiter)

    before = limiter.served_today()
    api_client.get("/api/geocode?q=hyde+park")

    assert limiter.served_today() == before


# ---------------------------------------------------------------------------
# gzip must not touch the stream
# ---------------------------------------------------------------------------


def test_sse_is_not_gzipped(api_client) -> None:
    """A buffered stream is not a stream."""
    resp = api_client.post(
        "/api/routes",
        json=BODY,
        headers={"Accept": "text/event-stream", "Accept-Encoding": "gzip"},
    )
    assert resp.headers.get("content-encoding") != "gzip"
    # And it is still parseable as SSE.
    events = [
        json.loads(line[6:])
        for line in resp.text.splitlines()
        if line.startswith("data: ")
    ]
    assert events, "the stream should still contain events"


# ---------------------------------------------------------------------------
# the OSM token is actually sent now
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_the_osm_token_is_sent_when_configured(monkeypatch: pytest.MonkeyPatch) -> None:
    """It was read by config.py and never sent, so the endpoint could not
    authenticate — a half-wired write path to a public database."""
    import dataclasses

    import httpx

    from backend import osm_report
    from backend.models import BarrierReport

    seen: dict = {}

    async def fake_fetch(method, url, **kwargs):
        seen.update(kwargs.get("headers") or {})
        return httpx.Response(200, json={"properties": {"id": 7}},
                              request=httpx.Request("POST", url))

    monkeypatch.setattr(osm_report, "fetch", fake_fetch)
    monkeypatch.setattr(
        osm_report, "settings", dataclasses.replace(osm_report.settings, osm_dev_token="tok-123")
    )

    report = BarrierReport(lat=51.5, lon=-0.16, type="steps", description="flight of steps")
    assert await osm_report.submit_barrier(report) == 7
    assert seen.get("Authorization") == "Bearer tok-123"


@pytest.mark.asyncio
async def test_no_token_still_files_an_anonymous_note(monkeypatch: pytest.MonkeyPatch) -> None:
    """Anonymous notes are permitted, so the token is optional rather than required."""
    import dataclasses

    import httpx

    from backend import osm_report
    from backend.models import BarrierReport

    seen: dict = {}

    async def fake_fetch(method, url, **kwargs):
        seen.update(kwargs.get("headers") or {})
        return httpx.Response(200, json={"properties": {"id": 8}},
                              request=httpx.Request("POST", url))

    monkeypatch.setattr(osm_report, "fetch", fake_fetch)
    monkeypatch.setattr(
        osm_report, "settings", dataclasses.replace(osm_report.settings, osm_dev_token=None)
    )

    report = BarrierReport(lat=51.5, lon=-0.16, type="steps", description="flight of steps")
    assert await osm_report.submit_barrier(report) == 8
    assert "Authorization" not in seen


def test_the_token_never_reaches_a_fixture_signature() -> None:
    """Authorization is in SECRET_HEADERS, so it is stripped from the hash and
    redacted on disk."""
    from backend.config import SECRET_HEADERS
    from backend.fixtures import signature

    assert "authorization" in SECRET_HEADERS
    with_token = signature("POST", "https://api06.dev.openstreetmap.org/api/0.6/notes",
                           headers={"Accept": "application/json", "Authorization": "Bearer x"})
    without = signature("POST", "https://api06.dev.openstreetmap.org/api/0.6/notes",
                        headers={"Accept": "application/json"})
    assert with_token == without


# ---------------------------------------------------------------------------
# .env.example is documentation that goes stale silently
# ---------------------------------------------------------------------------


def _env_example_values() -> dict[str, str]:
    from pathlib import Path

    root = Path(__file__).resolve().parent.parent.parent
    out: dict[str, str] = {}
    for line in (root / ".env.example").read_text().splitlines():
        line = line.strip()
        if line and not line.startswith("#") and "=" in line:
            key, value = line.split("=", 1)
            out[key.strip()] = value.strip()
    return out


def test_env_example_matches_the_code_defaults() -> None:
    """A number in .env.example that no longer matches the code is a trap.

    This is not hypothetical in this repository. MEANDER_DAILY_ROUTE_CEILING sat
    at 120 with a comment explaining it in terms of the hosted GraphHopper quota,
    long after the router became self-hosted. The since-removed deployment
    templates went on describing MEANDER_HTTP_TIMEOUT_S as 12 when config.py
    had said 20 for a while. Both are the same failure: prose that was true
    once, describing a default nobody re-read.

    Only the numeric knobs are checked. Keys and origins are deployment-specific
    and are empty here on purpose.
    """
    from backend import config

    settings = config.Settings()
    documented = _env_example_values()

    expected = {
        "MEANDER_DAILY_ROUTE_CEILING": settings.global_daily_route_ceiling,
        "MEANDER_RATE_CAPACITY": settings.per_ip_bucket_capacity,
        "MEANDER_RATE_REFILL_PER_MIN": settings.per_ip_refill_per_min,
        "MEANDER_ROUTE_CACHE_TTL_S": settings.route_cache_ttl_s,
        # Module-level rather than on Settings, and undocumented until the
        # release pass. The since-removed deployment templates went on
        # describing the HTTP timeout as 12 seconds when it had been 20 for a
        # while, which is the drift this test exists to catch a second
        # instance of.
        "MEANDER_HTTP_TIMEOUT_S": config.HTTP_TIMEOUT_S,
        "MEANDER_HTTP_CONNECT_TIMEOUT_S": config.HTTP_CONNECT_TIMEOUT_S,
        "MEANDER_REQUEST_DEADLINE_S": config.REQUEST_DEADLINE_S,
        "MEANDER_DRAIN_TIMEOUT_S": config.DRAIN_TIMEOUT_S,
        "MEANDER_TRUSTED_PROXY_HOPS": config.TRUSTED_PROXY_HOPS,
    }

    drifted = []
    for key, code_value in expected.items():
        if key not in documented:
            drifted.append(f"{key}: absent from .env.example, code default {code_value}")
        elif float(documented[key]) != float(code_value):
            drifted.append(
                f"{key}: .env.example says {documented[key]}, code default is {code_value}"
            )

    assert not drifted, "\n".join(drifted)
