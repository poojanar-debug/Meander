"""Geocoding runs against fixtures recorded from the live Nominatim service."""

from __future__ import annotations

import pytest

from backend.routing import GeocodeError, geocode_search


@pytest.mark.asyncio
async def test_known_query_returns_results() -> None:
    results = await geocode_search("Colombo Fort, Sri Lanka")

    assert results
    assert all(r.name for r in results)


@pytest.mark.asyncio
async def test_results_are_near_the_place_asked_for() -> None:
    results = await geocode_search("Hyde Park, London")
    first = results[0]

    assert 51.3 < first.lat < 51.7
    assert -0.4 < first.lon < 0.1


@pytest.mark.asyncio
async def test_unknown_query_raises_a_human_readable_error() -> None:
    """In replay mode an unrecorded query has no answer; the message must say so."""
    with pytest.raises(GeocodeError) as exc:
        await geocode_search("a place nobody has ever searched for")

    assert exc.value.status_code == 503
    assert exc.value.human_message[0].isupper()


def test_endpoint_returns_results(api_client) -> None:
    payload = api_client.get("/api/geocode", params={"q": "Vondelpark, Amsterdam"}).json()

    assert payload["results"]
    assert {"name", "lat", "lon"} == set(payload["results"][0])


def test_endpoint_rejects_a_one_character_query(api_client) -> None:
    assert api_client.get("/api/geocode", params={"q": "a"}).status_code == 422


def test_endpoint_shapes_a_miss_as_an_error_object(api_client) -> None:
    response = api_client.get("/api/geocode", params={"q": "zzzz not recorded zzzz"})

    assert response.status_code == 503
    assert response.json()["error"]["kind"] == "geocode"


@pytest.mark.asyncio
async def test_results_are_rounded_so_the_same_search_is_the_same_request() -> None:
    """Nominatim returns seven decimal places. Two people searching the same
    place must produce byte-identical routing requests, or the whole-route cache
    never hits and every search costs credits."""
    from backend.routing import GEOCODE_COORD_DECIMALS

    for result in await geocode_search("Hyde Park, London"):
        assert result.lat == round(result.lat, GEOCODE_COORD_DECIMALS)
        assert result.lon == round(result.lon, GEOCODE_COORD_DECIMALS)


@pytest.mark.asyncio
async def test_searching_for_a_demo_location_lands_on_its_fixture() -> None:
    """The demo has to work through the app's own search, not only through
    hand-entered coordinates."""
    from backend.config import TEST_LOCATIONS_BY_SLUG

    for slug in ("hyde-park-london", "colombo-fort", "amsterdam-vondelpark"):
        location = TEST_LOCATIONS_BY_SLUG[slug]
        first = (await geocode_search(location.name))[0]
        assert (first.lat, first.lon) == (location.lat, location.lon), slug
