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


def test_health_reports_which_routing_server_is_in_use(tmp_cache_db) -> None:
    """Whether custom models can run at all is otherwise only discoverable by
    getting a 400 out of the hosted API."""
    with _client(tmp_cache_db) as client:
        routing = client.get("/api/health").json()["routing"]

    assert set(routing) == {
        "endpoint",
        "self_hosted",
        # "hostname" on a deployed instance means nobody set the flag and the
        # answer was guessed — which is how smoothness goes quietly missing.
        "self_hosted_source",
        "custom_models_available",
        "path_details",
    }
    assert isinstance(routing["self_hosted"], bool)
    assert routing["custom_models_available"] == routing["self_hosted"]


def test_a_self_hosted_deployment_does_not_demand_an_api_key(monkeypatch) -> None:
    """MEANDER_STRICT_STARTUP would otherwise refuse to boot a perfectly good
    self-hosted deployment over a key it has no use for."""
    from backend import config

    # conftest pins the explicit flag for the whole suite; clear it to reach the
    # hostname fallback this test is about.
    monkeypatch.delenv(config.SELF_HOSTED_ENV, raising=False)
    monkeypatch.setattr(config, "GRAPHHOPPER_URL", "http://localhost:8989/route")
    assert "GRAPHHOPPER_KEY" not in config.Settings().missing_keys()


def test_a_hosted_deployment_still_demands_an_api_key(monkeypatch) -> None:
    from backend import config

    monkeypatch.setattr(config, "GRAPHHOPPER_URL", "https://graphhopper.com/api/1/route")
    assert "GRAPHHOPPER_KEY" in config.Settings().missing_keys()


# ---------------------------------------------------------------------------
# strict startup boots on the required list, not the completeness list
# ---------------------------------------------------------------------------


def test_strict_startup_boots_without_the_optional_keys(monkeypatch) -> None:
    """The configuration the documentation actually tells you to deploy.

    .env.example:75 says to set MEANDER_STRICT_STARTUP in production and
    infra/20-services.yaml:272 does. A free-tier deployment normally has neither
    MAPILLARY_TOKEN nor ANTHROPIC_API_KEY — CLIP reads scores out of cache.db and
    narration is skipped without a key — so both are in missing_keys() and
    neither is in missing_required_keys().

    _check_startup() used the first list, so that deployment refused to boot
    while being perfectly able to answer.
    """
    from backend import config, main

    settings = config.Settings()
    object.__setattr__(settings, "mapillary_token", None)
    object.__setattr__(settings, "anthropic_api_key", None)

    monkeypatch.setattr(main, "settings", settings)
    monkeypatch.setattr(main, "STRICT_STARTUP", True)

    # Both optional keys are named as absent...
    missing = main._check_startup()
    assert "MAPILLARY_TOKEN" in missing
    assert "ANTHROPIC_API_KEY" in missing
    # ...and neither of them stopped the boot.
    assert settings.missing_required_keys() == []


def test_strict_startup_still_refuses_a_genuinely_unusable_config(monkeypatch) -> None:
    """The guard has to keep working, or the fix has just switched it off.

    A hosted GraphHopper with no key cannot serve a single route, so it is in
    missing_required_keys() and strict startup must still refuse it.
    """
    import pytest

    from backend import config, main

    monkeypatch.setattr(config, "GRAPHHOPPER_URL", "https://graphhopper.com/api/1/route")
    monkeypatch.delenv(config.SELF_HOSTED_ENV, raising=False)

    settings = config.Settings()
    object.__setattr__(settings, "graphhopper_key", None)
    object.__setattr__(settings, "fixture_mode", "live")

    monkeypatch.setattr(main, "settings", settings)
    monkeypatch.setattr(main, "STRICT_STARTUP", True)

    with pytest.raises(RuntimeError, match="GRAPHHOPPER_KEY"):
        main._check_startup()
