"""The elevation profile, for drawing.

GraphHopper already returns a third ordinate on every coordinate when
``elevation: true``, and ``RawRoute.has_elevation`` has always known whether it
did. Nothing has ever done anything with it except ``incline_findings``, which
reduces the whole profile to at most two sentences.

This puts the shape itself on the wire so the card can draw it — and, for the
accessible preset, so it can mark the stretches that break the same 8% limit
``accessibility.py`` rejects on. **The two must never disagree**, which is why
every constant here is imported from there rather than restated: a profile that
drew a slope as fine while the engine rejected the route for it would be the
app contradicting itself about the one thing it exists to get right.

Resampled, not raw. Routers emit vertices at irregular intervals, and a 2 m
segment carrying 0.3 m of sensor noise reads as a 15% gradient that is not
there — the same reason ``incline_findings`` resamples before measuring.
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass, field

import numpy as np

from .accessibility import (
    INCLINE_SMOOTHING_WINDOW_M,
    MAX_INCLINE_PCT,
    _resample_elevation,
)
from .geometry import LatLon

# Enough to draw a recognisable profile on a phone, few enough not to bloat
# every route in the payload. A 390 px sparkline cannot resolve more.
MAX_PROFILE_POINTS = 120


@dataclass
class ElevationProfile:
    """A drawable profile, plus the two numbers people actually quote."""

    distances_m: list[float] = field(default_factory=list)
    elevations_m: list[float] = field(default_factory=list)
    ascent_m: float = 0.0
    descent_m: float = 0.0
    max_gradient_pct: float = 0.0
    # Index pairs [start, end) into the arrays above, for stretches steeper than
    # `limit_pct`. Index pairs rather than distances so the drawing code cannot
    # get the correspondence wrong.
    steep_spans: list[list[int]] = field(default_factory=list)
    limit_pct: float = MAX_INCLINE_PCT


def _thin(values: np.ndarray, target: int) -> np.ndarray:
    """Evenly sample down to `target`, always keeping the first and last."""
    if len(values) <= target:
        return values
    idx = np.linspace(0, len(values) - 1, target).round().astype(int)
    return values[idx]


def build_profile(
    points: Sequence[LatLon], elevations: Sequence[float] | None
) -> ElevationProfile | None:
    """The profile for a route, or None when there is no elevation to draw.

    None rather than an empty profile: "the router did not return elevation" and
    "this route is flat" are different statements, and a flat line drawn for the
    first would be the second's claim.
    """
    if not elevations or len(elevations) != len(points) or len(points) < 3:
        return None

    grid, profile = _resample_elevation(points, elevations, INCLINE_SMOOTHING_WINDOW_M)
    if len(grid) < 3:
        return None

    # Ascent and descent are measured on the *resampled* profile for the same
    # reason the gradients are: summing raw vertex-to-vertex deltas accumulates
    # sensor noise into hundreds of metres of climb that nobody walked.
    deltas = np.diff(profile)
    ascent = float(deltas[deltas > 0].sum())
    descent = float(-deltas[deltas < 0].sum())

    gradients = deltas / INCLINE_SMOOTHING_WINDOW_M * 100.0
    max_gradient = float(np.abs(gradients).max()) if len(gradients) else 0.0

    # Contiguous runs over the limit, collapsed into spans. One 25 m stretch is
    # one thing to mark, not two adjacent samples to mark twice.
    steep: list[list[int]] = []
    over = np.abs(gradients) > MAX_INCLINE_PCT
    start: int | None = None
    for i, flag in enumerate(over):
        if flag and start is None:
            start = i
        elif not flag and start is not None:
            steep.append([start, i + 1])
            start = None
    if start is not None:
        steep.append([start, len(over) + 1])

    thin_grid = _thin(grid, MAX_PROFILE_POINTS)
    thin_profile = _thin(profile, MAX_PROFILE_POINTS)

    # Thinning moves the indices, so the spans are re-expressed against the
    # thinned arrays rather than left pointing into the full-resolution ones.
    #
    # No `+ 1` on the end index. `steep` already holds half-open *grid* spans:
    # gradient j lies between grid[j] and grid[j+1], so a run ending at gradient
    # i-1 reaches grid point i, and the loop above appends i + 1 as the exclusive
    # end. Adding another one here shaded one extra sample beyond the ramp.
    #
    # Measured on an 800 m route with a 12% ramp from 300 m to 500 m: the span
    # came back [15, 27] while distances_m[26] is 520.0, so the drawn band ran
    # 300→520 m and the gradient over that last 20 m is 0.0%. Below ~2.4 km the
    # scale is exactly 1.0, so it was a whole extra sample every time — and this
    # module's stated invariant is that the drawing and the verdict never
    # disagree.
    scale = (len(thin_grid) - 1) / max(1, len(grid) - 1)
    scaled: list[list[int]] = []
    for a, b in steep:
        lo = max(0, min(len(thin_grid) - 1, int(round(a * scale))))
        hi = max(0, min(len(thin_grid), int(round(b * scale))))
        # Thinning can round both ends onto the same sample. A zero-width span
        # draws nothing, which would silently drop a steep stretch from a long
        # route rather than mark it, so it keeps the one sample it has.
        scaled.append([lo, max(hi, lo + 1)])

    return ElevationProfile(
        distances_m=[round(float(d), 1) for d in thin_grid],
        elevations_m=[round(float(e), 1) for e in thin_profile],
        ascent_m=round(ascent, 1),
        descent_m=round(descent, 1),
        max_gradient_pct=round(max_gradient, 1),
        steep_spans=scaled,
        limit_pct=MAX_INCLINE_PCT,
    )
