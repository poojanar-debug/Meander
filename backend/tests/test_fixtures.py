"""The fixtures layer is the thing standing between an iteration loop and a
drained API quota. These tests run with sockets blocked (see conftest), so a
replay that secretly reached the network would fail here rather than in
production.
"""

from __future__ import annotations

import json
from pathlib import Path

import httpx
import pytest

from backend import fixtures as fx


def _stub_response(payload: dict, status: int = 200) -> httpx.Response:
    return httpx.Response(
        status_code=status,
        headers={"content-type": "application/json"},
        content=json.dumps(payload).encode(),
        request=httpx.Request("GET", "https://example.invalid/"),
    )


# --- signature -------------------------------------------------------------


def test_signature_is_stable_across_param_order() -> None:
    a = fx.signature("GET", "https://api.open-meteo.com/v1/forecast",
                     params={"latitude": 6.9, "longitude": 79.8})
    b = fx.signature("GET", "https://api.open-meteo.com/v1/forecast",
                     params={"longitude": 79.8, "latitude": 6.9})
    assert a == b


def test_signature_ignores_api_keys() -> None:
    """Two contributors with different keys must share fixtures."""
    a = fx.signature("GET", "https://graphhopper.com/api/1/route",
                     params={"point": "6.9,79.8", "key": "aaa"})
    b = fx.signature("GET", "https://graphhopper.com/api/1/route",
                     params={"point": "6.9,79.8", "key": "bbb"})
    assert a == b


def test_signature_ignores_secret_headers() -> None:
    a = fx.signature("GET", "https://graph.mapillary.com/images",
                     headers={"Authorization": "OAuth aaa"})
    b = fx.signature("GET", "https://graph.mapillary.com/images",
                     headers={"Authorization": "OAuth bbb"})
    assert a == b


def test_signature_changes_with_the_request_body() -> None:
    a = fx.signature("POST", "https://graphhopper.com/api/1/route",
                     json_body={"profile": "foot"})
    b = fx.signature("POST", "https://graphhopper.com/api/1/route",
                     json_body={"profile": "bike"})
    assert a != b


def test_signature_nested_dict_order_does_not_matter() -> None:
    a = fx.signature("POST", "https://x.invalid/", json_body={"a": {"p": 1, "q": 2}})
    b = fx.signature("POST", "https://x.invalid/", json_body={"a": {"q": 2, "p": 1}})
    assert a == b


def test_signature_treats_integral_floats_as_ints() -> None:
    a = fx.signature("POST", "https://x.invalid/", json_body={"minutes": 25})
    b = fx.signature("POST", "https://x.invalid/", json_body={"minutes": 25.0})
    assert a == b


def test_signature_distinguishes_method() -> None:
    assert fx.signature("GET", "https://x.invalid/a") != fx.signature("POST", "https://x.invalid/a")


# --- service mapping -------------------------------------------------------


@pytest.mark.parametrize(
    "url,expected",
    [
        ("https://graphhopper.com/api/1/route", "graphhopper"),
        ("https://graph.mapillary.com/images", "mapillary"),
        ("https://overpass-api.de/api/interpreter", "overpass"),
        ("https://api.open-meteo.com/v1/forecast", "open_meteo"),
        ("https://air-quality-api.open-meteo.com/v1/air-quality", "open_meteo"),
        ("https://api06.dev.openstreetmap.org/api/0.6/notes", "osm_dev"),
    ],
)
def test_service_for_url(url: str, expected: str) -> None:
    assert fx.service_for_url(url) == expected


def test_unknown_host_gets_its_own_bucket() -> None:
    assert fx.service_for_url("https://example.com/x") == "example_com"


# --- replay ----------------------------------------------------------------


@pytest.mark.asyncio
async def test_replay_serves_from_disk_with_no_network(tmp_fixture_dir: Path, fixture_mode) -> None:
    fixture_mode("replay")
    sig = fx.signature("GET", "https://api.open-meteo.com/v1/forecast", params={"latitude": 6.9})
    fx.write_fixture(
        "open_meteo", sig,
        method="GET", url="https://api.open-meteo.com/v1/forecast",
        params={"latitude": 6.9}, json_body=None, data=None, content=None, headers=None,
        response=_stub_response({"hourly": {"temperature_2m": [28.1]}}),
    )

    resp = await fx.fetch("GET", "https://api.open-meteo.com/v1/forecast",
                          params={"latitude": 6.9})

    assert resp.status_code == 200
    assert resp.json()["hourly"]["temperature_2m"] == [28.1]
    assert fx.provenance_of(resp) == fx.PROVENANCE_RECORDED


@pytest.mark.asyncio
async def test_replay_miss_raises_rather_than_going_live(tmp_fixture_dir: Path, fixture_mode) -> None:
    fixture_mode("replay")
    with pytest.raises(fx.FixtureMissing) as exc:
        await fx.fetch("GET", "https://graphhopper.com/api/1/route", params={"point": "1,2"})

    assert "MEANDER_FIXTURES=record" in str(exc.value)


@pytest.mark.asyncio
async def test_replay_never_touches_the_budget(tmp_fixture_dir: Path, fixture_mode) -> None:
    fixture_mode("replay")
    sig = fx.signature("GET", "https://api.open-meteo.com/v1/forecast", params={"latitude": 1})
    fx.write_fixture(
        "open_meteo", sig,
        method="GET", url="https://api.open-meteo.com/v1/forecast",
        params={"latitude": 1}, json_body=None, data=None, content=None, headers=None,
        response=_stub_response({"ok": True}),
    )
    await fx.fetch("GET", "https://api.open-meteo.com/v1/forecast", params={"latitude": 1})

    assert fx.get_budget().spent("open_meteo") == 0


@pytest.mark.asyncio
async def test_replayed_non_json_body_survives(tmp_fixture_dir: Path, fixture_mode) -> None:
    fixture_mode("replay")
    url = "https://overpass-api.de/api/interpreter"
    sig = fx.signature("POST", url, data={"data": "[out:json];out;"})
    resp = httpx.Response(200, headers={"content-type": "text/plain"}, content=b"not json",
                          request=httpx.Request("POST", url))
    fx.write_fixture("overpass", sig, method="POST", url=url, params=None, json_body=None,
                     data={"data": "[out:json];out;"}, content=None, headers=None, response=resp)

    got = await fx.fetch("POST", url, data={"data": "[out:json];out;"})
    assert got.text == "not json"


# --- secret hygiene --------------------------------------------------------


def test_written_fixture_redacts_query_secrets(tmp_fixture_dir: Path) -> None:
    path = fx.write_fixture(
        "graphhopper", "abc123",
        method="GET", url="https://graphhopper.com/api/1/route?key=SECRET",
        params={"point": "6.9,79.8", "key": "SECRET"},
        json_body=None, data=None, content=None,
        headers={"Authorization": "OAuth SECRET"},
        response=_stub_response({"paths": []}),
    )
    text = path.read_text()

    assert "SECRET" not in text
    assert "<redacted>" in text


def test_written_fixture_strips_the_query_string_from_the_stored_url(tmp_fixture_dir: Path) -> None:
    path = fx.write_fixture(
        "graphhopper", "abc124",
        method="GET", url="https://graphhopper.com/api/1/route?key=SECRET&point=1,2",
        params=None, json_body=None, data=None, content=None, headers=None,
        response=_stub_response({}),
    )
    stored = json.loads(path.read_text())["request"]["url"]

    assert stored == "https://graphhopper.com/api/1/route"


# --- budget ----------------------------------------------------------------


def test_budget_allows_up_to_the_cap_then_refuses(tmp_path: Path) -> None:
    budget = fx.LiveCallBudget(tmp_path / "b.json", caps={"graphhopper": 3})

    assert budget.try_spend("graphhopper") is True
    assert budget.try_spend("graphhopper", 2) is True
    assert budget.try_spend("graphhopper") is False
    assert budget.spent("graphhopper") == 3
    assert budget.remaining("graphhopper") == 0


def test_budget_rejects_a_cost_that_would_overshoot(tmp_path: Path) -> None:
    budget = fx.LiveCallBudget(tmp_path / "b.json", caps={"graphhopper": 4})
    budget.try_spend("graphhopper", 3)

    assert budget.try_spend("graphhopper", 3) is False
    assert budget.spent("graphhopper") == 3, "a refused spend must not be charged"


def test_budget_persists_across_instances(tmp_path: Path) -> None:
    path = tmp_path / "b.json"
    fx.LiveCallBudget(path, caps={"overpass": 5}).try_spend("overpass", 4)

    assert fx.LiveCallBudget(path, caps={"overpass": 5}).remaining("overpass") == 1


def test_unbudgeted_service_gets_zero_live_calls(tmp_path: Path) -> None:
    """A hostname typo must not become an uncapped spend."""
    budget = fx.LiveCallBudget(tmp_path / "b.json", caps={"graphhopper": 10})

    assert budget.try_spend("typo_service") is False


def test_budget_survives_a_corrupt_counter_file(tmp_path: Path) -> None:
    path = tmp_path / "b.json"
    path.write_text("{ not json")

    assert fx.LiveCallBudget(path, caps={"overpass": 2}).spent("overpass") == 0


def test_budget_snapshot_shape(tmp_path: Path) -> None:
    budget = fx.LiveCallBudget(tmp_path / "b.json", caps={"graphhopper": 80})
    budget.try_spend("graphhopper", 3)

    assert budget.snapshot()["graphhopper"] == {"cap": 80, "spent": 3, "remaining": 77}


@pytest.mark.asyncio
async def test_exhausted_budget_falls_back_to_a_fixture(tmp_fixture_dir: Path, fixture_mode,
                                                        monkeypatch) -> None:
    """Hitting a cap downgrades the service to replay-only; it must not stop the run."""
    fixture_mode("live")
    monkeypatch.setattr(fx, "_budget", fx.LiveCallBudget(tmp_fixture_dir / "b.json",
                                                         caps={"open_meteo": 0}))
    url = "https://api.open-meteo.com/v1/forecast"
    sig = fx.signature("GET", url, params={"latitude": 2})
    fx.write_fixture("open_meteo", sig, method="GET", url=url, params={"latitude": 2},
                     json_body=None, data=None, content=None, headers=None,
                     response=_stub_response({"cached": True}))

    resp = await fx.fetch("GET", url, params={"latitude": 2})
    assert resp.json() == {"cached": True}


@pytest.mark.asyncio
async def test_exhausted_budget_without_a_fixture_raises_budget_exhausted(
    tmp_fixture_dir: Path, fixture_mode, monkeypatch
) -> None:
    fixture_mode("record")
    monkeypatch.setattr(fx, "_budget", fx.LiveCallBudget(tmp_fixture_dir / "b.json",
                                                         caps={"graphhopper": 0}))
    with pytest.raises(fx.BudgetExhausted):
        await fx.fetch("GET", "https://graphhopper.com/api/1/route", params={"point": "9,9"})


# --- provenance ------------------------------------------------------------


def test_synthetic_fixtures_are_flagged(tmp_fixture_dir: Path) -> None:
    fx.write_fixture("graphhopper", "syn1", method="POST", url="https://graphhopper.com/api/1/route",
                     params=None, json_body={"profile": "foot"}, data=None, content=None,
                     headers=None, response=_stub_response({"paths": []}),
                     provenance=fx.PROVENANCE_SYNTHETIC)

    resp = fx.read_fixture("graphhopper", "syn1")
    assert resp is not None
    assert fx.is_synthetic(resp) is True


def test_recorded_fixtures_are_not_synthetic(tmp_fixture_dir: Path) -> None:
    fx.write_fixture("graphhopper", "rec1", method="POST", url="https://graphhopper.com/api/1/route",
                     params=None, json_body={"profile": "foot"}, data=None, content=None,
                     headers=None, response=_stub_response({"paths": []}))

    resp = fx.read_fixture("graphhopper", "rec1")
    assert resp is not None
    assert fx.is_synthetic(resp) is False


def test_fixture_inventory_counts_by_provenance(tmp_fixture_dir: Path) -> None:
    fx.write_fixture("graphhopper", "a", method="GET", url="https://graphhopper.com/x",
                     params=None, json_body=None, data=None, content=None, headers=None,
                     response=_stub_response({}), provenance=fx.PROVENANCE_SYNTHETIC)
    fx.write_fixture("graphhopper", "b", method="GET", url="https://graphhopper.com/y",
                     params=None, json_body=None, data=None, content=None, headers=None,
                     response=_stub_response({}))

    assert fx.fixture_inventory()["graphhopper"] == {"recorded": 1, "synthetic": 1}


def test_read_fixture_missing_returns_none(tmp_fixture_dir: Path) -> None:
    assert fx.read_fixture("graphhopper", "nope") is None


def test_read_fixture_corrupt_returns_none_and_does_not_raise(tmp_fixture_dir: Path) -> None:
    path = fx.fixture_path("graphhopper", "bad")
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("{{{")

    assert fx.read_fixture("graphhopper", "bad") is None


# --- the offline guarantee -------------------------------------------------


def test_the_socket_guard_is_actually_active() -> None:
    """Meta-test. If this passes, every other test in the suite really is offline."""
    import socket

    from backend.tests.conftest import NetworkAccessInTest

    with pytest.raises(NetworkAccessInTest):
        socket.create_connection(("example.com", 80), timeout=1)


# --- record ----------------------------------------------------------------


@pytest.mark.asyncio
async def test_record_mode_writes_a_fixture_then_replays_it(
    tmp_fixture_dir: Path, fixture_mode, monkeypatch
) -> None:
    """The whole point of the layer: one upstream call, then disk forever after."""
    calls = {"n": 0}

    def handler(request: httpx.Request) -> httpx.Response:
        calls["n"] += 1
        return httpx.Response(200, json={"paths": [{"time": 1080000}]})

    monkeypatch.setattr(
        fx, "_client", httpx.AsyncClient(transport=httpx.MockTransport(handler))
    )
    monkeypatch.setattr(
        fx, "_budget", fx.LiveCallBudget(tmp_fixture_dir / "b.json", caps={"graphhopper": 10})
    )
    fixture_mode("record")
    url = "https://graphhopper.com/api/1/route"

    first = await fx.fetch("POST", url, json_body={"profile": "foot"}, cost=3)
    assert calls["n"] == 1
    assert fx.provenance_of(first) == fx.PROVENANCE_LIVE
    assert fx.get_budget().spent("graphhopper") == 3

    second = await fx.fetch("POST", url, json_body={"profile": "foot"}, cost=3)
    assert calls["n"] == 1, "a recorded signature must never hit the network again"
    assert fx.provenance_of(second) == fx.PROVENANCE_RECORDED
    assert second.json() == first.json()
    assert fx.get_budget().spent("graphhopper") == 3, "a replay must not be charged"


@pytest.mark.asyncio
async def test_error_responses_are_not_recorded(
    tmp_fixture_dir: Path, fixture_mode, monkeypatch
) -> None:
    """Recording a 401 would permanently replay a bad key as if it were the answer."""

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(401, json={"message": "no key"})

    monkeypatch.setattr(fx, "_client", httpx.AsyncClient(transport=httpx.MockTransport(handler)))
    monkeypatch.setattr(
        fx, "_budget", fx.LiveCallBudget(tmp_fixture_dir / "b.json", caps={"graphhopper": 10})
    )
    fixture_mode("record")

    resp = await fx.fetch("GET", "https://graphhopper.com/api/1/route", params={"point": "1,2"})

    assert resp.status_code == 401
    sig = fx.signature("GET", "https://graphhopper.com/api/1/route", params={"point": "1,2"})
    assert fx.read_fixture("graphhopper", sig) is None


@pytest.mark.asyncio
async def test_recorded_fixture_never_contains_the_live_key(
    tmp_fixture_dir: Path, fixture_mode, monkeypatch
) -> None:
    from backend import config

    monkeypatch.setattr(fx, "settings", config.Settings(graphhopper_key="LIVE-KEY-123"))

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"paths": []})

    monkeypatch.setattr(fx, "_client", httpx.AsyncClient(transport=httpx.MockTransport(handler)))
    monkeypatch.setattr(
        fx, "_budget", fx.LiveCallBudget(tmp_fixture_dir / "b.json", caps={"graphhopper": 10})
    )
    fixture_mode("record")

    await fx.fetch(
        "GET", "https://graphhopper.com/api/1/route",
        params={"point": "6.9,79.8", "key": "LIVE-KEY-123"},
    )

    written = list((tmp_fixture_dir / "graphhopper").glob("*.json"))
    assert len(written) == 1
    assert "LIVE-KEY-123" not in written[0].read_text()
