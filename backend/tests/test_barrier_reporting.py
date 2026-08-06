"""The barrier-reporting loop, end to end, without ever writing to OSM.

Every request here goes through a mocked transport. **Nothing in this suite is
permitted to open a socket**, and this is the one endpoint where that guarantee
protects somebody other than us: a real POST would put a note on a public
database, and a test suite that files junk into OpenStreetMap — even the
development instance — is a test suite nobody should run.

The loop matters because it is the only mechanism that improves the thing the
whole app is limited by. Meander can only reject a barrier somebody has already
recorded; most footways carry no surface, smoothness or kerb tag at all. A
person who has just walked into a barrier is the one source of that data.
"""

from __future__ import annotations

import dataclasses

import httpx
import pytest

from backend import osm_report
from backend.models import BarrierReport

VALID = {
    "lat": 51.507489,
    "lon": -0.162207,
    "type": "steps",
    "description": "Four steps up to the bridge, no ramp.",
}


@pytest.fixture
def osm(monkeypatch: pytest.MonkeyPatch):
    """Capture what would have been sent, and answer as OSM would."""
    sent: dict = {}

    def _install(*, status: int = 200, note_id: int | None = 4242):
        async def fake_fetch(method, url, **kwargs):
            sent["method"] = method
            sent["url"] = url
            sent["params"] = kwargs.get("params")
            sent["headers"] = kwargs.get("headers")
            body = {"properties": {"id": note_id}} if note_id is not None else {}
            return httpx.Response(status, json=body, request=httpx.Request(method, url))

        monkeypatch.setattr(osm_report, "fetch", fake_fetch)
        return sent

    return _install


# ---------------------------------------------------------------------------
# the target
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_it_writes_only_to_the_development_server(osm) -> None:
    sent = osm()
    await osm_report.submit_barrier(BarrierReport(**VALID))
    assert "api06.dev.openstreetmap.org" in sent["url"]


def test_production_osm_is_refused_at_call_time(monkeypatch: pytest.MonkeyPatch) -> None:
    """A constant is not a strong enough guard for a write to the live map.

    The host is asserted rather than only configured, because a copy-paste that
    repointed this at production would put junk into the map everyone relies on.
    """
    with pytest.raises(osm_report.BarrierReportError) as caught:
        osm_report.assert_development_server("https://api.openstreetmap.org/api/0.6/notes")
    assert caught.value.status_code == 500
    assert "Refusing to write" in caught.value.human_message


# ---------------------------------------------------------------------------
# what is actually sent
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_the_note_carries_the_barrier_and_its_attribution(osm) -> None:
    sent = osm()
    await osm_report.submit_barrier(BarrierReport(**VALID))

    text = sent["params"]["text"]
    assert "steps" in text
    assert "Four steps up to the bridge" in text
    # A mapper looking at this note needs to know where it came from.
    assert "Meander" in text


@pytest.mark.asyncio
async def test_coordinates_are_rounded_to_something_a_mapper_can_use(osm) -> None:
    sent = osm()
    await osm_report.submit_barrier(BarrierReport(**{**VALID, "lat": 51.50748912345}))
    assert sent["params"]["lat"] == round(51.50748912345, 6)


@pytest.mark.asyncio
async def test_the_note_id_comes_back(osm) -> None:
    osm(note_id=99)
    assert await osm_report.submit_barrier(BarrierReport(**VALID)) == 99


@pytest.mark.asyncio
async def test_a_missing_note_id_is_not_an_error(osm) -> None:
    """OSM does not promise one, and the report still landed."""
    osm(note_id=None)
    assert await osm_report.submit_barrier(BarrierReport(**VALID)) is None


# ---------------------------------------------------------------------------
# the token — wired in Phase 2.7, having been read and never sent
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_the_token_is_sent_when_present(osm, monkeypatch: pytest.MonkeyPatch) -> None:
    sent = osm()
    monkeypatch.setattr(
        osm_report, "settings", dataclasses.replace(osm_report.settings, osm_dev_token="tok")
    )
    await osm_report.submit_barrier(BarrierReport(**VALID))
    assert sent["headers"]["Authorization"] == "Bearer tok"


@pytest.mark.asyncio
async def test_without_a_token_it_still_files_anonymously(
    osm, monkeypatch: pytest.MonkeyPatch
) -> None:
    """OSM accepts anonymous notes, so a missing token degrades rather than blocks."""
    sent = osm()
    monkeypatch.setattr(
        osm_report, "settings", dataclasses.replace(osm_report.settings, osm_dev_token=None)
    )
    assert await osm_report.submit_barrier(BarrierReport(**VALID)) == 4242
    assert "Authorization" not in sent["headers"]


# ---------------------------------------------------------------------------
# failure
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_a_rejection_says_nothing_was_recorded(osm) -> None:
    """The one thing a user must not be left uncertain about."""
    osm(status=400)
    with pytest.raises(osm_report.BarrierReportError) as caught:
        await osm_report.submit_barrier(BarrierReport(**VALID))
    assert "Nothing was recorded" in caught.value.human_message


# ---------------------------------------------------------------------------
# the endpoint
# ---------------------------------------------------------------------------


def test_the_endpoint_is_rate_limited(api_client, monkeypatch: pytest.MonkeyPatch) -> None:
    """It is an unauthenticated write path to a public database."""
    from backend.main import limiter

    monkeypatch.setattr(limiter, "daily_ceiling", 0)
    response = api_client.post("/api/report-barrier", json=VALID)
    assert response.status_code == 429


def test_the_endpoint_validates_before_sending(api_client) -> None:
    response = api_client.post("/api/report-barrier", json={"lat": 999, "lon": 0,
                                                            "type": "x", "description": "y"})
    assert response.status_code == 422
    assert response.json()["error"]["kind"] == "invalid_request"


def test_a_successful_report_says_where_it_went(
    api_client, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The response repeats the development-server caveat, so a client that
    shows only the message still tells the truth."""

    async def fake_submit(report):
        return 7

    monkeypatch.setattr(osm_report, "submit_barrier", fake_submit)
    body = api_client.post("/api/report-barrier", json=VALID).json()

    assert body["status"] == "submitted"
    assert body["target"] == "api06.dev.openstreetmap.org"
    assert "not the live map" in body["message"]
