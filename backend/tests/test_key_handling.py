"""The hosted API key must never reach a server we run ourselves.

It travels as a query parameter, so a deployment that keeps GRAPHHOPPER_KEY
configured for fallback — a sensible thing to do — was putting it in the query
string of every request to its own router, and therefore into that server's
access log in plaintext.
"""

from __future__ import annotations

import dataclasses

import httpx
import pytest

from backend import config, routing
from backend import fixtures as fx
from backend.geometry import LatLon

ORIGIN = LatLon(51.5074, -0.1278)
DEST = LatLon(51.51, -0.12)
FAKE_KEY = "a-real-looking-key-0000"


@pytest.fixture
def capture_request(monkeypatch: pytest.MonkeyPatch):
    """Record what fetch() was asked to send, without sending it."""
    seen: dict = {}

    async def fake_fetch(method, url, **kwargs):
        seen["url"] = url
        seen["params"] = kwargs.get("params")
        return httpx.Response(
            200,
            json={"paths": [{"points": {"coordinates": [[-0.1278, 51.5074], [-0.12, 51.51]]},
                             "distance": 1000.0, "time": 600_000}]},
            request=httpx.Request("POST", url),
        )

    monkeypatch.setattr(routing, "fetch", fake_fetch)
    monkeypatch.setattr(routing, "is_synthetic", lambda _r: False)
    return seen


@pytest.fixture
def with_key(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setattr(
        routing, "settings", dataclasses.replace(routing.settings, graphhopper_key=FAKE_KEY)
    )


@pytest.mark.asyncio
async def test_the_key_is_not_sent_to_a_self_hosted_router(
    capture_request, with_key, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv(config.SELF_HOSTED_ENV, "1")

    await routing.route_fastest(ORIGIN, DEST, 30, "foot")

    assert capture_request["params"] is None, (
        "the key would land in the self-hosted server's access log"
    )


@pytest.mark.asyncio
async def test_the_key_is_still_sent_to_the_hosted_api(
    capture_request, with_key, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv(config.SELF_HOSTED_ENV, "0")

    await routing.route_fastest(ORIGIN, DEST, 30, "foot")

    assert capture_request["params"] == {"key": FAKE_KEY}


@pytest.mark.asyncio
async def test_no_key_configured_sends_nothing(
    capture_request, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(
        routing, "settings", dataclasses.replace(routing.settings, graphhopper_key=None)
    )
    monkeypatch.setenv(config.SELF_HOSTED_ENV, "0")

    await routing.route_fastest(ORIGIN, DEST, 30, "foot")

    assert capture_request["params"] is None


# ---------------------------------------------------------------------------
# the diagnosis attached to a 401/403
# ---------------------------------------------------------------------------


def _unauthorised() -> httpx.Response:
    return httpx.Response(
        403,
        json={"message": "forbidden"},
        request=httpx.Request("POST", "http://gh.internal/route"),
    )


def test_a_401_from_the_hosted_api_blames_the_key(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv(config.SELF_HOSTED_ENV, "0")
    err = routing._shape_upstream_error(_unauthorised())
    assert "GraphHopper key" in err.human_message


def test_a_401_from_our_own_router_does_not(monkeypatch: pytest.MonkeyPatch) -> None:
    """Otherwise an operator hunts for a credential that does not exist."""
    monkeypatch.setenv(config.SELF_HOSTED_ENV, "1")
    err = routing._shape_upstream_error(_unauthorised())
    message = err.human_message.lower()
    # It may mention an API key in order to rule one out; what it must not do
    # is send someone looking for a missing or rejected credential.
    assert "key is missing" not in message
    assert "rejected" not in message
    assert "proxy" in message


def test_the_key_never_reaches_a_fixture_signature() -> None:
    """Two developers with different keys must produce the same signature."""
    with_key = fx.signature("POST", routing.GRAPHHOPPER_URL, params={"key": FAKE_KEY})
    without = fx.signature("POST", routing.GRAPHHOPPER_URL, params={})
    assert with_key == without
