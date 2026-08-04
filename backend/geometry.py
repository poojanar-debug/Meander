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
