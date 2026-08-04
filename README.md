# Meander

**Give it where you are and how long you have. It gives you three routes back.**

| id | label | what it optimises |
|---|---|---|
| `fastest` | Fastest | Shortest time. The control. |
| `nature` | Nature | Maximum greenery, capped at 1.6× the fastest duration. |
| `accessible` | Accessible | Hard accessibility constraints first, then greenery within them. May return no route at all. |

One dial, 20–360 minutes. No destination means a round trip from where you started.

---

## Why

Time in nature is now prescribed clinically — roughly two hours a week, in sessions of twenty
minutes or more. Nothing tells you *where to go* given the time, the transport and the body you
actually have today.

And people with mobility impairments are routinely routed down flights of steps. Meander treats a
blocked route as a first-class answer: it will tell you it cannot get you there rather than
inventing a path you cannot use.

**The rule this project is built around: a missing OpenStreetMap tag means `UNKNOWN`, never
"accessible".** A false step-free claim can strand a real person. Everything else here is
negotiable; that is not.

---

## Status

**It produces real routes.** That was not true when the first eleven build phases were tagged
(`phase-a` … `phase-k`), and the sentence that used to sit here — "it has never produced a real
route" — is what a self-hosted GraphHopper 11 fixed.

### What is proven

All three presets route, against a self-hosted server carrying Sri Lanka + the Netherlands + Great
Britain in one graph. `scripts/verify_selfhosted.py` asserts it at four points, one per imported
region: all three presets answer, their geometries differ from each other, and `smoothness` comes
back as a path detail — which is the fifth hard accessibility constraint, and the one the hosted
API cannot supply at all.

### What is measured

One uncached `POST /api/routes` — a 45-minute foot round trip near Hyde Park, all three
objectives, nothing cached:

| | |
|---|---|
| wall clock | **14.0 s** |
| GraphHopper requests issued | **8** — 6 nature candidates, 1 fastest, 1 accessible |
| fastest | 35.9 min · 2,939 m · 64% of its length checked · 3 findings |
| nature | 22.4 min · 1,791 m · 88% checked · greener than fastest (0.666 vs 0.646) |
| accessible | **blocked** — hard constraints reject it, and it says so |

That is one measurement on one machine against a warm graph, not a benchmark. The nature route
came back well under the time budget and carries a `preset_note` saying so, which is the app
working as intended rather than a defect.

### What is still unverified

**Every route is `scoring_method: "geometry_only"`.** `data/cache.db` ships with zero CLIP segment
scores, so nothing in this checkout has ever been scored from real street-level imagery, and the
prompt pair driving CLIP has still only been ranked against generated reference images.
[BLOCKED.md](BLOCKED.md) §2 is open and has the two commands that would close it.

The "accessible is longer with fewer barriers" claim in [PROGRESS.md](PROGRESS.md) is a single
Hyde Park measurement. Nothing re-runs it.

### What is deployed

Nothing yet. [DEPLOY.md](DEPLOY.md) is written to be followed without asking questions.
[PROGRESS.md](PROGRESS.md) is the full build log, including the hostile self-audit and what a
reviewer should still be sceptical about.

---

## Architecture

```
                        ┌──────────────────────────────┐
   browser              │  frontend/  Vite + React     │
                        │  MapLibre GL + OpenFreeMap   │
                        └──────────────┬───────────────┘
                                       │  POST /api/routes  (SSE)
                        ┌──────────────▼───────────────┐
                        │  backend/main.py   FastAPI   │
                        │  rate limit · CORS · SSE     │
                        └──┬────────┬────────┬─────────┘
                           │        │        │
              routing.py ──┘        │        └── enrich.py ── Overpass
              (GraphHopper)         │                        Open-Meteo (+AQ)
                                    │
                    accessibility.py│  geometry.py   scoring.py
                    hard constraints│  numpy only    CLIP  [torch, local only]
                                    │
                        ┌───────────▼──────────────────┐
                        │  cache.py  →  data/cache.db  │
                        │  segment scores · route cache│
                        └──────────────────────────────┘

   ALL network egress passes through fixtures.py — record/replay + hard live-call caps.
```

### The split that makes it deployable

CLIP needs 2–3 GB of RAM. The Render free tier has 512 MB. So scoring is split in two:

| local (`requirements.txt`) | deployed (`requirements-deploy.txt`) |
|---|---|
| `batch_score.py` pulls Mapillary imagery | FastAPI reads the committed `data/cache.db` |
| CLIP ViT-B-32 scores each segment | numpy-only `geometry.py` scores the rest |
| writes `data/cache.db` | **no torch, no open-clip-torch** |

Cached regions get real CLIP scores. Everywhere else falls back to geometry with lower confidence.
**Every route states which path produced its numbers** in `scoring_method`.

---

## Setup from a clean clone

Requires Python 3.11+ and Node 18+.

```bash
git clone https://github.com/<you>/meander.git && cd meander
```

### Backend

```bash
python3 -m venv .venv && source .venv/bin/activate && pip install -r backend/requirements.txt
```

```bash
cp .env.example .env
```

Fill in `GRAPHHOPPER_KEY` for live routing. Everything runs from recorded fixtures without it —
that is the default (`MEANDER_FIXTURES=replay`).

```bash
uvicorn backend.main:app --reload --port 8000
```

```bash
curl -s localhost:8000/api/health | python3 -m json.tool
```

### Making it work for any location, not just the demo ones

Out of the box the backend runs on **recorded fixtures**, so only five demo
locations answer — Colombo Fort, Viharamahadevi Park, Hyde Park, Euston Road and
Vondelpark. Anything else returns *"this server is running from recorded
fixtures and has none for that request"*.

Two changes make it work anywhere. **One free API key, and one line in `.env`.**

1. Get a GraphHopper key — free, 500 credits/day:
   https://www.graphhopper.com/ → Dashboard → API keys
2. In `.env`, set `GRAPHHOPPER_KEY=` to it and `MEANDER_FIXTURES=live`
3. Raise the `MEANDER_BUDGET_*` caps. **This step is not optional and the
   failure is confusing without it:** those are lifetime development guard
   rails, and 80 GraphHopper calls is about 26 route requests, after which the
   service silently drops back to replay-only and every new location fails as
   though the key were wrong. `.env.example` has the values.
4. Restart the backend.

Everything else already works for any location with no key at all: place search
(Nominatim), rest stops (Overpass), air quality and cloud cover (Open-Meteo),
and sun position (computed locally).

> **The free GraphHopper tier routes `fastest` only.** The nature and accessible
> presets steer the router with a custom model, and custom models need flexible
> mode, which free packages do not include — the API answers *"Free packages
> cannot use flexible mode"*. Those two come back `status: "blocked"` with that
> reason rather than silently repeating the fastest route. Round trips, path
> details, and therefore the whole accessibility engine, are unaffected. See
> [BLOCKED.md](BLOCKED.md) #0 for the options.

### Self-hosting GraphHopper, so all three presets work

The open-source GraphHopper server has no flexible-mode restriction, so running
one locally is what makes `nature` and `accessible` real routes rather than
blocked ones. It also exposes the `smoothness` tag, which the hosted API does
not — that is one of the five hard accessibility constraints, and self-hosting
is the only way it can fire from routing data.

```bash
scripts/graphhopper.sh setup
```

Downloads the OSM extracts, merges them into one graph and builds it. Needs a
JDK 21+ and `osmium-tool` (`brew install openjdk@21 osmium-tool`); the script
checks and tells you if either is missing. The build is the slow part — minutes
to tens of minutes depending on how much of the world you asked for.

```bash
scripts/graphhopper.sh serve
```

Then point Meander at it, in `.env`:

```
MEANDER_GRAPHHOPPER_URL=http://localhost:8989/route
```

Only places **inside the imported extracts** can be routed. The regions are the
`REGIONS` list at the top of `scripts/graphhopper.sh`; add a Geofabrik path and
re-run `setup` to widen coverage. `scripts/graphhopper.sh regions` prints what
is currently built in.

Two things stay optional:

| | without it |
|---|---|
| `MAPILLARY_TOKEN` + `python3 -m backend.batch_score` | scenery is scored from route shape and OSM tags; every route reports `scoring_method: "geometry_only"` instead of `"clip"` |
| `ANTHROPIC_API_KEY` | `narration` stays `null` and the card says the description is still being written |

Watch your quota at `/api/health` under `rate_limit.served_today`. The default
daily ceiling of 120 routed requests is ~360 of the 500 credits.

### Frontend

```bash
cd frontend && npm install && npm run dev
```

Open http://localhost:5173. To run the UI with no backend at all:

```bash
VITE_MOCK_API=1 npm run dev
```

### Tests

```bash
python3 -m pytest backend/tests -q
```

The suite runs entirely offline. It never opens a socket.

---

## API

`POST /api/routes` · `GET /api/geocode?q=` · `GET /api/health` · `POST /api/report-barrier`

Full contract, including the streaming shape and the blocked-route cases: [docs/API.md](docs/API.md).

---

## Privacy

Stateless by design. No location history, no cookies, no third-party analytics, no browser
storage. Coordinates, IP addresses and user agents are never logged or persisted — there is a
filter in `backend/logging_setup.py` that redacts them as a backstop.

Usage is counted as aggregates only (`route_requests_total`, `routes_blocked_total`,
`cache_hits_total`, `segments_scored_total`) plus a daily unique-session count derived from an
in-memory digest keyed by a salt generated at process start and never written anywhere.

---

## Limitations

Read this before trusting anything the app tells you.

### Accessibility answers are only as complete as OpenStreetMap tagging

Meander can only reject a barrier somebody has already recorded. Most of the world's footways carry
no `surface` tag, no `smoothness` tag and no `kerb` tag at all, and Meander deliberately refuses to
guess: an untagged way is `UNKNOWN`, never "accessible".

The practical consequence: **a route with no blockers is not a verified route.** It is a route with
nothing recorded against it. Every result states the fraction of its length that was actually
checked, and below 30% the wording changes to say plainly that you should not rely on it. That
sentence is not boilerplate — it is the most important thing on the card.

What Meander cannot see at all:

- temporary obstructions — roadworks, parked cars, bins, market stalls, snow
- door widths, lift outages, and anything indoors
- kerb heights where `kerb` is untagged, which is most kerbs
- whether a "step-free" route is actually navigable in a particular chair, with a particular gait,
  on a particular day
- gradients where the elevation model is coarse; it smooths over short sharp ramps

**Meander is a starting point for planning, not a substitute for local knowledge.** If it says a
route is clear and it is not, that is the data being incomplete, which is exactly what the
confidence sentence is warning you about.

### Scenery scores are estimates, and they say which kind

| `scoring_method` | what produced the number |
|---|---|
| `clip` | CLIP inference over Mapillary street-level imagery near the route |
| `geometry_only` | route shape, elevation profile and OSM road tags — no imagery |
| `placeholder` | **not a measurement.** Do not present it as one. |

CLIP scoring only exists where somebody has run the offline pre-warm for that area. Everywhere
else falls back to geometry, which is a judgement encoded in a lookup table, not an observation.
The naturalness and air-proxy weightings in `geometry.py` are opinions, and reasonable people would
choose different numbers.

The prompt pair that drives CLIP scoring was chosen against generated reference images, not real
street photography — see PROGRESS.md, Phase G. Four of the seven pairs tried, including the one
originally specified, ranked an asphalt image as *more* scenic than a foliage one. That is a
warning about how brittle zero-shot aesthetic scoring is, and it has not yet been re-checked
against real imagery.

### Air quality is regional, blended with a local proxy

The measurement comes from Open-Meteo's European AQI for the area, which is real but coarse — on
its own it gives every route in a city the same number. It is modulated by how much of each route
runs alongside heavy traffic, inferred from OSM road classes. That blend is a judgement, stated in
PROGRESS.md, not a sensor reading from the pavement you will be walking on.

### Rest stops are whatever OSM knows about

Benches, drinking water, toilets and shelters within 35 m of the line. Under-recorded almost
everywhere, and the app cannot tell a usable bench from a broken one. When Overpass is unreachable
the field is `null` — "we could not look" — which is deliberately distinct from `[]`, "we looked
and found none".

### The keyless demo runs on hand-built routing data

Out of the box (`MEANDER_FIXTURES=replay`, no routing server) the committed GraphHopper fixtures
are **synthetic**: real response schema, plausible geometry, invented streets. Every route derived
from one carries `synthetic_upstream: true`, is labelled `placeholder`, and the UI prints "Built
from demonstration data, not a live routing response. Do not follow it."

Point the app at a self-hosted GraphHopper and that stops being true — the routes above under
**Status** are real ones. The distinction survives in the response: `scoring_method` and
`synthetic_upstream` say which kind you are looking at, on every route, always.

### Other things worth knowing

- The free Render instance sleeps; the first request after a quiet spell takes 30–60 seconds.
- The daily routing ceiling is a real ceiling. When it is reached the app says so and stops.
- Round-trip loops come from GraphHopper's `round_trip` algorithm with a fixed seed. The direction
  is not controllable, and the distance is derived from your time budget using conservative average
  speeds — hills and traffic lights will make it slower than the estimate.
- Narration is written by a language model from the numbers on this page and nothing else. It is
  told not to invent landmarks, but it is still generated text.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

## Licence and attribution

MIT — see [LICENSE](LICENSE).

- Map data © [OpenStreetMap](https://www.openstreetmap.org/copyright) contributors, ODbL.
- Basemap tiles by [OpenFreeMap](https://openfreemap.org/).
- Street-level imagery from [Mapillary](https://www.mapillary.com/), CC BY-SA 4.0.
- Weather and air quality from [Open-Meteo](https://open-meteo.com/), CC BY 4.0.
- Routing by [GraphHopper](https://www.graphhopper.com/).
