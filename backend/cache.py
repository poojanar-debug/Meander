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

SCHEMA_VERSION = 4


class CacheClosed(RuntimeError):
    """A cache call arrived after close(). See Cache.conn for why it is fatal."""


class SchemaVersionMismatch(RuntimeError):
    """The cache file was written by a schema this build cannot migrate.

    Raised rather than silently accepted. Stamping the current version over an
    older file — which is what this class replaced — left the old columns in
    place and the new number on top, so the version recorded which process last
    opened the file rather than what shape it was in.
    """


# Ordered, applied one step at a time from whatever the file says up to
# SCHEMA_VERSION. A version with no entry here cannot be migrated and is
# refused; a cache is safe to delete, so refusing costs a recomputation rather
# than data.
#
# 3 -> 4 drops access_segments. It was written by nothing and read by nothing
# for the whole life of the project, and the barrier work did not give it a
# purpose: barriers are fetched per request over a bbox and memoised by the
# whole-route cache in front of them. A segment-level barrier cache would have
# to record "this cell was surveyed and had nothing" for every cell in the
# area, because a missing row is otherwise indistinguishable from an unsurveyed
# one, and that ambiguity is the one thing this project refuses everywhere
# else. Dropping it is honest; leaving it was an invitation to wire it up
# wrongly later.
_MIGRATIONS: dict[int, tuple[str, ...]] = {
    3: ("DROP TABLE IF EXISTS access_segments;",),
}

# ~11 m at the equator. Segment scores are a property of a place, not a route,
# so neighbouring requests share cache entries.
SEGMENT_GRID_DECIMALS = 4

# The route cache is a cost control, not a database: it exists so a repeated
# request does not spend GraphHopper credits again, and losing an entry costs
# one recomputation. So it gets a ceiling rather than being allowed to grow to
# whatever the disk holds.
#
# 500 rows against a measured ~30 KB per payload (6.0 MB for 200 rows of three
# routes with geometry and steps) is about 15 MB — small beside the image it
# ships in, and far more than a free-tier daily quota of 2,000 routes can fill
# with distinct answers inside the 6-hour TTL.
ROUTE_CACHE_MAX_ROWS = 500

# The same reasoning, different arithmetic. A geocode payload is a handful of
# names and coordinate pairs — measured at about 400 bytes for a five-result
# answer, two orders of magnitude below a route — so 5,000 rows is roughly 2 MB
# and holds every distinct query a demonstration deployment will ever see inside
# the 7-day TTL. The ceiling is here because an unbounded table on a machine
# whose database is baked into the image is how the last cache growth defect
# happened, not because this one is expected to reach it.
GEOCODE_CACHE_MAX_ROWS = 5000

# Often enough that a burst cannot run away, rarely enough that the common path
# is still a single INSERT. At the ceiling above this is roughly one sweep per
# 10% of the table.
SWEEP_EVERY_N_WRITES = 50

# VACUUM rewrites the whole file and holds a write lock while it does, so it is
# worth doing once a meaningful number of rows have gone — counted across
# sweeps, since one sweep rarely drops more than SWEEP_EVERY_N_WRITES rows.
VACUUM_AFTER_ROWS_REMOVED = 100

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

-- Deliberately shaped exactly like route_cache, so purge_expired_routes'
-- sibling, the eviction and the reclaim can be the same code rather than a
-- second copy of it that drifts.
--
-- No SCHEMA_VERSION bump, and that is a decision rather than an oversight.
-- `_init_schema` runs this script on every open before it looks at the version,
-- so an existing version-4 file gains the table the first time this build opens
-- it, and a version-4 file that already has the table is read correctly by a
-- build that has never heard of it — the older code simply never selects from
-- it. The version guards against a file this code cannot read; both directions
-- here are readable, so bumping it would refuse files for no reason and throw
-- away 146 measured segment scores to do it.
CREATE TABLE IF NOT EXISTS geocode_cache (
    query_key  TEXT PRIMARY KEY,
    payload    TEXT NOT NULL,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_geocode_cache_expires ON geocode_cache(expires_at);

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
        # Every connection handed out, so close() can close all of them.
        #
        # thread-local storage is reachable only from the thread that owns it,
        # and every cache call arrives through run_in_threadpool — so the
        # connections live on anyio worker threads (up to 40) while close()
        # runs on the event loop. Measured: 4 worker threads produced 11 file
        # descriptors on the database and close() left 10 of them open. In the
        # deployed shape, where the loop thread never opens one of its own,
        # it closed nothing at all: 3 before, 3 after.
        #
        # Leaked readers are not just descriptors. An open reader pins the WAL,
        # so it cannot be checkpointed, which is the other half of why the file
        # grows without bound.
        self._all: list[sqlite3.Connection] = []
        self._all_lock = threading.Lock()
        self._closed = False
        self._writes_since_sweep = 0
        self._removed_since_reclaim = 0
        self._writes_lock = threading.Lock()
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
        # A closed cache does not quietly reopen. The lazy connection below used
        # to be left intact by close(), so the next call built a fresh
        # connection and skipped _init_schema — which for :memory: is a database
        # with no tables at all ("no such table: route_cache"), and for a file
        # is a reader on a database the process has declared itself done with.
        #
        # Reachable in the deployed shape: shutdown drains SSE streams only, so
        # a JSON /api/routes or a /readyz already in flight can touch the cache
        # after lifespan has closed it.
        if self._closed:
            raise CacheClosed(
                "This cache was closed. A closed cache does not reopen, because "
                "reopening skips schema setup and hands back a database that is "
                "empty rather than one that is missing."
            )
        if self._shared is not None:
            return self._shared
        conn = getattr(self._local, "conn", None)
        if conn is None:
            conn = self._new_connection()
            self._local.conn = conn
            with self._all_lock:
                self._all.append(conn)
        return conn

    def _init_schema(self) -> None:
        """Create the tables, and refuse a file this code cannot read.

        The version used to be stamped unconditionally, which made it a record
        of the last process to open the file rather than of the file's shape.
        Reproduced: set meta to 1, reopen, and meta silently reads 3 — with the
        v1 columns still in place, because `CREATE TABLE IF NOT EXISTS` adds
        nothing to a table that already exists. `stats()` then reported the
        module constant, so `/api/health` asserted a migration that never ran.

        Where a step exists in _MIGRATIONS it is applied; where none does, the
        file is refused rather than opened and hoped for. A wrong answer out of
        a half-migrated cache is worse than a process that will not start, and
        the fix — delete the file, it is a cache — fits in the error message.
        """
        with self.conn as conn:
            conn.executescript(_SCHEMA)
            row = conn.execute("SELECT value FROM meta WHERE key='schema_version'").fetchone()
            if row is None:
                conn.execute(
                    "INSERT INTO meta(key, value) VALUES('schema_version', ?)",
                    (str(SCHEMA_VERSION),),
                )
                return
            try:
                found = int(row["value"])
            except (TypeError, ValueError):
                found = -1

            while found != SCHEMA_VERSION:
                steps = _MIGRATIONS.get(found)
                if steps is None:
                    raise SchemaVersionMismatch(
                        f"{self.path} was written by schema version {row['value']}, and "
                        f"this build reads version {SCHEMA_VERSION} with no migration "
                        f"from there. This file is a cache and can be deleted: "
                        f"rm {self.path}"
                    )
                for statement in steps:
                    conn.execute(statement)
                found += 1
                conn.execute("UPDATE meta SET value = ? WHERE key='schema_version'",
                             (str(found),))
                log.info("cache_schema_migrated", extra={"to": found})

    def schema_version(self) -> int | None:
        """The version recorded in the file, not the constant this build holds."""
        row = self.conn.execute("SELECT value FROM meta WHERE key='schema_version'").fetchone()
        if row is None:
            return None
        try:
            return int(row["value"])
        except (TypeError, ValueError):
            return None

    # ---- segment scores -------------------------------------------------

    def get_segment_scores(
        self, keys: Iterable[str], variant: str | None = None
    ) -> dict[str, SegmentScore]:
        """Cached CLIP scores for these segment keys.

        ``variant`` filters to rows scored by one prompt variant, and callers on
        the request path must pass it. scoring.py's own table records variants
        disagreeing by up to 0.6 on the same imagery, and ``put_segment_score``
        upserts on ``segment_key`` alone — so a re-warm that stops part-way,
        which ``batch_score.py`` does cleanly whenever the Mapillary budget runs
        out, leaves one route's sample points split across two variants. Read
        without this filter they are length-weighted into a single number and
        labelled ``scoring_method: "clip"``, which reports a blend of two
        different questions as one measurement.

        A row from another variant is *unscored*, not wrong: it lowers coverage
        and says so, rather than biasing the score.

        ``prompt_variant IS NULL`` is excluded for the same reason — a row that
        does not say which question it answered cannot be counted as answering
        this one.
        """
        keys = list(keys)
        if not keys:
            return {}
        out: dict[str, SegmentScore] = {}
        # SQLite caps host parameters at 999; chunk to stay well below it.
        for i in range(0, len(keys), 400):
            chunk = keys[i : i + 400]
            placeholders = ",".join("?" * len(chunk))
            sql = f"SELECT * FROM segment_scores WHERE segment_key IN ({placeholders})"
            params = list(chunk)
            if variant is not None:
                sql += " AND prompt_variant = ?"
                params.append(variant)
            rows = self.conn.execute(sql, params).fetchall()
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

    # ---- whole-route cache ----------------------------------------------

    def get_route(self, cache_key: str) -> dict[str, Any] | None:
        row = self.conn.execute(
            "SELECT payload, expires_at FROM route_cache WHERE cache_key = ?", (cache_key,)
        ).fetchone()
        if row is None:
            return None
        # TypeError as well as ValueError, and the row goes rather than being
        # left in place. `datetime.fromisoformat("2026-01-01T01:00:00")` parses
        # happily and returns a *naive* datetime, and comparing that to an aware
        # `_now()` raises TypeError: can't compare offset-naive and offset-aware
        # datetimes. That is not a RoutingError, so it escaped run_in_threadpool
        # and landed in the un-enveloped 500 — for that key, on every request,
        # until somebody deleted the row by hand.
        #
        # An unreadable row is a miss, and a miss that cannot be read again is
        # better than one that poisons a cache key indefinitely.
        try:
            expires = datetime.fromisoformat(row["expires_at"])
            stale = expires <= _now()
        except (ValueError, TypeError):
            log.warning("route_cache_unreadable_expiry")
            self._delete_route(cache_key)
            return None
        if stale:
            self._delete_route(cache_key)
            return None
        try:
            return json.loads(row["payload"])
        except json.JSONDecodeError:
            log.warning("route_cache_corrupt")
            return None

    def _delete_route(self, cache_key: str) -> None:
        with self.conn as conn:
            conn.execute("DELETE FROM route_cache WHERE cache_key = ?", (cache_key,))

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
        self._maybe_sweep()

    # ---- place-search cache ---------------------------------------------

    def get_geocode(self, query_key: str) -> list[dict[str, Any]] | None:
        """A previous answer for this normalised query, or None.

        Same unreadable-row handling as `get_route`, for the same reason: a row
        whose expiry cannot be parsed is a miss and is deleted, rather than
        raising `TypeError` out of every request for that key until somebody
        removes it by hand.
        """
        row = self.conn.execute(
            "SELECT payload, expires_at FROM geocode_cache WHERE query_key = ?", (query_key,)
        ).fetchone()
        if row is None:
            return None
        try:
            stale = datetime.fromisoformat(row["expires_at"]) <= _now()
        except (ValueError, TypeError):
            log.warning("geocode_cache_unreadable_expiry")
            self._delete_geocode(query_key)
            return None
        if stale:
            self._delete_geocode(query_key)
            return None
        try:
            payload = json.loads(row["payload"])
        except json.JSONDecodeError:
            log.warning("geocode_cache_corrupt")
            return None
        return payload if isinstance(payload, list) else None

    def _delete_geocode(self, query_key: str) -> None:
        with self.conn as conn:
            conn.execute("DELETE FROM geocode_cache WHERE query_key = ?", (query_key,))

    def put_geocode(self, query_key: str, payload: list[dict[str, Any]], ttl_s: int) -> None:
        now = _now()
        with self.conn as conn:
            conn.execute(
                """
                INSERT INTO geocode_cache (query_key, payload, created_at, expires_at)
                VALUES (?,?,?,?)
                ON CONFLICT(query_key) DO UPDATE SET
                    payload=excluded.payload,
                    created_at=excluded.created_at,
                    expires_at=excluded.expires_at
                """,
                (
                    query_key,
                    json.dumps(payload, separators=(",", ":")),
                    _iso(now),
                    _iso(now + timedelta(seconds=ttl_s)),
                ),
            )
        self._maybe_sweep()

    def geocode_cache_size(self) -> int:
        """Rows that are actually still cached, expired ones excluded."""
        row = self.conn.execute(
            "SELECT COUNT(*) AS n FROM geocode_cache WHERE expires_at > ?", (_iso(_now()),)
        ).fetchone()
        return int(row["n"]) if row else 0

    def _maybe_sweep(self) -> None:
        """Sweep every SWEEP_EVERY_N_WRITES writes.

        The only caller of purge_expired_routes used to be startup, so between
        restarts an expired row went only when its exact key was asked for
        again — and a key that is never asked for again is exactly the kind that
        expires. There was no row cap, no periodic sweep and nothing that
        returned space to the filesystem.
        """
        with self._writes_lock:
            self._writes_since_sweep += 1
            if self._writes_since_sweep < SWEEP_EVERY_N_WRITES:
                return
            self._writes_since_sweep = 0
        self.sweep()

    def sweep(self) -> int:
        """Drop expired rows, then the oldest rows above the ceiling. Reclaims space.

        Returns the number of rows removed.

        **Deleting rows does not shrink a SQLite file, and in WAL mode it grows
        it.** Measured on this VM with 200 expired route payloads: the file plus
        its WAL was 6,086,136 bytes, and after `DELETE`-ing all 200 rows it was
        **8,012,632** — 1.9 MB larger for holding nothing. A `VACUUM` on its own
        did not help either, because the pages it rewrites go to the WAL too.

        What actually reclaims is checkpoint, then VACUUM, then checkpoint
        again: 6,086,136 -> 2,949,120 -> 2,990,352 -> **73,728**, an empty file.
        The first checkpoint is what lets VACUUM see the freed pages; the second
        returns what VACUUM itself wrote.

        That matters here more than it would elsewhere: `data/cache.db` is baked
        into the image with no volume mount, so this grows the container's
        writable layer, on a 12 GB VM, until something falls over.

        Only done after a large purge — VACUUM rewrites the whole file and takes
        a write lock for the duration, which is not a thing to do on every
        request.
        """
        removed = self.purge_expired_routes()
        removed += self._evict_over_ceiling()
        # The geocode table is swept by the same pass rather than by a second
        # timer. It shares the file, so it shares the VACUUM that reclaims it,
        # and a table with its own sweep schedule is a table that gets forgotten
        # when somebody changes the other one.
        removed += self.purge_expired_geocodes()
        removed += self._evict_geocodes_over_ceiling()
        if not removed:
            return 0

        # Accumulated across sweeps, not measured within one. A sweep runs every
        # SWEEP_EVERY_N_WRITES writes and so rarely finds more than that many
        # rows to drop; comparing a single sweep's yield against the VACUUM
        # threshold meant the threshold was never reached and nothing was ever
        # reclaimed — which was this fix quietly not working.
        with self._writes_lock:
            self._removed_since_reclaim += removed
            due = self._removed_since_reclaim >= VACUUM_AFTER_ROWS_REMOVED
            if due:
                self._removed_since_reclaim = 0
        if due:
            self._reclaim()
        log.info("route_cache_swept", extra={"rows": removed, "reclaimed": due})
        return removed

    def _evict_over_ceiling(self) -> int:
        """Oldest-first eviction down to ROUTE_CACHE_MAX_ROWS.

        By `created_at`, which for this table is the last time the entry was
        *written* — `put_route` refreshes it on conflict. That is the closest
        thing to recency the table records, and it is the right direction: an
        answer nobody has asked for since it was stored is the one to lose.
        """
        with self.conn as conn:
            over = conn.execute(
                "SELECT COUNT(*) AS n FROM route_cache"
            ).fetchone()["n"] - ROUTE_CACHE_MAX_ROWS
            if over <= 0:
                return 0
            cur = conn.execute(
                "DELETE FROM route_cache WHERE cache_key IN ("
                "  SELECT cache_key FROM route_cache ORDER BY created_at ASC LIMIT ?"
                ")",
                (over,),
            )
            return cur.rowcount or 0

    def _reclaim(self) -> None:
        """Return freed pages to the filesystem. See sweep() for the numbers."""
        conn = self.conn
        try:
            # Outside a transaction — VACUUM cannot run inside one.
            conn.execute("PRAGMA wal_checkpoint(TRUNCATE)")
            conn.execute("VACUUM")
            conn.execute("PRAGMA wal_checkpoint(TRUNCATE)")
        except sqlite3.Error as exc:
            # A busy database is a reason to try again later, not to fail a
            # request. The rows are already gone; only the space is not back.
            log.warning("route_cache_reclaim_failed", extra={"error": type(exc).__name__})

    def purge_expired_routes(self) -> int:
        """Delete every expired row, and every row whose expiry cannot be read.

        The comparison is lexicographic — SQLite has no date type — which is
        correct only while every value is the same shape. `_iso(_now())` always
        carries `+00:00`, so a row written without an offset sorts against a
        string two characters longer and compares wrong in both directions: it
        can survive its own expiry here, and it is the same row that raises
        TypeError out of get_route. Nothing this class writes is offset-free,
        but the table outlives any one version of this file.

        Rather than parse every row on every sweep, the malformed ones are
        matched by shape: an expiry that does not end in an offset is not a
        timestamp this code wrote, and cannot be trusted to have expired.
        """
        with self.conn as conn:
            cur = conn.execute(
                "DELETE FROM route_cache WHERE expires_at <= ? OR expires_at NOT LIKE '%+00:00'",
                (_iso(_now()),),
            )
            return cur.rowcount or 0

    def purge_expired_geocodes(self) -> int:
        """`purge_expired_routes` for the other table, with the same shape test.

        The `NOT LIKE '%+00:00'` clause is not defensive padding: SQLite has no
        date type, so the comparison is lexicographic and is only correct while
        every value is the same shape. A row written without an offset sorts
        against a string two characters longer and compares wrong in *both*
        directions — it can survive its own expiry, and it is the same row that
        raises TypeError out of the getter.
        """
        with self.conn as conn:
            cur = conn.execute(
                "DELETE FROM geocode_cache WHERE expires_at <= ? OR expires_at NOT LIKE '%+00:00'",
                (_iso(_now()),),
            )
            return cur.rowcount or 0

    def _evict_geocodes_over_ceiling(self) -> int:
        """Oldest-first eviction down to GEOCODE_CACHE_MAX_ROWS."""
        with self.conn as conn:
            over = conn.execute(
                "SELECT COUNT(*) AS n FROM geocode_cache"
            ).fetchone()["n"] - GEOCODE_CACHE_MAX_ROWS
            if over <= 0:
                return 0
            cur = conn.execute(
                "DELETE FROM geocode_cache WHERE query_key IN ("
                "  SELECT query_key FROM geocode_cache ORDER BY created_at ASC LIMIT ?"
                ")",
                (over,),
            )
            return cur.rowcount or 0

    def route_cache_size(self) -> int:
        """Rows that are actually still cached.

        Expired rows are excluded. They were counted before, so `/api/health`
        reported a cache larger than anything it could serve from — and since
        the only sweep ran at startup, the overstatement grew for as long as the
        process stayed up.
        """
        row = self.conn.execute(
            "SELECT COUNT(*) AS n FROM route_cache WHERE expires_at > ?", (_iso(_now()),)
        ).fetchone()
        return int(row["n"]) if row else 0

    def stats(self) -> dict[str, Any]:
        return {
            "segments_scored": self.segment_count(),
            "segments_clip": self.clip_segment_count(),
            "routes_cached": self.route_cache_size(),
            "geocodes_cached": self.geocode_cache_size(),
            # Read from the file, not the constant. Reporting the constant made
            # /api/health assert a migration that never ran — it could only ever
            # agree with itself.
            "schema_version": self.schema_version(),
        }

    def close(self) -> None:
        """Close every connection this cache handed out, from any thread.

        Marked closed first, so a call racing this one raises CacheClosed rather
        than opening a connection that will never be closed.
        """
        self._closed = True
        if self._shared is not None:
            self._shared.close()
            self._shared = None
        with self._all_lock:
            connections, self._all = self._all, []
        for conn in connections:
            try:
                conn.close()
            except sqlite3.Error:
                # Already closed, or closed from under us. Nothing to do, and a
                # shutdown path must not raise over a connection it is
                # discarding anyway.
                log.debug("cache_connection_close_failed")
        self._local = threading.local()


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
