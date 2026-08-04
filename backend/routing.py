"""GraphHopper routing: the three presets, round trips, and one coordinate converter.

Three things in here have cost people whole days:

1. **The POST API takes ``[lon, lat]``. The GET API takes ``"lat,lon"``.** Both
   converters live in this module, are the only ones in the codebase, and are
   unit-tested. Do not inline a third.
2. **``custom_model`` is silently ignored unless ``"ch.disable": true`` is set.**
   The symptom is a nature route identical to the fastest route — no error, no
   warning. ``_base_body`` always sets it.
3. **``heading`` is ignored when ``algorithm=round_trip``.** Loop direction is
   not controllable; do not build anything that depends on it.
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass, field
from typing import Any

import httpx

from .config import GRAPHHOPPER_URL, NOMINATIM_URL, settings
from .fixtures import BudgetExhausted, FixtureMissing, fetch, is_synthetic
from .geometry import LatLon, closes_loop, path_length_m, to_lonlat_pairs
from .logging_setup import get_logger
from .models import EffectiveMode, GeocodeResult

log = get_logger(__name__)

# One route request is roughly three GraphHopper credits.
GRAPHHOPPER_CREDIT_COST = 3

# Nature must not wander indefinitely. Spec constant.
NATURE_DURATION_CAP = 1.6

# Metres per minute, used only to turn a time budget into a round-trip distance.
# Deliberately conservative — an overshoot costs the user their time budget.
LOOP_SPEED_M_PER_MIN: dict[EffectiveMode, float] = {
    "foot": 75.0,    # ~4.5 km/h
    "bike": 220.0,   # ~13 km/h
    "car": 550.0,    # ~33 km/h, urban
}

PROFILE_FOR_MODE: dict[EffectiveMode, str] = {"foot": "foot", "bike": "bike", "car": "car"}

# Returned per-edge so accessibility.py can evaluate the route it was actually given.
PATH_DETAILS = ["road_class", "surface", "road_environment"]


class RoutingError(RuntimeError):
    """An upstream failure already shaped into something a person can read."""

    def __init__(self, kind: str, human_message: str, status_code: int = 502) -> None:
        self.kind = kind
        self.human_message = human_message
        self.status_code = status_code
        super().__init__(f"{kind}: {human_message}")


class NoRouteFound(RoutingError):
    def __init__(self, human_message: str) -> None:
        super().__init__("no_route", human_message, status_code=422)


# ---------------------------------------------------------------------------
# the one coordinate converter
# ---------------------------------------------------------------------------


def to_post_point(p: LatLon) -> list[float]:
    """GraphHopper POST body ordering: ``[lon, lat]``."""
    return [p.lon, p.lat]


def to_get_point(p: LatLon) -> str:
    """GraphHopper GET query ordering: ``"lat,lon"``."""
    return f"{p.lat},{p.lon}"


def from_post_point(pair: Sequence[float]) -> LatLon:
    """Parse a GraphHopper ``[lon, lat]`` or ``[lon, lat, ele]`` coordinate."""
    return LatLon(float(pair[1]), float(pair[0]))


# ---------------------------------------------------------------------------
# presets
# ---------------------------------------------------------------------------


def nature_custom_model(distance_influence: int) -> dict[str, Any]:
    """Prefer green, quiet, unsealed-but-walkable ways over arterial roads.

    ``distance_influence`` trades detour length against preference strength:
    lower wanders more. See PROGRESS.md Phase C for the values that were tried.
    """
    return {
        "priority": [
            {"if": "road_environment == FERRY", "multiply_by": "0"},
            {
                "if": "road_class == MOTORWAY || road_class == TRUNK || road_class == PRIMARY",
                "multiply_by": "0.05",
            },
            {"if": "road_class == SECONDARY", "multiply_by": "0.25"},
            {"if": "road_class == TERTIARY", "multiply_by": "0.5"},
            {
                "if": "road_class == PATH || road_class == FOOTWAY || road_class == TRACK "
                      "|| road_class == BRIDLEWAY || road_class == CYCLEWAY",
                "multiply_by": "1.0",
            },
            {"if": "road_class == PEDESTRIAN || road_class == LIVING_STREET", "multiply_by": "0.9"},
            {"if": "road_environment == TUNNEL", "multiply_by": "0.2"},
            {
                "if": "surface == GROUND || surface == DIRT || surface == GRASS "
                      "|| surface == COMPACTED || surface == FINE_GRAVEL",
                "multiply_by": "1.0",
            },
        ],
        "distance_influence": distance_influence,
    }


# Escalating ladder for the nature preset. A lower distance_influence wanders
# further; if the result breaks the 1.6x duration cap we climb one rung and try
# again rather than returning something over budget.
NATURE_DISTANCE_INFLUENCE_LADDER = (20, 45, 90)


def accessible_custom_model() -> dict[str, Any]:
    """Refuse ways that are *known* to be impassable.

    This models only the known-bad half of the accessibility rule. An untagged
    way is **not** excluded here, because in most of the world that would return
    no route at all. It is instead marked UNKNOWN by accessibility.py, counted
    against the route's confidence, and never reported as accessible. The
    distinction is the whole point of the project — see CONTRIBUTING.md.
    """
    return {
        "priority": [
            {"if": "road_class == STEPS", "multiply_by": "0"},
            {"if": "road_environment == FERRY", "multiply_by": "0"},
            {
                "if": "surface == GRAVEL || surface == GROUND || surface == DIRT "
                      "|| surface == SAND || surface == GRASS || surface == COBBLESTONE "
                      "|| surface == UNPAVED || surface == EARTH || surface == WOOD",
                "multiply_by": "0",
            },
            {
                "if": "surface == PAVED || surface == ASPHALT || surface == CONCRETE "
                      "|| surface == PAVING_STONES || surface == COMPACTED",
                "multiply_by": "1.0",
            },
        ],
        # High, because a wandering "accessible" route is a worse answer than a
        # direct one: every extra metre is more unverified surface.
        "distance_influence": 60,
    }


# ---------------------------------------------------------------------------
# request / response
# ---------------------------------------------------------------------------


@dataclass
class RawRoute:
    """A route as GraphHopper returned it, before scoring or enrichment."""

    points: list[LatLon]
    distance_m: float
    duration_min: float
    mode: EffectiveMode
    elevations: list[float] = field(default_factory=list)
    details: dict[str, list[tuple[int, int, Any]]] = field(default_factory=dict)
    synthetic_upstream: bool = False
    preset: str = "fastest"

    @property
    def has_elevation(self) -> bool:
        return len(self.elevations) == len(self.points) and len(self.elevations) > 1


def _base_body(profile: str, elevation: bool = True) -> dict[str, Any]:
    return {
        "profile": profile,
        "points_encoded": False,
        "instructions": False,
        "calc_points": True,
        "elevation": elevation,
        # Without this, custom_model is silently discarded and every preset
        # returns the same geometry as fastest.
        "ch.disable": True,
        "details": list(PATH_DETAILS),
    }


def _parse_details(raw: Any) -> dict[str, list[tuple[int, int, Any]]]:
    out: dict[str, list[tuple[int, int, Any]]] = {}
    if not isinstance(raw, dict):
        return out
    for key, spans in raw.items():
        if not isinstance(spans, list):
            continue
        parsed: list[tuple[int, int, Any]] = []
        for span in spans:
            if isinstance(span, list | tuple) and len(span) >= 3:
                try:
                    parsed.append((int(span[0]), int(span[1]), span[2]))
                except (TypeError, ValueError):
                    continue
        if parsed:
            out[key] = parsed
    return out


def _parse_path(path: dict[str, Any], mode: EffectiveMode, synthetic: bool, preset: str
                ) -> RawRoute:
    coords = (path.get("points") or {}).get("coordinates") or []
    if len(coords) < 2:
        raise NoRouteFound("The router returned a path with no shape. Try a different start point.")

    points = [from_post_point(c) for c in coords]
    elevations = [float(c[2]) for c in coords if len(c) >= 3]
    if len(elevations) != len(points):
        elevations = []

    time_ms = float(path.get("time") or 0.0)
    distance_m = float(path.get("distance") or 0.0)
    if distance_m <= 0:
        distance_m = path_length_m(points)

    return RawRoute(
        points=points,
        distance_m=distance_m,
        duration_min=time_ms / 60_000.0,
        mode=mode,
        elevations=elevations,
        details=_parse_details(path.get("details")),
        synthetic_upstream=synthetic,
        preset=preset,
    )


def _shape_upstream_error(response: httpx.Response) -> RoutingError:
    try:
        message = str((response.json() or {}).get("message", ""))
    except (ValueError, TypeError):
        message = ""

    status = response.status_code
    if status in (401, 403):
        return RoutingError(
            "auth",
            "Routing is not configured on this server — its GraphHopper key is missing or "
            "rejected. Nothing you did caused this.",
            status_code=503,
        )
    if status == 429:
        return RoutingError(
            "upstream_rate_limit",
            "The routing service is over its quota for today. Please try again tomorrow.",
            status_code=503,
        )
    if "cannot find point" in message.lower() or "point 0" in message.lower():
        return NoRouteFound(
            "No routable road or path was found near that point. Try moving the start a little."
        )
    if "connection between locations not found" in message.lower():
        return NoRouteFound(
            "There is no route between those two points for this mode of travel."
        )
    log.warning("graphhopper_error", extra={"status": status, "upstream_message": message[:200]})
    return RoutingError(
        "upstream",
        "The routing service could not answer that request. Please try again.",
        status_code=502,
    )


async def _post_route(body: dict[str, Any], mode: EffectiveMode, preset: str) -> RawRoute:
    params = {"key": settings.graphhopper_key} if settings.graphhopper_key else None
    try:
        response = await fetch(
            "POST",
            GRAPHHOPPER_URL,
            params=params,
            json_body=body,
            headers={"Content-Type": "application/json"},
            cost=GRAPHHOPPER_CREDIT_COST,
            service="graphhopper",
        )
    except FixtureMissing as exc:
        raise RoutingError(
            "no_fixture",
            "This server is running from recorded fixtures and has none for that request. "
            "Try one of the demo locations, or set GRAPHHOPPER_KEY and "
            "MEANDER_FIXTURES=record to go live.",
            status_code=503,
        ) from exc
    except BudgetExhausted as exc:
        raise RoutingError(
            "budget",
            "This server has reached its routing budget for now. Please try again later.",
            status_code=503,
        ) from exc
    except httpx.HTTPError as exc:
        log.warning("graphhopper_transport_error", extra={"error": type(exc).__name__})
        raise RoutingError(
            "network", "Could not reach the routing service. Please try again.", status_code=502
        ) from exc

    if response.status_code >= 400:
        raise _shape_upstream_error(response)

    try:
        payload = response.json()
    except ValueError as exc:
        raise RoutingError(
            "upstream", "The routing service returned something unreadable.", status_code=502
        ) from exc

    paths = payload.get("paths") or []
    if not paths:
        raise NoRouteFound("No route was found for that request.")

    return _parse_path(paths[0], mode, is_synthetic(response), preset)


# ---------------------------------------------------------------------------
# the three presets
# ---------------------------------------------------------------------------


def build_request_body(
    origin: LatLon,
    destination: LatLon | None,
    minutes: int,
    mode: EffectiveMode,
    preset: str = "fastest",
    distance_influence: int | None = None,
) -> dict[str, Any]:
    """The exact body sent to GraphHopper for a given preset.

    Public because the fixture generator has to reproduce it byte for byte —
    the request signature is what a fixture is keyed on.
    """
    body = _base_body(PROFILE_FOR_MODE[mode])
    if destination is None:
        body["points"] = [to_post_point(origin)]
        body["algorithm"] = "round_trip"
        body["round_trip.distance"] = round(LOOP_SPEED_M_PER_MIN[mode] * minutes)
        # Fixed seed: a stable input must produce a stable route, or the cache
        # never hits and every reload spends credits.
        body["round_trip.seed"] = 42
        # heading is ignored by round_trip; not setting it is deliberate.
    else:
        body["points"] = [to_post_point(origin), to_post_point(destination)]

    if preset == "nature":
        body["custom_model"] = nature_custom_model(
            distance_influence
            if distance_influence is not None
            else NATURE_DISTANCE_INFLUENCE_LADDER[0]
        )
    elif preset == "accessible":
        body["custom_model"] = accessible_custom_model()
    return body


async def route_fastest(origin: LatLon, destination: LatLon | None, minutes: int,
                        mode: EffectiveMode) -> RawRoute:
    body = build_request_body(origin, destination, minutes, mode, "fastest")
    return await _post_route(body, mode, "fastest")


async def route_nature(origin: LatLon, destination: LatLon | None, minutes: int,
                       mode: EffectiveMode, fastest_duration_min: float | None = None
                       ) -> RawRoute:
    """Greenest route within ``NATURE_DURATION_CAP`` x the fastest duration.

    Climbs the distance_influence ladder rather than returning an over-budget
    route. Each rung is another routing call, so the loop stops at the first
    result inside the cap.
    """
    cap = fastest_duration_min * NATURE_DURATION_CAP if fastest_duration_min else None
    best: RawRoute | None = None

    for influence in NATURE_DISTANCE_INFLUENCE_LADDER:
        body = build_request_body(origin, destination, minutes, mode, "nature", influence)
        candidate = await _post_route(body, mode, "nature")

        if cap is None or candidate.duration_min <= cap:
            return candidate
        if best is None or candidate.duration_min < best.duration_min:
            best = candidate
        log.info(
            "nature_over_duration_cap",
            extra={
                "distance_influence": influence,
                "duration_min": round(candidate.duration_min, 1),
                "cap_min": round(cap, 1),
            },
        )

    assert best is not None  # the ladder always runs at least once
    return best


async def route_accessible(origin: LatLon, destination: LatLon | None, minutes: int,
                           mode: EffectiveMode) -> RawRoute:
    body = build_request_body(origin, destination, minutes, mode, "accessible")
    return await _post_route(body, mode, "accessible")


PRESETS = {
    "fastest": route_fastest,
    "nature": route_nature,
    "accessible": route_accessible,
}


def loop_returned_to_origin(route: RawRoute, origin: LatLon, tolerance_m: float = 150.0) -> bool:
    """Sanity check for round trips, used by the tests and the request path."""
    return closes_loop([origin, *route.points, origin], tolerance_m) and closes_loop(
        route.points, tolerance_m
    )


def geometry_for_wire(route: RawRoute) -> list[list[float]]:
    return to_lonlat_pairs(route.points)


# ---------------------------------------------------------------------------
# geocoding
# ---------------------------------------------------------------------------


class GeocodeError(RuntimeError):
    def __init__(self, human_message: str, status_code: int = 502) -> None:
        self.human_message = human_message
        self.status_code = status_code
        super().__init__(human_message)


GEOCODE_RESULT_LIMIT = 6


async def geocode_search(query: str) -> list[GeocodeResult]:
    """Place search via Nominatim.

    Nominatim rather than GraphHopper's geocoder on purpose: it needs no key and
    spends nothing from the 500-credit/day routing quota, which is the scarce
    resource here. Its usage policy requires a real User-Agent, which
    fixtures.py sets on the shared client.
    """
    try:
        response = await fetch(
            "GET",
            NOMINATIM_URL,
            params={
                "q": query,
                "format": "jsonv2",
                "limit": GEOCODE_RESULT_LIMIT,
                "addressdetails": 0,
            },
            headers={"Accept": "application/json"},
            cost=1,
            service="nominatim",
        )
    except FixtureMissing as exc:
        raise GeocodeError(
            "Place search is running from recorded fixtures and has none for that query. "
            "Type a coordinate, or use the locate button.",
            status_code=503,
        ) from exc
    except BudgetExhausted as exc:
        raise GeocodeError(
            "Place search has reached its budget for now. Please try again later.",
            status_code=503,
        ) from exc
    except httpx.HTTPError as exc:
        log.warning("nominatim_transport_error", extra={"error": type(exc).__name__})
        raise GeocodeError("Could not reach the place-search service.", status_code=502) from exc

    if response.status_code >= 400:
        raise GeocodeError("Place search failed. Please try again.", status_code=502)

    try:
        payload = response.json()
    except ValueError as exc:
        raise GeocodeError("Place search returned something unreadable.", status_code=502) from exc

    results: list[GeocodeResult] = []
    for item in payload if isinstance(payload, list) else []:
        try:
            results.append(
                GeocodeResult(
                    name=str(item["display_name"]),
                    lat=float(item["lat"]),
                    lon=float(item["lon"]),
                )
            )
        except (KeyError, TypeError, ValueError):
            continue
    return results[:GEOCODE_RESULT_LIMIT]


__all__ = [
    "NATURE_DURATION_CAP",
    "GeocodeError",
    "NoRouteFound",
    "RawRoute",
    "RoutingError",
    "accessible_custom_model",
    "build_request_body",
    "from_post_point",
    "geometry_for_wire",
    "loop_returned_to_origin",
    "nature_custom_model",
    "route_accessible",
    "route_fastest",
    "route_nature",
    "to_get_point",
    "to_post_point",
]
