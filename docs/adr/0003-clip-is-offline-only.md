# 3 · CLIP runs offline; the request path reads a committed cache

**Accepted.**

## Context

Scenery scoring uses CLIP over Mapillary imagery. torch, open-clip and
torchvision are about 2.5 GB installed, and inference wants a GPU or several
seconds of CPU. The deployed instance is a 512 MB-class container.

## Decision

A hard split.

- `backend/batch_score.py` runs on a workstation: fetches imagery, runs CLIP,
  writes scores to `data/cache.db`, which is committed.
- `clip_term_for_route()` is the **only** function the request path calls. It
  reads SQLite. No torch, no network.
- **Every torch import in `scoring.py` is inside a function**, with a test that
  greps the module source to keep it that way — a top-level import would kill
  the deployed instance at startup, so a comment was not enough.
- `requirements-deploy.txt` has no torch, and CI installs it separately and
  asserts `find_spec` returns `None` for all three.
- A region nobody has pre-warmed returns `scoring_method: "geometry_only"`, and
  the response says so.

## Consequences

- The deployed image is 360 MB and imports in under a second.
- Scores are stale by construction. Acceptable: they describe how green a
  street is, which changes on the scale of seasons.
- Coordinates in the cache are grid-rounded to 4 decimal places (~11 m), so no
  stored row is attributable to one person's path.
- `data/cache.db` is a committed binary, which needs a pre-commit hook to stop
  live route rows being committed with it. That hook has correctly refused four
  commits.
- A point with fewer than two usable images is cached with a **NULL** score,
  not a low one. One blurry frame is not evidence about a place, and caching
  the null stops a later run paying to rediscover the same absence.

## Alternatives rejected

**Inference in the request path.** Rejected: 2.5 GB of dependencies and seconds
per request, for a number that barely changes.

**A separate inference service.** Rejected: a second always-on container and a
network hop, to serve values that are effectively static.

**Ship no scores and compute on demand.** Rejected: it makes the feature
invisible for every first visitor to a region, which is everyone.
