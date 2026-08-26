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


# ---------------------------------------------------------------------------
# The cache, and the bucket it exists to protect
# ---------------------------------------------------------------------------


def test_a_repeated_search_is_served_without_asking_upstream(api_client, monkeypatch) -> None:
    """The second identical query must not reach Nominatim.

    Backspacing and re-typing is the case this cache actually serves. It is not
    a normalisation win: case-folding the 12 distinct queries in the recorded
    burst in `fixtures/nominatim/` still gives 12 distinct keys, so only one of
    them would have been saved by normalising alone. What is saved is a user who
    deletes three characters and puts them back, which asks the same question
    twice by construction.
    """
    first = api_client.get("/api/geocode", params={"q": "Vondelpark, Amsterdam"})
    assert first.status_code == 200

    calls = []

    async def refuse(query: str):
        calls.append(query)
        raise AssertionError("a cached query reached the upstream search")

    monkeypatch.setattr("backend.routing.geocode_search", refuse)
    second = api_client.get("/api/geocode", params={"q": "  VONDELPARK,   amsterdam "})

    assert second.status_code == 200
    assert second.json() == first.json()
    assert calls == []


def test_a_cache_hit_costs_no_token(api_client, monkeypatch) -> None:
    """A hit that spends no upstream call must not spend a bucket token either,
    or the limiter charges the user for its own cache. `/api/routes` has always
    refunded on a cache hit; place search did not, which is one of the reasons a
    long session of typing reached the limiter sooner than a session of routing.
    """
    from backend import main
    from backend.ratelimit import RateLimiter

    monkeypatch.setattr(
        main, "geocode_limiter", RateLimiter(capacity=3, refill_per_min=0.0, daily_ceiling=100)
    )
    assert api_client.get("/api/geocode", params={"q": "Hyde Park, London"}).status_code == 200

    # Two tokens left, and thirty repeats of a cached query must not touch them.
    for _ in range(30):
        assert api_client.get("/api/geocode", params={"q": "hyde park, london"}).status_code == 200

    # Still room for two genuinely new queries before the bucket says no.
    assert api_client.get("/api/geocode", params={"q": "Vondelpark, Amsterdam"}).status_code == 200


def test_place_search_does_not_spend_the_route_bucket(api_client, monkeypatch) -> None:
    """The measurement behind the second limiter, asserted.

    A 20-character name costs a mean of 8.6 geocode requests at a 300 ms
    debounce, so two names come to 17.1 against a per-IP capacity of 12. With one
    shared bucket the route request that followed the typing was refused, using
    routing copy, under the place box. Forty place searches must now leave the
    route bucket untouched.
    """
    from backend import main
    from backend.ratelimit import RateLimiter

    monkeypatch.setattr(
        main, "limiter", RateLimiter(capacity=12, refill_per_min=0.0, daily_ceiling=2000)
    )
    monkeypatch.setattr(
        main, "geocode_limiter", RateLimiter(capacity=40, refill_per_min=0.0, daily_ceiling=2000)
    )

    for i in range(40):
        api_client.get("/api/geocode", params={"q": f"nowhere-{i}-not-recorded"})

    # The route bucket still holds every one of its twelve tokens.
    decision = main.limiter.check("test-client")
    assert decision.allowed


def test_a_found_place_and_a_miss_do_not_share_an_expiry(api_client, monkeypatch) -> None:
    """Two answers, two questions, two expiries.

    They used to share one, and it was seven days. The argument for seven days
    is sound for a coordinate — a name-to-coordinate mapping embeds none of the
    weather, daylight or air quality that makes a route payload go stale in
    six hours — and it is wrong for an empty result, because an empty result is
    exactly what a place mapped this week returns. One OSM edit is enough to
    make it false, and until it expired nobody who had already typed that name
    could find the place at all.
    """
    from backend import cache as cache_mod
    from backend.config import settings

    ttls: list[int] = []
    real = cache_mod.Cache.put_geocode

    def spy(self, query_key, payload, ttl_s):  # type: ignore[no-untyped-def]
        ttls.append(ttl_s)
        return real(self, query_key, payload, ttl_s)

    monkeypatch.setattr(cache_mod.Cache, "put_geocode", spy)

    assert api_client.get("/api/geocode", params={"q": "Hyde Park, London"}).status_code == 200
    assert ttls == [settings.geocode_cache_ttl_s]

    async def nothing(query: str):
        return []

    monkeypatch.setattr("backend.routing.geocode_search", nothing)
    empty = api_client.get("/api/geocode", params={"q": "Somewhere Nobody Has Mapped"})

    assert empty.status_code == 200
    assert empty.json()["results"] == []
    assert ttls[-1] == settings.geocode_empty_cache_ttl_s
    assert settings.geocode_empty_cache_ttl_s < settings.geocode_cache_ttl_s


def test_the_place_list_cannot_go_stale_by_more_than_a_day() -> None:
    """A ceiling on both TTLs, so the seven days cannot come quietly back.

    Neither number is asserted exactly — a deployment may shorten either, and
    `MEANDER_GEOCODE_CACHE_TTL_S` exists so it can. What is asserted is the
    bound: the list of places a user picks a destination from is at most a day
    behind OpenStreetMap, and a "nowhere is called that" at most a quarter of
    an hour behind it.
    """
    from backend.config import settings

    assert settings.geocode_cache_ttl_s <= 24 * 60 * 60
    assert settings.geocode_empty_cache_ttl_s <= 15 * 60
