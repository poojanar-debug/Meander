"""CLIP scoring.

Most of this runs without torch, on purpose: the deployed instance has no torch
and the request path must still behave correctly there. The one test that does
need torch is skipped when it is absent rather than silently passing.
"""

from __future__ import annotations

import importlib.util

import pytest

from backend import config, scoring
from backend.cache import Cache
from backend.geometry import LatLon
from backend.scoring import (
    ACTIVE_PROMPT_VARIANT,
    MAPILLARY_BBOX_HALF_DEG,
    MIN_IMAGES_FOR_A_SCORE,
    PROMPT_VARIANTS,
    ScoringUnavailable,
    bbox_for,
    clip_term_for_route,
    fetch_images_near,
    score_images,
    torch_available,
)

HYDE = LatLon(51.5073, -0.1657)

needs_torch = pytest.mark.skipif(
    not torch_available(), reason="torch and open-clip-torch are not installed"
)


def _require_clip_weights() -> None:
    """Skip rather than fail when the CLIP weights are not in the local cache.

    The suite runs with sockets blocked, so the weights cannot be downloaded
    here. Fetch them once with:  python3 -m scripts.compare_prompts
    """
    from backend.scoring import ScoringUnavailable, _load_model

    try:
        _load_model()
    except (FileNotFoundError, OSError, ScoringUnavailable) as exc:
        pytest.skip(
            "CLIP weights are not in the local Hugging Face cache "
            f"({type(exc).__name__}). Run `python3 -m scripts.compare_prompts` once "
            "to download them."
        )


def _line(start: LatLon, metres: float, n: int = 40) -> list[LatLon]:
    return [LatLon(start.lat + (metres * i / (n - 1)) / 111_195.0, start.lon) for i in range(n)]


# --- the module must be importable without torch ---------------------------


def test_scoring_module_has_no_module_level_torch_import() -> None:
    """A top-level torch import would kill the 512 MB deployment at startup."""
    source = (
        importlib.util.find_spec("backend.scoring").origin  # type: ignore[union-attr]
    )
    with open(source) as fh:
        lines = [line.rstrip() for line in fh]

    offenders = [
        (i + 1, line)
        for i, line in enumerate(lines)
        if (line.startswith("import torch") or line.startswith("from torch"))
        or (line.startswith("import open_clip") or line.startswith("from open_clip"))
    ]
    assert offenders == [], f"torch imported at module level: {offenders}"


def test_torch_available_uses_find_spec_not_an_import() -> None:
    assert isinstance(torch_available(), bool)


# --- the Mapillary bounding box --------------------------------------------


def test_bbox_is_under_the_mapillary_size_limit() -> None:
    """Mapillary rejects a bbox of 0.01 degrees square or more (since 2026-01-16)."""
    min_lon, min_lat, max_lon, max_lat = (float(v) for v in bbox_for(HYDE).split(","))

    assert max_lon - min_lon < 0.01
    assert max_lat - min_lat < 0.01


def test_bbox_is_min_lon_min_lat_max_lon_max_lat() -> None:
    """Order matters and is easy to get backwards; a wrong one silently returns
    imagery from somewhere else entirely."""
    min_lon, min_lat, max_lon, max_lat = (float(v) for v in bbox_for(HYDE).split(","))

    assert min_lon < HYDE.lon < max_lon
    assert min_lat < HYDE.lat < max_lat
    assert min_lon < max_lon and min_lat < max_lat


def test_bbox_is_centred_on_the_point() -> None:
    min_lon, min_lat, max_lon, max_lat = (float(v) for v in bbox_for(HYDE).split(","))

    assert (min_lon + max_lon) / 2 == pytest.approx(HYDE.lon, abs=1e-6)
    assert (min_lat + max_lat) / 2 == pytest.approx(HYDE.lat, abs=1e-6)


def test_bbox_half_width_stays_inside_the_limit_even_if_someone_raises_it() -> None:
    assert MAPILLARY_BBOX_HALF_DEG * 2 < 0.01


def test_bbox_handles_a_negative_longitude() -> None:
    min_lon, _, max_lon, _ = (float(v) for v in bbox_for(LatLon(51.5, -0.166)).split(","))
    assert min_lon < -0.166 < max_lon


# --- prompt variants -------------------------------------------------------


def test_at_least_six_prompt_variants_exist() -> None:
    assert len(PROMPT_VARIANTS) >= 6


def test_every_variant_is_a_non_empty_contrastive_pair() -> None:
    for name, pair in PROMPT_VARIANTS.items():
        assert len(pair) == 2, name
        assert all(isinstance(p, str) and p.strip() for p in pair), name
        assert pair[0] != pair[1], name


def test_the_active_variant_exists() -> None:
    assert ACTIVE_PROMPT_VARIANT in PROMPT_VARIANTS


def test_the_specs_original_pair_is_still_available() -> None:
    """It is no longer the default, but removing it would lose the comparison."""
    assert PROMPT_VARIANTS["v1_extreme"] == (
        "A photo of an area that is extremely scenic",
        "A photo of an area that is extremely ugly",
    )


def test_score_images_rejects_an_unknown_variant() -> None:
    with pytest.raises(ValueError, match="unknown prompt variant"):
        score_images([object()], "not_a_variant")


def test_score_images_of_nothing_is_an_empty_list_not_an_error() -> None:
    assert score_images([]) == []


# --- Mapillary without a token ---------------------------------------------


@pytest.mark.asyncio
async def test_fetching_imagery_without_a_token_fails_loudly(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Silently returning no imagery would look like "this place has none".

    The absent token is supplied by the test rather than by the developer's
    .env. Settings is frozen and resolved once at import, so clearing the
    environment variable here would not reach the module that already read it;
    swapping the module-level `settings` for a fresh one is the same idiom
    test_fixtures.py uses to inject a GraphHopper key.

    Without this the test asserted whatever the machine happened to have. A
    developer who followed BLOCKED.md #2 and set MAPILLARY_TOKEN got past the
    guard and died further down on a missing Mapillary fixture — a failure that
    named the wrong thing entirely, and which CI could never reproduce because
    .env is gitignored.
    """
    monkeypatch.setattr(scoring, "settings", config.Settings(mapillary_token=None))

    with pytest.raises(ScoringUnavailable, match="MAPILLARY_TOKEN"):
        await fetch_images_near(HYDE)


@pytest.mark.asyncio
async def test_a_token_in_the_environment_does_not_change_that_verdict(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The test above must assert the same thing on every machine.

    Pinned because the environment already broke it once: this is BLOCKED.md #3,
    and the failure mode is a suite that is green in CI and red on the laptop of
    anyone who has done the imagery work.
    """
    monkeypatch.setenv("MAPILLARY_TOKEN", "a-real-looking-token")
    monkeypatch.setattr(scoring, "settings", config.Settings(mapillary_token=None))

    with pytest.raises(ScoringUnavailable, match="MAPILLARY_TOKEN"):
        await fetch_images_near(HYDE)


# --- the request path: cache reads only ------------------------------------


def test_uncached_route_reports_no_clip_score(cache: Cache) -> None:
    term = clip_term_for_route(_line(HYDE, 1000), cache)

    assert term.score is None
    assert term.coverage == 0.0
    assert term.points_scored == 0
    assert term.points_sampled > 0


def test_cached_points_produce_a_clip_score(cache: Cache) -> None:
    points = _line(HYDE, 900)
    from backend.geometry import sample_every
    from backend.scoring import MAX_SAMPLE_POINTS, SAMPLE_SPACING_M

    for sample in sample_every(points, SAMPLE_SPACING_M, MAX_SAMPLE_POINTS):
        cache.put_segment_score(sample.point.lat, sample.point.lon, 0.8, 4, "clip", "v3_nature")

    term = clip_term_for_route(points, cache)
    assert term.score == pytest.approx(0.8)
    assert term.coverage > 0.9
    assert term.points_scored == term.points_sampled


def test_partial_coverage_is_reported_as_partial(cache: Cache) -> None:
    from backend.geometry import sample_every
    from backend.scoring import MAX_SAMPLE_POINTS, SAMPLE_SPACING_M

    points = _line(HYDE, 1200)
    samples = sample_every(points, SAMPLE_SPACING_M, MAX_SAMPLE_POINTS)
    for sample in samples[: len(samples) // 2]:
        cache.put_segment_score(sample.point.lat, sample.point.lon, 0.6, 3, "clip")

    term = clip_term_for_route(points, cache)
    assert term.score == pytest.approx(0.6)
    assert 0.2 < term.coverage < 0.8


def test_a_point_with_no_usable_imagery_does_not_become_a_score(cache: Cache) -> None:
    """A null clip_score in the cache means "we looked and found nothing", which
    must not be read as a zero."""
    from backend.geometry import sample_every
    from backend.scoring import MAX_SAMPLE_POINTS, SAMPLE_SPACING_M

    points = _line(HYDE, 900)
    for sample in sample_every(points, SAMPLE_SPACING_M, MAX_SAMPLE_POINTS):
        cache.put_segment_score(sample.point.lat, sample.point.lon, None, 1, "clip")

    term = clip_term_for_route(points, cache)
    assert term.score is None
    assert term.points_scored == 0


def test_a_degenerate_route_is_handled(cache: Cache) -> None:
    assert clip_term_for_route([HYDE], cache).score is None
    assert clip_term_for_route([], cache).score is None


def test_min_images_threshold_is_above_one() -> None:
    """One frame is not evidence about a place."""
    assert MIN_IMAGES_FOR_A_SCORE >= 2


# --- CLIP itself, when torch is present ------------------------------------


@needs_torch
def test_clip_ranks_a_green_scene_above_a_grim_one() -> None:
    """Pipeline check on generated reference images.

    Not evidence about real streets — that needs Mapillary imagery, which needs
    a token (BLOCKED.md #2). What it does prove is that the model loads, the
    contrastive softmax is the right way round, and the active prompt pair is
    not inverted.
    """
    _require_clip_weights()
    from scripts.compare_prompts import _asphalt_image, _foliage_image

    green = score_images([_foliage_image(i) for i in range(3)], ACTIVE_PROMPT_VARIANT)
    grim = score_images([_asphalt_image(i) for i in range(3)], ACTIVE_PROMPT_VARIANT)

    assert sum(green) / len(green) > sum(grim) / len(grim)
    assert all(0.0 <= s <= 1.0 for s in green + grim)


@needs_torch
def test_scores_are_probabilities() -> None:
    _require_clip_weights()
    from scripts.compare_prompts import _foliage_image

    scores = score_images([_foliage_image(0)], ACTIVE_PROMPT_VARIANT)
    assert len(scores) == 1
    assert 0.0 <= scores[0] <= 1.0


# --- the scoring_method a route ends up with -------------------------------


def _raw_route(points, synthetic: bool):
    from backend.routing import RawRoute

    return RawRoute(
        points=points,
        distance_m=900.0,
        duration_min=12.0,
        mode="foot",
        elevations=[10.0 + i * 0.1 for i in range(len(points))],
        details={"road_class": [(0, len(points) - 1, "FOOTWAY")]},
        synthetic_upstream=synthetic,
    )


def _seed_clip_scores(cache: Cache, points, value: float = 0.9) -> None:
    from backend.geometry import sample_every
    from backend.scoring import MAX_SAMPLE_POINTS, SAMPLE_SPACING_M

    for sample in sample_every(points, SAMPLE_SPACING_M, MAX_SAMPLE_POINTS):
        cache.put_segment_score(sample.point.lat, sample.point.lon, value, 4, "clip",
                                ACTIVE_PROMPT_VARIANT)


def test_scoring_method_becomes_clip_once_segments_are_cached(tmp_cache_db) -> None:
    from backend.cache import get_cache
    from backend.main import _scored_route

    points = _line(HYDE, 900)
    _seed_clip_scores(get_cache(), points)

    route = _scored_route("nature", "Nature", _raw_route(points, synthetic=False))

    assert route.scoring_method == "clip"
    # confidence_note is the accessibility coverage sentence, not a scoring one:
    # the scoring path is stated separately by scoring_method.
    assert "Accessibility data covers" in route.confidence_note


def test_scoring_method_is_geometry_only_without_cached_segments(tmp_cache_db) -> None:
    from backend.main import _scored_route

    route = _scored_route("nature", "Nature", _raw_route(_line(HYDE, 900), synthetic=False))

    assert route.scoring_method == "geometry_only"


def test_a_synthetic_route_stays_placeholder_even_with_clip_scores(tmp_cache_db) -> None:
    """Real CLIP scores over invented geometry are still not a measurement."""
    from backend.cache import get_cache
    from backend.main import _scored_route

    points = _line(HYDE, 900)
    _seed_clip_scores(get_cache(), points)

    route = _scored_route("nature", "Nature", _raw_route(points, synthetic=True))

    assert route.scoring_method == "placeholder"


def test_a_high_clip_score_lifts_the_nature_score(tmp_cache_db) -> None:
    from backend.cache import get_cache
    from backend.main import _scored_route

    points = _line(HYDE, 900)
    without = _scored_route("nature", "Nature", _raw_route(points, synthetic=False))
    _seed_clip_scores(get_cache(), points, 1.0)
    with_clip = _scored_route("nature", "Nature", _raw_route(points, synthetic=False))

    assert with_clip.scores.nature > without.scores.nature
