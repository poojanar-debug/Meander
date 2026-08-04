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


# Candidates for the nature preset, as (distance_influence, loop_distance_scale).
#
# A single escalating ladder does not work. For a point-to-point route,
# distance_influence is a usable lever: higher values pull the route back
# towards the direct one. For a **round trip** neither parameter behaves
# monotonically — GraphHopper's round_trip algorithm picks a candidate loop, and
# a small change to either input flips it to an entirely different loop. Measured
# in Colombo: distance_influence 20 through 400 all returned the same 117-minute
# loop against a 42-minute baseline, while scaling round_trip.distance by 0.7
# also returned 117 minutes and 0.5 returned 18. Searching monotonically over
# either one is meaningless.
#
# So the presets are generated as a small candidate set and the greenest one
# that fits the duration cap wins — which is what the specification actually
# asks for: maximum greenery, capped at 1.6x the fastest duration.
NATURE_DISTANCE_INFLUENCE_LADDER = (20, 45, 90)
NATURE_LOOP_CANDIDATES: tuple[tuple[int, float], ...] = (
    (20, 1.0),
    (20, 0.8),
    (20, 0.6),
    (20, 0.45),
    (45, 0.7),
    (90, 0.35),
)

# How a candidate is judged. Greenness is the objective, but a route that
# undershoots the time budget is a bad answer to "I have thirty minutes" even if
# it is green — picking purely on greenness turned a 30-minute request into an
# 18-minute loop. These weights are a judgement, not a measurement.
NATURE_GREENNESS_WEIGHT = 0.6
NATURE_BUDGET_FIT_WEIGHT = 0.4

# Below this fraction of the requested time, a route is short enough that the
# card should say so rather than let someone assume it fills their budget.
NATURE_BUDGET_UNDERSHOOT = 0.7


def _budget_fit(duration_min: float, requested_min: int) -> float:
    """1.0 when a route uses exactly the time asked for, falling off either side."""
    if requested_min <= 0:
        return 0.0
    return max(0.0, 1.0 - abs(duration_min - requested_min) / requested_min)


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
    # Set when the preset could not fully deliver what it promises — over the
    # duration cap, well under the time budget, or no greener than fastest. The
    # route is still the best available; the caller must not present it as
    # though the caveat does not exist.
    preset_note: str | None = None

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
        # A self-hosted GraphHopper has no concept of an API key, so "the key is
        # missing or rejected" is not merely unhelpful there, it is a wrong
        # diagnosis that sends an operator hunting for a credential that does
        # not exist. A 401/403 from our own router is a proxy, a security group
        # or an auth layer in front of it.
        if graphhopper_is_self_hosted():
            return RoutingError(
                "auth",
                "The routing service refused this request. That server is one this "
                "deployment runs itself, so this is something in front of it — a "
                "proxy or an access rule — rather than an API key. Nothing you did "
                "caused this.",
                status_code=503,
            )
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
    # Only the hosted API is sent the key.
    #
    # It travels as a *query parameter*, so a deployment that keeps
    # GRAPHHOPPER_KEY configured for fallback — which is a perfectly sensible
    # thing to do — was putting it in the query string of every request to its
    # own router, and therefore into that server's access log, in plaintext,
    # forever. A self-hosted server has no use for it either way.
    send_key = settings.graphhopper_key and not graphhopper_is_self_hosted()
    params = {"key": settings.graphhopper_key} if send_key else None
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
    loop_distance_scale: float = 1.0,
) -> dict[str, Any]:
    """The exact body sent to GraphHopper for a given preset.

    Public because the fixture generator has to reproduce it byte for byte —
    the request signature is what a fixture is keyed on.
    """
    body = _base_body(PROFILE_FOR_MODE[mode])
    if destination is None:
        body["points"] = [to_post_point(origin)]
        body["algorithm"] = "round_trip"
        body["round_trip.distance"] = round(
            LOOP_SPEED_M_PER_MIN[mode] * minutes * loop_distance_scale
        )
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


async def route_nature(
    origin: LatLon,
    destination: LatLon | None,
    minutes: int,
    mode: EffectiveMode,
    fastest: RawRoute | None = None,
) -> RawRoute:
    """The greenest route that fits inside ``NATURE_DURATION_CAP`` x fastest.

    Generates a few candidates and picks the best, rather than walking a ladder
    until something fits. That is what the specification asks for in as many
    words, and it is the only thing that works for round trips, where
    GraphHopper responds discontinuously to both available levers (see
    NATURE_LOOP_CANDIDATES).

    A candidate has to clear two bars before it is even considered: inside the
    duration cap, and **greener than the fastest route**. The second is not
    optional — a "nature" route no greener than the plain one is a label
    without a thing behind it. Among those, greenness is balanced against how
    well the route uses the time asked for, because picking on greenness alone
    turned a thirty-minute request into an eighteen-minute loop.

    Both terms come from geometry.py, which is local and free, so comparing
    candidates costs no extra requests.

    When no candidate clears the bars, the closest one is returned with
    ``preset_note`` explaining which promise it missed.
    """
    from .geometry import score_geometry

    def greenness(route: RawRoute) -> float:
        return score_geometry(route.points, route.elevations or None, route.details).nature

    cap = fastest.duration_min * NATURE_DURATION_CAP if fastest else None
    floor = greenness(fastest) if fastest else None
    is_loop = destination is None

    # Searching costs one routing request per candidate: free against a
    # self-hosted server, three credits a time against the hosted one, so the
    # metered path takes the first acceptable candidate.
    unmetered = graphhopper_is_self_hosted()
    if is_loop:
        candidates = NATURE_LOOP_CANDIDATES if unmetered else NATURE_LOOP_CANDIDATES[:2]
    else:
        candidates = tuple((infl, 1.0) for infl in NATURE_DISTANCE_INFLUENCE_LADDER)

    acceptable: list[tuple[float, RawRoute]] = []
    fallback: tuple[float, RawRoute] | None = None

    for influence, scale in candidates:
        body = build_request_body(
            origin, destination, minutes, mode, "nature", influence, scale
        )
        candidate = await _post_route(body, mode, "nature")
        green = greenness(candidate)
        within = cap is None or candidate.duration_min <= cap
        greener = floor is None or green > floor
        merit = (
            NATURE_GREENNESS_WEIGHT * green
            + NATURE_BUDGET_FIT_WEIGHT * _budget_fit(candidate.duration_min, minutes)
        )

        if within and greener:
            acceptable.append((merit, candidate))
            if not unmetered:
                break
        else:
            log.info(
                "nature_candidate_rejected",
                extra={
                    "distance_influence": influence,
                    "loop_scale": scale,
                    "over_cap": not within,
                    "not_greener": not greener,
                },
            )
            # Keep the least-bad option in case nothing clears both bars,
            # preferring one that at least fits the cap.
            better = fallback is None or (within and merit > fallback[0])
            if better:
                fallback = (merit, candidate)

    if acceptable:
        acceptable.sort(key=lambda pair: pair[0], reverse=True)
        chosen = acceptable[0][1]
        if minutes > 0 and chosen.duration_min < minutes * NATURE_BUDGET_UNDERSHOOT:
            chosen.preset_note = (
                "This is the greenest route available near you, but it is "
                "noticeably shorter than the time you asked for — nothing "
                "greener was reachable within your budget."
            )
        return chosen

    assert fallback is not None  # at least one candidate always runs
    _, chosen = fallback
    over_cap = cap is not None and chosen.duration_min > cap
    log.warning(
        "nature_no_acceptable_candidate",
        extra={"over_cap": over_cap, "candidates": len(candidates)},
    )
    chosen.preset_note = (
        "No greener route was found inside your time budget. This is the "
        "shortest one that is meaningfully greener, and it is longer than you "
        "asked for."
        if over_cap
        else "No route near you was greener than the fastest one, so this is "
             "much the same way."
    )
    return chosen


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
