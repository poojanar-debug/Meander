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
from pathlib import Path
from typing import Any, Iterator

import pytest

os.environ.setdefault("MEANDER_FIXTURES", "replay")
os.environ.setdefault("MEANDER_LOG_LEVEL", "WARNING")

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
