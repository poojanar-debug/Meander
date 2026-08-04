"""SQLite persistence: per-segment scores and whole-route responses.

Two independent caches share one file:

* ``segment_scores`` — expensive CLIP work, pre-warmed offline by batch_score.py
  and committed to the repo so the 512 MB deployment can read real scores
  without ever importing torch.
* ``route_cache`` — whole API responses, keyed on rounded inputs, to keep the
  GraphHopper credit burn under the free-tier quota.

No coordinate here is ever attributable to a user: segment keys are grid cells
rounded to ~11 m and route keys are hashes of rounded inputs.
"""

from __future__ import annotations

import json
import sqlite3
import threading
from collections.abc import Iterable
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

from .config import CACHE_DB_PATH
from .logging_setup import get_logger

log = get_logger(__name__)

SCHEMA_VERSION = 3

# ~11 m at the equator. Segment scores are a property of a place, not a route,
# so neighbouring requests share cache entries.
SEGMENT_GRID_DECIMALS = 4

_SCHEMA = """
CREATE TABLE IF NOT EXISTS meta (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS segment_scores (
    segment_key    TEXT PRIMARY KEY,
    lat            REAL NOT NULL,
    lon            REAL NOT NULL,
    clip_score     REAL,
    image_count    INTEGER NOT NULL DEFAULT 0,
    scoring_method TEXT NOT NULL,
    prompt_variant TEXT,
    updated_at     TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS route_cache (
    cache_key  TEXT PRIMARY KEY,
    payload    TEXT NOT NULL,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_route_cache_expires ON route_cache(expires_at);

CREATE TABLE IF NOT EXISTS access_segments (
    segment_key  TEXT PRIMARY KEY,
    lat          REAL NOT NULL,
    lon          REAL NOT NULL,
    tags_json    TEXT NOT NULL,
    updated_at   TEXT NOT NULL
);
"""


def _now() -> datetime:
    return datetime.now(UTC)


def _iso(dt: datetime) -> str:
    return dt.isoformat()


def segment_key(lat: float, lon: float) -> str:
    """Grid-cell id for a coordinate. Deterministic and lossy by design."""
    return f"{round(lat, SEGMENT_GRID_DECIMALS):.4f},{round(lon, SEGMENT_GRID_DECIMALS):.4f}"


@dataclass(frozen=True)
class SegmentScore:
    segment_key: str
    lat: float
    lon: float
    clip_score: float | None
    image_count: int
    scoring_method: str
    prompt_variant: str | None
    updated_at: str


class Cache:
    """Thread-safe SQLite wrapper. One connection per thread."""

    def __init__(self, path: Path | str | None = None) -> None:
        # Resolved at call time, not bound as a default, so tests can redirect
        # the module-level CACHE_DB_PATH to a temp file.
        self.path = Path(path if path is not None else CACHE_DB_PATH)
        if self.path.parent and str(self.path) != ":memory:":
            self.path.parent.mkdir(parents=True, exist_ok=True)
        self._local = threading.local()
        # An in-memory database only survives while its connection is open, so a
        # single shared connection is required for that case.
        self._shared: sqlite3.Connection | None = None
        if str(self.path) == ":memory:":
            self._shared = self._new_connection()
        self._init_schema()

    def _new_connection(self) -> sqlite3.Connection:
        conn = sqlite3.connect(str(self.path), check_same_thread=False, timeout=10.0)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA journal_mode=WAL")
        conn.execute("PRAGMA synchronous=NORMAL")
        conn.execute("PRAGMA foreign_keys=ON")
        return conn

    @property
    def conn(self) -> sqlite3.Connection:
        if self._shared is not None:
            return self._shared
        conn = getattr(self._local, "conn", None)
        if conn is None:
            conn = self._new_connection()
            self._local.conn = conn
        return conn

    def _init_schema(self) -> None:
        with self.conn as conn:
            conn.executescript(_SCHEMA)
            conn.execute(
                "INSERT INTO meta(key, value) VALUES('schema_version', ?) "
                "ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                (str(SCHEMA_VERSION),),
            )

    # ---- segment scores -------------------------------------------------

    def get_segment_scores(self, keys: Iterable[str]) -> dict[str, SegmentScore]:
        keys = list(keys)
        if not keys:
            return {}
        out: dict[str, SegmentScore] = {}
        # SQLite caps host parameters at 999; chunk to stay well below it.
        for i in range(0, len(keys), 400):
            chunk = keys[i : i + 400]
            placeholders = ",".join("?" * len(chunk))
            rows = self.conn.execute(
                f"SELECT * FROM segment_scores WHERE segment_key IN ({placeholders})", chunk
            ).fetchall()
            for row in rows:
                out[row["segment_key"]] = SegmentScore(
                    segment_key=row["segment_key"],
                    lat=row["lat"],
                    lon=row["lon"],
                    clip_score=row["clip_score"],
                    image_count=row["image_count"],
                    scoring_method=row["scoring_method"],
                    prompt_variant=row["prompt_variant"],
                    updated_at=row["updated_at"],
                )
        return out

    def put_segment_score(
        self,
        lat: float,
        lon: float,
        clip_score: float | None,
        image_count: int,
        scoring_method: str,
        prompt_variant: str | None = None,
    ) -> str:
        key = segment_key(lat, lon)
        with self.conn as conn:
            conn.execute(
                """
                INSERT INTO segment_scores
                    (segment_key, lat, lon, clip_score, image_count, scoring_method,
                     prompt_variant, updated_at)
                VALUES (?,?,?,?,?,?,?,?)
                ON CONFLICT(segment_key) DO UPDATE SET
                    clip_score=excluded.clip_score,
                    image_count=excluded.image_count,
                    scoring_method=excluded.scoring_method,
                    prompt_variant=excluded.prompt_variant,
                    updated_at=excluded.updated_at
                """,
                (
                    key,
                    round(lat, SEGMENT_GRID_DECIMALS),
                    round(lon, SEGMENT_GRID_DECIMALS),
                    clip_score,
                    image_count,
                    scoring_method,
                    prompt_variant,
                    _iso(_now()),
                ),
            )
        return key

    def segment_count(self) -> int:
        row = self.conn.execute("SELECT COUNT(*) AS n FROM segment_scores").fetchone()
        return int(row["n"]) if row else 0

    def clip_segment_count(self) -> int:
        row = self.conn.execute(
            "SELECT COUNT(*) AS n FROM segment_scores WHERE scoring_method='clip'"
        ).fetchone()
        return int(row["n"]) if row else 0

    # ---- accessibility tags ---------------------------------------------

    def get_access_tags(self, keys: Iterable[str]) -> dict[str, dict[str, Any]]:
        keys = list(keys)
        if not keys:
            return {}
        out: dict[str, dict[str, Any]] = {}
        corrupt = 0
        for i in range(0, len(keys), 400):
            chunk = keys[i : i + 400]
            placeholders = ",".join("?" * len(chunk))
            rows = self.conn.execute(
                f"SELECT segment_key, tags_json FROM access_segments "
                f"WHERE segment_key IN ({placeholders})",
                chunk,
            ).fetchall()
            for row in rows:
                try:
                    out[row["segment_key"]] = json.loads(row["tags_json"])
                except json.JSONDecodeError:
                    # The key is a rounded coordinate, so it is counted, not logged.
                    corrupt += 1
        if corrupt:
            log.warning("access_tags_corrupt", extra={"rows": corrupt})
        return out

    def put_access_tags(self, lat: float, lon: float, tags: dict[str, Any]) -> str:
        key = segment_key(lat, lon)
        with self.conn as conn:
            conn.execute(
                """
                INSERT INTO access_segments (segment_key, lat, lon, tags_json, updated_at)
                VALUES (?,?,?,?,?)
                ON CONFLICT(segment_key) DO UPDATE SET
                    tags_json=excluded.tags_json, updated_at=excluded.updated_at
                """,
                (
                    key,
                    round(lat, SEGMENT_GRID_DECIMALS),
                    round(lon, SEGMENT_GRID_DECIMALS),
                    json.dumps(tags, separators=(",", ":")),
                    _iso(_now()),
                ),
            )
        return key

    # ---- whole-route cache ----------------------------------------------

    def get_route(self, cache_key: str) -> dict[str, Any] | None:
        row = self.conn.execute(
            "SELECT payload, expires_at FROM route_cache WHERE cache_key = ?", (cache_key,)
        ).fetchone()
        if row is None:
            return None
        try:
            expires = datetime.fromisoformat(row["expires_at"])
        except ValueError:
            return None
        if expires <= _now():
            with self.conn as conn:
                conn.execute("DELETE FROM route_cache WHERE cache_key = ?", (cache_key,))
            return None
        try:
            return json.loads(row["payload"])
        except json.JSONDecodeError:
            log.warning("route_cache_corrupt")
            return None

    def put_route(self, cache_key: str, payload: dict[str, Any], ttl_s: int) -> None:
        now = _now()
        with self.conn as conn:
            conn.execute(
                """
                INSERT INTO route_cache (cache_key, payload, created_at, expires_at)
                VALUES (?,?,?,?)
                ON CONFLICT(cache_key) DO UPDATE SET
                    payload=excluded.payload,
                    created_at=excluded.created_at,
                    expires_at=excluded.expires_at
                """,
                (
                    cache_key,
                    json.dumps(payload, separators=(",", ":")),
                    _iso(now),
                    _iso(now + timedelta(seconds=ttl_s)),
                ),
            )

    def purge_expired_routes(self) -> int:
        with self.conn as conn:
            cur = conn.execute("DELETE FROM route_cache WHERE expires_at <= ?", (_iso(_now()),))
            return cur.rowcount or 0

    def route_cache_size(self) -> int:
        row = self.conn.execute("SELECT COUNT(*) AS n FROM route_cache").fetchone()
        return int(row["n"]) if row else 0

    def stats(self) -> dict[str, Any]:
        return {
            "segments_scored": self.segment_count(),
            "segments_clip": self.clip_segment_count(),
            "routes_cached": self.route_cache_size(),
            "schema_version": SCHEMA_VERSION,
        }

    def close(self) -> None:
        if self._shared is not None:
            self._shared.close()
            self._shared = None
        conn = getattr(self._local, "conn", None)
        if conn is not None:
            conn.close()
            self._local.conn = None


_default_cache: Cache | None = None
_default_lock = threading.Lock()


def get_cache() -> Cache:
    global _default_cache
    if _default_cache is None:
        with _default_lock:
            if _default_cache is None:
                _default_cache = Cache()
    return _default_cache


def reset_default_cache() -> None:
    """Test hook — drop the process-wide cache so a fresh path can be used."""
    global _default_cache
    with _default_lock:
        if _default_cache is not None:
            _default_cache.close()
        _default_cache = None
