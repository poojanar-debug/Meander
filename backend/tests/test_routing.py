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


@pytest.mark.parametrize("preset", ["fastest", "nature", "accessible"])
def test_every_request_body_disables_contraction_hierarchies(preset: str) -> None:
    """Without ch.disable, GraphHopper silently ignores custom_model and every
    preset returns the fastest route. There is no error to notice."""
    body = build_request_body(COLOMBO, VIHARA, 25, "foot", preset)
    assert body["ch.disable"] is True


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
    nature = await route_nature(origin, dest, minutes, mode, fastest.duration_min)
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
    nature = await route_nature(COLOMBO, VIHARA, 25, "foot", fastest.duration_min)

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
    nature = await route_nature(VONDEL, None, 60, "bike", fastest.duration_min)

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
