from __future__ import annotations

import time

from backend.cache import Cache, segment_key


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


def test_access_tags_round_trip(cache: Cache) -> None:
    key = cache.put_access_tags(51.5073, -0.1657, {"surface": "asphalt", "highway": "footway"})
    assert cache.get_access_tags([key])[key]["surface"] == "asphalt"


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
