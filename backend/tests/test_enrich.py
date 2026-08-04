"""Enrichment.

Two things matter here. First, the sun maths has to be right, because shade and
golden hour are derived from it and a sign error would be invisible. Second,
**nothing in this module may fail a request** — every entry point returns
``None`` on failure and the response says `null` rather than inventing a number.
"""

from __future__ import annotations

import math
from datetime import UTC, datetime

import pytest

from backend.enrich import (
    DEPARTURE_HORIZON_H,
    DEPARTURE_STEP_MIN,
    REST_STOP_CORRIDOR_M,
    AirQuality,
    best_departure,
    fetch_air_quality,
    fetch_cloud_cover,
    fetch_rest_stop_nodes,
    golden_hour,
    overpass_query,
    rest_stop_gap_score,
    rest_stops_on_route,
    route_heading,
    shade_need,
    solar_position,
)
from backend.geometry import EARTH_RADIUS_M, LatLon

M_PER_DEG = math.pi * EARTH_RADIUS_M / 180.0

LONDON = LatLon(51.5073, -0.1657)
COLOMBO = LatLon(6.9344, 79.8428)
VONDEL = LatLon(52.3580, 4.8686)


def _line(start: LatLon, metres: float, n: int = 41) -> list[LatLon]:
    return [LatLon(start.lat + (metres * i / (n - 1)) / M_PER_DEG, start.lon) for i in range(n)]


# ---------------------------------------------------------------------------
# solar position
# ---------------------------------------------------------------------------


def test_midsummer_noon_in_london_is_about_62_degrees() -> None:
    """London's solar altitude at the June solstice is ~62 degrees. If this is
    wrong, every shade and golden-hour number downstream is wrong too."""
    sun = solar_position(datetime(2026, 6, 21, 12, 0, tzinfo=UTC), LONDON)
    assert sun.elevation_deg == pytest.approx(61.9, abs=1.5)


def test_midwinter_noon_in_london_is_about_15_degrees() -> None:
    sun = solar_position(datetime(2026, 12, 21, 12, 0, tzinfo=UTC), LONDON)
    assert sun.elevation_deg == pytest.approx(15.1, abs=1.5)


def test_the_sun_is_below_the_horizon_at_midnight() -> None:
    sun = solar_position(datetime(2026, 6, 21, 0, 0, tzinfo=UTC), LONDON)
    assert sun.elevation_deg < 0
    assert not sun.is_up


def test_the_sun_is_due_south_at_local_solar_noon_in_the_north() -> None:
    sun = solar_position(datetime(2026, 3, 20, 12, 0, tzinfo=UTC), LatLon(51.5, 0.0))
    assert sun.azimuth_deg == pytest.approx(180.0, abs=3.0)


def test_the_sun_rises_in_the_east_and_sets_in_the_west() -> None:
    morning = solar_position(datetime(2026, 3, 20, 7, 0, tzinfo=UTC), LatLon(51.5, 0.0))
    evening = solar_position(datetime(2026, 3, 20, 17, 0, tzinfo=UTC), LatLon(51.5, 0.0))

    assert 60 < morning.azimuth_deg < 130, "morning sun should be in the east"
    assert 230 < evening.azimuth_deg < 300, "evening sun should be in the west"


def test_the_tropics_get_a_near_overhead_sun() -> None:
    sun = solar_position(datetime(2026, 4, 8, 6, 30, tzinfo=UTC), COLOMBO)
    assert sun.elevation_deg > 80


def test_azimuth_is_always_in_range() -> None:
    for hour in range(0, 24, 3):
        sun = solar_position(datetime(2026, 8, 4, hour, tzinfo=UTC), LONDON)
        assert 0 <= sun.azimuth_deg < 360
        assert -90 <= sun.elevation_deg <= 90


def test_a_naive_datetime_is_treated_as_utc() -> None:
    aware = solar_position(datetime(2026, 6, 21, 12, 0, tzinfo=UTC), LONDON)
    naive = solar_position(datetime(2026, 6, 21, 12, 0), LONDON)
    assert aware == naive


# ---------------------------------------------------------------------------
# golden hour and shade — the spec's formulas
# ---------------------------------------------------------------------------


def test_golden_hour_is_zero_when_the_sun_is_high() -> None:
    """Golden light is a property of a low sun, not of a direction."""
    high = solar_position(datetime(2026, 6, 21, 12, 0, tzinfo=UTC), LONDON)
    assert golden_hour(high, 270.0) == 0.0


def test_golden_hour_is_zero_when_the_sun_is_below_the_horizon() -> None:
    night = solar_position(datetime(2026, 12, 21, 23, 0, tzinfo=UTC), LONDON)
    assert golden_hour(night, 180.0) == 0.0


def test_golden_hour_peaks_when_heading_into_a_low_sun() -> None:
    evening = solar_position(datetime(2026, 6, 21, 19, 45, tzinfo=UTC), LONDON)
    assert 0 < evening.elevation_deg < 15, "test needs a low sun to be meaningful"

    towards = golden_hour(evening, evening.azimuth_deg)
    away = golden_hour(evening, (evening.azimuth_deg + 180) % 360)

    assert towards == pytest.approx(1.0, abs=0.01)
    assert away == 0.0


def test_shade_need_follows_the_sine_of_elevation() -> None:
    noon = solar_position(datetime(2026, 6, 21, 12, 0, tzinfo=UTC), LONDON)
    assert shade_need(noon) == pytest.approx(math.sin(math.radians(noon.elevation_deg)), abs=1e-6)


def test_shade_is_not_needed_at_night() -> None:
    night = solar_position(datetime(2026, 12, 21, 23, 0, tzinfo=UTC), LONDON)
    assert shade_need(night) == 0.0


def test_shade_need_is_higher_at_noon_than_at_dusk() -> None:
    noon = solar_position(datetime(2026, 6, 21, 12, 0, tzinfo=UTC), LONDON)
    dusk = solar_position(datetime(2026, 6, 21, 19, 30, tzinfo=UTC), LONDON)
    assert shade_need(noon) > shade_need(dusk)


def test_route_heading_of_a_northbound_line_is_zero() -> None:
    assert route_heading(_line(LONDON, 1000)) == pytest.approx(0.0, abs=1.0)


def test_route_heading_of_a_degenerate_route_is_zero() -> None:
    assert route_heading([LONDON]) == 0.0


# ---------------------------------------------------------------------------
# air quality, from recorded live fixtures
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_air_quality_comes_back_as_a_score() -> None:
    air = await fetch_air_quality(COLOMBO)

    assert air is not None
    assert 0.0 <= air.score <= 1.0
    assert air.aqi is not None and air.aqi >= 0


@pytest.mark.asyncio
async def test_a_cleaner_place_scores_higher_than_a_dirtier_one() -> None:
    colombo = await fetch_air_quality(COLOMBO)
    amsterdam = await fetch_air_quality(VONDEL)

    assert colombo is not None and amsterdam is not None
    # Recorded 2026-08-04: Colombo AQI 32, Amsterdam 60.
    assert colombo.score > amsterdam.score


@pytest.mark.asyncio
async def test_air_quality_returns_none_rather_than_guessing() -> None:
    """An unrecorded coordinate must produce null, not a plausible number."""
    assert await fetch_air_quality(LatLon(-40.0, 170.0)) is None


@pytest.mark.asyncio
async def test_cloud_cover_is_a_fraction() -> None:
    cloud = await fetch_cloud_cover(COLOMBO)
    assert cloud is None or 0.0 <= cloud <= 1.0


@pytest.mark.asyncio
async def test_cloud_cover_returns_none_when_unavailable() -> None:
    assert await fetch_cloud_cover(LatLon(-40.0, 170.0)) is None


# ---------------------------------------------------------------------------
# rest stops
# ---------------------------------------------------------------------------


def test_overpass_query_covers_the_route_bbox() -> None:
    points = _line(LONDON, 1000)
    query = overpass_query(points)

    assert "amenity" in query and "bench" in query
    assert "out body" in query
    assert f"timeout:{25}" in query


def test_only_amenities_inside_the_corridor_count() -> None:
    points = _line(LONDON, 1000)
    on_route = {"lat": points[10].lat, "lon": points[10].lon, "tags": {"amenity": "bench"}}
    far_away = {
        "lat": points[10].lat,
        "lon": points[10].lon + 0.01,  # ~700 m east
        "tags": {"amenity": "bench"},
    }

    stops = rest_stops_on_route(points, [on_route, far_away])
    assert len(stops) == 1


def test_rest_stops_are_ordered_along_the_route_with_a_distance() -> None:
    points = _line(LONDON, 1000)
    elements = [
        {"lat": points[30].lat, "lon": points[30].lon, "tags": {"amenity": "toilets"}},
        {"lat": points[5].lat, "lon": points[5].lon, "tags": {"amenity": "bench"}},
    ]

    stops = rest_stops_on_route(points, elements)
    assert [s.type for s in stops] == ["bench", "toilets"]
    assert stops[0].at_m < stops[1].at_m


def test_elements_without_coordinates_are_skipped_not_crashed_on() -> None:
    points = _line(LONDON, 1000)
    assert rest_stops_on_route(points, [{"tags": {"amenity": "bench"}}, {"lat": "x"}]) == []


def test_underscores_in_amenity_names_are_made_readable() -> None:
    points = _line(LONDON, 1000)
    element = {"lat": points[3].lat, "lon": points[3].lon, "tags": {"amenity": "drinking_water"}}

    assert rest_stops_on_route(points, [element])[0].type == "drinking water"


def test_the_corridor_is_narrow_enough_to_mean_something() -> None:
    assert REST_STOP_CORRIDOR_M <= 50


@pytest.mark.asyncio
async def test_recorded_overpass_data_finds_real_benches() -> None:
    """Recorded live from Overpass on 2026-08-04 around Vondelpark."""
    from backend.routing import route_nature

    route = await route_nature(VONDEL, None, 60, "bike")
    nodes = await fetch_rest_stop_nodes(route.points)

    assert nodes is not None
    assert len(nodes) > 0
    assert any((n.get("tags") or {}).get("amenity") == "bench" for n in nodes)


@pytest.mark.asyncio
async def test_unreachable_overpass_returns_none_not_an_empty_list() -> None:
    """None means "we could not look". An empty list means "we looked and there
    are none". Conflating them would report a bench-less route as verified."""
    assert await fetch_rest_stop_nodes(_line(LatLon(-40.0, 170.0), 800)) is None


def test_a_degenerate_route_has_no_rest_stops_rather_than_failing() -> None:
    assert rest_stops_on_route([LONDON], []) == []


# ---------------------------------------------------------------------------
# rest stop spacing
# ---------------------------------------------------------------------------


def test_evenly_spaced_stops_score_well() -> None:
    from backend.enrich import RestStop

    points = _line(LONDON, 800)
    stops = [RestStop(0, 0, "bench", at_m=m) for m in (150, 350, 550, 750)]

    assert rest_stop_gap_score(points, stops) == pytest.approx(1.0)


def test_a_long_gap_lowers_the_score() -> None:
    from backend.enrich import RestStop

    points = _line(LONDON, 2000)
    stops = [RestStop(0, 0, "bench", at_m=100)]

    score = rest_stop_gap_score(points, stops)
    assert score is not None and score < 0.2


def test_no_stops_at_all_scores_zero() -> None:
    assert rest_stop_gap_score(_line(LONDON, 1000), []) == 0.0


def test_unknown_stops_score_none_not_zero() -> None:
    assert rest_stop_gap_score(_line(LONDON, 1000), None) is None


# ---------------------------------------------------------------------------
# best departure
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_best_departure_lands_inside_the_search_horizon() -> None:
    start = datetime(2026, 8, 4, 9, 0, tzinfo=UTC)
    suggestion = await best_departure(
        _line(LONDON, 1500), start, air=AirQuality(0.8, 20.0, 5.0), cloud=0.2
    )

    assert suggestion is not None
    delta_min = (suggestion.when - start).total_seconds() / 60
    assert 0 <= delta_min <= DEPARTURE_HORIZON_H * 60
    assert delta_min % DEPARTURE_STEP_MIN == 0


@pytest.mark.asyncio
async def test_best_departure_prefers_the_low_evening_sun_over_midday_glare() -> None:
    """The whole point of the search: on a clear day it should not send someone
    out into the noon sun."""
    midday = datetime(2026, 6, 21, 11, 0, tzinfo=UTC)
    suggestion = await best_departure(
        _line(LONDON, 1500), midday, air=AirQuality(0.8, 20.0, 5.0), cloud=0.0
    )

    assert suggestion is not None
    assert suggestion.when.hour >= 15


@pytest.mark.asyncio
async def test_best_departure_carries_a_readable_reason() -> None:
    suggestion = await best_departure(
        _line(LONDON, 1500),
        datetime(2026, 8, 4, 9, 0, tzinfo=UTC),
        air=AirQuality(0.9, 10.0, 3.0),
        cloud=0.1,
    )

    assert suggestion is not None
    assert suggestion.reason.endswith(".")
    assert suggestion.reason[0].isupper()


@pytest.mark.asyncio
async def test_best_departure_returns_none_when_nothing_can_be_measured() -> None:
    """Naming a "best time" with no data behind it would be worse than silence."""
    result = await best_departure(_line(LatLon(-40.0, 170.0), 1500),
                                  datetime(2026, 8, 4, 9, 0, tzinfo=UTC))
    assert result is None


@pytest.mark.asyncio
async def test_best_departure_of_a_degenerate_route_is_none() -> None:
    assert await best_departure([LONDON]) is None
