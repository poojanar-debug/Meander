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

import json
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Literal

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
        f"world's map loaded ({extent.describe()}), and your starting point is "
        "outside it. Nothing you did caused this, and moving a little will not help."
    )


_REGION_MANIFEST = "regions.manifest.json"
_regions_cache: tuple[Coverage, ...] | None | Literal[False] = False


def _manifest_paths() -> tuple[Path, ...]:
    """Where the per-region boxes might be, in the two places this code runs."""
    return (
        # Inside the API image, put there by the Dockerfile's COPY.
        Path("/app/graphhopper") / _REGION_MANIFEST,
        # A developer or a test running from the repo.
        Path(__file__).resolve().parents[1] / "graphhopper" / _REGION_MANIFEST,
    )


def reset_region_cache() -> None:
    """For tests. The manifest is a build artefact and does not change at run time."""
    global _regions_cache
    _regions_cache = False


def region_boxes() -> tuple[Coverage, ...] | None:
    """The boxes actually imported, or None when nothing recorded them.

    Written by `scripts/graphhopper.sh setup` and committed, because the graph
    lives on the router's disk in a different container and GraphHopper exposes
    no per-region endpoint. Absence is a legitimate state — a graph built before
    this existed, or by hand — and it must degrade to the hedged wording rather
    than to a guess.
    """
    global _regions_cache
    if _regions_cache is not False:
        return _regions_cache

    _regions_cache = None
    for path in _manifest_paths():
        try:
            raw = json.loads(path.read_text())
        except (OSError, ValueError):
            continue
        boxes: list[Coverage] = []
        for entry in raw.get("regions") or []:
            bbox = entry.get("bbox")
            if isinstance(bbox, list | tuple) and len(bbox) >= 4:
                try:
                    boxes.append(Coverage(*(float(v) for v in bbox[:4])))
                except (TypeError, ValueError):
                    continue
        if boxes:
            _regions_cache = tuple(boxes)
            log.info("region_manifest_loaded", extra={"regions": len(boxes)})
        break
    return _regions_cache


def inside_an_imported_region(lat: float, lon: float) -> bool | None:
    """True, False, or None when there is no manifest to ask.

    ⚠ A box here is the *cut* box, and osmium's complete-ways extraction keeps
    ways that cross the boundary — so the imported extent slightly overruns it.
    Measured on this deployment: the cut union is (-0.65, 6.43, 80.35, 52.86)
    while the router reports (-1.449894, 6.379104, 80.389202, 54.991951). A
    point just outside a box can therefore still route.

    That asymmetry is why this is used only to explain a failure the router has
    already returned, and never as a pre-flight test. Refusing a request because
    a point falls outside a cut box would refuse points that route.
    """
    boxes = region_boxes()
    if boxes is None:
        return None
    return any(box.contains(lat, lon) for box in boxes)


def unroutable_point_message(extent: Coverage, lat: float | None = None,
                             lon: float | None = None) -> str:
    """For a point *inside* the bounding box that the router still cannot snap.

    The bbox is a union, and this is where that matters. The `demo` region set
    is three separate extracts whose union spans Sri Lanka to Britain, so Paris,
    Berlin and most of Europe sit inside the rectangle and inside none of the
    boxes. They reach the router, GraphHopper says "Cannot find point", and the
    old translation told the user to move their start a little — the precise
    sentence coverage.py was written to stop, arriving by the one path the
    pre-flight check cannot see.

    Two things produce "Cannot find point" on a finite graph: an area that was
    never imported, and a genuinely unroutable spot inside one that was, like
    the middle of the Serpentine. This used to name both and let the reader
    decide, because /info reports only the union and asserting either would have
    been a guess presented as a fact.

    **It can now tell them apart, when a region manifest exists.** The boxes are
    written at build time by `scripts/graphhopper.sh` and committed; with them,
    a point in none of them gets the definite answer, and a point inside one
    gets the other definite answer. Without them — an older graph, or one built
    by hand — the hedged sentence is still what gets said, because the hedge was
    never dishonest, only unhelpful.
    """
    inside = None if lat is None or lon is None else inside_an_imported_region(lat, lon)

    if inside is False:
        return (
            "Meander does not cover that area yet. This server has only part of the "
            f"world's map loaded ({extent.describe()}), and not all of it even inside "
            "that, and this area is not one of the parts. Nothing you did caused "
            "this, and moving a little will not help."
        )
    if inside is True:
        return (
            "This area is on the map, but no path was found close enough to that "
            "exact spot. Try moving the start a little."
        )
    return (
        "No routable path was found near that point. This server has only part of "
        f"the world's map loaded ({extent.describe()}), and not all of it even "
        "inside that, so either this area is not included yet, or there is no "
        "path close enough to that exact spot. Nothing you did caused this."
    )
