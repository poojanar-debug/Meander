"""A deployed instance must not write fixtures.

fetch() used to write one for every successful live response and then read the
file straight back to assert no secret had leaked. In live mode nothing ever
read those files — the read path is skipped on the happy path — so production
paid two synchronous disk operations per upstream call, grew its disk without
bound, and persisted third-party response bodies with no retention policy, for
no benefit whatsoever.
"""

from __future__ import annotations

from pathlib import Path

import httpx
import pytest

from backend import fixtures as fx

URL = "https://api.open-meteo.com/v1/forecast"


def _mock_client(payload: dict, status: int = 200) -> httpx.AsyncClient:
    return httpx.AsyncClient(
        transport=httpx.MockTransport(lambda request: httpx.Response(status, json=payload))
    )


@pytest.fixture
def mocked(monkeypatch: pytest.MonkeyPatch):
    """Replace the shared client, so 'live' does not mean 'a real socket'."""

    def _install(payload: dict, status: int = 200) -> None:
        monkeypatch.setattr(fx, "_client", _mock_client(payload, status))

    return _install


@pytest.mark.asyncio
async def test_live_mode_writes_nothing(
    tmp_fixture_dir: Path, fixture_mode, mocked, monkeypatch: pytest.MonkeyPatch
) -> None:
    fixture_mode("live")
    mocked({"ok": True})

    resp = await fx.fetch("GET", URL, params={"latitude": 51})
    assert resp.json() == {"ok": True}

    written = list(tmp_fixture_dir.rglob("*.json"))
    assert written == [], f"live mode must persist nothing, wrote {written}"


@pytest.mark.asyncio
async def test_record_mode_still_writes(
    tmp_fixture_dir: Path, fixture_mode, mocked, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Recording is the one mode whose entire job is to write."""
    fixture_mode("record")
    mocked({"ok": True})

    await fx.fetch("GET", URL, params={"latitude": 52})

    written = [p for p in tmp_fixture_dir.rglob("*.json") if p.name != "_budget.json"]
    assert len(written) == 1
    assert written[0].parent.name == "open_meteo"


@pytest.mark.asyncio
async def test_persist_true_overrides_the_mode(
    tmp_fixture_dir: Path, fixture_mode, mocked
) -> None:
    """scripts/make_synthetic_fixtures.py forces live mode in order to regenerate."""
    fixture_mode("live")
    mocked({"ok": True})

    await fx.fetch("GET", URL, params={"latitude": 53}, persist=True)

    written = [p for p in tmp_fixture_dir.rglob("*.json") if p.name != "_budget.json"]
    assert len(written) == 1


@pytest.mark.asyncio
async def test_persist_false_still_wins_when_recording(
    tmp_fixture_dir: Path, fixture_mode, mocked
) -> None:
    """Binary payloads (Mapillary imagery) must never land in the repository."""
    fixture_mode("record")
    mocked({"ok": True})

    await fx.fetch("GET", URL, params={"latitude": 54}, persist=False)

    written = [p for p in tmp_fixture_dir.rglob("*.json") if p.name != "_budget.json"]
    assert written == []


@pytest.mark.asyncio
async def test_an_error_response_is_never_recorded(
    tmp_fixture_dir: Path, fixture_mode, mocked
) -> None:
    """Recording a 4xx would permanently replay an outage or a rejected key."""
    fixture_mode("record")
    mocked({"message": "nope"}, status=429)

    await fx.fetch("GET", URL, params={"latitude": 55})

    written = [p for p in tmp_fixture_dir.rglob("*.json") if p.name != "_budget.json"]
    assert written == []


@pytest.mark.asyncio
async def test_two_hundred_live_requests_leave_the_disk_alone(
    tmp_fixture_dir: Path, fixture_mode, mocked
) -> None:
    """The Phase 1 gate: no fixture written in live mode, over a real request count."""
    fixture_mode("live")
    mocked({"ok": True})

    for i in range(200):
        await fx.fetch("GET", URL, params={"latitude": i})

    assert list(tmp_fixture_dir.rglob("*.json")) == []


def test_record_fixtures_refuses_any_mode_but_record(monkeypatch: pytest.MonkeyPatch) -> None:
    """It used to reject only 'replay', so under 'live' — which .env sets — it
    would spend real credits, report "recorded N" and write nothing."""
    import asyncio
    import dataclasses

    from backend import record_fixtures

    for mode in ("live", "replay"):
        monkeypatch.setattr(
            record_fixtures,
            "settings",
            dataclasses.replace(record_fixtures.settings, fixture_mode=mode),
        )
        rc = asyncio.run(record_fixtures.main_async(["graphhopper"], force=False))
        assert rc == 2, f"mode {mode!r} must be refused"
