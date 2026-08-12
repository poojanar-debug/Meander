"""FastAPI application.

Contract: this module must return a usable response even when scoring and
enrichment both fail. Every optional subsystem is behind a degradation path, and
the response always states which scoring path produced its numbers.
"""

from __future__ import annotations

import asyncio
import contextlib
import hashlib
import importlib.util
import json
import time
import uuid
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from dataclasses import dataclass, replace
from datetime import UTC
from typing import Any

from fastapi import FastAPI, Query, Request, Response
from fastapi.concurrency import run_in_threadpool
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.responses import JSONResponse, StreamingResponse
from starlette.datastructures import Headers
from starlette.exceptions import HTTPException as StarletteHTTPException

from . import __version__
from .accessibility import VERY_LOW_CONFIDENCE_THRESHOLD, assess_route
from .cache import get_cache
from .config import (
    DRAIN_TIMEOUT_S,
    REQUEST_DEADLINE_S,
    STRICT_STARTUP,
    TRUSTED_PROXY_HOPS,
    path_details,
    self_hosted_resolution,
    settings,
)
from .coverage import message as coverage_message
from .coverage import outside_coverage, routable_extent, unroutable_point_message
from .elevation import build_profile
from .enrich import (
    AirQuality,
    EnrichContext,
    barrier_spans_on_route,
    enrich_context,
    rest_stops_on_route,
)
from .enrich import RestStop as EnrichRestStop
from .geometry import score_geometry
from .health import check_routing
from .logging_setup import configure_logging, get_logger, request_id_var
from .metrics import metrics
from .models import (
    BarrierReport,
    Blocker,
    CacheInfo,
    ElevationProfile,
    GeocodeResponse,
    GeocodeResult,
    RestStop,
    Route,
    RouteRequest,
    RoutesResponse,
    Scores,
    Step,
    effective_mode,
)
from .ratelimit import RateLimiter
from .routing import (
    PRESETS,
    NoRouteFound,
    OutsideCoverage,
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

# Place search gets its own bucket, and this is the whole of the fix for a
# type-ahead that ran out mid-word.
#
# One limiter served /api/routes, /api/geocode and /api/report-barrier on the
# same per-IP key. Measured: a 20-character name at 40 wpm costs a mean of 8.6
# geocode requests at the old 300 ms debounce, so **two place names come to 17.1
# against a capacity of 12** — the bucket is empty before the first route
# request is made, and that request is refused too, with routing copy
# ("That is a lot of routes in a short time") shown under the place box.
#
# The daily ceiling is deliberately passed through unchanged so that
# `served_today` stays one global number counting routes. /api/geocode already
# called `check(counts_against_ceiling=False)`, and this limiter never gets a
# call that does, so nothing here can add to it.
geocode_limiter = RateLimiter(
    capacity=settings.geocode_bucket_capacity,
    refill_per_min=settings.geocode_refill_per_min,
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

# Every legitimate request is two coordinates and a few scalars.
MAX_BODY_BYTES = 64 * 1024


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
    """Warn on the completeness list; refuse to boot only on the required one.

    These are two different questions and this function used to answer both with
    missing_keys(). That is the *completeness* list, and it names MAPILLARY_TOKEN
    and ANTHROPIC_API_KEY whenever they are unset — neither of which is needed to
    serve a route. CLIP is cache-read-only in the deploy image and narration is
    skipped without a key, which is exactly what missing_required_keys() says in
    its own docstring.

    The consequence was a boot loop in the one configuration most likely to hit
    it: .env.example:75 tells you to set MEANDER_STRICT_STARTUP in production and
    infra/20-services.yaml:272 does, so a deployment with no Mapillary or
    Anthropic key — the normal case, and the documented free-tier one — would
    refuse to start while being perfectly able to answer.

    /readyz already used the required list. Only the boot decision did not.
    """
    missing = settings.missing_keys()
    required = settings.missing_required_keys()

    if required and STRICT_STARTUP:
        raise RuntimeError(
            "Missing API keys: " + ", ".join(required) + ". "
            "Copy .env.example to .env and fill them in, or run with "
            "MEANDER_FIXTURES=replay to work entirely from recorded fixtures."
        )
    if missing:
        log.warning("startup_missing_keys", extra={"missing_keys": missing})
    return missing


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    # Module state, so it survives a previous run of this app object — which
    # happens in tests, and would happen to anything that restarts the app
    # in-process. Left set, every stream would immediately answer
    # "this server is restarting".
    global _open_streams
    _shutting_down.clear()
    _open_streams = 0

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

    # ECS sends SIGTERM and then SIGKILL. Everything below happens inside that
    # window, so it is ordered by how bad losing it would be.
    from .fixtures import aclose_client

    # 1. Tell in-flight streams to stop. They check between events and emit a
    #    `shutting_down` error frame, so a client gets an explanation instead of
    #    a connection cut from under it mid-response.
    _shutting_down.set()
    for _ in range(int(DRAIN_TIMEOUT_S / 0.25)):
        if _open_streams == 0:
            break
        await asyncio.sleep(0.25)
    if _open_streams:
        log.warning("shutdown_streams_still_open", extra={"count": _open_streams})

    # 2. The httpx client, so nothing is mid-flight to an upstream.
    await aclose_client()

    # 3. The cache. Cache.close() existed and had no caller anywhere, so the
    #    thread-local sqlite connections were never closed — which is also the
    #    leak a long-running load test would have found.
    try:
        get_cache().close()
    except Exception as exc:  # noqa: BLE001 — shutdown must not raise
        log.warning("cache_close_failed", extra={"error": type(exc).__name__})

    log.info("shutdown", extra={"streams_open_at_exit": _open_streams})


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
    # Without this a cross-origin browser cannot read any of them at all, which
    # is why ApiError.retryAfter in frontend/src/api/client.js has always been 0
    # and the backoff logic behind it has never once run. A split deployment —
    # CloudFront for the site, an ALB for the API — is cross-origin by
    # construction, so this is the normal case rather than an edge one.
    expose_headers=["Retry-After", "X-Meander-Cache", "X-Request-Id"],
    max_age=600,
)


class ConditionalGZip:
    """GZip everything except a stream.

    Starlette's GZipMiddleware does **not** leave streaming responses alone —
    measured here, it happily returned `content-encoding: gzip` on a
    text/event-stream response. Compression buffers, and a buffered stream is
    not a stream: the whole point of the SSE path is that a route reaches the
    browser at 30 ms instead of 12 s.

    Decided on the *request's* Accept header rather than the response's content
    type, because by the time a content type is known the response wrapper has
    already been installed.
    """

    def __init__(self, app: Any, **kwargs: Any) -> None:
        self.app = app
        self.gzip = GZipMiddleware(app, **kwargs)

    async def __call__(self, scope: Any, receive: Any, send: Any) -> None:
        if scope["type"] == "http":
            accept = Headers(scope=scope).get("accept", "")
            if "text/event-stream" in accept:
                await self.app(scope, receive, send)
                return
        await self.gzip(scope, receive, send)


app.add_middleware(ConditionalGZip, minimum_size=1024, compresslevel=5)


@app.exception_handler(RequestValidationError)
async def validation_error(request: Request, exc: RequestValidationError) -> JSONResponse:
    """One error shape for the whole API.

    FastAPI's default is {"detail": [...]} while everything else here answers
    {"error": {"kind", "message"}}, so the frontend carried a special case for
    exactly one status code — and docs/API.md documented the FastAPI shape,
    which meant the documented contract and the real one disagreed depending on
    which endpoint you read.
    """
    first = (exc.errors() or [{}])[0]
    location = ".".join(str(p) for p in first.get("loc", ()) if p != "body")
    message = first.get("msg", "That request was not valid.")
    return JSONResponse(
        status_code=422,
        content={
            "error": {
                "kind": "invalid_request",
                "message": f"{location}: {message}" if location else message,
            }
        },
    )


@app.exception_handler(StarletteHTTPException)
async def http_error(request: Request, exc: StarletteHTTPException) -> JSONResponse:
    return JSONResponse(
        status_code=exc.status_code,
        content={"error": {"kind": "http_error", "message": str(exc.detail)}},
        headers=getattr(exc, "headers", None),
    )


@app.exception_handler(Exception)
async def unhandled_error(request: Request, exc: Exception) -> JSONResponse:
    """Anything nobody anticipated, in the shape every other error here has.

    Without this, an exception that is not a RoutingError escaped `post_routes`
    entirely and Starlette rendered it as `text/plain` 500 "Internal Server
    Error" — not the `{"error": {"kind", "message"}}` envelope this endpoint's
    own error handling exists to guarantee, and not what
    `frontend/src/api/client.js` parses. The client fell back to "The server
    returned 500", which is what it says when it could not read the body at all.

    SSE handled the same case correctly, so the two transports for one endpoint
    disagreed about the shape of a failure as well as its kind.

    The message is deliberately generic. The detail goes to the log, which is
    scrubbed; the caller gets something true and useless to an attacker.
    """
    metrics.incr("unhandled_errors_total")
    log.exception("unhandled_error", extra={"path": request.url.path})
    return JSONResponse(
        status_code=500,
        content={
            "error": {
                "kind": "internal",
                "message": "Something went wrong on our side. Please try again.",
            }
        },
    )


def _too_large(request: Request) -> JSONResponse:
    """413, carrying the CORS headers the middleware below it never got to add.

    This middleware sits *outside* CORSMiddleware, so a response returned from
    here short-circuits before CORS runs. Measured: a 200 KB body with an
    `Origin:` header came back 413 with no `Access-Control-Allow-Origin`, which
    a browser reports to the page as a generic network failure — so the
    carefully worded message was unreadable by the only client that would ever
    see it. The deployment is cross-origin by construction (`*.pages.dev` ->
    `meander-app.duckdns.org`), so this is the normal path, not an edge case.

    The 429 in post_routes gets this right for free by being inside the router.
    Rather than reorder the middleware stack — which would change the gzip and
    request-id ordering too — this reflects the one header that matters, and
    only for an origin already on the allowlist.
    """
    headers = {}
    origin = request.headers.get("origin")
    allowed = settings.allowed_origins
    if origin and (origin in allowed or "*" in allowed):
        headers["Access-Control-Allow-Origin"] = origin
        headers["Vary"] = "Origin"
    return JSONResponse(
        status_code=413,
        content={
            "error": {
                "kind": "payload_too_large",
                "message": "That request body is too large.",
            }
        },
        headers=headers,
    )


@app.middleware("http")
async def limit_body_size(request: Request, call_next: Any) -> Response:
    """Reject an oversized body before it is parsed.

    Every legitimate request here is two coordinates and a handful of scalars —
    a few hundred bytes. Without a ceiling, an unauthenticated caller can make
    the service buffer as much as it likes.

    `Content-Length` alone was not a ceiling. A chunked request declares no
    length, so the check never fired: measured, 256 KB with a declared length
    returned 413 while **the same bytes sent chunked reached the JSON parser**,
    and a 5 MB chunked body was buffered and parsed in full.

    Caddy's `request_body max_size 64KB` covers the four allowlisted paths in
    the VM deploy, but `infra/20-services.yaml` runs this container behind an
    ALB with no Caddy and no body limit, so the bypass is live in the AWS path.
    A limit the application states should not depend on which edge is in front
    of it.

    So the body is counted as it arrives. The stream is consumed here and
    replayed downstream, which is the only way to bound something whose size is
    not declared until it has all arrived.
    """
    declared = request.headers.get("content-length")
    if declared and declared.isdigit() and int(declared) > MAX_BODY_BYTES:
        return _too_large(request)

    if request.method in {"POST", "PUT", "PATCH"} and not declared:
        body = b""
        async for chunk in request.stream():
            body += chunk
            if len(body) > MAX_BODY_BYTES:
                return _too_large(request)

        # The stream is now spent, so downstream is given one that replays what
        # was read. Without this the handler sees an empty body.
        async def replay() -> dict[str, Any]:
            return {"type": "http.request", "body": body, "more_body": False}

        request._receive = replay  # the documented way to re-feed a consumed body

    return await call_next(request)


@app.middleware("http")
async def request_context(request: Request, call_next: Any) -> Response:
    """One id per request, on every log line it produces, and back in a header.

    logging_setup disables uvicorn's access log — it echoes client IPs — and
    replaced it with nothing at all, so a deployed instance had no per-request
    record whatsoever. This is that record: method, path, status, duration,
    request id, cache hit or miss. **No IP and no coordinates**, which is why
    uvicorn's was turned off in the first place.

    An inbound X-Amzn-Trace-Id is honoured so a line here can be joined to an
    ALB access log entry without correlating on timestamps.
    """
    incoming = request.headers.get("x-amzn-trace-id") or request.headers.get("x-request-id")
    request_id = incoming or uuid.uuid4().hex[:16]
    token = request_id_var.set(request_id)
    started = time.monotonic()
    try:
        response = await call_next(request)
    except Exception:
        log.exception(
            "request_failed",
            extra={
                "method": request.method,
                "path": request.url.path,
                "duration_ms": round((time.monotonic() - started) * 1000, 1),
            },
        )
        request_id_var.reset(token)
        raise

    duration_ms = round((time.monotonic() - started) * 1000, 1)
    response.headers["X-Request-Id"] = request_id
    # Probes are the overwhelming majority of requests on a load-balanced
    # service and say nothing; logging them buries everything that does.
    if request.url.path not in ("/healthz", "/readyz"):
        log.info(
            "request",
            extra={
                "method": request.method,
                "path": request.url.path,
                "status": response.status_code,
                "duration_ms": duration_ms,
                "cache": response.headers.get("X-Meander-Cache"),
            },
        )
    request_id_var.reset(token)
    return response


# SSE carries its error inside a 200 body, so the kind is the whole of what it
# says. The JSON transport has to turn that same kind into a status line, and
# these are the only kinds route_events_with_deadline and _stream can produce.
# Anything unlisted falls back to 502, which is the honest default for "an
# upstream did not give us an answer".
_STATUS_FOR_ERROR_KIND: dict[str, int] = {
    "timeout": 504,
    "shutting_down": 503,
    "internal": 500,
}


def _error(kind: str, message: str, status: int) -> JSONResponse:
    return JSONResponse(status_code=status, content={"error": {"kind": kind, "message": message}})


def _client_ip(request: Request) -> str | None:
    """Read the client address for rate limiting only.

    The value is passed straight into a salted digest and never stored, logged
    or returned.

    **Read from the right, never the left.** X-Forwarded-For is appended to by
    each proxy, so the rightmost entries are the ones your own infrastructure
    added and the leftmost are whatever the client sent. Taking
    ``split(",")[0]`` meant a client could send its own X-Forwarded-For, land
    first in the list, and get a fresh token bucket on every single request —
    which is the entire rate limiter defeated by one header.

    With one trusted proxy a spoofed request arrives as ``1.2.3.4, <real
    client>``: ``parts[-1]`` is the address the proxy observed and ``parts[-2]``
    is the attacker's invention.

    ``MEANDER_TRUSTED_PROXY_HOPS`` is how many proxies of your own sit in front
    of this service. It defaults to **0**, which ignores the header completely
    and uses the socket peer — the only safe default, because trusting a hop
    that is not there is a bypass while distrusting one that is there is merely
    a shared bucket. **A deployment behind an ALB must set it to 1**, or every
    client shares one bucket and the service rate-limits itself as a whole.
    """
    hops = TRUSTED_PROXY_HOPS
    peer = request.client.host if request.client else None
    if hops <= 0:
        return peer

    forwarded = request.headers.get("x-forwarded-for")
    if not forwarded:
        return peer
    parts = [p.strip() for p in forwarded.split(",") if p.strip()]
    if not parts:
        return peer
    if len(parts) < hops:
        # Shorter than configured: something is not appending. Fall back to the
        # socket peer rather than trusting a client-controlled entry.
        return peer
    return parts[-hops]


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
            # None for a point-to-point trip, where the time budget is not an
            # input to the answer. Keying on it there split one answer across as
            # many rows as the dial has positions: the same two places at 30 and
            # at 35 minutes produce byte-identical payloads and used to miss the
            # cache and spend a fresh set of routing credits every time.
            "minutes": req.budget_minutes(),
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


def geocode_cache_key(q: str) -> str:
    """The normalised query, hashed.

    Case-folded and whitespace-collapsed so that "Kandy", "kandy " and
    "  Kandy" are one row rather than three. That normalisation is worth less
    than it looks — measured against the 12-query burst recorded in
    `fixtures/nominatim/`, case-folding still gives 12 distinct keys — and the
    case the cache actually serves is a user deleting characters and typing them
    back, which produces the *same* key by construction.

    Hashed rather than stored verbatim, for the reason the route key is: a place
    name a user typed is theirs, and a cache file that is baked into the
    published image should not be a list of what people searched for. The
    hashing is not a security control — the key space is guessable — it just
    means the file does not read as a log.
    """
    material = " ".join(q.strip().split()).casefold()
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
    """The expensive half of scoring a route.

    Split out because a route is now emitted twice — once as soon as it is
    routed, once when enrichment lands — and assess_route() plus
    score_geometry() must not run twice for that.

    "Enrichment-independent" until barriers were wired: the barrier constraint
    reads OSM nodes that only the Overpass call has, so the accessibility half
    *is* re-run on the second pass, and only that half. See
    _reassess_with_barriers.
    """

    scores: Any
    access: Any
    clip_score: float | None
    elevation: Any = None


def _assess(raw: RawRoute, osm_tags: dict[str, Any] | None = None) -> _Assessment:
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
    access = _guard(
        "accessibility", assess_route, raw.points, raw.elevations or None, raw.details,
        osm_tags=osm_tags,
    )
    # Same input, same threshold, computed in the same place as the verdict.
    profile = _guard("elevation_profile", build_profile, raw.points, raw.elevations or None)
    return _Assessment(
        scores=scores, access=access, clip_score=clip_score, elevation=profile
    )


def _reassess_with_barriers(
    assessment: _Assessment, raw: RawRoute, spans: list[tuple[int, int, str]]
) -> _Assessment:
    """The first pass's assessment, with the barrier constraint actually applied.

    Only the accessibility half is redone. The CLIP lookup, the geometry scoring
    and the elevation profile read nothing that enrichment provides, and
    repeating them would cost a cache round trip and a numpy pass per route to
    arrive at the same numbers.

    A route can go from `ok` to `blocked` here, and that is the point: until
    this ran, `REJECTED_BARRIERS` could never fire on the request path at all,
    so a route through a kissing gate came back ok with confidence 1.0. The
    client merges route events by id, so the second event corrects the first.
    """
    access = _guard(
        "accessibility", assess_route, raw.points, raw.elevations or None, raw.details,
        osm_tags={"barrier": spans},
    )
    return replace(assessment, access=access) if access is not None else assessment


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
        elevation=(
            ElevationProfile(**vars(assessment.elevation)) if assessment.elevation else None
        ),
        rest_stops=None if rest_stops is None else [
            RestStop(lat=s.lat, lon=s.lon, type=s.type, at_m=s.at_m)
            for s in (rest_stops or [])
        ],
        steps=[
            Step(
                text=st.text,
                distance_m=round(st.distance_m, 1),
                duration_min=round(st.duration_min, 2),
                street_name=st.street_name,
                sign=st.sign,
                interval=list(st.interval),
            )
            for st in raw.steps
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

    mode = effective_mode(req.mode, req.minutes, req.straight_line_m())
    origin = req.origin.to_latlon()
    destination = req.destination.to_latlon() if req.destination else None
    objectives = req.resolved_objectives()

    # Asked before routing rather than after failing. GraphHopper's own answer
    # for a point outside the graph is "Cannot find point", which routing.py
    # renders as "try moving the start a little" — right for a point in a lake,
    # actively misleading for a city this deployment did not import.
    for point in (origin, destination):
        if point is None:
            continue
        extent = await outside_coverage(point.lat, point.lon)
        if extent is not None:
            log.info("outside_coverage")
            raise OutsideCoverage(coverage_message(extent))

    async def _best_failure(failures: list[RoutingError]) -> RoutingError:
        """The failure to surface, with the coverage caveat when it applies.

        The pre-flight check above catches a point outside the graph's *bounding
        box*. That box is a union: the `demo` region set is three separate
        extracts spanning Sri Lanka to Britain, so Paris and Berlin sit inside
        the rectangle and inside none of the boxes. They pass the check, reach
        the router, and come back "Cannot find point" — which used to be
        rendered as "try moving the start a little", the exact sentence
        coverage.py exists to prevent, arriving by the one path it cannot see.

        Upgraded only when the router actually has a finite extent. Against the
        hosted API, which has the planet, "Cannot find point" really does mean a
        lake and the original advice is right.
        """
        failure = failures[0] if failures else NoRouteFound("No route could be found from there.")
        if not getattr(failure, "point_not_snappable", False):
            return failure
        extent = await routable_extent()
        if extent is None:
            return failure
        log.info("unroutable_point_on_a_finite_graph")
        return OutsideCoverage(unroutable_point_message(extent))

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
        raise await _best_failure(failures)

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
        assessment = assessments.get(objective)
        # None means Overpass could not be reached, or answered with a truncated
        # set we cannot treat as a survey. Either way nobody looked, so the
        # first pass's assessment stands — barriers_checked stays false and the
        # sentence keeps saying gates and stiles were not checked. Absence of
        # data must never arrive as absence of barriers.
        if assessment is not None and context.barrier_nodes is not None:
            spans = await run_in_threadpool(
                barrier_spans_on_route, raw.points, context.barrier_nodes
            )
            assessment = await run_in_threadpool(
                _reassess_with_barriers, assessment, raw, spans
            )
        route = _scored_route(
            objective, label, raw, stops, context.air, context.shade_score,
            assessment=assessment,
        )
        routes.append(route)
        yield {"type": "route", "route": route.model_dump()}

    if not any(r.status == "ok" for r in routes):
        raise await _best_failure(failures)

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
    budget = req.budget_minutes()
    ok_routes = [r for r in routes if r.status == "ok"]
    # Only a loop has a budget to overrun. Asked of a point-to-point trip this
    # said "longer than your 35-minute budget" about a journey whose length the
    # destination fixes — the user chose the other end, not the duration, and
    # there is no shorter option to show them first.
    if budget is not None and ok_routes and all(r.duration_min > budget for r in ok_routes):
        reason = (
            f"Every route found is longer than your {budget}-minute budget. "
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

    The clock measures time spent *producing* events, not wall-clock time from
    the first one. See the comment on `remaining`.
    """
    deadline_s = REQUEST_DEADLINE_S if deadline_s is None else deadline_s
    partial: dict[str, dict[str, Any]] = {}
    agen = route_events(req).__aiter__()
    # A budget that is spent, not a wall-clock instant that passes.
    #
    # This used to be `expires_at = time.monotonic() + deadline_s`, recomputed
    # each turn — so every second suspended at `yield event`, waiting for a
    # slow client to accept the write, came out of the time allowed for
    # *producing* the answer. The docstring below asserted the opposite, in as
    # many words, and had done since it was written.
    #
    # Reproduced with an instantaneous producer, a consumer taking 0.1 s per
    # event and a 0.3 s deadline: it timed out on the consumer alone, having
    # done no work slowly at all. The deadline exists to bound how long this
    # service will spend on a request, and a phone on a train is not this
    # service being slow. Combined with the caching of partial answers, one slow
    # client used to poison the shared cache for everyone behind that key.
    remaining = deadline_s

    try:
        while True:
            if remaining <= 0:
                raise TimeoutError
            started = time.monotonic()
            try:
                # wait_for, and here the cancellation it performs is wanted: a
                # deadline that does not stop the work is not a deadline. (The
                # keepalive in _stream wants the opposite, and uses asyncio.wait
                # for exactly that reason.)
                event = await asyncio.wait_for(agen.__anext__(), timeout=remaining)
            except StopAsyncIteration:
                return
            finally:
                # Charged before the yield below, so only the producer's time is
                # ever deducted.
                remaining -= time.monotonic() - started
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


# Long enough not to be chatter, short enough to beat a 60 s proxy idle
# timeout. There is otherwise a silent gap between the 60% progress event and
# the enriched routes that can exceed one.
KEEPALIVE_S = 15.0

# Set by lifespan on SIGTERM so in-flight streams can say goodbye rather than
# having the connection cut from under them.
_shutting_down = asyncio.Event()
_open_streams = 0


async def _stream(req: RouteRequest, cache_key: str) -> AsyncIterator[str]:
    """Forward each event as it is produced, and cache the final payload.

    Three things this has to survive that it previously did not.

    **Anything that is not a RoutingError.** A sqlite3.OperationalError from
    put_route or a pydantic error in model_dump escaped mid-stream, the client
    got a truncated response with no error event, and the frontend resolved to
    null — an empty screen with no explanation.

    **A client that goes away.** A disconnect at 90% cancelled the generator and
    threw away every GraphHopper call the request had made, caching nothing.

    **A long silence.** Nothing was written between the 60% progress event and
    the first enriched route, which on a slow Overpass is long enough for a
    proxy to close an idle connection.
    """
    global _open_streams
    _open_streams += 1
    agen = route_events_with_deadline(req).__aiter__()
    finished: dict[str, Any] | None = None
    cached = False
    # The in-flight pull, held across keepalive frames. See the loop below for
    # why it is a task and not a bare await.
    pending: asyncio.Task[dict[str, Any]] | None = None

    try:
        while True:
            if _shutting_down.is_set():
                yield _sse({
                    "type": "error",
                    "kind": "shutting_down",
                    "message": (
                        "This server is restarting. Your request was not finished — "
                        "please try again in a moment."
                    ),
                })
                return

            # asyncio.wait, not asyncio.wait_for. wait_for *cancels* what it is
            # waiting on when the timeout fires, and what it was waiting on here
            # is the generator producing the answer — so the keepalive killed
            # the request it exists to keep alive. The generator took the
            # CancelledError at whatever await it was suspended on, and the next
            # __anext__() then raised StopAsyncIteration, which this loop reads
            # as a clean end of stream: the client got a truncated response with
            # a `progress` event and no `done`, no error, and nothing cached.
            #
            # Measured on a three-event generator with a 300 ms middle stage
            # against a 50 ms keepalive: the old loop delivered 1 of 3 events
            # and reported success; the new one delivers 3 of 3 with 5
            # keepalives in between. Any stage slower than KEEPALIVE_S triggers
            # it, which is exactly the slow-Overpass case the keepalive was
            # added for.
            #
            # asyncio.wait leaves a timed-out task running, so the same pull is
            # still in flight on the next turn of the loop and is awaited again.
            if pending is None:
                pending = asyncio.ensure_future(agen.__anext__())
            done, _ = await asyncio.wait({pending}, timeout=KEEPALIVE_S)
            if not done:
                # A comment frame. SSE clients ignore it; proxies see traffic.
                yield ": keepalive\n\n"
                continue
            try:
                event = pending.result()
            except StopAsyncIteration:
                return
            finally:
                pending = None

            if event["type"] == "done":
                finished = event["payload"]
                await run_in_threadpool(
                    get_cache().put_route, cache_key, finished, settings.route_cache_ttl_s
                )
                cached = True
            yield _sse(event)

    except asyncio.CancelledError:
        # The client hung up. If the answer was already computed, keep it —
        # every GraphHopper call behind it has been paid for either way.
        if finished is not None and not cached:
            try:
                await run_in_threadpool(
                    get_cache().put_route, cache_key, finished, settings.route_cache_ttl_s
                )
            except Exception:  # noqa: BLE001 — never mask the cancellation
                log.warning("partial_cache_failed")
        metrics.incr("client_disconnects_total")
        log.info("stream_cancelled", extra={"had_result": finished is not None})
        raise
    except RoutingError as exc:
        metrics.incr("upstream_failures_total")
        # The status line has already been sent, so the error has to travel as
        # an event. The client turns it back into its normal error banner.
        yield _sse({"type": "error", "kind": exc.kind, "message": exc.human_message})
    except Exception:
        metrics.incr("stream_failures_total")
        log.exception("stream_failed")
        yield _sse({
            "type": "error",
            "kind": "internal",
            "message": "Something went wrong while building your routes. Please try again.",
        })
    finally:
        _open_streams -= 1
        # Cancelling here is correct where cancelling on timeout was not: this
        # runs only once nothing further will be read, so there is no work left
        # to protect. Without it a pull still in flight outlives the stream and
        # asyncio reports "Task was destroyed but it is pending".
        #
        # It has to be *awaited*, not just cancelled. cancel() only schedules
        # the CancelledError; until the task has actually taken it the generator
        # is still running, and aclose() on a running async generator raises
        # "RuntimeError: aclose(): asynchronous generator is already running" —
        # which the disconnect test caught, because a client hanging up mid-pull
        # is precisely when this path runs.
        if pending is not None:
            pending.cancel()
            with contextlib.suppress(BaseException):
                await pending
        await agen.aclose()


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

    # Counted and drained like a stream, because it is one — just one the client
    # sees as a single body. Without this a JSON request in flight at SIGTERM was
    # invisible to the drain loop in lifespan, which waited only on _open_streams
    # and then let the process exit from under it.
    global _open_streams
    _open_streams += 1
    try:
        payload: dict[str, Any] | None = None
        failure: dict[str, Any] | None = None
        async for event in route_events_with_deadline(req):
            if _shutting_down.is_set():
                return _error(
                    "shutting_down",
                    "This server is restarting. Your request was not finished — "
                    "please try again in a moment.",
                    503,
                )
            if event["type"] == "done":
                payload = event["payload"]
            # **The error event used to be dropped on the floor here.** The loop
            # looked only for "done", so a deadline that produced nothing left
            # `payload` as None and fell through to the generic 502 below: the
            # client was told "No route could be produced for that request" with
            # kind "upstream" when SSE, for the identical request, said kind
            # "timeout" and explained that the request had run out of time. Two
            # transports for one endpoint disagreeing about what happened.
            elif event["type"] == "error":
                failure = event
    except RoutingError as exc:
        metrics.incr("upstream_failures_total")
        return _error(exc.kind, exc.human_message, exc.status_code)
    finally:
        _open_streams -= 1

    if payload is None and failure is not None:
        return _error(
            failure["kind"], failure["message"], _STATUS_FOR_ERROR_KIND.get(failure["kind"], 502)
        )
    if payload is None:
        return _error("upstream", "No route could be produced for that request.", 502)

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
async def geocode(request: Request, q: str = Query(min_length=2, max_length=120)) -> Any:
    """Place search, proxied to Nominatim.

    Rate-limited, but on `geocode_limiter` rather than the shared one. It was
    previously unauthenticated **and unlimited**, and Nominatim's usage policy is
    one request per second enforced by banning the offending IP — which here is
    this service's egress address, so one script pointed at /api/geocode gets
    place search banned for every user of the deployment, not for the script.
    Putting it on the route bucket fixed that and created a different failure:
    two place names spent more tokens than the bucket held, so the route request
    that followed was refused. See `geocode_limiter` for the measurement.

    Answers are cached for a week. A name-to-coordinate mapping embeds none of
    the weather, daylight or air quality that makes a route payload go stale in
    six hours, and the case this actually serves is backspacing and re-typing:
    of the 12 distinct queries in the recorded burst in `fixtures/nominatim/`,
    case-folding gives 12 distinct keys, so normalisation alone saves almost
    nothing. What saves is that a user who deletes three characters and puts
    them back asks the same question twice.
    """
    decision = geocode_limiter.check(_client_ip(request), counts_against_ceiling=False)
    if not decision.allowed:
        metrics.incr("rate_limited_total")
        return JSONResponse(
            status_code=429,
            content={"error": {"kind": decision.reason, "message": decision.message}},
            headers={"Retry-After": str(max(1, decision.retry_after_s))},
        )

    from .routing import GeocodeError
    from .routing import geocode_search as search

    cache = get_cache()
    key = geocode_cache_key(q)
    cached = await run_in_threadpool(cache.get_geocode, key)
    if cached is not None:
        # Refunded exactly as a route cache hit is: an answer that cost no
        # upstream call must not cost a token, or the limiter charges for its
        # own cache.
        geocode_limiter.refund(_client_ip(request))
        metrics.incr("cache_hits_total")
        return GeocodeResponse(results=[GeocodeResult(**item) for item in cached])

    metrics.incr("cache_misses_total")
    try:
        results = await search(q)
    except GeocodeError as exc:
        response = _error("geocode", exc.human_message, exc.status_code)
        # Carried through only when the upstream said 429. Everything else has
        # no number to give and must not invent one.
        if exc.retry_after_s is not None:
            response.headers["Retry-After"] = str(max(1, exc.retry_after_s))
        return response

    # An empty result is cached too. "Nowhere is called that" is an answer, and
    # re-asking Nominatim for it on every keystroke of a misspelling is exactly
    # the traffic this is here to stop.
    await run_in_threadpool(
        cache.put_geocode,
        key,
        [item.model_dump() for item in results],
        settings.geocode_cache_ttl_s,
    )
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
    decision = limiter.check(_client_ip(request), counts_against_ceiling=False)
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
# health and metrics
# ---------------------------------------------------------------------------


@app.get("/metrics")
async def prometheus_metrics() -> Response:
    """Aggregate counters in Prometheus text exposition format.

    **Every series here is a whole-instance total with no labels, and that is
    the privacy design rather than an omission.** A `path`, `region` or
    `status` label would turn this into a low-cardinality description of who
    asked for what and when, and a coordinate label would be unthinkable. What
    it exports is exactly what `/api/health` already reports to anyone —
    `metrics.py` never holds a request attribute in the first place, so there
    is nothing here that could be labelled even by mistake.

    `unique_sessions_today` comes from a digest keyed by a salt generated at
    process start and never written down, so it cannot be joined to yesterday's
    figure or to anything outside this process.

    Unauthenticated, like `/healthz`, because it reveals no more than
    `/api/health` does. Scrape it from inside the VPC; the load balancer in
    infra/20-services.yaml has no rule that reaches it from outside.
    """
    snapshot = metrics.snapshot()

    # Written by hand rather than with prometheus_client: that is 200 KB and a
    # registry abstraction to serialise eleven integers, and it would be the
    # first entry in requirements-deploy.txt that exists purely for
    # observability.
    described = {
        "route_requests_total": ("counter", "Route requests accepted."),
        "routes_blocked_total": ("counter", "Routes rejected by the accessibility engine."),
        "cache_hits_total": ("counter", "Whole-route cache hits."),
        "cache_misses_total": ("counter", "Whole-route cache misses."),
        "segments_scored_total": ("counter", "Segments served from pre-warmed CLIP scores."),
        "rate_limited_total": ("counter", "Requests refused by the rate limiter."),
        "upstream_failures_total": ("counter", "Upstream calls that failed."),
        "narration_failures_total": ("counter", "Narration attempts that failed."),
        "enrichment_failures_total": ("counter", "Enrichment stages that failed."),
        "unique_sessions_today": ("gauge", "Distinct sessions today, from an unpersisted digest."),
        "uptime_s": ("gauge", "Seconds since this process started."),
    }

    lines: list[str] = []
    for name, value in snapshot.items():
        kind, description = described.get(name, ("gauge", ""))
        metric = f"meander_{name}"
        if description:
            lines.append(f"# HELP {metric} {description}")
        lines.append(f"# TYPE {metric} {kind}")
        lines.append(f"{metric} {value}")
    lines.append("")

    return Response(
        content="\n".join(lines),
        # `version=0.0.4` is part of the contract, not decoration: a scraper
        # given bare text/plain treats the body as an unparseable exposition.
        media_type="text/plain; version=0.0.4; charset=utf-8",
    )


@app.get("/healthz")
async def healthz() -> dict[str, str]:
    """Liveness. No disk, no upstream, no dependencies.

    This is what the load balancer polls, so it must keep answering while the
    instance is degraded: a readiness failure should take an instance out of
    rotation, not have it killed and restarted straight back into the same
    failure. If this process can execute this function, it is alive.
    """
    return {"status": "ok", "version": __version__}


@app.get("/readyz")
async def readyz(response: Response) -> dict[str, Any]:
    """Readiness. 503 when this instance genuinely cannot serve a route.

    ⚠ "Required" here is Settings.missing_required_keys(), which is a much
    shorter list than missing_keys(). The latter names MAPILLARY_TOKEN and
    ANTHROPIC_API_KEY whenever they are unset, and neither is needed to serve
    routes — CLIP is cache-read-only in the deploy image and narration is
    simply skipped without a key. Wiring readiness to that list would 503 a
    perfectly healthy instance for ever and the target would never register.
    """
    checks: dict[str, Any] = {}

    missing = settings.missing_required_keys()
    checks["keys"] = {"ok": not missing, "missing": missing}

    try:
        await run_in_threadpool(get_cache().segment_count)
        checks["cache"] = {"ok": True}
    except Exception as exc:  # noqa: BLE001 — any cache failure is unreadiness
        checks["cache"] = {"ok": False, "detail": type(exc).__name__}

    routing_ok, routing_detail = await check_routing()
    checks["routing"] = {"ok": routing_ok, "detail": routing_detail}

    ready = all(c["ok"] for c in checks.values())
    if not ready:
        response.status_code = 503
    return {"status": "ready" if ready else "not_ready", "checks": checks}


@app.get("/api/health")
def health(verbose: int = Query(0, ge=0, le=1)) -> dict[str, Any]:
    """The rich human diagnostic. Not a probe — see /healthz and /readyz.

    Deliberately does not name which secrets are unset, and does not publish
    how much of the rate-limit budget is left: both are free reconnaissance for
    an anonymous caller, and neither helps the operator more than keys_ok does.
    """
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
        # Not the list of names: telling an anonymous caller exactly which
        # secrets this deployment is missing is free reconnaissance. The
        # operator needs the boolean; the names are in the startup log.
        "keys_ok": not settings.missing_keys(),
        "required_keys_ok": not settings.missing_required_keys(),
        "cache": cache.stats(),
        "live_call_budget": budget_regime(),
        "counters": metrics.snapshot(),
        "rate_limit": {
            "per_ip_capacity": settings.per_ip_bucket_capacity,
            "per_ip_refill_per_min": settings.per_ip_refill_per_min,
            "daily_ceiling": settings.global_daily_route_ceiling,
            # served_today, but never `remaining`: publishing how much headroom
            # is left tells anyone who asks exactly how much more to send to
            # take the service down for the day.
            #
            # This stays a single global number and it counts ROUTES. Place
            # search runs on its own limiter now, and that limiter is never
            # called with counts_against_ceiling=True, so nothing it does can
            # move this. Two limiters and one ceiling number is the arrangement;
            # a second daily counter would be the mistake `served_today`'s own
            # docstring was written about.
            "served_today": limiter.served_today(),
            # Reported separately rather than folded in, because the two buckets
            # exist precisely because they are not interchangeable: this one is
            # sized for a type-ahead and the one above is sized to protect the
            # routing quota and the machine.
            "geocode_capacity": settings.geocode_bucket_capacity,
            "geocode_refill_per_min": settings.geocode_refill_per_min,
        },
        # fixture_inventory() walks the whole fixture tree and JSON-parses every
        # file — 150-odd files, on every call, on an endpoint anyone can hit.
        # Behind ?verbose=1, and the budget counters with it.
        **(
            {"fixtures": fixture_inventory(), "live_call_counters": budget_snapshot()}
            if verbose
            else {}
        ),
    }
