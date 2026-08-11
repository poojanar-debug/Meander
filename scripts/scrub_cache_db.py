#!/usr/bin/env python3
"""Keep route history out of the committed cache database and out of images.

``data/cache.db`` is a **tracked** file. It is committed on purpose: it carries
the pre-warmed CLIP ``segment_scores``, which are a property of a place and are
rounded to an ~11 m grid, so the 512 MB deployment can read real scenery scores
without ever importing torch.

The same file also holds ``route_cache``, and those rows are a completely
different kind of data: each payload is a whole ``/api/routes`` response, which
means **full coordinate arrays for somewhere a real person actually asked to
walk**. Committing one, or baking it into a container image, publishes location
history in a public artifact.

The trap is that this is invisible until it is too late. SQLite runs in WAL
mode, so a live request leaves ``data/cache.db`` byte-identical on disk and
parks the row in ``cache.db-wal`` — which *is* gitignored. ``git status`` says
clean. Then something checkpoints the WAL (any later open, a VACUUM, a plain
process exit) and the tracked file silently grows to carry the route.
Measured on this repository: one uncached request produced an 86 KB WAL, and
the checkpoint took ``data/cache.db`` from 4 KB to 45 KB.

Two modes:

``--check``   exit 1 if a database carries route rows. Reads the **staged**
              blob by default, which is what a pre-commit hook must inspect —
              the working tree is not what gets committed. ``--worktree``
              inspects the file on disk instead, for use as a build step.
``--scrub``   delete every ``route_cache`` row, checkpoint the WAL and VACUUM,
              leaving the segment scores untouched.

Neither mode ever touches ``segment_scores``.
"""

from __future__ import annotations

import argparse
import shutil
import sqlite3
import subprocess
import sys
import tempfile
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
DEFAULT_DB = REPO_ROOT / "data" / "cache.db"

# Tables whose rows are derived from a specific user request rather than from a
# place. These are the ones that must never be published.
REQUEST_SCOPED_TABLES = ("route_cache",)


def _count_request_scoped_rows(db_path: Path) -> dict[str, int]:
    """Rows per request-scoped table. A missing table counts as zero."""
    counts: dict[str, int] = {}
    # Read-only, and immutable=1 so opening a committed blob cannot create a
    # WAL beside it or otherwise mutate what we are inspecting.
    uri = f"file:{db_path}?mode=ro&immutable=1"
    try:
        conn = sqlite3.connect(uri, uri=True)
    except sqlite3.Error as exc:
        raise SystemExit(f"cannot open {db_path}: {exc}") from exc
    try:
        present = {
            row[0]
            for row in conn.execute("SELECT name FROM sqlite_master WHERE type='table'")
        }
        for table in REQUEST_SCOPED_TABLES:
            if table in present:
                counts[table] = int(conn.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0])
            else:
                counts[table] = 0
    finally:
        conn.close()
    return counts


def _staged_blob(rel_path: str) -> Path | None:
    """Write the staged version of a tracked file to a temp file.

    Returns None when the path is not staged in this commit, which is the
    common case and is not an error.
    """
    staged = subprocess.run(
        ["git", "diff", "--cached", "--name-only", "--", rel_path],
        cwd=REPO_ROOT,
        capture_output=True,
        text=True,
        check=False,
    )
    if staged.returncode != 0 or not staged.stdout.strip():
        return None

    blob = subprocess.run(
        ["git", "show", f":{rel_path}"],
        cwd=REPO_ROOT,
        capture_output=True,
        check=False,
    )
    if blob.returncode != 0:
        return None

    tmp = Path(tempfile.mkstemp(suffix=".db", prefix="meander-staged-")[1])
    tmp.write_bytes(blob.stdout)
    return tmp


def _repo_relative(db_path: Path) -> str:
    """Label for messages. Falls back to the absolute path outside the repo."""
    try:
        return db_path.relative_to(REPO_ROOT).as_posix()
    except ValueError:
        return str(db_path)


def check(db_path: Path, *, worktree: bool) -> int:
    if worktree:
        if not db_path.exists():
            print(f"scrub_cache_db: {db_path} does not exist; nothing to check.")
            return 0
        target: Path | None = db_path
        source = "working tree"
        cleanup = False
    else:
        target = _staged_blob(_repo_relative(db_path))
        source = "staged blob"
        cleanup = True
        if target is None:
            return 0  # not part of this commit

    try:
        counts = _count_request_scoped_rows(target)
    finally:
        if cleanup and target is not None:
            target.unlink(missing_ok=True)

    offending = {table: n for table, n in counts.items() if n}
    if not offending:
        return 0

    detail = ", ".join(f"{n} row(s) in {table}" for table, n in offending.items())
    print(
        f"\nREFUSING: {db_path.name} ({source}) carries request-scoped route data — {detail}.\n"
        f"\n"
        f"  Each route_cache payload is a whole /api/routes response, including the\n"
        f"  full coordinate array of somewhere a real person asked to walk. Committing\n"
        f"  it, or copying it into a container image, publishes location history.\n"
        f"\n"
        f"  Fix it:\n"
        f"      python3 scripts/scrub_cache_db.py --scrub\n"
        f"      git add {_repo_relative(db_path)}\n",
        file=sys.stderr,
    )
    return 1


def scrub(db_path: Path) -> int:
    if not db_path.exists():
        print(f"scrub_cache_db: {db_path} does not exist; nothing to scrub.")
        return 0

    before = db_path.stat().st_size
    conn = sqlite3.connect(str(db_path))
    try:
        removed = 0
        for table in REQUEST_SCOPED_TABLES:
            present = conn.execute(
                "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", (table,)
            ).fetchone()
            if present:
                removed += conn.execute(f"DELETE FROM {table}").rowcount or 0
        conn.commit()
        # Fold the WAL back in and drop it, then rewrite the file so the deleted
        # payloads are not merely unreferenced pages still holding coordinates.
        conn.execute("PRAGMA wal_checkpoint(TRUNCATE)")
        conn.execute("VACUUM")
        conn.commit()
    finally:
        conn.close()

    # VACUUM leaves the side files behind; they are gitignored but a stale WAL
    # beside a vacuumed database is confusing.
    for suffix in ("-wal", "-shm"):
        side = db_path.with_name(db_path.name + suffix)
        if side.exists():
            side.unlink()

    after = db_path.stat().st_size
    print(
        f"scrub_cache_db: removed {removed} route_cache row(s); "
        f"{db_path.name} {before} -> {after} bytes."
    )
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument(
        "--check",
        action="store_true",
        help="exit 1 if the database carries route rows (default: inspect the staged blob)",
    )
    parser.add_argument(
        "--worktree",
        action="store_true",
        help="with --check, inspect the file on disk rather than the staged blob",
    )
    parser.add_argument("--scrub", action="store_true", help="delete route rows and vacuum")
    parser.add_argument("--db", type=Path, default=DEFAULT_DB, help="database path")
    args = parser.parse_args(argv)

    if args.scrub and args.check:
        parser.error("--scrub and --check are mutually exclusive")
    if not args.scrub and not args.check:
        parser.error("choose one of --check or --scrub")

    db_path = args.db.resolve()
    if args.scrub:
        return scrub(db_path)
    return check(db_path, worktree=args.worktree)


if __name__ == "__main__":
    if shutil.which("git") is None and "--worktree" not in sys.argv:
        print("scrub_cache_db: git not found; use --worktree", file=sys.stderr)
        raise SystemExit(2)
    raise SystemExit(main())
