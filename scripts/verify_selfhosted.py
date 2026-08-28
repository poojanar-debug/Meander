"""Prove a self-hosted GraphHopper actually delivers what it was set up for.

    scripts/graphhopper.sh serve            # in one terminal
    python3 -m scripts.verify_selfhosted    # in another

Self-hosting exists for one reason: the hosted free tier cannot execute a
`custom_model`, so every preset except `fastest` comes back blocked. This checks
the three things that have to be true for that to have been worth doing, in
every region the running graph actually contains — locations outside it are
skipped and named, because which region set was built is an operator's choice
rather than a defect:

1. the presets route at all — where `accessible` alone may instead return no
   route, because hard constraints are allowed to reject a start and the
   README's preset table promises exactly that. Any other preset failing to
   route is a failure here.
2. the custom models actually steer. A model that is accepted but ignored
   returns the fastest route's exact geometry under **every** label, so the
   failure is every steered preset collapsing onto `fastest` at once. A
   *single* preset landing on the fastest line is reported but is not a
   failure — Central Park's loop is already step-free, smooth and tree-lined,
   so `accessible` and `shade` have nothing to improve there and honestly say
   so — and two preference presets matching *each other* never was one: a
   graph with no tunnel near the origin answers `quiet` and `air` identically,
   and is right to.
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
from backend.routing import PRESETS, NoRouteFound


@dataclass(frozen=True)
class Spot:
    name: str
    region: str
    point: LatLon
    minutes: int
    mode: str


# Somewhere a person would actually walk, in each region a region set might
# import.
#
# ⚠ `region` is the Geofabrik extract these coordinates fall in, which is **not**
# the same as what is built. The `demo` set imports bounding boxes around the
# five demo locations — for Britain that is Greater London and nothing else —
# while `countries` imports Great Britain entire and `custom` adds city boxes
# across the US and Europe. Edinburgh sat in exactly that gap for a year: it
# routes under `countries` and the expanded `custom`, and does not exist under
# `demo`.
#
# This used to be a straight list, with Edinburgh labelled `great-britain` and
# checked unconditionally, so running it against a `demo` graph reported a
# failure that was really a question nobody had asked the graph. Which set is
# built is now read from the router rather than assumed — see `covers()`.
#
# The four newest rows are one per corner of the expansion: two US coasts,
# and the two European cities the old graph was told about most often — Paris
# being the example backend/coverage.py itself uses for "inside the union
# rectangle, inside none of the boxes". Against a demo or countries graph all
# four skip, which is the covers() mechanism doing its job.
#
# Berlin is the Brandenburg Gate rather than the middle of the Tiergarten,
# and the difference was measured, not aesthetic: from the park's interior
# `accessible` returns no route at all — the paths the point snaps to fail a
# hard constraint, which is a first-class answer for the app and a poor spot
# for a script whose job is to exercise all six presets' *routing* path.
SPOTS = (
    Spot("Colombo Fort", "sri-lanka", LatLon(6.933727, 79.850080), 30, "foot"),
    Spot("Vondelpark, Amsterdam", "netherlands", LatLon(52.357197, 4.864119), 35, "foot"),
    Spot("Hyde Park, London", "great-britain", LatLon(51.507489, -0.162207), 35, "foot"),
    Spot("Princes Street, Edinburgh", "great-britain", LatLon(55.952326, -3.195041), 40, "foot"),
    Spot("Central Park, New York", "us/new-york", LatLon(40.781200, -73.966500), 35, "foot"),
    Spot("Golden Gate Park, SF", "us/california", LatLon(37.769400, -122.486200), 35, "foot"),
    Spot("Jardin du Luxembourg, Paris", "france", LatLon(48.846200, 2.337200), 35, "foot"),
    Spot("Brandenburg Gate, Berlin", "germany", LatLon(52.516300, 13.377700), 35, "foot"),
)


async def covers(spot: Spot) -> bool:
    """Whether the graph that is actually running claims this point.

    Asks the router's own /info bbox, via the same coverage module the API uses,
    so this cannot drift from what a user would be told. A spot outside it is
    skipped rather than failed: "you did not import Scotland" is a fact about
    the region set, not a defect in the router.

    The bbox is a union and therefore an over-estimate — a point inside it is
    not promised to route. That asymmetry is the right way round here. Skipping
    is driven by a *certain* negative, and anything that survives the check and
    then fails is a real failure worth reporting.
    """
    from backend.coverage import outside_coverage

    return await outside_coverage(spot.point.lat, spot.point.lon) is None


def _shape(route) -> tuple:
    return tuple((round(p.lat, 5), round(p.lon, 5)) for p in route.points)


async def check(spot: Spot) -> list[str]:
    failures: list[str] = []
    print(f"\n{spot.name}  ({spot.region}, {spot.minutes} min {spot.mode})")

    try:
        fastest = await PRESETS["fastest"](spot.point, None, spot.minutes, spot.mode)
    except Exception as exc:  # noqa: BLE001 — a failure here is the result, not a crash
        print(f"  fastest     FAILED  {type(exc).__name__}: {exc}")
        return [f"{spot.name}: fastest did not route ({type(exc).__name__})"]

    routes = {"fastest": fastest}
    for name, fn in PRESETS.items():
        if name == "fastest":
            continue
        try:
            # scenic is the only preset that takes the baseline: it derives both
            # its duration cap and its greenness floor from it.
            routes[name] = (
                await fn(spot.point, None, spot.minutes, spot.mode, fastest)
                if name == "scenic"
                else await fn(spot.point, None, spot.minutes, spot.mode)
            )
        except NoRouteFound as exc:
            if name == "accessible":
                # The one preset for which "no route" is an answer rather than
                # an error: hard constraints are allowed to reject a start —
                # from the middle of the Tiergarten they do — and the README's
                # preset table promises exactly that behaviour.
                print(f"  {name:<11} blocked — hard constraints reject this "
                      "start; a first-class answer")
            else:
                print(f"  {name:<11} FAILED  NoRouteFound: {exc}")
                failures.append(f"{spot.name}: {name} did not route (NoRouteFound)")
        except Exception as exc:  # noqa: BLE001
            print(f"  {name:<11} FAILED  {type(exc).__name__}: {exc}")
            failures.append(f"{spot.name}: {name} did not route ({type(exc).__name__})")

    for name, r in routes.items():
        detail_keys = sorted(r.details)
        print(f"  {name:<11} {r.duration_min:6.1f} min {r.distance_m:8.0f} m  "
              f"{len(r.points):4d} pts  details={detail_keys}")

    # The one that matters: a custom model that is accepted but ignored returns
    # the fastest route under EVERY preset, with no error anywhere — so that
    # collapse, all steered geometries landing on the fastest line at once, is
    # the failure. One preset matching fastest at one spot is reported but not
    # failed: it is what an honest model does where there is nothing to
    # improve — Central Park's loop is already step-free and tree-lined, and
    # `accessible` and `shade` rightly have nothing to move. This check used to
    # fail any single match, which was calibrated on two dense European parks
    # and read honest indifference as a dead model the day the graph grew a
    # third continent.
    #
    # Compared against fastest only. Requiring all six to differ from each other
    # would fail an honest graph: without a tunnel near the origin there is
    # nothing for `air` and `shade` to disagree about, and they may legitimately
    # land on the same line.
    shapes = {name: _shape(r) for name, r in routes.items()}
    steered = [n for n in shapes if n != "fastest"]
    same = [n for n in steered if shapes[n] == shapes["fastest"]]
    if steered and len(same) == len(steered):
        print("  !! ALL steered presets identical to fastest — custom models had no effect")
        failures.append(f"{spot.name}: every steered preset identical to fastest")
    elif same:
        print(f"  note: identical to fastest here: {', '.join(same)} "
              f"({len(steered) - len(same)} others differ, so the models are running)")
    elif len(steered) == len(PRESETS) - 1:
        print(f"  ok: all {len(steered)} steered geometries differ from fastest")

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
            "\nThis is the hosted API. Every preset except fastest carries a custom "
            "model and cannot run there — set MEANDER_GRAPHHOPPER_URL to your own "
            "server first.",
            file=sys.stderr,
        )
        return 2

    failures: list[str] = []
    checked = 0
    skipped: list[str] = []
    for spot in SPOTS:
        if not await covers(spot):
            skipped.append(spot.name)
            print(f"\n{spot.name}  ({spot.region}, {spot.minutes} min {spot.mode})")
            print("  skipped: outside the graph this server has built")
            continue
        checked += 1
        failures.extend(await check(spot))

    from backend.fixtures import aclose_client

    await aclose_client()

    print()
    if skipped:
        # Semicolons, not commas: the names contain commas ("Hyde Park, London"),
        # so a comma-joined list of four reads as seven.
        print(f"Skipped {len(skipped)}, outside the built graph: {'; '.join(skipped)}")

    # A run that verified nothing must not report success. With every spot
    # skipped the loop above would otherwise fall through to "All 0 locations",
    # which is the shape of green that hides an empty graph.
    #
    # Checked before the reassuring note below, because "not a failure" is true
    # of *some* spots being skipped and false of all of them.
    if not checked:
        print(
            "FAILED — every location was skipped, so nothing was verified. "
            "Is the router serving the graph you think it is?",
            file=sys.stderr,
        )
        return 1

    if skipped:
        print("  Not a failure. Build --region-set custom (or countries) to include them.")

    if failures:
        print(f"FAILED — {len(failures)} problem(s):")
        for f in failures:
            print(f"  - {f}")
        return 1
    print(f"All {checked} checked locations passed: the presets steer and smoothness is present.")
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main_async()))
