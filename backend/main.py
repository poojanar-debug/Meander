"""FastAPI application.

Contract: this module must return a usable response even when scoring and
enrichment both fail. Every optional subsystem is behind a degradation path, and
the response always states which scoring path produced its numbers.
"""

from __future__ import annotations

import importlib.util
from contextlib import asynccontextmanager
from typing import Any, AsyncIterator

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from . import __version__
from .cache import get_cache
from .config import STRICT_STARTUP, settings
from .logging_setup import configure_logging, get_logger
from .metrics import metrics

configure_logging(settings.log_level)
log = get_logger(__name__)


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
    }
