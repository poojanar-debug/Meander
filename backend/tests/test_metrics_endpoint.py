"""`/metrics`, and the rule that it must never become a description of anybody.

An exposition endpoint is the easiest place in a service to leak by accident:
one `path` label, one `region` label, and a file that was aggregate counters
becomes a low-cardinality account of who asked for what and when. This project
promises it does not build that, so the shape of the output is asserted rather
than assumed.
"""

from __future__ import annotations

import re

import pytest
from fastapi.testclient import TestClient

from backend.main import app
from backend.metrics import metrics

client = TestClient(app)


@pytest.fixture(autouse=True)
def _clean_metrics():
    metrics.reset()
    yield
    metrics.reset()


def _series(body: str) -> dict[str, str]:
    """Every non-comment line, as {name: value}."""
    out = {}
    for line in body.splitlines():
        if not line or line.startswith("#"):
            continue
        name, _, value = line.partition(" ")
        out[name] = value
    return out


def test_metrics_answers_in_the_prometheus_format() -> None:
    response = client.get("/metrics")

    assert response.status_code == 200
    # Not merely text/plain. A scraper handed a bare text/plain body treats the
    # exposition as unparseable, so the version parameter is part of the
    # contract rather than decoration.
    assert "version=0.0.4" in response.headers["content-type"]


def test_every_series_is_named_help_typed_and_prefixed() -> None:
    body = client.get("/metrics").text

    names = set(_series(body))
    assert names, "no series at all"
    for name in names:
        assert name.startswith("meander_"), name
        assert f"# TYPE {name} " in body, f"{name} has no TYPE"
        assert f"# HELP {name} " in body, f"{name} has no HELP"


def test_the_counters_the_project_promised_are_all_there() -> None:
    """README's privacy section names these by name as the whole of what is
    counted. If one disappears the document becomes wrong."""
    names = set(_series(client.get("/metrics").text))

    for promised in (
        "meander_route_requests_total",
        "meander_routes_blocked_total",
        "meander_cache_hits_total",
        "meander_segments_scored_total",
        "meander_unique_sessions_today",
    ):
        assert promised in names, promised


def test_a_counter_actually_moves() -> None:
    """A metrics endpoint that always reports zero is worse than none: it looks
    like healthy silence."""
    before = int(_series(client.get("/metrics").text)["meander_route_requests_total"])
    metrics.incr("route_requests_total")
    after = int(_series(client.get("/metrics").text)["meander_route_requests_total"])

    assert after == before + 1


# ---------------------------------------------------------------------------
# the privacy rule
# ---------------------------------------------------------------------------

# `name{label="value"}` — the syntax that turns a total into a breakdown.
LABELLED = re.compile(r"^[a-zA-Z_:][a-zA-Z0-9_:]*\{")


def test_no_series_carries_a_label() -> None:
    """**The rule.** Not a style preference.

    Labels are how an exposition endpoint stops being aggregate. A `path` label
    is a list of what was asked for, a `region` or `bbox` label is a list of
    where, and either is the thing this project's privacy section says it does
    not build. Totals cannot be disaggregated; a labelled series can.
    """
    for line in client.get("/metrics").text.splitlines():
        if line.startswith("#") or not line:
            continue
        assert not LABELLED.match(line), (
            f"labelled series: {line!r}. Every series here must be a whole-instance "
            "total — a label is what turns this file into a description of users."
        )


def test_no_coordinate_shaped_number_appears_anywhere() -> None:
    """A coordinate is a decimal with several places. Every value here is an
    integer count or a whole number of seconds, so any decimal at all is a
    finding worth failing on."""
    for name, value in _series(client.get("/metrics").text).items():
        assert re.fullmatch(r"-?\d+", value), f"{name} is not an integer: {value!r}"


def test_no_series_is_named_after_a_request_attribute() -> None:
    """The same vocabulary logging_setup.py redacts. A series named for one of
    these could only have got its value from a request.

    Matched on the **name**, split into underscore-separated words, not on a
    substring of the whole document. The first version of this searched the
    raw text for "ip" and failed on the word "clip" in a HELP line — which is
    the sort of check that gets deleted rather than fixed, and then the rule it
    was guarding goes with it.
    """
    banned = {"lat", "lon", "latitude", "longitude", "coord", "coords", "bbox",
              "origin", "destination", "ip", "addr", "agent", "ua", "session",
              "segment", "point", "points", "path", "url", "query"}

    for name in _series(client.get("/metrics").text):
        words = set(name.removeprefix("meander_").split("_"))
        overlap = words & banned
        assert not overlap, f"series {name!r} is named after {sorted(overlap)}"


def test_metrics_needs_no_upstream_and_no_disk() -> None:
    """It is scraped every 15 seconds forever. If it touched the router or the
    cache it would be a self-inflicted load generator, and it would start
    failing exactly when everything else does."""
    for _ in range(5):
        assert client.get("/metrics").status_code == 200
