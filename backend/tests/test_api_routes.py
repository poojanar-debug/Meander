"""End-to-end behaviour of POST /api/routes against the committed fixtures."""

from __future__ import annotations

from typing import Any

import pytest

from backend.config import TEST_LOCATIONS_BY_SLUG

COLOMBO = TEST_LOCATIONS_BY_SLUG["colombo-fort"]
VIHARA = TEST_LOCATIONS_BY_SLUG["viharamahadevi"]
HYDE = TEST_LOCATIONS_BY_SLUG["hyde-park-london"]
VONDEL = TEST_LOCATIONS_BY_SLUG["amsterdam-vondelpark"]


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

    assert [r["id"] for r in payload["routes"]] == ["fastest", "scenic", "accessible"]
    assert all(r["label"] for r in payload["routes"])


def test_routes_differ_in_duration_and_geometry(api_client) -> None:
    routes = api_client.post("/api/routes", json=_body()).json()["routes"]
    by_id = {r["id"]: r for r in routes}

    assert by_id["scenic"]["duration_min"] > by_id["fastest"]["duration_min"]
    assert by_id["scenic"]["geometry"] != by_id["fastest"]["geometry"]
    assert by_id["accessible"]["geometry"] != by_id["fastest"]["geometry"]


def test_turn_instructions_reach_the_wire(api_client) -> None:
    """routing.py parsing them is not enough — they have to survive to the payload.

    The step list, and the follow mode built on top of it, exist only if this
    array does.
    """
    routes = api_client.post("/api/routes", json=_body()).json()["routes"]
    fastest = next(r for r in routes if r["id"] == "fastest")

    assert fastest["steps"], "the router described turns and the API dropped them"
    first = fastest["steps"][0]
    assert first["text"]
    assert first["distance_m"] >= 0
    # Indexes into this route's own geometry, which is what lets the frontend
    # highlight the matching stretch and put a barrier inside the step where a
    # walker would meet it.
    assert len(first["interval"]) == 2
    assert 0 <= first["interval"][0] <= first["interval"][1] < len(fastest["geometry"])


def test_a_route_without_instructions_reports_an_empty_list(api_client) -> None:
    """Never a synthesised turn. Absence of data is not permission to fill it in —
    the same rule that makes an untagged path UNKNOWN rather than accessible."""
    routes = api_client.post("/api/routes", json=_body()).json()["routes"]

    for route in routes:
        assert isinstance(route["steps"], list)


def test_geometry_is_lon_lat_pairs(api_client) -> None:
    first = api_client.post("/api/routes", json=_body()).json()["routes"][0]["geometry"][0]

    assert len(first) == 2
    assert first[0] > 70, "longitude must come first in GeoJSON order"


def test_scores_from_synthetic_geometry_stay_labelled_as_placeholders(api_client) -> None:
    """The scoring maths is real, but it ran on invented terrain. That is not a
    measurement of anywhere, and must not be presented as one."""
    routes = api_client.post("/api/routes", json=_body()).json()["routes"]

    for route in routes:
        assert route["scoring_method"] == "placeholder"
        assert route["confidence_note"]
        assert "placeholder" in route["confidence_note"].lower()


def test_scenic_score_ranks_the_scenic_route_above_the_fastest(api_client) -> None:
    by_id = {r["id"]: r for r in api_client.post("/api/routes", json=_body()).json()["routes"]}

    assert by_id["scenic"]["scores"]["scenic"] > by_id["fastest"]["scores"]["scenic"]
    assert by_id["scenic"]["scores"]["air"] > by_id["fastest"]["scores"]["air"]


def test_a_measured_score_is_a_fraction_and_an_unmeasured_one_is_null(api_client) -> None:
    """Zero shade is a claim about a place; "not measured" is not the same claim,
    so an unmeasurable score must come back null rather than 0.0."""
    routes = api_client.post("/api/routes", json=_body()).json()["routes"]
    ok = [r for r in routes if r["status"] == "ok"]

    assert ok
    for route in ok:
        for value in route["scores"].values():
            assert value is None or 0.0 <= value <= 1.0


# --- graceful degradation --------------------------------------------------
#
# The hard rule from the specification: /api/routes must return a usable
# response even when scoring and enrichment both fail. These tests kill each
# upstream in turn and assert the API still answers.

ENRICHMENT_ENTRY_POINTS = [
    "fetch_rest_stop_nodes",
    "fetch_air_quality",
    "fetch_cloud_cover",
    "best_departure",
]


@pytest.mark.parametrize("name", ENRICHMENT_ENTRY_POINTS)
def test_killing_one_enrichment_service_still_returns_200(api_client, monkeypatch, name) -> None:
    from backend import enrich

    async def explode(*args, **kwargs):
        raise RuntimeError(f"{name} is down")

    monkeypatch.setattr(enrich, name, explode)

    response = api_client.post("/api/routes", json=_body())
    assert response.status_code == 200
    assert [r["id"] for r in response.json()["routes"]] == ["fastest", "scenic", "accessible"]


def test_killing_every_enrichment_service_at_once_still_returns_200(api_client, monkeypatch) -> None:
    from backend import enrich

    async def explode(*args, **kwargs):
        raise RuntimeError("everything is down")

    for name in ENRICHMENT_ENTRY_POINTS:
        monkeypatch.setattr(enrich, name, explode)

    payload = api_client.post("/api/routes", json=_body()).json()
    ok = [r for r in payload["routes"] if r["status"] == "ok"]

    assert len(ok) >= 2
    assert payload["best_departure"] is None
    # Null, not []. Every enrichment service is dead in this test, so nobody
    # looked — and "we looked and found none" would be a finding we did not make.
    assert all(r["rest_stops"] is None for r in ok)


def test_killing_scoring_still_returns_200(api_client, monkeypatch) -> None:
    """Degrade to geometry-only, then to nothing, but never to an error."""
    from backend import main

    def explode(*args, **kwargs):
        raise RuntimeError("scoring is down")

    monkeypatch.setattr(main, "clip_term_for_route", explode)

    assert api_client.post("/api/routes", json=_body()).status_code == 200


def test_killing_the_accessibility_engine_still_returns_200(api_client, monkeypatch) -> None:
    from backend import main

    def explode(*args, **kwargs):
        raise RuntimeError("accessibility is down")

    monkeypatch.setattr(main, "assess_route", explode)

    response = api_client.post("/api/routes", json=_body())
    assert response.status_code == 200
    for route in response.json()["routes"]:
        # With no assessment there is no coverage figure to report.
        assert route["confidence"] == 0.0


def test_narration_failure_leaves_narration_null(api_client, monkeypatch) -> None:
    from backend import narrate

    async def explode(*args, **kwargs):
        raise RuntimeError("narration is down")

    monkeypatch.setattr(narrate, "narrate", explode)

    routes = api_client.post("/api/routes", json=_body()).json()["routes"]
    assert all(r["narration"] is None for r in routes)


def test_a_blocked_route_reports_no_scores_at_all(api_client) -> None:
    body = {"origin": {"lat": COLOMBO.lat, "lon": COLOMBO.lon}, "minutes": 30}
    accessible = next(
        r for r in api_client.post("/api/routes", json=body).json()["routes"]
        if r["id"] == "accessible"
    )

    assert accessible["scores"] == {"scenic": None, "air": None, "shade": None, "quiet": None}


def test_routes_built_from_synthetic_fixtures_say_so(api_client) -> None:
    routes = api_client.post("/api/routes", json=_body()).json()["routes"]
    ok = [r for r in routes if r["status"] == "ok"]

    assert ok and all(r["synthetic_upstream"] is True for r in ok)


def test_auto_mode_resolves_to_foot_under_45_minutes(api_client) -> None:
    # A loop: the time budget is the whole of the request, so the ladder reads it.
    body = {"origin": {"lat": HYDE.lat, "lon": HYDE.lon}, "minutes": 35, "mode": "auto"}
    routes = api_client.post("/api/routes", json=body).json()["routes"]

    assert all(r["mode"] == "foot" for r in routes if r["status"] == "ok")


def test_auto_mode_resolves_to_bike_for_a_longer_loop(api_client) -> None:
    """The middle rung, end to end. The car rung is covered by the unit tests in
    test_routing.py — there is no committed loop fixture over 120 minutes, and
    inventing one to assert a pure function would be the expensive way to test it.
    """
    body = {"origin": {"lat": VONDEL.lat, "lon": VONDEL.lon}, "minutes": 60, "mode": "auto"}
    routes = api_client.post("/api/routes", json=body).json()["routes"]

    assert all(r["mode"] == "bike" for r in routes if r["status"] == "ok")


def test_auto_mode_for_a_trip_with_a_destination_ignores_the_dial(api_client) -> None:
    """**Changed behaviour.** This used to assert that minutes=150 made the same
    two places a car journey, which is the defect: Colombo Fort to
    Viharamahadevi is 2.4 km whatever the dial says, and the dial cannot make it
    further. The mode now comes from the straight-line distance, so the same
    destination gives the same mode at both ends of the dial's range.
    """
    near = [
        api_client.post("/api/routes", json=_body(minutes=m)).json()["routes"] for m in (20, 360)
    ]

    for routes in near:
        assert all(r["mode"] == "foot" for r in routes if r["status"] == "ok")


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
    body = _body(objectives=["fastest", "scenic", "accessible", "quiet"])
    assert api_client.post("/api/routes", json=body).status_code == 422


def test_every_declared_objective_routes(api_client) -> None:
    """The successor to a test that asserted the opposite.

    Until the preference presets landed, `quiet`, `shade` and `air` were in
    `RouteId` and in `ROUTE_LABELS` but not in `PRESETS`, and the request path
    turned each of them into a blocked route reading "not implemented yet". The
    test that guarded that behaviour is this one, retargeted: the contract
    promises six objectives, so asking for one must not produce a placeholder.

    Two at a time because `objectives` caps at three and `fastest` is worth
    keeping in the request as the control.
    """
    for pair in (["fastest", "quiet"], ["fastest", "shade"], ["fastest", "air"]):
        routes = api_client.post("/api/routes", json=_body(objectives=pair)).json()["routes"]
        subject = next(r for r in routes if r["id"] == pair[1])

        assert subject["status"] == "ok", subject.get("status_note")
        assert subject["geometry"]
        assert subject["duration_min"] > 0


def test_objective_order_is_preserved(api_client) -> None:
    body = _body(objectives=["accessible", "scenic", "fastest"])
    routes = api_client.post("/api/routes", json=body).json()["routes"]

    assert [r["id"] for r in routes] == ["accessible", "scenic", "fastest"]


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


def test_the_time_budget_is_not_part_of_a_point_to_point_cache_key(api_client) -> None:
    """The other half: two dial positions, one destination, one cached answer.

    Before this, the dial was in the cache key for every request shape, so a
    drag from 20 to 60 was eight cache misses and eight full sets of routing
    credits for eight byte-identical payloads.
    """
    first = api_client.post("/api/routes", json=_body(minutes=25))
    second = api_client.post("/api/routes", json=_body(minutes=40))

    assert first.headers["X-Meander-Cache"] == "miss"
    assert second.headers["X-Meander-Cache"] == "hit"
    assert first.json()["routes"] == second.json()["routes"]


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

    # Distinct objective sets so every request is a cache miss and is charged.
    # This used to vary `minutes`, which no longer distinguishes two requests
    # that share a destination — all four collapsed onto one cache key, the
    # last three were hits, and a hit spends no token, so nothing ever reached
    # the limit. Objectives are still part of the key and select which presets
    # run, so each of these is a genuine miss against the same fixtures.
    objectives = [["fastest"], ["scenic"], ["accessible"], ["fastest", "scenic"]]
    codes = [api_client.post("/api/routes", json=_body(objectives=o)).status_code
             for o in objectives]

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


# ---------------------------------------------------------------------------
# the deprecated objective name
# ---------------------------------------------------------------------------


def test_a_link_shared_before_the_rename_still_works(api_client) -> None:
    """`scenic` was called `nature` until 2026-08-12, and `objectives` is in the URL.

    A shared permalink is a promise. `writeUrl` puts the objective ids in the
    query string and `decodeState` reads them back, so a strict rename would
    422 every link anyone had sent — and would do it a year after they sent it,
    for a reason invisible to them.
    """
    response = api_client.post("/api/routes", json=_body(objectives=["fastest", "nature"]))
    assert response.status_code == 200, response.text
    ids = [r["id"] for r in response.json()["routes"]]
    assert ids == ["fastest", "scenic"]


def test_the_old_name_is_accepted_but_never_emitted(api_client) -> None:
    """One direction only.

    The alias exists so an old request is understood, not so the old name comes
    back. Nothing in the response, the labels or the scores may carry it, or the
    rename would be cosmetic and the two names would live on together.
    """
    import json as _json

    payload = api_client.post("/api/routes", json=_body(objectives=["nature"])).json()
    assert "nature" not in _json.dumps(payload).lower()


def test_an_unknown_objective_is_still_rejected() -> None:
    """The alias must not become a general "accept anything" clause.

    `mode="before"` runs ahead of the Literal, so it is the one place where an
    unrecognised id could be let through by accident.
    """
    from pydantic import ValidationError

    from backend.models import Point, RouteRequest

    with pytest.raises(ValidationError):
        RouteRequest(origin=Point(lat=51.5, lon=-0.16), minutes=30, objectives=["greenery"])

    # And the alias itself resolves rather than merely passing.
    req = RouteRequest(origin=Point(lat=51.5, lon=-0.16), minutes=30, objectives=["nature"])
    assert req.resolved_objectives() == ("scenic",)
