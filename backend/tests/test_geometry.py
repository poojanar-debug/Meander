"""Geometry maths.

This is one of the three places a silent bug produces a plausible-looking wrong
answer, so the tests here check the maths against hand-computable cases rather
than against whatever the code currently returns.
"""

from __future__ import annotations

import math

import numpy as np
import pytest

from backend.geometry import (
    CURVINESS_SATURATION_DEG_PER_100M,
    EARTH_RADIUS_M,
    ELEVATION_SATURATION_M,
    LatLon,
    bearing_deg,
    closes_loop,
    cumulative_distance_m,
    curviness,
    elevation_variance,
    from_lonlat_pairs,
    haversine_m,
    interpolate,
    path_length_m,
    sample_every,
    score_geometry,
    segment_lengths_m,
    to_lonlat_pairs,
    turn_angles_deg,
    weighted_tag_score,
)

LONDON = LatLon(51.5073, -0.1657)
COLOMBO = LatLon(6.9344, 79.8428)

# Metres per degree of latitude on the same sphere geometry.py measures with.
# Using the usual 111_320 shorthand here would make every helper 0.1% off and
# turn exact assertions into approximate ones for no reason.
M_PER_DEG = math.pi * EARTH_RADIUS_M / 180.0


def _straight_line(start: LatLon, metres: float, n: int = 40, bearing: float = 0.0
                   ) -> list[LatLon]:
    """n points running `metres` from `start`. Due north when bearing is 0."""
    rad = math.radians(bearing)
    out = []
    for i in range(n):
        d = metres * i / (n - 1)
        dlat = d * math.cos(rad) / M_PER_DEG
        dlon = d * math.sin(rad) / (M_PER_DEG * math.cos(math.radians(start.lat)))
        out.append(LatLon(start.lat + dlat, start.lon + dlon))
    return out


def _zigzag(start: LatLon, metres: float, n: int = 41, amplitude_m: float = 30.0
            ) -> list[LatLon]:
    out = []
    for i in range(n):
        d = metres * i / (n - 1)
        across = amplitude_m * (1 if i % 2 else -1)
        out.append(
            LatLon(
                start.lat + d / M_PER_DEG,
                start.lon + across / (M_PER_DEG * math.cos(math.radians(start.lat))),
            )
        )
    return out


# --- distance --------------------------------------------------------------


def test_haversine_matches_a_known_distance() -> None:
    """London to Paris is about 344 km."""
    paris = LatLon(48.8566, 2.3522)
    london = LatLon(51.5074, -0.1278)
    assert haversine_m(london, paris) == pytest.approx(343_500, rel=0.01)


def test_haversine_is_symmetric() -> None:
    assert haversine_m(LONDON, COLOMBO) == pytest.approx(haversine_m(COLOMBO, LONDON))


def test_haversine_of_a_point_with_itself_is_zero() -> None:
    assert haversine_m(LONDON, LONDON) == pytest.approx(0.0, abs=1e-6)


def test_one_degree_of_latitude_is_about_111_km() -> None:
    assert haversine_m(LatLon(0, 0), LatLon(1, 0)) == pytest.approx(111_195, rel=0.001)


def test_segment_lengths_sum_to_path_length() -> None:
    points = _straight_line(LONDON, 1000)
    assert segment_lengths_m(points).sum() == pytest.approx(path_length_m(points))


def test_path_length_of_a_straight_line_is_its_length() -> None:
    assert path_length_m(_straight_line(LONDON, 2000)) == pytest.approx(2000, rel=0.001)


def test_segment_lengths_of_a_single_point_is_empty() -> None:
    assert len(segment_lengths_m([LONDON])) == 0
    assert path_length_m([LONDON]) == 0.0


def test_cumulative_distance_starts_at_zero_and_ends_at_total() -> None:
    points = _straight_line(LONDON, 800)
    cum = cumulative_distance_m(points)
    assert cum[0] == 0.0
    assert cum[-1] == pytest.approx(path_length_m(points))
    assert np.all(np.diff(cum) >= 0)


# --- bearing and interpolation --------------------------------------------


@pytest.mark.parametrize(
    "target,expected",
    [(LatLon(52.5073, -0.1657), 0.0), (LatLon(50.5073, -0.1657), 180.0)],
)
def test_bearing_north_and_south(target: LatLon, expected: float) -> None:
    assert bearing_deg(LONDON, target) == pytest.approx(expected, abs=0.5)


def test_bearing_east_is_ninety() -> None:
    assert bearing_deg(LatLon(0, 0), LatLon(0, 1)) == pytest.approx(90.0, abs=0.5)


def test_bearing_is_always_in_range() -> None:
    for target in (LatLon(50, -1), LatLon(52, 1), LatLon(51, -5)):
        assert 0 <= bearing_deg(LONDON, target) < 360


def test_interpolate_midpoint() -> None:
    mid = interpolate(LatLon(0, 0), LatLon(2, 4), 0.5)
    assert mid == LatLon(1.0, 2.0)


# --- sampling --------------------------------------------------------------


def test_sample_every_spaces_points_along_the_route() -> None:
    points = _straight_line(LONDON, 1000)
    samples = sample_every(points, 200)

    assert samples[0].at_m == pytest.approx(0.0)
    assert samples[-1].at_m == pytest.approx(1000, rel=0.01)
    gaps = np.diff([s.at_m for s in samples[:-1]])
    assert np.allclose(gaps, 200, rtol=0.02)


def test_sample_every_respects_the_hard_point_cap() -> None:
    """Each sample becomes a Mapillary request; an unbounded count drains the budget."""
    points = _straight_line(LONDON, 200_000, n=500)
    assert len(sample_every(points, 10, max_points=50)) <= 50


def test_sample_every_handles_a_degenerate_route() -> None:
    assert sample_every([LONDON], 100) == [(LONDON, 0.0)]
    assert sample_every([], 100) == []


# --- curviness -------------------------------------------------------------


def test_turn_angles_of_a_straight_line_are_zero() -> None:
    assert np.allclose(turn_angles_deg(_straight_line(LONDON, 1000)), 0.0, atol=0.2)


def test_turn_angle_of_a_right_angle_is_ninety() -> None:
    corner = [LatLon(0, 0), LatLon(0.01, 0), LatLon(0.01, 0.01)]
    assert turn_angles_deg(corner)[0] == pytest.approx(90.0, abs=1.0)


def test_turn_angles_never_exceed_180() -> None:
    angles = turn_angles_deg(_zigzag(LONDON, 500))
    assert np.all(angles <= 180.0) and np.all(angles >= 0.0)


def test_a_straight_road_is_not_curvy() -> None:
    assert curviness(_straight_line(LONDON, 2000)) < 0.05


def test_a_zigzag_is_curvier_than_a_straight_line() -> None:
    assert curviness(_zigzag(LONDON, 1000)) > curviness(_straight_line(LONDON, 1000)) + 0.5


def test_curviness_is_bounded_to_the_unit_interval() -> None:
    assert 0.0 <= curviness(_zigzag(LONDON, 400, n=201, amplitude_m=60)) <= 1.0


def test_curviness_is_length_normalised() -> None:
    """A long straight road and a short one are equally uncurvy."""
    short = curviness(_straight_line(LONDON, 300))
    long = curviness(_straight_line(LONDON, 6000))
    assert abs(short - long) < 0.05


def test_curviness_of_a_too_short_route_is_zero_not_noise() -> None:
    assert curviness(_straight_line(LONDON, 20, n=5)) == 0.0


def test_curviness_saturation_constant_is_reachable() -> None:
    """A route turning at exactly the saturation rate scores 1.0."""
    points = [LatLon(0, 0), LatLon(0.001, 0), LatLon(0.002, 0.001)]
    total_turn = float(turn_angles_deg(points).sum())
    per_100m = total_turn / (path_length_m(points) / 100)
    expected = min(1.0, per_100m / CURVINESS_SATURATION_DEG_PER_100M)
    assert curviness(points) == pytest.approx(expected, abs=1e-6)


# --- elevation -------------------------------------------------------------


def test_flat_ground_has_no_elevation_variance() -> None:
    assert elevation_variance([12.0] * 40) == pytest.approx(0.0)


def test_hills_have_elevation_variance() -> None:
    hilly = [10 + 30 * math.sin(i / 5) for i in range(60)]
    assert elevation_variance(hilly) > 0.8


def test_missing_elevation_is_none_not_zero() -> None:
    """No data is a different thing from flat ground, and must not read as flat."""
    assert elevation_variance([]) is None
    assert elevation_variance(None) is None
    assert elevation_variance([1.0, 2.0]) is None


def test_non_finite_elevation_is_rejected() -> None:
    assert elevation_variance([1.0, float("nan"), 3.0, 4.0]) is None


def test_elevation_variance_is_bounded() -> None:
    extreme = [0, 1000] * 30
    assert elevation_variance(extreme) == 1.0


def test_elevation_saturation_constant_is_applied() -> None:
    values = [0.0, ELEVATION_SATURATION_M * 2] * 20
    assert elevation_variance(values) == pytest.approx(1.0)


# --- tag scoring -----------------------------------------------------------


def test_weighted_tag_score_is_length_weighted_not_span_weighted() -> None:
    """One long primary span must outweigh one short path span."""
    points = _straight_line(LONDON, 1000, n=101)
    spans = [(0, 90, "PRIMARY"), (90, 100, "PATH")]
    result = weighted_tag_score(points, spans, {"PRIMARY": 0.0, "PATH": 1.0})

    assert result.score == pytest.approx(0.1, abs=0.02)
    assert result.coverage == pytest.approx(1.0, abs=0.02)


def test_untagged_spans_lower_coverage_but_never_move_the_score() -> None:
    """An absent tag must not be able to raise or lower a score."""
    points = _straight_line(LONDON, 1000, n=101)
    tagged_only = weighted_tag_score(points, [(0, 50, "PATH")], {"PATH": 1.0})
    with_unknown = weighted_tag_score(
        points, [(0, 50, "PATH"), (50, 100, "MISSING")], {"PATH": 1.0}
    )

    assert with_unknown.score == tagged_only.score == 1.0
    assert with_unknown.coverage == pytest.approx(0.5, abs=0.02)


def test_a_value_absent_from_the_table_is_treated_as_unknown() -> None:
    points = _straight_line(LONDON, 500, n=51)
    result = weighted_tag_score(points, [(0, 50, "SOMETHING_NEW")], {"PATH": 1.0})

    assert result.score is None
    assert result.coverage == 0.0


def test_tag_values_are_case_insensitive() -> None:
    points = _straight_line(LONDON, 500, n=51)
    assert weighted_tag_score(points, [(0, 50, "path")], {"PATH": 1.0}).score == 1.0


def test_no_spans_at_all_gives_no_score() -> None:
    points = _straight_line(LONDON, 500, n=51)
    assert weighted_tag_score(points, None, {"PATH": 1.0}) == (None, 0.0)


def test_out_of_range_span_indices_do_not_raise() -> None:
    points = _straight_line(LONDON, 500, n=51)
    result = weighted_tag_score(points, [(0, 9999, "PATH")], {"PATH": 1.0})
    assert result.score == 1.0


# --- whole-route scoring ---------------------------------------------------


def _park_route() -> tuple[list[LatLon], list[float], dict]:
    points = _zigzag(COLOMBO, 1200, n=61, amplitude_m=25)
    elevations = [12 + 25 * math.sin(i / 8) for i in range(len(points))]
    details = {
        "road_class": [(0, 30, "PATH"), (30, 60, "FOOTWAY")],
        "surface": [(0, 30, "GROUND"), (30, 60, "COMPACTED")],
    }
    return points, elevations, details


def _arterial_route() -> tuple[list[LatLon], list[float], dict]:
    points = _straight_line(COLOMBO, 1200, n=61)
    elevations = [12.0 + 0.2 * (i % 3) for i in range(len(points))]
    details = {
        "road_class": [(0, 40, "PRIMARY"), (40, 60, "SECONDARY")],
        "surface": [(0, 60, "ASPHALT")],
    }
    return points, elevations, details


def test_a_park_route_scores_above_an_arterial_route() -> None:
    """The whole point of the scenic score. If this inverts, the feature is a lie."""
    park = score_geometry(*_park_route())
    arterial = score_geometry(*_arterial_route())

    assert park.scenic > arterial.scenic
    assert park.scenic - arterial.scenic > 0.3


def test_the_park_route_beats_the_arterial_on_every_component() -> None:
    park = score_geometry(*_park_route())
    arterial = score_geometry(*_arterial_route())

    assert park.naturalness > arterial.naturalness
    assert park.curviness > arterial.curviness
    assert park.elevation_variance > arterial.elevation_variance


def test_air_proxy_ranks_a_footpath_above_a_motorway() -> None:
    points = _straight_line(COLOMBO, 1000, n=51)
    footpath = score_geometry(points, None, {"road_class": [(0, 50, "PATH")]})
    motorway = score_geometry(points, None, {"road_class": [(0, 50, "MOTORWAY")]})

    assert footpath.air == 1.0
    assert motorway.air == 0.0


def test_scores_stay_in_the_unit_interval() -> None:
    for builder in (_park_route, _arterial_route):
        scores = score_geometry(*builder())
        assert 0.0 <= scores.scenic <= 1.0
        assert 0.0 <= scores.curviness <= 1.0
        assert scores.air is None or 0.0 <= scores.air <= 1.0


def test_missing_elevation_does_not_drag_the_scenic_score_down() -> None:
    """Weights are renormalised, not just dropped — otherwise a router that
    returns no elevation would make every route in that region look worse."""
    points, _, details = _park_route()
    with_elevation = score_geometry(*_park_route())
    without = score_geometry(points, None, details)

    assert without.elevation_variance is None
    assert without.scenic > 0.5
    assert abs(without.scenic - with_elevation.scenic) < 0.25


def test_no_tags_at_all_still_produces_a_score_from_shape() -> None:
    points = _zigzag(COLOMBO, 1000)
    scores = score_geometry(points, None, {})

    assert scores.naturalness is None
    assert scores.tag_coverage == 0.0
    assert scores.scenic == pytest.approx(scores.curviness)


def test_clip_term_dominates_when_present() -> None:
    points, elevations, details = _arterial_route()
    without = score_geometry(points, elevations, details)
    with_clip = score_geometry(points, elevations, details, clip_score=1.0)

    assert with_clip.scenic > without.scenic + 0.3


def test_tag_coverage_is_reported() -> None:
    points = _straight_line(COLOMBO, 1000, n=101)
    details = {"road_class": [(0, 50, "PATH"), (50, 100, "MISSING")]}
    assert score_geometry(points, None, details).tag_coverage == pytest.approx(0.5, abs=0.02)


# --- wire conversion -------------------------------------------------------


def test_to_lonlat_pairs_puts_longitude_first() -> None:
    assert to_lonlat_pairs([COLOMBO])[0] == [79.8428, 6.9344]


def test_lonlat_round_trip() -> None:
    assert from_lonlat_pairs(to_lonlat_pairs([LONDON, COLOMBO])) == [LONDON, COLOMBO]


def test_closes_loop_detects_a_returning_route() -> None:
    out = _straight_line(COLOMBO, 500)
    assert closes_loop([*out, *reversed(out)])
    assert not closes_loop(out)
