"""Enrichment.

Two things matter here. First, the sun maths has to be right, because shade and
golden hour are derived from it and a sign error would be invisible. Second,
**nothing in this module may fail a request** — every entry point returns
``None`` on failure and the response says `null` rather than inventing a number.
"""

from __future__ import annotations

import math
from datetime import UTC, datetime, timedelta

import pytest

from backend.accessibility import BARRIER_VALUES_WITH_A_VERDICT
from backend.config import TEST_LOCATIONS_BY_SLUG
from backend.enrich import (
    DEPARTURE_HORIZON_H,
    DEPARTURE_STEP_MIN,
    OVERPASS_MAX_RESULTS,
    REST_STOP_CORRIDOR_M,
    AirQuality,
    OverpassNodes,
    _bbox,
    barrier_spans_on_route,
    best_departure,
    fetch_air_quality,
    fetch_cloud_cover,
    fetch_rest_stop_nodes,
    golden_hour,
    overpass_barrier_query,
    overpass_query,
    rest_stop_gap_score,
    rest_stops_on_route,
    route_heading,
    shade_need,
    solar_position,
)
from backend.geometry import EARTH_RADIUS_M, LatLon

M_PER_DEG = math.pi * EARTH_RADIUS_M / 180.0


def _at(slug: str) -> LatLon:
    """Coordinates come from the config, never hard-coded.

    A copy of a coordinate in a test file drifts the moment the config changes,
    and the failure looks like a missing fixture rather than a stale test.
    """
    loc = TEST_LOCATIONS_BY_SLUG[slug]
    return LatLon(loc.lat, loc.lon)


LONDON = _at("hyde-park-london")
COLOMBO = _at("colombo-fort")
VONDEL = _at("amsterdam-vondelpark")


def _line(start: LatLon, metres: float, n: int = 41) -> list[LatLon]:
    """A straight line north, `n` vertices, `metres` long.

    ⚠ **The default spacing used to be exactly the barrier corridor.**
    `_line(LONDON, 400)` with n=41 puts a vertex every 400/40 = **10.00 m**,
    which is `BARRIER_CORRIDOR_M` to the centimetre. On geometry spaced like
    that, the distance to the nearest vertex and the perpendicular distance to
    the line never differ by more than the corridor, so the two tests agree on
    every point and the nearest-vertex bug could not be expressed. It shipped
    for exactly that reason.

    Callers that care about the corridor pass `n` explicitly; `_sparse_line`
    below exists to make the difference visible.
    """
    return [LatLon(start.lat + (metres * i / (n - 1)) / M_PER_DEG, start.lon) for i in range(n)]


def _sparse_line(start: LatLon, metres: float, n: int = 3) -> list[LatLon]:
    """The same line with vertices far apart, which is what real geometry is.

    Measured over the 86 committed GraphHopper fixtures: 11,331 segments,
    median 14.8 m, p90 69.7 m, longest 499.5 m. A 400 m line in three vertices
    is a 200 m segment, comfortably inside that distribution and well past the
    10 m corridor.
    """
    return _line(start, metres, n)


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



def _recorded_air_series_start(point: LatLon) -> datetime:
    """The first hour the recorded air-quality forecast for ``point`` covers.

    These tests used to hard-code a date, which made them expire. A fixture
    holds the forecast for the day it was recorded, and `_hour_index` now
    matches against the series' own timestamps rather than assuming the series
    starts today — so an hour outside it correctly answers ``None``, and any
    re-recording moved the corpus out from under a literal date.

    Reading the start from the fixture keeps the assertion about the wiring
    instead of about the calendar, and it is the same file the code under test
    will read a moment later.
    """
    import json

    from backend import fixtures as fx
    from backend.config import OPEN_METEO_AQ_URL

    sig = fx.signature(
        "GET",
        OPEN_METEO_AQ_URL,
        params={
            "latitude": round(point.lat, 3),
            "longitude": round(point.lon, 3),
            "hourly": "pm2_5,european_aqi",
            "forecast_days": 2,
        },
        headers={"Accept": "application/json"},
    )
    path = fx.fixture_path("open_meteo", sig)
    if not path.exists():
        pytest.skip(f"no recorded air-quality fixture for {point}")
    stamps = json.loads(path.read_text())["response"]["json"]["hourly"]["time"]
    return datetime.fromisoformat(stamps[0]).replace(tzinfo=UTC)


@pytest.mark.asyncio
async def test_air_quality_comes_back_as_a_score() -> None:
    air = await fetch_air_quality(COLOMBO, _recorded_air_series_start(COLOMBO))

    assert air is not None
    assert 0.0 <= air.score <= 1.0
    assert air.aqi is not None and air.aqi >= 0


@pytest.mark.asyncio
async def test_a_cleaner_place_scores_higher_than_a_dirtier_one() -> None:
    """Pinned to a named hour, because the fixture is a 24-hour series.

    ⚠ This used to call fetch_air_quality() with no `when`, which falls back to
    datetime.now(UTC), and _hour_index() indexes the recorded series by the
    current UTC *hour*. So the assertion depended on the wall clock in a suite
    whose entire point is that it is hermetic and offline.

    It was written during an hour when it happened to hold, and it held for
    about a year until midnight UTC on 2026-08-05, when the hour rolled to 01
    and Colombo's AQI (34) went above Amsterdam's (32). Measured across the
    recorded day, the ordering holds at 18 of the 24 hours and fails at
    00-02 and 05-07.

    **And it no longer names a winner.** It asserted Colombo 32 against
    Amsterdam 60, which is a fact about the air on the day the fixture was
    recorded, not about this code — re-recording moved it to Colombo 27 against
    Amsterdam 22 and the ordering simply reversed. Which of two cities is
    cleaner on a given afternoon is not something a unit test can own.

    What this module does own is the mapping: a lower European AQI must produce
    a higher score, monotonically, on whichever readings it is handed. That is
    asserted against two real recorded readings, in whatever order they fall.
    """
    colombo_noon = _recorded_air_series_start(COLOMBO) + timedelta(hours=12)
    vondel_noon = _recorded_air_series_start(VONDEL) + timedelta(hours=12)
    colombo = await fetch_air_quality(COLOMBO, colombo_noon)
    amsterdam = await fetch_air_quality(VONDEL, vondel_noon)

    assert colombo is not None and amsterdam is not None
    assert colombo.aqi is not None and amsterdam.aqi is not None
    assert colombo.aqi != amsterdam.aqi, "two identical readings cannot order anything"

    cleaner, dirtier = sorted((colombo, amsterdam), key=lambda a: a.aqi)
    assert cleaner.score > dirtier.score


@pytest.mark.asyncio
async def test_the_air_quality_score_tracks_the_hour_it_is_asked_about() -> None:
    """The behaviour that made the test above a time bomb, pinned deliberately.

    depart_at genuinely changes this number — which is also why Phase 1.7 had to
    put it in the route cache key.
    """
    start = _recorded_air_series_start(VONDEL)
    early = await fetch_air_quality(VONDEL, start)
    midday = await fetch_air_quality(VONDEL, start + timedelta(hours=12))

    assert early is not None and midday is not None
    assert early.aqi != midday.aqi


@pytest.mark.asyncio
async def test_an_hour_outside_the_forecast_is_none_not_the_nearest_one() -> None:
    """Replay used to serve last year's forecast as a current measurement.

    A recorded fixture holds the forecast for the day it was recorded, and
    indexing it by today's hour returned a real number with provenance
    `recorded` and no degradation attached. Replay is a documented deployment
    mode, so this was a live path, not a hypothetical one.

    The same guard covers a departure past UTC midnight, which used to read
    today's value for that hour — a reading up to 23 hours old presented as the
    air quality for the walk.
    """
    start = _recorded_air_series_start(VONDEL)

    assert await fetch_air_quality(VONDEL, start - timedelta(hours=1)) is None
    assert await fetch_air_quality(VONDEL, start + timedelta(days=400)) is None


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
    """Recorded live from Overpass around Hyde Park.

    Goes through `enrich_context` rather than a single route, because that is
    what the request path does: one query over the union of every route's
    geometry. Querying per route here would need a fixture production never
    asks for.

    **Moved off the Vondelpark scenario**, which is a 60-minute *bike* loop:
    the box covering its three routes is about 8 x 7 km and holds 4,762 amenity
    nodes, and Overpass answers that query with a 504 often enough that the
    fixture could not be re-recorded at all. A 35-minute walk is the shape this
    app is actually for, and it is the shape a hermetic suite should depend on.
    """
    from backend.enrich import enrich_context
    from backend.routing import route_accessible, route_fastest, route_scenic

    routes = [
        (await route_fastest(LONDON, None, 35, "foot")).points,
        (await route_scenic(LONDON, None, 35, "foot")).points,
        (await route_accessible(LONDON, None, 35, "foot")).points,
    ]
    context = await enrich_context(routes)

    assert context.rest_stop_nodes is not None
    assert len(context.rest_stop_nodes) > 0
    assert any(
        (n.get("tags") or {}).get("amenity") == "bench" for n in context.rest_stop_nodes
    )


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


# ---------------------------------------------------------------------------
# barriers
# ---------------------------------------------------------------------------


def _barrier(lat: float, lon: float, value: str = "gate") -> dict:
    return {"lat": lat, "lon": lon, "tags": {"barrier": value}}


def test_a_barrier_becomes_the_single_segment_it_sits_on() -> None:
    """A gate is at a place, not along a stretch, and the span it produces has
    to be the segment a walker is on when they reach it — not widened to the
    step, the neighbourhood, or a radius. A FAIL anywhere blocks the whole
    route, so one over-wide span is a route refused on evidence about somewhere
    else."""
    points = _line(LONDON, 400)
    node = points[3]

    spans = barrier_spans_on_route(points, [_barrier(node.lat, node.lon)])

    # **Changed shape, same claim.** The span now carries the barrier's own
    # lat/lon and its distance along the route, because the Finding built from
    # it used to take its position from the span's *start vertex* — which was
    # the matched vertex under nearest-vertex matching, and is the start of a
    # possibly-long segment under projection. Without these the map pin would
    # have moved off the gate.
    assert len(spans) == 1
    assert spans[0][:3] == (3, 4, "gate")
    assert spans[0][3] == pytest.approx(node.lat)
    assert spans[0][4] == pytest.approx(node.lon)
    assert spans[0][5] == pytest.approx(30.0, abs=0.5)


def test_a_barrier_off_the_route_is_dropped_rather_than_clamped() -> None:
    """~55 m east of the line: evidence about a different path.

    Offset in longitude, not latitude. `_line` runs due north, so nudging the
    latitude walks *along* the route and lands on a later vertex — which is the
    mistake this test caught in its own first draft.
    """
    points = _line(LONDON, 400)
    away = points[3]

    spans = barrier_spans_on_route(points, [_barrier(away.lat, away.lon + 0.0008)])

    assert spans == []


def test_the_barrier_value_reaches_the_engine_unfiltered() -> None:
    """assess_barrier owns which values reject, pass and are unrecognised.
    Filtering here would turn an unrecognised barrier into absence rather than
    UNKNOWN — the one substitution this project must never make."""
    points = _line(LONDON, 400)
    node = points[2]

    spans = barrier_spans_on_route(points, [_barrier(node.lat, node.lon, "cattle_grid")])

    assert [s[:3] for s in spans] == [(2, 3, "cattle_grid")]


def test_a_barrier_mid_segment_is_found_at_all() -> None:
    """**The defect this projection fixes, on geometry that can express it.**

    The corridor test used to compare `BARRIER_CORRIDOR_M` against the distance
    to the nearest *vertex*, while the docstring justifies the number as a
    perpendicular offset. For a point exactly on the line, distance-to-vertex is
    `min(d, s - d)` along its segment — so on a 200 m segment, a gate standing
    precisely on the route, 100 m from either end, is 100 m from the nearest
    vertex and was silently dropped.

    Silently is the word that matters: `barriers_checked` stayed True and the
    confidence sentence widened to "Accessibility data covers 100% of this
    route". A missing datum produced a more confident answer.

    Measured over all 86 committed GraphHopper fixtures, **56.3% of route length
    is more than 10 m from any vertex** (11,331 segments, median 14.8 m, p90
    69.7 m, longest 499.5 m). This test is on a 200 m segment, which is inside
    that distribution.
    """
    points = _sparse_line(LONDON, 400, n=3)
    midpoint = LatLon((points[0].lat + points[1].lat) / 2, points[0].lon)

    spans = barrier_spans_on_route(points, [_barrier(midpoint.lat, midpoint.lon)])

    assert len(spans) == 1, "a gate standing exactly on the route was dropped"
    assert spans[0][:3] == (0, 1, "gate")
    # And it is located where it actually is, not at the vertex 100 m behind it.
    assert spans[0][5] == pytest.approx(100.0, abs=1.0)


def test_the_corridor_is_measured_perpendicular_to_the_line() -> None:
    """The number means what its docstring says: 10 m is the width of a road.

    Two nodes level with the middle of a long segment, one just inside the
    corridor and one just outside. Under nearest-vertex matching both were
    dropped, because both are ~100 m from either end of the segment; the
    distinction the constant exists to make could not be made at all.
    """
    points = _sparse_line(LONDON, 400, n=3)
    mid_lat = (points[0].lat + points[1].lat) / 2
    # Longitude, so the offset is across the line rather than along it.
    deg_per_m_lon = 1.0 / (M_PER_DEG * math.cos(math.radians(LONDON.lat)))

    inside = barrier_spans_on_route(
        points, [_barrier(mid_lat, points[0].lon + 8.0 * deg_per_m_lon)]
    )
    outside = barrier_spans_on_route(
        points, [_barrier(mid_lat, points[0].lon + 12.0 * deg_per_m_lon)]
    )

    assert len(inside) == 1, "8 m from the line is inside a 10 m corridor"
    assert outside == [], "12 m from the line is evidence about a different path"


def test_two_gates_on_one_segment_stay_two_findings() -> None:
    """Deduplication is by identity, not by segment.

    One gate reported twice by Overpass collapses — that was measured on the
    Hyde Park accessible route, which matched (18, 19, "gate") twice. Two
    genuinely different gates on one long segment must not, or the map loses a
    pin and the route loses a reason.
    """
    points = _sparse_line(LONDON, 400, n=3)
    first = LatLon(points[0].lat + 50.0 / M_PER_DEG, points[0].lon)
    second = LatLon(points[0].lat + 150.0 / M_PER_DEG, points[0].lon)

    both = barrier_spans_on_route(
        points, [_barrier(first.lat, first.lon), _barrier(second.lat, second.lon)]
    )
    twice = barrier_spans_on_route(
        points, [_barrier(first.lat, first.lon), _barrier(first.lat, first.lon)]
    )

    assert len(both) == 2
    assert {s[:3] for s in both} == {(0, 1, "gate")}
    assert len(twice) == 1


def test_a_barrier_at_the_very_end_lands_on_the_last_segment() -> None:
    """The final vertex has no segment after it; clamping keeps the span real."""
    points = _line(LONDON, 400)
    last = points[-1]

    spans = barrier_spans_on_route(points, [_barrier(last.lat, last.lon)])

    assert spans and spans[0][1] <= len(points) - 1


def test_a_truncated_overpass_answer_cannot_support_a_claim() -> None:
    """Overpass truncates by element id, which is uncorrelated with position
    along a route — so a full page is a perforated sample of the bbox, not a
    prefix of it. It degrades to the same None an unreachable Overpass gives."""
    full = OverpassNodes([{"lat": 0, "lon": 0}] * OVERPASS_MAX_RESULTS, truncated=True)
    partial = OverpassNodes([{"lat": 0, "lon": 0}], truncated=False)

    assert full.usable is None
    assert partial.usable == [{"lat": 0, "lon": 0}]


def test_the_barrier_query_covers_the_same_bbox_as_the_amenity_one() -> None:
    points = _line(LONDON, 800)
    amenity = overpass_query(points)
    barrier = overpass_barrier_query(points)

    south, west, north, east = _bbox(points)
    box = f"({south:.5f},{west:.5f},{north:.5f},{east:.5f})"
    assert box in amenity and box in barrier
    # Narrowed to the values the engine has a verdict for, and derived from its
    # own constants so the two cannot drift. Asking for every barrier value
    # returned over 2,000 nodes for one bbox — 603 bollards, 310 blocks, 181
    # lift gates — which truncated, and a truncated answer supports no claim at
    # all. Everything excluded assesses to UNKNOWN, which yields no finding and
    # does not enter coverage, so it could not have changed a response.
    for value in BARRIER_VALUES_WITH_A_VERDICT:
        assert value.lower() in barrier
    assert "bollard" not in barrier
