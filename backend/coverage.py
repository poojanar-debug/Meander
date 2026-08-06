"""What this deployment can actually route, and how to say when it cannot.

Self-hosting made coverage finite. A graph built from the `demo` region set is
three bounding boxes; `countries` is three countries. Either way, most of the
planet is outside it, and GraphHopper's answer for a point outside the graph is
``"Cannot find point 0: 48.85,2.35"`` — which routing.py has always translated
into *"No routable road or path was found near that point. Try moving the start
a little."*

That is the wrong thing to say, and wrong in the worst direction: it blames the
user's choice of street corner for a decision the operator made about how much
of the world to import, and it invites them to try again a hundred metres away,
which will fail identically. Somebody in Paris could reasonably conclude the app
is broken rather than that Paris is not included.

So the router is asked what it knows, once, and a point outside that box gets
told the truth: Meander does not cover that area yet, and here is what it does.
"""

from __future__ import annotations

import time
from dataclasses import dataclass

import httpx

from . import config
from .config import HTTP_CONNECT_TIMEOUT_S, graphhopper_is_self_hosted
from .logging_setup import get_logger

log = get_logger(__name__)

# The graph does not change while the server is up, so this could be cached for
# ever. An hour is a compromise with the case where it *has* changed because
# somebody rebuilt and restarted the router behind us.
INFO_TTL_S = 3600.0
INFO_TIMEOUT_S = min(5.0, HTTP_CONNECT_TIMEOUT_S)


@dataclass(frozen=True)
class Coverage:
    """The routable extent, as GraphHopper reports it."""

    min_lon: float
    min_lat: float
    max_lon: float
    max_lat: float

    def contains(self, lat: float, lon: float) -> bool:
        return self.min_lat <= lat <= self.max_lat and self.min_lon <= lon <= self.max_lon

    def describe(self) -> str:
        """A bounding box in words. Deliberately vague about the interior.

        ⚠ A bbox is an **over**-estimate of coverage, not an under-estimate: the
        `demo` region set is three separate boxes, and its overall bbox spans
        from Sri Lanka to Britain, most of which is empty. So this is only ever
        used to explain a point that is *outside* — where the answer is certain
        — and never to promise that a point inside will route.
        """
        return (
            f"roughly {abs(self.min_lat):.0f}°{'N' if self.min_lat >= 0 else 'S'} to "
            f"{abs(self.max_lat):.0f}°{'N' if self.max_lat >= 0 else 'S'}, "
            f"{abs(self.min_lon):.0f}°{'E' if self.min_lon >= 0 else 'W'} to "
            f"{abs(self.max_lon):.0f}°{'E' if self.max_lon >= 0 else 'W'}"
        )


_cached: tuple[Coverage | None, float] | None = None


def reset_cache() -> None:
    """Test hook."""
    global _cached
    _cached = None


def info_url() -> str:
    from urllib.parse import urlsplit

    split = urlsplit(config.GRAPHHOPPER_URL)
    return f"{split.scheme}://{split.netloc}/info"


async def routable_extent(now: float | None = None) -> Coverage | None:
    """The graph's bounding box, or None when it cannot be established.

    None is the honest answer for the hosted API, which routes the planet and
    has no such limit, and for a self-hosted server that will not say. Callers
    must treat None as "no claim", never as "not covered".
    """
    global _cached
    now = time.monotonic() if now is None else now

    if not graphhopper_is_self_hosted():
        return None

    if _cached is not None and (now - _cached[1]) < INFO_TTL_S:
        return _cached[0]

    extent: Coverage | None = None
    try:
        async with httpx.AsyncClient(timeout=INFO_TIMEOUT_S) as client:
            response = await client.get(info_url())
        if response.status_code < 400:
            bbox = (response.json() or {}).get("bbox")
            if isinstance(bbox, list | tuple) and len(bbox) >= 4:
                extent = Coverage(*(float(v) for v in bbox[:4]))
    except (httpx.HTTPError, ValueError, TypeError) as exc:
        log.info("coverage_unknown", extra={"error": type(exc).__name__})

    _cached = (extent, now)
    return extent


async def outside_coverage(lat: float, lon: float) -> Coverage | None:
    """The extent, if this point is demonstrably outside it. None otherwise.

    Returning the extent rather than a bare True is what lets the caller say
    what *is* covered, which is the difference between "no" and "not here, but
    here".
    """
    extent = await routable_extent()
    if extent is None or extent.contains(lat, lon):
        return None
    return extent


def message(extent: Coverage) -> str:
    return (
        "Meander does not cover that area yet. This server has only part of the "
        f"world's map loaded — {extent.describe()} — and your starting point is "
        "outside it. Nothing you did caused this, and moving a little will not help."
    )


def unroutable_point_message(extent: Coverage) -> str:
    """For a point *inside* the bounding box that the router still cannot snap.

    The bbox is a union, and this is where that matters. The `demo` region set
    is three separate extracts whose union spans Sri Lanka to Britain, so Paris,
    Berlin and most of Europe sit inside the rectangle and inside none of the
    boxes. They reach the router, GraphHopper says "Cannot find point", and the
    old translation told the user to move their start a little — the precise
    sentence coverage.py was written to stop, arriving by the one path the
    pre-flight check cannot see.

    ⚠ **This deliberately does not claim which cause it is.** Two things produce
    "Cannot find point" on a finite graph — an area that was never imported, and
    a genuinely unroutable spot inside one that was, like the middle of the
    Serpentine — and the API cannot tell them apart, because /info reports only
    the union. Asserting either would be a guess presented as a fact, which is
    the habit this project exists not to have. So it names both and lets the
    reader decide which applies to where they are standing.

    Establishing the truth properly needs per-region boxes, which GraphHopper
    does not expose; `scripts/graphhopper.sh regions` has them, on the router's
    disk, in a different container from the API. BLOCKED.md records it.
    """
    return (
        "No routable path was found near that point. This server has only part of "
        f"the world's map loaded — {extent.describe()}, and not all of it even "
        "inside that — so either this area is not included yet, or there is no "
        "path close enough to that exact spot. Nothing you did caused this."
    )
