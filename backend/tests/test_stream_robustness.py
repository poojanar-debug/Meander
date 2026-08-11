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
    # **Added.** This test passed against a loop that cancelled the generator on
    # every keepalive: the comment frame it asserts was emitted, and the event
    # behind it was destroyed. Asserting the silence is broken says nothing
    # about whether the answer survived it, which is the only reason to break it.
    assert [json.loads(f[6:]) for f in frames if f.startswith("data: ")] == [
        {"type": "progress", "pct": 5, "text": "x", "segments_scored": 0}
    ]


@pytest.mark.asyncio
async def test_a_keepalive_does_not_cancel_the_work_it_is_protecting(
    tmp_cache_db, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The keepalive used to kill the request it exists to keep alive.

    `asyncio.wait_for` cancels what it waits on when the timeout fires, and what
    it waited on was the generator producing the answer. The generator took the
    CancelledError at its current await, the next pull raised
    StopAsyncIteration, and `_stream` read that as a clean end: the client got
    the events before the slow stage, no `done`, no error, and nothing cached.

    Three events with a slow middle stage, so more than one keepalive elapses
    inside a single pull.
    """
    monkeypatch.setattr(main_mod, "KEEPALIVE_S", 0.05)

    async def slow_middle(req, deadline_s=None):
        yield {"type": "progress", "pct": 5, "text": "a", "segments_scored": 0}
        await asyncio.sleep(0.3)
        yield {"type": "progress", "pct": 60, "text": "b", "segments_scored": 0}
        yield {"type": "done", "payload": {"routes": []}}

    monkeypatch.setattr(main_mod, "route_events_with_deadline", slow_middle)

    req = RouteRequest(origin=Point(lat=51.5, lon=-0.16), minutes=30)
    frames = [f async for f in main_mod._stream(req, "k")]

    events = [json.loads(f[6:]) for f in frames if f.startswith("data: ")]
    assert [e["type"] for e in events] == ["progress", "progress", "done"]
    # And the silence was still covered while that middle stage ran.
    assert sum(1 for f in frames if f.startswith(": ")) >= 2


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


# ---------------------------------------------------------------------------
# the JSON transport must fail in the same shape as SSE
# ---------------------------------------------------------------------------
#
# One endpoint, two transports. A client that asks for JSON and a client that
# asks for a stream are asking the same question, and they were getting
# different answers about what went wrong.


def test_a_deadline_with_nothing_ready_says_timeout_not_upstream(
    api_client, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The JSON loop looked only for "done" and dropped the error event.

    So a request that ran out of time fell through to the generic 502 — "No
    route could be produced for that request", kind "upstream" — while SSE, for
    the identical request, said kind "timeout" and explained that it had run out
    of time. The first is a claim about the router; the second is what happened.
    """

    async def only_timeout(req, deadline_s=None):
        yield {"type": "error", "kind": "timeout", "message": "That request ran out of time."}

    monkeypatch.setattr(main_mod, "route_events_with_deadline", only_timeout)

    response = api_client.post("/api/routes", json=BODY)

    assert response.status_code == 504
    assert response.json()["error"]["kind"] == "timeout"
    assert "ran out of time" in response.json()["error"]["message"]


def test_the_two_transports_agree_on_the_kind(
    api_client, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The same request, asked both ways, must not describe the failure
    differently."""

    async def only_timeout(req, deadline_s=None):
        yield {"type": "error", "kind": "timeout", "message": "That request ran out of time."}

    monkeypatch.setattr(main_mod, "route_events_with_deadline", only_timeout)

    as_json = api_client.post("/api/routes", json=BODY).json()["error"]
    as_sse = _events(api_client.post("/api/routes", json=BODY, headers=SSE))[-1]

    assert as_json["kind"] == as_sse["kind"]
    assert as_json["message"] == as_sse["message"]


def test_an_unanticipated_exception_still_gets_the_error_envelope(
    api_client, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Anything that is not a RoutingError escaped post_routes entirely, and
    Starlette rendered it as `text/plain` 500 "Internal Server Error" — not the
    envelope this endpoint's error handling exists to guarantee, and not what
    frontend/src/api/client.js parses. The client fell back to "The server
    returned 500", which is what it says when it could not read the body at all.
    """

    async def boom(req, deadline_s=None):
        raise ValueError("nobody anticipated this")
        yield  # pragma: no cover — makes this an async generator

    monkeypatch.setattr(main_mod, "route_events_with_deadline", boom)

    # `raise_server_exceptions=False`, because the shared api_client fixture
    # re-raises instead of letting the app answer — which is TestClient's
    # default and useful everywhere else, but here it would test Starlette's
    # debugging behaviour rather than what a real client receives.
    from fastapi.testclient import TestClient

    with TestClient(main_mod.app, raise_server_exceptions=False) as client:
        response = client.post("/api/routes", json=BODY)

    assert response.status_code == 500
    assert response.headers["content-type"].startswith("application/json")
    assert response.json()["error"]["kind"] == "internal"
    # And it does not leak the internal detail to the caller.
    assert "nobody anticipated" not in response.json()["error"]["message"]


@pytest.mark.asyncio
async def test_a_json_request_in_flight_is_drained_at_shutdown(
    tmp_cache_db, monkeypatch: pytest.MonkeyPatch
) -> None:
    """`_open_streams` is what the drain loop in lifespan waits on, and the JSON
    path never incremented it — so a JSON request in flight at SIGTERM was
    invisible and the process exited from under it. It is a stream too; the
    client just sees one body at the end of it."""
    from fastapi.testclient import TestClient

    seen: list[int] = []

    async def slow(req, deadline_s=None):
        seen.append(main_mod._open_streams)
        yield {"type": "done", "payload": {"routes": [], "cache": {}}}

    monkeypatch.setattr(main_mod, "route_events_with_deadline", slow)

    with TestClient(main_mod.app) as client:
        client.post("/api/routes", json=BODY)

    assert seen and seen[0] >= 1, "the JSON path was not counted as an open stream"
    assert main_mod._open_streams == 0, "and it must be given back"
