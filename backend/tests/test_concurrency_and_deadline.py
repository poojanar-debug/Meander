"""Concurrency, streaming order, and the whole-request deadline.

The measured shape of a request against a self-hosted router, from PROGRESS.md:
GraphHopper answers a whole foot route in 0.024 s, and Overpass took 13.553 s
for a trivial bench query. So routing is not the cost — the shared enrichment
pass is, and it used to sit between routing and the first route event, meaning
nothing at all reached the browser for up to fourteen seconds.
"""

from __future__ import annotations

import asyncio

import pytest

from backend import main as main_mod
from backend import routing
from backend.enrich import EnrichContext
from backend.geometry import LatLon
from backend.models import Point, RouteRequest


def _stub(preset: str, minutes: float = 30.0, points: int = 10) -> routing.RawRoute:
    return routing.RawRoute(
        points=[LatLon(51.5 + i * 0.001, -0.16 + i * 0.001) for i in range(points)],
        distance_m=minutes * 75.0,
        duration_min=minutes,
        mode="foot",
        preset=preset,
    )


@pytest.fixture
def no_enrichment(monkeypatch: pytest.MonkeyPatch):
    async def _none(geometries, depart_at=None):
        return EnrichContext()

    monkeypatch.setattr(main_mod, "enrich_context", _none)


async def _collect(req: RouteRequest) -> list[dict]:
    return [e async for e in main_mod.route_events(req)]


def _req(**kw) -> RouteRequest:
    return RouteRequest(origin=Point(lat=51.5074, lon=-0.1622), minutes=30, **kw)


# ---------------------------------------------------------------------------
# ordering: fastest alone and first, the rest together
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_fastest_completes_before_scenic_starts(
    tmp_cache_db, no_enrichment, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Load-bearing, not stylistic: route_scenic derives its cap and floor from it.

    A flat gather over all three objectives would pass fastest=None and
    silently disable both bars.
    """
    order: list[str] = []

    async def fake_post(body, mode, preset):
        order.append(f"start:{preset}")
        await asyncio.sleep(0)
        order.append(f"end:{preset}")
        return _stub(preset)

    monkeypatch.setattr(routing, "_post_route", fake_post)
    await _collect(_req(objectives=["fastest", "scenic", "accessible"]))

    assert order.index("end:fastest") < order.index("start:scenic")


@pytest.mark.asyncio
async def test_scenic_and_accessible_overlap(
    tmp_cache_db, no_enrichment, monkeypatch: pytest.MonkeyPatch
) -> None:
    """They are independent of each other, so they must not be serialised."""
    inflight = 0
    peak = 0

    async def fake_post(body, mode, preset):
        nonlocal inflight, peak
        if preset != "fastest":
            inflight += 1
            peak = max(peak, inflight)
            await asyncio.sleep(0.01)
            inflight -= 1
        return _stub(preset)

    monkeypatch.setattr(routing, "_post_route", fake_post)
    monkeypatch.setenv("MEANDER_GRAPHHOPPER_SELF_HOSTED", "0")  # one scenic candidate
    await _collect(_req(objectives=["fastest", "scenic", "accessible"]))

    assert peak >= 2, "scenic and accessible should be in flight together"


@pytest.mark.asyncio
async def test_scenic_candidates_run_together_when_unmetered(
    monkeypatch: pytest.MonkeyPatch
) -> None:
    inflight = 0
    peak = 0

    async def fake_post(body, mode, preset):
        nonlocal inflight, peak
        inflight += 1
        peak = max(peak, inflight)
        await asyncio.sleep(0.01)
        inflight -= 1
        return _stub(preset, 20.0)

    monkeypatch.setattr(routing, "_post_route", fake_post)
    monkeypatch.setenv("MEANDER_GRAPHHOPPER_SELF_HOSTED", "1")

    await routing.route_scenic(LatLon(51.5, -0.16), None, 30, "foot", _stub("fastest", 40.0))
    assert peak == len(routing.SCENIC_LOOP_CANDIDATES)


@pytest.mark.asyncio
async def test_metered_candidates_stay_sequential(monkeypatch: pytest.MonkeyPatch) -> None:
    """The metered path exists to stop at the first acceptable candidate."""
    inflight = 0
    peak = 0

    async def fake_post(body, mode, preset):
        nonlocal inflight, peak
        inflight += 1
        peak = max(peak, inflight)
        await asyncio.sleep(0.01)
        inflight -= 1
        return _stub(preset, 20.0)

    monkeypatch.setattr(routing, "_post_route", fake_post)
    monkeypatch.setenv("MEANDER_GRAPHHOPPER_SELF_HOSTED", "0")

    await routing.route_scenic(LatLon(51.5, -0.16), None, 30, "foot", _stub("fastest", 40.0))
    assert peak == 1


@pytest.mark.asyncio
async def test_one_failed_scenic_candidate_does_not_lose_the_others(
    monkeypatch: pytest.MonkeyPatch
) -> None:
    calls = {"n": 0}

    async def fake_post(body, mode, preset):
        calls["n"] += 1
        if calls["n"] == 1:
            raise routing.NoRouteFound("that variant is unroutable")
        return _stub(preset, 20.0)

    monkeypatch.setattr(routing, "_post_route", fake_post)
    monkeypatch.setenv("MEANDER_GRAPHHOPPER_SELF_HOSTED", "1")

    result = await routing.route_scenic(
        LatLon(51.5, -0.16), None, 30, "foot", _stub("fastest", 40.0)
    )
    assert result.duration_min == 20.0


@pytest.mark.asyncio
async def test_every_scenic_candidate_failing_still_raises(
    monkeypatch: pytest.MonkeyPatch
) -> None:
    """Total failure must not be laundered into a route."""

    async def fake_post(body, mode, preset):
        raise routing.NoRouteFound("nothing routable")

    monkeypatch.setattr(routing, "_post_route", fake_post)
    monkeypatch.setenv("MEANDER_GRAPHHOPPER_SELF_HOSTED", "1")

    with pytest.raises(routing.NoRouteFound):
        await routing.route_scenic(LatLon(51.5, -0.16), None, 30, "foot", _stub("fastest", 40.0))


# ---------------------------------------------------------------------------
# two-pass streaming
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_routes_are_emitted_before_enrichment(
    tmp_cache_db, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The whole point of the SSE transport."""
    marks: list[str] = []

    async def slow_enrich(geometries, depart_at=None):
        marks.append("enrichment")
        return EnrichContext()

    async def fake_post(body, mode, preset):
        return _stub(preset)

    monkeypatch.setattr(routing, "_post_route", fake_post)
    monkeypatch.setattr(main_mod, "enrich_context", slow_enrich)

    events = []
    async for event in main_mod.route_events(_req(objectives=["fastest", "scenic"])):
        if event["type"] == "route":
            marks.append(f"route:{event['route']['id']}:"
                         f"{'pending' if event['route']['enrichment_pending'] else 'final'}")
        events.append(event)

    assert marks.index("route:fastest:pending") < marks.index("enrichment")
    assert marks.index("enrichment") < marks.index("route:fastest:final")


@pytest.mark.asyncio
async def test_a_pending_route_never_claims_it_found_no_rest_stops(
    tmp_cache_db, no_enrichment, monkeypatch: pytest.MonkeyPatch
) -> None:
    """An empty rest_stops list means "we looked and found none".

    On the first pass we have not looked, and the whole project turns on
    absence of data never being reported as a finding.

    **The field is now null there**, rather than `[]` guarded by a flag. It used
    to be typed `list[RestStop]` with a default of `[]`, which made "we could
    not look" unrepresentable — so `enrichment_pending` existed partly to say in
    a second field what the first one was unable to say. It can say it itself
    now. The flag is still asserted below, because air and shade are scalars and
    null alone does not tell the UI that a second event is coming.
    """

    async def fake_post(body, mode, preset):
        return _stub(preset)

    monkeypatch.setattr(routing, "_post_route", fake_post)

    async for event in main_mod.route_events(_req(objectives=["fastest"])):
        if event["type"] == "route" and event["route"]["enrichment_pending"]:
            route = event["route"]
            assert route["rest_stops"] is None
            assert route["enrichment_pending"] is True, (
                "the flag is what tells the UI a second event is still coming"
            )
            # The parts that ARE final on the first pass.
            assert route["geometry"]
            assert route["confidence_note"]


@pytest.mark.asyncio
async def test_the_final_pass_is_not_marked_pending(
    tmp_cache_db, no_enrichment, monkeypatch: pytest.MonkeyPatch
) -> None:
    async def fake_post(body, mode, preset):
        return _stub(preset)

    monkeypatch.setattr(routing, "_post_route", fake_post)

    events = await _collect(_req(objectives=["fastest"]))
    done = next(e for e in events if e["type"] == "done")
    assert all(not r["enrichment_pending"] for r in done["payload"]["routes"])


@pytest.mark.asyncio
async def test_the_expensive_assessment_runs_once_per_route(
    tmp_cache_db, no_enrichment, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Two passes must not mean two accessibility assessments."""
    calls = {"n": 0}
    real = main_mod._assess

    def counting(raw):
        calls["n"] += 1
        return real(raw)

    monkeypatch.setattr(main_mod, "_assess", counting)

    async def fake_post(body, mode, preset):
        return _stub(preset)

    monkeypatch.setattr(routing, "_post_route", fake_post)

    await _collect(_req(objectives=["fastest", "scenic"]))
    assert calls["n"] == 2


# ---------------------------------------------------------------------------
# the deadline
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_deadline_returns_what_it_has(
    tmp_cache_db, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A partial answer is a real answer; a dead connection is not."""

    async def fake_post(body, mode, preset):
        return _stub(preset)

    async def never(geometries, depart_at=None):
        await asyncio.sleep(30)
        return EnrichContext()

    monkeypatch.setattr(routing, "_post_route", fake_post)
    monkeypatch.setattr(main_mod, "enrich_context", never)

    events = [
        e
        async for e in main_mod.route_events_with_deadline(
            _req(objectives=["fastest"]), deadline_s=0.2
        )
    ]

    done = next(e for e in events if e["type"] == "done")
    assert len(done["payload"]["routes"]) == 1
    assert done["payload"]["reason"] == main_mod.DEADLINE_NOTE
    # It is honest about being partial rather than passing enrichment off as done.
    assert done["payload"]["routes"][0]["enrichment_pending"] is True


@pytest.mark.asyncio
async def test_deadline_with_nothing_ready_is_an_error_not_an_empty_success(
    tmp_cache_db, monkeypatch: pytest.MonkeyPatch
) -> None:
    async def never(body, mode, preset):
        await asyncio.sleep(30)

    monkeypatch.setattr(routing, "_post_route", never)

    events = [
        e
        async for e in main_mod.route_events_with_deadline(
            _req(objectives=["fastest"]), deadline_s=0.1
        )
    ]
    assert events[-1]["type"] == "error"
    assert events[-1]["kind"] == "timeout"


@pytest.mark.asyncio
async def test_a_fast_request_is_untouched_by_the_deadline(
    tmp_cache_db, no_enrichment, monkeypatch: pytest.MonkeyPatch
) -> None:
    async def fake_post(body, mode, preset):
        return _stub(preset)

    monkeypatch.setattr(routing, "_post_route", fake_post)

    events = [
        e
        async for e in main_mod.route_events_with_deadline(
            _req(objectives=["fastest", "scenic"]), deadline_s=30
        )
    ]
    done = next(e for e in events if e["type"] == "done")
    assert done["payload"]["reason"] != main_mod.DEADLINE_NOTE
    assert len(done["payload"]["routes"]) == 2
