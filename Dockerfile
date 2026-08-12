# Meander API.
#
# Deliberately ARM64. Fargate Graviton is roughly 20% cheaper than x86 for the
# same vCPU/memory, this image is pure Python with no compiled extension that
# lacks an aarch64 wheel, and the router next to it is a JVM. Build for x86 by
# passing --platform=linux/amd64 to both this and the router.
#
#   docker build --platform=linux/arm64 -t meander-api .
#
# **requirements-deploy.txt only.** torch and open-clip are ~2.5 GB and would
# OOM the task at import time; CLIP scoring is an offline batch job whose
# results arrive in data/cache.db. See the header of that file.

# ---------------------------------------------------------------------------
# build: resolve wheels once, so the runtime layer carries no build tooling
# ---------------------------------------------------------------------------
FROM python:3.13-slim AS build

ENV PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PIP_NO_CACHE_DIR=1

WORKDIR /build
COPY backend/requirements-deploy.txt .
RUN python -m venv /opt/venv \
 && /opt/venv/bin/pip install --no-cache-dir -r requirements-deploy.txt

# ---------------------------------------------------------------------------
# runtime
# ---------------------------------------------------------------------------
FROM python:3.13-slim AS runtime

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PATH="/opt/venv/bin:$PATH"

# Non-root, and it owns nothing it does not need to write.
RUN useradd --system --create-home --uid 10001 meander

COPY --from=build /opt/venv /opt/venv

WORKDIR /app

# backend/, data/cache.db and one JSON file, and nothing else. .dockerignore is
# what keeps fixtures/, frontend/, graphhopper/, tests and .venv out; this COPY
# list is the second half of the same rule.
COPY --chown=meander:meander backend/ /app/backend/
COPY --chown=meander:meander data/cache.db /app/data/cache.db

# The per-region boxes, so the API can tell "never imported" from "no path near
# that exact spot". GraphHopper's /info reports only the union of everything
# imported, and for a set spanning Sri Lanka to Britain that rectangle contains
# Paris, Berlin and most of Europe. The graph itself lives on the router's disk
# in a different container, so this one small file is the only thing that
# crosses. Written by `scripts/graphhopper.sh setup` and committed; a build
# whose graph predates it simply has no file, and `backend/coverage.py`
# degrades to the hedged wording rather than to a guess.
#
# ⚠ `graphhopper/` is excluded wholesale by .dockerignore, so this needs its own
# un-ignore line there. A COPY of an ignored path fails the build outright,
# which is the right way for that mistake to surface.
COPY --chown=meander:meander graphhopper/regions.manifest.json /app/graphhopper/regions.manifest.json

# ⚠ data/cache.db is tracked and holds pre-warmed CLIP segment scores, which is
# why it is here. It ALSO holds route_cache, whose rows are whole /api/routes
# payloads with real coordinate arrays — baking one of those into a published
# image publishes location history. The build fails rather than ships it.
#
# scripts/ is not in the image, so the check is inlined; the full explanation
# and the --scrub fix are in scripts/scrub_cache_db.py.
RUN python - <<'PY'
import sqlite3, sys
conn = sqlite3.connect("file:/app/data/cache.db?mode=ro", uri=True)
present = {r[0] for r in conn.execute("SELECT name FROM sqlite_master WHERE type='table'")}
rows = conn.execute("SELECT COUNT(*) FROM route_cache").fetchone()[0] if "route_cache" in present else 0
if rows:
    sys.exit(
        f"REFUSING TO BUILD: data/cache.db carries {rows} route_cache row(s), which are\n"
        f"whole route payloads with real coordinates. Run:\n"
        f"    python3 scripts/scrub_cache_db.py --scrub\n"
    )
print(f"cache.db ok: 0 route rows, "
      f"{conn.execute('SELECT COUNT(*) FROM segment_scores').fetchone()[0]} segment scores")
PY

USER meander
EXPOSE 8000

# --workers is deliberately absent. The rate limiter, the daily ceiling, the
# metrics counters and the route cache are all per-process; a second worker
# means two independent daily ceilings and half the cache hit rate. See
# docs/adr/0003-single-task-rate-limiting.md.
#
# --timeout-graceful-shutdown sits above MEANDER_DRAIN_TIMEOUT_S (20 s) and
# below the orchestrator's SIGTERM-to-SIGKILL window.
CMD ["uvicorn", "backend.main:app", \
     "--host", "0.0.0.0", \
     "--port", "8000", \
     "--timeout-graceful-shutdown", "45", \
     "--no-access-log"]
