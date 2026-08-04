"""The health endpoint is the contract the deployment monitors against."""

from __future__ import annotations

from pathlib import Path

from fastapi.testclient import TestClient

from backend import __version__


def _client(tmp_cache_db: Path) -> TestClient:
    from backend.main import app

    return TestClient(app)


def test_health_reports_version_and_cache_stats(tmp_cache_db: Path) -> None:
    with _client(tmp_cache_db) as client:
        body = client.get("/api/health").json()

    assert body["status"] == "ok"
    assert body["version"] == __version__
    assert body["fixture_mode"] == "replay"
    assert set(body["cache"]) >= {"segments_scored", "routes_cached", "schema_version"}


def test_health_states_whether_clip_is_importable(tmp_cache_db: Path) -> None:
    """The deployed instance has no torch; the response must say so either way."""
    with _client(tmp_cache_db) as client:
        body = client.get("/api/health").json()

    assert isinstance(body["clip_available"], bool)


def test_health_never_leaks_key_values(tmp_cache_db: Path, monkeypatch) -> None:
    monkeypatch.setenv("GRAPHHOPPER_KEY", "super-secret-value")
    with _client(tmp_cache_db) as client:
        raw = client.get("/api/health").text

    assert "super-secret-value" not in raw


def test_health_counters_are_aggregates_only(tmp_cache_db: Path) -> None:
    with _client(tmp_cache_db) as client:
        counters = client.get("/api/health").json()["counters"]

    for key in ("route_requests_total", "routes_blocked_total", "cache_hits_total",
                "segments_scored_total", "unique_sessions_today"):
        assert key in counters
        assert isinstance(counters[key], int)
