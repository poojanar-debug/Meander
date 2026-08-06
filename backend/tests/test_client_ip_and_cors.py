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
# CORS for the native app
#
# DEPLOY.md used to say "there is no CORS step, and that is deliberate". That
# was true of the web deployment and only of it: one CloudFront distribution
# serves the site and proxies /api/*, so the browser never makes a cross-origin
# request. The iOS app serves its own assets from `capacitor://localhost` and
# calls https://<distribution>/api/*, which is cross-origin by any definition.
# Preflight and CORS apply, and the allowlist has to name a scheme that is not
# http or https.
# ---------------------------------------------------------------------------

APP_ORIGIN = "capacitor://localhost"


def test_a_custom_scheme_survives_the_allowlist_intact(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """`capacitor://localhost` must come back exactly as it went in.

    An Origin is compared as an opaque string, so anything that normalises or
    re-serialises it — adding a trailing slash, lowercasing a host that was
    already lowercase, running it through urlsplit and back — produces a value
    that never matches and a failure that looks like the allowlist being
    ignored.
    """
    monkeypatch.setenv("MEANDER_ALLOWED_ORIGINS", APP_ORIGIN)
    monkeypatch.delenv("MEANDER_ALLOW_LOCAL_ORIGINS", raising=False)

    assert config._resolve_origins() == (APP_ORIGIN,)


def test_the_app_and_the_site_can_both_be_allowed(monkeypatch: pytest.MonkeyPatch) -> None:
    """The deployment serves a website and an app against one API."""
    monkeypatch.setenv("MEANDER_ALLOWED_ORIGINS", f"{APP_ORIGIN},https://meander.example")
    monkeypatch.delenv("MEANDER_ALLOW_LOCAL_ORIGINS", raising=False)

    assert config._resolve_origins() == (APP_ORIGIN, "https://meander.example")


def test_configuring_the_app_origin_stops_allowlisting_the_vite_dev_server(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The live defect this phase exists to close, pinned so it cannot return.

    `_resolve_origins` defaults MEANDER_ALLOW_LOCAL_ORIGINS to `not origins`.
    infra/20-services.yaml shipped MEANDER_ALLOWED_ORIGINS as the empty string,
    so the deployed task's allowlist was never empty — it was exactly
    ('http://localhost:5173', '127.0.0.1:5173'). Production allowlisted the Vite
    dev server, and nothing said so.

    Setting CorsOrigins flips that default off. It does so as a *side effect* of
    the list becoming non-empty, which is the behaviour we want and precisely
    the kind of thing that gets refactored away by someone tidying the
    conditional. Hence a test that names it.
    """
    monkeypatch.setenv("MEANDER_ALLOWED_ORIGINS", APP_ORIGIN)
    monkeypatch.delenv("MEANDER_ALLOW_LOCAL_ORIGINS", raising=False)

    origins = config._resolve_origins()

    assert "http://localhost:5173" not in origins
    assert "http://127.0.0.1:5173" not in origins


def test_an_empty_origin_list_still_means_local_development(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The other half of the same defect: '' is not 'deny everything'.

    Documented rather than changed. A deployment that leaves CorsOrigins empty
    gets the dev-server allowlist, which is wrong for production and right for a
    developer running `make run` — and the fix is to configure it, which
    infra/20-services.yaml now does.
    """
    monkeypatch.setenv("MEANDER_ALLOWED_ORIGINS", "")
    monkeypatch.delenv("MEANDER_ALLOW_LOCAL_ORIGINS", raising=False)

    assert config._resolve_origins() == (
        "http://localhost:5173",
        "http://127.0.0.1:5173",
    )


def test_the_resolved_allowlist_is_what_the_middleware_was_given() -> None:
    """The link between config and the app, which nothing else covers.

    `_resolve_origins` is tested above and the middleware's behaviour below, but
    both would still pass if main.py were changed to pass a hard-coded list. The
    middleware is constructed once at import from `settings.allowed_origins`, so
    this is the only place that join can be checked.
    """
    from starlette.middleware.cors import CORSMiddleware

    from backend import main as main_mod

    cors = [m for m in main_mod.app.user_middleware if m.cls is CORSMiddleware]
    assert len(cors) == 1, "expected exactly one CORS middleware"
    assert cors[0].kwargs["allow_origins"] == list(main_mod.settings.allowed_origins)


def test_a_custom_scheme_origin_is_allowed_by_the_middleware_itself() -> None:
    """An end-to-end check that Starlette's CORS implementation accepts
    `capacitor://`, rather than an assumption that it treats an Origin as an
    opaque string.

    Built as a separate app because backend.main's middleware is constructed at
    import time from the environment, and reloading that module mid-suite would
    hand every other test a different `limiter` and `metrics` than conftest
    resets.
    """
    from starlette.applications import Starlette
    from starlette.middleware.cors import CORSMiddleware
    from starlette.responses import PlainTextResponse
    from starlette.routing import Route
    from starlette.testclient import TestClient

    from backend import main as main_mod

    probe = Starlette(routes=[Route("/x", lambda _r: PlainTextResponse("ok"))])
    configured = next(m for m in main_mod.app.user_middleware if m.cls is CORSMiddleware)
    kwargs = dict(configured.kwargs)
    kwargs["allow_origins"] = [APP_ORIGIN]
    probe.add_middleware(CORSMiddleware, **kwargs)

    with TestClient(probe) as client:
        allowed = client.get("/x", headers={"Origin": APP_ORIGIN})
        refused = client.get("/x", headers={"Origin": "https://not-meander.example"})

        preflight = client.options(
            "/x",
            headers={
                "Origin": APP_ORIGIN,
                "Access-Control-Request-Method": "POST",
                "Access-Control-Request-Headers": "content-type",
            },
        )

    assert allowed.headers.get("access-control-allow-origin") == APP_ORIGIN
    assert refused.headers.get("access-control-allow-origin") is None
    assert preflight.status_code == 200
    assert preflight.headers.get("access-control-allow-origin") == APP_ORIGIN
    assert "POST" in preflight.headers.get("access-control-allow-methods", "")


def test_a_foreign_origin_does_not(api_client) -> None:
    """The allowlist has to actually exclude something, or it is decoration."""
    resp = api_client.get("/api/healthz", headers={"Origin": "https://not-meander.example"})

    assert resp.headers.get("access-control-allow-origin") is None


def test_the_preflight_answers_the_route_request(api_client) -> None:
    """`POST /api/routes` with Content-Type: application/json is not a simple
    request, so the browser sends OPTIONS first and never sends the POST if it
    does not like the answer. Both headers the client sets must be named."""
    resp = api_client.options(
        "/api/routes",
        headers={
            "Origin": "http://localhost:5173",
            "Access-Control-Request-Method": "POST",
            "Access-Control-Request-Headers": "content-type",
        },
    )

    assert resp.status_code == 200
    assert "POST" in resp.headers.get("access-control-allow-methods", "")
    allowed = resp.headers.get("access-control-allow-headers", "").lower()
    assert "content-type" in allowed
    assert "accept" in allowed


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
