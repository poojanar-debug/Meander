"""The route cache key must cover everything that changes the answer.

depart_at drives best_departure, the air-quality hour index and the shade
score. Leaving it out of the key meant two requests differing only in departure
time shared one cached payload, so the later one got the earlier one's
departure advice for up to the 6 hour TTL.
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta, timezone

from backend.main import route_cache_key
from backend.models import Point, RouteRequest


def _req(**kw) -> RouteRequest:
    kw.setdefault("minutes", 45)
    return RouteRequest(origin=Point(lat=51.5074, lon=-0.1622), **kw)


def test_different_departure_hours_are_different_answers() -> None:
    morning = _req(depart_at=datetime(2026, 8, 5, 8, 0, tzinfo=UTC))
    evening = _req(depart_at=datetime(2026, 8, 5, 19, 0, tzinfo=UTC))
    assert route_cache_key(morning) != route_cache_key(evening)


def test_the_same_hour_shares_a_cache_entry() -> None:
    """Bucketed to the hour, for the same reason coordinates are rounded to 3 dp.

    An unrounded timestamp would miss on literally every request, which is
    worse than the bug it fixes.
    """
    a = _req(depart_at=datetime(2026, 8, 5, 8, 0, 0, tzinfo=UTC))
    b = _req(depart_at=datetime(2026, 8, 5, 8, 59, 59, tzinfo=UTC))
    assert route_cache_key(a) == route_cache_key(b)


def test_the_hour_is_the_granularity_the_data_actually_uses() -> None:
    a = _req(depart_at=datetime(2026, 8, 5, 8, 59, tzinfo=UTC))
    b = _req(depart_at=datetime(2026, 8, 5, 9, 0, tzinfo=UTC))
    assert route_cache_key(a) != route_cache_key(b)


def test_no_departure_is_its_own_bucket() -> None:
    """"Whenever" is a different request from "at 8am", not the same one."""
    assert route_cache_key(_req()) != route_cache_key(
        _req(depart_at=datetime(2026, 8, 5, 8, 0, tzinfo=UTC))
    )


def test_the_same_instant_in_two_zones_is_one_entry() -> None:
    """Otherwise the cache fragments by the caller's clock rather than by time."""
    utc = _req(depart_at=datetime(2026, 8, 5, 12, 0, tzinfo=UTC))
    plus_two = _req(depart_at=datetime(2026, 8, 5, 14, 0, tzinfo=timezone(timedelta(hours=2))))
    assert route_cache_key(utc) == route_cache_key(plus_two)


def test_a_naive_timestamp_is_read_as_utc_not_rejected() -> None:
    naive = _req(depart_at=datetime(2026, 8, 5, 12, 0))
    aware = _req(depart_at=datetime(2026, 8, 5, 12, 0, tzinfo=UTC))
    assert route_cache_key(naive) == route_cache_key(aware)


def test_the_other_inputs_still_key_the_cache() -> None:
    base = _req()
    assert route_cache_key(base) != route_cache_key(_req(minutes=46))
    assert route_cache_key(base) != route_cache_key(_req(mode="bike"))
    assert route_cache_key(base) != route_cache_key(_req(objectives=["fastest"]))
    assert route_cache_key(base) != route_cache_key(
        RouteRequest(
            origin=Point(lat=51.5074, lon=-0.1622),
            destination=Point(lat=51.52, lon=-0.13),
            minutes=45,
        )
    )


def test_the_time_budget_keys_a_loop_because_it_sets_the_loop_length() -> None:
    """`_req()` has no destination, so 45 and 46 minutes really are two answers —
    `minutes` is what `round_trip.distance` is computed from.
    """
    assert route_cache_key(_req()) != route_cache_key(_req(minutes=46))


def test_the_time_budget_does_not_key_a_trip_with_a_destination() -> None:
    """**Changed behaviour.** The key used to carry `minutes` for every request
    shape, so two identical point-to-point trips at different dial positions
    were two rows holding the same payload. Nothing about the answer depends on
    the dial once both ends are fixed, so nothing about the key should either —
    otherwise a drag across the dial's 68 positions is 68 misses and 68 sets of
    routing credits for one answer.
    """
    def trip(minutes: int) -> RouteRequest:
        return RouteRequest(
            origin=Point(lat=51.5074, lon=-0.1622),
            destination=Point(lat=51.52, lon=-0.13),
            minutes=minutes,
        )

    assert route_cache_key(trip(20)) == route_cache_key(trip(360))


def test_coordinates_are_still_rounded_to_a_shared_bucket() -> None:
    """Two people on the same street corner should share an answer."""
    a = RouteRequest(origin=Point(lat=51.50741, lon=-0.16221), minutes=45)
    b = RouteRequest(origin=Point(lat=51.50744, lon=-0.16224), minutes=45)
    assert route_cache_key(a) == route_cache_key(b)
