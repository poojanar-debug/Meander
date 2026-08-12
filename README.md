# Meander

**Give it where you are and how long you have. It gives you three routes back.**

| id | label | what it optimises |
|---|---|---|
| `fastest` | Fastest | Shortest time. The control. |
| `scenic` | Scenic | Maximum greenery, capped at 1.6× the fastest duration. |
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

Two branches then grew from that point in parallel and have now been reconciled onto one:
`feat/launch` built the deployment — backend hardening, containers, CloudFormation, observability
— and `claude/code-prompt-design-handoff` rebuilt the frontend across eight phases against
[docs/DESIGN-HANDOFF.md](docs/DESIGN-HANDOFF.md). **This tree is the launch backend under the
redesign frontend.** The launch branch's own frontend was not merged; [BLOCKED.md](BLOCKED.md) §5
lists the seven pieces of it that have to come back, and why each one is wanted.

### What is proven

**706 backend tests and 442 frontend tests pass offline**, at 87.71% statement coverage against an
85% floor. The suite never opens a socket, and a job in CI runs it under `unshare -n` to prove
that rather than trust it. The deploy image imports with torch absent, checked against the real
requirements file, and `backend.main` is imported in that environment to prove absence is not the
only thing being measured.

**WCAG 2.1 AA, checked rather than asserted.** `frontend/scripts/gate.mjs` runs axe-core against a
real headless Chrome in both themes and reports no wcag2a/wcag2aa violations, alongside a 44 x 44
target sweep, a no-horizontal-scroll check at 320 px and 390 px, and an assertion that every route
row carries its own text. 39 checks in total, and the gate refuses to run any of them if its
selector manifest does not match — the difference between grading the app and grading nothing.

Ten of those are a second pass that enters follow mode and re-runs the sweep, axe and the overflow
check there. Follow mode was the one user-facing screen with no automated coverage of any kind: the
gate reached it through neither of its entry points, and no test in the suite renders a component.
It had been overflowing its own container on every phone in portrait since it was written.

Four more guard the panel's scroll arrangement, and the gate now clears any service worker left in
its profile before grading. It had none, and `sw.js` serves the shell cache-first without
revalidating, so a run could silently grade the *previous* build — observed once, on a restructure
whose new class the manifest reported as matching zero elements while it was present in the served
bundle.

`.github/workflows/ci.yml` runs it on every push and `make check` includes it. The paragraph that
used to sit here said axe-core was "still a devDependency and nothing runs it", which was true when
the gate left the tree in the reconciliation merge and stopped being true when it came back.

All three presets route against a self-hosted server. `scripts/verify_selfhosted.py` asserts it at
**three** of its four locations under the default `demo` region set: all three presets answer, their
geometries differ from each other, and `smoothness` comes back as a path detail — which is the fifth
hard accessibility constraint, and the one the hosted API cannot supply at all.

The fourth, Edinburgh, is skipped rather than failed, and `scripts/verify_selfhosted.py:43-55`
explains why. `demo` imports three bounding boxes — Sri Lanka, Greater London, Noord-Holland — while
Edinburgh exists only under the `countries` set, which builds Great Britain entire and needs a 20 GB
serve heap. "You did not import Scotland" is a fact about the region set, not a defect in the router,
so the script asks the running graph what it covers instead of assuming.

**The frontend answers "when should I go?" and "which way, exactly?"** — a best-departure window,
sunrise and sunset computed in the browser, turn-by-turn directions with a barrier rendered inside
the step you would meet it on, and a live follow mode in which the position never leaves the page,
measured at zero outbound requests.

**It installs and opens offline again.** The service worker precaches the app shell, and the
layout and accessibility gate is back — rewritten rather than restored, because the version that
belonged to the launch frontend selected on seven classes this tree does not have and four of its
checks graded nothing. Verified with the network cut at the browser level: the app still opens.

The *native* rebase is still open. A service worker never registers under `capacitor://localhost`,
so the iOS build needs the same capability on Preferences rather than CacheStorage;
[BLOCKED.md](BLOCKED.md) §5 has that row.

### What is measured

One uncached `POST /api/routes` — a 45-minute foot round trip near Hyde Park, all three
objectives, nothing cached:

| | |
|---|---|
| wall clock | **14.0 s** |
| GraphHopper requests issued | **8** — 6 scenic candidates, 1 fastest, 1 accessible |
| fastest | 35.9 min · 2,939 m · 64% of its length checked · 3 findings |
| scenic | 22.4 min · 1,791 m · 88% checked · greener than fastest (0.666 vs 0.646) |
| accessible | **blocked** — hard constraints reject it, and it says so |

That is one measurement on one machine against a warm graph, not a benchmark. The scenic route
came back well under the time budget and carries a `preset_note` saying so, which is the app
working as intended rather than a defect.

### What is still unverified

**Nothing is deployed, and the AWS stacks have never been applied.** All four
CloudFormation templates validate and `cfn-lint` passes, which proves they are
well-formed and nothing else. [`infra/README.md`](infra/README.md) lists
seventeen gate items and marks every one UNVERIFIED with the command that would
settle it.

**The scenery scores are now real, and you should still read the caveats.**
`data/cache.db` ships with 146 pre-warmed CLIP segments and `/api/routes`
returns `scoring_method: "clip"` — but the prompt pair was chosen from three
location pairs, one of which rests on two images, and `v2_plain` measures
aesthetic appeal rather than greenery. The full table and both caveats are in
`backend/scoring.py` beside the constant, and in
[BLOCKED.md](BLOCKED.md) §2.

**Not tested on a real phone.** The layout and the targets are measured in headless Chrome at
390×844. That is not the same claim as a phone in a hand, and it is about to matter a great deal
more — this tree is the base for a native iOS build, where a browser at 390×844 reports zero
safe-area insets and this frontend has no `env(safe-area-inset-*)` in it at all.

### What is deployed

Nothing. [`infra/`](infra/) is four CloudFormation stacks that would deploy it —
ECS Fargate for the API and the router, CloudFront and S3 for the app, GitHub
OIDC for CI with no stored AWS credentials — and none has been applied.
[DEPLOY.md](DEPLOY.md) is written to be followed without guessing.

What *has* run end to end is the same stack under `docker compose`: both images
build, both containers reach healthy, and a real request returns three routes
with real CLIP scores. [PROGRESS.md](PROGRESS.md) is the full build log,
including the hostile self-audit and what a reviewer should still be sceptical
about. [docs/adr/](docs/adr/) has the six decisions worth questioning.

### What the redesign added

- A dark-green design system with a full dark theme, and no hard-coded colour outside two `:root`
  blocks.
- A **comparison rail** of uniform rows in place of three stacked data dumps, with the detail panel
  showing only the selected route.
- A **trip bar** of four labelled segments in place of nine form fields, and a first-run card that
  asks three questions rather than nine.
- **When to go** — the best departure window the API had always returned and the UI had always
  ignored, plus sunrise and sunset computed in the browser.
- **Turn-by-turn directions**, with a barrier rendered inside the step you would meet it on.
- **Live follow mode**, in which the position never leaves the browser.

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

CLIP needs 2–3 GB of RAM. The deployed container has 1 GB. So scoring is split in two:

| local (`requirements.txt`) | deployed (`requirements-deploy.txt`) |
|---|---|
| `batch_score.py` pulls Mapillary imagery | FastAPI reads the committed `data/cache.db` |
| CLIP ViT-B-32 scores each segment | numpy-only `geometry.py` scores the rest |
| writes `data/cache.db` | **no torch, no open-clip-torch** |

Cached regions get real CLIP scores. Everywhere else falls back to geometry with lower confidence.
**Every route states which path produced its numbers** in `scoring_method`.

---

## Setup from a clean clone

Requires Python 3.13 and Node 18+. `make help` lists every command in the
project; `make check` runs exactly what CI runs.

> Python 3.14 cannot build `pydantic-core` as of this writing. Use 3.13.

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

> **The free GraphHopper tier routes `fastest` only.** The scenic and accessible
> presets steer the router with a custom model, and custom models need flexible
> mode, which free packages do not include — the API answers *"Free packages
> cannot use flexible mode"*. Those two come back `status: "blocked"` with that
> reason rather than silently repeating the fastest route. Round trips, path
> details, and therefore the whole accessibility engine, are unaffected. See
> [BLOCKED.md](BLOCKED.md) #0 for the options.

### Self-hosting GraphHopper, so all three presets work

The open-source GraphHopper server has no flexible-mode restriction, so running
one locally is what makes `scenic` and `accessible` real routes rather than
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

Watch your quota under `rate_limit.served_today` — on the VM, with
`curl -s 127.0.0.1:8000/api/health`, because `/api/health` is not reachable from
outside the machine and deliberately so. The default
daily ceiling is 2,000 routed requests, and the default per-IP rate is 12
straight away then 1 a minute — 1,440 a day, so no single address can spend the
ceiling on its own.

This paragraph said "120 routed requests is ~360 of the 500 credits" until now.
Both halves were about the *hosted* GraphHopper's credit quota, which this
deployment does not use; the code stopped agreeing with it two commits before
the sentence was noticed.

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

Stateless by design. No location history, no cookies, no third-party analytics. Coordinates, IP
addresses and user agents are never logged or persisted — there is a filter in
`backend/logging_setup.py` that redacts them as a backstop.

Usage is counted as aggregates only (`route_requests_total`, `routes_blocked_total`,
`cache_hits_total`, `segments_scored_total`) plus a daily unique-session count derived from an
in-memory digest keyed by a salt generated at process start and never written anywhere.

### What the browser keeps

**Two words, the program, and — only if you ask — one route.**

| what | when | why it is allowed |
|---|---|---|
| `meander:theme` — `light` or `dark` | after you pick one | five characters, says nothing about anybody, and without it a dark-mode reader gets a frame of cream on every load |
| `meander:units` — `metric`/`imperial` and `12`/`24` | after you pick one | two words, validated against those enums on both read and write, so the key is structurally incapable of holding a coordinate |
| `meander-shell-<hash>` (CacheStorage) | on first load | the program. Identical bytes for every visitor, derived from the build; it says nothing about anybody, and it is what makes the app open without a network |
| `meander-prefs` (CacheStorage) | after you answer | one word, `true` or `false`. Deliberately **unversioned**, so a deploy cannot silently re-grant a permission you withdrew |
| `meander-results-<hash>` (CacheStorage) | only on explicit consent | **one** route response, at one fixed key so a second cannot sit beside it, always labelled with its age, and deleted the moment you say no. Written by the page (`src/lib/resultsStore.js`), not by the service worker — the worker declines every cross-origin request, and this deployment puts the API on another origin, so a store living there could never run. The request itself is not kept: only a SHA-256 of it, so no coordinate sits in a cache key. That hash is taken over the request with the starting point snapped to a ~11 m grid, so the set still comes back when the device reports a slightly different fix from the same doorstep — measured at 7.00–25.58 m in `resultsStore.test.js` depending on where in the grid square the saved fix sat, and 200 m away never matches |

No cookie, no analytics, no history, no map tiles. Every storage read is wrapped in a `try`,
because Safari in private mode throws on access rather than on write — and the consent flag is
written and then read *back*, so a control cannot claim a permission that storage refused.

Map tiles will **never** be cached. A tile cache is a record of where you have been, and they come
from a third party. The cost is that an offline route has no map behind it — which the app says,
and which it can afford, because the list carries every duration, score, blocker and rest stop.

A route served from that cache is always labelled as saved, with its age, on the row, on the card
and on a pill under the top bar that no panel position can hide. Past fifteen minutes it also
names what has stopped being true: air quality, rest stops and the best time to leave are
measurements of a moment, while the shape of the route is not.
`frontend/src/lib/offline.test.js` holds that contract — there is no age, including an age it
cannot work out, for which the label is allowed to be absent or quiet. An entry that cannot say how
old it is is treated as the *least* trustworthy thing on the screen, not the most.

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

**The sentence names what was examined, not just how much.** Gates, stiles, turnstiles and kissing
gates are checked against OSM barrier nodes fetched for the route, and the sentence reads
"Accessibility data covers N% of this route" only when that check actually ran. When Overpass could
not be reached — or answered with a set too truncated to be a survey — it reads "Surface data covers
N% … Gates and stiles were not checked" instead, because a percentage that silently covers a
dimension nobody looked at is the wrong kind of confident.

Until recently it was always the second case wearing the first case's words: the request path called
the accessibility engine without ever passing it barrier data, so `GATE`, `STILE`, `TURNSTILE` and
`KISSING_GATE` could not fire at all, and a route through a kissing gate came back `ok` with
confidence 1.0 and an empty blocker list.

What Meander cannot see at all:

- temporary obstructions — roadworks, parked cars, bins, market stalls, snow
- door widths, lift outages, and anything indoors
- kerb heights where `kerb` is untagged, which is most kerbs
- barriers OSM records with a value the engine has no verdict for — a bollard, a block, a cycle
  barrier. These are fetched only for the values that can change an answer, because asking for all
  of them returns thousands of nodes for a city-sized area and truncates the query
- barriers mapped onto a way rather than as a node, which the projection does not see
- whether a "step-free" route is actually navigable in a particular chair, with a particular gait,
  on a particular day
- gradients where the elevation model is coarse; it smooths over short sharp ramps

**Meander is a starting point for planning, not a substitute for local knowledge.** If it says a
route is clear and it is not, that is the data being incomplete, which is exactly what the
confidence sentence is warning you about.

### Scenery scores are estimates, and they say which kind

Every route reports `scoring_method`, and it means exactly three things:

| value | what produced the numbers |
|---|---|
| `clip` | CLIP over real Mapillary street imagery, read from the pre-warmed cache |
| `geometry_only` | OSM road-class and surface tags, curviness and elevation — no imagery |
| `placeholder` | The route itself came from a hand-built fixture. The maths ran; the terrain is invented. Not a measurement of anywhere. |

`data/cache.db` ships with 146 CLIP segments across the five demo locations, so
those return `clip`. Anywhere else returns `geometry_only` and says so.

**Three things to be sceptical about, and they are not small.**

The prompt pair was chosen on three real location pairs. Of the seven variants,
only `v2_plain` and `v1_extreme` pointed the right way on all three — the
previous default `v3_nature` and the widest-separating London variant
`v5_street` **both invert on the Colombo pair**, scoring a city fort greener
than a park. The full table is in `backend/scoring.py`.

The evidence behind that is thin: four to six images per location, and only two
at Viharamahadevi — which is the single point deciding the one pair that
separates the candidates, and the only non-European pair.

And `v2_plain` is "a photo of a beautiful place" against "a photo of an ugly
place", which measures **aesthetic appeal, not greenery**, while the number it
feeds is presented as a scenic score. They correlate on this sample. A
photogenic stone street would score well without a tree in it.

The naturalness and air-blend weightings are judgements rather than
measurements, written down here and in PROGRESS.md rather than buried.

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

That was documentation of an intention rather than of the code until recently: `rest_stops` was
typed `list[RestStop]` with a default of `[]`, so the `null` this paragraph describes could not be
emitted, and an unreachable Overpass was indistinguishable on the wire from a route with no benches
on it. The model now carries the distinction the sentence claims. The frontend had been branching
on `rest_stops == null` all along.

The same `null` is returned when Overpass answers but truncates. It caps at a fixed element count
and truncates by element id, which is uncorrelated with position along a route — so a full page is a
perforated sample of the area rather than a shortened one, and presenting it as a survey would drop
benches from the middle of a route with no indication.

### The keyless demo runs on hand-built routing data

Out of the box (`MEANDER_FIXTURES=replay`, no routing server) the committed GraphHopper fixtures
are **synthetic**: real response schema, plausible geometry, invented streets. Every route derived
from one carries `synthetic_upstream: true`, is labelled `placeholder`, and the UI prints "Built
from demonstration data, not a live routing response. Do not follow it."

Point the app at a self-hosted GraphHopper and that stops being true — the routes above under
**Status** are real ones. The distinction survives in the response: `scoring_method` and
`synthetic_upstream` say which kind you are looking at, on every route, always.

### Other things worth knowing

- Offline, the map is blank and the route list is not. Map tiles are deliberately never
  cached — a tile cache is a record of where you have been, and they come from a third party.
  A route served from the cache is always labelled with its age.
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
