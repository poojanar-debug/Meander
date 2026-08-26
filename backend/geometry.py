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
    bearing = math.degrees(math.atan2(y, x)) % 360.0

    # `% 360.0` alone does not close the interval, and the half-open range in
    # the docstring is the contract. Python's float modulo takes the sign of
    # the divisor, so a bearing a hair below zero — atan2 returns -2.8e-14
    # degrees for a due-north step across the antimeridian — becomes
    # 360 - 2.8e-14, which is not representable in float64 and rounds to
    # exactly 360.0.
    #
    # Harmless in both current callers: turn_angles_deg takes differences and
    # enrich.route_heading feeds a cosine, and both are periodic. It stops
    # being harmless the moment anyone buckets a bearing into compass points,
    # where int(360.0 / 45) indexes one past the end of an eight-element table.
    # Found by a property test rather than by a failure.
    return 0.0 if bearing >= 360.0 else bearing


def interpolate(a: LatLon, b: LatLon, t: float) -> LatLon:
    """Linear interpolation. Adequate at the sub-kilometre scale used here.

    Clamped, because the arithmetic can leave the planet. Interpolating between
    -89.99999999999999 and 90.0 produces 90.00000000000001 — an overshoot of
    about a nanometre, and still a latitude `models.py` refuses and a Mapillary
    bounding box cannot be built from. Found by a property test over the whole
    globe; no real route goes through a pole, but "no real input does that" is
    not a reason for a function to return something that is not a coordinate.
    """
    lat = a.lat + (b.lat - a.lat) * t
    lon = a.lon + (b.lon - a.lon) * t
    return LatLon(min(90.0, max(-90.0, lat)), min(180.0, max(-180.0, lon)))


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
#     segment_scenic = 0.45*clip + 0.20*naturalness + 0.20*curviness + 0.15*elev_variance
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

# How quiet each OSM road class is, 1.0 being the quietest.
#
# ⚠ **This is deliberately close to ROAD_CLASS_AIR_PROXY above, and the two are
# not independent measurements.** Traffic noise and street-level pollution both
# fall off with the same underlying quantity — how much motor traffic the way
# carries — and `road_class` is the only proxy for it either one has. Writing a
# table that pretended otherwise would be inventing a distinction the data
# cannot support.
#
# Where they differ, they differ for a reason that can be stated:
#
# * Noise scales with **speed** as well as volume, so it falls off more steeply
#   across the arterial classes than the air proxy does.
# * A way with no engine on it at all is quieter than the air table's 0.85
#   allows, because that figure is tempered by traffic running *beside* a
#   footway. Noise from the same source is what a walker actually hears.
#
# What keeps the quiet score from being a re-scaling of the air one is
# SURFACE_QUIET below, which has no counterpart in the air proxy at all.
ROAD_CLASS_QUIET_PROXY: dict[str, float] = {
    "MOTORWAY": 0.00,
    "TRUNK": 0.03,
    "PRIMARY": 0.12,
    "SECONDARY": 0.28,
    "TERTIARY": 0.45,
    "ROAD": 0.55,
    "UNCLASSIFIED": 0.62,
    "RESIDENTIAL": 0.68,
    "SERVICE": 0.70,
    "LIVING_STREET": 0.85,
    "FOOTWAY": 0.88,
    "CYCLEWAY": 0.90,
    "STEPS": 0.90,
    "PEDESTRIAN": 0.92,
    "TRACK": 0.95,
    "BRIDLEWAY": 0.97,
    "PATH": 1.00,
}

# How quiet each surface is underfoot and under a wheel.
#
# **This is the term that makes the quiet score its own measurement rather than
# a re-scaling of the air proxy, and it points the opposite way from
# SURFACE_NATURALNESS.** Cobbles and setts are the loudest surface in a European
# city: a car crossing them is audible streets away, and a wheelchair or a buggy
# on them is loud to the person pushing it. Asphalt is the quietest, and
# SURFACE_NATURALNESS rates it 0.15 because a scenic route wants the opposite
# thing. Both tables are right about the property they name.
SURFACE_QUIET: dict[str, float] = {
    "ASPHALT": 1.00,
    "GRASS": 0.95,
    "PAVED": 0.95,
    "CONCRETE": 0.90,
    "COMPACTED": 0.90,
    "GROUND": 0.90,
    "DIRT": 0.90,
    "EARTH": 0.90,
    "SAND": 0.85,
    "UNPAVED": 0.80,
    "FINE_GRAVEL": 0.75,
    "WOOD": 0.55,
    "GRAVEL": 0.55,
    "PAVING_STONES": 0.45,
    "COBBLESTONE": 0.20,
}

# How likely each road class is to have something between it and the sun.
# **A proxy for tree cover, and a weaker one than the tables above.**
#
# Canopy is not in OpenStreetMap in any form a router can steer on: trees are
# mapped as points and woodland as areas, and neither reaches an edge's tags.
# What is left is the correlation between the kind of way and what grows beside
# it, and this table is that correlation written down as a judgement. It is why
# the shade preset states its basis on the card rather than presenting a number
# and letting a reader assume a survey.
#
# PEDESTRIAN is the entry worth explaining: a pedestrianised square or shopping
# street is one of the *least* shaded surfaces in a city, and rating it high
# because it is pleasant to walk on would be scoring the wrong property.
ROAD_CLASS_CANOPY_PROXY: dict[str, float] = {
    "MOTORWAY": 0.05,
    "TRUNK": 0.08,
    "PRIMARY": 0.15,
    "SECONDARY": 0.25,
    "PEDESTRIAN": 0.25,
    "ROAD": 0.35,
    "TERTIARY": 0.35,
    "SERVICE": 0.40,
    "UNCLASSIFIED": 0.40,
    "CYCLEWAY": 0.50,
    "LIVING_STREET": 0.50,
    "STEPS": 0.50,
    "RESIDENTIAL": 0.55,
    "FOOTWAY": 0.60,
    "TRACK": 0.80,
    "PATH": 0.85,
    "BRIDLEWAY": 0.85,
}

# The same question asked of the surface, and again not the naturalness ordering.
#
# GRASS and SAND are the entries that make the point: an open meadow and a beach
# are two of the most natural surfaces in SURFACE_NATURALNESS and two of the
# least shaded places you can stand. A woodland path is unsealed *because* it is
# under trees, which is the correlation this table is actually reading.
SURFACE_CANOPY_PROXY: dict[str, float] = {
    "SAND": 0.20,
    "CONCRETE": 0.25,
    "ASPHALT": 0.30,
    "PAVED": 0.30,
    "PAVING_STONES": 0.30,
    "COBBLESTONE": 0.40,
    "GRASS": 0.50,
    "GRAVEL": 0.60,
    "FINE_GRAVEL": 0.60,
    "COMPACTED": 0.60,
    "UNPAVED": 0.70,
    "WOOD": 0.80,
    "GROUND": 0.85,
    "DIRT": 0.85,
    "EARTH": 0.85,
}

# Cover that is a fact about the way rather than a guess about what grows beside
# it. Only two values belong here, and everything else is left out on purpose:
# a value absent from a table lowers that term's coverage instead of
# contributing to it, so the ordinary ROAD case falls through to the canopy
# proxy, which is where it belongs.
#
# A tunnel is fully covered. A bridge is the opposite, and not by a small
# margin: a bridge deck has no street trees, no buildings and no shade at all.
ROAD_ENVIRONMENT_COVER: dict[str, float] = {
    "TUNNEL": 1.00,
    "BRIDGE": 0.10,
}

# How the two halves of a canopy estimate are weighted against each other. Road
# class leads for the same reason it leads in `naturalness`: what a way *is*
# says more than what it is made of.
CANOPY_ROAD_CLASS_WEIGHT = 0.60
CANOPY_SURFACE_WEIGHT = 0.40

# The same split for the quiet score. Road class leads by more here, because the
# traffic a way carries dominates what a walker hears and the surface is an
# audible but secondary term.
QUIET_ROAD_CLASS_WEIGHT = 0.75
QUIET_SURFACE_WEIGHT = 0.25

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
    scenic: float
    air: float | None
    curviness: float
    elevation_variance: float | None
    naturalness: float | None
    tag_coverage: float
    has_elevation: bool
    # The two preference presets that landed after the original three. Both are
    # optional for the same reason `air` is: a route whose ways carry none of
    # the tags the table reads has not been measured, and None says so.
    quiet: float | None = None
    shade_cover: float | None = None


def _blend_terms(
    first: float | None, first_weight: float, second: float | None, second_weight: float
) -> float | None:
    """Weighted mean of two optional terms, renormalised when one is absent.

    ``None`` when neither term was measurable. The alternative — treating an
    absent term as zero — would let an untagged surface drag a score down, which
    is the one thing `weighted_tag_score` exists to prevent.
    """
    if first is None and second is None:
        return None
    if first is None:
        return second
    if second is None:
        return first
    total = first_weight + second_weight
    return (first * first_weight + second * second_weight) / total


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

    ``quiet`` and ``shade_cover`` are the route-specific halves of the two
    preference presets that landed after the original three. Neither is a
    measurement of noise or of canopy — both read the same OSM way tags every
    other term here reads, and both are ``None`` rather than 0 when the route
    carries none of them.
    """
    details = details or {}
    class_spans = details.get("road_class")
    surface_spans = details.get("surface")
    road_class = weighted_tag_score(points, class_spans, ROAD_CLASS_NATURALNESS)
    surface = weighted_tag_score(points, surface_spans, SURFACE_NATURALNESS)
    air = weighted_tag_score(points, class_spans, ROAD_CLASS_AIR_PROXY)

    # Road class dominates: a paved path through a park is still a park path.
    naturalness: float | None
    if road_class.score is not None and surface.score is not None:
        naturalness = 0.65 * road_class.score + 0.35 * surface.score
    else:
        naturalness = road_class.score if road_class.score is not None else surface.score

    quiet = _blend_terms(
        weighted_tag_score(points, class_spans, ROAD_CLASS_QUIET_PROXY).score,
        QUIET_ROAD_CLASS_WEIGHT,
        weighted_tag_score(points, surface_spans, SURFACE_QUIET).score,
        QUIET_SURFACE_WEIGHT,
    )

    # The canopy guess, then the part of the route where cover is not a guess.
    #
    # Blended by length rather than by weight: `cover.coverage` is the fraction
    # of the route that is tunnel or bridge, and over that fraction the tag is
    # the answer. Over the rest, the proxy is all there is. Weighting them as
    # two opinions about the whole route would let a 40 m footbridge halve the
    # shade of a two-kilometre walk under trees.
    canopy = _blend_terms(
        weighted_tag_score(points, class_spans, ROAD_CLASS_CANOPY_PROXY).score,
        CANOPY_ROAD_CLASS_WEIGHT,
        weighted_tag_score(points, surface_spans, SURFACE_CANOPY_PROXY).score,
        CANOPY_SURFACE_WEIGHT,
    )
    cover = weighted_tag_score(points, details.get("road_environment"), ROAD_ENVIRONMENT_COVER)
    shade_cover: float | None
    if canopy is None:
        shade_cover = cover.score
    elif cover.score is None:
        shade_cover = canopy
    else:
        shade_cover = canopy * (1.0 - cover.coverage) + cover.score * cover.coverage

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
    scenic = sum(w * v for w, v in terms) / weight_total if weight_total > 0 else 0.0

    return RouteGeometryScores(
        scenic=round(float(np.clip(scenic, 0.0, 1.0)), 4),
        air=round(air.score, 4) if air.score is not None else None,
        curviness=round(curve, 4),
        elevation_variance=round(elevation, 4) if elevation is not None else None,
        naturalness=round(naturalness, 4) if naturalness is not None else None,
        tag_coverage=round(max(road_class.coverage, surface.coverage), 4),
        has_elevation=elevation is not None,
        quiet=round(float(np.clip(quiet, 0.0, 1.0)), 4) if quiet is not None else None,
        shade_cover=(
            round(float(np.clip(shade_cover, 0.0, 1.0)), 4) if shade_cover is not None else None
        ),
    )
