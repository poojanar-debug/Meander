"""Structured JSON logging to stdout.

Coordinates, IP addresses and user agents must never reach a log line. The
filter below is a backstop, not a licence to pass them in: it drops any record
whose extra fields use a banned key.
"""

from __future__ import annotations

import json
import logging
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


class PrivacyFilter(logging.Filter):
    """Strip banned keys rather than dropping the record — a log is still useful."""

    def filter(self, record: logging.LogRecord) -> bool:
        for key in list(record.__dict__):
            if key.lower() in BANNED_FIELDS and _could_carry_a_coordinate(record.__dict__[key]):
                record.__dict__[key] = "<redacted>"
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
            payload[key] = value
        if record.exc_info:
            payload["exc"] = self.formatException(record.exc_info)
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
