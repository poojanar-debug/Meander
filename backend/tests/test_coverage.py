"""Outside the imported graph is a different answer from "no route here".

Self-hosting made coverage finite. GraphHopper's reply for a point outside the
graph is "Cannot find point", which routing.py has always rendered as *"No
routable road or path was found near that point. Try moving the start a
little."* — which blames the user's choice of street corner for a decision the
operator made about how much of the world to import, and invites them to retry
somewhere that will fail identically.
"""

from __future__ import annotations

import httpx
import pytest

from backend import config, coverage
from backend import main as main_mod
from backend.models import Point, RouteRequest
from backend.routing import OutsideCoverage

# Sri Lanka + Britain + the Netherlands, as the real self-hosted graph reports.
DEMO_BBOX = [-8.584844, 5.919332, 81.877776, 62.007902]


@pytest.fixture(autouse=True)
def _fresh():
    coverage.reset_cache()
    yield
    coverage.reset_cache()


@pytest.fixture
def graph_says(monkeypatch: pytest.MonkeyPatch):
    """Stand in for the router's /info, without a socket."""

    def _set(bbox, status=200):
        class FakeClient:
            async def __aenter__(self):
                return self

            async def __aexit__(self, *a):
                return False

            async def get(self, url):
                return httpx.Response(
                    status, json={"bbox": bbox}, request=httpx.Request("GET", url)
                )

        monkeypatch.setattr(coverage.httpx, "AsyncClient", lambda **k: FakeClient())
        monkeypatch.setenv(config.SELF_HOSTED_ENV, "1")

    return _set


@pytest.mark.asyncio
async def test_a_point_inside_the_graph_is_not_flagged(graph_says) -> None:
    graph_says(DEMO_BBOX)
    assert await coverage.outside_coverage(51.5074, -0.1622) is None  # London


@pytest.mark.asyncio
async def test_a_point_outside_the_graph_is(graph_says) -> None:
    graph_says(DEMO_BBOX)
    # Sydney: comfortably outside a graph spanning Sri Lanka to Britain.
    extent = await coverage.outside_coverage(-33.8688, 151.2093)
    assert extent is not None
    assert "does not cover that area yet" in coverage.message(extent)
    # And it says what *is* covered, which is the difference between "no" and
    # "not here, but here".
    assert "°" in coverage.message(extent)


@pytest.mark.asyncio
async def test_it_does_not_tell_them_to_move_a_little(graph_says) -> None:
    """The whole point. That advice is right for a lake and wrong for a country."""
    graph_says(DEMO_BBOX)
    extent = await coverage.outside_coverage(-33.8688, 151.2093)
    text = coverage.message(extent)
    assert "moving a little will not help" in text
    assert "Nothing you did caused this" in text


@pytest.mark.asyncio
async def test_the_hosted_api_makes_no_coverage_claim(monkeypatch: pytest.MonkeyPatch) -> None:
    """It routes the planet, so there is no extent and nothing to say."""
    monkeypatch.setenv(config.SELF_HOSTED_ENV, "0")
    assert await coverage.routable_extent() is None
    assert await coverage.outside_coverage(-33.8688, 151.2093) is None


@pytest.mark.asyncio
async def test_a_router_that_will_not_say_is_not_treated_as_not_covering(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """None means "no claim". Treating it as "not covered" would refuse every
    request the moment /info went unreachable."""
    monkeypatch.setenv(config.SELF_HOSTED_ENV, "1")

    class Dead:
        async def __aenter__(self):
            return self

        async def __aexit__(self, *a):
            return False

        async def get(self, url):
            raise httpx.ConnectError("refused")

    monkeypatch.setattr(coverage.httpx, "AsyncClient", lambda **k: Dead())
    assert await coverage.routable_extent() is None
    assert await coverage.outside_coverage(-33.8688, 151.2093) is None


@pytest.mark.asyncio
async def test_the_extent_is_fetched_once(monkeypatch: pytest.MonkeyPatch) -> None:
    """Every request would otherwise poll the router for a graph that cannot change."""
    monkeypatch.setenv(config.SELF_HOSTED_ENV, "1")
    calls = {"n": 0}

    class Counting:
        async def __aenter__(self):
            return self

        async def __aexit__(self, *a):
            return False

        async def get(self, url):
            calls["n"] += 1
            return httpx.Response(
                200, json={"bbox": DEMO_BBOX}, request=httpx.Request("GET", url)
            )

    monkeypatch.setattr(coverage.httpx, "AsyncClient", lambda **k: Counting())

    for _ in range(25):
        await coverage.routable_extent()

    assert calls["n"] == 1, f"the router was polled {calls['n']} times for a fixed graph"


@pytest.mark.asyncio
async def test_the_request_path_raises_before_routing(
    graph_says, tmp_cache_db, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Checked up front, so no GraphHopper credit is spent discovering it."""
    graph_says(DEMO_BBOX)

    from backend import routing

    async def must_not_route(*a, **k):
        raise AssertionError("routing was attempted for a point outside the graph")

    monkeypatch.setattr(routing, "_post_route", must_not_route)

    req = RouteRequest(origin=Point(lat=-33.8688, lon=151.2093), minutes=30)
    with pytest.raises(OutsideCoverage) as caught:
        async for _ in main_mod.route_events(req):
            pass

    assert caught.value.kind == "outside_coverage"
    assert caught.value.status_code == 422
    assert "does not cover that area yet" in caught.value.human_message


@pytest.mark.asyncio
async def test_a_destination_outside_the_graph_is_caught_too(
    graph_says, tmp_cache_db, monkeypatch: pytest.MonkeyPatch
) -> None:
    graph_says(DEMO_BBOX)
    from backend import routing

    monkeypatch.setattr(routing, "_post_route", lambda *a, **k: None)

    req = RouteRequest(
        origin=Point(lat=51.5074, lon=-0.1622),
        destination=Point(lat=-33.8688, lon=151.2093),
        minutes=30,
    )
    with pytest.raises(OutsideCoverage):
        async for _ in main_mod.route_events(req):
            pass
