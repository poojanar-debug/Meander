"""Coordinate handling, checked as properties rather than against examples.

The example-based tests in test_geometry.py check the maths against
hand-computable cases — one degree of latitude, a right-angle turn, London to
Paris. Those catch a wrong formula. They do not catch the class of bug that
actually bites geographic code: a transposed pair, an antimeridian wrap, a
pole, a zero-length segment, coordinates that are equal to fifteen decimal
places. Hypothesis generates those without being asked.

Every property here is one that must hold for *any* coordinate the API can
receive. `models.py` bounds latitude to +/-90 and longitude to +/-180, so those
are the bounds generated — a property that only holds for London is not a
property.
"""

from __future__ import annotations

import math
from itertools import pairwise

import pytest
from hypothesis import assume, given, settings
from hypothesis import strategies as st

from backend.geometry import (
    LatLon,
    bearing_deg,
    closes_loop,
    cumulative_distance_m,
    from_lonlat_pairs,
    haversine_m,
    interpolate,
    path_length_m,
    sample_every,
    segment_lengths_m,
    to_lonlat_pairs,
    turn_angles_deg,
)

# The whole globe, because the API accepts the whole globe. Poles and the
# antimeridian are included deliberately: they are where spherical formulas
# stop behaving, and "we only route in three regions" is a fact about today's
# graph rather than about this code.
latitudes = st.floats(min_value=-90, max_value=90, allow_nan=False, allow_infinity=False)
longitudes = st.floats(min_value=-180, max_value=180, allow_nan=False, allow_infinity=False)
coordinates = st.builds(LatLon, latitudes, longitudes)
routes = st.lists(coordinates, min_size=2, max_size=60)

# `derandomize` because this is a build gate. Without it Hypothesis explores a
# different set every run, so the same commit can pass and then fail — which is
# how a property suite gets marked flaky and then deleted. It still explores 250
# examples per property, and shrinks; it just explores the *same* 250. Drop the
# flag locally to go hunting.
SLOW = settings(max_examples=250, deadline=None, derandomize=True)


# --- distance ---------------------------------------------------------------


@given(coordinates, coordinates)
@SLOW
def test_distance_is_symmetric(a: LatLon, b: LatLon) -> None:
    assert haversine_m(a, b) == pytest.approx(haversine_m(b, a), rel=1e-9)


@given(coordinates)
@SLOW
def test_distance_to_itself_is_zero(a: LatLon) -> None:
    """Not "small". Exactly zero — a route whose consecutive points repeat is
    ordinary, and a floating-point residue there accumulates into the length."""
    assert haversine_m(a, a) == 0.0


@given(coordinates, coordinates)
@SLOW
def test_distance_is_never_more_than_half_the_planet(a: LatLon, b: LatLon) -> None:
    """A great-circle distance cannot exceed half the circumference. Exceeding
    it is the signature of a transposed lat/lon pair, which otherwise produces
    a number that looks entirely plausible."""
    assert 0.0 <= haversine_m(a, b) <= math.pi * 6_371_008.8 * 1.000_001


@given(coordinates, coordinates, coordinates)
@SLOW
def test_the_triangle_inequality_holds(a: LatLon, b: LatLon, c: LatLon) -> None:
    direct = haversine_m(a, c)
    detour = haversine_m(a, b) + haversine_m(b, c)
    # A relative tolerance, because at planetary scale an absolute one is
    # meaningless and at zero scale a relative one is.
    assert direct <= detour + 1e-6 * max(1.0, detour)


@given(routes)
@SLOW
def test_path_length_is_the_sum_of_its_segments(points: list[LatLon]) -> None:
    assert path_length_m(points) == pytest.approx(float(segment_lengths_m(points).sum()), rel=1e-9)


@given(routes)
@SLOW
def test_cumulative_distance_never_decreases(points: list[LatLon]) -> None:
    """It is used to place blockers and rest stops along a route. A single
    non-monotonic step puts a barrier at the wrong place on the card."""
    cumulative = cumulative_distance_m(points)
    assert len(cumulative) == len(points)
    assert cumulative[0] == 0.0
    for previous, current in pairwise(cumulative):
        assert current >= previous - 1e-9


# --- the antimeridian, which is where this kind of code goes wrong -----------


@given(latitudes)
@SLOW
def test_the_antimeridian_is_not_a_trip_round_the_world(lat: float) -> None:
    """-179.999 and +179.999 are about 200 m apart, not 40,000 km.

    Naive code subtracts the longitudes and gets 359.998 degrees. Nothing in
    the demo regions crosses the line, which is exactly why this would survive
    every example-based test in the suite and then be wrong in Fiji.
    """
    west = LatLon(lat, -179.999)
    east = LatLon(lat, 179.999)
    # At the equator the true separation is ~222 m; it shrinks towards the
    # poles. Anything above a kilometre means the wrap was not handled.
    assert haversine_m(west, east) < 1_000.0


@given(longitudes, longitudes)
@SLOW
def test_two_points_at_a_pole_are_the_same_place(lon_a: float, lon_b: float) -> None:
    """Every longitude meets at the pole. Distance there must collapse to zero
    however far apart the longitudes look."""
    assert haversine_m(LatLon(90.0, lon_a), LatLon(90.0, lon_b)) < 1e-6
    assert haversine_m(LatLon(-90.0, lon_a), LatLon(-90.0, lon_b)) < 1e-6


# --- bearing ----------------------------------------------------------------


@given(coordinates, coordinates)
@SLOW
def test_bearing_is_always_a_compass_direction(a: LatLon, b: LatLon) -> None:
    """Used by the golden-hour term as `cos(azimuth - heading)`. A bearing
    outside [0, 360) silently rotates that comparison."""
    assert 0.0 <= bearing_deg(a, b) < 360.0


def test_a_bearing_of_exactly_360_is_zero() -> None:
    """The example this property found, kept as its own test.

    `math.degrees(atan2(...))` returns -2.8e-14 for a due-north step across the
    antimeridian, and `-2.8e-14 % 360.0` is 360.0 in float64 rather than 0.0 —
    Python's modulo takes the sign of the divisor, and 360 minus that much is
    not representable. The docstring promised [0, 360) and the function could
    return the endpoint.
    """
    bearing = bearing_deg(LatLon(0.0, 0.0), LatLon(14.0, -180.0))

    assert bearing == 0.0
    assert bearing != 360.0


# --- interpolation and sampling ---------------------------------------------


@given(coordinates, coordinates)
@SLOW
def test_interpolating_to_the_ends_returns_the_ends(a: LatLon, b: LatLon) -> None:
    assert interpolate(a, b, 0.0) == pytest.approx(tuple(a), abs=1e-9)
    assert interpolate(a, b, 1.0) == pytest.approx(tuple(b), abs=1e-9)


@given(routes, st.floats(min_value=10.0, max_value=5_000.0))
@SLOW
def test_sampling_never_leaves_the_route(points: list[LatLon], spacing: float) -> None:
    """Every sample point must be on the polyline. A sample that drifts off it
    is a CLIP score, or a rest-stop query, for somewhere the user is not
    going."""
    samples = sample_every(points, spacing, max_points=200)
    total = path_length_m(points)
    for sample in samples:
        assert -1e-6 <= sample.at_m <= total + 1e-6
        assert -90.0 <= sample.point.lat <= 90.0
        assert -180.0 <= sample.point.lon <= 180.0


@given(routes, st.floats(min_value=10.0, max_value=5_000.0), st.integers(1, 40))
@SLOW
def test_sampling_honours_its_cap(points: list[LatLon], spacing: float, cap: int) -> None:
    """The cap is what bounds a batch run's spend: one Mapillary request plus
    up to four image downloads per point. Exceeding it costs money."""
    assert len(sample_every(points, spacing, max_points=cap)) <= cap


# --- turn angles ------------------------------------------------------------


@given(routes)
@SLOW
def test_turn_angles_are_within_half_a_turn(points: list[LatLon]) -> None:
    """Curviness accumulates these. A value outside [0, 180] means a heading
    difference was not normalised, and it inflates the score of a straight road
    that happens to cross the antimeridian or a pole."""
    for angle in turn_angles_deg(points):
        assert 0.0 <= angle <= 180.0 + 1e-9


# --- the wire format --------------------------------------------------------

# `to_lonlat_pairs` rounds to six decimal places, and that is deliberate rather
# than sloppy — about 0.1 m, far finer than routing needs, and it is what makes
# two people searching the same place produce a byte-identical request body so
# the whole-route cache can actually hit (PROGRESS.md, Phase J, defect 3). The
# first version of this file asserted 1e-12 and failed; the rounding is the
# behaviour, so the tolerance is routing precision.
WIRE_PRECISION = 1e-6


@given(routes)
@SLOW
def test_geojson_round_trip_preserves_every_coordinate(points: list[LatLon]) -> None:
    """GeoJSON is [lon, lat]; everything else in this codebase is (lat, lon).

    That transposition is the single most common bug in geographic code, and it
    fails silently — a route in London renders in the Indian Ocean rather than
    raising. Phase G asserts the same ordering for the Mapillary bounding box,
    for the same reason.
    """
    back = from_lonlat_pairs(to_lonlat_pairs(points))

    assert len(back) == len(points)
    for original, restored in zip(points, back, strict=True):
        assert restored.lat == pytest.approx(original.lat, abs=WIRE_PRECISION)
        assert restored.lon == pytest.approx(original.lon, abs=WIRE_PRECISION)


@given(routes)
@SLOW
def test_geojson_pairs_are_lon_first(points: list[LatLon]) -> None:
    """Stated as its own property rather than left implicit in the round trip:
    a round trip through two consistently-transposed functions also passes."""
    for point, pair in zip(points, to_lonlat_pairs(points), strict=True):
        assert pair[0] == pytest.approx(point.lon, abs=WIRE_PRECISION)
        assert pair[1] == pytest.approx(point.lat, abs=WIRE_PRECISION)


@given(coordinates)
@SLOW
def test_the_wire_never_carries_more_precision_than_routing_needs(point: LatLon) -> None:
    """Six decimal places, not fifteen.

    Not only a cache-key concern. A coordinate at full float precision is far
    more identifying than one at 0.1 m — it is the difference between "a place"
    and "this exact reading from this exact device".
    """
    lon, lat = to_lonlat_pairs([point])[0]
    assert lon == round(lon, 6)
    assert lat == round(lat, 6)


# --- loop closure -----------------------------------------------------------


@given(routes)
@SLOW
def test_a_route_that_returns_to_its_start_closes(points: list[LatLon]) -> None:
    assert closes_loop([*points, points[0]])


@given(coordinates)
@SLOW
def test_a_route_that_ends_far_away_does_not_close(start: LatLon) -> None:
    """A round trip that does not come back is the one result a user cannot
    recover from — they are somewhere else when their time runs out."""
    # 1 degree of latitude is ~111 km, far outside any sane tolerance, and
    # clamped so the far end stays on the planet.
    far = LatLon(start.lat + 1.0 if start.lat < 89.0 else start.lat - 1.0, start.lon)
    assume(haversine_m(start, far) > 10_000.0)

    assert not closes_loop([start, far])
