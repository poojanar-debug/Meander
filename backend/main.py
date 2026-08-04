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
import time
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from dataclasses import dataclass
from datetime import UTC
from typing import Any

from fastapi import FastAPI, Query, Request, Response
from fastapi.concurrency import run_in_threadpool
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, StreamingResponse

from . import __version__
from .accessibility import VERY_LOW_CONFIDENCE_THRESHOLD, assess_route
from .cache import get_cache
from .config import (
    REQUEST_DEADLINE_S,
    STRICT_STARTUP,
    path_details,
    self_hosted_resolution,
    settings,
)
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
    BarrierReport,
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
    # Startup runs on the event loop like everything else, and a large
    # route_cache makes this a multi-second stall before the first request.
    purged = await run_in_threadpool(cache.purge_expired_routes)
    # Logged explicitly because four behaviours hang off it and none of them
    # fails loudly when it is wrong — most importantly, a False here drops the
    # smoothness hard constraint and the app just gets quietly less safe. See
    # config.graphhopper_is_self_hosted().
    resolution = self_hosted_resolution()
    log.info(
        "startup",
        extra={
            "version": __version__,
            "fixture_mode": settings.fixture_mode,
            "clip_available": clip_available(),
            "missing_keys": missing,
            "routes_purged": purged,
            "cache_stats": await run_in_threadpool(cache.stats),
            "graphhopper_self_hosted": resolution["self_hosted"],
            "graphhopper_flag_source": resolution["source"],
            "path_details": path_details(),
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
            # depart_at drives best_departure, the air-quality hour index and
            # the shade score, so two requests differing only in departure time
            # are different answers. Without it they shared one cached payload
            # and the later one got the earlier one's departure advice for up to
            # the 6 hour TTL.
            #
            # Bucketed to the hour, which is the granularity best_departure and
            # the air-quality series actually use, and for the same reason the
            # coordinates above are rounded to 3 dp: an unrounded timestamp
            # would miss the cache on literally every request. Nothing sends
            # departAt today, so this is latent — until Phase 5.5 plumbs a real
            # timestamp through, at which point it stops being latent.
            "depart_at": _departure_bucket(req),
            "version": __version__,
        },
        sort_keys=True,
    )
    return hashlib.sha256(material.encode()).hexdigest()[:24]


def _departure_bucket(req: RouteRequest) -> str | None:
    """The departure hour, in UTC, or None when the caller did not ask for one."""
    if req.depart_at is None:
        return None
    when = req.depart_at
    if when.tzinfo is None:
        when = when.replace(tzinfo=UTC)
    return when.astimezone(UTC).strftime("%Y-%m-%dT%H")


@dataclass
class _Assessment:
    """The expensive, enrichment-independent half of scoring a route.

    Split out because a route is now emitted twice — once as soon as it is
    routed, once when enrichment lands — and assess_route() plus
    score_geometry() must not run twice for that.
    """

    scores: Any
    access: Any
    clip_score: float | None


def _assess(raw: RawRoute) -> _Assessment:
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
    return _Assessment(scores=scores, access=access, clip_score=clip_score)


def _scored_route(
    route_id: str,
    label: str,
    raw: RawRoute,
    rest_stops: list[EnrichRestStop] | None = None,
    air: AirQuality | None = None,
    shade: float | None = None,
    assessment: _Assessment | None = None,
    enrichment_pending: bool = False,
) -> Route:
    """Turn a routed path into a wire Route, scored as well as it honestly can be.

    A route built from a hand-authored fixture keeps `scoring_method:
    "placeholder"` even though the scoring maths ran: the maths is real but the
    geometry it ran on is not, and a number derived from invented terrain is not
    a measurement of anywhere.
    """
    if assessment is None:
        assessment = _assess(raw)
    scores, access, clip_score = assessment.scores, assessment.access, assessment.clip_score
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
        status_note=_status_note(route_id, blocked, access, raw),
        enrichment_pending=enrichment_pending,
    )


def _status_note(
    route_id: str, blocked: bool, access: Any, raw: RawRoute | None = None
) -> str | None:
    """Why a route is blocked — or, for the accessible route, why it is not a claim.

    A route with no recorded barriers is not a verified route: it is a route
    with nothing recorded against it. On the accessible objective specifically,
    that distinction is the whole point, so it is stated rather than left to the
    reader to infer from a percentage.
    """
    if blocked:
        return "Hard accessibility constraints reject this route."
    if raw is not None and raw.preset_note:
        return raw.preset_note
    if route_id != "accessible" or access is None:
        return None
    if access.coverage < VERY_LOW_CONFIDENCE_THRESHOLD:
        return (
            "No barriers were found, but almost nothing along this route has been "
            "recorded in OpenStreetMap. That is an absence of data, not a step-free route."
        )
    return None


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


async def route_events(req: RouteRequest) -> AsyncIterator[dict[str, Any]]:
    """Produce the whole response as a sequence of events.

    Both transports consume this: the SSE path forwards each event as it is
    produced, and the JSON path drains it and returns the final payload. One
    implementation, so a route cannot appear over one transport and not the
    other.

    A preset that cannot be routed becomes a ``blocked`` event. Only an
    entirely empty set is an error.
    """
    from .models import ROUTE_LABELS

    yield {"type": "progress", "pct": 5, "text": "Looking for routable roads", "segments_scored": 0}

    mode = effective_mode(req.mode, req.minutes)
    origin = req.origin.to_latlon()
    destination = req.destination.to_latlon() if req.destination else None
    objectives = req.resolved_objectives()

    routes: list[Route] = []
    routed: list[tuple[str, str, RawRoute]] = []
    fastest_route: RawRoute | None = None
    failures: list[RoutingError] = []

    # fastest first when present: nature's duration cap is relative to it.
    ordered = sorted(objectives, key=lambda o: 0 if o == "fastest" else 1)

    # `objectives` accepts any subset, so {"objectives": ["nature"]} is a valid
    # public request. Without this, fastest is never routed, route_nature gets
    # fastest=None, and **both** of its bars quietly switch off: the
    # NATURE_DURATION_CAP and the "must be greener than fastest" floor. Every
    # candidate then counts as acceptable and the winner ships labelled Nature
    # with no preset_note — a label with nothing behind it, which is exactly
    # what route_nature's own docstring says must never happen.
    #
    # So fastest is routed as a baseline whenever nature is asked for, and
    # simply not emitted as a route. It costs one request, which is ~24 ms
    # against a self-hosted router.
    if "nature" in objectives and "fastest" not in objectives:
        try:
            fastest_route = await PRESETS["fastest"](origin, destination, req.minutes, mode)
        except RoutingError as exc:
            # Not fatal: the caller did not ask for this route. route_nature
            # says on the card that the comparison could not be made.
            log.info("nature_baseline_unavailable", extra={"kind": exc.kind})

    async def _run(objective: str) -> tuple[str, RawRoute | None, RoutingError | None]:
        """Route one objective. Never raises; the caller decides what a failure means."""
        preset_fn = PRESETS[objective]
        try:
            if objective == "nature":
                return objective, await preset_fn(
                    origin, destination, req.minutes, mode, fastest_route
                ), None
            return objective, await preset_fn(origin, destination, req.minutes, mode), None
        except RoutingError as exc:
            return objective, None, exc

    def _record_failure(objective: str, label: str, exc: RoutingError) -> None:
        if isinstance(exc, NoRouteFound):
            log.info("preset_unroutable", extra={"objective": objective, "kind": exc.kind})
            metrics.incr("routes_blocked_total")
        else:
            log.warning("preset_failed", extra={"objective": objective, "kind": exc.kind})
            metrics.incr("upstream_failures_total")
        failures.append(exc)
        routes.append(_blocked_route(objective, label, mode, exc.human_message))

    # Objectives beyond the implemented three (quiet/shade/air) are not silently
    # dropped — the UI is told they are not available yet.
    for objective in ordered:
        if objective not in PRESETS:
            label = ROUTE_LABELS.get(objective, objective.title())
            routes.append(
                _blocked_route(objective, label, mode,
                               f"The {label.lower()} objective is not implemented yet.")
            )

    # fastest is routed alone and first. This ordering is load-bearing, not
    # stylistic: route_nature takes it and derives both the NATURE_DURATION_CAP
    # and the greenness floor from it. A flat gather over all three would pass
    # fastest=None and silently disable both — see test_nature_baseline.py.
    if "fastest" in objectives:
        yield {"type": "progress", "pct": 15, "text": "Routing the fastest way",
               "segments_scored": 0}
        _, raw, exc = await _run("fastest")
        if exc is not None:
            if not isinstance(exc, NoRouteFound):
                metrics.incr("upstream_failures_total")
                # Without the baseline there is nothing to show at all.
                raise exc
            _record_failure("fastest", ROUTE_LABELS.get("fastest", "Fastest"), exc)
        else:
            fastest_route = raw
            routed.append(("fastest", ROUTE_LABELS.get("fastest", "Fastest"), raw))

    # nature and accessible are independent of each other, so they go together.
    rest = [o for o in ordered if o in PRESETS and o != "fastest"]
    if rest:
        yield {"type": "progress", "pct": 35, "text": "Routing the other ways",
               "segments_scored": 0}
        for objective, raw, exc in await asyncio.gather(*(_run(o) for o in rest)):
            label = ROUTE_LABELS.get(objective, objective.title())
            if exc is not None:
                _record_failure(objective, label, exc)
            else:
                routed.append((objective, label, raw))

    # Preserve the caller's order rather than completion order.
    routed.sort(key=lambda item: ordered.index(item[0]))

    if not routed and not any(r.status == "ok" for r in routes):
        raise failures[0] if failures else NoRouteFound("No route could be found from there.")

    # --- first pass: emit every route the moment it exists -------------------
    #
    # Enrichment is the entire latency budget of a request — Overpass measured
    # 13.6 s against 0.024 s for a whole self-hosted route — and it is shared
    # across all three routes, so waiting for it meant nothing at all reached
    # the browser for up to fourteen seconds. The map can draw these now.
    #
    # enrichment_pending says plainly that air, shade and rest stops are not
    # yet measured, because `rest_stops` cannot be null and an empty list would
    # otherwise read as "we looked and found none".
    assessments: dict[str, _Assessment] = {}
    for objective, label, raw in routed:
        assessments[objective] = await run_in_threadpool(_assess, raw)
        route = _scored_route(
            objective, label, raw, None, None, None,
            assessment=assessments[objective], enrichment_pending=True,
        )
        if route.status == "blocked":
            metrics.incr("routes_blocked_total")
        yield {"type": "route", "route": route.model_dump()}

    for route in routes:
        if route.status == "blocked" and not route.geometry:
            yield {"type": "route", "route": route.model_dump()}

    yield {
        "type": "progress",
        "pct": 60,
        "text": "Checking surfaces, air and rest stops",
        "segments_scored": 0,
    }

    # --- second pass: the same routes, now enriched --------------------------
    #
    # Enrichment runs once for the whole request, over every route's geometry.
    # It is entirely best-effort: every field may be None, and the response says
    # `null` rather than inventing a number. The client merges route events by
    # id, which is the same mechanism narration already uses.
    context = EnrichContext()
    if routed:
        context = await enrich_context([r.points for _, _, r in routed], req.depart_at)

    cache = get_cache()
    for objective, label, raw in routed:
        stops = (
            await run_in_threadpool(rest_stops_on_route, raw.points, context.rest_stop_nodes)
            if context.rest_stop_nodes is not None
            else None
        )
        route = _scored_route(
            objective, label, raw, stops, context.air, context.shade_score,
            assessment=assessments.get(objective),
        )
        routes.append(route)
        yield {"type": "route", "route": route.model_dump()}

    if not any(r.status == "ok" for r in routes):
        raise failures[0] if failures else NoRouteFound("No route could be found from there.")

    # Narration arrives after the routes, as a second pass over the same ids.
    # The client merges by id rather than appending.
    yield {"type": "progress", "pct": 90, "text": "Writing the descriptions", "segments_scored": 0}
    await _attach_narration(routes)
    for route in routes:
        if route.narration:
            yield {"type": "route", "route": route.model_dump()}

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
    yield {
        "type": "done",
        "payload": RoutesResponse(
            routes=routes,
            best_departure=(
                context.departure.when.isoformat() if context.departure else None
            ),
            reason=reason or (context.departure.reason if context.departure else None),
            cache=CacheInfo(
                segments_scored=await run_in_threadpool(cache.segment_count),
                hit_rate=_hit_rate(),
            ),
        ).model_dump(),
    }


DEADLINE_NOTE = (
    "This took longer than expected, so what had been worked out is shown here. "
    "Air quality, shade and rest stops may be missing. Try again for the full picture."
)


async def route_events_with_deadline(
    req: RouteRequest, deadline_s: float | None = None
) -> AsyncIterator[dict[str, Any]]:
    """route_events, but it returns what it has rather than hanging.

    Nothing underneath this had an overall ceiling. Every upstream has its own
    timeout, but they compose: three enrichment fetches plus a routing pass each
    allowed HTTP_TIMEOUT_S is a worst case far past any proxy's idle timeout,
    and the user gets a dead connection instead of a partial answer.

    Everything below the routing itself is best-effort and already degrades to
    null, so a truncated response is a real response — it just has less on it,
    and says so.
    """
    deadline_s = REQUEST_DEADLINE_S if deadline_s is None else deadline_s
    partial: dict[str, dict[str, Any]] = {}
    agen = route_events(req).__aiter__()
    expires_at = time.monotonic() + deadline_s

    try:
        while True:
            remaining = expires_at - time.monotonic()
            if remaining <= 0:
                raise TimeoutError
            try:
                # wait_for rather than wrapping the loop in asyncio.timeout: the
                # clock must not run while this generator is suspended at a
                # yield waiting on a slow client.
                event = await asyncio.wait_for(agen.__anext__(), timeout=remaining)
            except StopAsyncIteration:
                return
            if event["type"] == "route":
                partial[event["route"]["id"]] = event["route"]
            yield event
    except TimeoutError:
        usable = [r for r in partial.values() if r.get("geometry")]
        log.warning(
            "request_deadline_exceeded",
            extra={"deadline_s": deadline_s, "routes_ready": len(usable)},
        )
        metrics.incr("request_deadline_exceeded_total")
        if not usable:
            yield {
                "type": "error",
                "kind": "timeout",
                "message": (
                    "This took too long and no route was ready in time. "
                    "Please try again."
                ),
            }
            return
        yield {
            "type": "done",
            "payload": RoutesResponse(
                routes=[Route(**r) for r in usable],
                best_departure=None,
                reason=DEADLINE_NOTE,
                cache=CacheInfo(segments_scored=0, hit_rate=_hit_rate()),
            ).model_dump(),
        }
    finally:
        await agen.aclose()


SSE_HEADERS = {
    "Cache-Control": "no-cache, no-transform",
    "Connection": "keep-alive",
    # Nginx and several proxies buffer streaming responses by default, which
    # turns SSE back into one slow document. This asks them not to.
    "X-Accel-Buffering": "no",
}


def _sse(event: dict[str, Any]) -> str:
    return f"data: {json.dumps(event, separators=(',', ':'))}\n\n"


def _wants_stream(request: Request) -> bool:
    return "text/event-stream" in (request.headers.get("accept") or "")


async def _stream(req: RouteRequest, cache_key: str) -> AsyncIterator[str]:
    """Forward each event as it is produced, and cache the final payload."""
    try:
        async for event in route_events_with_deadline(req):
            if event["type"] == "done":
                metrics.incr("daily_routes_served")
                await run_in_threadpool(
                    get_cache().put_route,
                    cache_key,
                    event["payload"],
                    settings.route_cache_ttl_s,
                )
            yield _sse(event)
    except RoutingError as exc:
        metrics.incr("upstream_failures_total")
        # The status line has already been sent, so the error has to travel as
        # an event. The client turns it back into its normal error banner.
        yield _sse({"type": "error", "kind": exc.kind, "message": exc.human_message})


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
    cached = await run_in_threadpool(cache.get_route, key)
    if cached is not None:
        metrics.incr("cache_hits_total")
        limiter.refund(_client_ip(request))
        if _wants_stream(request):
            # A cache hit still speaks SSE, so the client has one code path.
            async def replay() -> AsyncIterator[str]:
                for route in cached["routes"]:
                    yield _sse({"type": "route", "route": route})
                yield _sse({"type": "done", "payload": cached})

            return StreamingResponse(
                replay(),
                media_type="text/event-stream",
                headers={**SSE_HEADERS, "X-Meander-Cache": "hit"},
            )
        response.headers["X-Meander-Cache"] = "hit"
        return cached

    metrics.incr("cache_misses_total")

    if _wants_stream(request):
        return StreamingResponse(
            _stream(req, key),
            media_type="text/event-stream",
            headers={**SSE_HEADERS, "X-Meander-Cache": "miss"},
        )

    try:
        payload: dict[str, Any] | None = None
        async for event in route_events_with_deadline(req):
            if event["type"] == "done":
                payload = event["payload"]
    except RoutingError as exc:
        metrics.incr("upstream_failures_total")
        return _error(exc.kind, exc.human_message, exc.status_code)

    if payload is None:
        return _error("upstream", "No route could be produced for that request.", 502)

    metrics.incr("daily_routes_served")
    await run_in_threadpool(cache.put_route, key, payload, settings.route_cache_ttl_s)
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
# barrier reporting — OSM DEVELOPMENT SERVER ONLY
# ---------------------------------------------------------------------------


@app.post("/api/report-barrier")
async def report_barrier(report: BarrierReport, request: Request) -> Any:
    """File an obstruction as an OpenStreetMap note.

    **This writes to api06.dev.openstreetmap.org, the OSM development server,
    and never to production OSM.** The target is asserted at call time as well
    as configured, because a copy-paste that pointed this at production would
    put junk into the map everyone else relies on.
    """
    decision = limiter.check(_client_ip(request))
    if not decision.allowed:
        metrics.incr("rate_limited_total")
        return JSONResponse(
            status_code=429,
            content={"error": {"kind": decision.reason, "message": decision.message}},
            headers={"Retry-After": str(max(1, decision.retry_after_s))},
        )

    from .osm_report import BarrierReportError, submit_barrier

    try:
        note_id = await submit_barrier(report)
    except BarrierReportError as exc:
        return _error("barrier_report", exc.human_message, exc.status_code)

    return {
        "status": "submitted",
        "note_id": note_id,
        "target": "api06.dev.openstreetmap.org",
        "message": (
            "Thank you. This was filed on the OpenStreetMap development server, "
            "not the live map."
        ),
    }


# ---------------------------------------------------------------------------
# health
# ---------------------------------------------------------------------------


@app.get("/api/health")
def health() -> dict[str, Any]:
    from .fixtures import budget_regime, budget_snapshot, fixture_inventory

    cache = get_cache()
    from .config import GRAPHHOPPER_URL, graphhopper_is_self_hosted, path_details

    self_hosted = graphhopper_is_self_hosted()
    return {
        "status": "ok",
        "version": __version__,
        "clip_available": clip_available(),
        # Which routing server, and therefore whether the nature and accessible
        # presets can run at all — the hosted free tier cannot execute a custom
        # model, and that fact is otherwise only discoverable by getting a 400.
        "routing": {
            "endpoint": GRAPHHOPPER_URL,
            "self_hosted": self_hosted,
            # "hostname" here on a deployed instance means nobody set
            # MEANDER_GRAPHHOPPER_SELF_HOSTED and the answer was guessed from
            # the URL. If the router is behind a real name that guess is False,
            # and smoothness — a hard accessibility constraint — is silently
            # absent from path_details below.
            "self_hosted_source": self_hosted_resolution()["source"],
            "custom_models_available": self_hosted,
            "path_details": path_details(),
        },
        "fixture_mode": settings.fixture_mode,
        "missing_keys": settings.missing_keys(),
        "cache": cache.stats(),
        "live_call_budget": {**budget_regime(), **budget_snapshot()},
        "fixtures": fixture_inventory(),
        "counters": metrics.snapshot(),
        "rate_limit": {
            "per_ip_capacity": settings.per_ip_bucket_capacity,
            "per_ip_refill_per_min": settings.per_ip_refill_per_min,
            "daily_ceiling": settings.global_daily_route_ceiling,
            "served_today": limiter.served_today(),
        },
    }
