"""Test harness.

Two guarantees the whole suite depends on:

1. Fixture mode is ``replay``, so no test can spend API quota.
2. Outbound sockets are blocked, so a test that *tries* to reach the network
   fails loudly instead of silently succeeding on a developer's machine and
   failing in CI.
"""

from __future__ import annotations

import os
import socket
from collections.abc import Iterator
from pathlib import Path
from typing import Any

import pytest

# Forced, not setdefault. These decide the exact shape of every upstream request
# and therefore the signature each committed fixture is keyed on, so a developer
# who has exported MEANDER_FIXTURES or MEANDER_GRAPHHOPPER_URL for their own
# self-hosted server would otherwise watch the whole suite fail on fixture
# misses. Per-test overrides go through the `fixture_mode` fixture instead.
os.environ["MEANDER_FIXTURES"] = "replay"
os.environ["MEANDER_GRAPHHOPPER_URL"] = "https://graphhopper.com/api/1/route"
# Pinned for the same reason and in the same breath as the URL: this flag
# decides path_details(), path_details() is inside the request body, and the
# body is what a fixture is keyed on. It is pinned to "0" specifically because
# that is what the hostname sniff resolved to for the URL above when every
# committed fixture was recorded — flipping it invalidates all of them at once
# and the suite fails wholesale on no_fixture rather than on anything that
# points at the cause. PROGRESS.md logs this as self-hosting defect #6.
os.environ["MEANDER_GRAPHHOPPER_SELF_HOSTED"] = "0"
os.environ.pop("MEANDER_PATH_DETAILS", None)
os.environ.setdefault("MEANDER_LOG_LEVEL", "WARNING")
# open_clip otherwise contacts the Hugging Face hub to revalidate the CLIP
# weights, which the socket guard below correctly refuses. Offline mode makes it
# use the local weights cache, or fail with a clear error if there is none.
os.environ.setdefault("HF_HUB_OFFLINE", "1")


_REAL_CONNECT = socket.socket.connect
_REAL_CREATE_CONNECTION = socket.create_connection


class NetworkAccessInTest(RuntimeError):
    """Raised when a test tries to open a socket. Record a fixture instead."""


@pytest.fixture(autouse=True)
def _no_network(monkeypatch: pytest.MonkeyPatch, request: pytest.FixtureRequest) -> Iterator[None]:
    if request.node.get_closest_marker("live"):
        yield
        return

    def _blocked(*args: Any, **kwargs: Any) -> Any:
        raise NetworkAccessInTest(
            "A test attempted to open a network socket. All upstream calls must be "
            "served from fixtures/ in replay mode — record a fixture instead."
        )

    monkeypatch.setattr(socket.socket, "connect", _blocked)
    monkeypatch.setattr(socket, "create_connection", _blocked)
    yield


@pytest.fixture
def tmp_cache_db(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Iterator[Path]:
    """A cache.db per test, replacing the process-wide default."""
    from backend import cache as cache_mod

    db = tmp_path / "cache.db"
    monkeypatch.setattr(cache_mod, "CACHE_DB_PATH", db)
    cache_mod.reset_default_cache()
    yield db
    cache_mod.reset_default_cache()


@pytest.fixture
def cache(tmp_cache_db: Path):
    from backend.cache import Cache

    c = Cache(tmp_cache_db)
    yield c
    c.close()


@pytest.fixture
def tmp_fixture_dir(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Iterator[Path]:
    """Redirect fixtures/ and the live-call budget file to a temp directory."""
    from backend import fixtures as fx

    d = tmp_path / "fixtures"
    d.mkdir()
    monkeypatch.setattr(fx, "FIXTURE_DIR", d)
    fx.reset_budget_singleton()
    yield d
    fx.reset_budget_singleton()


@pytest.fixture(autouse=True)
def _clean_process_state() -> Iterator[None]:
    """Counters, rate-limit buckets and shutdown state are process-wide.

    The shutdown flag matters more than it looks: every TestClient that exits
    runs lifespan's shutdown and leaves it set, so without this the *next*
    test's stream immediately answers "this server is restarting" and produces
    no events at all.
    """
    from backend import main as main_mod
    from backend.main import limiter
    from backend.metrics import metrics

    def _reset() -> None:
        metrics.reset()
        limiter.reset()
        main_mod._shutting_down.clear()
        main_mod._open_streams = 0

    _reset()
    yield
    _reset()


@pytest.fixture
def api_client(tmp_cache_db: Path):
    from fastapi.testclient import TestClient

    from backend.main import app

    with TestClient(app) as client:
        yield client


@pytest.fixture
def fixture_mode(monkeypatch: pytest.MonkeyPatch):
    """Override MEANDER_FIXTURES for one test without touching the frozen Settings."""
    from backend import fixtures as fx

    def _set(mode: str) -> None:
        monkeypatch.setattr(fx, "current_mode", lambda: mode)

    return _set
