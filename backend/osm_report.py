"""Barrier reporting to the OpenStreetMap **development** server.

Meander never writes to production OpenStreetMap. Reports go to
``api06.dev.openstreetmap.org``, whose data is disposable, and the host is
asserted at call time rather than only configured — a copy-paste that repointed
this at production would put junk into the map that everyone else relies on,
and a constant is not a strong enough guard for that.
"""

from __future__ import annotations

from urllib.parse import urlsplit

import httpx

from .config import OSM_DEV_API_URL
from .fixtures import BudgetExhausted, FixtureMissing, fetch
from .logging_setup import get_logger
from .models import BarrierReport

log = get_logger(__name__)

# The only host this module is ever permitted to write to.
PERMITTED_HOST = "api06.dev.openstreetmap.org"

NOTE_FOOTER = "\n\nReported via Meander (https://github.com/meander-routing/meander)."


class BarrierReportError(RuntimeError):
    def __init__(self, human_message: str, status_code: int = 502) -> None:
        self.human_message = human_message
        self.status_code = status_code
        super().__init__(human_message)


def assert_development_server(url: str) -> None:
    """Refuse to proceed unless the target is the OSM development server."""
    host = (urlsplit(url).hostname or "").lower()
    if host != PERMITTED_HOST:
        raise BarrierReportError(
            f"Refusing to write to {host!r}. Meander only ever writes to "
            f"{PERMITTED_HOST}, the OpenStreetMap development server.",
            status_code=500,
        )


def note_text(report: BarrierReport) -> str:
    kind = report.type.strip() or "barrier"
    return f"Accessibility barrier reported: {kind}. {report.description.strip()}{NOTE_FOOTER}"


async def submit_barrier(report: BarrierReport) -> int | None:
    """Create an OSM note on the development server. Returns its id if given."""
    url = f"{OSM_DEV_API_URL}/notes"
    assert_development_server(url)

    try:
        response = await fetch(
            "POST",
            url,
            params={
                "lat": round(report.lat, 6),
                "lon": round(report.lon, 6),
                "text": note_text(report),
            },
            headers={"Accept": "application/json"},
            cost=1,
            service="osm_dev",
        )
    except (FixtureMissing, BudgetExhausted) as exc:
        raise BarrierReportError(
            "Barrier reporting is not available on this server right now. "
            "Nothing was sent.",
            status_code=503,
        ) from exc
    except httpx.HTTPError as exc:
        log.warning("barrier_report_transport_error", extra={"error": type(exc).__name__})
        raise BarrierReportError(
            "Could not reach OpenStreetMap. Nothing was sent.", status_code=502
        ) from exc

    if response.status_code >= 400:
        log.warning("barrier_report_error", extra={"status": response.status_code})
        raise BarrierReportError(
            "OpenStreetMap rejected that report. Nothing was recorded.", status_code=502
        )

    try:
        payload = response.json()
    except ValueError:
        return None

    properties = payload.get("properties") if isinstance(payload, dict) else None
    if isinstance(properties, dict) and "id" in properties:
        try:
            return int(properties["id"])
        except (TypeError, ValueError):
            return None
    return None
