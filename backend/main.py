"""FastAPI application.

Contract: this module must return a usable response even when scoring and
enrichment both fail. Every optional subsystem is behind a degradation path, and
the response always states which scoring path produced its numbers.
"""

from __future__ import annotations

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
from .cache import get_cache
from .config import STRICT_STARTUP, settings
from .geometry import score_geometry
from .logging_setup import configure_logging, get_logger
from .metrics import metrics
from .models import (
    CacheInfo,
    GeocodeResponse,
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
from .scoring import ClipTerm, clip_term_for_route

configure_logging(settings.log_level)
log = get_logger(__name__)

limiter = RateLimiter(
    capacity=settings.per_ip_bucket_capacity,
    refill_per_min=settings.per_ip_refill_per_min,
    daily_ceiling=settings.global_daily_route_ceiling,
)

PLACEHOLDER_CONFIDENCE = 0.0

GEOMETRY_ONLY_NOTE = (
    "Accessibility data has not been evaluated for this route yet. "
    "Scenery is scored from the route's shape and its OpenStreetMap tags, not from imagery."
)
SYNTHETIC_NOTE = (
    "This route was built from demonstration data, not a live routing response. "
    "Every number on it is a placeholder, not a measurement."
)
CLIP_NOTE_TEMPLATE = (
    "Accessibility data has not been evaluated for this route yet. "
    "Scenery is scored from street-level imagery covering {pct}% of the route."
)


def _scoring_note(clip: ClipTerm) -> str:
    if clip.score is None:
        return GEOMETRY_ONLY_NOTE
    return CLIP_NOTE_TEMPLATE.format(pct=round(clip.coverage * 100))

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


def _scored_route(route_id: str, label: str, raw: RawRoute) -> Route:
    """Turn a routed path into a wire Route, scored as well as it honestly can be.

    A route built from a hand-authored fixture keeps `scoring_method:
    "placeholder"` even though the scoring maths ran: the maths is real but the
    geometry it ran on is not, and a number derived from invented terrain is not
    a measurement of anywhere.
    """
    # Cache read only — this never imports torch, and returns nothing for any
    # region batch_score.py has not pre-warmed.
    clip = clip_term_for_route(raw.points)
    scores = score_geometry(
        raw.points, raw.elevations or None, raw.details, clip_score=clip.score
    )
    synthetic = raw.synthetic_upstream

    if synthetic:
        method = "placeholder"
    elif clip.score is not None:
        method = "clip"
    else:
        method = "geometry_only"

    return Route(
        id=route_id,
        label=label,
        status="ok",
        geometry=geometry_for_wire(raw),
        duration_min=round(raw.duration_min, 1),
        distance_m=round(raw.distance_m),
        mode=raw.mode,
        # shade is null until enrich.py computes a real sun position — zero
        # shade would be a claim about the place rather than an absence of data.
        scores=Scores(nature=scores.nature, air=scores.air, shade=None),
        scoring_method=method,
        confidence=PLACEHOLDER_CONFIDENCE,
        synthetic_upstream=synthetic,
        confidence_note=SYNTHETIC_NOTE if synthetic else _scoring_note(clip),
    )


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


async def _build_routes(req: RouteRequest) -> tuple[list[Route], str | None]:
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
        routes.append(_scored_route(objective, label, raw))

    if not any(r.status == "ok" for r in routes):
        raise failures[0] if failures else NoRouteFound("No route could be found from there.")

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
    return routes, reason


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
        routes, reason = await _build_routes(req)
    except RoutingError as exc:
        metrics.incr("upstream_failures_total")
        return _error(exc.kind, exc.human_message, exc.status_code)

    metrics.incr("daily_routes_served")
    payload = RoutesResponse(
        routes=routes,
        best_departure=None,
        reason=reason,
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
