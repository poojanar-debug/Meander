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
# was only ever true of a single-origin deployment, which is not the one that
# serves traffic: the site is on Cloudflare Pages and the API on the VM, so
# every browser call is cross-origin. The iOS app is more so — it serves its
# own assets from `capacitor://localhost` and calls the API host, so the
# allowlist has to name a scheme that is not http or https.
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
    The since-removed deployment templates shipped MEANDER_ALLOWED_ORIGINS as
    the empty string, so that allowlist was never empty — it was exactly
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

    Still true, and now only in development. The suite runs in replay mode
    (conftest.py:26), which is exactly what "development" means to
    _resolve_origins, so an unconfigured origin list still yields the dev-server
    allowlist here — the behaviour `make run` depends on and the property
    test_localhost_is_allowed_when_nothing_is_configured pins.

    What changed is the production half. This used to hold in live mode too, so
    a deployment that forgot MEANDER_ALLOWED_ORIGINS silently allowlisted the
    Vite dev server. That was documented rather than fixed, and closed only in
    deployment templates that no longer exist — a fix the compose deploy never
    inherited. See test_live_mode_never_allows_localhost_by_omission below.
    """
    monkeypatch.setenv("MEANDER_ALLOWED_ORIGINS", "")
    monkeypatch.delenv("MEANDER_ALLOW_LOCAL_ORIGINS", raising=False)

    assert config._resolve_origins() == (
        "http://localhost:5173",
        "http://127.0.0.1:5173",
    )


def test_live_mode_never_allows_localhost_by_omission(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Forgetting to configure origins in production must close the door, not open it.

    live is the only fixture mode that talks to real upstreams, which makes it
    the one honest signal for "this is not a laptop". A deployment that sets
    nothing gets an empty allowlist — every cross-origin request refused — which
    is a loud, obvious failure rather than a quiet, wrong success.
    """
    monkeypatch.setenv("MEANDER_FIXTURES", "live")
    monkeypatch.delenv("MEANDER_ALLOWED_ORIGINS", raising=False)
    monkeypatch.delenv("MEANDER_ALLOW_LOCAL_ORIGINS", raising=False)

    assert config._resolve_origins() == ()


def test_live_mode_still_honours_an_explicit_opt_in(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """docker-compose.yml is a laptop file that runs live against the real router.

    It needs the dev server allowed and says so explicitly. Keying the *default*
    off fixture mode must not take the override away, or the one-command local
    stack stops working.
    """
    monkeypatch.setenv("MEANDER_FIXTURES", "live")
    monkeypatch.setenv("MEANDER_ALLOWED_ORIGINS", "")
    monkeypatch.setenv("MEANDER_ALLOW_LOCAL_ORIGINS", "1")

    assert "http://localhost:5173" in config._resolve_origins()


def test_live_mode_with_a_real_origin_does_not_gain_localhost(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The shape of the actual deployment: a Pages origin and nothing else."""
    monkeypatch.setenv("MEANDER_FIXTURES", "live")
    monkeypatch.setenv("MEANDER_ALLOWED_ORIGINS", "https://meander.pages.dev")
    monkeypatch.delenv("MEANDER_ALLOW_LOCAL_ORIGINS", raising=False)

    assert config._resolve_origins() == ("https://meander.pages.dev",)


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


def test_one_address_cannot_outspend_the_global_ceiling() -> None:
    """The per-IP rate and the global ceiling have to be coherent with each other.

    They were not. At 3.0/min a single address sustained 3 x 60 x 24 = 4,320
    requests a day against a global ceiling of 2,000, so one IP could exhaust
    the allowance for everybody — accidentally, in about eleven hours — and
    nothing in the code related the two numbers, so nothing said so.

    This is the relation, not the values: raise the refill rate without raising
    the ceiling and this fails.

    ⚠ It grades the committed defaults, and only those. A reviewer pointed out
    that `MEANDER_RATE_REFILL_PER_MIN=60 MEANDER_DAILY_ROUTE_CEILING=100` passes
    here while the running process would allow 86,400 a day per IP against a
    ceiling of 100 — and both keys ship in .env.example, so overriding them is
    the documented path.

    Grading load_settings() instead was tried and is worse: it reads the ambient
    environment, so on any machine with a real .env — this one, where the suite
    went red with "4320 against a 120/day ceiling" — the test fails for reasons
    that have nothing to do with what is committed. A test cannot see the VM's
    environment from here.

    What would close it is a check at startup, next to MEANDER_STRICT_STARTUP,
    which already owns the question of refusing to boot on bad configuration.
    That is a runtime semantics change and is deliberately left for the release
    session rather than slipped in here.
    """
    _assert_coherent(config.Settings())


def _assert_coherent(s: config.Settings) -> None:
    sustained_per_day = s.per_ip_refill_per_min * 60 * 24
    assert sustained_per_day <= s.global_daily_route_ceiling, (
        f"one IP sustains {sustained_per_day:.0f} requests/day against a "
        f"{s.global_daily_route_ceiling}/day global ceiling"
    )


def test_the_coherence_check_can_fail() -> None:
    """The relation above, proved to reject something.

    Without this, _assert_coherent could be `pass` and the test above would be a
    green light for any pair of numbers at all.
    """
    with pytest.raises(AssertionError, match="4320 requests/day"):
        _assert_coherent(
            config.Settings(per_ip_refill_per_min=3.0, global_daily_route_ceiling=2000)
        )


def test_a_fractional_refill_rate_survives(monkeypatch: pytest.MonkeyPatch) -> None:
    """int("0.5") raises, and the old code swallowed it into the default of 3."""
    monkeypatch.setenv("MEANDER_RATE_REFILL_PER_MIN", "0.5")
    assert config.load_settings().per_ip_refill_per_min == 0.5


def test_an_unparseable_refill_rate_still_falls_back(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("MEANDER_RATE_REFILL_PER_MIN", "banana")
    # Against the dataclass default rather than a literal. Written as a literal
    # this asserted 3.0, so lowering the default failed here — in a test about
    # *parsing*, which has no opinion on what the number should be.
    assert config.load_settings().per_ip_refill_per_min == config.Settings().per_ip_refill_per_min


def test_an_empty_flag_value_means_unset_not_false(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """.env.example is a file people copy to .env and fill in selectively.

    Every key it lists is present with an empty value, so a copied file sets
    MEANDER_ALLOW_LOCAL_ORIGINS='' — and _env_flag read that as false, silently
    switching off the dev-server origins the same file promises need no
    configuration. _env_int and _env_float had always treated blank as absent;
    only the flag helper did not.

    An explicit 0 must still override, or the escape hatch is gone.
    """
    monkeypatch.setenv("MEANDER_FIXTURES", "replay")
    monkeypatch.setenv("MEANDER_ALLOWED_ORIGINS", "")

    monkeypatch.setenv("MEANDER_ALLOW_LOCAL_ORIGINS", "")
    assert "http://localhost:5173" in config._resolve_origins()

    monkeypatch.setenv("MEANDER_ALLOW_LOCAL_ORIGINS", "0")
    assert config._resolve_origins() == ()
