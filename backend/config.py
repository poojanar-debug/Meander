"""Runtime configuration.

Secrets come from the environment only. Nothing here reads or writes a secret to
disk, and no default value is ever a real key.
"""

from __future__ import annotations

import os
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
# hosted free tier cannot run custom models (see BLOCKED.md #0), so the nature
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
    4. ``route_nature()`` searches all six loop candidates and picks on merit
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

SERVICE_HOSTS: dict[str, str] = {
    "graphhopper.com": "graphhopper",
    "graph.mapillary.com": "mapillary",
    "overpass-api.de": "overpass",
    "api.open-meteo.com": "open_meteo",
    "air-quality-api.open-meteo.com": "open_meteo",
    "nominatim.openstreetmap.org": "nominatim",
    "api.anthropic.com": "anthropic",
    "api06.dev.openstreetmap.org": "osm_dev",
}

def _env_flag(name: str, default: bool = False) -> bool:
    raw = os.environ.get(name)
    if raw is None:
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
    per_ip_refill_per_min: float = 3.0
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
    # The default is now "only when no origins were configured at all", i.e.
    # local development, where it is the whole allowlist. Configure
    # MEANDER_ALLOWED_ORIGINS — which any deployment must — and localhost stops
    # being allowed unless MEANDER_ALLOW_LOCAL_ORIGINS says otherwise.
    if _env_flag("MEANDER_ALLOW_LOCAL_ORIGINS", not origins):
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
        per_ip_refill_per_min=_env_float("MEANDER_RATE_REFILL_PER_MIN", 3.0),
        global_daily_route_ceiling=_env_int("MEANDER_DAILY_ROUTE_CEILING", 2000),
        route_cache_ttl_s=_env_int("MEANDER_ROUTE_CACHE_TTL_S", 6 * 60 * 60),
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
)

TEST_LOCATIONS_BY_SLUG: dict[str, TestLocation] = {loc.slug: loc for loc in TEST_LOCATIONS}
