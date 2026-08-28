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

# The `demo` region set, as the real self-hosted graph reports it. Read off the
# running router rather than derived:
#
#   docker compose ... exec api python -c \
#     "import httpx,json;print(json.dumps(httpx.get('http://graphhopper:8989/info').json()['bbox']))"
#   [-1.449894, 6.379104, 80.389202, 54.991951]
#
# **The previous value was the `countries` set's union, under a comment claiming
# it was this one.** 81.877776 is Sri Lanka's whole eastern extent and 62.007902
# is northern Britain; `demo` cuts Sri Lanka to a 1x1 degree box around Colombo
# and never imports Scotland at all. Eleven references across ten tests were
# asserting against a graph this deployment has never built — and under it Ella
# (6.875 N, 81.038 E) is *inside* the box, which is the exact opposite of the
# behaviour those tests exist to describe.
#
# Note this is wider than the three cut boxes themselves, whose union is
# (-0.65, 6.43, 80.35, 52.86): osmium's complete-ways extraction keeps ways that
# cross a boundary, so the imported extent overruns the cut. That is why
# `describe()` renders "6°N to 55°N" here and "6°N to 53°N" from the cut union —
# and 55 is what the screenshot shows, so this constant is the one that
# reproduces what a user actually saw.
#
# The deployed graph outgrew this box on 2026-08-27 — the 82-region custom set
# spans Honolulu to Trincomalee — but the tests below stub their own region
# boxes to match this bbox, so the pair stays internally consistent: it is *a*
# self-hosted graph these tests describe, the three-region one this module's
# scenarios were measured against, not a claim about the one deployed today.
DEMO_BBOX = [-1.449894, 6.379104, 80.389202, 54.991951]


async def _no_extent(*a, **k):
    """A router that makes no coverage claim — the hosted API."""
    return None


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


# ---------------------------------------------------------------------------
# Inside the bounding box, inside none of the extracts
#
# The pre-flight check above compares against the graph's overall bbox, and that
# bbox is a *union*. The `demo` region set is three separate extracts spanning
# Sri Lanka to Britain, so Paris and Berlin sit inside the rectangle and inside
# none of the boxes: they pass the check, reach the router, and come back
# "Cannot find point".
#
# Found by running it. coverage.py's own docstring names Paris as the case it
# exists to prevent, and Paris was reaching the old message by the one path the
# pre-flight check cannot see.
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_paris_is_inside_the_bbox_and_so_passes_the_preflight(graph_says) -> None:
    """The premise of everything below. If this ever fails, the rest is moot."""
    graph_says(DEMO_BBOX)
    assert await coverage.outside_coverage(48.8566, 2.3522) is None


@pytest.mark.asyncio
async def test_an_unsnappable_point_on_a_finite_graph_does_not_say_move_a_little(
    graph_says, tmp_cache_db, monkeypatch: pytest.MonkeyPatch
) -> None:
    graph_says(DEMO_BBOX)

    from backend import routing

    async def cannot_find_point(*a, **k):
        raise routing.NoRouteFound(
            "No routable road or path was found near that point. "
            "Try moving the start a little.",
            point_not_snappable=True,
        )

    monkeypatch.setattr(routing, "_post_route", cannot_find_point)

    # Bourges: inside the union rectangle, inside none of the committed boxes.
    # This point was Paris until the 83-region expansion — this test reads the
    # real manifest rather than stubbing it, so the day Paris gained a box its
    # "certainly not covered" scenario stopped being one, and the test moved to
    # a city that still tells the story instead of quietly testing the other
    # branch.
    req = RouteRequest(origin=Point(lat=47.081, lon=2.399), minutes=30)
    with pytest.raises(OutsideCoverage) as caught:
        async for _ in main_mod.route_events(req):
            pass

    said = caught.value.human_message
    assert "moving the start a little" not in said
    assert "only part of the world's map loaded" in said
    assert "Nothing you did caused this" in said


async def _cannot_find_point_message(monkeypatch, lat: float, lon: float) -> str:
    """The sentence produced when the router says "Cannot find point"."""
    from backend import routing

    async def cannot_find_point(*a, **k):
        raise routing.NoRouteFound("nope", point_not_snappable=True)

    monkeypatch.setattr(routing, "_post_route", cannot_find_point)

    req = RouteRequest(origin=Point(lat=lat, lon=lon), minutes=30)
    with pytest.raises(OutsideCoverage) as caught:
        async for _ in main_mod.route_events(req):
            pass
    return caught.value.human_message


@pytest.mark.asyncio
async def test_it_hedges_when_nothing_recorded_the_per_region_boxes(
    graph_says, tmp_cache_db, monkeypatch: pytest.MonkeyPatch
) -> None:
    """**Changed behaviour, and this is the half that did not change.**

    Two things produce "Cannot find point" on a finite graph — an area never
    imported, and an unroutable spot inside one that was — and /info reports
    only the union of the regions, so with nothing else to go on the API cannot
    tell them apart. Naming one would be a guess presented as a measurement.

    This test used to be the whole story. It is now the fallback: a graph built
    before `scripts/graphhopper.sh` wrote a region manifest, or one built by
    hand, has no boxes to consult and must still hedge rather than guess.
    """
    graph_says(DEMO_BBOX)
    monkeypatch.setattr(coverage, "region_boxes", lambda: None)
    coverage.reset_region_cache()

    said = await _cannot_find_point_message(monkeypatch, 48.8566, 2.3522)
    assert "either" in said and " or " in said
    # The certain wording belongs to the pre-flight path, where the answer
    # really is certain. Borrowing it here would overstate what is known.
    assert "does not cover that area yet" not in said


@pytest.mark.asyncio
async def test_the_region_manifest_turns_the_hedge_into_an_answer(
    graph_says, tmp_cache_db, monkeypatch: pytest.MonkeyPatch
) -> None:
    """**New behaviour.** With per-region boxes, both causes get named exactly.

    Paris is inside the union rectangle and inside none of the boxes, which is
    the case the hedge existed for: it reaches the router, comes back "Cannot
    find point", and used to be told "either this area is not included yet, or
    there is no path close enough". It can now be told which.

    Hyde Park is the mirror. It is inside an imported box, so a failure there
    really is a spot the router could not snap to, and "try moving the start a
    little" — the sentence coverage.py exists to prevent everywhere else — is
    the correct advice.
    """
    graph_says(DEMO_BBOX)
    boxes = (
        coverage.Coverage(79.16416, 5.621275, 82.64612, 10.07153),  # Sri Lanka
        coverage.Coverage(-0.65, 51.02, 0.36, 52.03),  # Greater London
        coverage.Coverage(4.36, 51.86, 5.37, 52.86),  # Noord-Holland
    )
    monkeypatch.setattr(coverage, "region_boxes", lambda: boxes)

    paris = await _cannot_find_point_message(monkeypatch, 48.8566, 2.3522)
    assert "not one of the parts" in paris
    assert "either" not in paris

    hyde_park = await _cannot_find_point_message(monkeypatch, 51.507489, -0.162207)
    assert "on the map" in hyde_park
    assert "moving the start a little" in hyde_park


def test_the_committed_manifest_matches_the_region_set_that_was_built() -> None:
    """The manifest is a build artefact, and a stale one is worse than none.

    It is committed because the graph lives on the router's disk in a different
    container, so this file is the only thing that crosses. That makes it
    possible for it to describe a region set nobody built — which would make the
    definite answers above confidently wrong.
    """
    coverage.reset_region_cache()
    boxes = coverage.region_boxes()
    assert boxes is not None, "graphhopper/regions.manifest.json is missing"
    assert len(boxes) == 83

    # Ella is the location the first coverage round was made for.
    assert coverage.inside_an_imported_region(6.87528, 81.03833) is True
    # Kandy, Galle and Jaffna came with it.
    assert coverage.inside_an_imported_region(7.290572, 80.633728) is True
    # And the two original European boxes are still there, which `custom`
    # replacing `demo` rather than extending it makes a real risk.
    assert coverage.inside_an_imported_region(51.507489, -0.162207) is True
    assert coverage.inside_an_imported_region(52.357197, 4.864119) is True

    # The second coverage round. Rotterdam and Den Haag were inside the claimed
    # Noord-Holland box and absent from the graph — the zuid-holland line is
    # what makes the old claim true.
    assert coverage.inside_an_imported_region(51.9225, 4.47917) is True
    assert coverage.inside_an_imported_region(52.0800, 4.3000) is True
    # One per corner of the expansion: Central Park, Golden Gate Park.
    assert coverage.inside_an_imported_region(40.7812, -73.9665) is True
    assert coverage.inside_an_imported_region(37.7694, -122.4862) is True
    # Paris spent two docstrings in this repo as the canonical place Meander
    # does not cover. It is covered now, which is why the negative example
    # below had to move.
    assert coverage.inside_an_imported_region(48.8566, 2.3522) is True

    # Still a union of boxes, not a continent: Bourges is inside the rectangle
    # the boxes span and inside none of them, and so is the middle of Kansas.
    assert coverage.inside_an_imported_region(47.081, 2.399) is False
    assert coverage.inside_an_imported_region(39.0, -98.0) is False


@pytest.mark.asyncio
async def test_the_hosted_api_still_says_move_a_little(
    tmp_cache_db, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The upgrade is wrong against a router that has the whole planet.

    There, "Cannot find point" really does mean a lake or a car park, and moving
    the start a little really is the fix.
    """
    monkeypatch.setattr(coverage, "routable_extent", _no_extent)

    from backend import routing

    async def cannot_find_point(*a, **k):
        raise routing.NoRouteFound(
            "No routable road or path was found near that point. "
            "Try moving the start a little.",
            point_not_snappable=True,
        )

    monkeypatch.setattr(routing, "_post_route", cannot_find_point)

    req = RouteRequest(origin=Point(lat=48.8566, lon=2.3522), minutes=30)
    with pytest.raises(routing.NoRouteFound) as caught:
        async for _ in main_mod.route_events(req):
            pass

    assert not isinstance(caught.value, OutsideCoverage)
    assert "moving the start a little" in caught.value.human_message


@pytest.mark.asyncio
async def test_an_ordinary_no_route_is_left_alone(
    graph_says, tmp_cache_db, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Only "Cannot find point" is reinterpreted. "No connection between those
    two points" is about the pair, not about coverage, and stays as it is."""
    graph_says(DEMO_BBOX)

    from backend import routing

    async def no_connection(*a, **k):
        raise routing.NoRouteFound(
            "There is no route between those two points for this mode of travel."
        )

    monkeypatch.setattr(routing, "_post_route", no_connection)

    req = RouteRequest(origin=Point(lat=51.5074, lon=-0.1622), minutes=30)
    with pytest.raises(routing.NoRouteFound) as caught:
        async for _ in main_mod.route_events(req):
            pass

    assert not isinstance(caught.value, OutsideCoverage)
    assert "no route between those two points" in caught.value.human_message
