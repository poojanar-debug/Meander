#!/usr/bin/env python3
"""Re-key GraphHopper fixtures after a change to the outgoing request body.

    python3 scripts/migrate_fixtures.py --patch instructions=true --live

A fixture is keyed on a hash of the request body. So any change to what the app
sends GraphHopper — ``path_details()``, ``_base_body()``, a custom model, a
round-trip parameter — invalidates **every** committed fixture at once, and the
offline suite fails wholesale with `no_fixture` 503s that point nowhere near the
cause. PROGRESS.md records this as self-hosting defect #6.

`backend/record_fixtures.py` re-records the scenarios it knows about. This does
something narrower and more complete: it takes the request body *already stored
in each fixture*, applies the same patch the code change made, and re-issues it.
Nothing is invented and no scenario is lost — including the ones recorded from
ad-hoc use that no script remembers.

Two sources for the new response:

``--live``      re-issue against the configured GraphHopper. Requires the server
                the fixture was originally recorded against, which for a
                self-hosted fixture means the self-hosted one.
``--rekey``     keep the stored response and only move it to its new signature.
                Correct **only** when the patch cannot change the response, and
                the tool refuses to guess: you have to say so.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO_ROOT))

from backend import fixtures as fx  # noqa: E402
from backend.config import GRAPHHOPPER_URL  # noqa: E402

FIXTURE_DIR = REPO_ROOT / "fixtures" / "graphhopper"

COERCE = {"true": True, "false": False, "null": None}


def parse_patch(items: list[str]) -> dict:
    patch = {}
    for item in items:
        key, _, raw = item.partition("=")
        if raw in COERCE:
            value = COERCE[raw]
        else:
            try:
                value = json.loads(raw)
            except json.JSONDecodeError:
                value = raw
        patch[key] = value
    return patch


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--patch", action="append", default=[],
                        help="body field to set, e.g. instructions=true")
    source = parser.add_mutually_exclusive_group(required=True)
    source.add_argument("--live", action="store_true",
                        help="re-issue each request and record the new response")
    source.add_argument("--rekey", action="store_true",
                        help="keep the stored response; only valid if it cannot have changed")
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()

    patch = parse_patch(args.patch)
    if not patch:
        print("Nothing to patch.", file=sys.stderr)
        return 2

    print(f"  patch: {patch}")
    print(f"  source: {'live re-issue against ' + GRAPHHOPPER_URL if args.live else 'rekey only'}")

    files = sorted(FIXTURE_DIR.glob("*.json"))
    print(f"  fixtures: {len(files)}")

    import asyncio

    import httpx

    async def run() -> int:
        migrated = unchanged = failed = 0
        written: set[Path] = set()

        async with httpx.AsyncClient(timeout=60.0) as client:
            for path in files:
                envelope = json.loads(path.read_text())
                request = envelope.get("request", {})
                body = request.get("json")
                if not isinstance(body, dict) or "points" not in body:
                    unchanged += 1
                    continue

                old_sig = path.stem
                new_body = {**body, **patch}
                new_sig = fx.signature(
                    "POST",
                    GRAPHHOPPER_URL,
                    json_body=new_body,
                    headers={"Content-Type": "application/json"},
                )
                if new_sig == old_sig:
                    unchanged += 1
                    continue

                provenance = envelope.get("_meander_provenance", "recorded")

                if args.live and provenance != "synthetic":
                    try:
                        response = await client.post(
                            GRAPHHOPPER_URL,
                            json=new_body,
                            headers={"Content-Type": "application/json"},
                        )
                        if response.status_code >= 400:
                            print(f"  FAIL {old_sig}: HTTP {response.status_code}")
                            failed += 1
                            continue
                        envelope["response"] = {
                            "status": response.status_code,
                            "headers": {"content-type": "application/json"},
                            "json": response.json(),
                        }
                    except httpx.HTTPError as exc:
                        print(f"  FAIL {old_sig}: {type(exc).__name__}")
                        failed += 1
                        continue
                elif provenance == "synthetic":
                    # A synthetic fixture is regenerated by its own script, not
                    # re-issued — there is no server that would produce it.
                    print(f"  skip {old_sig}: synthetic; run scripts/make_synthetic_fixtures.py")
                    unchanged += 1
                    continue

                envelope["request"]["json"] = new_body
                new_path = FIXTURE_DIR / f"{new_sig}.json"
                if not args.dry_run:
                    new_path.write_text(json.dumps(envelope, indent=2, sort_keys=False))
                    path.unlink()
                written.add(new_path)
                migrated += 1

        print(f"\n  migrated {migrated}, unchanged {unchanged}, failed {failed}")
        return 1 if failed else 0

    return asyncio.run(run())


if __name__ == "__main__":
    raise SystemExit(main())
