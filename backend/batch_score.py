"""Offline cache pre-warm. **Never called from a request.**

Fetches Mapillary imagery along the routes for the fixed test locations, scores
each sample point with CLIP, and writes the results to ``data/cache.db`` — the
file the 512 MB deployment reads instead of running torch.

    MEANDER_FIXTURES=record python3 -m backend.batch_score --location hyde-park-london

Then commit ``data/cache.db``. Regions you have not pre-warmed still work; they
come back as ``scoring_method: "geometry_only"`` with the response saying so.
"""

from __future__ import annotations

import argparse
import asyncio
import sys

from . import fixtures as fx
from .cache import get_cache
from .config import TEST_LOCATIONS, TEST_LOCATIONS_BY_SLUG, settings
from .geometry import LatLon, sample_every
from .logging_setup import configure_logging, get_logger
from .routing import route_fastest, route_nature
from .scoring import (
    ACTIVE_PROMPT_VARIANT,
    MAX_SAMPLE_POINTS,
    PROMPT_VARIANTS,
    SAMPLE_SPACING_M,
    ScoringUnavailable,
    score_point,
    torch_available,
)

log = get_logger(__name__)


async def _points_for_location(slug: str, minutes: int) -> list[LatLon]:
    """Sample points along the fastest and nature routes from a test location.

    Both, because the two presets take different streets and pre-warming only
    one leaves the other permanently on geometry-only scoring.
    """
    location = TEST_LOCATIONS_BY_SLUG[slug]
    origin = LatLon(location.lat, location.lon)

    collected: list[LatLon] = []
    for name, router in (("fastest", route_fastest), ("nature", route_nature)):
        try:
            route = await router(origin, None, minutes, "foot")
        # A location that will not route is a reason to skip it, not to abandon
        # the whole run — the next location may be fine.
        except Exception as exc:  # noqa: BLE001 — an offline run must not abort part-way
            log.warning("batch_route_failed",
                        extra={"location": slug, "preset": name, "error": type(exc).__name__})
            print(f"  ! {slug}/{name}: {type(exc).__name__}: {exc}", file=sys.stderr)
            continue
        collected.extend(s.point for s in sample_every(route.points, SAMPLE_SPACING_M,
                                                       MAX_SAMPLE_POINTS))

    # Deduplicate to the cache's own grid, so two routes sharing a street do not
    # pay for the same imagery twice.
    seen: dict[tuple[float, float], LatLon] = {}
    for p in collected:
        seen.setdefault((round(p.lat, 4), round(p.lon, 4)), p)
    return list(seen.values())


async def run(slugs: list[str], minutes: int, variant: str, dry_run: bool) -> int:
    configure_logging(settings.log_level)

    if not torch_available():
        print(
            "torch and open-clip-torch are not installed in this environment.\n"
            "That is correct for the deployed build and wrong for this script:\n"
            "  pip install -r backend/requirements.txt",
            file=sys.stderr,
        )
        return 2
    if settings.fixture_mode == "replay":
        print(
            "MEANDER_FIXTURES is 'replay', so no imagery can be fetched.\n"
            "Re-run as:  MEANDER_FIXTURES=record python3 -m backend.batch_score",
            file=sys.stderr,
        )
        return 2
    if not settings.mapillary_token:
        print("MAPILLARY_TOKEN is not set. See BLOCKED.md #2.", file=sys.stderr)
        return 2

    cache = get_cache()
    budget = fx.get_budget()
    total_scored = 0
    total_empty = 0

    for slug in slugs:
        points = await _points_for_location(slug, minutes)
        print(f"{slug}: {len(points)} sample points "
              f"({budget.remaining('mapillary')} Mapillary calls left)")
        if dry_run:
            continue

        for i, point in enumerate(points, 1):
            if budget.remaining("mapillary") <= 0:
                print("  Mapillary budget exhausted; stopping cleanly.", file=sys.stderr)
                break
            try:
                score, count = await score_point(point, cache, variant)
            # One point failing must not lose the points already scored: every
            # successful point is written to the cache as it goes.
            except ScoringUnavailable as exc:
                log.info("point_skipped", extra={"reason": type(exc).__name__})
                continue
            if score is None:
                total_empty += 1
            else:
                total_scored += 1
            if i % 10 == 0:
                print(f"  {i}/{len(points)} — {total_scored} scored, {total_empty} without imagery")

    print(f"\nDone. {total_scored} points scored, {total_empty} had too little imagery.")
    print(f"Cache now holds {cache.segment_count()} segments "
          f"({cache.clip_segment_count()} from CLIP).")
    print("Commit data/cache.db to ship these scores with the deployment.")
    await fx.aclose_client()
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--location", action="append", choices=[loc.slug for loc in TEST_LOCATIONS],
        help="test location slug; repeatable (default: all)",
    )
    parser.add_argument("--minutes", type=int, default=35)
    parser.add_argument("--variant", default=ACTIVE_PROMPT_VARIANT, choices=sorted(PROMPT_VARIANTS))
    parser.add_argument("--dry-run", action="store_true",
                        help="report how many points would be scored, and spend nothing")
    args = parser.parse_args()

    slugs = args.location or [loc.slug for loc in TEST_LOCATIONS]
    return asyncio.run(run(slugs, args.minutes, args.variant, args.dry_run))


if __name__ == "__main__":
    sys.exit(main())
