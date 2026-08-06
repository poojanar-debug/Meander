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


# ---------------------------------------------------------------------------
# The floor must be measured on the score the user is shown
# ---------------------------------------------------------------------------
#
# Latent for the whole project and only reachable once data/cache.db held CLIP
# rows. `greenness()` called score_geometry *without* clip_score, so the
# candidate was judged on a number that omitted the largest term in the score
# (WEIGHT_CLIP is 0.45) and then rendered with one that included it. The floor
# and the card disagreed, and the card is what a person reads.
#
# Found by pre-warming the cache and looking: Hyde Park returned a nature route
# at 0.4806 against a fastest route at 0.4854 — passing a floor it visibly
# failed.


@pytest.fixture
def clip_dominated_scoring(monkeypatch: pytest.MonkeyPatch):
    """A world where CLIP and the geometry proxy disagree about which is greener.

    9-point routes: geometry says grim, CLIP says lush.
    12-point routes: geometry says lush, CLIP says grim.

    Any judgement that ignores clip_score therefore reaches the opposite
    conclusion from one that uses it, which is exactly the bug.
    """
    from backend import geometry as geometry_mod
    from backend import scoring as scoring_mod

    def fake_score(points, elevations=None, details=None, clip_score=None):
        geometry_only = 0.9 if len(points) == 12 else 0.1
        return type("S", (), {
            "nature": geometry_only if clip_score is None else clip_score,
            "air": None,
        })()

    def fake_clip(points, cache=None):
        return scoring_mod.ClipTerm(0.1 if len(points) == 12 else 0.9, 1.0, 4, 4)

    monkeypatch.setattr(geometry_mod, "score_geometry", fake_score)
    monkeypatch.setattr(scoring_mod, "clip_term_for_route", fake_clip)


@pytest.mark.asyncio
async def test_the_greenness_floor_uses_the_same_score_the_card_shows(
    clip_dominated_scoring, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A candidate greener only by the geometry proxy must not pass the floor.

    The candidate here scores 0.9 on geometry alone and 0.1 once CLIP is
    counted; the baseline is the other way round. Judged on the geometry proxy
    it sails through and ships labelled Nature with no note. Judged on the
    number that reaches the card, it is plainly *less* green than the fastest
    route and has to say so.
    """
    monkeypatch.setenv("MEANDER_GRAPHHOPPER_SELF_HOSTED", "0")

    async def fake_post(body, mode, preset):
        return _stub(preset, 30.0, green=True)      # 12 points: clip says 0.1

    monkeypatch.setattr(routing, "_post_route", fake_post)

    fastest = _stub("fastest", 30.0, green=False)   # 9 points: clip says 0.9
    result = await routing.route_nature(ORIGIN, None, 30, "foot", fastest)

    assert result.preset_note is not None, (
        "a route the card will show as less green than fastest was accepted "
        "silently — the floor is being applied to a different number"
    )
    assert "greener" in result.preset_note


@pytest.mark.asyncio
async def test_a_candidate_greener_on_the_shown_score_still_passes(
    clip_dominated_scoring, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The mirror image, so the fix is not just "always add a note"."""
    monkeypatch.setenv("MEANDER_GRAPHHOPPER_SELF_HOSTED", "0")

    async def fake_post(body, mode, preset):
        return _stub(preset, 30.0, green=False)     # 9 points: clip says 0.9

    monkeypatch.setattr(routing, "_post_route", fake_post)

    fastest = _stub("fastest", 30.0, green=True)    # 12 points: clip says 0.1
    result = await routing.route_nature(ORIGIN, None, 30, "foot", fastest)

    assert result.preset_note is None
