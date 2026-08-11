"""Structured JSON logging to stdout.

Coordinates, IP addresses and user agents must never reach a log line. The
filter below is a backstop, not a licence to pass them in.

It works two ways, because one is not enough. ``BANNED_FIELDS`` catches a
structured field by its *key*, which is the deliberate case — somebody chose to
log something. ``COORDINATE_SHAPED`` catches it by its *shape* in the message,
the interpolated arguments and the traceback, which is the accidental case, and
the accidental case is the one that reaches production: a library raising with a
coordinate in its text does not consult a list of banned keys.
"""

from __future__ import annotations

import json
import logging
import re
import sys
from contextvars import ContextVar
from datetime import UTC, datetime
from typing import Any

BANNED_FIELDS = frozenset(
    {
        "lat", "lon", "latitude", "longitude", "ip", "client_ip", "user_agent",
        "origin_coord", "destination", "origin", "coordinates", "point", "points",
        # A segment key is a rounded coordinate pair, and a bbox is four of them.
        "segment_key", "bbox", "upstream_message",
    }
)

# Bound per request by the middleware in main.py, and attached to every record
# emitted while handling it — including from modules that know nothing about
# the request, which is most of them.
request_id_var: ContextVar[str | None] = ContextVar("request_id", default=None)

_RESERVED = frozenset(
    {
        "name", "msg", "args", "levelname", "levelno", "pathname", "filename",
        "module", "exc_info", "exc_text", "stack_info", "lineno", "funcName",
        "created", "msecs", "relativeCreated", "thread", "threadName",
        "processName", "process", "taskName", "message", "asctime",
    }
)


def _could_carry_a_coordinate(value: Any) -> bool:
    """Could this value under a banned key actually be a location?

    The banned list is keyed on names, and some of those names are ordinary
    words. ``points`` is a coordinate array in routing.py and a plain count
    almost everywhere else; ``origin`` is a coordinate in a route request and an
    HTTP header in a CORS log line. Redacting a count or a scheme-and-host
    throws away the only useful part of a log line for no privacy gain.

    So: integers and booleans are counts and flags, never coordinates. Strings
    with no digits cannot encode one. Everything else — floats, lists, dicts,
    digit-bearing strings — is redacted. Deliberately asymmetric: over-redacting
    costs a log field, under-redacting publishes somebody's location.
    """
    if isinstance(value, bool | int):
        return False
    if isinstance(value, str):
        return any(ch.isdigit() for ch in value)
    return True


# A decimal carrying four or more fractional digits. At London's latitude the
# fourth decimal place is about 11 m, so anything at or beyond it is precise
# enough to place a person on a street rather than in a city.
#
# This is the second half of the guarantee, and it is needed because the banned
# list above can only see *keys*. Three ways a coordinate reaches a log line
# without ever being a key, all measured against the real filter and formatter:
#
#   log.info("cannot find point %s", 51.507489)       -> the message
#   log.exception(...) on GraphHopper's
#     ValueError("Cannot find point 0: 51.507489,...") -> the traceback
#   a pydantic ValidationError, which embeds `input_value=` -> the traceback
#
# All 60 call sites are clean today, so nothing leaks now. But two catch-all
# handlers sit above everything in main.py, which makes the promise rest on
# every exception raised anywhere in the process — including from libraries —
# having a coordinate-free message. That is not a property this project can
# hold, and row two above is exactly the string routing.py already refuses to
# log as a structured field.
#
# Deliberately blunt, in the same direction as _could_carry_a_coordinate: a
# genuine four-decimal number in a log line is redacted too. Nothing in this
# codebase logs one — the structured fields are counts, statuses and enum
# values — and a lost debugging digit is the cheaper mistake.
COORDINATE_SHAPED = re.compile(r"-?\d+\.\d{4,}")


def scrub(value: Any) -> Any:
    """Replace anything coordinate-shaped inside ``value``, at any depth."""
    if isinstance(value, str):
        return COORDINATE_SHAPED.sub("<redacted>", value)
    if isinstance(value, float):
        return "<redacted>" if COORDINATE_SHAPED.fullmatch(repr(value)) else value
    if isinstance(value, tuple):
        return tuple(scrub(v) for v in value)
    if isinstance(value, list):
        return [scrub(v) for v in value]
    if isinstance(value, dict):
        return {k: scrub(v) for k, v in value.items()}
    return value


class PrivacyFilter(logging.Filter):
    """Strip banned keys rather than dropping the record — a log is still useful."""

    def filter(self, record: logging.LogRecord) -> bool:
        for key in list(record.__dict__):
            if key.lower() in BANNED_FIELDS and _could_carry_a_coordinate(record.__dict__[key]):
                record.__dict__[key] = "<redacted>"
        # The message is assembled from msg % args by getMessage(), which the
        # loop above never touches — it only ever saw the extra fields.
        if isinstance(record.msg, str):
            record.msg = scrub(record.msg)
        if record.args:
            record.args = scrub(record.args)
        return True


class RequestIdFilter(logging.Filter):
    """Attach the in-flight request id to every record, from anywhere."""

    def filter(self, record: logging.LogRecord) -> bool:
        rid = request_id_var.get()
        if rid is not None:
            record.request_id = rid
        return True


class JsonFormatter(logging.Formatter):
    def format(self, record: logging.LogRecord) -> str:
        payload: dict[str, Any] = {
            "ts": datetime.fromtimestamp(record.created, tz=UTC).isoformat(),
            "level": record.levelname,
            "logger": record.name,
            "msg": record.getMessage(),
        }
        for key, value in record.__dict__.items():
            if key in _RESERVED or key.startswith("_"):
                continue
            try:
                json.dumps(value)
            except (TypeError, ValueError):
                value = repr(value)
            # Scrubbed here as well as in the filter, because a banned key is
            # not the only way a coordinate arrives: `extra={"start": 51.5074}`
            # uses a key nobody thought to ban, and reached the output intact.
            payload[key] = scrub(value)
        if record.exc_info:
            # A traceback is free text from anywhere in the process, including
            # libraries. It is the single most likely place for a coordinate to
            # appear without anyone here having chosen to log one.
            payload["exc"] = scrub(self.formatException(record.exc_info))
        # `ts` is excluded on purpose: an ISO timestamp ends in fractional
        # seconds, which are coordinate-shaped and would be redacted, and a log
        # line with no time on it is not worth the trade.
        return json.dumps(payload, separators=(",", ":"))


_configured = False


def configure_logging(level: str = "INFO") -> None:
    global _configured
    if _configured:
        return
    handler = logging.StreamHandler(sys.stdout)
    handler.setFormatter(JsonFormatter())
    handler.addFilter(RequestIdFilter())
    # Last, so it also sees anything the filters above added.
    handler.addFilter(PrivacyFilter())

    root = logging.getLogger()
    root.handlers.clear()
    root.addHandler(handler)
    root.setLevel(getattr(logging, level.upper(), logging.INFO))

    # uvicorn's access log echoes client IPs; we log our own request lines instead.
    logging.getLogger("uvicorn.access").disabled = True
    _configured = True


def get_logger(name: str) -> logging.LoggerAdapter | logging.Logger:
    return logging.getLogger(name)
