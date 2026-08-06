"""The committed cache database must never carry route history.

``data/cache.db`` is tracked so the deployment can read pre-warmed CLIP segment
scores without torch. Those are a property of a place, rounded to an ~11 m grid.
``route_cache`` rows are not: each payload is a whole ``/api/routes`` response
carrying the full coordinate array of somewhere a real person asked to walk.

These tests pin both halves of the guard — that it refuses the bad case, and
that scrubbing keeps the scores it exists to ship.
"""

from __future__ import annotations

import json
import sqlite3
import subprocess
import sys
from pathlib import Path

import pytest

from backend.cache import Cache

SCRUB = Path(__file__).resolve().parent.parent.parent / "scripts" / "scrub_cache_db.py"

# A recognisable coordinate, so a test can assert the bytes are really gone
# rather than merely unreferenced.
SECRET_LAT, SECRET_LON = 51.507489, -0.162207


def _run(*args: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [sys.executable, str(SCRUB), *args], capture_output=True, text=True, check=False
    )


@pytest.fixture
def populated_db(tmp_path: Path) -> Path:
    """A cache database holding one segment score and one cached route."""
    db = tmp_path / "cache.db"
    c = Cache(db)
    c.put_segment_score(SECRET_LAT, SECRET_LON, 0.82, 12, "clip", "v1")
    c.put_route(
        "abc123",
        {"routes": [{"id": "fastest", "geometry": [[SECRET_LON, SECRET_LAT]] * 40}]},
        ttl_s=3600,
    )
    c.close()
    # Fold the WAL in so the file on disk is what a naive commit would pick up.
    conn = sqlite3.connect(str(db))
    conn.execute("PRAGMA wal_checkpoint(TRUNCATE)")
    conn.close()
    return db


def test_check_rejects_a_database_carrying_routes(populated_db: Path) -> None:
    result = _run("--check", "--worktree", "--db", str(populated_db))
    assert result.returncode == 1
    assert "route_cache" in result.stderr
    assert "location history" in result.stderr


def test_scrub_removes_routes_and_keeps_segment_scores(populated_db: Path) -> None:
    assert _run("--scrub", "--db", str(populated_db)).returncode == 0

    conn = sqlite3.connect(str(populated_db))
    assert conn.execute("SELECT COUNT(*) FROM route_cache").fetchone()[0] == 0
    # The reason the file is committed at all must survive the scrub.
    assert conn.execute("SELECT COUNT(*) FROM segment_scores").fetchone()[0] == 1
    assert conn.execute("SELECT clip_score FROM segment_scores").fetchone()[0] == 0.82
    conn.close()

    assert _run("--check", "--worktree", "--db", str(populated_db)).returncode == 0


def test_scrub_vacuums_the_coordinates_out_of_the_file(populated_db: Path) -> None:
    """A DELETE alone leaves the payload in unreferenced pages. VACUUM is the point."""
    raw_before = populated_db.read_bytes()
    assert json.dumps(SECRET_LON).encode() in raw_before

    _run("--scrub", "--db", str(populated_db))

    raw_after = populated_db.read_bytes()
    # The segment score row legitimately keeps a rounded lat/lon, so assert on
    # the route payload's exact serialisation rather than on the numbers.
    assert b'"geometry"' not in raw_after
    assert b"abc123" not in raw_after


def test_check_inspects_the_staged_blob_not_the_working_tree(
    tmp_path: Path, populated_db: Path
) -> None:
    """The hook must judge what is being committed, not what happens to be on disk.

    A developer can stage a dirty cache.db and then scrub the working copy; the
    commit would still publish the routes. This is the case --worktree misses.
    """
    repo = tmp_path / "repo"
    (repo / "data").mkdir(parents=True)
    (repo / "scripts").mkdir()
    (repo / "scripts" / "scrub_cache_db.py").write_bytes(SCRUB.read_bytes())

    def git(*args: str) -> None:
        subprocess.run(["git", *args], cwd=repo, check=True, capture_output=True)

    git("init", "-q")
    git("config", "user.email", "t@example.invalid")
    git("config", "user.name", "t")

    tracked = repo / "data" / "cache.db"
    tracked.write_bytes(populated_db.read_bytes())
    git("add", "data/cache.db")

    # Working tree is now clean of routes; the staged blob still has them.
    _run("--scrub", "--db", str(tracked))
    assert _run("--check", "--worktree", "--db", str(tracked)).returncode == 0

    staged_check = subprocess.run(
        [sys.executable, str(repo / "scripts" / "scrub_cache_db.py"), "--check"],
        cwd=repo,
        capture_output=True,
        text=True,
        check=False,
    )
    assert staged_check.returncode == 1, "staged route rows must be refused"
    assert "route_cache" in staged_check.stderr


def test_check_passes_when_cache_db_is_not_part_of_the_commit(tmp_path: Path) -> None:
    repo = tmp_path / "repo"
    (repo / "data").mkdir(parents=True)
    (repo / "scripts").mkdir()
    (repo / "scripts" / "scrub_cache_db.py").write_bytes(SCRUB.read_bytes())

    def git(*args: str) -> None:
        subprocess.run(["git", *args], cwd=repo, check=True, capture_output=True)

    git("init", "-q")
    git("config", "user.email", "t@example.invalid")
    git("config", "user.name", "t")
    (repo / "README.md").write_text("unrelated change")
    git("add", "README.md")

    result = subprocess.run(
        [sys.executable, str(repo / "scripts" / "scrub_cache_db.py"), "--check"],
        cwd=repo,
        capture_output=True,
        text=True,
        check=False,
    )
    assert result.returncode == 0
