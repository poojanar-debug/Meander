"""Routing correctness, with heavy weight on the places a silent bug produces a
plausible-looking wrong answer: the coordinate converter and the ch.disable flag.
"""

from __future__ import annotations

import pytest

from backend.config import TEST_LOCATIONS_BY_SLUG
from backend.geometry import LatLon, haversine_m
from backend.models import derive_mode, effective_mode
from backend.routing import (
    NATURE_DURATION_CAP,
    NoRouteFound,
    accessible_custom_model,
    build_request_body,
    from_post_point,
    loop_returned_to_origin,
    nature_custom_model,
    route_accessible,
    route_fastest,
    route_nature,
    to_get_point,
    to_post_point,
)


def _pt(slug: str) -> LatLon:
    loc = TEST_LOCATIONS_BY_SLUG[slug]
    return LatLon(loc.lat, loc.lon)


COLOMBO = _pt("colombo-fort")
VIHARA = _pt("viharamahadevi")
HYDE = _pt("hyde-park-london")
EUSTON = _pt("euston-road-london")
VONDEL = _pt("amsterdam-vondelpark")


# ---------------------------------------------------------------------------
# the coordinate converter — POST takes [lon, lat], GET takes "lat,lon"
# ---------------------------------------------------------------------------


def test_post_point_is_lon_then_lat() -> None:
    assert to_post_point(LatLon(6.9344, 79.8428)) == [79.8428, 6.9344]


def test_get_point_is_lat_then_lon() -> None:
    assert to_get_point(LatLon(6.9344, 79.8428)) == "6.9344,79.8428"


def test_post_and_get_orderings_are_actually_different() -> None:
    """The bug this guards against is using one form where the other is required."""
    p = LatLon(51.5073, -0.1657)
    assert to_get_point(p).split(",") != [str(v) for v in to_post_point(p)]


def test_from_post_point_round_trips() -> None:
    p = LatLon(52.3580, 4.8686)
    assert from_post_point(to_post_point(p)) == p


def test_from_post_point_ignores_a_third_elevation_element() -> None:
    assert from_post_point([79.8428, 6.9344, 12.5]) == LatLon(6.9344, 79.8428)


def test_converter_survives_a_negative_longitude() -> None:
    """London is west of Greenwich; a sign flip here would route into the sea."""
    p = LatLon(51.5073, -0.1657)
    assert to_post_point(p) == [-0.1657, 51.5073]
    assert from_post_point(to_post_point(p)).lon < 0


def test_converter_survives_a_southern_latitude() -> None:
    p = LatLon(-33.8688, 151.2093)
    assert from_post_point(to_post_point(p)) == p


# ---------------------------------------------------------------------------
# the ch.disable gotcha
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("preset", ["nature", "accessible"])
def test_a_custom_model_always_travels_with_flexible_mode(preset: str) -> None:
    """A custom model without ch.disable is rejected, and older GraphHopper
    versions discarded it silently — returning the fastest route under every
    preset with no error at all."""
    body = build_request_body(COLOMBO, VIHARA, 25, "foot", preset)
    assert "custom_model" in body
    assert body["ch.disable"] is True


def test_flexible_mode_is_never_requested_without_a_custom_model() -> None:
    """ch.disable is a paid GraphHopper feature: a free package rejects any
    request carrying it with "Free packages cannot use flexible mode". Sending
    it on the fastest preset, which needs no custom model, broke the baseline
    route on the free tier and took the whole request down with it."""
    body = build_request_body(COLOMBO, VIHARA, 25, "foot", "fastest")
    assert "custom_model" not in body
    assert "ch.disable" not in body


def test_a_round_trip_does_not_request_flexible_mode() -> None:
    """Round trips work on a free package; they only stop working if ch.disable
    is bolted on."""
    body = build_request_body(COLOMBO, None, 30, "foot", "fastest")
    assert body["algorithm"] == "round_trip"
    assert "ch.disable" not in body


def test_nature_body_carries_a_custom_model() -> None:
    body = build_request_body(COLOMBO, VIHARA, 25, "foot", "nature")
    assert "custom_model" in body
    assert body["custom_model"]["distance_influence"] == 20


def test_accessible_body_carries_a_custom_model() -> None:
    body = build_request_body(COLOMBO, VIHARA, 25, "foot", "accessible")
    assert "custom_model" in body


def test_fastest_body_has_no_custom_model() -> None:
    assert "custom_model" not in build_request_body(COLOMBO, VIHARA, 25, "foot", "fastest")


def test_request_body_uses_lon_lat_points() -> None:
    body = build_request_body(COLOMBO, VIHARA, 25, "foot")
    assert body["points"][0] == [COLOMBO.lon, COLOMBO.lat]
    assert body["points"][1] == [VIHARA.lon, VIHARA.lat]


def test_round_trip_body_sends_one_point_and_a_distance() -> None:
    body = build_request_body(COLOMBO, None, 30, "foot")
    assert len(body["points"]) == 1
    assert body["algorithm"] == "round_trip"
    assert body["round_trip.distance"] > 0


def test_round_trip_body_does_not_set_heading() -> None:
    """heading is ignored by round_trip; setting it would imply control we lack."""
    assert "heading" not in build_request_body(COLOMBO, None, 30, "foot")


def test_round_trip_distance_scales_with_the_time_budget() -> None:
    short = build_request_body(COLOMBO, None, 20, "foot")["round_trip.distance"]
    long = build_request_body(COLOMBO, None, 40, "foot")["round_trip.distance"]
    assert long == pytest.approx(short * 2, rel=0.05)


def test_round_trip_seed_is_fixed_so_the_cache_can_hit() -> None:
    a = build_request_body(COLOMBO, None, 30, "foot")
    b = build_request_body(COLOMBO, None, 30, "foot")
    assert a["round_trip.seed"] == b["round_trip.seed"]


# ---------------------------------------------------------------------------
# custom models
# ---------------------------------------------------------------------------


def test_accessible_model_excludes_steps_outright() -> None:
    rules = accessible_custom_model()["priority"]
    steps = [r for r in rules if "STEPS" in r["if"]]
    assert steps and all(r["multiply_by"] == "0" for r in steps)


def test_accessible_model_excludes_known_bad_surfaces() -> None:
    rules = accessible_custom_model()["priority"]
    excluded = " ".join(r["if"] for r in rules if r["multiply_by"] == "0")
    for surface in ("GRAVEL", "GROUND", "SAND", "COBBLESTONE", "UNPAVED"):
        assert surface in excluded


def test_accessible_model_does_not_exclude_untagged_ways() -> None:
    """Excluding MISSING would return no route almost anywhere. Untagged ways are
    routed and then marked UNKNOWN by accessibility.py — never 'accessible'."""
    rules = accessible_custom_model()["priority"]
    zeroed = " ".join(r["if"] for r in rules if r["multiply_by"] == "0")
    assert "MISSING" not in zeroed


def test_nature_model_penalises_arterial_roads() -> None:
    rules = nature_custom_model(20)["priority"]
    motorway = next(r for r in rules if "MOTORWAY" in r["if"])
    assert float(motorway["multiply_by"]) < 0.2


def test_nature_distance_influence_is_configurable() -> None:
    assert nature_custom_model(90)["distance_influence"] == 90


# ---------------------------------------------------------------------------
# the auto-mode ladder
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    "minutes,expected",
    [(20, "foot"), (45, "foot"), (46, "bike"), (120, "bike"), (121, "car"), (360, "car")],
)
def test_derive_mode_boundaries(minutes: int, expected: str) -> None:
    assert derive_mode(minutes) == expected


def test_explicit_mode_overrides_the_ladder() -> None:
    assert effective_mode("foot", 300) == "foot"
    assert effective_mode("auto", 300) == "car"


# ---------------------------------------------------------------------------
# routing against fixtures
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "origin,dest,minutes,mode",
    [(COLOMBO, VIHARA, 25, "foot"), (EUSTON, HYDE, 40, "foot")],
)
async def test_three_presets_produce_measurably_different_routes(origin, dest, minutes, mode) -> None:
    fastest = await route_fastest(origin, dest, minutes, mode)
    nature = await route_nature(origin, dest, minutes, mode, fastest)
    accessible = await route_accessible(origin, dest, minutes, mode)

    geometries = {
        tuple((round(p.lat, 5), round(p.lon, 5)) for p in r.points)
        for r in (fastest, nature, accessible)
    }
    assert len(geometries) == 3, "presets returned identical geometry — check ch.disable"

    assert nature.distance_m > fastest.distance_m * 1.05
    assert nature.duration_min > fastest.duration_min


@pytest.mark.asyncio
async def test_nature_respects_the_duration_cap() -> None:
    fastest = await route_fastest(COLOMBO, VIHARA, 25, "foot")
    nature = await route_nature(COLOMBO, VIHARA, 25, "foot", fastest)

    assert nature.duration_min <= fastest.duration_min * NATURE_DURATION_CAP


@pytest.mark.asyncio
async def test_round_trip_returns_to_the_origin() -> None:
    loop = await route_fastest(HYDE, None, 35, "foot")

    assert loop_returned_to_origin(loop, HYDE)
    assert haversine_m(loop.points[0], loop.points[-1]) < 150
    assert loop.distance_m > 500, "a loop that returns immediately is not a loop"


@pytest.mark.asyncio
async def test_round_trip_presets_also_differ() -> None:
    fastest = await route_fastest(VONDEL, None, 60, "bike")
    nature = await route_nature(VONDEL, None, 60, "bike", fastest)

    assert fastest.points != nature.points
    assert loop_returned_to_origin(nature, VONDEL)


@pytest.mark.asyncio
async def test_an_unroutable_preset_raises_no_route_found() -> None:
    with pytest.raises(NoRouteFound):
        await route_accessible(COLOMBO, None, 30, "foot")


@pytest.mark.asyncio
async def test_routes_from_synthetic_fixtures_are_flagged_as_such() -> None:
    """A hand-built fixture must never be mistaken for a measurement."""
    route = await route_fastest(COLOMBO, VIHARA, 25, "foot")

    assert route.synthetic_upstream is True


@pytest.mark.asyncio
async def test_parsed_route_carries_path_details_for_the_accessibility_engine() -> None:
    route = await route_fastest(COLOMBO, VIHARA, 25, "foot")

    assert "surface" in route.details
    assert "road_class" in route.details
    first_span = route.details["surface"][0]
    assert len(first_span) == 3 and isinstance(first_span[0], int)


@pytest.mark.asyncio
async def test_parsed_route_carries_turn_instructions() -> None:
    """The step list is only as honest as what the router actually said."""
    route = await route_fastest(COLOMBO, VIHARA, 25, "foot")

    assert route.steps, "the router returned instructions and they must survive parsing"
    first = route.steps[0]
    assert first.text and isinstance(first.text, str)
    assert first.distance_m >= 0
    assert first.duration_min >= 0
    # The interval indexes into the point array, which is what lets the frontend
    # highlight the matching stretch of line and place a barrier inside the step
    # a walker would meet it on.
    assert len(first.interval) == 2
    assert 0 <= first.interval[0] <= first.interval[1] < len(route.points)


def test_no_instructions_is_an_empty_list_not_an_invention() -> None:
    """A router that describes no turns must not have turns made up for it.

    This is the same rule as an untagged path being UNKNOWN rather than
    accessible: absence of data is not permission to fill it in.
    """
    from backend.routing import _parse_instructions

    assert _parse_instructions(None) == []
    assert _parse_instructions([]) == []
    assert _parse_instructions("not a list") == []
    # Entries with no usable text are dropped rather than rendered blank.
    assert _parse_instructions([{"distance": 10}, {"text": "   "}]) == []


def test_malformed_instruction_entries_degrade_rather_than_raise() -> None:
    from backend.routing import _parse_instructions

    steps = _parse_instructions(
        [
            {"text": "Turn left", "distance": "nope", "time": None, "interval": "bad"},
            {"text": "Continue", "distance": 120.5, "time": 90000, "interval": [3, 9]},
        ]
    )
    assert len(steps) == 2
    assert steps[0].interval == (0, 0)
    assert steps[1].interval == (3, 9)
    assert steps[1].distance_m == 120.5
    assert steps[1].duration_min == pytest.approx(1.5)


@pytest.mark.asyncio
async def test_parsed_route_carries_elevation() -> None:
    route = await route_fastest(COLOMBO, VIHARA, 25, "foot")

    assert route.has_elevation
    assert len(route.elevations) == len(route.points)


@pytest.mark.asyncio
async def test_geometry_is_emitted_in_geojson_lon_lat_order() -> None:
    from backend.routing import geometry_for_wire

    route = await route_fastest(COLOMBO, VIHARA, 25, "foot")
    first = geometry_for_wire(route)[0]

    # Colombo is at lon ~79.8, lat ~6.9. If these were swapped, the first value
    # would be the small one.
    assert first[0] > 70 and first[1] < 10


# ---------------------------------------------------------------------------
# self-hosted vs hosted GraphHopper
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    "url,self_hosted",
    [
        ("http://localhost:8989/route", True),
        ("http://127.0.0.1:8989/route", True),
        ("http://gh.local:8989/route", True),
        ("https://graphhopper.com/api/1/route", False),
        ("https://graphhopper.com.evil.invalid/route", False),
    ],
)
def test_self_hosted_detection(monkeypatch, url: str, self_hosted: bool) -> None:
    """Drives whether smoothness is requested, so a wrong answer here silently
    changes what the accessibility engine can see."""
    from backend import config

    monkeypatch.setattr(config, "GRAPHHOPPER_URL", url)
    assert config.graphhopper_is_self_hosted() is self_hosted


def test_hosted_graphhopper_is_not_asked_for_smoothness(monkeypatch) -> None:
    """The hosted API rejects unknown path details, so asking would 400 every
    request rather than degrading."""
    from backend import config

    monkeypatch.setattr(config, "GRAPHHOPPER_URL", "https://graphhopper.com/api/1/route")
    monkeypatch.delenv("MEANDER_PATH_DETAILS", raising=False)
    assert "smoothness" not in config.path_details()


def test_a_self_hosted_server_is_asked_for_smoothness(monkeypatch) -> None:
    """smoothness is one of the five hard accessibility constraints, and a graph
    we build ourselves can expose it."""
    from backend import config

    monkeypatch.setattr(config, "GRAPHHOPPER_URL", "http://localhost:8989/route")
    monkeypatch.delenv("MEANDER_PATH_DETAILS", raising=False)
    assert "smoothness" in config.path_details()


def test_path_details_can_be_overridden(monkeypatch) -> None:
    from backend import config

    monkeypatch.setenv("MEANDER_PATH_DETAILS", "surface, road_class")
    assert config.path_details() == ["surface", "road_class"]


# ---------------------------------------------------------------------------
# the nature duration cap
# ---------------------------------------------------------------------------


def test_budget_fit_peaks_at_the_requested_duration() -> None:
    from backend.routing import _budget_fit

    assert _budget_fit(30, 30) == 1.0
    assert _budget_fit(21, 30) == pytest.approx(0.7)
    assert _budget_fit(39, 30) == pytest.approx(0.7)
    # A route twice the budget scores nothing, rather than going negative.
    assert _budget_fit(60, 30) == 0.0
    assert _budget_fit(300, 30) == 0.0


def test_budget_fit_of_a_zero_budget_is_not_a_division_by_zero() -> None:
    from backend.routing import _budget_fit

    assert _budget_fit(10, 0) == 0.0


def test_loop_distance_scale_shrinks_the_round_trip_target() -> None:
    """The only lever that moves a round trip. distance_influence does not:
    measured in Colombo, values from 20 to 400 all returned the same loop."""
    full = build_request_body(COLOMBO, None, 30, "foot", "nature")
    half = build_request_body(COLOMBO, None, 30, "foot", "nature", 20, 0.5)

    assert half["round_trip.distance"] == pytest.approx(full["round_trip.distance"] / 2, abs=1)


def test_loop_distance_scale_does_not_apply_to_point_to_point() -> None:
    body = build_request_body(COLOMBO, VIHARA, 30, "foot", "nature", 20, 0.5)
    assert "round_trip.distance" not in body


def test_the_loop_candidate_set_spans_a_useful_range() -> None:
    """A single ladder cannot work when the router responds discontinuously, so
    the candidates have to actually sample the space."""
    from backend.routing import NATURE_LOOP_CANDIDATES

    scales = [scale for _, scale in NATURE_LOOP_CANDIDATES]
    assert max(scales) == 1.0
    assert min(scales) <= 0.4
    assert len(set(scales)) >= 4


@pytest.mark.asyncio
async def test_nature_stays_inside_the_cap_when_a_candidate_fits() -> None:
    fastest = await route_fastest(COLOMBO, VIHARA, 25, "foot")
    nature = await route_nature(COLOMBO, VIHARA, 25, "foot", fastest)

    assert nature.duration_min <= fastest.duration_min * NATURE_DURATION_CAP
    assert nature.preset_note is None


@pytest.mark.asyncio
async def test_nature_is_greener_than_fastest_or_says_why_not() -> None:
    """A nature route no greener than the plain one is a label with nothing
    behind it. It is allowed to happen — some places have no greener way — but
    it is never allowed to happen silently."""
    from backend.geometry import score_geometry

    fastest = await route_fastest(COLOMBO, VIHARA, 25, "foot")
    nature = await route_nature(COLOMBO, VIHARA, 25, "foot", fastest)

    def green(r):
        return score_geometry(r.points, r.elevations or None, r.details).nature

    assert green(nature) > green(fastest) or nature.preset_note is not None


@pytest.mark.asyncio
async def test_nature_without_a_baseline_applies_no_cap() -> None:
    """Called with no fastest route there is nothing to be capped against."""
    nature = await route_nature(COLOMBO, VIHARA, 25, "foot", None)
    assert nature.duration_min > 0
