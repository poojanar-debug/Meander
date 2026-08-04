"""Runtime configuration.

Secrets come from the environment only. Nothing here reads or writes a secret to
disk, and no default value is ever a real key.
"""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path
from typing import Literal

REPO_ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = REPO_ROOT / "data"
FIXTURE_DIR = REPO_ROOT / "fixtures"
CACHE_DB_PATH = Path(os.environ.get("MEANDER_CACHE_DB") or (DATA_DIR / "cache.db"))

FixtureMode = Literal["replay", "record", "live"]

# Endpoints. Kept here so fixtures.py can map a hostname back to a service name
# and apply that service's live-call budget.
GRAPHHOPPER_URL = "https://graphhopper.com/api/1/route"
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

# Hard ceilings on live network calls for the whole project, enforced in
# fixtures.py. Hitting a cap downgrades that service to replay-only rather than
# failing the run.
LIVE_CALL_BUDGET: dict[str, int] = {
    "graphhopper": 80,
    "mapillary": 200,
    "overpass": 50,
    "anthropic": 20,
    "open_meteo": 100,
    "nominatim": 40,
    "osm_dev": 20,
}

# Query params and headers that carry secrets. Stripped from the fixture
# signature (so a fixture is portable between developers) and redacted from the
# fixture file on disk.
SECRET_QUERY_PARAMS = frozenset({"key", "access_token", "api_key"})
SECRET_HEADERS = frozenset({"authorization", "x-api-key", "anthropic-api-key"})

# Every request goes through these. Kept low so a wedged upstream degrades the
# response instead of holding a request open.
HTTP_TIMEOUT_S = 12.0
HTTP_CONNECT_TIMEOUT_S = 5.0


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
    global_daily_route_ceiling: int = 120
    route_cache_ttl_s: int = 6 * 60 * 60

    log_level: str = "INFO"

    def key_for(self, service: str) -> str | None:
        return {
            "graphhopper": self.graphhopper_key,
            "mapillary": self.mapillary_token,
            "anthropic": self.anthropic_api_key,
            "osm_dev": self.osm_dev_token,
        }.get(service)

    def missing_keys(self) -> list[str]:
        """Keys absent from the environment, in the order a deployer should add them."""
        missing = []
        if not self.graphhopper_key:
            missing.append("GRAPHHOPPER_KEY")
        if not self.mapillary_token:
            missing.append("MAPILLARY_TOKEN")
        if not self.anthropic_api_key:
            missing.append("ANTHROPIC_API_KEY")
        return missing


def _resolve_fixture_mode() -> FixtureMode:
    raw = (os.environ.get("MEANDER_FIXTURES") or "replay").strip().lower()
    if raw not in ("replay", "record", "live"):
        return "replay"
    return raw  # type: ignore[return-value]


def _resolve_origins() -> tuple[str, ...]:
    raw = os.environ.get("MEANDER_ALLOWED_ORIGINS", "")
    origins = [o.strip() for o in raw.split(",") if o.strip()]
    # Local dev servers are always permitted; the deployed origin comes from env.
    defaults = ["http://localhost:5173", "http://127.0.0.1:5173"]
    for d in defaults:
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
        per_ip_refill_per_min=float(_env_int("MEANDER_RATE_REFILL_PER_MIN", 3)),
        global_daily_route_ceiling=_env_int("MEANDER_DAILY_ROUTE_CEILING", 120),
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
