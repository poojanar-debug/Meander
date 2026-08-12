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

### Install the hooks. This is not automatic on clone.

```bash
scripts/install-hooks.sh
```

Nothing installs them for you, and this repository has already leaked a
`data/cache.db` carrying route history for exactly that reason. The hook refuses
two commits: a `cache.db` with `route_cache` rows in it, and a fixture that is
not already tracked.

The second one will stop you at some point, and the message it prints is the
whole explanation. The short version: before `70891eb`, production wrote one
fixture per upstream call, so a live session left dozens of files holding real
requested coordinates in tracked directories. 71 of them were found sitting in
this repository. If you are recording deliberately, say so and it gets out of
your way:

```bash
MEANDER_ALLOW_NEW_FIXTURES=1 git commit ...
```

Read `BLOCKED.md:228` before re-recording anything in bulk — the filenames are
hashes of the outgoing request body, so changing what the request looks like
misses *every* fixture at once and the suite fails wholesale with `no_fixture`
503s.

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
| `custom_model` is silently ignored without `"ch.disable": true` | Symptom: the scenic route comes back identical to fastest. |
| `heading` is ignored when `algorithm=round_trip` | Do not depend on loop direction. |
| Mapillary bbox must be < 0.01° square (since 2026-01-16) | Sample points along the polyline, one ±0.002° bbox per point. |
| Render free tier is 512 MB; CLIP needs 2–3 GB | `requirements-deploy.txt` must never contain `torch` or `open-clip-torch`. |
| **The Cloudflare preview deployment your PR creates cannot reach the API** | Known, decided, and not a bug in your branch. Every preview build gets a fresh `<hash>.meander-eoc.pages.dev` hostname, and `backend/config.py:336-372` compares `MEANDER_ALLOWED_ORIGINS` as verbatim strings — there is no pattern matching anywhere in the backend. Only the stable `https://meander-eoc.pages.dev` is allowlisted, so a preview gets `400 Disallowed CORS origin` on every call. Develop against `npm run dev:mock`. See DEPLOY.md for why this was accepted rather than fixed. |

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

Conventional commits: `feat(routing): add scenic custom model`. Run the test suite before every
commit.

## Never

- Commit a secret. `.env` is gitignored; keep it that way.
- Write to the production OpenStreetMap API. Barrier reporting targets `api06.dev.openstreetmap.org`
  only.
- Present a synthetic or placeholder score as real. Placeholders must be labelled
  `scoring_method: "placeholder"` in the response.
