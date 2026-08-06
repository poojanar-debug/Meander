#!/usr/bin/env python3
"""Load test for `POST /api/routes`, sized to answer a specific question.

    python3 scripts/load_test.py --url http://localhost:8000 --users 10 --requests 50

**The question is not "how many requests per second".** That number would be a
measurement of Overpass — PROGRESS.md's launch phase 0 measured routing at
24 ms and one Overpass bench query at 13.6 s, so throughput here is almost
entirely somebody else's tail latency. The questions worth asking are:

  1. Does concurrency break anything? The route cache, the rate limiter and the
     live-call budget are all shared mutable state behind an async server.
  2. Does the rate limiter actually limit, and does it limit the right people?
  3. Does the app degrade rather than fail? A slow or dead upstream must
     produce a 200 with null fields, not a 500.
  4. What is the p95, and is it the shape the alarm in infra/20-services.yaml
     was sized for?

It reports percentiles rather than a mean. A mean over a distribution with a
13 s tail describes nothing that ever happened.

⚠ **This makes real requests.** Against a deployment it spends real upstream
quota — run it with `MEANDER_FIXTURES=replay` on the server, or against a
staging instance, unless you mean to. It refuses a non-local URL without
`--i-mean-it` for that reason.
"""

from __future__ import annotations

import argparse
import asyncio
import sys
import time
from collections import Counter
from dataclasses import dataclass, field
from urllib.parse import urlparse

import httpx

# The five demo locations. Spread across them so the whole-route cache is
# exercised both ways: repeats of one body should hit, and a mix should not.
LOCATIONS = [
    ("Colombo Fort", 6.933727, 79.85008),
    ("Viharamahadevi", 6.914899, 79.861364),
    ("Hyde Park", 51.507489, -0.162207),
    ("Euston Road", 51.524718, -0.13853),
    ("Vondelpark", 52.357197, 4.864119),
]


@dataclass
class Results:
    # Split, because a 429 is refused in microseconds and pooling the two makes
    # the median describe the rate limiter rather than the application. The
    # first run of this reported p50 = 0.00s with a p95 of 9.81s, which is not
    # a distribution, it is two.
    served: list[float] = field(default_factory=list)
    refused: list[float] = field(default_factory=list)
    latencies: list[float] = field(default_factory=list)
    statuses: Counter[int] = field(default_factory=Counter)
    errors: Counter[str] = field(default_factory=Counter)
    degraded: int = 0          # 200s with a null enrichment field
    blocked_routes: int = 0
    scoring_methods: Counter[str] = field(default_factory=Counter)


def body_for(index: int, minutes: int) -> dict:
    _, lat, lon = LOCATIONS[index % len(LOCATIONS)]
    return {
        "origin": {"lat": lat, "lon": lon},
        "minutes": minutes,
        "mode": "auto",
        "objectives": ["fastest", "nature", "accessible"],
    }


async def one_request(client: httpx.AsyncClient, url: str, body: dict, out: Results) -> None:
    started = time.perf_counter()
    try:
        response = await client.post(f"{url}/api/routes", json=body)
    except httpx.HTTPError as exc:
        out.errors[type(exc).__name__] += 1
        out.latencies.append(time.perf_counter() - started)
        return

    elapsed = time.perf_counter() - started
    out.latencies.append(elapsed)
    (out.refused if response.status_code == 429 else out.served).append(elapsed)

    out.statuses[response.status_code] += 1
    if response.status_code != 200:
        return

    try:
        payload = response.json()
    except ValueError:
        out.errors["unparseable_body"] += 1
        return

    for route in payload.get("routes", []):
        out.scoring_methods[route.get("scoring_method", "?")] += 1
        if route.get("status") != "ok":
            out.blocked_routes += 1
        # `null` rest stops means "we could not look", which is the documented
        # degradation. Counting it is the point: the run is healthy if these
        # appear and the status stays 200.
        if route.get("rest_stops") is None:
            out.degraded += 1


async def worker(client, url, out, bodies: list[dict]) -> None:
    for body in bodies:
        await one_request(client, url, body, out)


def percentile(values: list[float], p: float) -> float:
    if not values:
        return float("nan")
    ordered = sorted(values)
    index = min(len(ordered) - 1, int(round((p / 100.0) * (len(ordered) - 1))))
    return ordered[index]


async def run(url: str, users: int, requests_each: int, minutes: int) -> Results:
    out = Results()
    # A generous timeout: the point is to observe the tail, and a client-side
    # timeout shorter than it would report the *client's* limit as the server's.
    timeout = httpx.Timeout(60.0)
    limits = httpx.Limits(max_connections=users * 2)

    async with httpx.AsyncClient(timeout=timeout, limits=limits) as client:
        plans = [
            [body_for(u * requests_each + i, minutes) for i in range(requests_each)]
            for u in range(users)
        ]
        started = time.perf_counter()
        await asyncio.gather(*(worker(client, url, out, plan) for plan in plans))
        out.wall = time.perf_counter() - started  # type: ignore[attr-defined]
    return out


def report(out: Results, users: int, total: int) -> int:
    wall = getattr(out, "wall", 0.0)
    print(f"\n{total} requests, {users} concurrent, {wall:.1f}s wall\n")

    if out.served:
        print(f"  latency of the {len(out.served)} requests that were served")
        for label, p in (("p50", 50), ("p95", 95), ("p99", 99)):
            print(f"    {label}  {percentile(out.served, p):6.2f}s")
        print(f"    max  {max(out.served):6.2f}s")
    else:
        print("  nothing was served — every request was refused or errored")

    if out.refused:
        print(f"\n  the {len(out.refused)} refused took "
              f"p50 {percentile(out.refused, 50) * 1000:.1f}ms — a 429 is cheap, which is "
              "why it is\n  reported separately: pooled in, it makes the median describe "
              "the limiter.")

    print("\n  status")
    for code, count in sorted(out.statuses.items()):
        print(f"    {code}  {count}")
    for name, count in out.errors.items():
        print(f"    {name}  {count}")

    print("\n  what came back")
    print(f"    routes blocked by the accessibility engine  {out.blocked_routes}")
    print(f"    routes with rest_stops = null (degraded)    {out.degraded}")
    for method, count in out.scoring_methods.items():
        print(f"    scoring_method {method}: {count}")

    # The pass/fail. Everything above is description; these are the claims.
    ok = True
    server_errors = sum(c for s, c in out.statuses.items() if s >= 500)
    if server_errors:
        print(f"\n  FAIL  {server_errors} responses were 5xx. The app is supposed to")
        print("        degrade — a dead enrichment upstream is a 200 with null fields.")
        ok = False
    if out.errors:
        print(f"\n  FAIL  {sum(out.errors.values())} transport errors: {dict(out.errors)}")
        ok = False
    if not out.statuses:
        print("\n  FAIL  no responses at all")
        ok = False

    if ok:
        print("\n  PASS  no 5xx, no transport errors.")
        if out.statuses.get(429):
            print(f"        {out.statuses[429]} of {total} were rate limited, which is the "
                  "limiter working\n        rather than a failure — every one of these came "
                  "from the same address,\n        so they share one bucket by design "
                  "(capacity 12, refill 3/min).\n        To measure latency under load "
                  "instead, restart the server with\n        MEANDER_RATE_CAPACITY=500.")
    return 0 if ok else 1


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--url", default="http://localhost:8000")
    parser.add_argument("--users", type=int, default=10)
    parser.add_argument("--requests", type=int, default=5, help="per user")
    parser.add_argument("--minutes", type=int, default=35)
    parser.add_argument("--i-mean-it", action="store_true",
                        help="required for a non-local URL; it spends real quota")
    args = parser.parse_args()

    host = urlparse(args.url).hostname or ""
    if host not in {"localhost", "127.0.0.1", "::1"} and not args.i_mean_it:
        print(f"{args.url} is not local. This makes real requests and spends real "
              "upstream quota. Pass --i-mean-it if that is what you want.", file=sys.stderr)
        return 2

    total = args.users * args.requests
    print(f"POST {args.url}/api/routes — {args.users} concurrent, {total} total")
    out = asyncio.run(run(args.url, args.users, args.requests, args.minutes))
    return report(out, args.users, total)


if __name__ == "__main__":
    raise SystemExit(main())
