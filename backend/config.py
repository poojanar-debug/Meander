"""Runtime configuration.

Secrets come from the environment only. Nothing here reads or writes a secret to
disk, and no default value is ever a real key.
"""

from __future__ import annotations

import os
import secrets
from dataclasses import dataclass, field
from pathlib import Path
from typing import Literal

from dotenv import load_dotenv

REPO_ROOT = Path(__file__).resolve().parent.parent

# Load .env before anything below reads the environment. `override=False` is the
# important part: a real environment variable always beats the file, so a
# deployment's dashboard-set secrets are never shadowed by a stray .env that
# ended up in the image. Missing file is a no-op.
load_dotenv(REPO_ROOT / ".env", override=False)
DATA_DIR = REPO_ROOT / "data"
FIXTURE_DIR = REPO_ROOT / "fixtures"
CACHE_DB_PATH = Path(os.environ.get("MEANDER_CACHE_DB") or (DATA_DIR / "cache.db"))

FixtureMode = Literal["replay", "record", "live"]

# Endpoints. Kept here so fixtures.py can map a hostname back to a service name
# and apply that service's live-call budget.
# Overridable so the app can be pointed at a self-hosted GraphHopper. The
# hosted free tier cannot run custom models (see BLOCKED.md #0), so the scenic
# and accessible presets only work against a server you run yourself:
#
#   MEANDER_GRAPHHOPPER_URL=http://localhost:8989/route
GRAPHHOPPER_URL = os.environ.get(
    "MEANDER_GRAPHHOPPER_URL", "https://graphhopper.com/api/1/route"
)


SELF_HOSTED_ENV = "MEANDER_GRAPHHOPPER_SELF_HOSTED"

_LOOPBACK_HOSTS = frozenset({"localhost", "127.0.0.1", "0.0.0.0", "::1"})


def _hostname_looks_self_hosted() -> bool:
    host = GRAPHHOPPER_URL.split("//", 1)[-1].split("/", 1)[0].split(":", 1)[0].lower()
    return host in _LOOPBACK_HOSTS or host.endswith(".local")


def graphhopper_is_self_hosted() -> bool:
    """Is the routing server one we run ourselves?

    Four unrelated behaviours hang off this answer, and **none of them fails
    loudly when it is wrong**:

    1. ``path_details()`` requests ``smoothness`` only when self-hosted, because
       the hosted API has no such encoded value and referencing one that does
       not exist fails the whole request. Get this wrong in the False direction
       and the accessible custom model silently stops excluding IMPASSABLE
       surfaces — one of the five hard constraints stops firing, the app keeps
       answering, and its answers get quietly less safe.
    2. ``Settings.missing_keys()`` stops demanding ``GRAPHHOPPER_KEY``, so with
       ``MEANDER_STRICT_STARTUP=1`` a wrong answer refuses to boot against a
       perfectly good router.
    3. ``build_request_body()`` sets ``ch.disable`` for round trips, because a
       self-hosted server with CH prepared answers "algorithm=round_trip cannot
       be used with CH". Only the *fastest* round trip is affected — the other
       two presets carry a custom model and get ``ch.disable`` regardless — and
       a fastest failure is re-raised, so the whole request dies.
    4. ``route_scenic()`` searches all six loop candidates and picks on merit
       when unmetered, but only the first two with an early break when it thinks
       it is paying per call. So this flag changes **which route the user gets**,
       not merely how the server is operated.

    Hostname sniffing was the original answer and it is wrong the moment the
    router lives anywhere real — a private ALB, ECS Service Connect,
    ``graphhopper.meander.internal``, a VPC address. That is exactly the
    deployment this repository is heading for, so the flag is now explicit and
    the sniff is only the default when nothing is configured. Local development
    keeps working with no configuration at all.
    """
    raw = os.environ.get(SELF_HOSTED_ENV)
    if raw is not None and raw.strip():
        return raw.strip().lower() in {"1", "true", "yes", "on"}
    return _hostname_looks_self_hosted()


def self_hosted_resolution() -> dict[str, object]:
    """How the flag was decided, for one startup log line and /api/health."""
    raw = os.environ.get(SELF_HOSTED_ENV)
    explicit = raw is not None and raw.strip() != ""
    return {
        "self_hosted": graphhopper_is_self_hosted(),
        "source": "env" if explicit else "hostname",
        "endpoint_host": GRAPHHOPPER_URL.split("//", 1)[-1].split("/", 1)[0],
    }
GRAPHHOPPER_GEOCODE_URL = "https://graphhopper.com/api/1/geocode"
MAPILLARY_URL = "https://graph.mapillary.com/images"
OVERPASS_URL = "https://overpass-api.de/api/interpreter"
OPEN_METEO_URL = "https://api.open-meteo.com/v1/forecast"
OPEN_METEO_AQ_URL = "https://air-quality-api.open-meteo.com/v1/air-quality"
NOMINATIM_URL = "https://nominatim.openstreetmap.org/search"
OSM_DEV_API_URL = "https://api06.dev.openstreetmap.org/api/0.6"
# The MediaWiki API on Wikimedia Commons, used by photos.py for geosearch. No
# key and no account: `action=query&generator=geosearch` answers anonymously,
# which is why it is the source that always works and Mapillary is the one that
# is allowed to be absent.
WIKIMEDIA_COMMONS_API_URL = "https://commons.wikimedia.org/w/api.php"

SERVICE_HOSTS: dict[str, str] = {
    "graphhopper.com": "graphhopper",
    "graph.mapillary.com": "mapillary",
    "overpass-api.de": "overpass",
    "api.open-meteo.com": "open_meteo",
    "air-quality-api.open-meteo.com": "open_meteo",
    "nominatim.openstreetmap.org": "nominatim",
    "api.anthropic.com": "anthropic",
    "api06.dev.openstreetmap.org": "osm_dev",
    "commons.wikimedia.org": "wikimedia_commons",
    # Where Commons actually serves the pixels from. It is a separate budget
    # line from the API above because the two have wildly different call
    # counts: one geosearch produces up to a dozen thumbnails, and metering
    # them together would make the API's cap meaningless.
    #
    # Mapillary's thumbnails have no entry here and cannot have one. They come
    # from rotating `scontent-*.xx.fbcdn.net` hostnames, so photos.py passes
    # `service="mapillary_images"` explicitly at the call site rather than
    # letting `service_for_url` invent a new directory (and a zero cap) for
    # every CDN edge that answers.
    "upload.wikimedia.org": "wikimedia_images",
}

def _env_flag(name: str, default: bool = False) -> bool:
    """An empty value means "unset", the same as it does for ints and floats.

    `_env_int` and `_env_float` both treat a blank string as absent. This did
    not, so `MEANDER_ALLOW_LOCAL_ORIGINS=` read as *false* rather than as "no
    opinion" — and .env.example is a file people copy to .env and fill in
    selectively, which produces exactly that. The result was that copying the
    example and running `make run` turned off the dev-server origins the same
    example promises need no configuration.

    Empty is not the same as 0, and only the latter should be able to override
    a default.
    """
    raw = os.environ.get(name)
    if raw is None or not raw.strip():
        return default
    return raw.strip().lower() in {"1", "true", "yes", "on"}


def _env_int(name: str, default: int) -> int:
    raw = os.environ.get(name)
    if raw is None or not raw.strip():
        return default
    try:
        return int(raw)
    except ValueError:
        return default


# Ceilings on live network calls, enforced in fixtures.py. Hitting a cap
# downgrades that service to replay-only rather than failing the run.
#
# These are *development* guard rails and nothing else: their job is to stop an
# iteration loop quietly draining a 500-credit/day quota and then failing in a
# way that looks exactly like a code bug. They are **per UTC day** and reset on
# their own; the counters live in fixtures/_budget.json.
#
# fixtures.budget_applies() decides when they are consulted at all. They are
# skipped entirely in live mode — production is protected by the rate limiter
# and the daily route ceiling — and skipped for a self-hosted GraphHopper,
# which has no quota to protect. Before that was true, a deployed instance
# metered its own router at 3 credits a call against an 80-call *lifetime* cap,
# which is three route requests per container and then 503 forever.
#
# Raising them with MEANDER_BUDGET_* is still available for a long recording
# session against the hosted API, but is no longer load-bearing for a
# deployment: forgetting one used to produce a service that worked three times
# and then stopped.
_DEV_LIVE_CALL_BUDGET: dict[str, int] = {
    "graphhopper": 80,
    "mapillary": 200,
    "overpass": 50,
    "anthropic": 20,
    "open_meteo": 100,
    "nominatim": 40,
    "osm_dev": 20,
    # Route photos. The geosearch caps are per *anchor point* along a route and
    # photos.py asks at most PHOTO_MAX_ANCHORS of them per request, so 150 is
    # roughly forty route-photo requests in a recording session.
    #
    # The two image caps are deliberately much larger than the geosearch ones:
    # one answered geosearch yields several thumbnails, and every one of them
    # that the browser actually displays is a second call through
    # /api/photo/{ref}. Sizing them equal would exhaust the image budget while
    # the search budget still had room, which shows up as a page of broken
    # thumbnails under a working hero.
    "wikimedia_commons": 150,
    "wikimedia_images": 600,
    "mapillary_images": 600,
}


def _resolve_live_call_budget() -> dict[str, int]:
    """Per-service caps, overridable with MEANDER_BUDGET_<SERVICE>.

    ``MEANDER_BUDGET_GRAPHHOPPER=100000`` effectively removes the cap for that
    service. Set them all when you want the app to answer for any location
    rather than only the recorded demo ones.
    """
    return {
        service: _env_int(f"MEANDER_BUDGET_{service.upper()}", default)
        for service, default in _DEV_LIVE_CALL_BUDGET.items()
    }


LIVE_CALL_BUDGET: dict[str, int] = _resolve_live_call_budget()

# Query params and headers that carry secrets. Stripped from the fixture
# signature (so a fixture is portable between developers) and redacted from the
# fixture file on disk.
SECRET_QUERY_PARAMS = frozenset({"key", "access_token", "api_key"})

# Per-edge details requested from GraphHopper and read by accessibility.py.
# `smoothness` is one of the five hard constraints but the hosted API does not
# expose it, so it is only requested when the encoded value is known to exist —
# a self-hosted graph built by scripts/graphhopper.sh includes it.
DEFAULT_PATH_DETAILS = ("road_class", "surface", "road_environment")
SELF_HOSTED_PATH_DETAILS = (*DEFAULT_PATH_DETAILS, "smoothness")


def path_details() -> list[str]:
    raw = os.environ.get("MEANDER_PATH_DETAILS")
    if raw:
        return [d.strip() for d in raw.split(",") if d.strip()]
    return list(SELF_HOSTED_PATH_DETAILS if graphhopper_is_self_hosted() else DEFAULT_PATH_DETAILS)
SECRET_HEADERS = frozenset({"authorization", "x-api-key", "anthropic-api-key"})

def _env_float(name: str, default: float) -> float:
    raw = os.environ.get(name)
    if raw is None or not raw.strip():
        return default
    try:
        return float(raw)
    except ValueError:
        return default


# Every request goes through these. Kept low so a wedged upstream degrades the
# response instead of holding a request open.
#
# 12 s was too aggressive to be a default and had to become configurable:
# Overpass measured **13.6 s** for a trivial bench query on this project, so
# rest stops were already timing out into `null` at random. `null` is honest —
# it means "we could not look", distinct from `[]` — but the resulting httpx
# error surfaces as "Could not reach the routing service", which sends an
# operator hunting a network fault that does not exist.
HTTP_TIMEOUT_S = _env_float("MEANDER_HTTP_TIMEOUT_S", 20.0)
HTTP_CONNECT_TIMEOUT_S = _env_float("MEANDER_HTTP_CONNECT_TIMEOUT_S", 5.0)

# Whole-request ceiling. Past this, /api/routes returns what it already has
# rather than holding the connection open — every subsystem below it is
# best-effort and degrades to null, so a partial answer is a real answer.
# Deliberately under a typical 60 s proxy idle timeout.
REQUEST_DEADLINE_S = _env_float("MEANDER_REQUEST_DEADLINE_S", 45.0)

# ---------------------------------------------------------------------------
# route photos
# ---------------------------------------------------------------------------
#
# The whole point of the photos feature is that **the image host sees this
# server and never the user**, so every number below is a limit on what this
# server will do on a stranger's behalf. /api/photo/{ref} is a proxy, and a
# proxy without limits is somebody else's bandwidth.

# How many places along a route are asked about. Each anchor costs one Commons
# geosearch and, when a token exists, one Mapillary bbox query, so this is the
# multiplier on every upstream number in this feature. Ten calls is the same
# order as one uncached /api/routes, and they are all issued together.
#
# **Odd on purpose.** photos.py places anchors at (i + 0.5) / n along the
# route, so an odd n puts one of them exactly halfway and an even n does not.
# The `fastest` hero is the midpoint, and "about halfway" reading as 37.5% of
# the way along is the kind of quiet inaccuracy this project does not ship.
PHOTO_MAX_ANCHORS = _env_int("MEANDER_PHOTO_MAX_ANCHORS", 5)

# How far from an anchor point a photo may be and still count as "along this
# route". 400 m is about five minutes' walk, which is the distance at which a
# photo stops being of somewhere you pass and starts being of somewhere else.
PHOTO_SEARCH_RADIUS_M = _env_int("MEANDER_PHOTO_SEARCH_RADIUS_M", 400)

# Ceiling on one proxied image, in bytes.
#
# The thumbnails asked for are 640 px (Commons) and 1024 px (Mapillary), which
# measure in the low hundreds of kilobytes. 5 MB is therefore not a working
# limit, it is a refusal: anything this large is not the thumbnail that was
# asked for, and streaming it would mean this service is being used to move
# somebody else's file.
#
# fixtures.MAX_RESPONSE_BYTES (32 MB) is the memory bound that actually stops a
# hostile body mid-flight. This is the policy limit applied to what arrives.
PHOTO_MAX_IMAGE_BYTES = _env_int("MEANDER_PHOTO_MAX_IMAGE_BYTES", 5 * 1024 * 1024)

# Cache-Control max-age on a proxied image. A day, and `immutable`: the
# reference in the URL pins one exact upstream URL, so the bytes behind a given
# /api/photo/{ref} cannot change without the reference changing too.
PHOTO_CACHE_MAX_AGE_S = _env_int("MEANDER_PHOTO_CACHE_MAX_AGE_S", 24 * 60 * 60)

# Token bucket for /api/photo/{ref}, which needs its own and cannot share the
# route one.
#
# One route view asks for up to six images at once against a route bucket whose
# whole capacity is twelve, so putting images on that bucket would empty it
# before the user picked a second route. This is the same lesson place search
# already taught (see geocode_bucket_capacity): an endpoint whose natural unit
# is "several per interaction" cannot share a bucket with one whose unit is
# "one per interaction".
PHOTO_BUCKET_CAPACITY = _env_int("MEANDER_PHOTO_RATE_CAPACITY", 60)
PHOTO_REFILL_PER_MIN = _env_float("MEANDER_PHOTO_RATE_REFILL_PER_MIN", 60.0)


def _photo_signing_key() -> bytes:
    """Key for the HMAC on an image reference.

    **Not a secret in the sense a credential is.** Forging a reference buys an
    attacker nothing that the host allowlist in photos.py does not already
    refuse: the decoded URL is checked against exactly two upstreams whatever
    the signature says. The HMAC is the second lock, not the only one, and it is
    here so that a reference cannot be edited into a *different* URL on those
    hosts (a 200 MB media file on upload.wikimedia.org is still on the
    allowlist).

    Unset, it is generated per process. That is the right default for a single
    uvicorn worker, which is what this service runs: references stay valid for
    the life of the process and are invalidated by a restart, which shows up as
    a photo that fails to load and is then refetched by the next /api/photos
    call.

    **Set MEANDER_PHOTO_SIGNING_KEY when running more than one worker or more
    than one instance.** Without it each worker mints references the others
    reject, so roughly (n-1)/n of image loads 404 at random, which looks like a
    flaky CDN rather than a configuration error.
    """
    configured = (os.environ.get("MEANDER_PHOTO_SIGNING_KEY") or "").strip()
    if configured:
        return configured.encode("utf-8")
    return secrets.token_bytes(32)


PHOTO_SIGNING_KEY: bytes = _photo_signing_key()

# How many proxies of *your own* sit in front of this service.
#
# Defaults to 0, which ignores X-Forwarded-For entirely and rate-limits on the
# socket peer. That is the only safe default: trusting a hop that is not there
# is a complete bypass (a client sends its own X-Forwarded-For and gets a fresh
# token bucket every request), whereas distrusting one that is there merely
# makes everybody share a bucket.
#
# **Set this to 1 behind an ALB.** Left at 0 there, every request appears to
# come from the load balancer and the whole service rate-limits as one client.
TRUSTED_PROXY_HOPS = _env_int("MEANDER_TRUSTED_PROXY_HOPS", 0)

# How long shutdown waits for in-flight SSE streams to finish before closing the
# cache under them. Must stay comfortably below uvicorn's
# --timeout-graceful-shutdown, which must in turn stay below the orchestrator's
# SIGTERM-to-SIGKILL window.
DRAIN_TIMEOUT_S = _env_float("MEANDER_DRAIN_TIMEOUT_S", 20.0)


@dataclass(frozen=True)
class Settings:
    """Snapshot of the environment, resolved once at import time."""

    fixture_mode: FixtureMode = "replay"
    graphhopper_key: str | None = None
    mapillary_token: str | None = None
    anthropic_api_key: str | None = None
    osm_dev_token: str | None = None

    # Public deployment guard rails.
    allowed_origins: tuple[str, ...] = ()
    per_ip_bucket_capacity: int = 12
    # Sustained rate per IP, in requests per minute. Burst is the capacity above
    # and is deliberately untouched: twelve back-to-back requests still go
    # through instantly, which is more than a normal session ever asks for.
    #
    # This was 3.0, and 3.0 was incoherent with the ceiling below it. 3/min is
    # 4,320 requests a day from a single address, against a *global* ceiling of
    # 2,000. One IP could therefore spend the whole day's allowance — with 2,320
    # to spare — and everyone else got 429 for the rest of the day. It took
    # 2,000 ÷ 3 ≈ 667 minutes, a little over eleven hours, to do it by accident.
    #
    # 1.0 is 1,440 a day, which is 72% of the ceiling: still generous, and no
    # longer enough for one address to starve the service on its own. The
    # ceiling binds before any single bucket does, which is the property that
    # was missing.
    #
    # The cost, stated plainly: an empty bucket now says Retry-After: 61 rather
    # than 21, and refills fully in 12 minutes rather than 4.
    #
    # That cost used to be paid by place search too, and it was worse than this
    # note admitted. Measured: a 20-character name typed at 40 wpm costs a mean
    # of 8.6 geocode requests at a 300 ms debounce, so **two place names come to
    # 17.1 requests against a capacity of 12** — the bucket is empty before the
    # first route request is made, and that request is then refused with the
    # routing copy shown under the place box. It is the ordinary case, not a
    # pathological one, and it was reproduced accidentally on this machine while
    # measuring something else: one browser pass over seven viewports drove
    # `rate_limited_total` from 21 to 27 and left three of the seven with no
    # routes at all.
    #
    # Place search now has a bucket of its own, below. This one is left exactly
    # as it was, because this is the one protecting the routing quota and the
    # machine, and nothing measured here says it is wrong for routes.
    per_ip_refill_per_min: float = 1.0
    # 120 was sized against the *hosted* GraphHopper's 500-credit day. The router
    # is self-hosted now and that quota is gone, but the ceiling is not
    # redundant: fixtures.budget_applies() skips the per-service budgets entirely
    # in live mode (see the note above _DEV_LIVE_CALL_BUDGET), so this number is
    # the only thing standing between a public URL and the shared upstreams.
    #
    # Measured, one uncached 3-objective request: 8 router calls, 4 Open-Meteo,
    # 1 Overpass. Open-Meteo's free tier is 10,000 calls/day, so it saturates at
    # ~2,500 requests — well before the machine does, which at the recorded 14.0 s
    # per uncached request and no --workers tops out near 6,100 a day.
    #
    # 2,000 keeps a fifth of Open-Meteo's allowance in reserve and is still an
    # order of magnitude above anything a demonstration link will see.
    global_daily_route_ceiling: int = 2000
    route_cache_ttl_s: int = 6 * 60 * 60

    # Place search, on a bucket of its own.
    #
    # **Sized against measurement, not taste.** The worst single-name case seen
    # is 19 requests — a 20-character name typed at exactly the debounce
    # interval, where every keystroke fires — and the largest burst the repo has
    # actually recorded is the 12-query cluster in fixtures/nominatim/. 40 holds
    # both, with room for a second name in the same breath.
    #
    # 20/min rather than the route bucket's 1.0 because the failure being
    # avoided is a type-ahead that stops answering mid-word: a drained bucket
    # refills in two minutes instead of twelve. It is still well inside
    # Nominatim's usage policy, which is one request per second enforced by
    # banning the offending IP — and the IP it would ban is this service's
    # egress address, so it is every user of the deployment who loses place
    # search, not the one client. 20/min is 0.33 req/s per address, a third of
    # the policy, before the client LRU and the server cache below take their
    # share.
    #
    # Deliberately NOT counted against the daily route ceiling: `served_today`
    # is the one enforced "routes served today" number and a place search is not
    # a route. It never was — /api/geocode already passed
    # counts_against_ceiling=False — and the second limiter must not quietly
    # change that.
    geocode_bucket_capacity: int = 40
    geocode_refill_per_min: float = 20.0
    # One day, deliberately not the route cache's six hours and no longer the
    # seven days this held. A route payload embeds weather, daylight and air
    # quality and goes stale as they do; a name-to-coordinate mapping embeds
    # none of them, which is the argument that bought seven days.
    #
    # What that argument missed is that OSM is edited continuously and
    # Nominatim picks the edits up within hours, so the cache decides how old
    # the place list a user picks a destination from is allowed to be. At seven
    # days, a park mapped on Monday could not be found until the Monday after
    # for anyone whose search string was already in the table. A day still
    # absorbs the case this cache exists for — backspacing and re-typing, which
    # happens over seconds — and costs at most one upstream call per distinct
    # name per day.
    geocode_cache_ttl_s: int = 24 * 60 * 60
    # How long "nowhere is called that" stands, which is a different question
    # and has a much shorter answer.
    #
    # An empty result is the one answer that a single OSM edit turns into a
    # wrong one, and it is the answer a newly mapped place gets. It was sharing
    # the TTL above, so the same table that saved a few requests on a
    # misspelling also hid a real place for a week. Ten minutes still covers the
    # keystrokes of a misspelling, which is all that caching a miss was ever
    # for.
    geocode_empty_cache_ttl_s: int = 10 * 60

    log_level: str = "INFO"

    def missing_keys(self) -> list[str]:
        """Keys absent from the environment, in the order a deployer should add them.

        A self-hosted GraphHopper needs no key, so demanding one would make
        MEANDER_STRICT_STARTUP refuse to boot a perfectly good deployment.

        ⚠ This is a *completeness* list, not a readiness list. Two of the three
        are optional at runtime — see missing_required_keys().
        """
        missing = []
        if not self.graphhopper_key and not graphhopper_is_self_hosted():
            missing.append("GRAPHHOPPER_KEY")
        if not self.mapillary_token:
            missing.append("MAPILLARY_TOKEN")
        if not self.anthropic_api_key:
            missing.append("ANTHROPIC_API_KEY")
        return missing

    def missing_required_keys(self) -> list[str]:
        """Keys without which this instance genuinely cannot serve a route.

        Deliberately much shorter than missing_keys(), and readiness must use
        this one. MAPILLARY_TOKEN and ANTHROPIC_API_KEY are in missing_keys()
        whenever they are unset, and **neither is needed to serve routes**: CLIP
        is cache-read-only in the deploy image, and narration is simply skipped
        without a key. Wiring readiness to missing_keys() would 503 a perfectly
        healthy instance for ever and the load-balancer target would never come
        into service.

        In replay mode nothing is required at all — that is the keyless demo,
        and it answers for the recorded locations without any credentials.
        """
        if self.fixture_mode == "replay":
            return []
        if not self.graphhopper_key and not graphhopper_is_self_hosted():
            return ["GRAPHHOPPER_KEY"]
        return []


def _resolve_fixture_mode() -> FixtureMode:
    raw = (os.environ.get("MEANDER_FIXTURES") or "replay").strip().lower()
    if raw not in ("replay", "record", "live"):
        return "replay"
    return raw  # type: ignore[return-value]


def _resolve_origins() -> tuple[str, ...]:
    raw = os.environ.get("MEANDER_ALLOWED_ORIGINS", "")
    origins = [o.strip() for o in raw.split(",") if o.strip()]

    # The Vite dev server used to be appended to *every* deployment's allowlist
    # unconditionally, which quietly means a page served from a developer's
    # laptop can call production.
    #
    # That was narrowed to "only when no origins were configured at all", which
    # is better and still not right: an empty MEANDER_ALLOWED_ORIGINS is exactly
    # what a deployment that forgot to configure it looks like, and "forgot to
    # configure it" then got the dev-server allowlist rather than a closed door.
    # The previous pass documented that rather than fixing it and closed the hole
    # in CloudFormation instead — a fix a compose deploy does not inherit.
    #
    # The default now keys off fixture mode, which is the one signal that is
    # already required to be correct and already differs between the two cases:
    #
    #   replay / record   development. MEANDER_FIXTURES defaults to replay, so a
    #                     developer who has configured *nothing at all* still
    #                     gets localhost — the property pinned by
    #                     test_localhost_is_allowed_when_nothing_is_configured,
    #                     which is deliberate and stays true.
    #   live              production, by definition: it is the only mode that
    #                     talks to real upstreams. localhost is never added
    #                     implicitly here.
    #
    # MEANDER_ALLOW_LOCAL_ORIGINS still overrides in both directions, so a
    # laptop running compose against the real router (MEANDER_FIXTURES=live) says
    # so explicitly — see docker-compose.yml — and production can never acquire
    # the dev server by omission.
    is_development = _resolve_fixture_mode() != "live"
    if _env_flag("MEANDER_ALLOW_LOCAL_ORIGINS", is_development and not origins):
        for d in ("http://localhost:5173", "http://127.0.0.1:5173"):
            if d not in origins:
                origins.append(d)
    return tuple(origins)


def load_settings() -> Settings:
    def _clean(name: str) -> str | None:
        raw = os.environ.get(name)
        if raw is None:
            return None
        raw = raw.strip()
        return raw or None

    return Settings(
        fixture_mode=_resolve_fixture_mode(),
        graphhopper_key=_clean("GRAPHHOPPER_KEY"),
        mapillary_token=_clean("MAPILLARY_TOKEN"),
        anthropic_api_key=_clean("ANTHROPIC_API_KEY"),
        osm_dev_token=_clean("OSM_DEV_TOKEN"),
        allowed_origins=_resolve_origins(),
        per_ip_bucket_capacity=_env_int("MEANDER_RATE_CAPACITY", 12),
        # _env_float, not float(_env_int(...)): the latter parsed "0.5" with
        # int(), hit ValueError, and silently returned the default of 3 — a
        # six-fold difference from what the operator asked for, with no error.
        per_ip_refill_per_min=_env_float("MEANDER_RATE_REFILL_PER_MIN", 1.0),
        global_daily_route_ceiling=_env_int("MEANDER_DAILY_ROUTE_CEILING", 2000),
        route_cache_ttl_s=_env_int("MEANDER_ROUTE_CACHE_TTL_S", 6 * 60 * 60),
        geocode_bucket_capacity=_env_int("MEANDER_GEOCODE_RATE_CAPACITY", 40),
        geocode_refill_per_min=_env_float("MEANDER_GEOCODE_RATE_REFILL_PER_MIN", 20.0),
        geocode_cache_ttl_s=_env_int("MEANDER_GEOCODE_CACHE_TTL_S", 24 * 60 * 60),
        geocode_empty_cache_ttl_s=_env_int("MEANDER_GEOCODE_EMPTY_CACHE_TTL_S", 10 * 60),
        log_level=os.environ.get("MEANDER_LOG_LEVEL", "INFO").upper(),
    )


settings = load_settings()

STRICT_STARTUP = _env_flag("MEANDER_STRICT_STARTUP", False)


@dataclass(frozen=True)
class TestLocation:
    """A fixed coordinate used for every dev iteration.

    Fixed on purpose: a new coordinate is a fixture cache miss and therefore a
    live API call against a 500-credit/day quota.

    Each one is **the coordinate Nominatim returns for that name**, not a
    hand-picked centre. Searching for a demo location in the app then produces
    exactly the request the fixtures were recorded for, so the whole demo works
    end to end without a key. Picking them by hand left every search 30-800 m
    off its own fixture and the app answered "no fixture for that request".
    """

    slug: str
    name: str
    lat: float
    lon: float
    notes: str = ""
    tags: tuple[str, ...] = field(default_factory=tuple)


TEST_LOCATIONS: tuple[TestLocation, ...] = (
    TestLocation(
        "colombo-fort",
        "Colombo Fort, Sri Lanka",
        6.933727,
        79.850080,
        "Dense arterial grid beside Galle Face Green. Origin for most fixtures.",
        ("urban", "arterial"),
    ),
    TestLocation(
        "viharamahadevi",
        "Viharamahadevi Park, Colombo",
        6.914899,
        79.861364,
        "Large city park. Expected to score above the arterial baseline.",
        ("park", "green"),
    ),
    TestLocation(
        "hyde-park-london",
        "Hyde Park, London",
        51.507489,
        -0.162207,
        "Dense Mapillary coverage and rich OSM accessibility tagging.",
        ("park", "green", "well-tagged"),
    ),
    TestLocation(
        "euston-road-london",
        "Euston Road, London",
        51.524718,
        -0.138530,
        "Six-lane arterial. The grim control for CLIP ranking.",
        ("urban", "arterial"),
    ),
    TestLocation(
        "amsterdam-vondelpark",
        "Vondelpark, Amsterdam",
        52.357197,
        4.864119,
        "Flat, exceptionally well tagged for surface and smoothness.",
        ("park", "green", "well-tagged"),
    ),
    TestLocation(
        "ella-sri-lanka",
        "Ella, Sri Lanka",
        6.875280,
        81.038330,
        # The location that started Part 4. The demo region set cut Sri Lanka to
        # a 1x1 degree box around Colombo, which left Ella 76 km east of the
        # edge and answered a Sri Lankan user with "Meander does not cover that
        # area yet" for their own country.
        #
        # It earns its place beyond that: at **1,041 m** it is the first test
        # location that is not at sea level, and it is in steep terrain, which
        # is exactly where a ~90 m SRTM grid is least trustworthy. Every other
        # location here exercises the elevation path at approximately zero.
        "1,041 m in steep hill country. The only test location not at sea level.",
        ("rural", "elevation", "hills"),
    ),
)

TEST_LOCATIONS_BY_SLUG: dict[str, TestLocation] = {loc.slug: loc for loc in TEST_LOCATIONS}
