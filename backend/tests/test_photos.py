"""Route photos.

Three things are being protected here, and only one of them is "does it work".

**Attribution.** Both sources require credit, so a photograph whose licence
cannot be read out of the upstream response has to be dropped rather than shown.
There is a test for the drop, and there is deliberately no rendering path for an
unknown licence to fall back to.

**Honesty.** The hero photo is chosen by what the route was optimised for, and
for four of the six objectives there is no per-segment data on a `Route` to
choose from. The tests below pin that the response says so rather than letting
the objective's name imply a measurement nobody made.

**Not being an open proxy.** /api/photo takes a reference and fetches a URL, and
the tests cover the signature, the host allowlist, the size cap and the content
type separately, because each of them is on its own sufficient to stop a
different attack and any one of them could be removed without the others
failing.

Every upstream here is an `httpx.MockTransport`. Nothing opens a socket: CI runs
this suite under `unshare -n`.
"""

from __future__ import annotations

import dataclasses
import math
from typing import Any

import httpx
import pytest

from backend import fixtures as fx
from backend import photos
from backend.config import TEST_LOCATIONS_BY_SLUG
from backend.geometry import EARTH_RADIUS_M, LatLon
from backend.models import Blocker, PhotosRequest

M_PER_DEG = math.pi * EARTH_RADIUS_M / 180.0

HYDE = TEST_LOCATIONS_BY_SLUG["hyde-park-london"]

COMMONS_THUMB = (
    "https://upload.wikimedia.org/wikipedia/commons/thumb/a/ab/Serpentine.jpg/"
    "640px-Serpentine.jpg"
)
MAPILLARY_THUMB = "https://scontent-lhr8-1.xx.fbcdn.net/m1/v/t6/An-frame.jpg?stp=s1024x768"


# ---------------------------------------------------------------------------
# helpers
# ---------------------------------------------------------------------------


def _line_lonlat(metres: float = 1000.0, n: int = 41) -> list[list[float]]:
    """A straight line north from Hyde Park, on the wire in ``[lon, lat]`` order.

    41 vertices over 1,000 m is a vertex every 25 m, so an anchor asked for at
    500 m lands on one exactly. That matters for the midpoint test: if the
    nearest vertex to halfway were 12 m off, the assertion would be testing the
    vertex spacing rather than the anchor placement.
    """
    return [[HYDE.lon, HYDE.lat + (metres * i / (n - 1)) / M_PER_DEG] for i in range(n)]


def _commons_page(
    pageid: int,
    title: str = "File:Serpentine bridge, Hyde Park.jpg",
    thumb: str = COMMONS_THUMB,
    licence: str | None = "CC BY-SA 4.0",
    artist: str | None = '<a href="//commons.wikimedia.org/wiki/User:A" title="A">Ada L</a>',
    lat: float | None = None,
    lon: float | None = None,
) -> dict[str, Any]:
    extmetadata: dict[str, Any] = {}
    if licence is not None:
        extmetadata["LicenseShortName"] = {"value": licence}
        extmetadata["LicenseUrl"] = {"value": "https://creativecommons.org/licenses/by-sa/4.0"}
    if artist is not None:
        extmetadata["Artist"] = {"value": artist}
    page: dict[str, Any] = {
        "pageid": pageid,
        "ns": 6,
        "title": title,
        "imageinfo": [
            {
                "url": "https://upload.wikimedia.org/wikipedia/commons/a/ab/Serpentine.jpg",
                "descriptionurl": "https://commons.wikimedia.org/wiki/File:Serpentine.jpg",
                "thumburl": thumb,
                "thumbwidth": 640,
                "thumbheight": 427,
                "extmetadata": extmetadata,
            }
        ],
    }
    if lat is not None and lon is not None:
        page["coordinates"] = [{"lat": lat, "lon": lon, "primary": "", "globe": "earth"}]
    return page


def _commons_body(*pages: dict[str, Any]) -> dict[str, Any]:
    return {"batchcomplete": True, "query": {"pages": list(pages)}}


def _mapillary_body(count: int = 1) -> dict[str, Any]:
    return {
        "data": [
            {
                "id": f"100{i}",
                "thumb_1024_url": f"{MAPILLARY_THUMB}&i={i}",
                "computed_geometry": {
                    "type": "Point",
                    "coordinates": [HYDE.lon, HYDE.lat],
                },
                "captured_at": 1_700_000_000_000 + i,
            }
            for i in range(count)
        ]
    }


def _transport(
    monkeypatch: pytest.MonkeyPatch,
    *,
    commons: Any = None,
    mapillary: Any = None,
    image: Any = None,
) -> dict[str, list[httpx.Request]]:
    """Point the one shared httpx client at a handler that answers by host.

    Each argument is either an `httpx.Response`, a callable taking the request,
    or None meaning "this host is not expected to be contacted" — which is
    asserted rather than defaulted, because "no token means Mapillary is never
    called" is one of the properties under test and a permissive default would
    hide its failure.
    """
    seen: dict[str, list[httpx.Request]] = {"commons": [], "mapillary": [], "image": []}

    def _answer(which: str, spec: Any, request: httpx.Request) -> httpx.Response:
        seen[which].append(request)
        if spec is None:
            raise AssertionError(f"{which} was contacted and should not have been")
        return spec(request) if callable(spec) else spec

    def handler(request: httpx.Request) -> httpx.Response:
        host = request.url.host
        if host == "commons.wikimedia.org":
            return _answer("commons", commons, request)
        if host == "graph.mapillary.com":
            return _answer("mapillary", mapillary, request)
        return _answer("image", image, request)

    monkeypatch.setattr(fx, "_client", httpx.AsyncClient(transport=httpx.MockTransport(handler)))
    return seen


def _with_token(monkeypatch: pytest.MonkeyPatch, token: str | None) -> None:
    """`Settings` is frozen, so a token arrives as a replaced copy.

    The value is a shape, never a credential. conftest.py blanks MAPILLARY_TOKEN
    for the whole suite precisely so that a real one in someone's .env cannot
    change what these tests assert.
    """
    monkeypatch.setattr(
        photos, "settings", dataclasses.replace(photos.settings, mapillary_token=token)
    )


@pytest.fixture(autouse=True)
def _reset_photo_limiter():
    """The image bucket is process-wide and conftest only knows about the route one."""
    from backend.main import photo_limiter

    photo_limiter.reset()
    yield
    photo_limiter.reset()


# ---------------------------------------------------------------------------
# anchor placement
# ---------------------------------------------------------------------------


def test_anchors_are_evenly_spaced_and_never_sit_on_the_origin() -> None:
    """A photo of where the user is standing is the one photo they do not need."""
    points = [LatLon(p[1], p[0]) for p in _line_lonlat()]

    anchors = photos._even_anchors(points, 5)

    assert [a.at_m for a in anchors] == [100.0, 300.0, 500.0, 700.0, 900.0]
    assert all(a.at_m > 0 for a in anchors)


def test_an_odd_anchor_count_puts_one_exactly_halfway() -> None:
    """The `fastest` hero is the midpoint, and an even count has no midpoint.

    With four anchors the nearest to halfway is 37.5% or 62.5% of the way along,
    and a caption reading "about halfway" over a photo taken a third of the way
    into the walk is the kind of quiet inaccuracy this project does not ship.
    """
    points = [LatLon(p[1], p[0]) for p in _line_lonlat()]

    odd = [a.at_m for a in photos._even_anchors(points, 5)]
    even = [a.at_m for a in photos._even_anchors(points, 4)]

    assert 500.0 in odd
    assert 500.0 not in even


def test_the_barrier_replaces_an_anchor_rather_than_adding_one() -> None:
    """Cost must not depend on whether the route happens to have a gate on it."""
    points = [LatLon(p[1], p[0]) for p in _line_lonlat()]
    blocker = Blocker(
        type="gate", lat=HYDE.lat + (600 / M_PER_DEG), lon=HYDE.lon, description="Locked gate"
    )

    plain = photos._anchors_for(points, "accessible", [])
    with_barrier = photos._anchors_for(points, "accessible", [blocker])

    assert len(with_barrier) == len(plain)
    assert with_barrier[0].is_barrier
    assert with_barrier[0].at_m == pytest.approx(600.0, abs=25.0)
    assert not any(a.is_barrier for a in with_barrier[1:])


def test_the_barrier_anchor_is_the_barrier_and_not_the_nearest_route_vertex() -> None:
    """A gate is a few metres off the line, and that is the distance that matters.

    Centring the photo search on the polyline rather than on the gate centres it
    on the wrong thing by exactly the offset the user is being shown.
    """
    points = [LatLon(p[1], p[0]) for p in _line_lonlat()]
    off_line = LatLon(HYDE.lat + (600 / M_PER_DEG), HYDE.lon + (30 / M_PER_DEG))
    blocker = Blocker(type="gate", lat=off_line.lat, lon=off_line.lon, description="Locked gate")

    anchors = photos._anchors_for(points, "accessible", [blocker])

    assert anchors[0].point.lon == pytest.approx(off_line.lon)
    assert anchors[0].point.lon != pytest.approx(points[0].lon)


def test_a_barrier_is_only_folded_in_for_the_accessible_objective() -> None:
    points = [LatLon(p[1], p[0]) for p in _line_lonlat()]
    blocker = Blocker(type="gate", lat=HYDE.lat, lon=HYDE.lon, description="Locked gate")

    assert not any(a.is_barrier for a in photos._anchors_for(points, "scenic", [blocker]))


# ---------------------------------------------------------------------------
# Wikimedia Commons parsing
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_a_commons_photo_carries_its_licence_and_author(
    monkeypatch: pytest.MonkeyPatch, fixture_mode
) -> None:
    _transport(monkeypatch, commons=httpx.Response(200, json=_commons_body(_commons_page(1))))
    fixture_mode("live")

    found = await photos.commons_photos_near(photos.Anchor(LatLon(HYDE.lat, HYDE.lon), 100.0))

    assert found is not None
    (photo,) = found
    assert photo.licence == "CC BY-SA 4.0"
    assert photo.author == "Ada L"
    assert photo.attribution == "Ada L, CC BY-SA 4.0, via Wikimedia Commons"
    assert photo.source_page == "https://commons.wikimedia.org/wiki/File:Serpentine.jpg"


@pytest.mark.asyncio
async def test_a_photo_with_no_determinable_licence_is_dropped(
    monkeypatch: pytest.MonkeyPatch, fixture_mode
) -> None:
    """Attribution is a legal requirement, not a nicety.

    There is no "licence unknown" rendering path and there must not be one: that
    caption is an admission published on the photographer's behalf.
    """
    _transport(
        monkeypatch,
        commons=httpx.Response(
            200,
            json=_commons_body(
                _commons_page(1, licence=None), _commons_page(2, thumb=COMMONS_THUMB + "?v=2")
            ),
        ),
    )
    fixture_mode("live")

    found = await photos.commons_photos_near(photos.Anchor(LatLon(HYDE.lat, HYDE.lon), 100.0))

    assert found is not None
    assert len(found) == 1, "the unlicensed file must not survive"
    assert found[0].licence == "CC BY-SA 4.0"


@pytest.mark.asyncio
async def test_the_artist_field_is_html_and_is_reduced_to_text(
    monkeypatch: pytest.MonkeyPatch, fixture_mode
) -> None:
    """`Artist` is nearly always an anchor tag. Escaping it would show the markup."""
    _transport(
        monkeypatch,
        commons=httpx.Response(
            200,
            json=_commons_body(
                _commons_page(1, artist='<span><a href="/x">Jos&eacute; R</a></span>')
            ),
        ),
    )
    fixture_mode("live")

    found = await photos.commons_photos_near(photos.Anchor(LatLon(HYDE.lat, HYDE.lon), 100.0))

    assert found is not None
    assert found[0].author == "José R"
    assert "<" not in found[0].attribution


@pytest.mark.asyncio
async def test_a_file_uses_its_own_coordinate_and_falls_back_to_the_anchor(
    monkeypatch: pytest.MonkeyPatch, fixture_mode
) -> None:
    """A pin at the anchor can be up to the search radius from where a photo was taken."""
    _transport(
        monkeypatch,
        commons=httpx.Response(
            200,
            json=_commons_body(
                _commons_page(1, lat=51.5, lon=-0.16),
                _commons_page(2, thumb=COMMONS_THUMB + "?v=2"),
            ),
        ),
    )
    fixture_mode("live")

    anchor = photos.Anchor(LatLon(HYDE.lat, HYDE.lon), 100.0)
    found = await photos.commons_photos_near(anchor)

    assert found is not None
    with_coordinate, without = found
    assert (with_coordinate.lat, with_coordinate.lon) == (51.5, -0.16)
    assert (without.lat, without.lon) == (anchor.point.lat, anchor.point.lon)


@pytest.mark.asyncio
async def test_a_generator_that_matched_nothing_is_an_answer_not_a_failure(
    monkeypatch: pytest.MonkeyPatch, fixture_mode
) -> None:
    """MediaWiki omits `query` entirely when a generator matched nothing.

    Empty list, not None. "Commons holds no geolocated file near here" and
    "Commons could not be reached" are different claims, and only the second one
    should keep the source out of `sources_used`.
    """
    _transport(monkeypatch, commons=httpx.Response(200, json={"batchcomplete": True}))
    fixture_mode("live")

    found = await photos.commons_photos_near(photos.Anchor(LatLon(HYDE.lat, HYDE.lon), 100.0))

    assert found == []


@pytest.mark.asyncio
async def test_a_commons_thumbnail_on_an_unexpected_host_is_dropped(
    monkeypatch: pytest.MonkeyPatch, fixture_mode
) -> None:
    """The proxy would refuse it later. Minting a reference for it would produce
    a photo in the strip whose image endpoint always 404s."""
    _transport(
        monkeypatch,
        commons=httpx.Response(
            200, json=_commons_body(_commons_page(1, thumb="https://evil.invalid/x.jpg"))
        ),
    )
    fixture_mode("live")

    assert await photos.commons_photos_near(photos.Anchor(LatLon(HYDE.lat, HYDE.lon), 1.0)) == []


# ---------------------------------------------------------------------------
# Mapillary, and the absence of a token
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_no_token_means_commons_only_and_never_an_error(
    monkeypatch: pytest.MonkeyPatch, fixture_mode
) -> None:
    """The whole no-token contract, in one test.

    `mapillary=None` in the transport turns any request to graph.mapillary.com
    into a failed assertion, so this pins that the call is *not made* rather
    than that it is made and swallowed. The same shape as
    `osm_report.submit_barrier` with no OSM_DEV_TOKEN: absent means a narrower
    result, never an error and never a broken feature.
    """
    _with_token(monkeypatch, None)
    seen = _transport(
        monkeypatch, commons=httpx.Response(200, json=_commons_body(_commons_page(1)))
    )
    fixture_mode("live")

    response = await photos.route_photos(
        PhotosRequest(geometry=_line_lonlat(), objective="scenic")
    )

    assert seen["mapillary"] == []
    assert response.mapillary_enabled is False
    assert response.sources_used == ["wikimedia_commons"]
    assert response.hero is not None


@pytest.mark.asyncio
async def test_a_token_adds_mapillary_and_its_licence_is_carried(
    monkeypatch: pytest.MonkeyPatch, fixture_mode
) -> None:
    _with_token(monkeypatch, "MLY|test|token")
    _transport(
        monkeypatch,
        commons=httpx.Response(200, json={"batchcomplete": True}),
        mapillary=httpx.Response(200, json=_mapillary_body(1)),
    )
    fixture_mode("live")

    response = await photos.route_photos(
        PhotosRequest(geometry=_line_lonlat(), objective="scenic")
    )

    assert response.mapillary_enabled is True
    assert response.hero is not None
    assert response.hero.source == "mapillary"
    assert response.hero.licence == "CC BY-SA 4.0"
    assert response.hero.attribution == "Mapillary contributors, CC BY-SA 4.0"
    assert response.hero.captured_at is not None


@pytest.mark.asyncio
async def test_the_mapillary_bbox_stays_under_the_size_limit(
    monkeypatch: pytest.MonkeyPatch, fixture_mode
) -> None:
    """Mapillary has refused a bbox of 0.01 degrees or more since 2026-01-16."""
    _with_token(monkeypatch, "MLY|test|token")
    seen = _transport(
        monkeypatch,
        commons=httpx.Response(200, json={"batchcomplete": True}),
        mapillary=httpx.Response(200, json=_mapillary_body(0)),
    )
    fixture_mode("live")

    await photos.route_photos(PhotosRequest(geometry=_line_lonlat(), objective="scenic"))

    assert seen["mapillary"]
    for request in seen["mapillary"]:
        west, south, east, north = (float(v) for v in request.url.params["bbox"].split(","))
        assert east - west < 0.01
        assert north - south < 0.01


# ---------------------------------------------------------------------------
# choosing the hero, and saying what was not measured
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_the_accessible_hero_is_the_first_barrier(
    monkeypatch: pytest.MonkeyPatch, fixture_mode
) -> None:
    """The one objective whose hero this codebase can honestly measure."""
    _with_token(monkeypatch, None)
    _transport(monkeypatch, commons=httpx.Response(200, json=_commons_body(_commons_page(1))))
    fixture_mode("live")

    response = await photos.route_photos(
        PhotosRequest(
            geometry=_line_lonlat(),
            objective="accessible",
            blockers=[
                Blocker(
                    type="gate",
                    lat=HYDE.lat + (600 / M_PER_DEG),
                    lon=HYDE.lon,
                    description="Locked gate",
                )
            ],
        )
    )

    assert response.hero_basis == "first_barrier"
    assert response.objective_measured is True
    assert response.hero is not None
    assert response.hero.at_m == pytest.approx(600.0, abs=25.0)


@pytest.mark.asyncio
async def test_accessible_with_no_barrier_says_so_rather_than_implying_one(
    monkeypatch: pytest.MonkeyPatch, fixture_mode
) -> None:
    _with_token(monkeypatch, None)
    _transport(monkeypatch, commons=httpx.Response(200, json=_commons_body(_commons_page(1))))
    fixture_mode("live")

    response = await photos.route_photos(
        PhotosRequest(geometry=_line_lonlat(), objective="accessible")
    )

    assert response.hero_basis != "first_barrier"
    assert response.objective_measured is False
    assert response.note == photos.NO_BARRIER_NOTE


@pytest.mark.asyncio
async def test_the_fastest_hero_is_the_midpoint(
    monkeypatch: pytest.MonkeyPatch, fixture_mode
) -> None:
    _with_token(monkeypatch, None)
    _transport(monkeypatch, commons=httpx.Response(200, json=_commons_body(_commons_page(1))))
    fixture_mode("live")

    response = await photos.route_photos(
        PhotosRequest(geometry=_line_lonlat(), objective="fastest")
    )

    assert response.hero_basis == "midpoint"
    assert response.objective_measured is True
    assert response.hero is not None
    assert response.hero.at_m == pytest.approx(500.0)


@pytest.mark.parametrize("objective", ["scenic", "shade", "quiet", "air"])
@pytest.mark.asyncio
async def test_an_objective_with_no_per_segment_data_never_claims_to_have_measured_one(
    objective: str, monkeypatch: pytest.MonkeyPatch, fixture_mode
) -> None:
    """The rule this project exists on, applied to a photograph.

    `Route` carries one aggregate number per score. The per-way tag spans that
    produce those numbers are consumed inside `main._scored_route` and never
    reach the wire, so there is no greenest, shadiest or quietest point on a
    route to pick a hero from. A caption asserting one would be inventing a
    measurement, so the response states which claim it is not making.
    """
    _with_token(monkeypatch, None)
    _transport(monkeypatch, commons=httpx.Response(200, json=_commons_body(_commons_page(1))))
    fixture_mode("live")

    response = await photos.route_photos(
        PhotosRequest(geometry=_line_lonlat(), objective=objective)  # type: ignore[arg-type]
    )

    assert response.objective_measured is False
    assert response.note == photos.UNMEASURED_NOTES[objective]
    assert response.hero_basis in ("most_photographed", "sampled")


@pytest.mark.asyncio
async def test_the_strip_is_ordered_along_the_route_and_capped_per_place(
    monkeypatch: pytest.MonkeyPatch, fixture_mode
) -> None:
    """Otherwise it is five views of whichever place is best photographed."""
    _with_token(monkeypatch, None)

    def commons(request: httpx.Request) -> httpx.Response:
        # A distinct thumbnail per anchor, four of them, so the per-anchor cap
        # is the only thing that can hold the strip down.
        coord = request.url.params["ggscoord"]
        return httpx.Response(
            200,
            json=_commons_body(
                *(
                    _commons_page(i, thumb=f"{COMMONS_THUMB}?c={coord}&i={i}")
                    for i in range(4)
                )
            ),
        )

    _transport(monkeypatch, commons=commons)
    fixture_mode("live")

    response = await photos.route_photos(
        PhotosRequest(geometry=_line_lonlat(), objective="fastest")
    )

    assert len(response.strip) == photos.STRIP_SIZE
    assert [p.at_m for p in response.strip] == sorted(p.at_m for p in response.strip)
    for at_m in {p.at_m for p in response.strip}:
        assert sum(1 for p in response.strip if p.at_m == at_m) <= photos.MAX_PER_ANCHOR
    assert response.hero is not None
    assert response.hero.id not in {p.id for p in response.strip}


@pytest.mark.asyncio
async def test_every_returned_url_is_on_this_origin_and_never_an_upstream_one(
    monkeypatch: pytest.MonkeyPatch, fixture_mode
) -> None:
    """The entire reason the backend proxies.

    A upload.wikimedia.org or scontent-*.xx.fbcdn.net URL here would hand the
    browser the job of contacting the image host, which is the disclosure the
    proxy exists to prevent, and would need CSP entries that in Mapillary's case
    cannot be written down because the hostnames rotate.
    """
    _with_token(monkeypatch, "MLY|test|token")
    _transport(
        monkeypatch,
        commons=httpx.Response(200, json=_commons_body(_commons_page(1))),
        mapillary=httpx.Response(200, json=_mapillary_body(2)),
    )
    fixture_mode("live")

    response = await photos.route_photos(
        PhotosRequest(geometry=_line_lonlat(), objective="scenic")
    )

    assert response.hero is not None
    for photo in [response.hero, *response.strip]:
        assert photo.url.startswith("/api/photo/")
        assert "wikimedia.org" not in photo.url
        assert "fbcdn.net" not in photo.url


# ---------------------------------------------------------------------------
# degrading
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_an_unreachable_source_never_fails_the_request(
    monkeypatch: pytest.MonkeyPatch, fixture_mode
) -> None:
    _with_token(monkeypatch, None)

    def explode(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("no route to host", request=request)

    _transport(monkeypatch, commons=explode)
    fixture_mode("live")

    response = await photos.route_photos(
        PhotosRequest(geometry=_line_lonlat(), objective="scenic")
    )

    assert response.hero is None
    assert response.strip == []
    assert response.sources_used == [], "nobody answered, so nothing may claim to have looked"
    assert response.hero_basis == "none"


@pytest.mark.asyncio
async def test_a_source_that_errors_is_not_recorded_as_having_looked(
    monkeypatch: pytest.MonkeyPatch, fixture_mode
) -> None:
    """An empty list and an unreachable host are different claims."""
    _with_token(monkeypatch, "MLY|test|token")
    _transport(
        monkeypatch,
        commons=httpx.Response(200, json={"batchcomplete": True}),
        mapillary=httpx.Response(503, text="upstream down"),
    )
    fixture_mode("live")

    response = await photos.route_photos(
        PhotosRequest(geometry=_line_lonlat(), objective="scenic")
    )

    assert response.sources_used == ["wikimedia_commons"]
    assert response.mapillary_enabled is True


@pytest.mark.asyncio
async def test_a_synthetic_fixture_never_becomes_a_credited_photograph(
    monkeypatch: pytest.MonkeyPatch, fixture_mode
) -> None:
    """A hand-built response would attribute a picture to whoever typed the file."""
    def synthetic(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            json=_commons_body(_commons_page(1)),
            headers={fx.PROVENANCE_HEADER: fx.PROVENANCE_SYNTHETIC},
        )

    monkeypatch.setattr(fx, "_record_provenance", fx.PROVENANCE_SYNTHETIC)
    _transport(monkeypatch, commons=synthetic)
    fixture_mode("live")

    assert await photos.commons_photos_near(photos.Anchor(LatLon(HYDE.lat, HYDE.lon), 1.0)) is None


@pytest.mark.asyncio
async def test_a_geosearch_is_charged_to_the_live_call_budget(
    tmp_fixture_dir, monkeypatch: pytest.MonkeyPatch, fixture_mode
) -> None:
    """`record`, not `live`: the budget is deliberately not consulted in live mode.

    Every new upstream in this codebase has to participate in the budget, or an
    iteration loop drains somebody's quota and then fails in a way that looks
    exactly like a bug in this file.
    """
    _with_token(monkeypatch, None)
    _transport(monkeypatch, commons=httpx.Response(200, json=_commons_body(_commons_page(1))))
    budget = fx.LiveCallBudget(tmp_fixture_dir / "b.json", caps={"wikimedia_commons": 50})
    monkeypatch.setattr(fx, "_budget", budget)
    fixture_mode("record")

    await photos.route_photos(PhotosRequest(geometry=_line_lonlat(), objective="scenic"))

    assert budget.spent("wikimedia_commons") == photos.PHOTO_MAX_ANCHORS


# ---------------------------------------------------------------------------
# the image proxy
# ---------------------------------------------------------------------------


def test_a_reference_round_trips() -> None:
    ref = photos.image_ref(COMMONS_THUMB)

    assert photos.resolve_image_ref(ref) == (COMMONS_THUMB, "wikimedia_images")


def test_a_tampered_reference_is_refused() -> None:
    payload, _, tag = photos.image_ref(COMMONS_THUMB).rpartition(".")
    forged = photos.image_ref("https://upload.wikimedia.org/wikipedia/commons/other.jpg")

    with pytest.raises(photos.PhotoProxyError) as caught:
        photos.resolve_image_ref(f"{forged.partition('.')[0]}.{tag}")

    assert caught.value.status_code == 404
    assert payload  # the reference really was two parts to begin with


@pytest.mark.parametrize(
    "url",
    [
        "https://evil.invalid/x.jpg",
        # The registrable domain must be fbcdn.net exactly, not a suffix of a
        # hostname somebody registered.
        "https://scontent.evil-fbcdn.net/x.jpg",
        # On fbcdn.net, but not a content-delivery host.
        "https://graph.fbcdn.net/x.jpg",
        # A URL parser reads the hostname here as `evil.invalid`; a human
        # skimming a log line reads it as upload.wikimedia.org.
        "https://upload.wikimedia.org@evil.invalid/x.jpg",
        "http://upload.wikimedia.org/x.jpg",
        "https://upload.wikimedia.org:8080/x.jpg",
    ],
)
def test_a_correctly_signed_reference_to_the_wrong_host_is_still_refused(url: str) -> None:
    """The signature and the allowlist are two locks, not one.

    These references are minted with the real key, so the HMAC verifies. They
    are refused anyway. If this ever passes, the service has become an open
    proxy for anyone who can read the signing key out of the environment.
    """
    with pytest.raises(photos.PhotoProxyError) as caught:
        photos.resolve_image_ref(photos.image_ref(url))

    assert caught.value.status_code == 404


def test_a_mapillary_cdn_host_is_accepted() -> None:
    """The rotating hostnames are the reason a CSP could not name these."""
    for host in ("scontent-lhr8-1.xx.fbcdn.net", "z-p3-scontent-cdg4-2.xx.fbcdn.net"):
        url = f"https://{host}/m1/v/t6/frame.jpg"
        assert photos.resolve_image_ref(photos.image_ref(url)) == (url, "mapillary_images")


def test_an_absurdly_long_reference_is_refused_before_it_is_decoded() -> None:
    with pytest.raises(photos.PhotoProxyError):
        photos.resolve_image_ref("a" * (photos.MAX_REF_CHARS + 1) + ".b")


@pytest.mark.asyncio
async def test_the_proxy_streams_an_image_back(
    monkeypatch: pytest.MonkeyPatch, fixture_mode
) -> None:
    _transport(
        monkeypatch,
        image=httpx.Response(200, content=b"\xff\xd8jpegbytes", headers={"content-type": "image/jpeg"}),
    )
    fixture_mode("live")

    image = await photos.proxied_image(photos.image_ref(COMMONS_THUMB))

    assert image.content_type == "image/jpeg"
    assert image.body == b"\xff\xd8jpegbytes"


@pytest.mark.asyncio
async def test_the_proxy_refuses_a_content_type_that_is_not_an_image(
    monkeypatch: pytest.MonkeyPatch, fixture_mode
) -> None:
    """Streaming text/html from this API's own origin is an XSS vector."""
    _transport(
        monkeypatch,
        image=httpx.Response(
            200, content=b"<script>alert(1)</script>", headers={"content-type": "text/html"}
        ),
    )
    fixture_mode("live")

    with pytest.raises(photos.PhotoProxyError):
        await photos.proxied_image(photos.image_ref(COMMONS_THUMB))


@pytest.mark.asyncio
async def test_a_content_type_with_parameters_is_still_recognised(
    monkeypatch: pytest.MonkeyPatch, fixture_mode
) -> None:
    """`image/jpeg; charset=binary` is a real thing some CDNs send."""
    _transport(
        monkeypatch,
        image=httpx.Response(
            200, content=b"jpeg", headers={"content-type": "image/JPEG; charset=binary"}
        ),
    )
    fixture_mode("live")

    assert (await photos.proxied_image(photos.image_ref(COMMONS_THUMB))).content_type == "image/jpeg"


@pytest.mark.asyncio
async def test_the_proxy_refuses_an_image_over_the_size_cap(
    monkeypatch: pytest.MonkeyPatch, fixture_mode
) -> None:
    """A thumbnail this large is not the thumbnail that was asked for."""
    monkeypatch.setattr(photos, "PHOTO_MAX_IMAGE_BYTES", 16)
    _transport(
        monkeypatch,
        image=httpx.Response(200, content=b"x" * 64, headers={"content-type": "image/jpeg"}),
    )
    fixture_mode("live")

    with pytest.raises(photos.PhotoProxyError):
        await photos.proxied_image(photos.image_ref(COMMONS_THUMB))


@pytest.mark.asyncio
async def test_an_upstream_error_becomes_a_refusal_rather_than_a_crash(
    monkeypatch: pytest.MonkeyPatch, fixture_mode
) -> None:
    _transport(monkeypatch, image=httpx.Response(404, text="gone"))
    fixture_mode("live")

    with pytest.raises(photos.PhotoProxyError) as caught:
        await photos.proxied_image(photos.image_ref(COMMONS_THUMB))

    assert caught.value.status_code == 502


@pytest.mark.asyncio
async def test_replay_mode_has_no_image_fixture_and_says_so_without_opening_a_socket(
    monkeypatch: pytest.MonkeyPatch
) -> None:
    """The cost of routing image bytes through the record/replay layer, pinned.

    Reaching for the shared client directly would make MEANDER_FIXTURES=replay
    open a socket, and that guarantee is load-bearing for this whole suite.
    """
    with pytest.raises(photos.PhotoProxyError) as caught:
        await photos.proxied_image(photos.image_ref(COMMONS_THUMB))

    assert caught.value.status_code == 503


# ---------------------------------------------------------------------------
# the endpoints
# ---------------------------------------------------------------------------


def test_the_photos_endpoint_answers_with_the_documented_shape(
    api_client, monkeypatch: pytest.MonkeyPatch, fixture_mode
) -> None:
    _with_token(monkeypatch, None)
    _transport(monkeypatch, commons=httpx.Response(200, json=_commons_body(_commons_page(1))))
    fixture_mode("live")

    response = api_client.post(
        "/api/photos", json={"geometry": _line_lonlat(), "objective": "fastest"}
    )

    assert response.status_code == 200
    body = response.json()
    assert set(body) == {
        "hero",
        "strip",
        "hero_basis",
        "hero_reason",
        "objective_measured",
        "sources_used",
        "mapillary_enabled",
        "note",
    }
    assert body["hero_basis"] == "midpoint"
    assert body["hero"]["url"].startswith("/api/photo/")
    assert body["hero"]["licence"]
    assert body["hero"]["attribution"]


def test_the_photos_endpoint_rejects_a_geometry_that_is_not_a_line(api_client) -> None:
    assert api_client.post("/api/photos", json={"geometry": [[0.0, 0.0]]}).status_code == 422
    assert api_client.post("/api/photos", json={"geometry": [[0.0], [1.0]]}).status_code == 422
    assert (
        api_client.post("/api/photos", json={"geometry": [[999.0, 0.0], [1.0, 1.0]]}).status_code
        == 422
    )


def test_the_photos_endpoint_refuses_an_unthinned_geometry(api_client) -> None:
    """A six-hour drive is thousands of vertices and this endpoint needs a shape."""
    line = [[0.0, i / 100_000.0] for i in range(900)]

    assert api_client.post("/api/photos", json={"geometry": line}).status_code == 422


def test_the_image_endpoint_serves_bytes_with_a_cache_header(
    api_client, monkeypatch: pytest.MonkeyPatch, fixture_mode
) -> None:
    _transport(
        monkeypatch,
        image=httpx.Response(200, content=b"jpegbytes", headers={"content-type": "image/jpeg"}),
    )
    fixture_mode("live")

    response = api_client.get(f"/api/photo/{photos.image_ref(COMMONS_THUMB)}")

    assert response.status_code == 200
    assert response.content == b"jpegbytes"
    assert response.headers["content-type"] == "image/jpeg"
    assert "immutable" in response.headers["cache-control"]
    assert response.headers["x-content-type-options"] == "nosniff"
    # JPEG is already compressed. Gzipping six of them per route view is tens of
    # milliseconds of blocking CPU on a single worker for a fraction of a
    # percent of bytes, so ConditionalGZip exempts this path.
    assert response.headers.get("content-encoding") != "gzip"


def test_the_image_endpoint_refuses_a_reference_it_did_not_issue(api_client) -> None:
    assert api_client.get("/api/photo/not-a-real-reference").status_code == 404
