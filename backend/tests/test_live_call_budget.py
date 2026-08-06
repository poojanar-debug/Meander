"""The live-call budget is a development guard rail, and must behave like one.

It used to be a **lifetime** cap that was still consulted in live mode and
metered a self-hosted server at 3 credits a call. One round trip runs up to 6
nature candidates plus fastest plus accessible — 8 requests x 3 = 24 units
against a cap of 80. Three route requests per container, ever, and then 503
until somebody deleted a file they had never heard of.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from backend import config
from backend import fixtures as fx


@pytest.fixture
def budget(tmp_fixture_dir: Path) -> fx.LiveCallBudget:
    return fx.LiveCallBudget(caps={"graphhopper": 10, "overpass": 4})


# ---------------------------------------------------------------------------
# when the budget applies at all
# ---------------------------------------------------------------------------


def test_not_consulted_in_live_mode(monkeypatch: pytest.MonkeyPatch) -> None:
    """Production. The rate limiter and the daily ceiling are the real controls."""
    monkeypatch.setattr(fx, "current_mode", lambda: "live")
    applies, reason = fx.budget_applies("graphhopper")
    assert applies is False
    assert reason == "live_mode"


def test_not_consulted_for_a_self_hosted_router(monkeypatch: pytest.MonkeyPatch) -> None:
    """A server you own and pay nothing to query has no quota to protect."""
    monkeypatch.setattr(fx, "current_mode", lambda: "record")
    monkeypatch.setenv(config.SELF_HOSTED_ENV, "1")
    applies, reason = fx.budget_applies("graphhopper")
    assert applies is False
    assert reason == "self_hosted_router"


def test_still_enforced_when_recording_against_the_hosted_api(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The one case it was written for: a dev loop burning a metered quota."""
    monkeypatch.setattr(fx, "current_mode", lambda: "record")
    monkeypatch.setenv(config.SELF_HOSTED_ENV, "0")
    assert fx.budget_applies("graphhopper") == (True, "enforced")


def test_other_services_are_metered_even_when_the_router_is_ours(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Self-hosting GraphHopper says nothing about Overpass or Nominatim."""
    monkeypatch.setattr(fx, "current_mode", lambda: "record")
    monkeypatch.setenv(config.SELF_HOSTED_ENV, "1")
    assert fx.budget_applies("overpass") == (True, "enforced")
    assert fx.budget_applies("nominatim") == (True, "enforced")


# ---------------------------------------------------------------------------
# the UTC-day rollover
# ---------------------------------------------------------------------------


def test_rollover_zeroes_the_counters(
    budget: fx.LiveCallBudget, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Nobody should have to delete a file to get another day's allowance."""
    assert budget.try_spend("graphhopper", 9) is True
    assert budget.remaining("graphhopper") == 1
    assert budget.try_spend("graphhopper", 5) is False

    monkeypatch.setattr(fx, "utc_day", lambda: "2099-01-02")

    assert budget.remaining("graphhopper") == 10
    assert budget.try_spend("graphhopper", 5) is True


def test_rollover_re_warns_once_per_day(
    budget: fx.LiveCallBudget, monkeypatch: pytest.MonkeyPatch
) -> None:
    budget.try_spend("graphhopper", 10)
    assert budget.try_spend("graphhopper", 1) is False
    assert "graphhopper" in budget._warned

    monkeypatch.setattr(fx, "utc_day", lambda: "2099-01-03")
    budget.try_spend("graphhopper", 1)
    assert "graphhopper" not in budget._warned


def test_a_counter_file_from_yesterday_is_ignored(tmp_fixture_dir: Path) -> None:
    """The rollover has to survive a restart, or it only works while the process does."""
    path = tmp_fixture_dir / "_budget.json"
    path.write_text(json.dumps({"day": "1999-12-31", "live_calls": {"graphhopper": 999}}))

    budget = fx.LiveCallBudget(path=path, caps={"graphhopper": 10})
    assert budget.spent("graphhopper") == 0
    assert budget.remaining("graphhopper") == 10


def test_todays_counter_file_is_honoured(tmp_fixture_dir: Path) -> None:
    path = tmp_fixture_dir / "_budget.json"
    path.write_text(json.dumps({"day": fx.utc_day(), "live_calls": {"graphhopper": 7}}))

    budget = fx.LiveCallBudget(path=path, caps={"graphhopper": 10})
    assert budget.spent("graphhopper") == 7
    assert budget.remaining("graphhopper") == 3


def test_the_saved_file_records_the_day(budget: fx.LiveCallBudget) -> None:
    budget.try_spend("graphhopper", 1)
    saved = json.loads(budget.path.read_text())
    assert saved["day"] == fx.utc_day()
    assert saved["live_calls"]["graphhopper"] == 1


# ---------------------------------------------------------------------------
# no disk write on the production path
# ---------------------------------------------------------------------------


def test_live_mode_writes_no_budget_file(
    tmp_fixture_dir: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """_save() used to run a synchronous JSON write per upstream call."""
    monkeypatch.setattr(fx, "current_mode", lambda: "live")
    applies, _ = fx.budget_applies("graphhopper")
    assert applies is False
    assert not (tmp_fixture_dir / "_budget.json").exists()


# ---------------------------------------------------------------------------
# the arithmetic that made this a launch blocker
# ---------------------------------------------------------------------------


def test_a_deployed_round_trip_no_longer_exhausts_the_cap(
    monkeypatch: pytest.MonkeyPatch, tmp_fixture_dir: Path
) -> None:
    """200 consecutive uncached requests, the Phase 1 gate, in miniature.

    Under the old rules this spent 24 units per request against 80 and stopped
    after three.
    """
    monkeypatch.setattr(fx, "current_mode", lambda: "live")
    monkeypatch.setenv(config.SELF_HOSTED_ENV, "1")

    from backend.routing import GRAPHHOPPER_CREDIT_COST

    requests_per_route = 6 + 1 + 1  # nature candidates, fastest, accessible
    for _ in range(200):
        for _ in range(requests_per_route):
            metered, _reason = fx.budget_applies("graphhopper")
            assert metered is False, "a deployed instance must not meter its own router"

    # Nothing was counted and nothing was written.
    assert not (tmp_fixture_dir / "_budget.json").exists()
    assert GRAPHHOPPER_CREDIT_COST == 3  # the multiplier that made 80 into 3 requests
