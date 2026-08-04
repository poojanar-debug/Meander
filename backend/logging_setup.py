"""Structured JSON logging to stdout.

Coordinates, IP addresses and user agents must never reach a log line. The
filter below is a backstop, not a licence to pass them in: it drops any record
whose extra fields use a banned key.
"""

from __future__ import annotations

import json
import logging
import sys
from datetime import UTC, datetime
from typing import Any

BANNED_FIELDS = frozenset(
    {"lat", "lon", "latitude", "longitude", "ip", "client_ip", "user_agent", "origin_coord"}
)

_RESERVED = frozenset(
    {
        "name", "msg", "args", "levelname", "levelno", "pathname", "filename",
        "module", "exc_info", "exc_text", "stack_info", "lineno", "funcName",
        "created", "msecs", "relativeCreated", "thread", "threadName",
        "processName", "process", "taskName", "message", "asctime",
    }
)


class PrivacyFilter(logging.Filter):
    """Strip banned keys rather than dropping the record — a log is still useful."""

    def filter(self, record: logging.LogRecord) -> bool:
        for key in list(record.__dict__):
            if key.lower() in BANNED_FIELDS:
                record.__dict__[key] = "<redacted>"
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
