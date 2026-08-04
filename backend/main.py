"""FastAPI application.

Contract: this module must return a usable response even when scoring and
enrichment both fail. Every optional subsystem is behind a degradation path, and
the response always states which scoring path produced its numbers.
"""

from __future__ import annotations

import asyncio
import hashlib
import importlib.util
import json
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from typing import Any

from fastapi import FastAPI, Query, Request, Response
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from . import __version__
from .accessibility import assess_route
from .cache import get_cache
from .config import STRICT_STARTUP, settings
from .enrich import (
    AirQuality,
    EnrichContext,
    enrich_context,
    rest_stops_on_route,
)
from .enrich import RestStop as EnrichRestStop
from .geometry import score_geometry
from .logging_setup import configure_logging, get_logger
from .metrics import metrics
from .models import (
    Blocker,
    CacheInfo,
    GeocodeResponse,
    RestStop,
    Route,
    RouteRequest,
    RoutesResponse,
    Scores,
    effective_mode,
)
from .ratelimit import RateLimiter
from .routing import (
    PRESETS,
    NoRouteFound,
    RawRoute,
    RoutingError,
    geometry_for_wire,
)
from .scoring import clip_term_for_route

configure_logging(settings.log_level)
log = get_logger(__name__)

limiter = RateLimiter(
    capacity=settings.per_ip_bucket_capacity,
    refill_per_min=settings.per_ip_refill_per_min,
    daily_ceiling=settings.global_daily_route_ceiling,
)

UNASSESSED_NOTE = (
    "Accessibility could not be assessed for this route at all. "
    "Treat all of it as unverified."
)
SYNTHETIC_NOTE = (
    "This route was built from demonstration data, not a live routing response. "
    "Every number on it is a placeholder, not a measurement."
)


# ~110 m. Two requests from the same street corner should share a cached answer.
CACHE_COORD_DECIMALS = 3


def clip_available() -> bool:
    """True when torch and open_clip can be imported in this process.

    Deliberately uses find_spec rather than an import: importing torch costs
    ~300 MB of RSS and the deployed instance has 512 MB total.
    """
    try:
        return (
            importlib.util.find_spec("torch") is not None
            and importlib.util.find_spec("open_clip") is not None
        )
    except (ImportError, ValueError):
        return False


def _check_startup() -> list[str]:
    missing = settings.missing_keys()
    if missing:
        message = (
            "Missing API keys: " + ", ".join(missing) + ". "
            "Copy .env.example to .env and fill them in, or run with "
            "MEANDER_FIXTURES=replay to work entirely from recorded fixtures."
        )
        if STRICT_STARTUP:
            raise RuntimeError(message)
        log.warning("startup_missing_keys", extra={"missing_keys": missing})
    return missing


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    missing = _check_startup()
    cache = get_cache()
    purged = cache.purge_expired_routes()
    log.info(
        "startup",
        extra={
            "version": __version__,
            "fixture_mode": settings.fixture_mode,
            "clip_available": clip_available(),
            "missing_keys": missing,
            "routes_purged": purged,
            "cache_stats": cache.stats(),
        },
    )
    yield
    from .fixtures import aclose_client

    await aclose_client()
    log.info("shutdown")


app = FastAPI(
    title="Meander",
    version=__version__,
    description="Time-budgeted routing that optimises for greenery and real accessibility.",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=list(settings.allowed_origins),
    allow_credentials=False,
    allow_methods=["GET", "POST", "OPTIONS"],
    allow_headers=["Content-Type", "Accept"],
    max_age=600,
)


def _error(kind: str, message: str, status: int) -> JSONResponse:
    return JSONResponse(status_code=status, content={"error": {"kind": kind, "message": message}})


def _client_ip(request: Request) -> str | None:
    """Read the client address for rate limiting only.

    The value is passed straight into a salted digest and never stored, logged
    or returned.
    """
    forwarded = request.headers.get("x-forwarded-for")
    if forwarded:
        return forwarded.split(",")[0].strip()
    return request.client.host if request.client else None


# ---------------------------------------------------------------------------
# routes
# ---------------------------------------------------------------------------


def route_cache_key(req: RouteRequest) -> str:
    """Rounded inputs only — never a raw user coordinate."""
    origin = (
        round(req.origin.lat, CACHE_COORD_DECIMALS),
        round(req.origin.lon, CACHE_COORD_DECIMALS),
    )
    dest = (
        (round(req.destination.lat, CACHE_COORD_DECIMALS),
         round(req.destination.lon, CACHE_COORD_DECIMALS))
        if req.destination
        else None
    )
    material = json.dumps(
        {
            "origin": origin,
            "destination": dest,
            "minutes": req.minutes,
            "mode": req.mode,
            "objectives": list(req.resolved_objectives()),
            "version": __version__,
        },
        sort_keys=True,
    )
    return hashlib.sha256(material.encode()).hexdigest()[:24]


def _scored_route(
    route_id: str,
    label: str,
    raw: RawRoute,
    rest_stops: list[EnrichRestStop] | None = None,
    air: AirQuality | None = None,
    shade: float | None = None,
) -> Route:
    """Turn a routed path into a wire Route, scored as well as it honestly can be.

    A route built from a hand-authored fixture keeps `scoring_method:
    "placeholder"` even though the scoring maths ran: the maths is real but the
    geometry it ran on is not, and a number derived from invented terrain is not
    a measurement of anywhere.
    """
    # Cache read only — this never imports torch, and returns nothing for any
    # region batch_score.py has not pre-warmed.
    clip = _guard("clip_lookup", clip_term_for_route, raw.points)
    clip_score = clip.score if clip is not None else None
    scores = _guard(
        "geometry_scoring",
        score_geometry,
        raw.points,
        raw.elevations or None,
        raw.details,
        clip_score=clip_score,
    )
    access = _guard("accessibility", assess_route, raw.points, raw.elevations or None, raw.details)
    synthetic = raw.synthetic_upstream

    if synthetic or scores is None:
        # A failed scoring run has produced no measurement, and "placeholder" is
        # exactly what the contract calls a number that is not one.
        method = "placeholder"
    elif clip_score is not None:
        method = "clip"
    else:
        method = "geometry_only"

    # Hard constraints reject only the accessible preset. On the other two the
    # same findings are reported as information: someone walking may well take a
    # route with three steps in it, and should still be told they are there.
    blocked = route_id == "accessible" and access is not None and access.is_blocked
    blockers = [
        Blocker(type=f.type, lat=f.lat, lon=f.lon, description=f.description)
        for f in (access.findings if access else [])
    ]

    return Route(
        id=route_id,
        label=label,
        status="blocked" if blocked else "ok",
        geometry=geometry_for_wire(raw),
        duration_min=round(raw.duration_min, 1),
        distance_m=round(raw.distance_m),
        mode=raw.mode,
        # A null score means "not measured", which is a different statement
        # from zero and is rendered as such.
        scores=Scores(
            nature=scores.nature if scores else None,
            air=_blend_air(air, scores.air if scores else None),
            shade=shade,
        ),
        scoring_method=method,
        # A coverage figure computed over invented tags is not a coverage
        # figure. Synthetic routes report no confidence at all.
        confidence=0.0 if (synthetic or access is None) else access.coverage,
        blockers=blockers,
        rest_stops=[
            RestStop(lat=s.lat, lon=s.lon, type=s.type, at_m=s.at_m)
            for s in (rest_stops or [])
        ],
        synthetic_upstream=synthetic,
        confidence_note=(
            SYNTHETIC_NOTE if synthetic else (access.sentence() if access else UNASSESSED_NOTE)
        ),
        status_note=(
            "Hard accessibility constraints reject this route." if blocked else None
        ),
    )


def _guard(stage: str, fn: Any, *args: Any, **kwargs: Any) -> Any:
    """Run an optional scoring step, returning ``None`` if it fails.

    The specification's hard rule is that /api/routes returns a usable response
    even when scoring and enrichment both fail. Degrading is explicit and
    logged; nothing is swallowed silently.
    """
    try:
        return fn(*args, **kwargs)
    except Exception as exc:  # noqa: BLE001 — deliberate: nothing here may fail a request
        log.warning("scoring_degraded", extra={"stage": stage, "error": type(exc).__name__})
        metrics.incr("upstream_failures_total")
        return None


def _blend_air(measured: AirQuality | None, road_proxy: float | None) -> float | None:
    """Combine a regional air-quality measurement with local traffic exposure.

    The Open-Meteo reading is a real measurement but covers a whole area, so on
    its own it gives all three routes the same number. The road-class proxy is
    route-specific but is only a proxy. Together: the regional level, modulated
    by how much traffic this particular route runs alongside.
    """
    if measured is None:
        return road_proxy
    if road_proxy is None:
        return measured.score
    return round(measured.score * (0.55 + 0.45 * road_proxy), 4)


def _blocked_route(route_id: str, label: str, mode: str, note: str) -> Route:
    return Route(
        id=route_id,
        label=label,
        status="blocked",
        geometry=[],
        duration_min=0.0,
        distance_m=0.0,
        mode=mode,  # type: ignore[arg-type]
        scores=Scores(),
        scoring_method="placeholder",
        confidence=0.0,
        status_note=note,
    )


async def _attach_narration(routes: list[Route]) -> None:
    """Fill in `narration` where it can be. Mutates `routes` in place.

    Narration is the least important field in the response and must never be
    able to fail a request or hold one open, so every call is guarded and the
    whole pass is skipped when no key is configured.
    """
    from . import narrate as narrate_module

    if not settings.anthropic_api_key:
        return

    async def one(route: Route) -> None:
        try:
            route.narration = await narrate_module.narrate(
                narrate_module.narration_request_for(route, route.rest_stops)
            )
        except Exception as exc:  # noqa: BLE001 — narration may never fail a request
            log.warning("narration_degraded", extra={"error": type(exc).__name__})
            metrics.incr("narration_failures_total")

    await asyncio.gather(*(one(r) for r in routes), return_exceptions=True)


async def _build_routes(
    req: RouteRequest,
) -> tuple[list[Route], str | None, EnrichContext]:
    """Route every requested objective, degrading rather than failing.

    A preset that cannot be routed becomes a ``blocked`` result. Only an
    entirely empty set is an error.
    """
    from .models import ROUTE_LABELS

    mode = effective_mode(req.mode, req.minutes)
    origin = req.origin.to_latlon()
    destination = req.destination.to_latlon() if req.destination else None
    objectives = req.resolved_objectives()

    routes: list[Route] = []
    routed: list[tuple[str, str, RawRoute]] = []
    fastest_duration: float | None = None
    failures: list[RoutingError] = []

    # fastest first when present: nature's duration cap is relative to it.
    ordered = sorted(objectives, key=lambda o: 0 if o == "fastest" else 1)

    for objective in ordered:
        label = ROUTE_LABELS.get(objective, objective.title())
        preset_fn = PRESETS.get(objective)
        if preset_fn is None:
            # Objectives beyond the implemented three (quiet/shade/air) are not
            # silently dropped — the UI is told they are not available yet.
            routes.append(
                _blocked_route(objective, label, mode,
                               f"The {label.lower()} objective is not implemented yet.")
            )
            continue

        try:
            if objective == "nature":
                raw = await preset_fn(origin, destination, req.minutes, mode, fastest_duration)
            else:
                raw = await preset_fn(origin, destination, req.minutes, mode)
        except NoRouteFound as exc:
            log.info("preset_unroutable", extra={"objective": objective, "kind": exc.kind})
            metrics.incr("routes_blocked_total")
            routes.append(_blocked_route(objective, label, mode, exc.human_message))
            failures.append(exc)
            continue
        except RoutingError as exc:
            log.warning("preset_failed", extra={"objective": objective, "kind": exc.kind})
            metrics.incr("upstream_failures_total")
            failures.append(exc)
            if objective == "fastest":
                # Without the baseline there is nothing to show at all.
                raise
            routes.append(_blocked_route(objective, label, mode, exc.human_message))
            continue

        if objective == "fastest":
            fastest_duration = raw.duration_min
        routed.append((objective, label, raw))

    # Enrichment runs once for the whole request, over every route's geometry.
    # It is entirely best-effort: every field below may be None, and the
    # response says `null` rather than inventing a number.
    context = EnrichContext()
    if routed:
        context = await enrich_context([r.points for _, _, r in routed], req.depart_at)

    for objective, label, raw in routed:
        stops = (
            rest_stops_on_route(raw.points, context.rest_stop_nodes)
            if context.rest_stop_nodes is not None
            else None
        )
        route = _scored_route(objective, label, raw, stops, context.air, context.shade_score)
        if route.status == "blocked":
            metrics.incr("routes_blocked_total")
        routes.append(route)

    if not any(r.status == "ok" for r in routes):
        raise failures[0] if failures else NoRouteFound("No route could be found from there.")

    await _attach_narration(routes)

    # Preserve the caller's requested order in the response.
    order = {o: i for i, o in enumerate(objectives)}
    routes.sort(key=lambda r: order.get(r.id, 99))

    reason = None
    ok_routes = [r for r in routes if r.status == "ok"]
    if ok_routes and all(r.duration_min > req.minutes for r in ok_routes):
        reason = (
            f"Every route found is longer than your {req.minutes}-minute budget. "
            "The shortest option is shown first."
        )
    return routes, reason, context


@app.post("/api/routes")
async def post_routes(req: RouteRequest, request: Request, response: Response) -> Any:
    metrics.incr("route_requests_total")
    metrics.note_session(_client_ip(request), request.headers.get("user-agent"))

    decision = limiter.check(_client_ip(request))
    if not decision.allowed:
        metrics.incr("rate_limited_total")
        log.info("rate_limited", extra={"reason": decision.reason})
        return JSONResponse(
            status_code=429,
            content={"error": {"kind": decision.reason, "message": decision.message}},
            headers={"Retry-After": str(max(1, decision.retry_after_s))},
        )

    cache = get_cache()
    key = route_cache_key(req)
    cached = cache.get_route(key)
    if cached is not None:
        metrics.incr("cache_hits_total")
        limiter.refund(_client_ip(request))
        response.headers["X-Meander-Cache"] = "hit"
        return cached

    metrics.incr("cache_misses_total")

    try:
        routes, reason, context = await _build_routes(req)
    except RoutingError as exc:
        metrics.incr("upstream_failures_total")
        return _error(exc.kind, exc.human_message, exc.status_code)

    metrics.incr("daily_routes_served")
    payload = RoutesResponse(
        routes=routes,
        best_departure=(
            context.departure.when.isoformat() if context.departure else None
        ),
        reason=reason or (context.departure.reason if context.departure else None),
        cache=CacheInfo(segments_scored=cache.segment_count(), hit_rate=_hit_rate()),
    ).model_dump()

    cache.put_route(key, payload, settings.route_cache_ttl_s)
    response.headers["X-Meander-Cache"] = "miss"
    return payload


def _hit_rate() -> float:
    snap = metrics.snapshot()
    hits, misses = snap["cache_hits_total"], snap["cache_misses_total"]
    total = hits + misses
    return round(hits / total, 3) if total else 0.0


# ---------------------------------------------------------------------------
# geocode
# ---------------------------------------------------------------------------


@app.get("/api/geocode", response_model=GeocodeResponse)
async def geocode(q: str = Query(min_length=2, max_length=120)) -> Any:
    from .routing import GeocodeError
    from .routing import geocode_search as search

    try:
        results = await search(q)
    except GeocodeError as exc:
        return _error("geocode", exc.human_message, exc.status_code)
    return GeocodeResponse(results=results)


# ---------------------------------------------------------------------------
# health
# ---------------------------------------------------------------------------


@app.get("/api/health")
def health() -> dict[str, Any]:
    from .fixtures import budget_snapshot, fixture_inventory

    cache = get_cache()
    return {
        "status": "ok",
        "version": __version__,
        "clip_available": clip_available(),
        "fixture_mode": settings.fixture_mode,
        "missing_keys": settings.missing_keys(),
        "cache": cache.stats(),
        "live_call_budget": budget_snapshot(),
        "fixtures": fixture_inventory(),
        "counters": metrics.snapshot(),
        "rate_limit": {
            "per_ip_capacity": settings.per_ip_bucket_capacity,
            "per_ip_refill_per_min": settings.per_ip_refill_per_min,
            "daily_ceiling": settings.global_daily_route_ceiling,
            "served_today": limiter.served_today(),
        },
    }
