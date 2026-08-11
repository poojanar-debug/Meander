"""The elevation profile, and the one invariant that matters about it.

**The drawing and the verdict must never disagree.** If the card shades a slope
as steep, the accessibility engine must have rejected on it, and vice versa —
an app that draws a hill as fine while refusing to route over it is
contradicting itself about the single thing it exists to get right.
"""

from __future__ import annotations

import math

from backend.accessibility import MAX_INCLINE_PCT, incline_findings
from backend.elevation import MAX_PROFILE_POINTS, build_profile
from backend.geometry import LatLon


def _line(n: int, spacing_m: float = 10.0) -> list[LatLon]:
    """A straight north-running line with `n` vertices `spacing_m` apart."""
    dlat = spacing_m / 111_320.0
    return [LatLon(51.5 + i * dlat, -0.16) for i in range(n)]


def test_no_elevation_is_none_not_a_flat_line() -> None:
    """"The router gave no elevation" and "this route is flat" are different
    statements, and a flat line drawn for the first makes the second's claim."""
    assert build_profile(_line(40), None) is None
    assert build_profile(_line(40), []) is None


def test_a_mismatched_elevation_array_is_refused() -> None:
    assert build_profile(_line(40), [1.0, 2.0]) is None


def test_a_flat_route_has_no_ascent() -> None:
    profile = build_profile(_line(60), [20.0] * 60)
    assert profile is not None
    assert profile.ascent_m == 0.0
    assert profile.descent_m == 0.0
    assert profile.max_gradient_pct == 0.0
    assert profile.steep_spans == []


def test_a_steady_climb_is_measured() -> None:
    """600 m at a constant 4%: 24 m of ascent, no descent, nothing steep."""
    points = _line(61)
    elevations = [i * 0.4 for i in range(61)]  # 0.4 m per 10 m = 4%
    profile = build_profile(points, elevations)

    assert profile is not None
    assert math.isclose(profile.ascent_m, 24.0, abs_tol=1.0)
    assert profile.descent_m == 0.0
    assert math.isclose(profile.max_gradient_pct, 4.0, abs_tol=0.5)
    assert profile.steep_spans == []


def test_ascent_and_descent_are_counted_separately() -> None:
    points = _line(81)
    up = [i * 0.2 for i in range(41)]
    down = [up[-1] - i * 0.2 for i in range(1, 41)]
    profile = build_profile(points, up + down)

    assert profile is not None
    assert profile.ascent_m > 5.0
    assert profile.descent_m > 5.0
    assert math.isclose(profile.ascent_m, profile.descent_m, abs_tol=1.0)


def test_sensor_noise_does_not_become_a_climb() -> None:
    """The reason the profile is resampled rather than summed vertex to vertex.

    A 10 m segment carrying 0.3 m of jitter reads as a 3% gradient that is not
    there, and summing those deltas accumulates hundreds of metres of climb
    nobody walked.
    """
    points = _line(200)
    noisy = [20.0 + (0.3 if i % 2 else -0.3) for i in range(200)]

    raw_sum = sum(max(0.0, noisy[i + 1] - noisy[i]) for i in range(len(noisy) - 1))
    profile = build_profile(points, noisy)

    assert profile is not None
    assert raw_sum > 25.0, "the naive sum should indeed be large"
    assert profile.ascent_m < 2.0, f"resampling should absorb the jitter, got {profile.ascent_m}"


# ---------------------------------------------------------------------------
# the invariant
# ---------------------------------------------------------------------------


def test_a_steep_span_is_drawn_exactly_when_the_engine_rejects_it() -> None:
    """The profile and the accessibility verdict come from the same numbers."""
    points = _line(81)
    # A 12% ramp in the middle: well over the 8% limit.
    elevations = [0.0] * 30 + [i * 1.2 for i in range(21)] + [24.0] * 30

    profile = build_profile(points, elevations)
    findings = incline_findings(points, elevations)

    assert profile is not None
    assert profile.steep_spans, "the profile should mark the ramp"
    assert profile.max_gradient_pct > MAX_INCLINE_PCT
    assert any(f.type == "incline" for f in findings), (
        "the engine must reject what the profile draws as steep"
    )


def test_nothing_is_drawn_steep_when_the_engine_is_content() -> None:
    """The other direction, which is the one that would mislead."""
    points = _line(81)
    elevations = [i * 0.6 for i in range(81)]  # a steady 6%: under the limit

    profile = build_profile(points, elevations)
    findings = incline_findings(points, elevations)

    assert profile is not None
    assert profile.steep_spans == []
    assert not any(f.type == "incline" and "steeper than" in f.description for f in findings)


def test_the_limit_travels_with_the_profile() -> None:
    """So the UI cannot restate 8% and drift from the engine."""
    profile = build_profile(_line(60), [i * 0.1 for i in range(60)])
    assert profile is not None
    assert profile.limit_pct == MAX_INCLINE_PCT


# ---------------------------------------------------------------------------
# payload size
# ---------------------------------------------------------------------------


def test_a_long_route_is_thinned_for_the_wire() -> None:
    points = _line(4000)
    profile = build_profile(points, [i * 0.01 for i in range(4000)])

    assert profile is not None
    assert len(profile.distances_m) <= MAX_PROFILE_POINTS
    assert len(profile.distances_m) == len(profile.elevations_m)


def test_thinning_keeps_the_ends() -> None:
    points = _line(4000)
    profile = build_profile(points, [i * 0.01 for i in range(4000)])
    assert profile is not None
    assert profile.distances_m[0] == 0.0
    # The last sample should be near the end of the route, not lopped off.
    assert profile.distances_m[-1] > 39_000 * 0.9


def test_steep_spans_stay_inside_the_thinned_arrays() -> None:
    """Thinning moves the indices; a span pointing past the end would either
    crash the drawing code or silently shade nothing."""
    points = _line(4000)
    elevations = [0.0] * 2000 + [i * 1.5 for i in range(2000)]
    profile = build_profile(points, elevations)

    assert profile is not None
    assert profile.steep_spans
    n = len(profile.distances_m)
    for start, end in profile.steep_spans:
        assert 0 <= start < end <= n, f"span [{start}, {end}) escapes an array of {n}"


def test_the_shaded_band_stops_where_the_ramp_stops() -> None:
    """One sample too many was shaded, every time, on any route under ~2.4 km.

    `steep` already holds half-open *grid* spans — gradient j lies between
    grid[j] and grid[j+1], so a run ending at gradient i-1 reaches grid point i
    and the exclusive end is i+1. The rescaling step then added a second +1.

    Measured before the fix on exactly this route: `steep_spans == [[15, 27]]`
    with `distances_m[26] == 520.0`, so the band ran 300→520 m while the
    gradient over that last 20 m is 0.0%. This module's whole premise is that
    the drawing and the verdict cannot disagree, and shading flat ground steep
    is that disagreement.
    """
    points = _line(81, spacing_m=10.0)
    # 12% from 300 m to 500 m; dead flat either side.
    elevations = [0.0] * 30 + [i * 1.2 for i in range(21)] + [24.0] * 30

    profile = build_profile(points, elevations)

    assert profile is not None
    assert profile.steep_spans == [[15, 26]]
    start, end = profile.steep_spans[0]
    assert profile.distances_m[start] == 300.0
    assert profile.distances_m[end - 1] == 500.0


def test_a_thinned_span_never_collapses_to_nothing() -> None:
    """Rounding both ends onto one sample would draw nothing at all, dropping a
    steep stretch from a long route rather than marking it."""
    # Long enough that thinning is active, with a short ramp.
    n = MAX_PROFILE_POINTS * 6
    elevations = [0.0] * n
    for i in range(100, 104):
        elevations[i] = (i - 99) * 2.0
    for i in range(104, n):
        elevations[i] = 8.0

    profile = build_profile(_line(n), elevations)

    assert profile is not None
    for start, end in profile.steep_spans:
        assert end > start, "a span with no width draws nothing"
