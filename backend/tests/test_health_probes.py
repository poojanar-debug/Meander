"""Liveness, readiness, and what /api/health is allowed to tell a stranger.

/api/health used to answer 200 whatever was wrong, name which secrets were
unset, publish how much of the rate-limit budget was left, and walk the whole
fixture tree parsing every file — on every call, on an endpoint anyone can hit.
"""

from __future__ import annotations

import dataclasses

import httpx
import pytest

from backend import config, health
from backend import main as main_mod


@pytest.fixture(autouse=True)
def _fresh_probe():
    health.reset_probe_cache()
    yield
    health.reset_probe_cache()


# ---------------------------------------------------------------------------
# liveness
# ---------------------------------------------------------------------------


def test_healthz_touches_nothing(api_client, monkeypatch: pytest.MonkeyPatch) -> None:
    """It must keep answering while the instance is degraded.

    A readiness failure should take an instance out of rotation; a liveness
    failure gets it killed and restarted straight back into the same problem.
    """

    def explode(*a, **k):
        raise AssertionError("liveness must not touch the cache")

    monkeypatch.setattr(main_mod, "get_cache", explode)

    resp = api_client.get("/healthz")
    assert resp.status_code == 200
    assert resp.json()["status"] == "ok"


# ---------------------------------------------------------------------------
# readiness
# ---------------------------------------------------------------------------


def test_readyz_is_ready_when_everything_works(api_client) -> None:
    resp = api_client.get("/readyz")
    assert resp.status_code == 200
    assert resp.json()["status"] == "ready"


def test_readyz_503s_when_the_router_is_unreachable(
    api_client, monkeypatch: pytest.MonkeyPatch
) -> None:
    async def down():
        return False, "ConnectError"

    monkeypatch.setattr(main_mod, "check_routing", down)

    resp = api_client.get("/readyz")
    assert resp.status_code == 503
    assert resp.json()["checks"]["routing"] == {"ok": False, "detail": "ConnectError"}


def test_readyz_503s_when_the_cache_is_unreadable(
    api_client, monkeypatch: pytest.MonkeyPatch
) -> None:
    class Broken:
        def segment_count(self):
            raise OSError("disk gone")

    monkeypatch.setattr(main_mod, "get_cache", lambda: Broken())

    resp = api_client.get("/readyz")
    assert resp.status_code == 503
    assert resp.json()["checks"]["cache"]["ok"] is False


def test_readiness_does_not_demand_the_optional_keys(monkeypatch: pytest.MonkeyPatch) -> None:
    """The trap this avoids.

    missing_keys() names MAPILLARY_TOKEN and ANTHROPIC_API_KEY whenever they
    are unset, and neither is needed to serve a route — CLIP is cache-read-only
    in the deploy image and narration is simply skipped. Wiring readiness to it
    would 503 a healthy instance for ever and the ALB target would never come
    into service.
    """
    s = dataclasses.replace(
        config.settings,
        fixture_mode="live",
        mapillary_token=None,
        anthropic_api_key=None,
        graphhopper_key="present",
    )
    assert "MAPILLARY_TOKEN" in s.missing_keys()
    assert "ANTHROPIC_API_KEY" in s.missing_keys()
    assert s.missing_required_keys() == []


def test_the_keyless_demo_is_ready_with_no_secrets_at_all(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    s = dataclasses.replace(
        config.settings,
        fixture_mode="replay",
        graphhopper_key=None,
        mapillary_token=None,
        anthropic_api_key=None,
    )
    assert s.missing_required_keys() == []


def test_live_mode_against_the_hosted_api_does_require_a_key(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv(config.SELF_HOSTED_ENV, "0")
    s = dataclasses.replace(config.settings, fixture_mode="live", graphhopper_key=None)
    assert s.missing_required_keys() == ["GRAPHHOPPER_KEY"]


# ---------------------------------------------------------------------------
# the routing probe
# ---------------------------------------------------------------------------


def test_the_hosted_api_is_not_probed(monkeypatch: pytest.MonkeyPatch) -> None:
    """Every hosted call is metered; probing on a readiness schedule would spend
    the quota this service exists to protect."""
    import asyncio

    monkeypatch.setenv(config.SELF_HOSTED_ENV, "0")
    ok, detail = asyncio.run(health.check_routing())
    assert ok is True
    assert detail == "hosted_api_not_probed"


def test_the_probe_is_cached(monkeypatch: pytest.MonkeyPatch) -> None:
    """A load balancer polls every few seconds; the router should not."""
    import asyncio

    monkeypatch.setenv(config.SELF_HOSTED_ENV, "1")
    calls = {"n": 0}

    class FakeClient:
        async def __aenter__(self):
            return self

        async def __aexit__(self, *a):
            return False

        async def get(self, url):
            calls["n"] += 1
            return httpx.Response(200, request=httpx.Request("GET", url))

    monkeypatch.setattr(health.httpx, "AsyncClient", lambda **k: FakeClient())

    async def hammer():
        for _ in range(20):
            await health.check_routing()

    asyncio.run(hammer())
    assert calls["n"] == 1


def test_the_probe_notices_a_router_that_went_away(monkeypatch: pytest.MonkeyPatch) -> None:
    import asyncio

    monkeypatch.setenv(config.SELF_HOSTED_ENV, "1")

    class FakeClient:
        async def __aenter__(self):
            return self

        async def __aexit__(self, *a):
            return False

        async def get(self, url):
            raise httpx.ConnectError("refused")

    monkeypatch.setattr(health.httpx, "AsyncClient", lambda **k: FakeClient())

    ok, detail = asyncio.run(health.check_routing())
    assert ok is False
    assert detail == "ConnectError"


def test_the_probe_url_is_the_routers_own_health_endpoint(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(config, "GRAPHHOPPER_URL", "http://gh.internal:8989/route")
    assert health.routing_probe_url() == "http://gh.internal:8989/health"


# ---------------------------------------------------------------------------
# what /api/health discloses
# ---------------------------------------------------------------------------


def test_health_does_not_name_the_missing_secrets(api_client) -> None:
    body = api_client.get("/api/health").json()
    assert "missing_keys" not in body
    assert isinstance(body["keys_ok"], bool)
    assert isinstance(body["required_keys_ok"], bool)


def test_health_does_not_publish_remaining_quota(api_client) -> None:
    """Otherwise it tells anyone who asks how much more to send to take it down."""
    body = api_client.get("/api/health").json()
    assert "remaining" not in body["rate_limit"]
    assert "services" not in body["live_call_budget"]
    assert body["rate_limit"]["served_today"] >= 0


def test_the_fixture_walk_is_behind_verbose(api_client, monkeypatch: pytest.MonkeyPatch) -> None:
    """It JSON-parses every fixture file, on every call, unauthenticated."""
    from backend import fixtures as fx

    calls = {"n": 0}
    real = fx.fixture_inventory

    def counting():
        calls["n"] += 1
        return real()

    monkeypatch.setattr(fx, "fixture_inventory", counting)

    assert "fixtures" not in api_client.get("/api/health").json()
    assert calls["n"] == 0

    verbose = api_client.get("/api/health?verbose=1").json()
    assert "fixtures" in verbose
    assert "live_call_counters" in verbose
    assert calls["n"] == 1
