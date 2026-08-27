# Meander

**Give it where you are and how long you have. It gives you three routes back.**
**Give it somewhere to be as well, and it gives you three ways there.**

| id | label | what it optimises |
|---|---|---|
| `fastest` | Fastest | Shortest time. The control. |
| `scenic` | Scenic | Maximum greenery, capped at 1.6× the fastest duration. |
| `accessible` | Accessible | Hard accessibility constraints first, then greenery within them. May return no route at all. |
| `quiet` | Quiet | Away from motor traffic, and off cobblestones. |
| `shade` | Shade | The kinds of way that tend to be shaded. Never a bridge deck. |
| `air` | Clean air | Away from motor traffic, and out of tunnels. |

Three at a time, and the first three unless you say otherwise. One dial, 20–360 minutes. No
destination means a round trip from where you started; naming one puts the same three routes on
the way there, and the dial steps aside because the destination is what sets the length.

**The last three are inferred, not measured, and every route from them says so on the card.**
There is no noise layer in OpenStreetMap, no pollution layer, and no canopy a router can steer on
— trees are points and woods are areas, and neither reaches the street. What those presets read is
the *kind* of way: what it carries, what it is made of, whether it is in a tunnel or on a bridge.
[docs/adr/0007](docs/adr/0007-preference-presets-are-proxies.md) is why that was judged worth
shipping and what was rejected on the way.

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

**845 backend tests and 651 frontend tests pass offline**, at 87.46% statement coverage against an
85% floor. Two backend tests skip; both are torch-related and both pre-date this tree. (Those first
two numbers said 706 and 442, then 787 and 597, for several sessions after each pair stopped being
true; these are what the suites report today, and the coverage figure was re-run rather than
carried forward.) The suite never opens a socket, and a job in CI runs it under `unshare -n` to prove
that rather than trust it. The deploy image imports with torch absent, checked against the real
requirements file, and `backend.main` is imported in that environment to prove absence is not the
only thing being measured. (`make test-sandboxed` could not be run in the environment this round's
work was done in — `unshare -n` returns "Operation not permitted" there. The in-suite socket guard
was active and passed; the second line of defence went unexercised locally, and CI still runs it.
[BLOCKED.md](BLOCKED.md) §14.)

**WCAG 2.1 AA, checked rather than asserted.** `frontend/scripts/gate.mjs` runs axe-core against a
real headless Chrome in both themes and reports no wcag2a/wcag2aa violations, alongside a 44 x 44
target sweep, a no-horizontal-scroll check at 320 px and 390 px, and an assertion that every route
row carries its own text. 102 checks in total, and the gate refuses to run any of them if its
selector manifest does not match — the difference between grading the app and grading nothing.

**One of the 102 fails, and it is not new.** `[destination] Find routes still streams cards for a
trip with one` fails here and fails identically on the unmodified baseline, where it was 1 of 85.
It is written down rather than rounded off: "all green except one" is the sentence that hides the
regression the week after it is written. The honest number is **101 of 102, with one pre-existing
failure**, and it is unrelated to anything on this page.

Fifteen of those are the objective picker, which had no interaction coverage at all until the last
three objectives were released: the gate now presses a chip, trades one objective out for another
because the reducer allows only three, and runs axe and the target sweep over a screen where the
newly-pressable accents are actually painted.

Ten more are a second pass that enters follow mode and re-runs the sweep, axe and the overflow
check there. Follow mode was the one user-facing screen with no automated coverage of any kind: the
gate reached it through neither of its entry points, and no test in the suite renders a component.
It had been overflowing its own container on every phone in portrait since it was written.

Seventeen more are the map layers and the compass. Two of the things the layer picker must do are
obligations rather than features — choosing satellite has to carry a visible warning that tiles
will be fetched while walking, and it has to add Esri's credit to the attribution line *without*
dropping OpenStreetMap's — and neither is the kind of thing axe or a target sweep would ever notice
going missing. So the gate opens the menu, grades it with axe while it is open, presses satellite,
and reads the attribution line before and after. The follow pass also now asserts the course-up
compass is painted.

Four more guard the panel's scroll arrangement, and the gate now clears any service worker left in
its profile before grading. It had none, and `sw.js` serves the shell cache-first without
revalidating, so a run could silently grade the *previous* build — observed once, on a restructure
whose new class the manifest reported as matching zero elements while it was present in the served
bundle.

`.github/workflows/ci.yml` runs it on every push and `make check` includes it. The paragraph that
used to sit here said axe-core was "still a devDependency and nothing runs it", which was true when
the gate left the tree in the reconciliation merge and stopped being true when it came back.

All six presets route against a self-hosted server. `scripts/verify_selfhosted.py` asserts it at
**three** of its four locations under the default `demo` region set: every preset answers, all five
steered geometries differ from `fastest`, and `smoothness` comes back as a path detail — which is the
fifth hard accessibility constraint, and the one the hosted API cannot supply at all.

It compares each steered preset against `fastest` rather than all of them against each other. Two
preference presets landing on the same line is honest — without a tunnel near the origin there is
nothing for `air` and `shade` to disagree about, and at Hyde Park `quiet` and `air` do return the
same route — where either one matching `fastest` is the custom-model-ignored failure the script
exists to catch.

**That run is what caught the worst defect in the three new presets.** They shipped their first
version sending one round-trip request and keeping it, and the synthetic fixtures made that look
fine. Against the real graph at Colombo Fort, a 30-minute foot loop came back at **108 minutes** for
Quiet, 118 for Shade and 115 for Clean air. They search three round-trip lengths now and keep the
best fit, which is 18 minutes there — the same 18-minute loop Scenic returns, because that is what
that network has. [docs/adr/0007](docs/adr/0007-preference-presets-are-proxies.md) has the table.

The fourth, Edinburgh, is skipped rather than failed, and `scripts/verify_selfhosted.py:43-55`
explains why. `demo` imports three bounding boxes — Sri Lanka, Greater London, Noord-Holland — while
Edinburgh exists only under the `countries` set, which builds Great Britain entire and needs a 20 GB
serve heap. "You did not import Scotland" is a fact about the region set, not a defect in the router,
so the script asks the running graph what it covers instead of assuming.

**The frontend answers "when should I go?" and "which way, exactly?"** — a best-departure window,
sunrise and sunset computed in the browser, turn-by-turn directions with a barrier rendered inside
the step you would meet it on, and a live follow mode that walks the route with you and redraws it
when you leave it.

**While the walker stays on the route, the default map fetches nothing as they move.** That was
measured, not assumed, and it still holds for the default map and for green cover: OpenFreeMap's
vector source declares `maxzoom: 14`, so the z17 follow camera is served by overzooming tiles the
client already holds, and a full simulated walk made three requests, all of them glyph ranges and
not one of them a tile. Under **satellite** it is false. Esri's imagery is raster to z19, so every
stretch walked pulls new tiles, and the sequence of those requests is the walk.

Two things send the walker's whereabouts off the phone, and the UI names both rather than defending
either. A sustained wrong turn sends the live position to the app's own routing server — once per
recalculation, never per fix — so the route can be redrawn from where the walker actually stands,
the way any navigator is expected to behave; the provenance line under the dock names that before
it ever happens, the recalculating card names it while it happens, and the arrival card counts what
was sent once it has. And under satellite the tile sequence is the walk, so the provenance line
changes with the basemap and names the imagery host, the layer picker warns at the moment of
choosing, and the walk-summary card says the same thing in the past tense. A privacy claim that is
true for the default and false for one path is worse than no claim, because the path is the case
where it matters.

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

**The satellite basemap is running against terms nobody has accepted.** Esri's World Imagery
endpoint is keyless, and keyless is not the same as licensed. Esri's published guidance permits
unrestricted keyless use for OpenStreetMap *tracing and editing*; embedding the imagery in a
third-party application is a different case, and for that Esri asks for four things together: a
free ArcGIS Developer account, no revenue generation, under a million tiles a month, and
attribution. **Three of the four are already true.** This project takes no revenue, is nowhere near
a million tiles, and renders Esri's own `copyrightText` verbatim in the map footer — read from the
service's `?f=json` rather than copied from a tutorial, because Maxar rebranded to Vantor in 2025
and the string most tutorials carry is now the *wrong* credit rather than merely an old one.

The fourth is a registration, not a payment, and it has to be done by a person. Nobody has done it.
[BLOCKED.md](BLOCKED.md) §13 is the open item and says what happens if it is refused;
`frontend/src/lib/basemap.js` carries the full argument and names a verified fallback — EOX's
Sentinel-2 cloudless, keyless and CC BY-NC-SA 4.0 — along with the reason it is not the default
(10 m/pixel, which at follow zoom is a green smear rather than a path).

**Not tested on a real phone.** The layout and the targets are measured in headless Chrome at
390×844. That is not the same claim as a phone in a hand, and it is about to matter a great deal
more — this tree is the base for a native iOS build, where a browser at 390×844 reports zero
safe-area insets and this frontend has no `env(safe-area-inset-*)` in it at all.

### What is deployed

**All six objectives are live**, on a topology that is not the one in `infra/`:

| | where | how it ships |
|---|---|---|
| the app | [`meander-eoc.pages.dev`](https://meander-eoc.pages.dev) | Cloudflare Pages, built from `main` by the GitHub integration |
| the API and the router | `meander-app.duckdns.org` | one VM, `docker compose` behind Caddy: `api`, `graphhopper`, `caddy` |

Verified on 2026-08-26, after the preference presets landed: `POST /api/routes`
returns real routes for `quiet`, `shade` and `air` from the public host, the
default three are unchanged, and `frontend/scripts/live-gate.mjs` reports **28
passed, 0 failed** against production in a real browser — CORS, CSP, the
service worker, the offline open and a permalink among them.

**Nothing from the map-layers round is deployed.** The basemaps, the follow-mode heading,
viewpoints, and both photo endpoints are committed and unshipped, and the `Caddyfile` lines that
make `/api/photos` and `/api/photo/*` public are committed too. Until the VM is redeployed the photo
call 404s against the live API — which `client.js` degrades to a null response rather than an error
box, so the route still draws with no photographs under it.

**The AWS path in [`infra/`](infra/) is still unapplied.** Four CloudFormation
stacks that would deploy it — ECS Fargate for the API and the router, CloudFront
and S3 for the app, GitHub OIDC for CI with no stored AWS credentials — and none
has been applied; `.github/workflows/deploy.yml` has never got past assuming its
role, because the repository has no AWS secrets set. [DEPLOY.md](DEPLOY.md) is
written to be followed without guessing, and documents the Cloudflare path that
is actually serving traffic alongside it.

This section said "Nothing" for several sessions after that stopped being true.
[PROGRESS.md](PROGRESS.md) is the full build log, including the hostile
self-audit and what a reviewer should still be sceptical about.
[docs/adr/](docs/adr/) has the seven decisions worth questioning.

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
- **Live follow mode**, which matches every fix against the line in the browser and sends the
  position out only to recalculate the route after a wrong turn.

### What the layers, the heading and the photos added

- **Three basemaps** — `map`, `green` (the same OpenFreeMap vector tiles repainted so parks and
  woodland come forward), and `satellite` (Esri raster, added lazily *under* the label symbols so
  street names survive over the imagery). Each row in `frontend/src/lib/basemap.js` has to declare
  what it costs to follow with, so nothing can add a basemap and forget to say.
- **Direction in follow mode** — a heading cone under the puck, filtered on `hasHeading` because
  most walking fixes carry none; chevrons along the line ahead; a turn badge drawn on the route at
  the next manoeuvre; and course-up rotation, default on, with a compass to turn it off, an 8°
  threshold so the map does not rock, and north forced under `prefers-reduced-motion`.
- **The provenance sentence became conditional**, which is the most important thing in this list
  and is argued out above.
- **Viewpoints** (`tourism=viewpoint`) alongside benches, water, toilets and shelter, drawn amber
  rather than mint, with per-type glyphs on the detail pills and amenity dots now shown for every
  route rather than only the selected one.
- **The next amenity ahead, in follow mode.** `followTracking` had computed it and returned it as
  `rest` since it was written, and nothing rendered it — so the app knew there was drinking water
  in 200 m and kept it to itself.
- **The elevation profile in follow mode**, compact, with a marker at where you are. The data had
  been on every response since it shipped and only the detail sheet ever read it.
- **Route photographs**, fetched and streamed by the backend so no image host ever sees a user.
  Read the limitation below before trusting the hero.

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

> **The free GraphHopper tier routes `fastest` only.** The other five presets
> steer the router with a custom model, and custom models need flexible mode,
> which free packages do not include — the API answers *"Free packages cannot
> use flexible mode"*. All five come back `status: "blocked"` with that reason
> rather than silently repeating the fastest route. Round trips, path details,
> and therefore the whole accessibility engine, are unaffected. See
> [BLOCKED.md](BLOCKED.md) #0 for the options.

### Self-hosting GraphHopper, so all six presets work

The open-source GraphHopper server has no flexible-mode restriction, so running
one locally is what makes the other five real routes rather than blocked ones.
It also exposes the `smoothness` tag, which the hosted API does not — that is
one of the five hard accessibility constraints, and self-hosting is the only way
it can fire from routing data.

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

`POST /api/routes` · `GET /api/geocode?q=` · `GET /api/health` · `POST /api/report-barrier` ·
`POST /api/photos` · `GET /api/photo/{ref}`

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
That holds for the satellite layer too: `sw.js` will not cache its tiles either.

**Not cached is not the same as not fetched.** The default map and green cover fetch nothing while
you walk — measured, see **Status** — and the satellite layer fetches a tile for every stretch you
cover, from `server.arcgisonline.com`. Those requests are not stored anywhere, by us or by the
browser, but they are made, and the host that answers them can infer the walk from their sequence.
The app says so in three places rather than none: in the layer picker at the moment of choosing, in
the attribution line, and in the provenance sentence at the foot of the follow screen. The basemap
choice is deliberately **not** persisted — it would be a third localStorage key, and the two words
above are the whole of what this app is willing to keep.

**Photographs are fetched by the server, never by your browser.** A route is somebody's Tuesday
afternoon, and asking the browser for a thumbnail hands Wikimedia and Mapillary an IP address next
to a set of coordinates describing where that person is about to walk. So `POST /api/photos`
returns URLs that point back at this service and `GET /api/photo/{ref}` streams the bytes. The
alternative — returning upstream URLs and naming the hosts in the CSP — was rejected twice over: it
reintroduces exactly the disclosure the proxy exists to prevent, and Mapillary's rotating
`scontent-*.xx.fbcdn.net` hostnames cannot be enumerated by a strict policy anyway. `backend/photos.py`
documents the three things that stop a proxy becoming somebody else's open relay: a two-host
allowlist, an HMAC over the reference so a URL cannot be swapped for another on those hosts, and a
size cap with redirects refused.

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

Benches, drinking water, toilets, shelters and — new in this round — viewpoints, within 35 m of
the line. Under-recorded almost everywhere, and the app cannot tell a usable bench from a broken
one. When Overpass is unreachable
the field is `null` — "we could not look" — which is deliberately distinct from `[]`, "we looked
and found none".

That was documentation of an intention rather than of the code until recently: `rest_stops` was
typed `list[RestStop]` with a default of `[]`, so the `null` this paragraph describes could not be
emitted, and an unreachable Overpass was indistinguishable on the wire from a route with no benches
on it. The model now carries the distinction the sentence claims. The frontend had been branching
on `rest_stops == null` all along.

**A viewpoint is not a rest stop and the app does not pretend otherwise.** It arrives from
`tourism=viewpoint` rather than `amenity=*`, and it rides in the same list only because the
corridor match, the spacing score and the map layer all want it treated the same way
*geometrically*. Everywhere a person sees one it is worded and drawn differently: amber rather than
mint, a different glyph, and "a view" rather than "a viewpoint" — because "there is a bench in
200 m" and "there is a view in 200 m" are not the same sentence, and flattening them would waste
the one of the two that would make somebody look up from the phone.

Adding them costs the Overpass query almost nothing, measured with `out count` rather than assumed:
over the Vondelpark bbox, 22 viewpoints against 4,762 amenities, taking the query from 79.4% of its
6,000-element ceiling to 79.7%. Hyde Park has none at all beside 219 amenities. There are two
orders of magnitude fewer viewpoints than benches, for the same reason they are worth showing.

The same `null` is returned when Overpass answers but truncates. It caps at a fixed element count
and truncates by element id, which is uncorrelated with position along a route — so a full page is a
perforated sample of the area rather than a shortened one, and presenting it as a survey would drop
benches from the middle of a route with no indication.

### Route photos are anchored by the objective for only two of the six objectives

The idea is that choosing the scenic route should show you something scenic on it. Two objectives
can deliver that honestly and four cannot, and the response says which it is giving you.

`accessible` anchors the hero at the **first barrier**, which is a real coordinate the route already
carries — so the picture is of the thing that blocks you, which is the most useful image this
feature can produce. `fastest` anchors at the **midpoint**, which is arithmetic and cannot be wrong.

For `scenic`, `shade`, `quiet` and `air` there is no per-segment data anywhere on the wire to anchor
to. Those scores arrive as **one aggregate number for the whole route**; the per-way tag spans they
are computed from are consumed inside the backend and never leave it. So there is no greenest point,
no shadiest point and no quietest point to be found on a `Route`, and the backend does not invent
one: the hero falls back to the most-photographed place near the route — which is a measurement of
Wikimedia Commons, not of the route — and the response carries `objective_measured: false` plus a
sentence saying so, which the UI renders rather than swallows. No caption in this app reads "the
greenest point on this route", because nothing measured greenery point by point.

Every image is somebody else's work under a licence that requires credit. A photo whose licence
could not be determined is dropped rather than shown uncredited, and `Photo.licence` is a required
field with no default so that a later refactor cannot quietly reintroduce the alternative.

Without `MAPILLARY_TOKEN` the photos come from Wikimedia Commons only. That is the ordinary keyless
configuration rather than a failure, and the response says so in `mapillary_enabled` and in a note,
instead of leaving the frontend to guess from an empty `sources_used`.

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
- Satellite imagery: Source: Esri, Vantor, Earthstar Geographics, and the GIS User Community —
  reproduced verbatim from the service's own `copyrightText`. **Read the licensing caveat under
  "What is still unverified"; this one is not settled.**
- Photographs from [Wikimedia Commons](https://commons.wikimedia.org/), under the per-file licence
  the app credits beneath each image.
- Street-level imagery from [Mapillary](https://www.mapillary.com/), CC BY-SA 4.0.
- Weather and air quality from [Open-Meteo](https://open-meteo.com/), CC BY 4.0.
- Routing by [GraphHopper](https://www.graphhopper.com/).
