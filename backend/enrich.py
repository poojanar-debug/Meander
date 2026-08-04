"""Enrichment: air quality, sun and shade, rest stops, and best departure time.

Everything here is a nice-to-have. **Nothing in this module is allowed to fail a
request.** Each entry point returns a value or ``None``, logs the reason it
degraded, and the response carries `null` for that field rather than an
invented number. `main.py` never raises on an enrichment failure — there is a
test that kills each service in turn and asserts the API still answers 200.

Solar position is computed locally rather than fetched. It is pure arithmetic
(the NOAA algorithm), so calling an API for it would spend budget and add a
failure mode for something that cannot fail.
"""

from __future__ import annotations

import math
from collections.abc import Sequence
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from itertools import pairwise
from typing import Any

import httpx

from .config import OPEN_METEO_AQ_URL, OPEN_METEO_URL, OVERPASS_URL
from .fixtures import BudgetExhausted, FixtureMissing, fetch
from .geometry import LatLon, bearing_deg, cumulative_distance_m, haversine_m, sample_every
from .logging_setup import get_logger
from .metrics import metrics

log = get_logger(__name__)

# European AQI: 0-20 good, 20-40 fair, 40-60 moderate, 60-80 poor, 80-100 very
# poor, 100+ extremely poor. Mapped to a 0-1 score where 1 is clean air.
AQI_WORST = 100.0

# How far off the polyline a bench still counts as being "on the route".
REST_STOP_CORRIDOR_M = 35.0
REST_STOP_TARGET_SPACING_M = 200.0
OVERPASS_TIMEOUT_S = 25
OVERPASS_MAX_RESULTS = 200

REST_STOP_AMENITIES = ("bench", "drinking_water", "toilets", "shelter")

# Best-departure search: 15-minute steps across six hours, per the spec.
DEPARTURE_STEP_MIN = 15
DEPARTURE_HORIZON_H = 6


# ---------------------------------------------------------------------------
# sun position — local arithmetic, no API
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class SunPosition:
    elevation_deg: float
    azimuth_deg: float

    @property
    def is_up(self) -> bool:
        return self.elevation_deg > 0


def solar_position(when: datetime, point: LatLon) -> SunPosition:
    """NOAA solar position. Accurate to well under a degree, which is ample here.

    ``when`` is interpreted as UTC; a naive datetime is assumed to be UTC.
    """
    if when.tzinfo is None:
        when = when.replace(tzinfo=UTC)
    when = when.astimezone(UTC)

    day_of_year = when.timetuple().tm_yday
    hour = when.hour + when.minute / 60 + when.second / 3600

    gamma = 2 * math.pi / 365.0 * (day_of_year - 1 + (hour - 12) / 24)

    eq_time = 229.18 * (
        0.000075
        + 0.001868 * math.cos(gamma)
        - 0.032077 * math.sin(gamma)
        - 0.014615 * math.cos(2 * gamma)
        - 0.040849 * math.sin(2 * gamma)
    )
    declination = (
        0.006918
        - 0.399912 * math.cos(gamma)
        + 0.070257 * math.sin(gamma)
        - 0.006758 * math.cos(2 * gamma)
        + 0.000907 * math.sin(2 * gamma)
        - 0.002697 * math.cos(3 * gamma)
        + 0.00148 * math.sin(3 * gamma)
    )

    time_offset = eq_time + 4 * point.lon
    true_solar_time = (hour * 60) + time_offset
    hour_angle = math.radians(true_solar_time / 4 - 180)

    lat = math.radians(point.lat)
    cos_zenith = math.sin(lat) * math.sin(declination) + math.cos(lat) * math.cos(
        declination
    ) * math.cos(hour_angle)
    cos_zenith = max(-1.0, min(1.0, cos_zenith))
    zenith = math.acos(cos_zenith)
    elevation = 90.0 - math.degrees(zenith)

    sin_zenith = math.sin(zenith)
    if abs(sin_zenith) < 1e-9:
        azimuth = 0.0
    else:
        cos_azimuth = (math.sin(lat) * cos_zenith - math.sin(declination)) / (
            math.cos(lat) * sin_zenith
        )
        cos_azimuth = max(-1.0, min(1.0, cos_azimuth))
        # NOAA gives cos(180 - azimuth), not cos(azimuth): the angle is measured
        # away from due south. Dropping the 180 puts the noon sun due north.
        core = math.degrees(math.acos(cos_azimuth))
        azimuth = 180.0 - core if hour_angle <= 0 else 180.0 + core

    return SunPosition(round(elevation, 3), round(azimuth % 360.0, 3))


def golden_hour(sun: SunPosition, heading_deg: float) -> float:
    """Spec formula: ``max(0, cos(azimuth - heading))`` when the sun is low.

    Zero outside the 0-15 degree elevation band, because golden light is a
    property of a low sun, not of a direction.
    """
    if not (0 < sun.elevation_deg < 15):
        return 0.0
    return max(0.0, math.cos(math.radians(sun.azimuth_deg - heading_deg)))


def shade_need(sun: SunPosition) -> float:
    """Spec formula: ``max(0, sin(elevation))``. Zero when the sun is down."""
    return max(0.0, math.sin(math.radians(sun.elevation_deg)))


def route_heading(points: Sequence[LatLon]) -> float:
    """Overall heading, start to end. Zero for a loop, which has no net heading."""
    if len(points) < 2:
        return 0.0
    return bearing_deg(points[0], points[-1])


# ---------------------------------------------------------------------------
# air quality
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class AirQuality:
    score: float
    aqi: float | None
    pm2_5: float | None


async def fetch_air_quality(point: LatLon, when: datetime | None = None) -> AirQuality | None:
    """European AQI at a point, as a 0-1 score where 1 is clean.

    Returns ``None`` on any failure. The caller reports `null`, never a guess.
    """
    try:
        response = await fetch(
            "GET",
            OPEN_METEO_AQ_URL,
            params={
                "latitude": round(point.lat, 3),
                "longitude": round(point.lon, 3),
                "hourly": "pm2_5,european_aqi",
                "forecast_days": 1,
            },
            headers={"Accept": "application/json"},
            cost=1,
            service="open_meteo",
        )
    except (FixtureMissing, BudgetExhausted) as exc:
        log.info("air_quality_unavailable", extra={"reason": type(exc).__name__})
        metrics.incr("enrichment_failures_total")
        return None
    except httpx.HTTPError as exc:
        log.warning("air_quality_transport_error", extra={"error": type(exc).__name__})
        metrics.incr("enrichment_failures_total")
        return None

    if response.status_code >= 400:
        log.warning("air_quality_error", extra={"status": response.status_code})
        metrics.incr("enrichment_failures_total")
        return None

    try:
        hourly = response.json().get("hourly", {})
        aqi_series = hourly.get("european_aqi") or []
        pm_series = hourly.get("pm2_5") or []
    except (ValueError, AttributeError):
        metrics.incr("enrichment_failures_total")
        return None

    index = _hour_index(when, len(aqi_series))
    aqi = _value_at(aqi_series, index)
    pm2_5 = _value_at(pm_series, index)
    if aqi is None:
        return None

    return AirQuality(
        score=round(max(0.0, min(1.0, 1.0 - aqi / AQI_WORST)), 4),
        aqi=aqi,
        pm2_5=pm2_5,
    )


def _hour_index(when: datetime | None, length: int) -> int:
    if length == 0:
        return 0
    moment = when or datetime.now(UTC)
    if moment.tzinfo is None:
        moment = moment.replace(tzinfo=UTC)
    return max(0, min(length - 1, moment.astimezone(UTC).hour))


def _value_at(series: list[Any], index: int) -> float | None:
    if not series or index >= len(series):
        return None
    value = series[index]
    if value is None:
        # Open-Meteo returns nulls for hours it has no data for. A null hour is
        # not a zero reading.
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


# ---------------------------------------------------------------------------
# cloud cover, used to temper the shade calculation
# ---------------------------------------------------------------------------


async def fetch_cloud_cover(point: LatLon, when: datetime | None = None) -> float | None:
    """Cloud cover fraction 0-1, or ``None``. Overcast makes shade irrelevant."""
    try:
        response = await fetch(
            "GET",
            OPEN_METEO_URL,
            params={
                "latitude": round(point.lat, 3),
                "longitude": round(point.lon, 3),
                "hourly": "cloud_cover",
                "forecast_days": 1,
            },
            headers={"Accept": "application/json"},
            cost=1,
            service="open_meteo",
        )
    except (FixtureMissing, BudgetExhausted, httpx.HTTPError) as exc:
        log.info("cloud_cover_unavailable", extra={"reason": type(exc).__name__})
        metrics.incr("enrichment_failures_total")
        return None

    if response.status_code >= 400:
        metrics.incr("enrichment_failures_total")
        return None
    try:
        series = response.json().get("hourly", {}).get("cloud_cover") or []
    except (ValueError, AttributeError):
        return None

    value = _value_at(series, _hour_index(when, len(series)))
    return None if value is None else round(max(0.0, min(1.0, value / 100.0)), 4)


# ---------------------------------------------------------------------------
# rest stops — Overpass
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class RestStop:
    lat: float
    lon: float
    type: str
    at_m: float


def _bbox(points: Sequence[LatLon], pad_deg: float = 0.001) -> tuple[float, float, float, float]:
    lats = [p.lat for p in points]
    lons = [p.lon for p in points]
    return (
        min(lats) - pad_deg,
        min(lons) - pad_deg,
        max(lats) + pad_deg,
        max(lons) + pad_deg,
    )


def overpass_query(points: Sequence[LatLon]) -> str:
    south, west, north, east = _bbox(points)
    amenities = "|".join(REST_STOP_AMENITIES)
    return (
        f"[out:json][timeout:{OVERPASS_TIMEOUT_S}];"
        f'node["amenity"~"^({amenities})$"]({south:.5f},{west:.5f},{north:.5f},{east:.5f});'
        f"out body {OVERPASS_MAX_RESULTS};"
    )


async def fetch_rest_stop_nodes(points: Sequence[LatLon]) -> list[dict[str, Any]] | None:
    """Raw amenity nodes in the bounding box covering ``points``.

    Separate from the per-route filtering so one Overpass query can serve every
    route in a request. Overpass rate-limits hard, and three queries per page
    load would earn a ban within minutes.

    Returns ``None`` when Overpass could not be reached — which is different
    from an empty list, and the caller reports it differently.
    """
    if len(points) < 2:
        return []

    try:
        response = await fetch(
            "POST",
            OVERPASS_URL,
            data={"data": overpass_query(points)},
            headers={"Content-Type": "application/x-www-form-urlencoded"},
            cost=1,
            service="overpass",
        )
    except (FixtureMissing, BudgetExhausted) as exc:
        log.info("rest_stops_unavailable", extra={"reason": type(exc).__name__})
        metrics.incr("enrichment_failures_total")
        return None
    except httpx.HTTPError as exc:
        log.warning("overpass_transport_error", extra={"error": type(exc).__name__})
        metrics.incr("enrichment_failures_total")
        return None

    if response.status_code == 429:
        # Overpass rate-limits hard. Back off by giving up on this request
        # rather than retrying into a longer ban.
        log.warning("overpass_rate_limited")
        metrics.incr("enrichment_failures_total")
        return None
    if response.status_code >= 400:
        log.warning("overpass_error", extra={"status": response.status_code})
        metrics.incr("enrichment_failures_total")
        return None

    try:
        return response.json().get("elements", [])
    except (ValueError, AttributeError):
        metrics.incr("enrichment_failures_total")
        return None


def rest_stops_on_route(points: Sequence[LatLon], elements: list[dict[str, Any]]
                        ) -> list[RestStop]:
    cum = cumulative_distance_m(points)
    found: list[RestStop] = []

    for element in elements:
        try:
            node = LatLon(float(element["lat"]), float(element["lon"]))
        except (KeyError, TypeError, ValueError):
            continue
        amenity = (element.get("tags") or {}).get("amenity")
        if not amenity:
            continue

        # Nearest vertex is close enough at this corridor width, and avoids a
        # point-to-segment projection for every node in the bbox.
        best_index, best_distance = 0, float("inf")
        for i, p in enumerate(points):
            d = haversine_m(node, p)
            if d < best_distance:
                best_index, best_distance = i, d
        if best_distance > REST_STOP_CORRIDOR_M:
            continue

        found.append(
            RestStop(
                lat=round(node.lat, 6),
                lon=round(node.lon, 6),
                type=str(amenity).replace("_", " "),
                at_m=round(float(cum[best_index])),
            )
        )

    found.sort(key=lambda s: s.at_m)
    return found


def rest_stop_gap_score(points: Sequence[LatLon], stops: Sequence[RestStop]) -> float | None:
    """How well the route meets "a rest stop at least every 200 m".

    1.0 when no gap exceeds the target, falling towards 0 as the worst gap
    grows. ``None`` when Overpass could not be consulted at all.
    """
    if stops is None:
        return None
    total = float(cumulative_distance_m(points)[-1]) if len(points) > 1 else 0.0
    if total <= 0:
        return None
    if not stops:
        return 0.0

    marks = [0.0, *[s.at_m for s in stops], total]
    worst_gap = max(b - a for a, b in pairwise(marks))
    return round(max(0.0, min(1.0, REST_STOP_TARGET_SPACING_M / max(worst_gap, 1.0))), 4)


# ---------------------------------------------------------------------------
# best departure
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class DepartureSuggestion:
    when: datetime
    reason: str
    score: float


async def best_departure(
    points: Sequence[LatLon],
    from_time: datetime | None = None,
    horizon_hours: int = DEPARTURE_HORIZON_H,
    air: AirQuality | None = None,
    cloud: float | None = None,
) -> DepartureSuggestion | None:
    """Search 15-minute steps across the next six hours for the nicest start.

    Scored on air quality, how much shade is wanted, and whether the light will
    be low and along the route. Returns ``None`` if nothing could be measured —
    an invented "best time" would be worse than none.
    """
    if len(points) < 2:
        return None

    start = from_time or datetime.now(UTC)
    if start.tzinfo is None:
        start = start.replace(tzinfo=UTC)

    midpoint = points[len(points) // 2]
    heading = route_heading(points)

    if air is None:
        air = await fetch_air_quality(midpoint, start)
    if cloud is None:
        cloud = await fetch_cloud_cover(midpoint, start)
    if air is None and cloud is None:
        # Nothing measurable, so there is no honest "best" time to name.
        return None

    steps = int(horizon_hours * 60 / DEPARTURE_STEP_MIN)
    best: DepartureSuggestion | None = None

    for step in range(steps + 1):
        moment = start + timedelta(minutes=step * DEPARTURE_STEP_MIN)
        sun = solar_position(moment, midpoint)

        # Under a clear high sun, wanting shade counts against the slot; when it
        # is overcast or the sun is low, it does not matter.
        exposure = shade_need(sun) * (1.0 - (cloud if cloud is not None else 0.5))
        light = golden_hour(sun, heading)
        air_score = air.score if air else 0.5

        score = 0.45 * air_score + 0.35 * (1.0 - exposure) + 0.20 * light
        if sun.elevation_deg < -6:
            # After civil twilight nothing is scenic and much is unsafe.
            score *= 0.35

        if best is None or score > best.score:
            best = DepartureSuggestion(moment, _departure_reason(sun, light, exposure, air), score)

    return best


def _departure_reason(
    sun: SunPosition, light: float, exposure: float, air: AirQuality | None
) -> str:
    parts: list[str] = []
    if light > 0.3:
        parts.append("the light will be low and along your way")
    elif exposure < 0.25 and sun.is_up:
        parts.append("the sun will be off your back")
    elif not sun.is_up:
        parts.append("it will be dark, so this is the quietest rather than the prettiest option")
    if air is not None and air.score > 0.7:
        parts.append("air quality is good")
    elif air is not None and air.score < 0.4:
        parts.append("air quality is poor all afternoon, so this is the least bad slot")

    if not parts:
        return "This is the most comfortable slot in the next few hours."
    return parts[0][0].upper() + parts[0][1:] + (f", and {parts[1]}." if len(parts) > 1 else ".")


# ---------------------------------------------------------------------------
# the one call main.py makes
# ---------------------------------------------------------------------------


async def _degrade(stage: str, awaitable: Any) -> Any:
    """Await something optional, returning ``None`` if it fails for any reason.

    The individual fetchers already handle the failures they expect. This is the
    backstop for the ones they do not, because the specification's hard rule is
    that /api/routes stays usable when enrichment breaks — and "any reason"
    includes bugs in this module.
    """
    try:
        return await awaitable
    except Exception as exc:  # noqa: BLE001 — deliberate: nothing here may fail a request
        log.warning("enrichment_degraded", extra={"stage": stage, "error": type(exc).__name__})
        metrics.incr("enrichment_failures_total")
        return None


@dataclass(frozen=True)
class EnrichContext:
    """Everything enrichment could find for one request.

    Fetched once per request, not once per route: Overpass rate-limits hard
    enough that three queries per page load would earn a ban within minutes.
    Every field may be ``None``, and ``None`` always means "could not measure",
    never "measured zero".
    """

    rest_stop_nodes: list[dict[str, Any]] | None = None
    air: AirQuality | None = None
    shade_score: float | None = None
    sun: SunPosition | None = None
    departure: DepartureSuggestion | None = None


async def enrich_context(
    routes_points: Sequence[Sequence[LatLon]],
    depart_at: datetime | None = None,
) -> EnrichContext:
    """Best-effort enrichment for a whole request. Never raises."""
    all_points = [p for route in routes_points for p in route]
    if len(all_points) < 2:
        return EnrichContext()

    longest = max(routes_points, key=len)
    midpoint = longest[len(longest) // 2]
    when = depart_at or datetime.now(UTC)

    nodes = await _degrade("rest_stops", fetch_rest_stop_nodes(_sampled_for_overpass(all_points)))
    air = await _degrade("air_quality", fetch_air_quality(midpoint, when))
    cloud = await _degrade("cloud_cover", fetch_cloud_cover(midpoint, when))

    sun = solar_position(when, midpoint)
    # "How much shade will you get relative to how much you need." With no cloud
    # data there is no honest number, so it stays null rather than becoming 1.0.
    shade: float | None = None
    if cloud is not None:
        shade = round(max(0.0, min(1.0, 1.0 - shade_need(sun) * (1.0 - cloud))), 4)

    departure = await _degrade(
        "best_departure", best_departure(longest, when, air=air, cloud=cloud)
    )

    return EnrichContext(
        rest_stop_nodes=nodes,
        air=air,
        shade_score=shade,
        sun=sun,
        departure=departure,
    )


def _sampled_for_overpass(points: Sequence[LatLon], max_points: int = 120) -> list[LatLon]:
    """Thin the polyline before building a bbox — the query only needs its extent."""
    if len(points) <= max_points:
        return list(points)
    return [s.point for s in sample_every(points, 25.0, max_points)]
