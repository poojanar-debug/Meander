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

from .config import (
    GRAPHHOPPER_URL,
    NOMINATIM_URL,
    graphhopper_is_self_hosted,
    path_details,
    settings,
)
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

# The values GraphHopper's own enums accept in a custom model, probed against a
# running server. These are NOT the same as OSM tag values: `surface=earth` is
# valid OSM but the router maps it to GROUND, and writing EARTH in a custom
# model fails the whole request with "is neither a method, a field, nor a member
# class of com.graphhopper.routing.ev.Surface". accessibility.py deliberately
# keeps the wider OSM vocabulary, because it evaluates tags rather than
# compiling them.
GH_SURFACE_VALUES = frozenset({
    "PAVED", "ASPHALT", "CONCRETE", "PAVING_STONES", "COMPACTED", "GRAVEL",
    "FINE_GRAVEL", "GROUND", "DIRT", "GRASS", "SAND", "WOOD", "COBBLESTONE",
    "UNPAVED", "MISSING", "OTHER",
})
GH_ROAD_CLASS_VALUES = frozenset({
    "STEPS", "PATH", "FOOTWAY", "TRACK", "BRIDLEWAY", "CYCLEWAY", "PEDESTRIAN",
    "LIVING_STREET", "MOTORWAY", "TRUNK", "PRIMARY", "SECONDARY", "TERTIARY",
    "RESIDENTIAL", "SERVICE", "UNCLASSIFIED", "ROAD", "OTHER",
})
GH_ROAD_ENVIRONMENT_VALUES = frozenset({"ROAD", "FERRY", "BRIDGE", "TUNNEL", "FORD", "OTHER"})
GH_SMOOTHNESS_VALUES = frozenset({
    "EXCELLENT", "GOOD", "INTERMEDIATE", "BAD", "VERY_BAD", "HORRIBLE",
    "VERY_HORRIBLE", "IMPASSABLE", "MISSING", "OTHER",
})

# Returned per-edge so accessibility.py can evaluate the route it was actually
# given. Resolved at call time because it depends on which server we are talking
# to — see config.path_details().


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


class PresetUnavailable(RoutingError):
    """This objective cannot be routed on the current GraphHopper plan.

    A first-class outcome, not a bug: the nature and accessible presets steer
    the router with a custom model, and custom models need flexible mode, which
    free packages do not include. The honest response is to report that preset
    as blocked with the reason, rather than quietly returning the fastest route
    a second time under a different name.
    """

    def __init__(self, human_message: str) -> None:
        super().__init__("plan_limitation", human_message, status_code=422)


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


def accessible_custom_model(with_smoothness: bool | None = None) -> dict[str, Any]:
    """Refuse ways that are *known* to be impassable.

    This models only the known-bad half of the accessibility rule. An untagged
    way is **not** excluded here, because in most of the world that would return
    no route at all. It is instead marked UNKNOWN by accessibility.py, counted
    against the route's confidence, and never reported as accessible. The
    distinction is the whole point of the project — see CONTRIBUTING.md.
    """
    if with_smoothness is None:
        with_smoothness = "smoothness" in path_details()

    return {
        "priority": [
            {"if": "road_class == STEPS", "multiply_by": "0"},
            {"if": "road_environment == FERRY", "multiply_by": "0"},
            {
                "if": "surface == GRAVEL || surface == GROUND || surface == DIRT "
                      "|| surface == SAND || surface == GRASS || surface == COBBLESTONE "
                      "|| surface == UNPAVED || surface == WOOD",
                "multiply_by": "0",
            },
            {
                "if": "surface == PAVED || surface == ASPHALT || surface == CONCRETE "
                      "|| surface == PAVING_STONES || surface == COMPACTED",
                "multiply_by": "1.0",
            },
            # Only reachable on a self-hosted graph: the encoded value must be
            # built into the graph, and the hosted API does not include it. This
            # is the hard constraint the router could never enforce — until now
            # bad smoothness could only be reported after the fact, never
            # avoided. Referencing it against a graph without it fails the whole
            # request, so it is conditional.
            *(
                [{
                    "if": "smoothness == BAD || smoothness == VERY_BAD "
                          "|| smoothness == HORRIBLE || smoothness == VERY_HORRIBLE "
                          "|| smoothness == IMPASSABLE",
                    "multiply_by": "0",
                }]
                if with_smoothness
                else []
            ),
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
    """Everything common to a request. `ch.disable` is added only when needed.

    A custom model requires flexible mode (`ch.disable: true`) — without it
    GraphHopper rejects the request, and older versions silently discarded the
    model, which returned the fastest route under every preset with no error at
    all. But flexible mode is a **paid feature**: a free package answers any
    request carrying `ch.disable` with 400 "Free packages cannot use flexible
    mode". Setting it unconditionally therefore broke even the fastest preset,
    which needs no custom model. It is now added by build_request_body only for
    the presets that actually carry one.
    """
    return {
        "profile": profile,
        "points_encoded": False,
        "instructions": False,
        "calc_points": True,
        "elevation": elevation,
        "details": path_details(),
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


# Coordinate-free labels for GraphHopper's error text, so a log line can say
# what went wrong without repeating what the caller asked for.
_UPSTREAM_CLASSIFICATIONS = (
    ("cannot find point", "point_not_snappable"),
    ("connection between locations not found", "no_connection"),
    ("flexible mode", "plan_lacks_flexible_mode"),
    ("profile", "bad_profile"),
    ("custom_model", "bad_custom_model"),
    ("query param", "bad_parameter"),
)


def _classify_upstream_message(message: str) -> str:
    lowered = message.lower()
    for needle, label in _UPSTREAM_CLASSIFICATIONS:
        if needle in lowered:
            return label
    return "unclassified"


def _shape_upstream_error(response: httpx.Response) -> RoutingError:
    try:
        message = str((response.json() or {}).get("message", ""))
    except (ValueError, TypeError):
        message = ""

    status = response.status_code
    lowered = message.lower()

    if "flexible mode" in lowered or (
        "custom_model" in lowered and "speed mode" in lowered
    ):
        return PresetUnavailable(
            "This objective needs GraphHopper's flexible routing mode, which free "
            "API packages do not include. The fastest route still works, and "
            "everything else — accessibility checks, rest stops, air quality — is "
            "unaffected. A paid GraphHopper plan enables it."
        )
    if "profile parameter can only be one of" in lowered:
        return PresetUnavailable(
            "This travel mode is not available on the current GraphHopper plan. "
            "Free packages allow car, bike and foot only."
        )

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
    # Deliberately NOT logging `message`: GraphHopper's error text routinely
    # embeds the caller's coordinates ("Cannot find point 0: 51.50,-0.16"), and
    # this project does not log coordinates. A classification is enough to
    # debug with.
    log.warning(
        "graphhopper_error",
        extra={"status": status, "classification": _classify_upstream_message(message)},
    )
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

    # When flexible mode is required, and only then.
    #
    # A custom model always needs it. A round trip needs it too, but only on a
    # self-hosted server: one with contraction hierarchies prepared answers
    # "algorithm=round_trip cannot be used with CH", whereas the hosted API
    # accepts the same request happily. Asking for it unconditionally would
    # break every round trip on a free package, where flexible mode is paid.
    needs_flexible = "custom_model" in body or (
        body.get("algorithm") == "round_trip" and graphhopper_is_self_hosted()
    )
    if needs_flexible:
        body["ch.disable"] = True
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
GEOCODE_COORD_DECIMALS = 6


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
                    # Six decimal places is ~0.1 m, far finer than routing needs.
                    # Rounding here means two people searching the same place get
                    # byte-identical requests, so the route cache hits and the
                    # demo fixtures match what the search returns.
                    lat=round(float(item["lat"]), GEOCODE_COORD_DECIMALS),
                    lon=round(float(item["lon"]), GEOCODE_COORD_DECIMALS),
                )
            )
        except (KeyError, TypeError, ValueError):
            continue
    return results[:GEOCODE_RESULT_LIMIT]


__all__ = [
    "NATURE_DURATION_CAP",
    "GeocodeError",
    "NoRouteFound",
    "PresetUnavailable",
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
