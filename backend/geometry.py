"""Geometric primitives and geometry-only scenery scoring.

**numpy only.** Nothing in this module may import torch, directly or
transitively — it is the scoring path that runs on the 512 MB deployment where
torch does not exist.

Coordinates are ``LatLon`` throughout. The GeoJSON ``[lon, lat]`` ordering used
on the wire is converted at exactly one boundary, in routing.py.
"""

from __future__ import annotations

import math
from collections.abc import Iterable, Sequence
from typing import NamedTuple

import numpy as np

EARTH_RADIUS_M = 6_371_008.8


class LatLon(NamedTuple):
    """A coordinate in (latitude, longitude) order.

    A NamedTuple rather than a bare tuple so that ``p.lat`` is unambiguous at
    every call site. Swapping lat and lon is the single most expensive mistake
    available in this codebase and it fails silently.
    """

    lat: float
    lon: float


def haversine_m(a: LatLon, b: LatLon) -> float:
    """Great-circle distance in metres."""
    lat1, lon1, lat2, lon2 = map(math.radians, (a.lat, a.lon, b.lat, b.lon))
    dlat = lat2 - lat1
    dlon = lon2 - lon1
    h = math.sin(dlat / 2) ** 2 + math.cos(lat1) * math.cos(lat2) * math.sin(dlon / 2) ** 2
    return 2 * EARTH_RADIUS_M * math.asin(math.sqrt(min(1.0, h)))


def _to_array(points: Sequence[LatLon]) -> np.ndarray:
    return np.asarray([(p.lat, p.lon) for p in points], dtype=float)


def segment_lengths_m(points: Sequence[LatLon]) -> np.ndarray:
    """Length of each consecutive pair. Length n-1 for n points."""
    if len(points) < 2:
        return np.zeros(0, dtype=float)
    arr = np.radians(_to_array(points))
    lat1, lon1 = arr[:-1, 0], arr[:-1, 1]
    lat2, lon2 = arr[1:, 0], arr[1:, 1]
    dlat = lat2 - lat1
    dlon = lon2 - lon1
    h = np.sin(dlat / 2) ** 2 + np.cos(lat1) * np.cos(lat2) * np.sin(dlon / 2) ** 2
    return 2 * EARTH_RADIUS_M * np.arcsin(np.sqrt(np.minimum(1.0, h)))


def path_length_m(points: Sequence[LatLon]) -> float:
    return float(segment_lengths_m(points).sum())


def cumulative_distance_m(points: Sequence[LatLon]) -> np.ndarray:
    """Distance from the start to each point. Length n, starting at 0."""
    if not points:
        return np.zeros(0, dtype=float)
    return np.concatenate([[0.0], np.cumsum(segment_lengths_m(points))])


def bearing_deg(a: LatLon, b: LatLon) -> float:
    """Initial bearing from a to b, degrees clockwise from north, in [0, 360)."""
    lat1, lat2 = math.radians(a.lat), math.radians(b.lat)
    dlon = math.radians(b.lon - a.lon)
    y = math.sin(dlon) * math.cos(lat2)
    x = math.cos(lat1) * math.sin(lat2) - math.sin(lat1) * math.cos(lat2) * math.cos(dlon)
    return math.degrees(math.atan2(y, x)) % 360.0


def interpolate(a: LatLon, b: LatLon, t: float) -> LatLon:
    """Linear interpolation. Adequate at the sub-kilometre scale used here."""
    return LatLon(a.lat + (b.lat - a.lat) * t, a.lon + (b.lon - a.lon) * t)


class SamplePoint(NamedTuple):
    point: LatLon
    at_m: float


def sample_every(points: Sequence[LatLon], spacing_m: float, max_points: int = 200
                 ) -> list[SamplePoint]:
    """Points at a fixed spacing along the polyline, plus the final point.

    ``max_points`` is a hard stop: each sample becomes one Mapillary bounding-box
    request, and a 360-minute car route would otherwise issue thousands.
    """
    if not points:
        return []
    if len(points) == 1:
        return [SamplePoint(points[0], 0.0)]

    cum = cumulative_distance_m(points)
    total = float(cum[-1])
    if total <= 0:
        return [SamplePoint(points[0], 0.0)]

    spacing = max(spacing_m, total / max(1, max_points - 1))
    targets = np.arange(0.0, total, spacing)

    out: list[SamplePoint] = []
    idx = 0
    for target in targets:
        while idx < len(cum) - 2 and cum[idx + 1] < target:
            idx += 1
        span = cum[idx + 1] - cum[idx]
        t = 0.0 if span <= 0 else (target - cum[idx]) / span
        out.append(SamplePoint(interpolate(points[idx], points[idx + 1], float(t)), float(target)))

    out.append(SamplePoint(points[-1], total))
    return out[:max_points]


def turn_angles_deg(points: Sequence[LatLon]) -> np.ndarray:
    """Absolute heading change at each interior vertex, in degrees [0, 180]."""
    if len(points) < 3:
        return np.zeros(0, dtype=float)
    bearings = np.array(
        [bearing_deg(points[i], points[i + 1]) for i in range(len(points) - 1)], dtype=float
    )
    delta = np.abs(np.diff(bearings))
    return np.minimum(delta, 360.0 - delta)


def closes_loop(points: Sequence[LatLon], tolerance_m: float = 120.0) -> bool:
    """True when the last point is back within ``tolerance_m`` of the first."""
    if len(points) < 2:
        return False
    return haversine_m(points[0], points[-1]) <= tolerance_m


def to_lonlat_pairs(points: Iterable[LatLon]) -> list[list[float]]:
    """GeoJSON ordering for the wire. The one place lat/lon order flips outbound."""
    return [[round(p.lon, 6), round(p.lat, 6)] for p in points]


def from_lonlat_pairs(pairs: Iterable[Sequence[float]]) -> list[LatLon]:
    """GeoJSON ordering off the wire. The one place lat/lon order flips inbound."""
    return [LatLon(float(pair[1]), float(pair[0])) for pair in pairs]


# ---------------------------------------------------------------------------
# geometry-only scenery scoring
# ---------------------------------------------------------------------------
#
# This is the fallback that runs everywhere CLIP has not been pre-warmed, which
# on the deployed instance is most of the world. It uses only the route's shape,
# its elevation profile, and the OSM tags GraphHopper returns as path details.
#
# The spec's full weighting is
#
#     segment_nature = 0.45*clip + 0.20*naturalness + 0.20*curviness + 0.15*elev_variance
#
# With no CLIP term the remaining three are renormalised to sum to 1, rather
# than scoring out of 0.55 and making every geometry-only route look worse than
# a CLIP-scored one for a reason that has nothing to do with the place.

WEIGHT_CLIP = 0.45
WEIGHT_NATURALNESS = 0.20
WEIGHT_CURVINESS = 0.20
WEIGHT_ELEVATION = 0.15

# Degrees of accumulated heading change per 100 m at which curviness reads 1.0.
# A straight arterial runs at roughly 3-8; a winding park path at 40 or more.
CURVINESS_SATURATION_DEG_PER_100M = 45.0

# Metres of elevation standard deviation at which elevation variance reads 1.0.
ELEVATION_SATURATION_M = 15.0

# Routes shorter than this are too short for shape statistics to mean anything.
MIN_SCORABLE_LENGTH_M = 50.0

# How natural each OSM road class feels underfoot. Values are judgements, not
# measurements, and they are the reason geometry-only scoring is labelled as
# such in every response.
ROAD_CLASS_NATURALNESS: dict[str, float] = {
    "PATH": 1.00,
    "TRACK": 0.95,
    "BRIDLEWAY": 0.95,
    "FOOTWAY": 0.75,
    "CYCLEWAY": 0.70,
    "PEDESTRIAN": 0.60,
    "STEPS": 0.60,
    "LIVING_STREET": 0.55,
    "RESIDENTIAL": 0.40,
    "SERVICE": 0.35,
    "UNCLASSIFIED": 0.35,
    "ROAD": 0.30,
    "TERTIARY": 0.25,
    "SECONDARY": 0.15,
    "PRIMARY": 0.08,
    "TRUNK": 0.02,
    "MOTORWAY": 0.00,
}

SURFACE_NATURALNESS: dict[str, float] = {
    "GROUND": 1.00,
    "DIRT": 1.00,
    "EARTH": 1.00,
    "GRASS": 1.00,
    "SAND": 0.90,
    "WOOD": 0.90,
    "FINE_GRAVEL": 0.80,
    "GRAVEL": 0.75,
    "COMPACTED": 0.70,
    "COBBLESTONE": 0.45,
    "PAVING_STONES": 0.40,
    "UNPAVED": 0.80,
    "CONCRETE": 0.20,
    "ASPHALT": 0.15,
    "PAVED": 0.20,
}

# Proximity to motor traffic is the dominant term in street-level air quality,
# and road class is the only proxy for it available without a sensor. This is a
# proxy and is reported as one — real measurements arrive from Open-Meteo's air
# quality API in enrich.py.
ROAD_CLASS_AIR_PROXY: dict[str, float] = {
    "MOTORWAY": 0.00,
    "TRUNK": 0.05,
    "PRIMARY": 0.15,
    "SECONDARY": 0.30,
    "TERTIARY": 0.45,
    "ROAD": 0.55,
    "SERVICE": 0.60,
    "UNCLASSIFIED": 0.60,
    "RESIDENTIAL": 0.65,
    "LIVING_STREET": 0.75,
    "PEDESTRIAN": 0.85,
    "CYCLEWAY": 0.85,
    "FOOTWAY": 0.85,
    "STEPS": 0.85,
    "BRIDLEWAY": 0.95,
    "TRACK": 0.95,
    "PATH": 1.00,
}

# Values meaning "nobody has tagged this". They are never scored — they lower
# coverage instead, which is the honest treatment of an absent tag.
UNKNOWN_TAG_VALUES = frozenset({"", "MISSING", "OTHER", "UNKNOWN", "NONE"})

DetailSpans = Sequence[tuple[int, int, object]]


class WeightedTagScore(NamedTuple):
    """A length-weighted mean over tagged spans, plus how much was tagged."""

    score: float | None
    coverage: float


def _normalise_tag(value: object) -> str:
    return str(value).strip().upper().replace("-", "_")


def weighted_tag_score(
    points: Sequence[LatLon],
    spans: DetailSpans | None,
    table: dict[str, float],
) -> WeightedTagScore:
    """Length-weighted mean of ``table`` over ``spans``.

    Spans whose value is unknown, or absent from the table, contribute to the
    denominator of ``coverage`` but never to ``score``. An untagged way must not
    be able to raise or lower a score — only to reduce how much of the route the
    score is based on.
    """
    lengths = segment_lengths_m(points)
    total = float(lengths.sum())
    if not spans or total <= 0:
        return WeightedTagScore(None, 0.0)

    scored_length = 0.0
    weighted_sum = 0.0
    for start, end, value in spans:
        lo = max(0, min(int(start), len(lengths)))
        hi = max(lo, min(int(end), len(lengths)))
        span_length = float(lengths[lo:hi].sum())
        if span_length <= 0:
            continue
        key = _normalise_tag(value)
        if key in UNKNOWN_TAG_VALUES or key not in table:
            continue
        scored_length += span_length
        weighted_sum += table[key] * span_length

    if scored_length <= 0:
        return WeightedTagScore(None, 0.0)
    return WeightedTagScore(weighted_sum / scored_length, min(1.0, scored_length / total))


def curviness(points: Sequence[LatLon]) -> float:
    """Accumulated heading change per 100 m, saturating at 1.0.

    Length-normalised on purpose: a long straight route and a short straight
    route are equally uncurvy, but the long one accumulates more total turning
    from vertex noise alone.
    """
    distance = path_length_m(points)
    if distance < MIN_SCORABLE_LENGTH_M:
        return 0.0
    total_turn = float(turn_angles_deg(points).sum())
    per_100m = total_turn / (distance / 100.0)
    return float(np.clip(per_100m / CURVINESS_SATURATION_DEG_PER_100M, 0.0, 1.0))


def elevation_variance(elevations: Sequence[float]) -> float | None:
    """Standard deviation of the elevation profile, saturating at 1.0.

    ``None`` when the router returned no elevation — which is a different thing
    from flat ground, and is treated as such.
    """
    if elevations is None or len(elevations) < 3:
        return None
    arr = np.asarray(elevations, dtype=float)
    if not np.isfinite(arr).all():
        return None
    return float(np.clip(arr.std() / ELEVATION_SATURATION_M, 0.0, 1.0))


class RouteGeometryScores(NamedTuple):
    nature: float
    air: float | None
    curviness: float
    elevation_variance: float | None
    naturalness: float | None
    tag_coverage: float
    has_elevation: bool


def score_geometry(
    points: Sequence[LatLon],
    elevations: Sequence[float] | None = None,
    details: dict[str, DetailSpans] | None = None,
    clip_score: float | None = None,
) -> RouteGeometryScores:
    """Score a route from its shape, elevation and OSM tags.

    ``clip_score`` is the length-weighted CLIP term when one is available; when
    it is ``None`` the remaining weights are renormalised so the result is still
    on a 0-1 scale.
    """
    details = details or {}
    road_class = weighted_tag_score(points, details.get("road_class"), ROAD_CLASS_NATURALNESS)
    surface = weighted_tag_score(points, details.get("surface"), SURFACE_NATURALNESS)
    air = weighted_tag_score(points, details.get("road_class"), ROAD_CLASS_AIR_PROXY)

    # Road class dominates: a paved path through a park is still a park path.
    naturalness: float | None
    if road_class.score is not None and surface.score is not None:
        naturalness = 0.65 * road_class.score + 0.35 * surface.score
    else:
        naturalness = road_class.score if road_class.score is not None else surface.score

    curve = curviness(points)
    elevation = elevation_variance(elevations) if elevations else None

    terms: list[tuple[float, float]] = [(WEIGHT_CURVINESS, curve)]
    if clip_score is not None:
        terms.append((WEIGHT_CLIP, clip_score))
    if naturalness is not None:
        terms.append((WEIGHT_NATURALNESS, naturalness))
    if elevation is not None:
        terms.append((WEIGHT_ELEVATION, elevation))

    weight_total = sum(w for w, _ in terms)
    nature = sum(w * v for w, v in terms) / weight_total if weight_total > 0 else 0.0

    return RouteGeometryScores(
        nature=round(float(np.clip(nature, 0.0, 1.0)), 4),
        air=round(air.score, 4) if air.score is not None else None,
        curviness=round(curve, 4),
        elevation_variance=round(elevation, 4) if elevation is not None else None,
        naturalness=round(naturalness, 4) if naturalness is not None else None,
        tag_coverage=round(max(road_class.coverage, surface.coverage), 4),
        has_elevation=elevation is not None,
    )
