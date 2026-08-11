"""A coordinate must not reach a log line, by any of the routes it can take.

The filter walks `record.__dict__`, so it only ever saw *structured fields* — a
key somebody chose. The formatter separately writes `record.getMessage()` and
`formatException(record.exc_info)`, and neither passed through it. Every case
below was measured leaking against the real filter and formatter pair.

The last two are the ones that matter, because they need nobody in this project
to have logged anything: two catch-all handlers sit above everything in main.py,
so any exception raised anywhere in the process — including inside a library —
becomes a log line. GraphHopper's own "Cannot find point 0: 51.507489,-0.162207"
is the string routing.py already refuses to log as a structured field, and
pydantic v2 embeds `input_value=` in every ValidationError.
"""

from __future__ import annotations

import io
import json
import logging

import pytest
from pydantic import BaseModel

from backend.logging_setup import JsonFormatter, PrivacyFilter, scrub

LAT = 51.507489
LON = -0.162207


@pytest.fixture
def emit():
    """Log through the real filter and formatter, and hand back the JSON line."""
    buffer = io.StringIO()
    handler = logging.StreamHandler(buffer)
    handler.setFormatter(JsonFormatter())
    handler.addFilter(PrivacyFilter())
    log = logging.getLogger("test_log_privacy")
    log.handlers = [handler]
    log.propagate = False
    log.setLevel(logging.DEBUG)

    def _emit(fn, *args, **kwargs):
        buffer.truncate(0)
        buffer.seek(0)
        fn(log, *args, **kwargs)
        return buffer.getvalue()

    return _emit


def _clean(line: str) -> bool:
    return "51.5074" not in line and "0.16220" not in line


def test_a_banned_key_is_still_redacted(emit) -> None:
    assert _clean(emit(lambda log: log.info("routed", extra={"lat": LAT})))


def test_a_key_nobody_thought_to_ban_is_redacted_by_shape(emit) -> None:
    """`start` is not in BANNED_FIELDS and never will be — the list cannot
    anticipate every name. This one leaked in full."""
    assert _clean(emit(lambda log: log.info("routed", extra={"start": LAT})))


def test_an_interpolated_argument_is_redacted(emit) -> None:
    """`msg % args` is assembled by getMessage(), which the key walk never saw."""
    assert _clean(emit(lambda log: log.info("cannot find point %s", LAT)))


def test_a_traceback_is_redacted(emit) -> None:
    """The exact GraphHopper string routing.py refuses to log as a field."""

    def raise_it(log):
        try:
            raise ValueError(f"Cannot find point 0: {LAT},{LON}")
        except ValueError:
            log.exception("upstream_failed")

    assert _clean(emit(raise_it))


def test_a_pydantic_validation_error_is_redacted(emit) -> None:
    """v2 embeds `input_value=` in the rendered error, so the coordinate is in
    the traceback text without anyone having chosen to put it there."""

    class Model(BaseModel):
        lat: int

    def raise_it(log):
        try:
            Model(lat=LAT)
        except Exception:
            log.exception("validation_failed")

    assert _clean(emit(raise_it))


def test_the_timestamp_survives(emit) -> None:
    """An ISO timestamp ends in fractional seconds, which are coordinate-shaped.
    Redacting those would cost every log line its time for no privacy gain."""
    line = json.loads(emit(lambda log: log.info("hello")))
    assert line["ts"].startswith("20")
    assert "<redacted>" not in line["ts"]


def test_the_message_still_says_something(emit) -> None:
    """Redaction replaces the number, not the line."""
    line = json.loads(emit(lambda log: log.info("cannot find point %s", LAT)))
    assert line["msg"] == "cannot find point <redacted>"


@pytest.mark.parametrize(
    "value,expected",
    [
        (51.507489, "<redacted>"),
        # Two decimals is a city, not a street: ~1.1 km at this latitude.
        (51.5, 51.5),
        (0.65, 0.65),
        # Counts and flags are neither.
        (200, 200),
        (True, True),
        ("bench", "bench"),
    ],
)
def test_scrub_leaves_everything_that_is_not_coordinate_shaped(value, expected) -> None:
    assert scrub(value) == expected


def test_scrub_reaches_inside_containers() -> None:
    assert scrub({"a": [f"{LAT},{LON}"]}) == {"a": ["<redacted>,<redacted>"]}
