"""End-to-end behaviour of POST /api/routes against the committed fixtures."""

from __future__ import annotations

from typing import Any

import pytest

from backend.config import TEST_LOCATIONS_BY_SLUG

COLOMBO = TEST_LOCATIONS_BY_SLUG["colombo-fort"]
VIHARA = TEST_LOCATIONS_BY_SLUG["viharamahadevi"]
HYDE = TEST_LOCATIONS_BY_SLUG["hyde-park-london"]


def _body(**overrides: Any) -> dict[str, Any]:
    body: dict[str, Any] = {
        "origin": {"lat": COLOMBO.lat, "lon": COLOMBO.lon},
        "destination": {"lat": VIHARA.lat, "lon": VIHARA.lon},
        "minutes": 25,
        "mode": "auto",
    }
    body.update(overrides)
    return body


def test_returns_three_routes(api_client) -> None:
    payload = api_client.post("/api/routes", json=_body()).json()

    assert [r["id"] for r in payload["routes"]] == ["fastest", "nature", "accessible"]
    assert all(r["label"] for r in payload["routes"])


def test_routes_differ_in_duration_and_geometry(api_client) -> None:
    routes = api_client.post("/api/routes", json=_body()).json()["routes"]
    by_id = {r["id"]: r for r in routes}

    assert by_id["nature"]["duration_min"] > by_id["fastest"]["duration_min"]
    assert by_id["nature"]["geometry"] != by_id["fastest"]["geometry"]
    assert by_id["accessible"]["geometry"] != by_id["fastest"]["geometry"]


def test_geometry_is_lon_lat_pairs(api_client) -> None:
    first = api_client.post("/api/routes", json=_body()).json()["routes"][0]["geometry"][0]

    assert len(first) == 2
    assert first[0] > 70, "longitude must come first in GeoJSON order"


def test_placeholder_scores_are_labelled_as_placeholders(api_client) -> None:
    """A synthetic number presented as a measurement is the failure this prevents."""
    routes = api_client.post("/api/routes", json=_body()).json()["routes"]

    for route in routes:
        assert route["scoring_method"] == "placeholder"
        assert route["confidence_note"]
        assert "placeholder" in route["confidence_note"].lower()


def test_routes_built_from_synthetic_fixtures_say_so(api_client) -> None:
    routes = api_client.post("/api/routes", json=_body()).json()["routes"]
    ok = [r for r in routes if r["status"] == "ok"]

    assert ok and all(r["synthetic_upstream"] is True for r in ok)


def test_auto_mode_resolves_to_foot_under_45_minutes(api_client) -> None:
    routes = api_client.post("/api/routes", json=_body(minutes=25)).json()["routes"]

    assert all(r["mode"] == "foot" for r in routes if r["status"] == "ok")


def test_auto_mode_resolves_to_car_over_120_minutes(api_client) -> None:
    routes = api_client.post("/api/routes", json=_body(minutes=150)).json()["routes"]

    assert all(r["mode"] == "car" for r in routes if r["status"] == "ok")


def test_omitting_destination_returns_a_loop(api_client) -> None:
    body = {"origin": {"lat": HYDE.lat, "lon": HYDE.lon}, "minutes": 35, "mode": "auto"}
    routes = api_client.post("/api/routes", json=body).json()["routes"]
    geometry = next(r for r in routes if r["id"] == "fastest")["geometry"]

    start, end = geometry[0], geometry[-1]
    assert abs(start[0] - end[0]) < 0.002 and abs(start[1] - end[1]) < 0.002


def test_blocked_accessible_is_a_result_not_an_error(api_client) -> None:
    body = {"origin": {"lat": COLOMBO.lat, "lon": COLOMBO.lon}, "minutes": 30, "mode": "auto"}
    response = api_client.post("/api/routes", json=body)
    payload = response.json()
    accessible = next(r for r in payload["routes"] if r["id"] == "accessible")

    assert response.status_code == 200
    assert accessible["status"] == "blocked"
    assert accessible["status_note"]
    assert [r["status"] for r in payload["routes"] if r["id"] != "accessible"] == ["ok", "ok"]


def test_destination_null_is_treated_as_a_loop(api_client) -> None:
    body = {"origin": {"lat": HYDE.lat, "lon": HYDE.lon}, "destination": None, "minutes": 35}

    assert api_client.post("/api/routes", json=body).status_code == 200


# --- validation ------------------------------------------------------------


@pytest.mark.parametrize("minutes", [0, 19, 361, 10_000])
def test_minutes_outside_the_dial_range_is_rejected(api_client, minutes: int) -> None:
    assert api_client.post("/api/routes", json=_body(minutes=minutes)).status_code == 422


def test_out_of_range_coordinates_are_rejected(api_client) -> None:
    body = _body(origin={"lat": 91.0, "lon": 0.0})
    assert api_client.post("/api/routes", json=body).status_code == 422


def test_unknown_fields_are_rejected(api_client) -> None:
    assert api_client.post("/api/routes", json=_body(surprise=1)).status_code == 422


def test_more_than_three_objectives_is_rejected(api_client) -> None:
    body = _body(objectives=["fastest", "nature", "accessible", "quiet"])
    assert api_client.post("/api/routes", json=body).status_code == 422


def test_unimplemented_objective_is_reported_not_dropped(api_client) -> None:
    body = _body(objectives=["fastest", "quiet"])
    routes = api_client.post("/api/routes", json=body).json()["routes"]
    quiet = next(r for r in routes if r["id"] == "quiet")

    assert quiet["status"] == "blocked"
    assert "not implemented" in quiet["status_note"].lower()


def test_objective_order_is_preserved(api_client) -> None:
    body = _body(objectives=["accessible", "nature", "fastest"])
    routes = api_client.post("/api/routes", json=body).json()["routes"]

    assert [r["id"] for r in routes] == ["accessible", "nature", "fastest"]


# --- caching ---------------------------------------------------------------


def test_second_identical_request_is_served_from_cache(api_client) -> None:
    first = api_client.post("/api/routes", json=_body())
    second = api_client.post("/api/routes", json=_body())

    assert first.headers["X-Meander-Cache"] == "miss"
    assert second.headers["X-Meander-Cache"] == "hit"
    assert first.json()["routes"] == second.json()["routes"]


def test_cache_key_ignores_sub_100m_coordinate_noise(api_client) -> None:
    api_client.post("/api/routes", json=_body())
    jittered = _body(origin={"lat": COLOMBO.lat + 0.00002, "lon": COLOMBO.lon - 0.00003})

    assert api_client.post("/api/routes", json=jittered).headers["X-Meander-Cache"] == "hit"


def test_a_different_time_budget_is_a_different_cache_entry(api_client) -> None:
    api_client.post("/api/routes", json=_body(minutes=25))

    assert api_client.post("/api/routes", json=_body(minutes=40)).headers["X-Meander-Cache"] == "miss"


def test_a_cache_hit_does_not_consume_a_rate_limit_token(api_client) -> None:
    from backend.main import limiter

    api_client.post("/api/routes", json=_body())
    served_after_miss = limiter.served_today()
    api_client.post("/api/routes", json=_body())

    assert limiter.served_today() == served_after_miss


# --- rate limiting ---------------------------------------------------------


def test_429_fires_when_the_per_ip_bucket_empties(api_client, monkeypatch) -> None:
    from backend import main
    from backend.ratelimit import RateLimiter

    monkeypatch.setattr(main, "limiter",
                        RateLimiter(capacity=2, refill_per_min=0.0, daily_ceiling=100))

    # Distinct time budgets so every request is a cache miss and is charged.
    codes = [api_client.post("/api/routes", json=_body(minutes=20 + 5 * i)).status_code
             for i in range(4)]

    assert codes == [200, 200, 429, 429]


def test_429_carries_a_retry_after_and_a_human_message(api_client, monkeypatch) -> None:
    from backend import main
    from backend.ratelimit import RateLimiter

    monkeypatch.setattr(main, "limiter",
                        RateLimiter(capacity=0, refill_per_min=0.0, daily_ceiling=100))

    response = api_client.post("/api/routes", json=_body())

    assert response.status_code == 429
    assert int(response.headers["Retry-After"]) >= 1
    message = response.json()["error"]["message"]
    assert message and message[0].isupper()


def test_daily_ceiling_returns_429_with_its_own_message(api_client, monkeypatch) -> None:
    from backend import main
    from backend.ratelimit import RateLimiter

    monkeypatch.setattr(main, "limiter",
                        RateLimiter(capacity=50, refill_per_min=60.0, daily_ceiling=0))

    response = api_client.post("/api/routes", json=_body())

    assert response.status_code == 429
    assert "tomorrow" in response.json()["error"]["message"].lower()


# --- privacy ---------------------------------------------------------------


def test_response_never_echoes_the_request_coordinates_verbatim(api_client) -> None:
    """The response carries route geometry, not a record of what was asked for."""
    payload = api_client.post("/api/routes", json=_body()).json()

    assert "origin" not in payload
    assert "destination" not in payload


def test_health_counts_the_request_without_identifying_it(api_client) -> None:
    api_client.post("/api/routes", json=_body())
    counters = api_client.get("/api/health").json()["counters"]

    assert counters["route_requests_total"] == 1
    assert counters["unique_sessions_today"] == 1
