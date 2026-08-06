"""Record real upstream responses for the fixed test locations.

Run this once, with real keys, to replace the hand-built fixtures that ship with
the repo:

    MEANDER_FIXTURES=record python3 -m backend.record_fixtures --service graphhopper

It is deliberately conservative: it only requests the scenarios in
``scripts.make_synthetic_fixtures.SCENARIOS``, refuses to start if that would
exceed the remaining budget, and prints the cost before spending anything.
"""

from __future__ import annotations

import argparse
import asyncio
import sys

from . import fixtures as fx
from .config import TEST_LOCATIONS_BY_SLUG, settings
from .geometry import LatLon
from .logging_setup import configure_logging, get_logger
from .routing import GRAPHHOPPER_CREDIT_COST, route_accessible, route_fastest, route_nature

log = get_logger(__name__)

SERVICES = ("graphhopper", "nominatim", "enrichment")

# Overpass bans on sustained load. This is deliberately generous.
OVERPASS_PAUSE_S = 45


def _scenarios():
    from scripts.make_synthetic_fixtures import SCENARIOS

    return SCENARIOS


async def _record_graphhopper(force: bool) -> int:
    scenarios = _scenarios()
    budget = fx.get_budget()
    # Three presets per scenario, and nature may climb its ladder up to 3 rungs.
    worst_case = len(scenarios) * 5 * GRAPHHOPPER_CREDIT_COST
    remaining = budget.remaining("graphhopper")
    print(f"GraphHopper: {len(scenarios)} scenarios, worst case {worst_case} credits, "
          f"{remaining} remaining in the budget.")
    if remaining < worst_case:
        print("Not enough budget remaining for a full pass. Recording what fits; "
              "the rest stays on its existing fixture.")

    recorded = 0
    for scenario in scenarios:
        origin_loc = TEST_LOCATIONS_BY_SLUG[scenario.origin_slug]
        origin = LatLon(origin_loc.lat, origin_loc.lon)
        dest = None
        if scenario.destination_slug:
            d = TEST_LOCATIONS_BY_SLUG[scenario.destination_slug]
            dest = LatLon(d.lat, d.lon)

        fastest = None
        for name in ("fastest", "nature", "accessible"):
            if force:
                body_sig = _signature_for(origin, dest, scenario, name)
                fx.fixture_path("graphhopper", body_sig).unlink(missing_ok=True)
            try:
                if name == "fastest":
                    fastest = await route_fastest(origin, dest, scenario.minutes, scenario.mode)
                elif name == "nature":
                    await route_nature(origin, dest, scenario.minutes, scenario.mode, fastest)
                else:
                    await route_accessible(origin, dest, scenario.minutes, scenario.mode)
            # A recording run must survive one bad scenario: the point is to
            # capture as many fixtures as the budget allows in a single pass.
            except Exception as exc:  # noqa: BLE001 — an offline run must not abort part-way
                log.warning("record_failed", extra={"scenario": scenario.slug, "preset": name,
                                                    "error": type(exc).__name__})
                print(f"  ! {scenario.slug}/{name}: {type(exc).__name__}: {exc}")
                continue
            recorded += 1
            print(f"  + {scenario.slug}/{name}")
    return recorded


def _signature_for(origin: LatLon, dest: LatLon | None, scenario, preset: str) -> str:
    from .config import GRAPHHOPPER_URL
    from .routing import build_request_body

    body = build_request_body(origin, dest, scenario.minutes, scenario.mode, preset)
    return fx.signature("POST", GRAPHHOPPER_URL, json_body=body,
                        headers={"Content-Type": "application/json"})


async def _record_nominatim(force: bool) -> int:
    from .routing import geocode_search

    queries = [loc.name for loc in TEST_LOCATIONS_BY_SLUG.values()]
    recorded = 0
    for q in queries:
        try:
            results = await geocode_search(q)
        # One unresolvable place name must not abandon the remaining queries.
        except Exception as exc:  # noqa: BLE001 — an offline run must not abort part-way
            print(f"  ! {q}: {type(exc).__name__}: {exc}")
            continue
        recorded += 1
        print(f"  + {q} -> {len(results)} results")
        # Nominatim asks for at most one request per second.
        await asyncio.sleep(1.1)
    return recorded


async def _record_enrichment(force: bool) -> int:
    """Record the Overpass and Open-Meteo calls the request path actually makes.

    Recording them per-route would produce the wrong fixtures: enrichment runs
    once per request over the union of every route's geometry, so that is the
    query whose signature has to exist.
    """
    from .main import route_events
    from .models import Point, RouteRequest

    scenarios = _scenarios()
    recorded = 0
    for scenario in scenarios:
        origin_loc = TEST_LOCATIONS_BY_SLUG[scenario.origin_slug]
        request = RouteRequest(
            origin=Point(lat=origin_loc.lat, lon=origin_loc.lon),
            destination=(
                Point(
                    lat=TEST_LOCATIONS_BY_SLUG[scenario.destination_slug].lat,
                    lon=TEST_LOCATIONS_BY_SLUG[scenario.destination_slug].lon,
                )
                if scenario.destination_slug
                else None
            ),
            minutes=scenario.minutes,
            mode=scenario.mode,
        )
        try:
            # Drain the same generator the API serves from, so the fixtures
            # recorded are exactly the requests production makes.
            async for _event in route_events(request):
                pass
        # One scenario failing must not abandon the rest of the pass.
        except Exception as exc:  # noqa: BLE001 — an offline run must not abort part-way
            print(f"  ! {scenario.slug}: {type(exc).__name__}: {exc}", file=sys.stderr)
            continue

        print(f"  + {scenario.slug}")
        recorded += 1
        # Overpass rate-limits aggressively; give it room between queries.
        await asyncio.sleep(OVERPASS_PAUSE_S)
    return recorded


async def main_async(services: list[str], force: bool) -> int:
    configure_logging(settings.log_level)

    # Exactly `record`, not merely "not replay".
    #
    # `live` used to be accepted here and is what this repository's own .env
    # sets, which was fine while every mode persisted fixtures. It no longer
    # does — only `record` writes, because a deployed instance must not — so
    # running this under `live` would spend real API credits, report
    # "recorded N", and write nothing at all.
    if settings.fixture_mode != "record":
        print(
            f"MEANDER_FIXTURES is '{settings.fixture_mode}', and only 'record' writes "
            "fixtures. Under 'live' this would spend credits and save nothing; under "
            "'replay' it would do nothing at all.\n"
            "Re-run as:  MEANDER_FIXTURES=record python3 -m backend.record_fixtures",
            file=sys.stderr,
        )
        return 2

    if "graphhopper" in services and not settings.graphhopper_key:
        print("GRAPHHOPPER_KEY is not set — skipping GraphHopper. See BLOCKED.md #1.",
              file=sys.stderr)
        services = [s for s in services if s != "graphhopper"]

    total = 0
    if "graphhopper" in services:
        print("Recording GraphHopper…")
        total += await _record_graphhopper(force)
    if "nominatim" in services:
        print("Recording Nominatim…")
        total += await _record_nominatim(force)
    if "enrichment" in services:
        print("Recording enrichment (Overpass + Open-Meteo)…")
        total += await _record_enrichment(force)

    print(f"\nDone. {total} requests recorded.")
    print("Budget now:", fx.budget_snapshot())
    await fx.aclose_client()
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--service", action="append", choices=SERVICES,
                        help="record only this service; repeatable (default: all)")
    parser.add_argument("--force", action="store_true",
                        help="delete the existing fixture first, so it is re-recorded")
    args = parser.parse_args()
    return asyncio.run(main_async(list(args.service or SERVICES), args.force))


if __name__ == "__main__":
    sys.exit(main())
