"""CLIP scenery scoring over Mapillary street-level imagery.

**Every torch import in this file is inside a function.** Importing this module
must stay free on the 512 MB deployment, where torch does not exist and where
importing it would end the process. `clip_term_for_route` — the only function
the request path calls — reads `data/cache.db` and never touches torch at all.

The split:

    local, backend/batch_score.py          deployed, backend/main.py
    ------------------------------         ---------------------------
    Mapillary imagery per sample point      reads data/cache.db
    CLIP inference on MPS                   numpy-only geometry.py
    writes data/cache.db                    no torch, ever

Scoring is contrastive zero-shot: one positive prompt, one negative prompt,
softmax over the pair, take the positive probability. The prompt pair is a
config constant because it materially changes the numbers — see
PROMPT_VARIANTS and the comparison recorded in PROGRESS.md.
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass
from typing import Any

import httpx

from .cache import Cache, get_cache, segment_key
from .config import MAPILLARY_URL, settings
from .fixtures import BudgetExhausted, FixtureMissing, fetch
from .geometry import LatLon, sample_every, segment_lengths_m
from .logging_setup import get_logger

log = get_logger(__name__)

CLIP_MODEL_NAME = "ViT-B-32"
CLIP_PRETRAINED = "laion2b_s34b_b79k"

# Mapillary rejects a bounding box of 0.01 degrees square or larger (changed
# 2026-01-16). Half-width of 0.002 gives a 0.004-degree box, comfortably inside
# the limit and about 400 m across at the equator.
MAPILLARY_BBOX_HALF_DEG = 0.002

# Staying under the size limit is not enough. Mapillary also refuses a box that
# is *dense*, with a 500 telling you to ask for less — and density means "how
# photographed is this place", so the refusal lands on exactly the busy roads
# this scorer most needs to look at. fetch_images_near halves the box and
# retries; this is the floor, about 28 m half-width, past which "imagery near
# this point" would stop being a claim about the point.
MAPILLARY_BBOX_MIN_HALF_DEG = 0.00025

# One request and a handful of image downloads per sample point, so these two
# constants are what actually govern how much of the budget a batch run spends.
SAMPLE_SPACING_M = 150.0
MAX_SAMPLE_POINTS = 40
IMAGES_PER_POINT = 4

# A point scored from one blurry frame is not evidence. Below this, the point
# is recorded as having no usable imagery rather than a weak score.
MIN_IMAGES_FOR_A_SCORE = 2

# Contrastive prompt pairs. The spec's pair is `v1_extreme`; the rest are the
# variants tried against it. Changing ACTIVE_PROMPT_VARIANT changes every score,
# so cached rows record which variant produced them.
PROMPT_VARIANTS: dict[str, tuple[str, str]] = {
    "v1_extreme": (
        "A photo of an area that is extremely scenic",
        "A photo of an area that is extremely ugly",
    ),
    "v2_plain": (
        "A photo of a beautiful place",
        "A photo of an ugly place",
    ),
    "v3_nature": (
        "A photo of a green natural place with trees and plants",
        "A photo of a bare place made of concrete and asphalt",
    ),
    "v4_walk": (
        "A photo of a place that is pleasant to walk through",
        "A photo of a place that is unpleasant to walk through",
    ),
    "v5_street": (
        "A street-level photo of a leafy, quiet, attractive street",
        "A street-level photo of a bleak, traffic-dominated street",
    ),
    "v6_restorative": (
        "A photo of a calm restorative outdoor place someone would choose to spend time in",
        "A photo of a harsh outdoor place someone would hurry through",
    ),
    "v7_park": (
        "A photo taken in a park or woodland",
        "A photo taken beside a busy road or car park",
    ),
}

# Chosen on **real Mapillary imagery**, which reversed most of what the
# generated-texture comparison in Phase G concluded. Separation (green - grim),
# three pairs, 2026-08-06:
#
#   pair                              v1     v2     v3     v4     v5     v6     v7
#   Hyde Park / Euston Rd          +.105  +.657  +.107  +.556  +.647  +.100  +.431
#   Vondelpark / Euston Rd         +.091  +.217  +.612  +.279  +.757  +.119  +.335
#   Viharamahadevi / Colombo Fort  +.038  +.262  -.141  -.133  -.339  -.022   .000
#
# Only **v2_plain** and v1_extreme point the right way on all three. v1_extreme
# is correct but barely moves (+.038 to +.105); a score that hardly changes
# between a park and an arterial road cannot rank anything. v2_plain has three
# to six times the range and never inverts.
#
# The previous default, v3_nature, and the widest-separating London variant,
# v5_street, **both invert on the Colombo pair** — they call the city fort
# greener than the park. An inverted score is not a weak score, it is a wrong
# one, and it is disqualifying however well the name fits.
#
# ⚠ Two reasons to still be sceptical, both recorded rather than resolved:
#   * n is small — 4 to 6 images per location, and only 2 for Viharamahadevi,
#     which is the single point deciding the one pair that separates the
#     candidates. That pair is also the only non-European one.
#   * "beautiful"/"ugly" measures **aesthetic appeal, not greenery**, and this
#     score is presented as a nature score. It correlates here, but a
#     photogenic stone street would score well without a tree in it. That is a
#     construct mismatch, not a bug, and it is why every response still carries
#     `scoring_method`.
ACTIVE_PROMPT_VARIANT = "v2_plain"


class ScoringUnavailable(RuntimeError):
    """CLIP cannot run in this process. Callers fall back to geometry scoring."""


# ---------------------------------------------------------------------------
# model — every torch reference below is inside a function
# ---------------------------------------------------------------------------

_model_bundle: Any = None


def torch_available() -> bool:
    import importlib.util

    return (
        importlib.util.find_spec("torch") is not None
        and importlib.util.find_spec("open_clip") is not None
    )


def _load_model() -> Any:
    """Load CLIP once per process. Never called on the deployed instance."""
    global _model_bundle
    if _model_bundle is not None:
        return _model_bundle

    try:
        import open_clip
        import torch
    except ImportError as exc:
        raise ScoringUnavailable(
            "torch and open-clip-torch are not installed in this environment. "
            "They are deliberately absent from requirements-deploy.txt; install "
            "backend/requirements.txt to run CLIP locally."
        ) from exc

    device = "mps" if torch.backends.mps.is_available() else "cpu"
    model, _, preprocess = open_clip.create_model_and_transforms(
        CLIP_MODEL_NAME, pretrained=CLIP_PRETRAINED
    )
    model = model.to(device).eval()
    tokenizer = open_clip.get_tokenizer(CLIP_MODEL_NAME)

    log.info("clip_loaded", extra={"device": device, "model": CLIP_MODEL_NAME})
    _model_bundle = (model, preprocess, tokenizer, device)
    return _model_bundle


def score_images(images: Sequence[Any], variant: str = ACTIVE_PROMPT_VARIANT) -> list[float]:
    """Positive-prompt probability for each PIL image, in [0, 1].

    Contrastive zero-shot: encode both prompts, softmax the image-text
    similarities over the pair, return the positive side.
    """
    if not images:
        return []
    if variant not in PROMPT_VARIANTS:
        raise ValueError(f"unknown prompt variant {variant!r}")

    import torch

    model, preprocess, tokenizer, device = _load_model()
    positive, negative = PROMPT_VARIANTS[variant]

    with torch.no_grad():
        batch = torch.stack([preprocess(img) for img in images]).to(device)
        text = tokenizer([positive, negative]).to(device)

        image_features = model.encode_image(batch)
        text_features = model.encode_text(text)
        image_features = image_features / image_features.norm(dim=-1, keepdim=True)
        text_features = text_features / text_features.norm(dim=-1, keepdim=True)

        logits = model.logit_scale.exp() * image_features @ text_features.T
        probabilities = logits.softmax(dim=-1)

    return [float(p[0]) for p in probabilities.cpu()]


# ---------------------------------------------------------------------------
# Mapillary
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class MapillaryImage:
    id: str
    url: str
    lat: float
    lon: float


def bbox_for(point: LatLon, half_deg: float = MAPILLARY_BBOX_HALF_DEG) -> str:
    """`minLon,minLat,maxLon,maxLat`, sized to stay under Mapillary's 0.01° limit."""
    return ",".join(
        f"{v:.6f}"
        for v in (
            point.lon - half_deg,
            point.lat - half_deg,
            point.lon + half_deg,
            point.lat + half_deg,
        )
    )


def _asked_for_too_much(response: httpx.Response) -> bool:
    """Is this the "your bounding box covers too many images" 500?

    Mapillary answers a bbox it considers too dense with **HTTP 500** and
    ``{"error": {"code": 1, "message": "Please reduce the amount of data you're
    asking for, then retry your request"}}`` — not a 400, and not a rate limit.
    Matched on the message as well as the code because a bare ``code: 1`` is
    Facebook's generic "unknown error" and means nothing on its own.
    """
    if response.status_code != 500:
        return False
    try:
        error = response.json().get("error") or {}
    except ValueError:
        return False
    return "reduce the amount of data" in str(error.get("message", "")).lower()


async def fetch_images_near(point: LatLon, limit: int = IMAGES_PER_POINT
                            ) -> list[MapillaryImage]:
    """Image metadata for one small bounding box around a sample point.

    **The box narrows on demand, and the reason is the interesting part.**
    ``limit`` bounds the rows returned, not the rows scanned, so Mapillary
    refuses a dense bbox outright however small a limit you ask for. Density
    tracks how photographed a place is — which means the failure lands exactly
    on busy arterial roads, which are exactly the "grim" half of every
    comparison this scorer exists to make. Euston Road failed at the default
    0.002° box on every attempt while Hyde Park, 2 km away, answered first time.

    So a refusal halves the box and retries rather than giving up. Narrowing is
    not a degradation here: a tighter box returns imagery *closer* to the sample
    point, which is what was wanted in the first place. It stops at
    ``MAPILLARY_BBOX_MIN_HALF_DEG`` — about 28 m — below which "near this point"
    stops being a meaningful claim, and a still-failing box raises as before.
    """
    if not settings.mapillary_token:
        raise ScoringUnavailable("MAPILLARY_TOKEN is not set; see BLOCKED.md #2.")

    half_deg = MAPILLARY_BBOX_HALF_DEG
    while True:
        try:
            response = await fetch(
                "GET",
                MAPILLARY_URL,
                params={
                    "access_token": settings.mapillary_token,
                    "fields": "id,thumb_1024_url,computed_geometry",
                    "bbox": bbox_for(point, half_deg),
                    "limit": limit,
                },
                headers={"Accept": "application/json"},
                cost=1,
                service="mapillary",
            )
        except (FixtureMissing, BudgetExhausted) as exc:
            raise ScoringUnavailable(str(exc)) from exc
        except httpx.HTTPError as exc:
            raise ScoringUnavailable(f"Mapillary unreachable: {type(exc).__name__}") from exc

        if response.status_code < 400:
            break

        # Each attempt is charged to the budget, which is right: a narrowed
        # retry is a second request and pretending otherwise would let one
        # dense point spend several calls off the books.
        if _asked_for_too_much(response) and half_deg / 2 >= MAPILLARY_BBOX_MIN_HALF_DEG:
            half_deg /= 2
            continue

        raise ScoringUnavailable(f"Mapillary returned {response.status_code}")

    try:
        payload = response.json()
    except ValueError as exc:
        raise ScoringUnavailable("Mapillary returned something unreadable") from exc

    out: list[MapillaryImage] = []
    for item in payload.get("data", []):
        url = item.get("thumb_1024_url")
        if not url:
            continue
        coords = (item.get("computed_geometry") or {}).get("coordinates") or [point.lon, point.lat]
        out.append(
            MapillaryImage(
                id=str(item.get("id", "")),
                url=url,
                lat=float(coords[1]),
                lon=float(coords[0]),
            )
        )
    return out


async def download_image(image: MapillaryImage) -> Any:
    """Fetch one JPEG and decode it to a PIL image.

    Goes through the fixture layer for budget accounting, but with
    ``persist=False``: committing street imagery would add megabytes to the
    repository for no benefit, because the derived score is what gets cached.
    """
    from io import BytesIO

    from PIL import Image

    response = await fetch(
        "GET", image.url, cost=1, service="mapillary", persist=False,
        headers={"Accept": "image/jpeg"},
    )
    if response.status_code >= 400:
        raise ScoringUnavailable(f"image download returned {response.status_code}")
    return Image.open(BytesIO(response.content)).convert("RGB")


async def score_point(
    point: LatLon,
    cache: Cache | None = None,
    variant: str = ACTIVE_PROMPT_VARIANT,
) -> tuple[float | None, int]:
    """CLIP score for one place, writing the result to the cache.

    Returns ``(score, image_count)``. A score of ``None`` means there was not
    enough usable imagery — which is recorded as such, so a later run does not
    keep paying to rediscover it.
    """
    cache = cache or get_cache()
    images = await fetch_images_near(point)

    decoded = []
    for image in images:
        try:
            decoded.append(await download_image(image))
        except (ScoringUnavailable, httpx.HTTPError, OSError) as exc:
            log.info("image_skipped", extra={"reason": type(exc).__name__})

    if len(decoded) < MIN_IMAGES_FOR_A_SCORE:
        cache.put_segment_score(point.lat, point.lon, None, len(decoded), "clip", variant)
        return None, len(decoded)

    scores = score_images(decoded, variant)
    mean = sum(scores) / len(scores)
    cache.put_segment_score(point.lat, point.lon, mean, len(decoded), "clip", variant)
    return mean, len(decoded)


# ---------------------------------------------------------------------------
# the request path — cache reads only, no torch
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class ClipTerm:
    """The CLIP contribution to a route's nature score, and how much of the
    route it actually covers."""

    score: float | None
    coverage: float
    points_scored: int
    points_sampled: int


def clip_term_for_route(points: Sequence[LatLon], cache: Cache | None = None) -> ClipTerm:
    """Length-weighted CLIP score for a route, read from the cache only.

    This is the only function in this module the deployed backend calls. It does
    not import torch, does not touch the network, and returns
    ``ClipTerm(None, 0.0, ...)`` for any region that has not been pre-warmed —
    which is the signal for the caller to fall back to geometry-only scoring and
    say so in the response.
    """
    if len(points) < 2:
        return ClipTerm(None, 0.0, 0, 0)

    cache = cache or get_cache()
    samples = sample_every(points, SAMPLE_SPACING_M, MAX_SAMPLE_POINTS)
    if not samples:
        return ClipTerm(None, 0.0, 0, 0)

    keys = [segment_key(s.point.lat, s.point.lon) for s in samples]
    rows = cache.get_segment_scores(keys)

    total = float(segment_lengths_m(points).sum()) or 1.0
    # Each sample stands for the stretch of route around it.
    share = total / len(samples)

    weighted = 0.0
    covered = 0.0
    scored = 0
    for key in keys:
        row = rows.get(key)
        if row is None or row.clip_score is None:
            continue
        weighted += row.clip_score * share
        covered += share
        scored += 1

    if covered <= 0:
        return ClipTerm(None, 0.0, 0, len(samples))
    return ClipTerm(
        score=round(weighted / covered, 4),
        coverage=round(min(1.0, covered / total), 4),
        points_scored=scored,
        points_sampled=len(samples),
    )
