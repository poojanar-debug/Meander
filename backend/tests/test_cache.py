from __future__ import annotations

import time

import pytest

from backend.cache import (
    ROUTE_CACHE_MAX_ROWS,
    SCHEMA_VERSION,
    SWEEP_EVERY_N_WRITES,
    VACUUM_AFTER_ROWS_REMOVED,
    Cache,
    SchemaVersionMismatch,
    segment_key,
)


def test_segment_key_is_a_grid_cell_not_a_coordinate() -> None:
    """Two points ~5 m apart must collapse to one cache entry."""
    assert segment_key(51.50731, -0.16571) == segment_key(51.50734, -0.16569)
    assert segment_key(51.5073, -0.1657) != segment_key(51.5090, -0.1657)


def test_segment_key_is_stable_across_float_noise() -> None:
    assert segment_key(6.9271000001, 79.8612) == segment_key(6.9271, 79.86119999)


def test_put_and_get_segment_score_round_trips(cache: Cache) -> None:
    key = cache.put_segment_score(51.5073, -0.1657, 0.81, 12, "clip", "v1")
    got = cache.get_segment_scores([key])

    assert got[key].clip_score == 0.81
    assert got[key].image_count == 12
    assert got[key].scoring_method == "clip"
    assert got[key].prompt_variant == "v1"


def test_segment_score_upsert_overwrites(cache: Cache) -> None:
    key = cache.put_segment_score(51.5073, -0.1657, 0.20, 1, "geometry_only")
    cache.put_segment_score(51.5073, -0.1657, 0.90, 30, "clip", "v3")

    got = cache.get_segment_scores([key])[key]
    assert got.clip_score == 0.90
    assert got.scoring_method == "clip"
    assert cache.segment_count() == 1


def test_get_segment_scores_handles_more_than_one_chunk(cache: Cache) -> None:
    keys = [cache.put_segment_score(51.0 + i / 10000, -0.1, 0.5, 1, "clip") for i in range(450)]
    assert len(cache.get_segment_scores(keys)) == 450


def test_get_segment_scores_empty_input_does_not_query(cache: Cache) -> None:
    assert cache.get_segment_scores([]) == {}


def test_route_cache_round_trips(cache: Cache) -> None:
    cache.put_route("k1", {"routes": [{"id": "fastest"}]}, ttl_s=60)
    assert cache.get_route("k1") == {"routes": [{"id": "fastest"}]}


def test_route_cache_expires(cache: Cache) -> None:
    cache.put_route("k2", {"routes": []}, ttl_s=-1)
    assert cache.get_route("k2") is None
    assert cache.route_cache_size() == 0


def test_route_cache_miss_returns_none(cache: Cache) -> None:
    assert cache.get_route("never-written") is None


def test_purge_expired_routes_leaves_live_entries(cache: Cache) -> None:
    cache.put_route("live", {"a": 1}, ttl_s=300)
    cache.put_route("dead", {"a": 2}, ttl_s=-5)

    assert cache.purge_expired_routes() == 1
    assert cache.get_route("live") == {"a": 1}


def test_clip_segment_count_only_counts_clip_rows(cache: Cache) -> None:
    cache.put_segment_score(51.0, -0.1, 0.5, 4, "clip")
    cache.put_segment_score(51.1, -0.1, 0.5, 0, "geometry_only")

    assert cache.segment_count() == 2
    assert cache.clip_segment_count() == 1


def test_stats_shape(cache: Cache) -> None:
    stats = cache.stats()
    assert stats["schema_version"] >= 1
    assert stats["segments_scored"] == 0


def test_schema_is_idempotent(tmp_cache_db) -> None:
    first = Cache(tmp_cache_db)
    first.put_segment_score(51.0, -0.1, 0.4, 2, "clip")
    first.close()

    second = Cache(tmp_cache_db)
    try:
        assert second.segment_count() == 1
    finally:
        second.close()


def test_updated_at_is_written(cache: Cache) -> None:
    key = cache.put_segment_score(51.0, -0.1, 0.4, 2, "clip")
    before = cache.get_segment_scores([key])[key].updated_at
    time.sleep(0.001)
    assert before


# ---------------------------------------------------------------------------
# expiry that cannot be read
# ---------------------------------------------------------------------------


def test_a_naive_expiry_is_a_miss_not_a_five_hundred(cache: Cache) -> None:
    """`datetime.fromisoformat` parses an offset-free timestamp happily and
    returns a naive datetime; comparing that to an aware now() raises
    TypeError, not ValueError. Only ValueError was caught, so it escaped
    run_in_threadpool, was not a RoutingError, and became an un-enveloped 500 —
    for that cache key, on every request, until someone deleted the row by hand.
    """
    cache.put_route("k", {"routes": []}, ttl_s=3600)
    with cache.conn as conn:
        conn.execute(
            "UPDATE route_cache SET expires_at = ? WHERE cache_key = ?",
            ("2099-01-01T01:00:00", "k"),
        )

    assert cache.get_route("k") is None
    # And the row is gone, so the next request is a clean miss rather than the
    # same failure again.
    assert cache.get_route("k") is None
    with cache.conn as conn:
        remaining = conn.execute(
            "SELECT COUNT(*) AS n FROM route_cache WHERE cache_key = 'k'"
        ).fetchone()["n"]
    assert remaining == 0


def test_a_garbage_expiry_is_also_a_miss(cache: Cache) -> None:
    cache.put_route("k", {"routes": []}, ttl_s=3600)
    with cache.conn as conn:
        conn.execute("UPDATE route_cache SET expires_at = 'tomorrow' WHERE cache_key = 'k'")

    assert cache.get_route("k") is None


def test_purge_removes_rows_whose_expiry_is_the_wrong_shape(cache: Cache) -> None:
    """The sweep compares strings, which is only correct while every value has
    the same shape. An offset-free row sorts against a string two characters
    longer and can outlive its own expiry."""
    cache.put_route("good", {"routes": []}, ttl_s=3600)
    cache.put_route("naive", {"routes": []}, ttl_s=3600)
    with cache.conn as conn:
        conn.execute(
            "UPDATE route_cache SET expires_at = '2099-01-01T01:00:00' WHERE cache_key = 'naive'"
        )

    removed = cache.purge_expired_routes()

    assert removed == 1
    assert cache.get_route("good") is not None


def test_expired_rows_are_not_counted_as_cached(cache: Cache) -> None:
    """/api/health reported a cache bigger than anything it could serve from,
    and since the only sweep ran at startup the overstatement grew for as long
    as the process stayed up."""
    cache.put_route("live", {"routes": []}, ttl_s=3600)
    cache.put_route("dead", {"routes": []}, ttl_s=3600)
    with cache.conn as conn:
        conn.execute(
            "UPDATE route_cache SET expires_at = '2000-01-01T00:00:00+00:00' "
            "WHERE cache_key = 'dead'"
        )

    assert cache.route_cache_size() == 1


# ---------------------------------------------------------------------------
# the schema version, and the one migration that exists
# ---------------------------------------------------------------------------


def test_a_v3_file_is_migrated_rather_than_overstamped(tmp_path) -> None:
    """The version used to be written unconditionally, so opening an old file
    stamped it with the current number while leaving its old shape in place —
    reproduced by setting meta to 1 and reopening, which read back 3.

    Now the one step that exists is applied, and the dead table it drops is
    actually gone afterwards.
    """
    path = tmp_path / "v3.db"
    first = Cache(path)
    with first.conn as conn:
        conn.execute(
            "CREATE TABLE IF NOT EXISTS access_segments ("
            " segment_key TEXT PRIMARY KEY, lat REAL, lon REAL,"
            " tags_json TEXT, updated_at TEXT)"
        )
        conn.execute("UPDATE meta SET value='3' WHERE key='schema_version'")
    first.close()

    reopened = Cache(path)

    assert reopened.schema_version() == SCHEMA_VERSION
    tables = {
        r["name"]
        for r in reopened.conn.execute(
            "SELECT name FROM sqlite_master WHERE type='table'"
        ).fetchall()
    }
    assert "access_segments" not in tables
    assert "segment_scores" in tables, "the migration must not take the real tables with it"
    reopened.close()


def test_a_version_with_no_migration_is_refused(tmp_path) -> None:
    """A cache is safe to delete, so refusing costs a recomputation rather than
    data — and a wrong answer out of a half-migrated file is worse than a
    process that will not start."""
    path = tmp_path / "ancient.db"
    first = Cache(path)
    with first.conn as conn:
        conn.execute("UPDATE meta SET value='1' WHERE key='schema_version'")
    first.close()

    with pytest.raises(SchemaVersionMismatch, match="no migration"):
        Cache(path)


# ---------------------------------------------------------------------------
# the route cache is bounded and gives space back
# ---------------------------------------------------------------------------


def _payload() -> dict:
    return {"routes": [{"id": "fastest", "geometry": [[0.1, 51.5]] * 900}]}


def _bytes_on_disk(path) -> int:
    return sum(
        (path.parent / (path.name + suffix)).stat().st_size
        for suffix in ("", "-wal", "-shm")
        if (path.parent / (path.name + suffix)).exists()
    )


def test_expired_rows_go_without_being_asked_for_again(tmp_path) -> None:
    """purge_expired_routes had exactly one caller: startup. Between restarts an
    expired row went only when its exact key was requested again — and a key
    nobody asks for again is precisely the kind that expires."""
    cache = Cache(tmp_path / "sweep.db")
    for i in range(SWEEP_EVERY_N_WRITES * 2):
        cache.put_route(f"k{i}", _payload(), ttl_s=-1)

    assert cache.route_cache_size() == 0
    with cache.conn as conn:
        assert conn.execute("SELECT COUNT(*) AS n FROM route_cache").fetchone()["n"] == 0
    cache.close()


def test_the_row_count_stops_at_the_ceiling(tmp_path) -> None:
    """Unbounded growth was the finding. Writes past the ceiling evict the
    oldest rather than accumulating."""
    cache = Cache(tmp_path / "ceiling.db")
    for i in range(ROUTE_CACHE_MAX_ROWS * 2):
        cache.put_route(f"k{i}", _payload(), ttl_s=3600)

    # Bounded by the ceiling plus at most one sweep interval of overshoot,
    # because the sweep is periodic rather than per-write.
    assert cache.route_cache_size() <= ROUTE_CACHE_MAX_ROWS + SWEEP_EVERY_N_WRITES
    cache.close()


def test_the_newest_entries_are_the_ones_kept(tmp_path) -> None:
    cache = Cache(tmp_path / "lru.db")
    for i in range(ROUTE_CACHE_MAX_ROWS * 2):
        cache.put_route(f"k{i}", _payload(), ttl_s=3600)

    assert cache.get_route(f"k{ROUTE_CACHE_MAX_ROWS * 2 - 1}") is not None
    assert cache.get_route("k0") is None
    cache.close()


def test_deleting_rows_gives_the_space_back(tmp_path) -> None:
    """**Deleting rows does not shrink a SQLite file, and in WAL mode it grows
    it.** Measured on this VM: 200 expired payloads occupied 6,086,136 bytes,
    and after DELETE-ing all 200 the file was 8,012,632 — 1.9 MB larger for
    holding nothing. A VACUUM alone did not help either, because the pages it
    rewrites go to the WAL as well.

    Checkpoint, VACUUM, checkpoint took the same file to 73,728 bytes.
    `data/cache.db` is baked into the image with no volume mount, so this grew
    the container's writable layer on a 12 GB VM.
    """
    path = tmp_path / "reclaim.db"
    cache = Cache(path)
    # Written live and expired afterwards, so the periodic sweep does not
    # reclaim them on the way in and leave nothing to measure.
    for i in range(VACUUM_AFTER_ROWS_REMOVED * 3):
        cache.put_route(f"k{i}", _payload(), ttl_s=3600)
    peak = _bytes_on_disk(path)
    with cache.conn as conn:
        conn.execute("UPDATE route_cache SET expires_at = '2000-01-01T00:00:00+00:00'")

    cache.sweep()

    assert cache.route_cache_size() == 0
    assert _bytes_on_disk(path) < peak / 2, "the sweep freed rows but not space"
    cache.close()
