"""Request ids, the access log, and the privacy filter behind both.

logging_setup disables uvicorn's access log because it echoes client IPs, and
replaced it with nothing at all — so a deployed instance had no per-request
record of any kind.
"""

from __future__ import annotations

import logging

import pytest

from backend.logging_setup import (
    JsonFormatter,
    PrivacyFilter,
    RequestIdFilter,
    request_id_var,
)


def _record(**extra) -> logging.LogRecord:
    record = logging.LogRecord("t", logging.INFO, "f", 1, "msg", (), None)
    record.__dict__.update(extra)
    return record


# ---------------------------------------------------------------------------
# request id
# ---------------------------------------------------------------------------


def test_a_request_id_comes_back_in_a_header(api_client) -> None:
    resp = api_client.get("/api/health")
    assert resp.headers.get("X-Request-Id")


def test_an_inbound_trace_id_is_honoured(api_client) -> None:
    """So a log line here can be joined to an ALB entry without guessing at times."""
    trace = "Root=1-abcdef01-2345678901234567890abcde"
    resp = api_client.get("/api/health", headers={"X-Amzn-Trace-Id": trace})
    assert resp.headers["X-Request-Id"] == trace


def test_each_request_gets_its_own_id(api_client) -> None:
    ids = {api_client.get("/api/health").headers["X-Request-Id"] for _ in range(5)}
    assert len(ids) == 5


def test_the_id_reaches_a_log_record_from_anywhere() -> None:
    """Most modules that log know nothing about the request."""
    token = request_id_var.set("abc123")
    try:
        record = _record()
        RequestIdFilter().filter(record)
        assert record.request_id == "abc123"
    finally:
        request_id_var.reset(token)


def test_no_id_outside_a_request() -> None:
    record = _record()
    RequestIdFilter().filter(record)
    assert not hasattr(record, "request_id")


# ---------------------------------------------------------------------------
# the access log
# ---------------------------------------------------------------------------


def test_the_access_line_carries_no_ip_and_no_coordinates(
    api_client, caplog: pytest.LogCaptureFixture
) -> None:
    with caplog.at_level(logging.INFO, logger="backend.main"):
        api_client.get("/api/health", headers={"X-Forwarded-For": "203.0.113.7"})

    lines = [r for r in caplog.records if r.getMessage() == "request"]
    assert lines, "every request should produce one access line"
    line = lines[-1]
    assert line.method == "GET"
    assert line.path == "/api/health"
    assert line.status == 200
    assert isinstance(line.duration_ms, float)
    blob = JsonFormatter().format(line)
    assert "203.0.113.7" not in blob


def test_probes_are_not_logged(api_client, caplog: pytest.LogCaptureFixture) -> None:
    """They are most of the traffic on a load-balanced service and say nothing."""
    with caplog.at_level(logging.INFO, logger="backend.main"):
        api_client.get("/healthz")
        api_client.get("/readyz")

    paths = [getattr(r, "path", None) for r in caplog.records if r.getMessage() == "request"]
    assert "/healthz" not in paths
    assert "/readyz" not in paths


# ---------------------------------------------------------------------------
# the privacy filter, which is a backstop and not a licence
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    "field,value",
    [
        ("lat", 51.5074),
        ("lon", -0.1622),
        ("origin", [51.5, -0.16]),
        ("points", [[51.5, -0.16], [51.6, -0.17]]),
        ("segment_key", "51.5074,-0.1622"),
        ("bbox", "51.5,-0.17,51.6,-0.15"),
        ("client_ip", "203.0.113.7"),
        ("user_agent", "Mozilla/5.0"),
        # A digit-bearing string under a banned key could encode a coordinate.
        ("destination", "51.5074"),
    ],
)
def test_anything_that_could_be_a_location_is_redacted(field: str, value) -> None:
    record = _record(**{field: value})
    PrivacyFilter().filter(record)
    assert record.__dict__[field] == "<redacted>"


@pytest.mark.parametrize(
    "field,value",
    [
        # The reason the filter is value-aware: these names are ordinary words.
        ("points", 42),           # a count, in most of the codebase
        ("point", 0),
        ("origin", "https"),      # a scheme, in a CORS log line
        ("destination", True),
    ],
)
def test_a_count_or_a_flag_survives(field: str, value) -> None:
    """Redacting these throws away the only useful part of a line for no gain."""
    record = _record(**{field: value})
    PrivacyFilter().filter(record)
    assert record.__dict__[field] == value


def test_the_filter_still_defaults_to_redacting() -> None:
    """Over-redacting costs a log field; under-redacting publishes a location."""
    record = _record(origin={"lat": 51.5, "lon": -0.16})
    PrivacyFilter().filter(record)
    assert record.origin == "<redacted>"


def test_unbanned_fields_are_untouched() -> None:
    record = _record(objective="scenic", duration_ms=12.5)
    PrivacyFilter().filter(record)
    assert record.objective == "scenic"
    assert record.duration_ms == 12.5
