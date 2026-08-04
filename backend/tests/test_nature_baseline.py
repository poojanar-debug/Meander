"""Nature must always be measured against a fastest route.

`objectives` accepts any subset, so {"objectives": ["nature"]} is a valid public
request. Without a baseline, route_nature receives fastest=None and **both** of
its bars quietly switch off — the 1.6x NATURE_DURATION_CAP and the "must be
greener than fastest" floor. Every candidate then counts as acceptable and the
winner ships labelled Nature with no preset_note.

That is a label with nothing behind it, which route_nature's own docstring says
must never happen: "a 'nature' route no greener than the plain one is a label
without a thing behind it".
"""

from __future__ import annotations

import pytest

from backend import main as main_mod
from backend import routing
from backend.geometry import LatLon
from backend.models import Point, RouteRequest

ORIGIN = LatLon(6.9337, 79.8501)


def _stub(preset: str, minutes: float, *, green: bool) -> routing.RawRoute:
    # Point count is the seam the stubbed scorer keys on.
    n = 12 if green else 9
    return routing.RawRoute(
        points=[LatLon(6.9337 + i * 0.001, 79.8501 + i * 0.001) for i in range(n)],
        distance_m=minutes * 75.0,
        duration_min=minutes,
        mode="foot",
        preset=preset,
    )


@pytest.fixture
def stub_scoring(monkeypatch: pytest.MonkeyPatch):
    from backend import geometry as geometry_mod

    def fake_score(points, elevations=None, details=None, clip_score=None):
        return type("S", (), {"nature": 0.9 if len(points) == 12 else 0.1, "air": None})()

    monkeypatch.setattr(geometry_mod, "score_geometry", fake_score)


# ---------------------------------------------------------------------------
# route_nature itself
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_without_a_baseline_every_bar_is_off(
    stub_scoring, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The defect, pinned so a refactor cannot quietly reintroduce it.

    A 200-minute answer to a 30-minute request, no greener than nothing in
    particular, is 'acceptable' when there is nothing to compare against.
    """
    monkeypatch.setenv("MEANDER_GRAPHHOPPER_SELF_HOSTED", "0")

    async def fake_post(body, mode, preset):
        return _stub(preset, 200.0, green=False)

    monkeypatch.setattr(routing, "_post_route", fake_post)

    result = await routing.route_nature(ORIGIN, None, 30, "foot", fastest=None)

    # It still returns the best it can — but it must say the promise is unbacked.
    assert result.preset_note == routing.UNCOMPARED_NOTE


@pytest.mark.asyncio
async def test_with_a_baseline_the_cap_rejects_an_overlong_candidate(
    stub_scoring, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("MEANDER_GRAPHHOPPER_SELF_HOSTED", "0")

    async def fake_post(body, mode, preset):
        return _stub(preset, 200.0, green=True)

    monkeypatch.setattr(routing, "_post_route", fake_post)

    fastest = _stub("fastest", 40.0, green=False)  # cap = 64 min
    result = await routing.route_nature(ORIGIN, None, 30, "foot", fastest)

    assert result.duration_min > 40.0 * routing.NATURE_DURATION_CAP
    assert result.preset_note is not None
    assert "longer than you asked for" in result.preset_note


@pytest.mark.asyncio
async def test_with_a_baseline_the_greenness_floor_rejects_a_dull_candidate(
    stub_scoring, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("MEANDER_GRAPHHOPPER_SELF_HOSTED", "0")

    async def fake_post(body, mode, preset):
        return _stub(preset, 30.0, green=False)  # same greenness as the baseline

    monkeypatch.setattr(routing, "_post_route", fake_post)

    fastest = _stub("fastest", 30.0, green=False)
    result = await routing.route_nature(ORIGIN, None, 30, "foot", fastest)

    assert result.preset_note is not None
    assert "greener than the fastest" in result.preset_note.lower()


# ---------------------------------------------------------------------------
# the public request that reaches it
# ---------------------------------------------------------------------------


async def _drain(req: RouteRequest) -> dict:
    payload = None
    async for event in main_mod.route_events(req):
        if event["type"] == "done":
            payload = event["payload"]
    assert payload is not None
    return payload


@pytest.mark.asyncio
async def test_nature_only_request_still_routes_a_baseline(
    stub_scoring, tmp_cache_db, monkeypatch: pytest.MonkeyPatch
) -> None:
    """{"objectives": ["nature"]} must not disable the cap and the floor."""
    monkeypatch.setenv("MEANDER_GRAPHHOPPER_SELF_HOSTED", "0")

    seen: list[str] = []

    async def fake_post(body, mode, preset):
        seen.append(preset)
        return _stub(preset, 30.0, green=True)

    monkeypatch.setattr(routing, "_post_route", fake_post)
    monkeypatch.setattr(main_mod, "enrich_context", _no_enrichment)

    req = RouteRequest(origin=Point(lat=6.9337, lon=79.8501), minutes=30, objectives=["nature"])
    payload = await _drain(req)

    assert "fastest" in seen, "a baseline must be routed even when not requested"
    # ...and it must not leak into the answer the caller asked for.
    assert [r["id"] for r in payload["routes"]] == ["nature"]


@pytest.mark.asyncio
async def test_nature_only_says_so_when_the_baseline_fails(
    stub_scoring, tmp_cache_db, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A failed baseline degrades to an honest caveat, not a silent claim."""
    monkeypatch.setenv("MEANDER_GRAPHHOPPER_SELF_HOSTED", "0")

    async def fake_post(body, mode, preset):
        if preset == "fastest":
            raise routing.NoRouteFound("nothing near there")
        return _stub(preset, 300.0, green=True)

    monkeypatch.setattr(routing, "_post_route", fake_post)
    monkeypatch.setattr(main_mod, "enrich_context", _no_enrichment)

    req = RouteRequest(origin=Point(lat=6.9337, lon=79.8501), minutes=30, objectives=["nature"])
    payload = await _drain(req)

    nature = next(r for r in payload["routes"] if r["id"] == "nature")
    assert nature["status_note"] == routing.UNCOMPARED_NOTE


@pytest.mark.asyncio
async def test_an_explicit_fastest_is_not_routed_twice(
    stub_scoring, tmp_cache_db, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("MEANDER_GRAPHHOPPER_SELF_HOSTED", "0")

    seen: list[str] = []

    async def fake_post(body, mode, preset):
        seen.append(preset)
        return _stub(preset, 30.0, green=True)

    monkeypatch.setattr(routing, "_post_route", fake_post)
    monkeypatch.setattr(main_mod, "enrich_context", _no_enrichment)

    req = RouteRequest(
        origin=Point(lat=6.9337, lon=79.8501), minutes=30, objectives=["fastest", "nature"]
    )
    await _drain(req)

    assert seen.count("fastest") == 1


async def _no_enrichment(geometries, depart_at=None):
    from backend.enrich import EnrichContext

    return EnrichContext()
