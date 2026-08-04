"""Compare the CLIP prompt variants and print a ranking.

    python3 -m scripts.compare_prompts                 # generated reference images
    python3 -m scripts.compare_prompts --location hyde-park-london   # real imagery

**Read the caveat before trusting the output.** With no Mapillary token this
script falls back to procedurally generated reference images: a foliage-like
texture against an asphalt-like one. That measures whether a prompt pair
separates green from grey *at all* — it is a check on the pipeline and on prompt
polarity, not evidence about how a pair behaves on real street photography.
Ranking variants properly needs real imagery, which needs a token (BLOCKED.md #2).

Whatever it prints, record it in PROGRESS.md alongside which mode produced it.
"""

from __future__ import annotations

import argparse
import asyncio
import math
import random
import sys
from typing import Any

from backend.config import TEST_LOCATIONS_BY_SLUG, settings
from backend.geometry import LatLon
from backend.scoring import (
    PROMPT_VARIANTS,
    ScoringUnavailable,
    download_image,
    fetch_images_near,
    score_images,
    torch_available,
)

IMAGE_SIZE = 336


def _foliage_image(seed: int) -> Any:
    """A green, high-frequency, organic-looking texture."""
    from PIL import Image, ImageFilter

    rng = random.Random(seed)
    img = Image.new("RGB", (IMAGE_SIZE, IMAGE_SIZE))
    pixels = img.load()
    for y in range(IMAGE_SIZE):
        for x in range(IMAGE_SIZE):
            n = (
                math.sin(x * 0.21 + seed) * math.cos(y * 0.17 - seed)
                + math.sin((x + y) * 0.08)
            ) * 0.5
            g = int(90 + 85 * n + rng.uniform(-25, 25))
            r = int(g * 0.45 + rng.uniform(-12, 12))
            b = int(g * 0.35 + rng.uniform(-12, 12))
            pixels[x, y] = (max(0, min(255, r)), max(0, min(255, g)), max(0, min(255, b)))
    # Sky at the top, as in a street-level photograph.
    for y in range(int(IMAGE_SIZE * 0.18)):
        for x in range(IMAGE_SIZE):
            pixels[x, y] = (170, 195, 215)
    return img.filter(ImageFilter.GaussianBlur(0.6))


def _asphalt_image(seed: int) -> Any:
    """Flat grey with hard straight edges and lane markings."""
    from PIL import Image, ImageDraw, ImageFilter

    rng = random.Random(seed)
    img = Image.new("RGB", (IMAGE_SIZE, IMAGE_SIZE), (108, 108, 110))
    pixels = img.load()
    for y in range(IMAGE_SIZE):
        for x in range(IMAGE_SIZE):
            v = 100 + int(rng.uniform(-14, 14))
            pixels[x, y] = (v, v, v + 2)
    draw = ImageDraw.Draw(img)
    draw.rectangle([0, 0, IMAGE_SIZE, int(IMAGE_SIZE * 0.30)], fill=(150, 152, 156))
    for i in range(6):
        y = int(IMAGE_SIZE * (0.45 + i * 0.09))
        draw.line([(0, y), (IMAGE_SIZE, y)], fill=(200, 200, 190), width=3)
    draw.rectangle([0, int(IMAGE_SIZE * 0.30), IMAGE_SIZE, int(IMAGE_SIZE * 0.34)],
                   fill=(70, 70, 74))
    return img.filter(ImageFilter.GaussianBlur(0.4))


def _generated_sets() -> tuple[list[Any], list[Any], str]:
    green = [_foliage_image(s) for s in range(4)]
    grim = [_asphalt_image(s) for s in range(4)]
    return green, grim, "generated reference images (pipeline check, NOT a place ranking)"


async def _real_sets(green_slug: str, grim_slug: str) -> tuple[list[Any], list[Any], str]:
    async def grab(slug: str) -> list[Any]:
        loc = TEST_LOCATIONS_BY_SLUG[slug]
        images = await fetch_images_near(LatLon(loc.lat, loc.lon), limit=6)
        return [await download_image(i) for i in images]

    return await grab(green_slug), await grab(grim_slug), "real Mapillary imagery"


async def main_async(green_slug: str | None, grim_slug: str | None) -> int:
    if not torch_available():
        print("torch and open-clip-torch are not installed. "
              "pip install -r backend/requirements.txt", file=sys.stderr)
        return 2

    if green_slug and grim_slug and settings.mapillary_token:
        try:
            green, grim, source = await _real_sets(green_slug, grim_slug)
        except ScoringUnavailable as exc:
            print(f"Falling back to generated images: {exc}", file=sys.stderr)
            green, grim, source = _generated_sets()
    else:
        if green_slug or grim_slug:
            print("MAPILLARY_TOKEN is not set — using generated images instead.", file=sys.stderr)
        green, grim, source = _generated_sets()

    print(f"Source: {source}")
    print(f"{len(green)} green images, {len(grim)} grim images\n")
    print(f"{'variant':<16} {'green':>7} {'grim':>7} {'separation':>11}  correct")
    print("-" * 56)

    results = []
    for name in sorted(PROMPT_VARIANTS):
        green_scores = score_images(green, name)
        grim_scores = score_images(grim, name)
        g = sum(green_scores) / len(green_scores)
        b = sum(grim_scores) / len(grim_scores)
        results.append((g - b, name, g, b))
        print(f"{name:<16} {g:>7.3f} {b:>7.3f} {g - b:>11.3f}  {'yes' if g > b else 'NO'}")

    results.sort(reverse=True)
    best = results[0]
    print(f"\nWidest separation: {best[1]} ({best[0]:+.3f})")
    if source.startswith("generated"):
        print("This ranking comes from generated images. Do not record it as a")
        print("finding about real streets — re-run with a Mapillary token.")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--green", default=None, help="test location slug expected to score high")
    parser.add_argument("--grim", default=None, help="test location slug expected to score low")
    parser.add_argument("--location", default=None,
                        help="shorthand: use hyde-park-london vs euston-road-london")
    args = parser.parse_args()

    green, grim = args.green, args.grim
    if args.location and not (green or grim):
        green, grim = "hyde-park-london", "euston-road-london"
    return asyncio.run(main_async(green, grim))


if __name__ == "__main__":
    sys.exit(main())
