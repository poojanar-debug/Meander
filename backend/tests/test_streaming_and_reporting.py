"""SSE streaming and barrier reporting."""

from __future__ import annotations

import json

import pytest

from backend.config import TEST_LOCATIONS_BY_SLUG

COLOMBO = TEST_LOCATIONS_BY_SLUG["colombo-fort"]
VIHARA = TEST_LOCATIONS_BY_SLUG["viharamahadevi"]

BODY = {
    "origin": {"lat": COLOMBO.lat, "lon": COLOMBO.lon},
    "destination": {"lat": VIHARA.lat, "lon": VIHARA.lon},
    "minutes": 25,
}
SSE = {"Accept": "text/event-stream"}


def _events(response) -> list[dict]:
    out = []
    for frame in response.text.split("\n\n"):
        line = next((line for line in frame.split("\n") if line.startswith("data:")), None)
        if line:
            out.append(json.loads(line[5:]))
    return out


# --- streaming -------------------------------------------------------------


def test_asking_for_event_stream_gets_one(api_client) -> None:
    response = api_client.post("/api/routes", json=BODY, headers=SSE)

    assert response.status_code == 200
    assert "text/event-stream" in response.headers["content-type"]


def test_the_stream_carries_progress_then_routes_then_done(api_client) -> None:
    events = _events(api_client.post("/api/routes", json=BODY, headers=SSE))
    kinds = [e["type"] for e in events]

    assert kinds[0] == "progress"
    assert kinds[-1] == "done"
    assert kinds.index("route") > kinds.index("progress")


def test_routes_arrive_before_the_final_payload(api_client) -> None:
    """The whole point of streaming: the first route must not wait for the last."""
    events = _events(api_client.post("/api/routes", json=BODY, headers=SSE))
    route_events = [e for e in events if e["type"] == "route"]

    assert len(route_events) >= 3
    assert events.index(route_events[0]) < events.index(events[-1])


def test_progress_events_advance(api_client) -> None:
    pcts = [e["pct"] for e in _events(api_client.post("/api/routes", json=BODY, headers=SSE))
            if e["type"] == "progress"]

    assert pcts == sorted(pcts)
    assert pcts[0] < pcts[-1] <= 100


def test_streamed_routes_have_the_same_shape_as_json_ones(api_client) -> None:
    streamed = _events(api_client.post("/api/routes", json=BODY, headers=SSE))
    final = next(e for e in streamed if e["type"] == "done")["payload"]
    plain = api_client.post("/api/routes", json={**BODY, "minutes": 30}).json()

    assert set(final) == set(plain)
    assert set(final["routes"][0]) == set(plain["routes"][0])


def test_every_route_id_appears_in_the_stream(api_client) -> None:
    events = _events(api_client.post("/api/routes", json=BODY, headers=SSE))
    streamed_ids = {e["route"]["id"] for e in events if e["type"] == "route"}
    final_ids = {r["id"] for e in events if e["type"] == "done" for r in e["payload"]["routes"]}

    assert streamed_ids == final_ids


def test_a_cache_hit_still_speaks_sse(api_client) -> None:
    """One client code path, whether or not the answer was already computed."""
    api_client.post("/api/routes", json=BODY, headers=SSE)
    second = api_client.post("/api/routes", json=BODY, headers=SSE)

    assert second.headers["X-Meander-Cache"] == "hit"
    kinds = [e["type"] for e in _events(second)]
    assert "route" in kinds and kinds[-1] == "done"


def test_the_stream_is_not_buffered_by_proxies(api_client) -> None:
    response = api_client.post("/api/routes", json=BODY, headers=SSE)

    assert response.headers["cache-control"].startswith("no-cache")
    assert response.headers["x-accel-buffering"] == "no"


def test_a_routing_failure_mid_stream_becomes_an_error_event(api_client, monkeypatch) -> None:
    """The status line is already sent by then, so the error has to travel as an event."""
    from backend import main
    from backend.routing import RoutingError

    async def explode(*args, **kwargs):
        raise RoutingError("upstream", "The routing service fell over.", 502)

    monkeypatch.setitem(main.PRESETS, "fastest", explode)

    events = _events(api_client.post("/api/routes", json=BODY, headers=SSE))
    assert events[-1]["type"] == "error"
    assert events[-1]["message"] == "The routing service fell over."


def test_streaming_is_opt_in(api_client) -> None:
    response = api_client.post("/api/routes", json=BODY)
    assert "application/json" in response.headers["content-type"]


def test_a_stream_result_is_cached_for_the_json_path_too(api_client) -> None:
    api_client.post("/api/routes", json=BODY, headers=SSE)
    assert api_client.post("/api/routes", json=BODY).headers["X-Meander-Cache"] == "hit"


# --- barrier reporting -----------------------------------------------------


REPORT = {
    "lat": 6.9344,
    "lon": 79.8428,
    "type": "steps",
    "description": "Four steps at the park entrance, no ramp.",
}


def test_the_report_target_is_the_development_server_and_nothing_else() -> None:
    """A copy-paste that repointed this at production OSM would put junk into
    the map everyone else relies on."""
    from backend.config import OSM_DEV_API_URL
    from backend.osm_report import PERMITTED_HOST, assert_development_server

    assert PERMITTED_HOST == "api06.dev.openstreetmap.org"
    assert OSM_DEV_API_URL.startswith("https://api06.dev.openstreetmap.org/")
    assert_development_server(OSM_DEV_API_URL + "/notes")


@pytest.mark.parametrize(
    "url",
    [
        "https://api.openstreetmap.org/api/0.6/notes",
        "https://www.openstreetmap.org/api/0.6/notes",
        "https://master.apis.dev.openstreetmap.org/api/0.6/notes",
        "http://evil.invalid/api/0.6/notes",
    ],
)
def test_any_other_host_is_refused(url: str) -> None:
    from backend.osm_report import BarrierReportError, assert_development_server

    with pytest.raises(BarrierReportError, match="Refusing to write"):
        assert_development_server(url)


def test_the_note_text_says_where_it_came_from() -> None:
    from backend.models import BarrierReport
    from backend.osm_report import note_text

    text = note_text(BarrierReport(**REPORT))
    assert "steps" in text
    assert "no ramp" in text
    assert "Meander" in text


def test_reporting_without_a_fixture_fails_safely(api_client) -> None:
    """Nothing is written, and the response says so rather than implying success."""
    response = api_client.post("/api/report-barrier", json=REPORT)

    assert response.status_code == 503
    assert "Nothing was sent" in response.json()["error"]["message"]


def test_a_report_with_a_bad_coordinate_is_rejected(api_client) -> None:
    assert api_client.post("/api/report-barrier", json={**REPORT, "lat": 200}).status_code == 422


def test_an_overlong_description_is_rejected(api_client) -> None:
    body = {**REPORT, "description": "x" * 5000}
    assert api_client.post("/api/report-barrier", json=body).status_code == 422


def test_barrier_reports_are_rate_limited(api_client, monkeypatch) -> None:
    from backend import main
    from backend.ratelimit import RateLimiter

    monkeypatch.setattr(main, "limiter",
                        RateLimiter(capacity=0, refill_per_min=0.0, daily_ceiling=100))

    assert api_client.post("/api/report-barrier", json=REPORT).status_code == 429
