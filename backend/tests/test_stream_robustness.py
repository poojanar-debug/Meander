"""What the SSE transport does when things go wrong.

_stream() caught only RoutingError. Anything else — a sqlite3.OperationalError
from put_route, a pydantic error in model_dump — escaped mid-stream, the client
got a truncated response with **no error event at all**, and the frontend
resolved to null: an empty screen with no explanation.
"""

from __future__ import annotations

import asyncio
import json
import sqlite3

import pytest

from backend import main as main_mod
from backend import routing
from backend.enrich import EnrichContext
from backend.geometry import LatLon
from backend.models import Point, RouteRequest

SSE = {"Accept": "text/event-stream"}
BODY = {"origin": {"lat": 6.933727, "lon": 79.850080}, "minutes": 30, "mode": "foot"}


def _events(response) -> list[dict]:
    return [
        json.loads(line[6:])
        for line in response.text.splitlines()
        if line.startswith("data: ")
    ]


def _stub(preset: str) -> routing.RawRoute:
    return routing.RawRoute(
        points=[LatLon(51.5 + i * 0.001, -0.16 + i * 0.001) for i in range(6)],
        distance_m=2000.0,
        duration_min=25.0,
        mode="foot",
        preset=preset,
    )


@pytest.fixture
def working_routes(monkeypatch: pytest.MonkeyPatch):
    async def fake_post(body, mode, preset):
        return _stub(preset)

    async def no_enrich(geometries, depart_at=None):
        return EnrichContext()

    monkeypatch.setattr(routing, "_post_route", fake_post)
    monkeypatch.setattr(main_mod, "enrich_context", no_enrich)


# ---------------------------------------------------------------------------
# non-RoutingError failures
# ---------------------------------------------------------------------------


def test_a_database_error_mid_stream_becomes_an_error_event(
    api_client, working_routes, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The exact failure that used to truncate the stream silently."""

    class Exploding:
        def get_route(self, key):
            return None

        def put_route(self, *a, **k):
            raise sqlite3.OperationalError("database is locked")

        def segment_count(self):
            return 0

    monkeypatch.setattr(main_mod, "get_cache", lambda: Exploding())

    events = _events(api_client.post("/api/routes", json=BODY, headers=SSE))
    assert events[-1]["type"] == "error"
    assert events[-1]["kind"] == "internal"
    # And it does not leak the internal detail to the caller.
    assert "sqlite" not in events[-1]["message"].lower()


def test_an_unexpected_error_still_ends_the_stream_properly(
    api_client, working_routes, monkeypatch: pytest.MonkeyPatch
) -> None:
    async def boom(req, deadline_s=None):
        yield {"type": "progress", "pct": 5, "text": "starting", "segments_scored": 0}
        raise ValueError("something nobody anticipated")

    monkeypatch.setattr(main_mod, "route_events_with_deadline", boom)

    events = _events(api_client.post("/api/routes", json=BODY, headers=SSE))
    assert events[0]["type"] == "progress"
    assert events[-1]["type"] == "error"


def test_a_routing_error_still_gets_its_own_kind(
    api_client, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The specific message must not be flattened into the generic one."""

    async def fake_post(body, mode, preset):
        raise routing.RoutingError("upstream_rate_limit", "over quota for today", 503)

    monkeypatch.setattr(routing, "_post_route", fake_post)

    events = _events(api_client.post("/api/routes", json=BODY, headers=SSE))
    assert events[-1]["type"] == "error"
    assert events[-1]["kind"] == "upstream_rate_limit"
    assert events[-1]["message"] == "over quota for today"


# ---------------------------------------------------------------------------
# keepalive
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_a_long_silence_produces_a_comment_frame(
    tmp_cache_db, monkeypatch: pytest.MonkeyPatch
) -> None:
    """There is otherwise a silent gap between 60% and the enriched routes that
    can outlast a proxy's idle timeout."""
    monkeypatch.setattr(main_mod, "KEEPALIVE_S", 0.05)

    async def slow(req, deadline_s=None):
        await asyncio.sleep(0.2)
        yield {"type": "progress", "pct": 5, "text": "x", "segments_scored": 0}

    monkeypatch.setattr(main_mod, "route_events_with_deadline", slow)

    req = RouteRequest(origin=Point(lat=51.5, lon=-0.16), minutes=30)
    frames = [f async for f in main_mod._stream(req, "k")]

    assert any(f.startswith(": ") for f in frames), "expected a keepalive comment"
    # A comment frame must not look like an event to the client.
    assert not any(f.startswith(": ") and "data:" in f for f in frames)


# ---------------------------------------------------------------------------
# shutdown
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_a_shutting_down_server_says_so(
    tmp_cache_db, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Better than having the connection cut from under the client."""

    async def slow(req, deadline_s=None):
        await asyncio.sleep(10)
        yield {"type": "done", "payload": {}}

    monkeypatch.setattr(main_mod, "route_events_with_deadline", slow)
    main_mod._shutting_down.set()
    try:
        req = RouteRequest(origin=Point(lat=51.5, lon=-0.16), minutes=30)
        frames = [f async for f in main_mod._stream(req, "k")]
    finally:
        main_mod._shutting_down.clear()

    payload = json.loads(frames[-1][6:])
    assert payload["kind"] == "shutting_down"


@pytest.mark.asyncio
async def test_shutdown_state_does_not_survive_a_restart(tmp_cache_db) -> None:
    """Module state outlives the app object; left set, every later stream would
    immediately answer "this server is restarting"."""
    from fastapi.testclient import TestClient

    main_mod._shutting_down.set()
    with TestClient(main_mod.app):
        assert not main_mod._shutting_down.is_set()


# ---------------------------------------------------------------------------
# client disconnect
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_a_disconnect_keeps_a_result_that_was_already_computed(
    tmp_cache_db, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A disconnect at 90% used to throw away every GraphHopper call behind it."""
    stored: dict = {}

    class Recording:
        def put_route(self, key, payload, ttl):
            stored[key] = payload

        def get_route(self, key):
            return None

        def segment_count(self):
            return 0

    monkeypatch.setattr(main_mod, "get_cache", lambda: Recording())

    async def finishes_then_hangs(req, deadline_s=None):
        yield {"type": "done", "payload": {"routes": [], "cache": {}}}
        await asyncio.sleep(30)

    monkeypatch.setattr(main_mod, "route_events_with_deadline", finishes_then_hangs)

    req = RouteRequest(origin=Point(lat=51.5, lon=-0.16), minutes=30)

    async def consume():
        async for _ in main_mod._stream(req, "cachekey"):
            pass

    task = asyncio.ensure_future(consume())
    await asyncio.sleep(0.05)
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task

    assert "cachekey" in stored, "a computed answer should survive the client leaving"


@pytest.mark.asyncio
async def test_the_stream_counter_returns_to_zero(
    tmp_cache_db, working_routes, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Otherwise shutdown waits the full drain timeout, every time."""

    async def quick(req, deadline_s=None):
        yield {"type": "done", "payload": {"routes": [], "cache": {}}}

    monkeypatch.setattr(main_mod, "route_events_with_deadline", quick)

    before = main_mod._open_streams
    req = RouteRequest(origin=Point(lat=51.5, lon=-0.16), minutes=30)
    async for _ in main_mod._stream(req, "k"):
        pass
    assert main_mod._open_streams == before
