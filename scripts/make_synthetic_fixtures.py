"""Generate hand-built GraphHopper fixtures so the app runs without an API key.

This exists because no ``GRAPHHOPPER_KEY`` was available when the project was
built (BLOCKED.md #1). It produces responses in GraphHopper's real schema with
plausible geometry, so every parsing, scoring and accessibility path is
exercised end to end — but **every fixture it writes is stamped
``"_meander_provenance": "synthetic"``**, and any route derived from one is
forced to ``scoring_method: "placeholder"`` with ``synthetic_upstream: true`` in
the API response. Nothing here is ever presented as a measurement.

Replace them with the real thing:

    MEANDER_FIXTURES=record python3 -m backend.record_fixtures

Run:

    python3 -m scripts.make_synthetic_fixtures [--force]
"""

from __future__ import annotations

import argparse
import asyncio
import hashlib
import json
import math
import random
import sys
from dataclasses import dataclass
from typing import Any

import httpx

from backend import fixtures as fx
from backend.config import FIXTURE_DIR, GRAPHHOPPER_URL, TEST_LOCATIONS_BY_SLUG
from backend.geometry import LatLon, haversine_m, path_length_m
from backend.models import EffectiveMode
from backend.routing import build_request_body, route_accessible, route_fastest, route_nature

# Metres per second, used to turn a synthetic distance into a synthetic duration.
SPEED_M_S: dict[str, float] = {"foot": 1.35, "bike": 4.2, "car": 9.0}

# How far the preset bows away from the straight line, as a fraction of the
# straight-line distance. This is what makes the three presets measurably
# different geometries rather than three copies of the same one.
BOW_FRACTION: dict[str, float] = {"fastest": 0.03, "nature": 0.34, "accessible": 0.13}

# Realistic tag mixes per preset. "MISSING" is included on purpose: most of the
# world is untagged, and the accessibility engine has to cope with that.
DETAIL_MIX: dict[str, dict[str, list[tuple[str, float]]]] = {
    "fastest": {
        "road_class": [("PRIMARY", 0.35), ("SECONDARY", 0.3), ("RESIDENTIAL", 0.25),
                       ("FOOTWAY", 0.1)],
        "surface": [("ASPHALT", 0.6), ("PAVING_STONES", 0.15), ("MISSING", 0.25)],
        "road_environment": [("ROAD", 0.92), ("BRIDGE", 0.08)],
    },
    "nature": {
        "road_class": [("FOOTWAY", 0.3), ("PATH", 0.3), ("TRACK", 0.15),
                       ("RESIDENTIAL", 0.15), ("PEDESTRIAN", 0.1)],
        "surface": [("COMPACTED", 0.25), ("GROUND", 0.2), ("ASPHALT", 0.2),
                    ("FINE_GRAVEL", 0.1), ("MISSING", 0.25)],
        "road_environment": [("ROAD", 0.95), ("BRIDGE", 0.05)],
    },
    "accessible": {
        "road_class": [("FOOTWAY", 0.4), ("RESIDENTIAL", 0.3), ("PEDESTRIAN", 0.2),
                       ("SECONDARY", 0.1)],
        "surface": [("ASPHALT", 0.4), ("PAVING_STONES", 0.25), ("CONCRETE", 0.1),
                    ("MISSING", 0.25)],
        "road_environment": [("ROAD", 1.0)],
    },
}


@dataclass(frozen=True)
class Scenario:
    slug: str
    origin_slug: str
    destination_slug: str | None
    minutes: int
    mode: EffectiveMode
    # Preset -> whether the router should fail to find a route at all.
    unroutable: tuple[str, ...] = ()
    # Preset -> extra segments with known-bad tags, so the accessibility engine
    # has something real to reject.
    known_bad: tuple[str, ...] = ()


SCENARIOS: tuple[Scenario, ...] = (
    Scenario("colombo-walk", "colombo-fort", "viharamahadevi", 25, "foot"),
    Scenario("hyde-park-loop", "hyde-park-london", None, 35, "foot"),
    Scenario("euston-to-hyde", "euston-road-london", "hyde-park-london", 40, "foot",
             known_bad=("accessible",)),
    Scenario("vondelpark-loop", "amsterdam-vondelpark", None, 60, "bike"),
    Scenario("colombo-loop", "colombo-fort", None, 30, "foot",
             unroutable=("accessible",)),
    Scenario("colombo-drive", "colombo-fort", "viharamahadevi", 150, "car"),
)


def _seed_for(scenario: Scenario, preset: str) -> int:
    """A seed that is the same on every machine and every run.

    Python salts `hash()` of a string per process, so seeding from it made this
    generator produce different geometry every time it ran — which defeats the
    point of committing the fixtures, and silently invalidates every enrichment
    fixture keyed on the resulting bounding box.
    """
    digest = hashlib.sha256(f"{scenario.slug}/{preset}".encode()).digest()
    return int.from_bytes(digest[:4], "big")


def _offset(p: LatLon, north_m: float, east_m: float) -> LatLon:
    dlat = north_m / 111_320.0
    dlon = east_m / (111_320.0 * max(0.1, math.cos(math.radians(p.lat))))
    return LatLon(p.lat + dlat, p.lon + dlon)


def _bezier(a: LatLon, control: LatLon, b: LatLon, n: int) -> list[LatLon]:
    pts = []
    for i in range(n):
        t = i / (n - 1)
        u = 1 - t
        pts.append(
            LatLon(
                u * u * a.lat + 2 * u * t * control.lat + t * t * b.lat,
                u * u * a.lon + 2 * u * t * control.lon + t * t * b.lon,
            )
        )
    return pts


def _jitter(points: list[LatLon], rng: random.Random, metres: float) -> list[LatLon]:
    """Nudge interior vertices so the line looks like a street network, not a curve."""
    out = [points[0]]
    for p in points[1:-1]:
        out.append(_offset(p, rng.uniform(-metres, metres), rng.uniform(-metres, metres)))
    out.append(points[-1])
    return out


def _a_to_b(origin: LatLon, dest: LatLon, preset: str, rng: random.Random) -> list[LatLon]:
    straight = haversine_m(origin, dest)
    mid = LatLon((origin.lat + dest.lat) / 2, (origin.lon + dest.lon) / 2)

    # Perpendicular to the origin->dest axis, in metres.
    dlat_m = (dest.lat - origin.lat) * 111_320.0
    dlon_m = (dest.lon - origin.lon) * 111_320.0 * math.cos(math.radians(origin.lat))
    norm = math.hypot(dlat_m, dlon_m) or 1.0
    perp_north, perp_east = -dlon_m / norm, dlat_m / norm

    bow = straight * BOW_FRACTION[preset]
    # Presets bow to opposite sides so their geometries are visibly distinct.
    if preset == "accessible":
        bow = -bow
    control = _offset(mid, perp_north * bow * 2, perp_east * bow * 2)

    n = max(24, min(90, int(straight / 45)))
    return _jitter(_bezier(origin, control, dest, n), rng, 6.0)


def _loop(origin: LatLon, target_distance_m: float, preset: str,
          rng: random.Random) -> list[LatLon]:
    """A closed loop through the origin, roughly ``target_distance_m`` long."""
    lobes = {"fastest": 0.0, "nature": 3.0, "accessible": 0.0}[preset]
    wobble = {"fastest": 0.06, "nature": 0.22, "accessible": 0.03}[preset]
    radius = target_distance_m / (2 * math.pi)
    start_bearing = math.radians({"fastest": 20.0, "nature": 95.0, "accessible": 200.0}[preset])
    centre = _offset(origin, radius * math.cos(start_bearing), radius * math.sin(start_bearing))

    n = 72
    pts: list[LatLon] = []
    for i in range(n + 1):
        theta = 2 * math.pi * i / n
        shape = math.sin(lobes * theta) if lobes else math.sin(theta)
        r = radius * (1 + wobble * shape)
        # Start and finish exactly at the origin's bearing from the centre.
        angle = start_bearing + math.pi + theta
        pts.append(_offset(centre, r * math.cos(angle), r * math.sin(angle)))

    pts[0] = origin
    pts[-1] = origin
    return _jitter(pts, rng, 5.0)


def _elevations(points: list[LatLon], preset: str, rng: random.Random) -> list[float]:
    base = 8.0 + rng.uniform(0, 20)
    amplitude = {"fastest": 2.0, "nature": 22.0, "accessible": 1.2}[preset]
    n = len(points)
    return [
        round(base + amplitude * math.sin(3.1 * i / n * math.pi) + rng.uniform(-0.4, 0.4), 1)
        for i in range(n)
    ]


def _weighted_spans(n_points: int, mix: list[tuple[str, float]], rng: random.Random,
                    forced: list[tuple[int, int, str]] | None = None
                    ) -> list[list[Any]]:
    """GraphHopper path-details format: ``[[from_idx, to_idx, value], ...]``."""
    spans: list[list[Any]] = []
    idx = 0
    values = [v for v, _ in mix]
    weights = [w for _, w in mix]
    while idx < n_points - 1:
        span_len = min(rng.randint(2, 8), n_points - 1 - idx)
        value = rng.choices(values, weights=weights, k=1)[0]
        spans.append([idx, idx + span_len, value])
        idx += span_len

    for start, end, value in forced or []:
        spans.append([start, min(end, n_points - 1), value])
    spans.sort(key=lambda s: s[0])
    return spans


def _details(points: list[LatLon], preset: str, rng: random.Random,
             known_bad: bool) -> dict[str, list[list[Any]]]:
    n = len(points)
    mix = DETAIL_MIX[preset]
    forced_class: list[tuple[int, int, str]] = []
    forced_surface: list[tuple[int, int, str]] = []
    if known_bad:
        # A flight of steps and a stretch of cobbles part-way along: the
        # accessibility engine must reject this route outright.
        forced_class.append((int(n * 0.42), int(n * 0.45), "STEPS"))
        forced_surface.append((int(n * 0.62), int(n * 0.68), "COBBLESTONE"))

    return {
        "road_class": _weighted_spans(n, mix["road_class"], rng, forced_class),
        "surface": _weighted_spans(n, mix["surface"], rng, forced_surface),
        "road_environment": _weighted_spans(n, mix["road_environment"], rng),
    }


def _synth_payload(body: dict[str, Any], preset: str, scenario: Scenario) -> dict[str, Any]:
    rng = random.Random(_seed_for(scenario, preset))
    origin = LatLon(body["points"][0][1], body["points"][0][0])
    profile = body["profile"]

    if body.get("algorithm") == "round_trip":
        points = _loop(origin, float(body["round_trip.distance"]), preset, rng)
    else:
        dest = LatLon(body["points"][1][1], body["points"][1][0])
        points = _a_to_b(origin, dest, preset, rng)

    elevations = _elevations(points, preset, rng)
    distance_m = path_length_m(points)
    # Nature is genuinely slower per metre: unsealed surfaces and more turns.
    speed = SPEED_M_S[profile] * {"fastest": 1.0, "nature": 0.88, "accessible": 0.95}[preset]
    time_ms = int(distance_m / speed * 1000)

    return {
        "hints": {"visited_nodes.sum": 0, "visited_nodes.average": 0},
        "info": {
            "copyrights": ["GraphHopper", "OpenStreetMap contributors"],
            "took": 12,
            "road_data_timestamp": "2026-07-01T00:00:00Z",
        },
        "paths": [
            {
                "distance": round(distance_m, 3),
                "weight": round(distance_m / max(speed, 0.1), 3),
                "time": time_ms,
                "transfers": 0,
                "points_encoded": False,
                "bbox": [
                    min(p.lon for p in points), min(p.lat for p in points),
                    max(p.lon for p in points), max(p.lat for p in points),
                ],
                "points": {
                    "type": "LineString",
                    "coordinates": [
                        [round(p.lon, 6), round(p.lat, 6), e]
                        for p, e in zip(points, elevations, strict=False)
                    ],
                },
                "ascend": round(max(elevations) - elevations[0], 1),
                "descend": round(max(elevations) - elevations[-1], 1),
                "details": _details(points, preset, rng, known_bad=preset in scenario.known_bad),
                "legs": [],
                "snapped_waypoints": {
                    "type": "LineString",
                    "coordinates": [
                        [round(p.lon, 6), round(p.lat, 6)] for p in (points[0], points[-1])
                    ],
                },
            }
        ],
    }


def _unroutable_payload() -> dict[str, Any]:
    """GraphHopper's real shape for "there is no such route"."""
    return {
        "message": "Connection between locations not found: 0->1",
        "hints": [{"message": "Connection between locations not found: 0->1",
                   "details": "com.graphhopper.util.exceptions.ConnectionNotFoundException"}],
    }


async def _generate(scenario: Scenario, force: bool) -> list[str]:
    origin = TEST_LOCATIONS_BY_SLUG[scenario.origin_slug]
    dest_loc = (
        TEST_LOCATIONS_BY_SLUG[scenario.destination_slug] if scenario.destination_slug else None
    )
    origin_pt = LatLon(origin.lat, origin.lon)
    dest_pt = LatLon(dest_loc.lat, dest_loc.lon) if dest_loc else None

    written: list[str] = []

    # Unroutable presets are authored directly: fetch() refuses to record a
    # non-2xx response, and rightly so — that rule exists to stop a live outage
    # being cached forever. A deliberately authored error fixture is different.
    for preset in scenario.unroutable:
        body = build_request_body(origin_pt, dest_pt, scenario.minutes, scenario.mode, preset)
        sig = fx.signature("POST", GRAPHHOPPER_URL, json_body=body,
                           headers={"Content-Type": "application/json"})
        path = fx.fixture_path("graphhopper", sig)
        if path.exists() and not force:
            continue
        fx.write_fixture(
            "graphhopper", sig,
            method="POST", url=GRAPHHOPPER_URL, params=None, json_body=body,
            data=None, content=None, headers={"Content-Type": "application/json"},
            response=httpx.Response(
                400, json=_unroutable_payload(),
                request=httpx.Request("POST", GRAPHHOPPER_URL),
            ),
            provenance=fx.PROVENANCE_SYNTHETIC,
        )
        written.append(f"{scenario.slug}/{preset} (unroutable)")

    def handler(request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content)
        custom_model = body.get("custom_model")
        if custom_model is None:
            preset = "fastest"
        elif any("STEPS" in str(rule.get("if", "")) for rule in custom_model["priority"]):
            preset = "accessible"
        else:
            preset = "nature"
        return httpx.Response(200, json=_synth_payload(body, preset, scenario))

    transport = httpx.MockTransport(handler)
    original_client = fx._client
    fx._client = httpx.AsyncClient(transport=transport)
    try:
        with fx.recording_as(fx.PROVENANCE_SYNTHETIC):
            for preset in ("fastest", "nature", "accessible"):
                if preset in scenario.unroutable:
                    continue
                body = build_request_body(origin_pt, dest_pt, scenario.minutes,
                                          scenario.mode, preset)
                sig = fx.signature("POST", GRAPHHOPPER_URL, json_body=body,
                                   headers={"Content-Type": "application/json"})
                if fx.fixture_path("graphhopper", sig).exists() and not force:
                    continue
                response = await fx.fetch(
                    "POST", GRAPHHOPPER_URL, json_body=body,
                    headers={"Content-Type": "application/json"},
                    cost=0, service="graphhopper",
                )
                assert response.status_code == 200
                written.append(f"{scenario.slug}/{preset}")
    finally:
        await fx._client.aclose()
        fx._client = original_client

    return written


async def _report(scenario: Scenario) -> str:
    """Replay what was just written and print the numbers, so a bad generator is obvious."""
    origin = TEST_LOCATIONS_BY_SLUG[scenario.origin_slug]
    dest_loc = (
        TEST_LOCATIONS_BY_SLUG[scenario.destination_slug] if scenario.destination_slug else None
    )
    origin_pt = LatLon(origin.lat, origin.lon)
    dest_pt = LatLon(dest_loc.lat, dest_loc.lon) if dest_loc else None

    lines = [f"  {scenario.slug} ({scenario.mode}, {scenario.minutes} min)"]
    fastest = None
    for name, fn in (("fastest", route_fastest), ("nature", route_nature),
                     ("accessible", route_accessible)):
        try:
            if name == "nature":
                route = await fn(origin_pt, dest_pt, scenario.minutes, scenario.mode,
                                 fastest.duration_min if fastest else None)
            else:
                route = await fn(origin_pt, dest_pt, scenario.minutes, scenario.mode)
        # This is the generator's own report, not a request path: a preset that
        # is deliberately unroutable must print as such rather than abort.
        except Exception as exc:  # noqa: BLE001 — an offline run must not abort part-way
            lines.append(f"    {name:<11} blocked: {type(exc).__name__}")
            continue
        if name == "fastest":
            fastest = route
        ratio = route.duration_min / fastest.duration_min if fastest else 1.0
        lines.append(
            f"    {name:<11} {route.duration_min:6.1f} min  {route.distance_m:8.0f} m  "
            f"{len(route.points):3d} pts  x{ratio:.2f}"
        )
    return "\n".join(lines)


async def main_async(force: bool) -> int:
    # The generator must be able to write regardless of the ambient mode.
    original_mode = fx.current_mode
    fx.current_mode = lambda: "live"
    try:
        written: list[str] = []
        for scenario in SCENARIOS:
            written.extend(await _generate(scenario, force))
    finally:
        fx.current_mode = original_mode

    print(f"Wrote {len(written)} synthetic GraphHopper fixtures to {FIXTURE_DIR / 'graphhopper'}")
    for w in written:
        print(f"  + {w}")

    fx.current_mode = lambda: "replay"
    try:
        print("\nReplayed:")
        for scenario in SCENARIOS:
            print(await _report(scenario))
    finally:
        fx.current_mode = original_mode
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--force", action="store_true",
                        help="overwrite fixtures that already exist")
    args = parser.parse_args()
    return asyncio.run(main_async(args.force))


if __name__ == "__main__":
    sys.exit(main())
