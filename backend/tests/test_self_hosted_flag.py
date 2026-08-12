"""MEANDER_GRAPHHOPPER_SELF_HOSTED, and the four things that hang off it.

Every one of these used to be decided by sniffing the hostname, which is right
on a laptop and wrong the moment the router lives behind a real name — a private
ALB, ECS Service Connect, a VPC address. None of the four fails loudly when the
answer is wrong, so each is pinned here **to the flag rather than to the host**.

The first is the dangerous one: with the flag False the accessible custom model
stops excluding IMPASSABLE surfaces, the app carries on answering, and its
answers get quietly less safe.
"""

from __future__ import annotations

import pytest

from backend import config, routing
from backend.config import SELF_HOSTED_ENV
from backend.geometry import LatLon

# A hostname that no sniff could ever call self-hosted. This is the shape of
# every address the router will actually have in production.
REAL_HOSTNAME_URL = "http://graphhopper.meander.internal:8989/route"
HOSTED_URL = "https://graphhopper.com/api/1/route"


@pytest.fixture
def router_at(monkeypatch: pytest.MonkeyPatch):
    """Point config at a URL and set (or clear) the explicit flag."""

    def _set(url: str, flag: str | None) -> None:
        monkeypatch.setattr(config, "GRAPHHOPPER_URL", url)
        if flag is None:
            monkeypatch.delenv(SELF_HOSTED_ENV, raising=False)
        else:
            monkeypatch.setenv(SELF_HOSTED_ENV, flag)

    return _set


# ---------------------------------------------------------------------------
# resolution itself
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("url", "flag", "expected"),
    [
        # The flag wins over the hostname in both directions.
        (REAL_HOSTNAME_URL, "1", True),
        ("http://localhost:8989/route", "0", False),
        (HOSTED_URL, "1", True),
        # Unset falls back to the sniff, so local development needs no config.
        ("http://localhost:8989/route", None, True),
        ("http://127.0.0.1:8989/route", None, True),
        ("http://gh.local:8989/route", None, True),
        (HOSTED_URL, None, False),
        (REAL_HOSTNAME_URL, None, False),
        # Empty string is "unset", not "false" — an env var set to nothing by a
        # deployment template must not silently disable smoothness.
        ("http://localhost:8989/route", "", True),
    ],
)
def test_flag_beats_hostname(router_at, url: str, flag: str | None, expected: bool) -> None:
    router_at(url, flag)
    assert config.graphhopper_is_self_hosted() is expected


def test_resolution_reports_where_the_answer_came_from(router_at) -> None:
    router_at(REAL_HOSTNAME_URL, "1")
    assert config.self_hosted_resolution()["source"] == "env"
    router_at(REAL_HOSTNAME_URL, None)
    assert config.self_hosted_resolution()["source"] == "hostname"


# ---------------------------------------------------------------------------
# consequence 1 — the smoothness hard constraint
# ---------------------------------------------------------------------------


def test_smoothness_survives_a_router_on_a_real_hostname(router_at) -> None:
    """The most dangerous bug in the codebase, pinned.

    A self-hosted router reachable by name must still be asked for smoothness,
    or one of the five hard accessibility constraints silently stops firing.
    """
    router_at(REAL_HOSTNAME_URL, "1")
    assert "smoothness" in config.path_details()

    model = routing.accessible_custom_model()
    clauses = [str(c.get("if", "")) for c in model["priority"]]
    assert any("smoothness == IMPASSABLE" in c for c in clauses), (
        "the accessible model must exclude IMPASSABLE surfaces when the router "
        "carries the smoothness encoded value"
    )


def test_smoothness_is_absent_against_the_hosted_api(router_at) -> None:
    """Referencing an encoded value the graph lacks fails the whole request."""
    router_at(HOSTED_URL, "0")
    assert "smoothness" not in config.path_details()
    clauses = [str(c.get("if", "")) for c in routing.accessible_custom_model()["priority"]]
    assert not any("smoothness" in c for c in clauses)


# ---------------------------------------------------------------------------
# consequence 2 — strict startup
# ---------------------------------------------------------------------------


def test_a_self_hosted_router_needs_no_api_key(router_at) -> None:
    """MEANDER_STRICT_STARTUP=1 must not refuse to boot against our own server."""
    router_at(REAL_HOSTNAME_URL, "1")
    settings = config.load_settings()
    object.__setattr__(settings, "graphhopper_key", None)
    assert "GRAPHHOPPER_KEY" not in settings.missing_keys()


def test_the_hosted_api_still_demands_a_key(router_at) -> None:
    router_at(HOSTED_URL, "0")
    settings = config.load_settings()
    object.__setattr__(settings, "graphhopper_key", None)
    assert "GRAPHHOPPER_KEY" in settings.missing_keys()


# ---------------------------------------------------------------------------
# consequence 3 — ch.disable on round trips
# ---------------------------------------------------------------------------


ORIGIN = LatLon(51.5074, -0.1278)


def test_fastest_round_trip_disables_ch_when_self_hosted(router_at) -> None:
    """The failure this prevents is subtle enough to be worth naming.

    scenic and accessible always carry a custom model and therefore always get
    ch.disable, so they keep working either way. It is the *fastest* round trip
    that a CH-prepared server rejects with "algorithm=round_trip cannot be used
    with CH" — and a fastest failure is re-raised, so the whole request dies.
    A test asserting "scenic loops fail" would pass for entirely the wrong
    reason.
    """
    router_at(REAL_HOSTNAME_URL, "1")
    body = routing.build_request_body(ORIGIN, None, 30, "foot", "fastest")
    assert body["algorithm"] == "round_trip"
    assert body.get("ch.disable") is True


def test_fastest_round_trip_keeps_ch_against_the_hosted_api(router_at) -> None:
    """Free packages answer any request carrying ch.disable with a 400."""
    router_at(HOSTED_URL, "0")
    body = routing.build_request_body(ORIGIN, None, 30, "foot", "fastest")
    assert body["algorithm"] == "round_trip"
    assert "ch.disable" not in body


def test_point_to_point_fastest_never_needs_flexible_mode(router_at) -> None:
    router_at(REAL_HOSTNAME_URL, "1")
    body = routing.build_request_body(ORIGIN, LatLon(51.51, -0.12), 30, "foot", "fastest")
    assert "ch.disable" not in body


# ---------------------------------------------------------------------------
# consequence 4 — how hard route_scenic searches, i.e. which route you get
# ---------------------------------------------------------------------------


def _stub_route(preset: str, minutes: float) -> routing.RawRoute:
    return routing.RawRoute(
        points=[LatLon(51.5074 + i * 0.001, -0.1278 + i * 0.001) for i in range(8)],
        distance_m=minutes * 75.0,
        duration_min=minutes,
        mode="foot",
        preset=preset,
    )


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("flag", "expected_requests"),
    [
        # Unmetered: search every candidate and pick the best on merit.
        ("1", len(routing.SCENIC_LOOP_CANDIDATES)),
        # Metered: take the first acceptable one and stop.
        ("0", 1),
    ],
)
async def test_scenic_search_depth_follows_the_flag(
    router_at, monkeypatch: pytest.MonkeyPatch, flag: str, expected_requests: int
) -> None:
    """This flag is not merely operational — it changes which route ships."""
    router_at(REAL_HOSTNAME_URL, flag)

    # Greenness is stubbed rather than computed, so the test measures how hard
    # route_scenic is willing to search and nothing else. The baseline is dull
    # and every candidate beats it, so each one clears both bars and the metered
    # path can legitimately stop at the first.
    from backend import geometry as geometry_mod

    def fake_score(points, elevations=None, details=None, clip_score=None):
        dull = len(points) == 9  # only the fastest stub is built with 9 points
        return type("S", (), {"scenic": 0.1 if dull else 0.9, "air": None})()

    monkeypatch.setattr(geometry_mod, "score_geometry", fake_score)

    calls: list[dict] = []

    async def fake_post(body, mode, preset):
        calls.append(body)
        return _stub_route(preset, 30.0)

    monkeypatch.setattr(routing, "_post_route", fake_post)

    fastest = _stub_route("fastest", 40.0)
    fastest.points = [LatLon(51.5074, -0.1278 + i * 0.002) for i in range(9)]

    await routing.route_scenic(ORIGIN, None, 30, "foot", fastest)
    assert len(calls) == expected_requests
