"""Rate-limit identity, and what a cross-origin browser is allowed to read.

_client_ip took X-Forwarded-For.split(",")[0] — the leftmost value, which is
entirely client-controlled. Any load balancer *appends* to that header, so a
client sending its own X-Forwarded-For lands first and gets a fresh token
bucket on every request. That is the whole rate limiter defeated by one header.
"""

from __future__ import annotations

import pytest

from backend import config
from backend import main as main_mod


class _FakeClient:
    def __init__(self, host: str) -> None:
        self.host = host


class _FakeRequest:
    def __init__(self, peer: str | None, xff: str | None = None) -> None:
        self.client = _FakeClient(peer) if peer else None
        self.headers = {"x-forwarded-for": xff} if xff else {}


@pytest.fixture
def hops(monkeypatch: pytest.MonkeyPatch):
    def _set(n: int) -> None:
        monkeypatch.setattr(main_mod, "TRUSTED_PROXY_HOPS", n)

    return _set


def test_zero_hops_ignores_the_header_entirely(hops) -> None:
    """The safe default: trust the socket, not the client."""
    hops(0)
    req = _FakeRequest("10.0.0.9", xff="1.2.3.4, 203.0.113.7")
    assert main_mod._client_ip(req) == "10.0.0.9"


def test_one_hop_reads_from_the_right(hops) -> None:
    """Behind one ALB the rightmost entry is the one the ALB observed."""
    hops(1)
    req = _FakeRequest("10.0.0.9", xff="203.0.113.7")
    assert main_mod._client_ip(req) == "203.0.113.7"


def test_a_spoofed_header_does_not_win(hops) -> None:
    """The attack this exists to stop.

    The client sends 'X-Forwarded-For: 1.2.3.4'; the ALB appends the address it
    actually saw. Reading from the left hands the attacker a fresh bucket for
    every value they invent.
    """
    hops(1)
    req = _FakeRequest("10.0.0.9", xff="1.2.3.4, 203.0.113.7")
    assert main_mod._client_ip(req) == "203.0.113.7"


def test_a_long_spoofed_chain_does_not_win_either(hops) -> None:
    hops(1)
    spoof = ", ".join(f"1.2.3.{i}" for i in range(20))
    req = _FakeRequest("10.0.0.9", xff=f"{spoof}, 203.0.113.7")
    assert main_mod._client_ip(req) == "203.0.113.7"


def test_a_rotating_spoof_maps_to_one_bucket(hops) -> None:
    """The property that actually matters: one client, one bucket."""
    hops(1)
    from backend.ratelimit import client_digest

    seen = {
        client_digest(main_mod._client_ip(_FakeRequest("10.0.0.9", xff=f"9.9.9.{i}, 203.0.113.7")))
        for i in range(50)
    }
    assert len(seen) == 1


def test_two_hops_steps_further_left(hops) -> None:
    hops(2)
    req = _FakeRequest("10.0.0.9", xff="1.2.3.4, 203.0.113.7, 10.0.0.1")
    assert main_mod._client_ip(req) == "203.0.113.7"


def test_a_shorter_chain_than_configured_falls_back_to_the_peer(hops) -> None:
    """Something is not appending; do not trust a client-controlled entry."""
    hops(2)
    req = _FakeRequest("10.0.0.9", xff="1.2.3.4")
    assert main_mod._client_ip(req) == "10.0.0.9"


def test_no_header_falls_back_to_the_peer(hops) -> None:
    hops(1)
    assert main_mod._client_ip(_FakeRequest("10.0.0.9")) == "10.0.0.9"


# ---------------------------------------------------------------------------
# CORS
# ---------------------------------------------------------------------------


def test_the_browser_can_read_retry_after_and_the_cache_header(api_client) -> None:
    """Retry-After is invisible cross-origin without expose_headers, which is
    why the frontend's backoff has never run."""
    # On the actual response, not the preflight: Access-Control-Expose-Headers
    # is what tells the browser which response headers JS may read.
    resp = api_client.get("/api/health", headers={"Origin": "http://localhost:5173"})
    exposed = resp.headers.get("access-control-expose-headers", "")
    for header in ("Retry-After", "X-Meander-Cache", "X-Request-Id"):
        assert header in exposed


def test_localhost_is_allowed_when_nothing_is_configured(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Local development must need no configuration at all."""
    monkeypatch.delenv("MEANDER_ALLOWED_ORIGINS", raising=False)
    monkeypatch.delenv("MEANDER_ALLOW_LOCAL_ORIGINS", raising=False)
    assert "http://localhost:5173" in config._resolve_origins()


def test_a_configured_deployment_does_not_silently_allow_localhost(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A page served from a laptop should not be able to call production."""
    monkeypatch.setenv("MEANDER_ALLOWED_ORIGINS", "https://meander.example")
    monkeypatch.delenv("MEANDER_ALLOW_LOCAL_ORIGINS", raising=False)
    origins = config._resolve_origins()
    assert origins == ("https://meander.example",)


def test_local_origins_can_still_be_opted_into(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("MEANDER_ALLOWED_ORIGINS", "https://meander.example")
    monkeypatch.setenv("MEANDER_ALLOW_LOCAL_ORIGINS", "1")
    assert "http://localhost:5173" in config._resolve_origins()


# ---------------------------------------------------------------------------
# a fractional refill rate
# ---------------------------------------------------------------------------


def test_a_fractional_refill_rate_survives(monkeypatch: pytest.MonkeyPatch) -> None:
    """int("0.5") raises, and the old code swallowed it into the default of 3."""
    monkeypatch.setenv("MEANDER_RATE_REFILL_PER_MIN", "0.5")
    assert config.load_settings().per_ip_refill_per_min == 0.5


def test_an_unparseable_refill_rate_still_falls_back(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("MEANDER_RATE_REFILL_PER_MIN", "banana")
    assert config.load_settings().per_ip_refill_per_min == 3.0
