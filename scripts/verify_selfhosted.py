"""Prove a self-hosted GraphHopper actually delivers what it was set up for.

    scripts/graphhopper.sh serve            # in one terminal
    python3 -m scripts.verify_selfhosted    # in another

Self-hosting exists for one reason: the hosted free tier cannot execute a
`custom_model`, so the nature and accessible presets come back blocked. This
checks the three things that have to be true for that to have been worth doing,
in every imported region:

1. all three presets route at all
2. their geometries are genuinely **different** — a custom model that is
   accepted but ignored returns the fastest route three times, which looks like
   success and is the exact failure the spec warns about
3. `smoothness` comes back in the path details, so the accessibility engine can
   apply the one hard constraint the hosted API could never give it

Exits non-zero if any of that fails, so it can gate a deploy.
"""

from __future__ import annotations

import asyncio
import sys
from dataclasses import dataclass

from backend.config import GRAPHHOPPER_URL, graphhopper_is_self_hosted, path_details
from backend.geometry import LatLon
from backend.routing import route_accessible, route_fastest, route_nature


@dataclass(frozen=True)
class Spot:
    name: str
    region: str
    point: LatLon
    minutes: int
    mode: str


# One per imported region, chosen to be somewhere a person would actually walk.
SPOTS = (
    Spot("Colombo Fort", "sri-lanka", LatLon(6.933727, 79.850080), 30, "foot"),
    Spot("Vondelpark, Amsterdam", "netherlands", LatLon(52.357197, 4.864119), 35, "foot"),
    Spot("Hyde Park, London", "great-britain", LatLon(51.507489, -0.162207), 35, "foot"),
    Spot("Princes Street, Edinburgh", "great-britain", LatLon(55.952326, -3.195041), 40, "foot"),
)


def _shape(route) -> tuple:
    return tuple((round(p.lat, 5), round(p.lon, 5)) for p in route.points)


async def check(spot: Spot) -> list[str]:
    failures: list[str] = []
    print(f"\n{spot.name}  ({spot.region}, {spot.minutes} min {spot.mode})")

    try:
        fastest = await route_fastest(spot.point, None, spot.minutes, spot.mode)
    except Exception as exc:  # noqa: BLE001 — a failure here is the result, not a crash
        print(f"  fastest     FAILED  {type(exc).__name__}: {exc}")
        return [f"{spot.name}: fastest did not route ({type(exc).__name__})"]

    routes = {"fastest": fastest}
    for name, fn in (("nature", route_nature), ("accessible", route_accessible)):
        try:
            routes[name] = (
                await fn(spot.point, None, spot.minutes, spot.mode, fastest.duration_min)
                if name == "nature"
                else await fn(spot.point, None, spot.minutes, spot.mode)
            )
        except Exception as exc:  # noqa: BLE001
            print(f"  {name:<11} FAILED  {type(exc).__name__}: {exc}")
            failures.append(f"{spot.name}: {name} did not route ({type(exc).__name__})")

    for name, r in routes.items():
        detail_keys = sorted(r.details)
        print(f"  {name:<11} {r.duration_min:6.1f} min {r.distance_m:8.0f} m  "
              f"{len(r.points):4d} pts  details={detail_keys}")

    # The one that matters: a custom model that is accepted but ignored returns
    # the fastest route under every preset, with no error anywhere.
    shapes = {name: _shape(r) for name, r in routes.items()}
    if len(routes) == 3 and len(set(shapes.values())) < 3:
        same = [n for n in shapes if shapes[n] == shapes["fastest"] and n != "fastest"]
        print(f"  !! IDENTICAL to fastest: {', '.join(same)} — custom model had no effect")
        failures.append(f"{spot.name}: {', '.join(same)} identical to fastest")
    elif len(routes) == 3:
        print("  ok: all three geometries differ")

    if "smoothness" in path_details() and "smoothness" not in fastest.details:
        print("  !! smoothness requested but absent from the response")
        failures.append(f"{spot.name}: no smoothness in path details")

    return failures


async def main_async() -> int:
    print(f"Routing endpoint : {GRAPHHOPPER_URL}")
    print(f"Self-hosted      : {graphhopper_is_self_hosted()}")
    print(f"Path details     : {', '.join(path_details())}")

    if not graphhopper_is_self_hosted():
        print(
            "\nThis is the hosted API. The nature and accessible presets cannot run "
            "there — set MEANDER_GRAPHHOPPER_URL to your own server first.",
            file=sys.stderr,
        )
        return 2

    failures: list[str] = []
    for spot in SPOTS:
        failures.extend(await check(spot))

    from backend.fixtures import aclose_client

    await aclose_client()

    print()
    if failures:
        print(f"FAILED — {len(failures)} problem(s):")
        for f in failures:
            print(f"  - {f}")
        return 1
    print(f"All {len(SPOTS)} locations: three distinct routes, smoothness present.")
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main_async()))
