"""CLIP scoring.

Most of this runs without torch, on purpose: the deployed instance has no torch
and the request path must still behave correctly there. The one test that does
need torch is skipped when it is absent rather than silently passing.
"""

from __future__ import annotations

import dataclasses
import importlib.util

import httpx
import pytest

from backend import config, scoring
from backend import fixtures as fx
from backend.cache import Cache
from backend.geometry import LatLon
from backend.scoring import (
    ACTIVE_PROMPT_VARIANT,
    MAPILLARY_BBOX_HALF_DEG,
    MAPILLARY_BBOX_MIN_HALF_DEG,
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
        cache.put_segment_score(sample.point.lat, sample.point.lon, 0.8, 4, "clip",
                                ACTIVE_PROMPT_VARIANT)

    term = clip_term_for_route(points, cache)
    assert term.score == pytest.approx(0.8)
    assert term.coverage > 0.9
    assert term.points_scored == term.points_sampled


def test_a_score_from_another_variant_is_unscored_not_borrowed(cache: Cache) -> None:
    """**Changed behaviour.** This route used to be seeded with `v3_nature`,
    read back while the active variant was `v2_plain`, and asserted to score
    0.8 — pinning the defect.

    The variant is on the row because, in this module's own words, changing
    ACTIVE_PROMPT_VARIANT changes every score; the table above records variants
    disagreeing by up to 0.6 on the same imagery. Nothing on the read path used
    it. `put_segment_score` upserts on `segment_key` alone and `batch_score.py`
    stops cleanly when the Mapillary budget runs out mid-run, so one interrupted
    re-warm leaves a route's samples split across two variants — length-weighted
    into a single number and labelled `scoring_method: "clip"`.

    An off-variant row is *unscored*: it lowers coverage, which is a true
    statement about how much of this route has been measured by the question
    being asked, rather than biasing the answer with a different question's.
    """
    points = _line(HYDE, 900)
    from backend.geometry import sample_every
    from backend.scoring import MAX_SAMPLE_POINTS, SAMPLE_SPACING_M

    for sample in sample_every(points, SAMPLE_SPACING_M, MAX_SAMPLE_POINTS):
        cache.put_segment_score(sample.point.lat, sample.point.lon, 0.8, 4, "clip", "v3_nature")

    term = clip_term_for_route(points, cache)

    assert term.score is None
    assert term.coverage == 0.0
    assert term.points_scored == 0
    # And it still knows it looked, which is what makes the coverage honest.
    assert term.points_sampled > 0


def test_an_interrupted_rewarm_does_not_blend_two_variants(cache: Cache) -> None:
    """The half-and-half state batch_score.py leaves when its budget runs out."""
    from backend.geometry import sample_every
    from backend.scoring import MAX_SAMPLE_POINTS, SAMPLE_SPACING_M

    points = _line(HYDE, 1200)
    samples = sample_every(points, SAMPLE_SPACING_M, MAX_SAMPLE_POINTS)
    half = len(samples) // 2
    for sample in samples[:half]:
        cache.put_segment_score(sample.point.lat, sample.point.lon, 0.9, 4, "clip",
                                ACTIVE_PROMPT_VARIANT)
    for sample in samples[half:]:
        cache.put_segment_score(sample.point.lat, sample.point.lon, 0.3, 4, "clip", "v3_nature")

    term = clip_term_for_route(points, cache)

    # 0.9 from the half that answers this question, not a blend with 0.3.
    assert term.score == pytest.approx(0.9)
    assert 0.2 < term.coverage < 0.8


def test_a_row_with_no_variant_at_all_is_unscored(cache: Cache) -> None:
    """A row that does not say which question it answered cannot be counted as
    answering this one."""
    from backend.geometry import sample_every
    from backend.scoring import MAX_SAMPLE_POINTS, SAMPLE_SPACING_M

    points = _line(HYDE, 900)
    for sample in sample_every(points, SAMPLE_SPACING_M, MAX_SAMPLE_POINTS):
        cache.put_segment_score(sample.point.lat, sample.point.lon, 0.8, 4, "clip")

    assert clip_term_for_route(points, cache).score is None


def test_partial_coverage_is_reported_as_partial(cache: Cache) -> None:
    from backend.geometry import sample_every
    from backend.scoring import MAX_SAMPLE_POINTS, SAMPLE_SPACING_M

    points = _line(HYDE, 1200)
    samples = sample_every(points, SAMPLE_SPACING_M, MAX_SAMPLE_POINTS)
    for sample in samples[: len(samples) // 2]:
        # **Now seeded with the active variant.** These rows used to be written
        # with prompt_variant NULL and read back regardless, which is the
        # behaviour being fixed: the request path counts only rows scored by the
        # question it is asking.
        cache.put_segment_score(sample.point.lat, sample.point.lon, 0.6, 3, "clip",
                                ACTIVE_PROMPT_VARIANT)

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
        cache.put_segment_score(sample.point.lat, sample.point.lon, None, 1, "clip",
                                ACTIVE_PROMPT_VARIANT)

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
def test_the_contrastive_softmax_is_the_right_way_round() -> None:
    """Pipeline check on generated reference images.

    **Deliberately not run against ACTIVE_PROMPT_VARIANT**, and that is the
    whole lesson of this phase. This used to assert the active pair separates on
    a foliage texture versus an asphalt texture, which conflates two unrelated
    claims: "the model loads and the softmax is the right way round" and "this
    prompt pair is a good choice". Generated textures answer the first and
    actively mislead on the second — four pairs invert on them, including the
    one real imagery later showed to be the best of the seven. Left as it was,
    this test would have blocked the correct choice.

    So it pins the pipeline using a pair known to separate on *these* images,
    and the prompt choice is pinned separately, from real imagery, below.
    """
    _require_clip_weights()
    from scripts.compare_prompts import _asphalt_image, _foliage_image

    green = score_images([_foliage_image(i) for i in range(3)], "v3_nature")
    grim = score_images([_asphalt_image(i) for i in range(3)], "v3_nature")

    assert sum(green) / len(green) > sum(grim) / len(grim)
    assert all(0.0 <= s <= 1.0 for s in green + grim)


def test_the_active_variant_is_one_that_held_on_real_imagery() -> None:
    """Of seven variants across three real Mapillary pairs, only these two
    pointed the right way every time — see the table in scoring.py.

    v3_nature and v5_street both invert on the Colombo pair, calling the city
    fort greener than the park, and an inverted score is a wrong one rather than
    a weak one. This guard exists so a future edit cannot quietly reinstate a
    variant that was measured to invert.
    """
    assert ACTIVE_PROMPT_VARIANT in {"v2_plain", "v1_extreme"}


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
    # the scoring path is stated separately by scoring_method. The subject is
    # "Surface data" wherever no barrier source was consulted — asserted loosely
    # here because which subject is correct is test_accessibility.py's business.
    assert "covers" in route.confidence_note and "of this route" in route.confidence_note


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


# --- the dense-bbox refusal ------------------------------------------------
#
# Found with a real token against Euston Road. Mapillary answers a bbox it
# considers too dense with HTTP 500 and "Please reduce the amount of data you're
# asking for" — regardless of `limit`, which bounds rows returned rather than
# rows scanned. Density is a proxy for how photographed a place is, so the
# failure lands squarely on busy arterial roads: Hyde Park answered first time
# while Euston Road, 2 km away, failed on every attempt at the default box.


def _mapillary_transport(monkeypatch, handler) -> dict[str, list[str]]:
    """Point the shared client at a handler and record the bboxes it is asked for.

    `Settings` is frozen, so the token arrives as a replaced copy swapped into
    the module rather than as an assignment to the field.
    """
    seen: dict[str, list[str]] = {"bbox": []}

    def wrapped(request: httpx.Request) -> httpx.Response:
        seen["bbox"].append(request.url.params.get("bbox", ""))
        return handler(request, len(seen["bbox"]))

    monkeypatch.setattr(
        fx, "_client", httpx.AsyncClient(transport=httpx.MockTransport(wrapped))
    )
    monkeypatch.setattr(
        scoring,
        "settings",
        dataclasses.replace(scoring.settings, mapillary_token="MLY|test|token"),
    )
    return seen


def _too_dense() -> httpx.Response:
    return httpx.Response(
        500,
        json={"error": {"code": 1,
                        "message": "Please reduce the amount of data you're asking "
                                   "for, then retry your request"}},
    )


def _bbox_half_width(bbox: str) -> float:
    min_lon, _, max_lon, _ = (float(v) for v in bbox.split(","))
    return (max_lon - min_lon) / 2


@pytest.mark.asyncio
async def test_a_bbox_refused_as_too_dense_is_narrowed_and_retried(
    tmp_fixture_dir, fixture_mode, monkeypatch
) -> None:
    """The busiest streets are the ones this fails on, and they are the ones that
    most need scoring — giving up would mean CLIP only ever sees quiet places."""
    def handler(request: httpx.Request, attempt: int) -> httpx.Response:
        if attempt == 1:
            return _too_dense()
        return httpx.Response(200, json={"data": [
            {"id": "1", "thumb_1024_url": "https://example.invalid/1.jpg",
             "computed_geometry": {"type": "Point", "coordinates": [-0.1657, 51.5073]}},
        ]})

    seen = _mapillary_transport(monkeypatch, handler)
    monkeypatch.setattr(
        fx, "_budget", fx.LiveCallBudget(tmp_fixture_dir / "b.json", caps={"mapillary": 10})
    )
    fixture_mode("live")

    images = await fetch_images_near(HYDE)

    assert len(images) == 1
    assert len(seen["bbox"]) == 2, "it should have retried exactly once"
    first, second = (_bbox_half_width(b) for b in seen["bbox"])
    assert first == pytest.approx(MAPILLARY_BBOX_HALF_DEG, abs=1e-9)
    assert second == pytest.approx(first / 2, abs=1e-9)


@pytest.mark.asyncio
async def test_narrowing_stops_at_the_floor_rather_than_shrinking_for_ever(
    tmp_fixture_dir, fixture_mode, monkeypatch
) -> None:
    """Below the floor "imagery near this point" stops being a claim about the
    point, so it raises instead of returning imagery from a 5 m box."""
    seen = _mapillary_transport(monkeypatch, lambda request, attempt: _too_dense())
    monkeypatch.setattr(
        fx, "_budget", fx.LiveCallBudget(tmp_fixture_dir / "b.json", caps={"mapillary": 50})
    )
    fixture_mode("live")

    with pytest.raises(ScoringUnavailable, match="Mapillary returned 500"):
        await fetch_images_near(HYDE)

    # 0.002 -> 0.001 -> 0.0005 -> 0.00025, and then it gives up. The tolerance
    # is float slop from repeated halving, not slack in the rule.
    assert len(seen["bbox"]) == 4
    smallest = min(_bbox_half_width(b) for b in seen["bbox"])
    assert smallest == pytest.approx(MAPILLARY_BBOX_MIN_HALF_DEG, rel=1e-6)


@pytest.mark.asyncio
async def test_a_500_that_is_not_the_density_refusal_is_not_retried(
    tmp_fixture_dir, fixture_mode, monkeypatch
) -> None:
    """`code: 1` alone is Facebook's generic "unknown error". Narrowing the box
    for an unrelated outage would triple the spend and fix nothing."""
    seen = _mapillary_transport(
        monkeypatch,
        lambda request, attempt: httpx.Response(
            500, json={"error": {"code": 1, "message": "An unknown error occurred"}}
        ),
    )
    monkeypatch.setattr(
        fx, "_budget", fx.LiveCallBudget(tmp_fixture_dir / "b.json", caps={"mapillary": 10})
    )
    fixture_mode("live")

    with pytest.raises(ScoringUnavailable, match="Mapillary returned 500"):
        await fetch_images_near(HYDE)

    assert len(seen["bbox"]) == 1, "a generic 500 must not be retried"


@pytest.mark.asyncio
async def test_every_narrowed_retry_is_charged_to_the_budget(
    tmp_fixture_dir, fixture_mode, monkeypatch
) -> None:
    """A retry is a second request. Not charging it would let one dense point
    spend several live calls off the books, which is how a budget stops working.

    `record`, not `live`: live mode is deliberately uncapped — it is the mode a
    person picks to record fixtures on purpose — and never touches the counter.
    Metering only exists on the record path, which is the one this asserts.
    """
    def handler(request: httpx.Request, attempt: int) -> httpx.Response:
        return _too_dense() if attempt < 3 else httpx.Response(200, json={"data": []})

    _mapillary_transport(monkeypatch, handler)
    budget = fx.LiveCallBudget(tmp_fixture_dir / "b.json", caps={"mapillary": 10})
    monkeypatch.setattr(fx, "_budget", budget)
    fixture_mode("record")

    await fetch_images_near(HYDE)

    assert budget.spent("mapillary") == 3
