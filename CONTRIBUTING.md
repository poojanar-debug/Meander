# Contributing to Meander

Thanks for looking. A few things about this codebase are unusual and will save you a wasted
afternoon if you read them first.

## The one rule

**A missing OpenStreetMap tag means `UNKNOWN`, never "accessible".**

`accessibility.py` models this in the type system rather than with booleans, and there is a test
asserting it. If a change makes an untagged way default to passable, that change is wrong even if
every other test passes. A false step-free claim can strand a real person.

## Before you write code that calls an external API

Everything network-facing goes through `backend/fixtures.py`. It records the first call for a
request signature to `fixtures/<service>/<hash>.json` and replays it forever after.

```bash
MEANDER_FIXTURES=replay pytest backend/tests -q   # default; no sockets opened
MEANDER_FIXTURES=record uvicorn backend.main:app  # replay known, record new
```

GraphHopper's free tier is 500 credits/day and one route request costs about three. An iteration
loop in `live` mode will exhaust the quota in minutes, and every subsequent call fails in a way
that looks exactly like a code bug. `fixtures.py` enforces hard per-service caps and downgrades a
service to replay-only when its cap is hit.

Use the coordinates in `backend/config.py:TEST_LOCATIONS`. Every new coordinate is a cache miss.

## Setup

```bash
python3 -m venv .venv && source .venv/bin/activate && pip install -r backend/requirements.txt
```

```bash
cd frontend && npm install
```

## Tests

```bash
python3 -m pytest backend/tests -q
```

The suite must pass with the network unplugged. If a test needs a network response, record a
fixture for it.

The tests that matter most are the ones covering places where a silent bug produces a
plausible-looking wrong answer:

- `test_geometry.py` — scoring maths
- `test_accessibility.py` — every hard constraint, and the unknown-≠-accessible invariant
- `test_routing.py` — the `[lon, lat]` / `"lat,lon"` converter

## Gotchas that each cost a day if you hit them cold

| | |
|---|---|
| GraphHopper POST takes `[lon, lat]`; GET takes `"lat,lon"` | One converter in `routing.py`, used everywhere, with a unit test. Do not inline a second one. |
| `custom_model` is silently ignored without `"ch.disable": true` | Symptom: the nature route comes back identical to fastest. |
| `heading` is ignored when `algorithm=round_trip` | Do not depend on loop direction. |
| Mapillary bbox must be < 0.01° square (since 2026-01-16) | Sample points along the polyline, one ±0.002° bbox per point. |
| Render free tier is 512 MB; CLIP needs 2–3 GB | `requirements-deploy.txt` must never contain `torch` or `open-clip-torch`. |

## Style

- Type hints on every Python signature.
- Comment the non-obvious *why*, not the *what*.
- No `try`/`except` that swallows an error silently — log it and degrade explicitly.
- No dead code, no commented-out blocks, no leftover TODOs.
- Frontend is JavaScript, not TypeScript.

## Accessibility is a requirement, not a nice-to-have

Meander routes people with mobility impairments. An inaccessible interface would be a
contradiction. Pull requests touching the frontend need to hold WCAG 2.1 AA:

- contrast, visible focus, targets ≥ 44 × 44 px
- full keyboard operation
- the route list is the complete text equivalent of the map — test it with `display: none` on
  `MapView`
- never colour alone to distinguish routes
- respect `prefers-reduced-motion`
- usable at 375 px with no horizontal scrolling

## Commits

Conventional commits: `feat(routing): add nature custom model`. Run the test suite before every
commit.

## Never

- Commit a secret. `.env` is gitignored; keep it that way.
- Write to the production OpenStreetMap API. Barrier reporting targets `api06.dev.openstreetmap.org`
  only.
- Present a synthetic or placeholder score as real. Placeholders must be labelled
  `scoring_method: "placeholder"` in the response.
