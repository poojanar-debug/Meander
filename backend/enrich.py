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

import asyncio
import math
from collections.abc import Sequence
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from itertools import pairwise
from typing import Any

import httpx
import numpy as np

from .accessibility import BARRIER_VALUES_WITH_A_VERDICT
from .config import OPEN_METEO_AQ_URL, OPEN_METEO_URL, OVERPASS_URL
from .fixtures import BudgetExhausted, FixtureMissing, fetch
from .geometry import (
    EARTH_RADIUS_M,
    LatLon,
    bearing_deg,
    closes_loop,
    cumulative_distance_m,
    sample_every,
)
from .logging_setup import get_logger
from .metrics import metrics

log = get_logger(__name__)

# European AQI: 0-20 good, 20-40 fair, 40-60 moderate, 60-80 poor, 80-100 very
# poor, 100+ extremely poor. Mapped to a 0-1 score where 1 is clean air.
AQI_WORST = 100.0

# How far off the polyline a bench still counts as being "on the route".
REST_STOP_CORRIDOR_M = 35.0

# Much tighter than the rest-stop corridor, and tight for the opposite reason —
# see barrier_spans_on_route. Roughly the width of a road: wide enough for the
# disagreement between an OSM node and a simplified polyline, narrow enough not
# to reach the parallel path across the street.
BARRIER_CORRIDOR_M = 10.0
REST_STOP_TARGET_SPACING_M = 200.0
OVERPASS_TIMEOUT_S = 25
# Raised from 200, which real routes were hitting. Overpass truncates by element
# id, and element id has nothing to do with position along a route, so reaching
# the cap does not shorten the survey — it perforates it, and the result was
# presented as a complete look either way.
#
# Measured on the committed corpus at the old value: two of the eleven recorded
# fixtures held exactly 200 elements and a third held 199, so a wheelchair user
# planning rest breaks was already being shown a survey with holes in it and no
# way to tell.
#
# 6,000 is sized against the largest bbox this project actually produces. The
# Vondelpark scenario is a 60-minute *bike* loop, so the box covering its three
# routes is about 8 x 7 km and holds **4,762** amenity nodes — counted with
# `out count`, not guessed. A 35-minute walk is an order of magnitude smaller.
#
# The cap still exists because an unbounded `out body` over a large bbox is how
# a client earns a ban, and because a runaway query should fail rather than
# stream. Where it is reached anyway, OverpassNodes.truncated refuses to let the
# partial answer pass for a whole one.
#
# It lives inside the query string, so changing it rekeys every committed
# Overpass fixture. They were re-recorded for this value.
OVERPASS_MAX_RESULTS = 6000

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


def route_heading(points: Sequence[LatLon]) -> float | None:
    """Overall heading, start to end, or ``None`` when there is not one.

    ⚠ **A loop has no net heading, and 0.0 is not a way of saying that.** This
    returned 0.0 for a round trip and `golden_hour` consumed it as a bearing of
    **due north** — so on this app's *default* trip shape the 0.20-weight light
    term was scoring a departure by whether the sun would be northerly.

    Severity is lower than it sounds, and measuring it is what says so:
    `golden_hour` only fires for 0 < elevation < 15 degrees, and at those
    elevations the sun is never due north at any latitude this app covers.
    Measured over a year of 15-minute samples with `heading = 0.0`, the light
    term peaks at 0.616 at Hyde Park, 0.642 at Vondelpark and 0.401 at Colombo
    Fort — a systematic bias in the departure ranking rather than a wild one.

    None rather than 0.0 so the caller renormalises the weights instead of
    scoring a direction nobody is travelling in.
    """
    if len(points) < 2:
        return None
    if closes_loop(points):
        return None
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
                # Two days, not one. The departure strip offers six hours
                # forward, so a late-evening request routinely asks about
                # tomorrow — and a 24-value series cannot answer that, it can
                # only return today's value for the same hour. See _hour_index.
                "forecast_days": 2,
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

    index = _hour_index(when, hourly)
    aqi = _value_at(aqi_series, index)
    pm2_5 = _value_at(pm_series, index)
    if aqi is None:
        return None

    return AirQuality(
        score=round(max(0.0, min(1.0, 1.0 - aqi / AQI_WORST)), 4),
        aqi=aqi,
        pm2_5=pm2_5,
    )


def _hour_index(when: datetime | None, hourly: dict[str, Any]) -> int | None:
    """Position of ``when`` in the series, found by the series' own timestamps.

    Two defects met here, and one answer closes both.

    **The day mattered, not just the hour.** This indexed by ``moment.hour``
    into a 24-value array, so a departure after UTC midnight read *today's*
    value for that hour: a request at 23:30 with `depart_at` 01:00 got index 1,
    a reading close to 23 hours old, presented as the air quality for the walk.
    `models.py` puts no bound on `depart_at` and the departure strip offers six
    hourly chips forward, so crossing midnight is ordinary.

    **Replay served last year's forecast as a current measurement.** A recorded
    fixture holds the forecast for the day it was recorded. Indexing it by
    today's hour returns a number with provenance `recorded` and no degradation
    — a real measurement of a day that has passed. Replay is a documented
    deployment mode, so this is not hypothetical.

    Open-Meteo returns `hourly.time` alongside every series, so the series can
    say for itself which hours it covers. Matching against that is both the fix
    for the midnight case and the reason a stale fixture now answers ``None``:
    the hour being asked about is simply not in it. Nothing has to know how old
    the fixture is, or guess a threshold past which it stops being true.
    """
    stamps = hourly.get("time") or []
    if not stamps:
        return None

    moment = when or datetime.now(UTC)
    if moment.tzinfo is None:
        moment = moment.replace(tzinfo=UTC)
    # Open-Meteo's timestamps are naive and in the requested timezone, which is
    # UTC by default here. Truncated to the hour because that is the resolution
    # the series has.
    wanted = moment.astimezone(UTC).replace(minute=0, second=0, microsecond=0)
    wanted_key = wanted.strftime("%Y-%m-%dT%H:00")

    try:
        return stamps.index(wanted_key)
    except ValueError:
        return None


def _value_at(series: list[Any], index: int | None) -> float | None:
    if index is None or not series or index >= len(series):
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
                # Two days, for the same reason as the air-quality call above:
                # this feeds the shade score through the same _hour_index, so a
                # departure past UTC midnight would otherwise fall off the end
                # of the series and take the shade score to null with it.
                "forecast_days": 2,
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
        hourly = response.json().get("hourly", {})
        series = hourly.get("cloud_cover") or []
    except (ValueError, AttributeError):
        return None

    value = _value_at(series, _hour_index(when, hourly))
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


def overpass_barrier_query(points: Sequence[LatLon]) -> str:
    """Barrier nodes over the same bbox, as a sibling query rather than a union.

    A union with the amenity query would be one request instead of two, which is
    what the rate limit cares about, and it was the first thing tried. It is not
    worth what it costs: a fixture is keyed on a hash of the request body, so
    editing the amenity query invalidates all eleven committed Overpass
    fixtures at once and the offline suite goes dark on a change that has
    nothing to do with rest stops. Two queries per request is still one query
    per *request* — the thing the rest-stop comment warns against is one per
    route, which multiplies by three.

    The value filter is not an optimisation that trades away correctness, and it
    is derived from ``BARRIER_VALUES_WITH_A_VERDICT`` rather than written out
    here so that widening the engine widens the question automatically.

    Asking for every barrier value was the first version, on the reasoning that
    assess_barrier() should own the decision and an unrecognised value should
    arrive as UNKNOWN rather than as absence. Measured, that does not hold: the
    bbox covering three Vondelpark routes returns **more than 2,000 barrier
    nodes**, of which 603 are bollards, 310 blocks, 181 lift gates and 50 kerbs.
    The query truncated, and a truncated answer cannot support a claim at all —
    so asking for everything produced *no* barrier check rather than a thorough
    one.

    Nothing is lost by narrowing it. A value outside the set assesses to
    UNKNOWN; an UNKNOWN barrier span yields no finding and does not enter
    coverage, which is computed from surface and smoothness. It cannot change
    the response, so not fetching it cannot change the response either. The same
    bbox returns 676 gates.
    """
    south, west, north, east = _bbox(points)
    values = "|".join(sorted(v.lower() for v in BARRIER_VALUES_WITH_A_VERDICT))
    return (
        f"[out:json][timeout:{OVERPASS_TIMEOUT_S}];"
        f'node["barrier"~"^({values})$"]({south:.5f},{west:.5f},{north:.5f},{east:.5f});'
        f"out body {OVERPASS_MAX_RESULTS};"
    )


@dataclass(frozen=True)
class OverpassNodes:
    """What one Overpass query returned, and whether it returned all of it.

    ``truncated`` is the reason this is a type rather than a list. ``out body N``
    stops at N elements ordered by element id, which has nothing to do with
    position along any route — so a truncated answer is a *biased sample* of the
    bbox, not a prefix of it. Presented as a complete survey it would drop
    benches from the second half of a route with no indication, and drop
    barriers from anywhere at all.
    """

    elements: list[dict[str, Any]]
    truncated: bool

    @property
    def usable(self) -> list[dict[str, Any]] | None:
        """The elements, or None when the answer cannot support a claim.

        A truncated answer is a biased sample of the bbox, not a short one, so
        it is folded into the same None that an unreachable Overpass produces
        and read the same way everywhere downstream.
        """
        return None if self.truncated else self.elements


async def fetch_overpass(
    points: Sequence[LatLon], query: str, what: str
) -> OverpassNodes | None:
    """Run one Overpass query over the bbox covering ``points``.

    Separate from the per-route filtering so one query can serve every route in
    a request. Overpass rate-limits hard, and three queries per page load —
    which is what one query per route would be — would earn a ban within
    minutes.

    Returns ``None`` when Overpass could not be reached — which is different
    from an empty list, and the caller reports it differently.
    """
    if len(points) < 2:
        return OverpassNodes([], False)

    try:
        response = await fetch(
            "POST",
            OVERPASS_URL,
            data={"data": query},
            headers={"Content-Type": "application/x-www-form-urlencoded"},
            cost=1,
            service="overpass",
        )
    except (FixtureMissing, BudgetExhausted) as exc:
        log.info("overpass_unavailable", extra={"what": what, "reason": type(exc).__name__})
        metrics.incr("enrichment_failures_total")
        return None
    except httpx.HTTPError as exc:
        log.warning("overpass_transport_error", extra={"what": what, "error": type(exc).__name__})
        metrics.incr("enrichment_failures_total")
        return None

    if response.status_code == 429:
        # Overpass rate-limits hard. Back off by giving up on this request
        # rather than retrying into a longer ban.
        log.warning("overpass_rate_limited", extra={"what": what})
        metrics.incr("enrichment_failures_total")
        return None
    if response.status_code >= 400:
        log.warning("overpass_error", extra={"what": what, "status": response.status_code})
        metrics.incr("enrichment_failures_total")
        return None

    try:
        elements = response.json().get("elements", [])
    except (ValueError, AttributeError):
        metrics.incr("enrichment_failures_total")
        return None

    # Overpass gives no "there was more" flag, so a full page is the only signal
    # available. It over-reports by exactly the case where the bbox holds
    # precisely the cap — rare, and erring toward "we might not have seen
    # everything" is the right direction for both consumers.
    truncated = len(elements) >= OVERPASS_MAX_RESULTS
    if truncated:
        log.warning("overpass_truncated", extra={"what": what, "limit": OVERPASS_MAX_RESULTS})
        metrics.incr("overpass_truncated_total")
    return OverpassNodes(elements, truncated)


async def fetch_rest_stop_nodes(points: Sequence[LatLon]) -> OverpassNodes | None:
    return await fetch_overpass(points, overpass_query(points), "rest_stops")


async def fetch_barrier_nodes(points: Sequence[LatLon]) -> OverpassNodes | None:
    return await fetch_overpass(points, overpass_barrier_query(points), "barriers")


def barrier_spans_on_route(
    points: Sequence[LatLon], elements: list[dict[str, Any]]
) -> list[tuple[int, int, str, float, float]]:
    """Barrier nodes projected onto ``(start, end, value, lat, lon)`` spans.

    ## How a point becomes a span

    A barrier is a node — a gate is at a place, not along a stretch — while the
    accessibility engine reasons in spans of route geometry. The conversion has
    to be stated rather than assumed, because every way of getting it wrong is a
    false claim about whether someone can get through.

    **A barrier blocks the single segment it sits on.** The node is projected
    perpendicularly onto every segment, the nearest segment `i` wins, and the
    span is `(i, i + 1)`: one segment, the one the walker is on when they reach
    it. It is not widened to the surrounding vertices, not to the step, and not
    to a radius. Widening would report a gate as blocking stretches of path that
    are demonstrably clear, and — because a FAIL anywhere blocks the whole route
    — would turn one mis-projected node into a refusal to offer the route at all.

    ## Perpendicular to the line, not to the nearest vertex

    This used to take the distance to the nearest **vertex** and compare *that*
    to ``BARRIER_CORRIDOR_M``, while the docstring below justifies the number as
    a perpendicular offset — "10 m is the width of a road". Those are different
    measurements, and the gap between them is not small. For a point lying
    exactly on the line, distance-to-nearest-vertex is ``min(d, s - d)`` along
    its segment, which is large in the middle of a long one.

    **Measured over all 86 committed GraphHopper fixtures — 11,331 segments,
    344.5 km, median segment 14.8 m, p90 69.7 m, longest 499.5 m — 56.3% of
    route length is more than 10 m from any vertex.** A gate sitting precisely
    on the route in that 56% was silently dropped, while ``barriers_checked``
    stayed True and the sentence widened to "Accessibility data covers 100% of
    this route": a missing datum producing a confident answer, which is this
    project's founding promise inverted.

    Two honest qualifications. That 56.3% is a property of the geometry, not a
    rate of real misses — matched against the three committed Overpass barrier
    fixtures, only 1 of 33 pairings changes a route's verdict. And it shipped
    for a findable reason: the synthetic test geometry was spaced at *exactly*
    the corridor width, so the vertex test and the perpendicular test agreed on
    it and could never disagree. That helper is fixed alongside this.

    ## Why the node's own coordinates travel with the span

    ``_span_verdicts`` places the Finding at ``points[lo]`` — the span's start
    vertex — because that is all it used to be given. Under the old
    nearest-vertex match, ``lo`` *was* the matched vertex, so the map pin landed
    within 10 m of the gate by accident. Under a projection it is the start of a
    segment that may be hundreds of metres back, and the pin would move off the
    gate. Trading a missed barrier for a misplaced one is not a fix, so the
    node's lat/lon are carried through and the Finding uses them.

    ## The corridor

    ``BARRIER_CORRIDOR_M`` is deliberately much tighter than the 35 m used for
    rest stops, and they are tight and loose for opposite reasons. A bench 30 m
    away is plausibly *for* this path and listing it costs nothing if it is not.
    A gate 30 m away is probably on a different path, and claiming it blocks
    this one denies a route that is fine.

    10 m is the width of a road. It absorbs the few metres of disagreement
    between OSM's node position and GraphHopper's simplified polyline, without
    reaching across to the parallel way on the other side of a street.

    A node beyond the corridor is dropped rather than clamped. It is evidence
    about somewhere else.
    """
    if len(points) < 2 or not elements:
        return []

    candidates: list[tuple[LatLon, str]] = []
    for element in elements:
        value = (element.get("tags") or {}).get("barrier")
        if not value:
            continue
        try:
            node = LatLon(float(element["lat"]), float(element["lon"]))
        except (KeyError, TypeError, ValueError):
            continue
        candidates.append((node, str(value)))

    if not candidates:
        return []

    # Broadcast over (nodes x segments), for the same reason the haversine it
    # replaces was broadcast: a Python loop over every node times every segment,
    # per route, on the event loop is the one thing this must not be.
    #
    # A local equirectangular projection about the route's mean latitude, rather
    # than a spherical formula, because perpendicular distance to a segment has
    # no closed form on a sphere. Over the few hundred metres a segment spans it
    # is indistinguishable from the spherical answer, and `lib/follow.js` does
    # the same thing on the client for the same reason.
    pt_lat = np.fromiter((p.lat for p in points), float, len(points))
    pt_lon = np.fromiter((p.lon for p in points), float, len(points))
    lat0 = float(pt_lat.mean())
    kx = math.cos(math.radians(lat0)) * math.pi / 180.0 * EARTH_RADIUS_M
    ky = math.pi / 180.0 * EARTH_RADIUS_M

    px = pt_lon * kx
    py = pt_lat * ky
    ax, ay = px[:-1], py[:-1]
    bx, by = px[1:], py[1:]
    abx, aby = bx - ax, by - ay
    seg_len_sq = abx * abx + aby * aby

    node_x = np.fromiter((n.lon for n, _ in candidates), float, len(candidates)) * kx
    node_y = np.fromiter((n.lat for n, _ in candidates), float, len(candidates)) * ky

    # t is where along each segment the foot of the perpendicular falls, clamped
    # to [0, 1] so a node level with the segment but past its end measures to the
    # endpoint rather than to an imaginary extension of the line.
    dx = node_x[:, None] - ax[None, :]
    dy = node_y[:, None] - ay[None, :]
    with np.errstate(invalid="ignore", divide="ignore"):
        t = (dx * abx[None, :] + dy * aby[None, :]) / seg_len_sq[None, :]
    # A duplicated vertex is a zero-length segment and would divide by zero.
    t = np.where(seg_len_sq[None, :] > 0, np.clip(t, 0.0, 1.0), 0.0)
    offx = dx - t * abx[None, :]
    offy = dy - t * aby[None, :]
    distances = np.hypot(offx, offy)

    # Ties go to the LATER segment, which is what `argmin` does not do — it
    # returns the first minimum. A node sitting exactly on vertex `i` is zero
    # from both the segment arriving at it and the segment leaving it, and the
    # nearest-vertex code this replaces resolved that to `(i, i + 1)`. Keeping
    # that convention means the span indices are unchanged for every barrier the
    # old code already found, so this change adds barriers rather than moving
    # the ones that were working.
    nearest = distances.shape[1] - 1 - distances[:, ::-1].argmin(axis=1)
    rows = np.arange(len(candidates))
    nearest_m = distances[rows, nearest]

    # Where along the route the foot of the perpendicular falls. Computed here,
    # where the projection already exists, rather than reconstructed downstream
    # from a vertex index: `at_m` used to be `cum[lo]`, the span's *start
    # vertex*, which is up to a whole segment short of the barrier. The longest
    # segment in the committed fixtures is 499.5 m.
    seg_len = np.hypot(abx, aby)
    seg_cum = np.concatenate(([0.0], np.cumsum(seg_len)))
    along_m = seg_cum[nearest] + t[rows, nearest] * seg_len[nearest]

    # Deduplicated: two gates a few metres apart match the same segment, and one
    # gate on a segment already blocks it. Measured on the Hyde Park accessible
    # route, which matched (18, 19, "gate") twice.
    #
    # The node's own position is part of the key, so two genuinely different
    # gates on one segment stay two findings with two pins, while one gate
    # reported twice collapses. Rounded to 7 decimal places — about 11 mm, finer
    # than any barrier is surveyed — so float noise cannot split a duplicate.
    seen: set[tuple[int, int, str, float, float, float]] = set()
    last_segment = max(0, len(points) - 2)
    for i, (node, value) in enumerate(candidates):
        if nearest_m[i] > BARRIER_CORRIDOR_M:
            continue
        start = min(int(nearest[i]), last_segment)
        seen.add((
            start,
            start + 1,
            value,
            round(node.lat, 7),
            round(node.lon, 7),
            round(float(along_m[i]), 1),
        ))

    return sorted(seen)


def rest_stops_on_route(points: Sequence[LatLon], elements: list[dict[str, Any]]
                        ) -> list[RestStop]:
    cum = cumulative_distance_m(points)
    found: list[RestStop] = []

    candidates: list[tuple[LatLon, str]] = []
    for element in elements:
        try:
            node = LatLon(float(element["lat"]), float(element["lon"]))
        except (KeyError, TypeError, ValueError):
            continue
        amenity = (element.get("tags") or {}).get("amenity")
        if not amenity:
            continue
        candidates.append((node, str(amenity).replace("_", " ")))

    if not candidates or len(points) == 0:
        return []

    # One (nodes x vertices) haversine in numpy, rather than a Python loop over
    # up to 200 Overpass nodes times every polyline vertex, per route, on the
    # event loop. Same arithmetic as geometry.haversine_m, broadcast.
    #
    # Nearest vertex is close enough at this corridor width, and avoids a
    # point-to-segment projection for every node in the bbox.
    node_lat = np.radians(np.fromiter((n.lat for n, _ in candidates), float, len(candidates)))
    node_lon = np.radians(np.fromiter((n.lon for n, _ in candidates), float, len(candidates)))
    pt_lat = np.radians(np.fromiter((p.lat for p in points), float, len(points)))
    pt_lon = np.radians(np.fromiter((p.lon for p in points), float, len(points)))

    dlat = pt_lat[None, :] - node_lat[:, None]
    dlon = pt_lon[None, :] - node_lon[:, None]
    h = (
        np.sin(dlat / 2.0) ** 2
        + np.cos(node_lat)[:, None] * np.cos(pt_lat)[None, :] * np.sin(dlon / 2.0) ** 2
    )
    distances = 2.0 * EARTH_RADIUS_M * np.arcsin(np.sqrt(np.minimum(1.0, h)))

    nearest = distances.argmin(axis=1)
    nearest_m = distances[np.arange(len(candidates)), nearest]

    for i, (node, amenity) in enumerate(candidates):
        if nearest_m[i] > REST_STOP_CORRIDOR_M:
            continue
        found.append(
            RestStop(
                lat=round(node.lat, 6),
                lon=round(node.lon, 6),
                type=amenity,
                at_m=round(float(cum[int(nearest[i])])),
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
        air_score = air.score if air else 0.5

        # Renormalised rather than scored as zero. A loop has no net heading, so
        # `route_heading` returns None and the 0.20 light weight is redistributed
        # across the two terms that *are* measurable — air and exposure — in
        # their existing proportions. Scoring the light term as 0 instead would
        # push every loop's total down uniformly, which changes nothing in the
        # ranking but makes the number mean less; scoring it against a heading of
        # due north, which is what 0.0 used to do, changed the ranking itself.
        if heading is None:
            score = (0.45 * air_score + 0.35 * (1.0 - exposure)) / 0.80
            light = 0.0
        else:
            light = golden_hour(sun, heading)
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
    # Barrier nodes from the same query. None means the same thing it means
    # everywhere else here — nobody could look — and it is what keeps
    # `barriers_checked` false rather than letting an unreachable Overpass read
    # as "no gates on this route".
    barrier_nodes: list[dict[str, Any]] | None = None
    air: AirQuality | None = None
    # **How much shade the hour demands, not how much a route provides.**
    #
    # It used to be the finished score, and that was the whole of `Scores.shade`
    # on the wire: one number computed at the midpoint of the longest route and
    # stamped on every route in the request. Under the three original objectives
    # nobody could tell, because it was the same claim about the same hour
    # whichever route you looked at. A Shade *preset* made it a defect — the one
    # route chosen for shade would have reported exactly the shade of the route
    # that ignored it, which is a label with nothing behind it.
    #
    # So the split: this is the demand, `geometry.score_geometry` measures what
    # each route offers against it, and `main._blend_shade` puts them together.
    shade_need: float | None = None
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

    # Three independent upstreams, three different hosts. Awaited in sequence
    # this was the entire latency budget of a request: measured on this project,
    # Overpass alone took 13.6 s for a trivial bench query while the two
    # Open-Meteo calls took 0.58 s and 0.84 s, and a self-hosted GraphHopper
    # answered a whole route in 0.024 s. Gathering turns worst-case ~= sum into
    # worst-case ~= Overpass.
    #
    # _degrade() already swallows every failure into None, so gather cannot
    # raise here and one slow or broken service cannot take the other two down.
    sampled = _sampled_for_overpass(all_points)
    stops_found, barriers_found, air, cloud = await asyncio.gather(
        _degrade("rest_stops", fetch_rest_stop_nodes(sampled)),
        _degrade("barriers", fetch_barrier_nodes(sampled)),
        _degrade("air_quality", fetch_air_quality(midpoint, when)),
        _degrade("cloud_cover", fetch_cloud_cover(midpoint, when)),
    )

    sun = solar_position(when, midpoint)
    # How much shade this hour calls for: a high sun in a clear sky, and nothing
    # at all once it is down or the cloud has closed in. With no cloud data
    # there is no honest number, so it stays null rather than becoming 0.
    need: float | None = None
    if cloud is not None:
        need = round(max(0.0, min(1.0, shade_need(sun) * (1.0 - cloud))), 4)

    departure = await _degrade(
        "best_departure", best_departure(longest, when, air=air, cloud=cloud)
    )

    return EnrichContext(
        rest_stop_nodes=stops_found.usable if stops_found else None,
        barrier_nodes=barriers_found.usable if barriers_found else None,
        air=air,
        shade_need=need,
        sun=sun,
        departure=departure,
    )


def _sampled_for_overpass(points: Sequence[LatLon], max_points: int = 120) -> list[LatLon]:
    """Thin the polyline before building a bbox — the query only needs its extent."""
    if len(points) <= max_points:
        return list(points)
    return [s.point for s in sample_every(points, 25.0, max_points)]
