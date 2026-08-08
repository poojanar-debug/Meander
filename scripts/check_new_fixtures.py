#!/usr/bin/env python3
"""Refuse fixtures that nobody meant to add.

The fourth guard on the privacy promise, alongside the pre-commit cache.db
check, the build-time assertion in the Dockerfile, and test_privacy_guard.py.

A recorded fixture is a verbatim capture of one upstream call, which for
GraphHopper, Overpass and Nominatim means the coordinates of somewhere a real
person actually asked to walk. Before 70891eb, production wrote one per upstream
call: a live session silently produced dozens of files in tracked directories,
and `git add -A` would have committed the lot. That path is fixed, but the
directories are still tracked, `scripts/record_fixtures` still exists by design,
and an older checkout still has the old behaviour.

The obvious guard is precision — refuse coordinates finer than the ~11 m grid
the cache key rounds to (backend/cache.py:35, SEGMENT_GRID_DECIMALS = 4). That
does not work, and it is worth writing down why so nobody implements it later:
**283 of the 322 committed fixtures already carry more than six decimal places**,
some up to eighteen. They are recordings of what upstream actually sent, so they
carry upstream's precision by definition. A precision rule would reject the
entire existing corpus while saying nothing about whether a file should be
there.

The 71 stray fixtures this guard was written for were indistinguishable from the
committed ones by every intrinsic property — same `_meander_provenance:
recorded`, same envelope, same precision, same shape. The only thing that made
them different is that no one decided to add them.

So that is what is checked. A fixture that is not already tracked cannot be
committed by accident. Deliberate recording sessions are one explicit
environment variable away:

    MEANDER_ALLOW_NEW_FIXTURES=1 git commit ...

Modifying an existing fixture is allowed and unchecked — the hash in the
filename is derived from the outgoing request body, so a file that already
exists is a re-recording of a request the corpus already contains, not a new
place. See BLOCKED.md:228 before re-recording anything in bulk.

Exit 0 if clean, 1 if new fixtures are staged without the opt-in.
"""

from __future__ import annotations

import os
import subprocess
import sys

OPT_IN = "MEANDER_ALLOW_NEW_FIXTURES"


def _staged_additions() -> list[str]:
    """Paths under fixtures/ that this commit would add for the first time."""
    result = subprocess.run(
        ["git", "diff", "--cached", "--name-only", "--diff-filter=A", "--", "fixtures/"],
        capture_output=True,
        text=True,
        check=True,
    )
    return [p for p in result.stdout.split("\n") if p.strip()]


def main() -> int:
    if os.environ.get(OPT_IN) == "1":
        print(f"{OPT_IN}=1 — new fixtures allowed for this commit.")
        return 0

    try:
        added = _staged_additions()
    except subprocess.CalledProcessError as exc:
        print(f"check_new_fixtures: git failed: {exc}", file=sys.stderr)
        return 1

    if not added:
        return 0

    print(
        f"{len(added)} fixture(s) would be added by this commit:",
        file=sys.stderr,
    )
    for path in added[:20]:
        print(f"    {path}", file=sys.stderr)
    if len(added) > 20:
        print(f"    ... and {len(added) - 20} more", file=sys.stderr)

    print(
        "\nA recorded fixture holds the coordinates of a real request. Before"
        "\n70891eb, production wrote one per upstream call, and 71 of them were"
        "\nsitting untracked in this repository when that was found."
        "\n"
        "\nIf these came from a live session rather than a deliberate recording,"
        "\nthey should be deleted, not committed:"
        "\n"
        "\n    git restore --staged fixtures/ && git clean -f -- fixtures/"
        "\n"
        f"\nIf you meant to add them, say so:"
        f"\n"
        f"\n    {OPT_IN}=1 git commit ...",
        file=sys.stderr,
    )
    return 1


if __name__ == "__main__":
    sys.exit(main())
