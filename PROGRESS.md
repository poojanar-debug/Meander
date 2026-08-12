# Progress

Append-only build log. One entry per phase.

---

## Phase A — Scaffold · 2026-08-04

**Done**

- `.gitignore` written and committed as the very first commit, before any file that could hold a
  secret existed.
- Repo structure: `backend/` (config, cache, metrics, logging_setup, main, tests), `data/`,
  `fixtures/`, `docs/`.
- `backend/requirements.txt` (full, includes torch) and `backend/requirements-deploy.txt`
  (explicitly no torch, no open-clip-torch, with a comment saying why).
- `.env.example` listing every key with no values.
- `README.md` with the architecture diagram and clean-clone setup; `CONTRIBUTING.md`; MIT `LICENSE`.
- SQLite schema in `cache.py`: `segment_scores`, `route_cache`, `access_segments`, `meta`.
- `GET /api/health` reporting version, cache stats, `clip_available`, fixture mode, missing keys
  and aggregate counters.
- `PROGRESS.md`, `BLOCKED.md`.
- Privacy-safe `metrics.py` — aggregates plus a daily unique-session count from an in-memory
  digest keyed by a salt generated at process start and never persisted.
- `logging_setup.py` — JSON to stdout with a filter that redacts coordinate/IP/user-agent fields
  as a backstop.

**Verified**

- `pip install -r backend/requirements-deploy.txt` succeeds in a clean venv (Python 3.13).
- In that venv: `importlib.util.find_spec('torch') is None` and `import backend.main` succeeds;
  `clip_available()` returns `False`.
- `git log --diff-filter=A --name-only` contains no `.env`.
- Test suite green with sockets blocked (see the conftest network guard).

**Live API calls used:** 3 total — one keyless reachability probe each to Open-Meteo, Overpass and
GraphHopper (the last returned 401, confirming no key is present). None counted against a service
budget; these predate `fixtures.py`.

**Decisions**

- Python 3.13, not 3.11. It is what is installed here, and it satisfies "3.11+". Consequence:
  `torch==2.5.1` from the spec has no cp313 wheel, so the full requirements pin `torch==2.9.1` and
  `open-clip-torch==2.32.0` (held on the 2.x API). This is a version bump inside the specified
  stack, not a substitution.
- Added `python-dotenv` (not named in the stack list) so `.env` loads without a shell wrapper.
  Reason recorded here per the operating rules. It is 20 KB and has no transitive dependencies.
- Added `pyproject.toml` for pytest/ruff configuration only — no `[project]` or `[build-system]`
  table, because Meander runs from a checkout and is not installed as a package.
- Segment cache keys are grid cells rounded to 4 decimal places (~11 m) rather than raw
  coordinates. Neighbouring requests then share cache entries, and no stored row is attributable
  to a single user's path.
- `Cache.__init__` resolves its path at call time instead of binding `CACHE_DB_PATH` as a default,
  so tests can redirect it.

**Deviations**

- `docs/API.md` deferred to Phase C, when the contract is real rather than aspirational.

**Blockers opened:** BLOCKED.md #1 (no `GRAPHHOPPER_KEY`), #2 (no `MAPILLARY_TOKEN`),
#3 (prototype `Waypoint.dc.html` / `mock-api.js` referenced by HANDOFF.md are not on this machine).

---

## Phase B — Fixtures + live-call budget · 2026-08-04

**Done**

- `backend/fixtures.py`: record/replay around the one shared `httpx.AsyncClient`.
  - `signature()` hashes method, host, path, query, body and content-type. **API keys are
    deliberately excluded**, so two contributors with different keys share fixtures.
  - `replay` (default) never opens a socket; a miss raises `FixtureMissing` naming the exact
    command to record it. `record` replays known signatures and goes live for new ones. `live`
    always goes live and still writes the fixture.
  - Secrets are redacted from the fixture body *and* the stored URL's query string, with a
    post-write assertion that deletes the file if a live key value appears in it anyway.
  - Non-2xx responses are never recorded — replaying a 401 forever would look exactly like a
    routing bug.
- `LiveCallBudget`: per-service hard ceilings persisted to `fixtures/_budget.json` (gitignored).
  Hitting a cap logs once, downgrades that service to replay-only and lets the run continue. A
  refused spend is not charged. An **unbudgeted service gets zero live calls**, so a hostname typo
  cannot become an uncapped spend.
- Provenance travels on the response as `x-meander-provenance`: `live`, `recorded` or `synthetic`.
  `is_synthetic()` is the hook downstream code uses to refuse to present a hand-built fixture as a
  measurement.
- `/api/health` now reports the budget snapshot and a fixture inventory split by provenance.

**Verified**

- 56 tests pass with outbound sockets blocked by an autouse conftest guard, including a meta-test
  (`test_the_socket_guard_is_actually_active`) that proves the guard is really in force — without
  it, "the suite passes offline" would be an untested claim.
- `test_record_mode_writes_a_fixture_then_replays_it` drives the full record path over an
  `httpx.MockTransport` and asserts the upstream is called exactly once across two `fetch()` calls,
  and that the replay is not charged to the budget.
- `test_recorded_fixture_never_contains_the_live_key` sets a fake live key and asserts it is absent
  from the written file.

**Live API calls used:** 0.

**Decisions**

- Budget cost is a parameter (`cost=`), not a constant, because GraphHopper charges ~3 credits per
  route request while Open-Meteo charges 1. Routing passes `cost=3`.
- The budget file is gitignored rather than committed: it is machine-local spend, not shared state,
  and committing it would create a merge conflict on every contributor's first live call.
- Provenance is carried as a response header rather than a wrapper type so callers keep using the
  ordinary `httpx.Response` API and cannot forget to unwrap.

**Deviations:** none.

---

## Phase C — Routing · 2026-08-04

**Done**

- `backend/geometry.py` — geometric primitives (haversine, cumulative distance, bearing, sampling,
  turn angles, loop closure, GeoJSON conversion). numpy only. Scoring lands in Phase F.
- `backend/routing.py` — GraphHopper client with the three presets, round trips, error shaping,
  and the single coordinate converter. Nominatim geocoding lives here too.
- `backend/models.py` — the wire contract as pydantic models.
- `backend/ratelimit.py` — per-IP token bucket plus a global daily ceiling.
- `POST /api/routes`, `GET /api/geocode`, whole-route cache, `X-Meander-Cache` header.
- `scripts/make_synthetic_fixtures.py` and `backend/record_fixtures.py`.
- `docs/API.md`.

**Verified**

- 139 tests pass with sockets blocked.
- Three presets differ measurably on **four** locations, not the two required:

  | scenario | fastest | nature | accessible |
  |---|---|---|---|
  | Colombo Fort → Viharamahadevi (foot, 25 min) | 37.2 min / 3010 m | 52.7 min / 3755 m (×1.42) | 40.7 min / 3133 m |
  | Euston Rd → Hyde Park (foot, 40 min) | 38.3 min / 3100 m | 54.3 min / 3868 m (×1.42) | 41.9 min / 3227 m |
  | Hyde Park loop (foot, 35 min) | 32.6 min / 2641 m | 40.9 min / 2912 m (×1.25) | 34.2 min / 2635 m |
  | Vondelpark loop (bike, 60 min) | 52.4 min / 13195 m | 65.5 min / 14522 m (×1.25) | 55.1 min / 13188 m |

- Round-trip loops return to the origin (`test_round_trip_returns_to_the_origin`, < 150 m closure).
- Nature stays inside the 1.6× duration cap on every scenario.
- 429 fires on per-IP exhaustion **and** on the daily ceiling, each with its own message and a
  `Retry-After` header.
- A cache hit refunds the rate-limit token — verified by test, because charging for a cache hit
  would throttle users for work the server never did.
- The `accessible` preset returning no route is a `200` with `status: "blocked"`, and the other two
  routes are unaffected.

**Live API calls used:** GraphHopper 0 (of 80). Nominatim 5 (of 40) — real geocode fixtures for the
five test locations.

**Decisions**

- **Geocoding uses Nominatim, not GraphHopper.** GraphHopper's geocoder spends from the same
  500-credit/day pool as routing, which is the scarce resource; Nominatim is keyless and free. The
  shared client already sends a real User-Agent, which Nominatim's usage policy requires.
- **The accessible custom model excludes only *known-bad* tags, never missing ones.** Excluding
  `surface == MISSING` is the literal reading of the spec's hard constraint, but most of the world
  is untagged, so it returns no route almost anywhere and the feature becomes useless. Instead:
  known-bad values are rejected by the router outright, and untagged ways are routed and then
  marked UNKNOWN by `accessibility.py`, counted against `confidence`, and **never reported as
  accessible**. There is a test (`test_accessible_model_does_not_exclude_untagged_ways`) pinning
  this, and Phase H adds the tests pinning the UNKNOWN side. This is the single most important
  design decision in the project and it is deliberately not a silent one.
- Nature climbs a `distance_influence` ladder of 20 → 45 → 90, stopping at the first result inside
  the 1.6× cap, rather than returning an over-budget route. On the synthetic fixtures rung 1 always
  suffices (ratios 1.25–1.42).
- `round_trip.seed` is fixed at 42. A varying seed means a stable input produces a different route
  every time, the whole-route cache never hits, and every page reload spends three credits.
- Round-trip distance comes from deliberately conservative speeds (foot 75 m/min, bike 220,
  car 550). Overshooting costs the user their actual time budget.
- Added two fields not in the original contract: `synthetic_upstream` (a route built from a
  hand-authored fixture must never look like a measurement) and `status_note` (the contract has
  nowhere to say *why* a route is blocked when the reason is not a geographic blocker).
- Added `backend/models.py` and `backend/ratelimit.py`, which are not in the spec's file list.
  Rate limiting is specified as living in `main.py`; extracting the bucket keeps it unit-testable
  without a TestClient. No new third-party dependency was added.
- A preset that fails to route degrades to `status: "blocked"` rather than failing the whole
  request. Only `fastest` failing is fatal, because without the baseline there is nothing to show.

**Deviations (Phase C)**

- GraphHopper fixtures are **synthetic**, not recorded — there is no API key on this machine
  (BLOCKED.md #1). They use GraphHopper's real response schema and plausible geometry, so every
  parsing, scoring and accessibility path is exercised, but each one is stamped
  `"_meander_provenance": "synthetic"`, `/api/health` reports the count, and every route derived
  from one carries `synthetic_upstream: true` with `scoring_method: "placeholder"`.

---

## Phase D — Frontend · 2026-08-04

**Done**

- Vite + React (JavaScript, not TypeScript) + MapLibre GL, structured as the handoff specifies:
  `App.jsx` (all state), `api/client.js`, `api/mock.js`, seven components, `lib/format.js`,
  `lib/dash.js`.
- Streaming client: parses `text/event-stream` and pushes each route into state as it lands,
  falling back transparently to whole-document JSON. Routes merge by `id`, so the narration pass
  updates a card instead of appending a duplicate.
- Debounce table implemented as specified — dial 400 ms, mode 120 ms, objective chip 120 ms, place
  pick immediate — with an `AbortController` per request. **The previous result stays rendered and
  interactive during a refetch;** only the banner changes.
- MapLibre: one `geojson` source and a `case-`/`line-` layer pair per route, selection applied with
  `setPaintProperty` rather than by re-adding layers, `fitBounds` on selection with padding 70 (40
  when narrow) and `duration: 0` under `prefers-reduced-motion`.
- All six objectives with distinct colour **and** dash pattern; max three selected, never zero.
- `api/mock.js` gated on `VITE_MOCK_API === '1'`, with the header stating in visible text that the
  build is on fixtures. Emits four progress events over ~2.2 s, one route every ~420 ms, then a
  narration pass at +700 ms, and includes the required blocked-accessible fixture with
  `confidence: 0.41` and two blockers.

**Verified in a real browser, against mocks, with the backend never started**

- `npm run build` succeeds.
- Full flow works end to end: type a place → arrow-key the listbox → Enter picks it → routes
  stream in → cards and map populate.
- **Keyboard:** tab order runs skip-link → controls → dial → mode → six chips → map → three route
  selectors → footer, with nothing unreachable. Combobox `ArrowDown`/`ArrowUp`/`Escape`/`Enter`
  verified by dispatching properly-keyed events and asserting `aria-activedescendant` and
  `aria-selected` move with the highlight.
- **Target size:** every interactive element in the app measures ≥ 44 × 44 px, checked by script.
  MapLibre's own 29 px zoom buttons are enlarged to 44 px in CSS rather than left as the one
  exception.
- **The map is not load-bearing:** with `display: none` on `MapView`, the results panel still
  contains every duration, distance, all three scores, the scoring method, the confidence
  sentence, rest stops, both blockers and the narration.
- **Live region** announces route arrival (count, routable count, each label + duration +
  distance) and selection changes (label, duration, distance, confidence sentence), debounced
  350 ms so a dial drag cannot spam it.
- **Derived mode updates on the drag itself**, before any network call:
  `aria-valuetext` goes from "35 minutes, walking" to "150 minutes, driving" on the change event.
- **375 px:** `scrollWidth === clientWidth`, so no horizontal scrolling; the 860 px breakpoint
  stacks the layout as specified.

**Live API calls used:** 0.

**Two real defects found by testing in the browser and fixed**

1. `RouteCard` wrapped the whole card in a `<button>` containing `<p>`, `<dl>` and `<ul>`. That is
   invalid HTML, and screen readers flatten such a button's contents into a single unreadable
   label — the card is the accessibility story for this app, so this was the worst possible place
   for it. Restructured: the card is an `<li>`, and the selector is one button holding only
   phrasing content. Pointer users can still click anywhere on the card. Asserted by a DOM check
   that no `<button>` contains block or interactive content.
2. Rest-stop pluralisation produced "2 benchs" and "1 drinking water". Added a name table for the
   OSM amenity types plus an `-es` rule, so it now reads "2 benches and 1 drinking water tap".

**Decisions**

- **Fonts are not fetched.** Newsreader and IBM Plex Sans are named first in the stack with
  system serif/sans fallbacks, rather than loaded from Google Fonts. Loading a webfont from a
  third party would leak every visitor's IP to that third party, and the app's headline promise is
  that it does not do that. The visual system degrades to a system serif where the fonts are not
  installed locally.
- MapLibre is split into its own Rollup chunk: it is 1 MB and never changes, so a UI edit should
  not invalidate it in the browser cache.
- Footer and map-attribution links are inline in a sentence and cannot be 44 px tall without
  wrecking the prose; WCAG 2.2 exempts inline targets for that reason. They are padded to ~39 px
  and the exception is recorded here rather than left silent.
- The map degrades explicitly: if WebGL is unavailable or the style host is blocked, a visible
  message says so and points at the list, which already carries the whole answer.

---

## Phase E — Deploy-ready · 2026-08-04

**Done**

- `render.yaml` — Blueprint for the backend. Every secret is `sync: false`, so Render prompts for
  it and no key can end up in the file. `MEANDER_STRICT_STARTUP=1` and `MEANDER_FIXTURES=live` in
  production.
- `frontend/vercel.json` — SPA rewrite, immutable asset caching, and a real security header set
  including a CSP that allows exactly `'self'` plus `tiles.openfreemap.org` and the API origin.
- `DEPLOY.md` — step by step, with the two-part CORS/CSP closing step called out explicitly
  because the site is broken until both are done, and a "things that look like bugs and are not"
  table.
- Frontend now honours `VITE_API_BASE`, defaulting to same-origin `/api` so local dev is unchanged.

**Verified**

- Fresh `python3.13 -m venv` + `pip install -r backend/requirements-deploy.txt` succeeds, and
  `torch`, `open_clip` and `torchvision` are all absent (`find_spec` is `None` for each).
- That build boots under uvicorn and serves both endpoints:
  - `/api/health` → `"status": "ok"`, `"clip_available": false`, and a fixture inventory correctly
    reporting 18 synthetic GraphHopper fixtures against 5 recorded Nominatim ones.
  - `POST /api/routes` → three routes, 37.2 / 52.7 / 40.7 min, each labelled
    `scoring_method: "placeholder"` and `synthetic_upstream: true`.

**Live API calls used:** 0.

**Decisions**

- Split deployment uses `VITE_API_BASE` rather than a Vercel rewrite. A rewrite cannot read an
  environment variable, so the backend host would have to be hard-coded into `vercel.json` — this
  way the same commit deploys against any backend, and the CSP is the only place the host is named.
- `MEANDER_CACHE_DB` points at `/tmp` on Render. The free plan's filesystem is ephemeral, so a
  cache under the repo root would be silently discarded anyway; naming `/tmp` makes that explicit
  instead of surprising. Segment scores survive because they live in the committed `data/cache.db`.
- The daily ceiling defaults to 120 routed requests (~360 GraphHopper credits of the 500/day free
  tier), leaving headroom for geocoding and retries.

**Deviations:** none. **Nothing was deployed** — this phase produces configuration and
documentation only.

---

## Phase F — Geometry scoring · 2026-08-04

**Done**

- `backend/geometry.py` gains real scoring, numpy only, no torch anywhere near it:
  - **curviness** — accumulated heading change per 100 m, saturating at 45°/100 m. Length-normalised
    so a long straight road and a short one are equally uncurvy; a long one would otherwise
    accumulate more turning from vertex noise alone.
  - **elevation variance** — standard deviation of the elevation profile, saturating at 15 m.
    Returns `None`, not `0`, when the router gave no elevation.
  - **naturalness** — length-weighted mean over OSM `road_class` and `surface` path details
    (65/35), with `road_class` dominant because a paved path through a park is still a park path.
  - **air proxy** — length-weighted `road_class` exposure to motor traffic. Labelled a proxy in the
    code and in this log; real measurements arrive in Phase I.
- `score_geometry()` renormalises the spec's weights when a term is missing, rather than scoring
  out of 0.55 whenever CLIP is absent.
- Wired into `/api/routes`. `Scores` fields are now `float | None`, and the frontend renders `null`
  as "not measured" rather than an empty bar.

**Verified**

- 233 tests pass; 48 of them are new geometry tests checking the maths against hand-computable
  cases (London→Paris distance, a right-angle turn measuring 90°, one degree of latitude) rather
  than against whatever the code happened to return.
- **The DoD case, on the real test locations:**

  | route | Colombo Fort → Viharamahadevi | Hyde Park loop |
  |---|---|---|
  | fastest (arterial) | nature **0.257**, air 0.406 | nature **0.338**, air 0.386 |
  | nature (park) | nature **0.659**, air 0.925 | nature **0.785**, air 0.899 |
  | accessible | nature 0.271, air 0.648 | nature 0.383, air 0.745 |

  A park route scores roughly 2.5× an arterial one, and the air proxy orders footway above
  residential above arterial, as it should.
- `test_untagged_spans_lower_coverage_but_never_move_the_score` pins the rule that an absent tag
  can only reduce coverage, never raise or lower a score.
- `test_missing_elevation_does_not_drag_the_nature_score_down` pins the renormalisation: without
  it, a region where the router returns no elevation would look uniformly worse for a reason that
  has nothing to do with the place.

**Live API calls used:** 0.

**Decisions**

- **`scoring_method` stays `"placeholder"` on routes built from synthetic fixtures, even though
  the scoring maths genuinely ran.** The maths is real; the terrain it ran on is invented. A
  number derived from invented terrain is not a measurement of anywhere, and calling it
  `geometry_only` would imply it was. Recording GraphHopper fixtures with a real key flips these
  to `geometry_only` automatically.
- `shade` is `null`, not `0.0`, until Phase I computes a real sun position. Zero shade is a claim
  about a place; "not measured" is a different claim, and the contract now distinguishes them.
- The naturalness and air tables are judgements, not measurements. That is exactly why every
  response carries `scoring_method`, and why the CLIP path exists.
- The test helper's metres-per-degree constant was switched from the usual 111_320 shorthand to
  the value implied by `EARTH_RADIUS_M`, so assertions can be exact instead of approximate.

**Deviations:** none.

---

## Phase G — CLIP scoring · 2026-08-04

**Done**

- `backend/scoring.py` — CLIP ViT-B-32 (`laion2b_s34b_b79k`), contrastive zero-shot over a
  positive/negative prompt pair, softmax, positive probability. **Every torch and open_clip import
  is inside a function**, with a test that greps the module source to keep it that way.
- Mapillary client sampling one bounding box per point along the polyline, half-width 0.002° —
  a 0.004° box, inside the 0.01° limit that changed on 2026-01-16.
- `clip_term_for_route()` — the only function the request path calls. Cache reads only: no torch,
  no network. Returns `None` for any region that has not been pre-warmed, which is the signal to
  fall back to geometry scoring and say so.
- `backend/batch_score.py` — offline pre-warm, never in the request path. Refuses to start without
  torch, without a token, or in replay mode, each with a specific message. Stops cleanly when the
  Mapillary budget runs out instead of failing mid-run, and writes each point as it goes so a
  crash never loses completed work.
- `scripts/compare_prompts.py` — runs all seven variants and prints a ranking.
- `/api/routes` now emits `scoring_method: "clip"` when cached CLIP segments cover the route.

**Prompt variants — seven tried, and the result was not what the spec assumed**

Run: `python3 -m scripts.compare_prompts` on **procedurally generated reference images** (a foliage
texture against an asphalt texture with lane markings).

| variant | green | grim | separation | correct? |
|---|---|---|---|---|
| `v5_street` — "leafy, quiet, attractive street" / "bleak, traffic-dominated street" | 0.869 | 0.047 | **+0.821** | yes |
| `v7_park` — "in a park or woodland" / "beside a busy road or car park" | 0.785 | 0.002 | **+0.783** | yes |
| `v3_nature` — "green natural place with trees and plants" / "bare place made of concrete and asphalt" | 0.751 | 0.000 | **+0.751** | yes |
| `v1_extreme` — the spec's pair, "extremely scenic" / "extremely ugly" | 0.002 | 0.005 | −0.004 | **no** |
| `v2_plain` — "beautiful place" / "ugly place" | 0.012 | 0.048 | −0.036 | **no** |
| `v4_walk` — "pleasant to walk through" / "unpleasant to walk through" | 0.076 | 0.195 | −0.119 | **no** |
| `v6_restorative` — "calm restorative place" / "harsh place someone would hurry through" | 0.006 | 0.349 | −0.344 | **no** |

The four abstract aesthetic pairs — including the spec's own `v1_extreme` — **invert** on this
set: they score the asphalt image *higher*. Only the three concrete, descriptive pairs separate in
the right direction. That is a strong enough signal to act on, but it is **not** a finding about
real streets: these are synthetic textures, and part of why the abstract pairs fail may simply be
that a generated foliage texture does not read as "scenic" to CLIP.

**Verified**

- 277 tests pass. Two are skipped without torch and run under the full environment.
- `test_scoring_module_has_no_module_level_torch_import` greps the source for top-level torch and
  open_clip imports — the deployed instance would die at startup on one, so a comment was not
  enough.
- `backend.scoring` and `backend.main` both import cleanly in the deploy venv with torch absent.
- `test_clip_ranks_a_green_scene_above_a_grim_one` runs real CLIP inference on MPS and confirms
  the active pair is not inverted.
- `scoring_method` transitions verified directly: `clip` with cached segments, `geometry_only`
  without, and **`placeholder` on a synthetic route even when real CLIP scores are cached** —
  real inference over invented geometry is still not a measurement of anywhere.
- The bounding box is asserted under 0.01° square, centred on its point, and in
  `minLon,minLat,maxLon,maxLat` order — a transposed one would silently return imagery from
  somewhere else.

**Live API calls used:** Mapillary 0 (no token). The CLIP weights (~600 MB) were downloaded once
from the Hugging Face hub; that is a model download, not a metered API, and the test suite runs
with `HF_HUB_OFFLINE=1` so it never repeats it.

**Decisions**

- **`ACTIVE_PROMPT_VARIANT` is `v3_nature`, not the spec's `v1_extreme`.** The spec's pair
  inverted on every reference image tried. Of the three that worked, `v5_street` separated widest,
  but `v3_nature` names the thing actually being scored — greenery — and on synthetic textures the
  margin between the three is not meaningful. `v1_extreme` is retained in `PROMPT_VARIANTS`, and a
  test pins its exact wording, so the comparison can be rerun. **This choice needs re-validating on
  real imagery before it is trusted** — BLOCKED.md #2 has the command.
- A point with fewer than two usable images is cached with a `NULL` score, not a low one. One
  blurry frame is not evidence about a place, and caching the null stops a later run paying to
  rediscover the same absence.
- Image downloads go through `fetch(..., persist=False)`: the budget still counts them, but no
  fixture is written. Committing street imagery would add megabytes for no benefit, because the
  expensive derived thing — the score — is itself persisted, in `data/cache.db`.
- Sampling is capped at 40 points per route at 150 m spacing. Each point is one Mapillary request
  plus up to four image downloads, so an uncapped 360-minute car route would drain the 200-call
  budget in a single run.

**Deviations**

- `data/cache.db` ships with no CLIP rows, so every route is `geometry_only` (or `placeholder`)
  until someone with a Mapillary token runs `batch_score.py`. The response states which path it
  used on every route, so this is visible rather than silent.

---

## Phase H — Accessibility engine · 2026-08-04

**Done**

- `backend/accessibility.py`. Three-valued `Verdict` — `PASS`, `FAIL`, `UNKNOWN` — with the rule
  enforced in the type system rather than by convention: **`Verdict.__bool__` raises.** Writing
  `if verdict:` is a `TypeError` on first execution instead of a wrong answer in production,
  because that expression would silently treat UNKNOWN as accessible.
- All five hard constraints, each rejecting only on a *tagged* bad value:
  `highway=steps`; `barrier` in {gate, stile, turnstile, kissing_gate}; incline > 8% or > 5%
  sustained over 50 m; surface outside {paved, asphalt, concrete, paving_stones, compacted};
  smoothness in {bad, very_bad, horrible, very_horrible, impassable}.
- Blockers are located on the ground — lat, lon, distance along the route, and a sentence a person
  can act on ("Steps with no recorded step-free alternative.").
- Confidence is the fraction of route length with a definite verdict, and the sentence it produces
  is the exact copy from the handoff, escalating at 0.6 and again at 0.3.
- Wired into `/api/routes`: `status`, `blockers`, `confidence` and `confidence_note` are now real.
  The frontend renders the backend's sentence, so the wording cannot drift between the two halves.

**Verified — 296 tests, 80 of them in `test_accessibility.py`**

- **The DoD case**: Euston Road → Hyde Park returns `200` with the accessible route
  `status: "blocked"` and two located blockers — `steps` at (51.51598, −0.14319) and
  `surface: cobblestone` at (51.51201, −0.14998) — while the other two routes stay `ok`.
- **The invariant**, from several directions:
  - `test_an_entirely_untagged_route_is_never_reported_as_accessible` — no tags gives `UNKNOWN`,
    coverage 0, and the sentence "do not rely on it".
  - `test_a_route_tagged_only_with_road_class_is_not_accessible` — a way tagged `FOOTWAY` and
    nothing else is still UNKNOWN. A footway can be cobbles.
  - `test_a_surface_value_nobody_anticipated_is_unknown_not_accessible` — an unrecognised OSM
    value is UNKNOWN, not a pass. New values appear constantly.
  - `test_a_verdict_cannot_be_used_as_a_boolean` — the type-level guard itself.
- Every constraint has a test per value, generated from the constant sets, plus a test asserting
  each set matches the specification exactly — so silently dropping `kissing_gate` fails the suite.
- `test_elevation_noise_does_not_invent_a_gradient` — ±0.3 m of sensor noise on 5 m vertices reads
  as a 12% gradient without smoothing. It now reads as flat, which it is.
- `test_a_downhill_gradient_is_rejected_too` — descending a 14% slope in a wheelchair is not safer
  than climbing it.

**Live API calls used:** 0.

**Decisions**

- **`road_class` can reject but can never pass.** Only `surface` and `smoothness` can say a stretch
  is passable, so `assess_road_class` returns `FAIL` for steps and `UNKNOWN` for everything else —
  including `FOOTWAY`. Coverage is therefore driven by surface and smoothness alone, which is why a
  route tagged only with road classes reports 0% coverage rather than a misleadingly high one.
- **Hard constraints block only the `accessible` preset.** The same findings appear on the other
  two routes as information: someone walking may well take a route with three steps in it and
  should still be told they are there. Blocking every route on any finding would make the app
  useless in most cities without making anyone safer.
- Incline is measured on an elevation profile resampled to a fixed 20 m grid. Routers emit vertices
  at irregular spacing, and 0.3 m of sensor noise across a 2 m segment reads as a 15% gradient that
  is not there.
- A synthetic route reports `confidence: 0.0` and the synthetic warning, never a coverage figure.
  A coverage number computed over invented tags is not a coverage number.
- The incline sentence uses one decimal place. At zero it printed "A gradient of 8%, steeper than
  the 8% limit", which is self-contradictory and undermines the one thing the message must do.

**Deviations:** none.

---

## Phase I — Enrichment + narration · 2026-08-04

**Done**

- `backend/enrich.py`:
  - **Solar position** computed locally (NOAA algorithm), not fetched. It is pure arithmetic, so
    calling an API for it would spend budget and add a failure mode to something that cannot fail.
  - The spec's two formulas verbatim: `golden_hour = max(0, cos(azimuth − heading))` inside the
    0–15° elevation band, `shade_need = max(0, sin(elevation))`.
  - **Air quality** from Open-Meteo's European AQI, mapped to a 0–1 score.
  - **Rest stops** from Overpass — benches, drinking water, toilets, shelters — filtered to a 35 m
    corridor around the polyline and reported with their distance along the route.
  - **Best departure**: 15-minute steps across six hours, scored on air quality, how much shade is
    wanted against the cloud cover, and whether the light will be low and along the route.
- `backend/narrate.py` — Anthropic call, given only the facts already in the response and
  instructed never to invent a landmark. Absent key means `narration` stays `null`.
- All of it wired into `/api/routes`, with enrichment fetched **once per request** over the union
  of every route's geometry rather than once per route.

**Verified — 351 tests**

- **The DoD case.** `test_killing_one_enrichment_service_still_returns_200` kills each of the four
  enrichment entry points in turn; another kills all four at once; two more kill scoring and the
  accessibility engine. Every one still returns `200` with three routes.
- **Those tests found a real gap.** The degradation guarantee was not actually implemented — an
  exception from any enrichment or scoring stage propagated straight out of `/api/routes` as a 500.
  Fixed with explicit, logged guards in `enrich_context` and `_scored_route`; a failed scoring run
  now yields null scores and `scoring_method: "placeholder"`, and a failed assessment yields
  confidence 0 with "could not be assessed at all".
- **The sun tests found a real bug.** `test_the_sun_is_due_south_at_local_solar_noon` returned
  2.6° instead of 180°. NOAA's formula gives `cos(180 − azimuth)`, not `cos(azimuth)`; dropping the
  180 put the noon sun due *north*, which would have inverted every shade and golden-hour figure in
  the app. Now checked against London midsummer (61.9°), midwinter (15.1°), sunrise in the east,
  sunset in the west, and a near-overhead tropical sun.
- **Live end to end**, from recorded fixtures:

  | Hyde Park loop, foot, 35 min | nature | air | shade | rest stops |
  |---|---|---|---|---|
  | fastest | 0.338 | 0.514 | 0.751 | 10 |
  | nature | 0.785 | 0.678 | 0.751 | 9 |
  | accessible | 0.383 | 0.629 | 0.751 | 8 |

  `best_departure: 2026-08-04T19:15Z`, reason *"The light will be low and along your way, and air
  quality is good."*

**Live API calls used:** Open-Meteo 21 of 100, Overpass 13 of 50, Nominatim 5 of 40. GraphHopper 0,
Mapillary 0, Anthropic 0.

**Overpass really does rate-limit as aggressively as the brief warned.** Roughly half the queries
came back 429 or 5xx on first attempt. The back-off is to give up on that request rather than
retry into a longer ban, and the recorder pauses 45 s between queries; getting nine usable fixtures
took several passes. The app's behaviour under that failure is the interesting part, and it is
correct: rest stops come back `null`, everything else is unaffected, and the response is still 200.

**Decisions**

- **`null` and `0` are kept strictly apart.** `fetch_rest_stop_nodes` returns `None` for "could not
  look" and `[]` for "looked, found none". Conflating them would report a bench-less route as
  verified. The same rule governs every score.
- **Air is a blend**, not one or the other: `measured × (0.55 + 0.45 × road_class_proxy)`. The
  Open-Meteo reading is a real measurement but regional, so alone it gives all three routes an
  identical number; the road-class proxy is route-specific but only a proxy. Together they say
  "the regional level, modulated by how much traffic this route runs alongside". Formula recorded
  here because it is a judgement, not a measurement.
- Enrichment is fetched once per request over the union bounding box. Three Overpass queries per
  page load would earn a ban within minutes.
- Narration is skipped entirely without a key, runs concurrently across routes, and is guarded
  twice over. It is the least important field in the response and must never hold a request open.
- `BLE001` was added to the ruff rule set, so every blind `except Exception` in the codebase is now
  either annotated with why it must be blind or is a lint failure. There are seven, all deliberate:
  two degradation guards and five in offline scripts that must not abort part-way through a run.

**Deviations:** none.

---

## Phase J — Polish · 2026-08-04

**Done**

- **SSE streaming.** Route production is now a single async generator, `route_events()`, that both
  transports consume. Routes are emitted the moment they exist; narration arrives as a second pass
  over the same ids, which the client merges rather than appends. A cache hit still speaks SSE so
  the client has one code path, and a failure part-way through becomes an `error` event because the
  status line has already gone out.
- **Barrier reporting** to `api06.dev.openstreetmap.org`, with the host asserted at call time in
  `osm_report.py` rather than only configured. Rate-limited like everything else.
- **Accessibility audit harness** — `frontend/a11y.html` plus `src/a11y.jsx`, which mounts the real
  app, drives it until three route cards exist, and runs axe-core. Auditing an empty page would
  prove nothing.
- **README limitations section** — the honest one, covering what OSM tagging does not know, what
  each `scoring_method` actually means, why the CLIP prompt choice is not yet trustworthy, and that
  the demo runs on hand-built routing data.

**Verified**

- **axe-core, WCAG 2.0/2.1 A and AA, on the fully rendered app with three routes: 46 rules passed,
  0 violations, 0 incomplete.** Best-practice rules were run separately and also come back clean
  after two fixes below.
- The harness never ships: `npm run build` produces 46 modules and no axe or a11y chunk, because
  Vite's production build takes `index.html` as its only entry.
- Streaming verified in a real browser against the real backend, not just in tests: response is
  `text/event-stream`, progress events arrive in ascending order, all three routes stream, and a
  request with no fixture produces `progress → progress → error` over the wire.
- The full flow now works through the app's own search: type "Hyde Park, London" → arrow → enter →
  three routes with 11, 9 and 17 real OSM rest stops and 12 map markers.

**Live API calls used:** Open-Meteo 42 of 100, Overpass 19 of 50, Nominatim 5 of 40.

**Three real defects found and fixed**

1. **axe flagged two landmark failures** — no `<main>`, and content outside any landmark. Added a
   `<main>` and gave the controls form an accessible name. Both are best-practice rather than AA,
   but "content not in a landmark" is a real navigation problem for a screen-reader user.
2. **Searching for a demo location did not work.** `TEST_LOCATIONS` held hand-picked coordinates
   30–800 m away from what Nominatim actually returns for those names, so the app's own search
   produced a request no fixture matched and the demo answered "no fixture for that request".
   `TEST_LOCATIONS` is now defined *as* the geocoder's output for each name.
3. **Even then it missed by seven decimal places.** Nominatim returns `51.5074889`; the config held
   `51.507489`. `geocode_search` now rounds to six decimal places (~0.1 m, far finer than routing
   needs), so two people searching the same place produce byte-identical requests and the
   whole-route cache can actually hit. Pinned by
   `test_searching_for_a_demo_location_lands_on_its_fixture`.

**Decisions**

- `axe-core` added as a **dev** dependency (not in the stack list; reason recorded here). It is the
  standard automated WCAG checker, and "no violations in an automated pass" is a much weaker claim
  from a hand-rolled script. It is never bundled.
- Test coordinates are now derived from `TEST_LOCATIONS` in the test files too. A copied coordinate
  drifts the moment the config changes, and the failure looks like a missing fixture rather than a
  stale test.
- The SSE error event exists because there is no other way to report a failure once the status line
  has been sent. The client turns it back into its normal error banner.

**Deviations:** none.

---

## Phase K — Hostile self-audit · 2026-08-04

Re-read as somebody trying to find a reason not to trust this. Findings first, then what was
checked and came back clean.

### Findings, all fixed

**1 · Coordinates could reach the logs from the request path.** `_shape_upstream_error` logged
GraphHopper's raw error text, and that text routinely embeds the caller's coordinates — *"Cannot
find point 0: 51.5074889,-0.1622074"*. The project's own rule is that coordinates are never logged.
Now classified into a coordinate-free label (`point_not_snappable`, `no_connection`, …) and the
message itself is discarded. This was the most serious finding: it was in the request path, it
would have shipped, and nothing in the test suite was looking for it.

**2 · A segment key is a coordinate.** `cache.py` logged `segment_key` on a corrupt row, which is a
rounded lat/lon pair. Corrupt rows are counted now, not named. `BANNED_FIELDS` in the logging
filter also gained `segment_key`, `bbox`, `origin`, `destination`, `points` and `upstream_message`,
so the backstop catches those shapes by name as well.

**3 · `batch_score` logged a raw exception message.** Offline only, and the message happened not to
contain coordinates, but "happened not to" is not a guarantee. It logs the exception type now.

**4 · An unverified accessible route read like a step-free claim.** A route with no recorded
barriers was returned `status: "ok"` with `confidence: 0.0`. Both facts were true and the
confidence sentence said "do not rely on it", but a reader could still take the green card at face
value. The accessible objective now carries an explicit `status_note` when coverage is below 30%:
*"No barriers were found, but almost nothing along this route has been recorded in OpenStreetMap.
That is an absence of data, not a step-free route."* Three tests pin it.

**5 · The deployment would have thrown away its own pre-warmed scores.** `render.yaml` set
`MEANDER_CACHE_DB=/tmp/meander-cache.db`. That path is outside the repository, so the committed
`data/cache.db` — the entire reason the 512 MB instance can serve real CLIP scores without torch —
would never have been read. Every route would have quietly dropped to `geometry_only` and nothing
would have looked broken. The override is removed, with a comment explaining why it must stay
removed, and DEPLOY.md now warns against re-adding it.

**6 · Three dead functions.** `enrich.fetch_rest_stops`, `models.Point.from_latlon` and
`config.Settings.key_for` had no callers left after later refactors. Removed.

**7 · Stale documentation.** DEPLOY.md's verification `curl` used pre-realignment coordinates, and
told the reader to `git add -f` a file that is not gitignored.

### Checked and clean

| check | result |
|---|---|
| `.env` ever added to git | never — `.env.example` is the only `.env*` in history |
| key-shaped strings in tracked files | none |
| literal assignment to a key variable | none |
| unredacted auth material in any fixture | none — every secret param/header is `<redacted>` |
| `torch` / `open-clip-torch` in `requirements-deploy.txt` | absent |
| module-level torch import anywhere in `backend/` | none; all four are inside functions |
| deploy venv imports `backend.main` and `backend.scoring` | yes, with torch absent |
| `TODO` / `FIXME` / commented-out code | none |
| truthiness test on a `Verdict` | none — every comparison uses `is` |
| `road_class` alone granting a PASS | impossible by construction |
| synthetic route labelled anything but `placeholder` | impossible; pinned by two tests |
| production OSM API referenced | only in tests asserting those hosts are refused |
| browser storage APIs in the frontend | none |
| third-party network hosts in the frontend | one: `tiles.openfreemap.org` |
| privacy filter actually redacts a coordinate field | verified by executing it |
| every command in the docs resolves | all 8 |
| every file the docs reference exists | all, once `data/cache.db`'s absence was documented |
| orphaned functions | none remaining |

### Clean-clone test

`git clone` into an empty directory, then the README's own steps, nothing else:

- `.env` absent, `.env.example` present
- `pip install -r backend/requirements-deploy.txt` succeeds
- `uvicorn backend.main:app` boots; `/api/health` returns `status: ok`, `clip_available: false`
- `POST /api/routes` returns three routes with 11, 9 and 17 real OSM rest stops and a
  best-departure time
- `pytest backend/tests` — 367 passed, 2 skipped
- `npm install && npm run build` succeeds
- the full `requirements.txt` pins all resolve

### Final state

- **367 tests pass, 2 skipped** (the CLIP inference tests, which run under the full environment).
- Green in both environments: the deploy venv with torch absent, and the full venv with it present.
- `ruff` clean across `backend/` and `scripts/`, with `BLE001` enabled so every blind
  `except Exception` is annotated with why it must be blind.
- Frontend builds; axe-core reports 0 WCAG 2.1 AA violations across 46 rules.

### What a reviewer should still be sceptical about

- **Routing data is synthetic.** No GraphHopper key was available, so the routes are hand-built.
  Everything downstream is exercised, and every route says `synthetic_upstream: true`, but no real
  route has been produced by this code.
- **The CLIP prompt choice rests on generated images.** The spec's own prompt pair inverted on
  them. That is worth acting on but not worth trusting; it needs real imagery.
- **`data/cache.db` ships with no CLIP rows**, so `scoring_method` is `geometry_only` in practice
  everywhere.
- **The naturalness and air-blend weightings are judgements**, not measurements. They are written
  down in this log and in the README rather than buried.

All four are in BLOCKED.md or the README limitations section, with the commands to resolve them.

---

## Consolidation and publication · 2026-08-04

**Done**

- `.claude/` added to `.gitignore` and `.claude/launch.json` removed from tracking. That folder is
  agent scratch, and `.claude/worktrees/` holds checkouts of this very repository — committing it
  would have nested the repo inside itself. Nothing the project needs lived there; the dev-server
  commands it configured are already in the README.
- `main` fast-forwarded to the work branch, so all sixteen commits and the eleven phase tags are
  preserved rather than squashed. The build history *is* part of the deliverable: each phase tag
  marks a state where the tests passed.
- Pushed to `github.com/poojanar-debug/Meander` — `main` plus `phase-a` … `phase-k`.

**Verified before pushing**

The repository is **public**, so the pre-push check was run against exactly what would become
visible, not against the working tree:

- no key-shaped strings in any tracked file (`sk-ant-`, `sk-…`, `MLY|`, `AIza…`, `ghp_`, JWTs)
- no `.env` added in any commit on any branch, ever — `.env.example` is the only `.env*` in history
- every secret parameter and header in all 49 fixtures reads `<redacted>`
- 367 tests pass, 2 skipped, run from the main folder rather than the worktree
- `git status` clean in the main folder, confirming `.claude/worktrees/` is ignored

**Final shape:** 121 tracked files — 35 Python modules and 9,124 lines, 16 frontend source files,
49 fixtures (18 synthetic GraphHopper, 31 recorded live from Nominatim, Open-Meteo and Overpass).

**Deviations:** none. Nothing was deployed; `DEPLOY.md` remains a manual step.

---

## Self-hosted GraphHopper · 2026-08-04

The hosted free tier cannot execute a `custom_model`, so `nature` and
`accessible` came back blocked. Self-hosting removes that restriction — and
turned out to add a capability the hosted API never had.

**Built**

- JDK 21 + GraphHopper 11.0, `graphhopper/config.yml`, `scripts/graphhopper.sh`
  (`setup` / `serve` / `status` / `regions`).
- Sri Lanka + Netherlands + Great Britain, merged with osmium into one 3.5 GB
  extract → **18,556,187 nodes, 23,167,345 edges, 6.6 GB graph, 31 min import.**
  One graph rather than three servers, so there is one endpoint and the app
  needs no routing-by-region logic.
- `MEANDER_GRAPHHOPPER_URL` points the app at it; `/api/health` reports which
  server is live and whether custom models can run there.

**Verified — `scripts/verify_selfhosted.py`, all four locations across all three regions**

| Hyde Park, 35 min | duration | distance | barriers |
|---|---|---|---|
| fastest | 31 min | 2.5 km | 3 |
| nature | 32 min | 2.5 km | 3 |
| accessible | 37 min | 3.1 km | **1** |

Three distinct geometries everywhere, `smoothness` present everywhere. The
accessible route is longer *and* has fewer barriers — the custom model is
steering around them, which is the whole point.

**Six defects, every one found by running it rather than reasoning about it**

1. `ch.disable` was sent on *every* request including `fastest`, which needs no
   custom model — and it is a paid feature. "Free packages cannot use flexible
   mode" took down the baseline and with it the whole request.
2. `round_trip` needs `ch.disable` on a self-hosted server with CH prepared
   ("algorithm=round_trip cannot be used with CH") but must **not** have it on
   the hosted API, where flexible mode is paid. Now conditional on the server.
3. The accessible model referenced `surface == EARTH`, which fails the whole
   request. `EARTH` is a valid *OSM tag* but not a router enum value.
   `accessibility.py` keeps the wider OSM vocabulary deliberately — it evaluates
   tags rather than compiling them. The valid enum sets are now recorded in
   `routing.py`, probed from a live server.
4. `import.osm.ignored_highways` — GraphHopper's own example excludes `footway`,
   `cycleway`, `path` and **`steps`**. Correct for a car-only server;
   catastrophic here. **If steps are never imported the graph cannot contain
   them, the hard accessibility check can never fire, and the app would
   confidently report a staircase as step-free.**
5. An 8 GB server heap against a 6.6 GB graph dies with `OutOfMemoryError`
   *after* a 31-minute import has already succeeded — a confusing place to fail.
6. The test suite was not hermetic: `MEANDER_GRAPHHOPPER_URL` decides which path
   details are requested, and therefore the signature every committed fixture is
   keyed on. A developer with it exported watched the whole suite fail on fixture
   misses. conftest now forces it.

**What self-hosting bought beyond the two presets**

`smoothness` is now an encoded value, so the accessible model can *avoid* bad
surfaces rather than only report them afterwards. It is one of the five hard
constraints and the hosted API never exposed it — until now that constraint
could not fire from routing data at all.

**The nature cap — fixed, and it was not what it looked like**

Colombo's nature loop returned 117 min against a 30-min budget: 2.8× fastest,
well past the 1.6× cap. The obvious reading is "the ladder does not climb high
enough". Measuring said otherwise:

| distance_influence | 20 | 45 | 90 | 150 | 250 | 400 | 700 | 1200 |
|---|---|---|---|---|---|---|---|---|
| duration | 117.7 | 117.7 | 117.7 | 115.9 | 114.7 | 108.4 | 69.8 | 69.8 |

Sixty-fold on the lever moves the answer by 40%, and it plateaus above the cap.
Scaling `round_trip.distance` instead is worse — not weak but *discontinuous*:
1.0 and 0.7 both give 117.7 min, 0.5 gives 18.0. GraphHopper's round-trip
algorithm picks a candidate loop, and a small nudge to either input flips it to
an entirely different one. **No monotonic search over either parameter is
meaningful**, which is why a ladder could never have worked.

So `route_nature` now generates a small candidate set and picks between them,
which is what the spec asks for in as many words. A candidate must clear two
bars: inside the duration cap, and **greener than the fastest route**. The
second is not optional — picking on budget-fit alone produced a "nature" route
at Euston Road that was *less* green than the plain one, which makes the label a
lie. Among those that clear both, greenness is balanced 60/40 against how well
the route uses the time asked for; on greenness alone a 30-minute request came
back as an 18-minute loop.

Judging costs nothing extra: `geometry.py` is local, so candidates are compared
without more requests. The search runs fully against a self-hosted server and
stops at the first acceptable candidate against the metered hosted one.

| location | asked | fastest | nature | cap | greenness |
|---|---|---|---|---|---|
| Colombo Fort | 30 min | 42.1 | **18.0** (was 117.7) | 67.3 | 0.54 → 0.57 |
| Hyde Park | 35 min | 30.5 | 32.3 | 48.8 | greener |
| Vondelpark | 35 min | 33.8 | 34.0 | 54.1 | greener |
| Viharamahadevi | 45 min | 45.8 | 38.0 | 73.2 | 0.52 → 0.56 |
| Euston Road | 60 min | 47.4 | 37.4 | 75.8 | greener |

5/5 within the cap and greener than fastest. When a promise still cannot be
kept, `preset_note` says which one — Colombo's card now reads *"the greenest
route available near you, but noticeably shorter than the time you asked for"*
rather than silently handing over an 18-minute walk.

**Live API calls:** GraphHopper hosted 0 (self-hosted is unmetered), Nominatim 3.

---

## Two programmes, from the same commit

Everything above is shared history. From `867e8e2` the project ran in two
directions at once, and both logs are kept below in full rather than one being
folded into the other — they describe different work, they were measured
independently, and a reader trying to understand why a file looks the way it
does needs whichever one touched it.

**The redesign programme** comes first: eight phases rebuilding the frontend
against `docs/DESIGN-HANDOFF.md`. **The launch programme** follows: the
deployment, the hardening and the infrastructure. They were reconciled onto one
branch on 2026-08-06; the entry at the very end of this file records what that
merge kept, what it dropped, and why.

---

# The redesign programme

## Redesign phase 2 — Layout shell · 2026-08-06

**Done**

- The §3 two-column grid: 56px sticky topbar, full-width ribbon, then
  `panel minmax(360px,420px)` + `stage minmax(0,1fr)`. The panel scrolls; the
  map does not.
- `Header.jsx` → `Topbar.jsx`. The header paragraph became a one-line tagline.
- The entire footer became the §4.9 `<details>` at the foot of the panel, with
  every sentence it used to carry, in the handoff's order.
- `Ribbon.jsx` — the §4.2 demo-data warning.

**Verified**

- 0px horizontal overflow at 320, 390 and 1280.
- The map fills the stage exactly — an 860×627 map in an 860×627 column.
- Topbar measures 56px; panel `overflow-y` computes to `auto`.

**Decisions**

- **`minmax(0, 1fr)` and not `1fr`,** as the handoff insists. A plain `1fr`
  resolves its minimum to min-content, the map's SVG reports a min-content width
  wider than its column, and the grid ends up ~12px past the viewport with a
  horizontal scrollbar. This is not theoretical — the same trap caught the trip
  bar in phase 3, where a long place name refused to shrink and the ellipsis
  never applied.
- **No profile button in the topbar**, though §4.1 specifies one. The sheet it
  opens is §6.5, which is deferred. A control that opens nothing reads as broken
  rather than as unbuilt. The place for it is recorded in a comment.
- Collapsing the footer is not deleting it. The OpenStreetMap tagging caveat
  leads the disclosure because it is the sentence a reader most needs and least
  expects, and it is the reason the project exists.

**Deviations:** none.

---

## Redesign phase 3 — Trip bar · 2026-08-06

**Done**

- `Controls.jsx` → `TripBar.jsx` + `TripDrawer.jsx` + `ObjectiveChips.jsx`
  (§4.3–4.5). Four segments, each showing its current value, each opening one
  inline drawer; opening one closes the others.
- `TimeDial.jsx` gained the §4.4 readout and the four preset pills. The native
  `<input type="range">` and its `aria-valuetext` are unchanged.
- `FirstRun.jsx` — the §7 empty state.
- The a11y harness now matches `.route, .card` so it survives phase 4's rename.

**Verified**

- **The fetch model is byte-for-byte unchanged.** Diffed `App.jsx` against the
  pre-redesign commit filtering for `DEBOUNCE`, `nonce`, `withRefetch`, `abort`
  and every refetching action: the only hits are two added comments.
- One drawer open at a time, `aria-expanded` and `hidden` agreeing, checked in
  the browser rather than by inspection.
- axe-core WCAG 2.0/2.1 A+AA: **0 violations, 0 best-practice violations.**

**Decisions**

- **Drawers render inline, not as an overlay.** An overlay would float over the
  map, and below 900px — where the map sits *above* the panel — it would cover
  the answer the user is adjusting.
- **`hidden` rather than unmounting.** A half-typed place name survives closing
  the drawer, and `aria-controls` always points at an element that exists.
- **Presets dispatch the same `minutes` action the slider does.** No second code
  path, so no second debounce to keep in step.
- The first-run gate keys on `origin`, not on `routes`. MapLibre is therefore
  not constructed until there is somewhere to draw, and once constructed it is
  never unmounted — which is the one-instance rule the StrictMode fix depends on.

**Deviations**

- §7 is built here rather than in phase 2. It shares the preset pills with
  §4.4, and building it alongside them avoided writing the component twice.

**Found while working**

Two best-practice regressions, both from the topbar rewrite and both caught by
running axe rather than by reading the diff: the wordmark had become a `<span>`,
leaving the page with no `<h1>`, and the ribbon sat outside every landmark.
Fixed in the same phase.

16 `color-contrast` checks report *incomplete* — axe cannot measure them. All
are inside the old `.card` and all are on pairings §2 pre-verifies. Phase 4
deletes that component; re-checked there rather than carried forward.

**Live API calls:** none.

---

## Redesign phase 4 — Rail and detail · 2026-08-06

The core change. `RouteList` + `RouteCard` → `RouteRail` + `RouteRow` +
`RouteDetail`, plus `VerificationMeter` and `verificationTier()` (§4.6–4.8).

**Done**

- Uniform-height comparison rows for every route; full detail for the selected
  route only.
- The four-segment verification meter, with the server's confidence sentence
  still rendering verbatim in the detail panel underneath it.
- `verificationTier()`, `restStopSummary()`, `durationParts()`, `waysBack()` in
  `lib/format.js`.

**Verified**

- Every row is a single `<button>` with **zero** `p`/`ul`/`ol`/`dl`/`div`
  descendants, checked in the browser rather than by reading the JSX.
- All three rows exactly **159px**; all nine score tracks at the same **117px**
  offset within their row.
- A `null` score and a `0` score render differently.
- axe-core: 0 violations, 0 best-practice, 41 rules passed.

**Decisions**

- **The accessible name is the visible content, not an `aria-label`.** An
  aria-label would have produced the tidy four-fact name §9 describes and
  silently discarded the three score percentages — the numbers the rail exists
  to let people compare. The visible text is instead written so that reading it
  in order makes sense, with visually-hidden connectives where the terse visual
  form would not.
- **Uniform height needed a fix worth writing down.** "not measured" is ~78px at
  `--t-micro`; a score column is 114px at the panel's widest and ~98px at its
  narrowest, so it cannot share a line with its label. It wraps, and a wrapped
  head made that row taller than the others — destroying the alignment the
  component exists for. Shrinking the type was tried and fails at 360px. The fix
  reserves the second line across the **whole rail** rather than on the row that
  needs it (`.rail:has(.score__none) .score__head { min-height: 3em }`), so
  every row grows together. With nothing unmeasured, nothing matches and the
  head stays the single tight row §4.6 specifies.
- **No `Share` or `Save` action**, though §4.8 lists them. `Save` is §6.8, which
  is deferred. `Share` has no specification anywhere, and the app holds no state
  in the URL, so a share link would point at the app's front door and say
  nothing about the route. Same reasoning as the topbar profile button: a
  control that does nothing reads as broken.

**Found while working**

The mock had no `null` score anywhere, so the branch that distinguishes "not
measured" from "zero" had never once been rendered. The Accessible fixture now
carries `shade: null`. Separately, the a11y harness was matching `.route`, which
the loading skeletons also carry — three placeholders satisfied it and the audit
ran against a half-streamed result. It now matches `button.route`.

---

## Redesign phase 5 — Map · 2026-08-06

**Done**

- Basemap recoloured to the §2.4 palette in place, per theme.
- `--raised` casing at line-width + 6 under the selected line; unselected routes
  at 5px / 0.45 opacity.
- Rest stops as a circle layer on the selected route; barriers as ✕ markers.
- Bottom-left legend, hidden below 900px.
- 44px controls, last in the tab order.

**Verified**

- Light: background `#e9e5d8`, water `#c6dae4`, park `#cfe0c9`.
  Dark: `#16221b`, `#152a33`, `#1d3527`. Route lines and casings switch with them.
- axe-core: **0 violations, 0 best-practice** at light desktop, dark desktop and
  390px. 0px horizontal overflow at 390px.

**Two bugs found by running it, not by reading it**

1. **The map drew streets and nothing else.** Route layers were gated on
   MapLibre's `load` event, and with the current upstream positron style that
   event never fires — `areTilesLoaded()` is true and tiles paint, but
   `isStyleLoaded()` stays false forever. Every route layer was waiting on
   something that was never coming. `load` and `idle` are both wired now, plus a
   250 ms poll on `getStyle().layers.length`, which is the real precondition for
   `addSource`. Readiness is idempotent so whichever arrives first wins.
2. **The map repainted in the palette it was leaving.** React runs every child's
   passive effect before the parent's, so MapView read `--map-land` and friends
   out of `getComputedStyle` *before* App had written the new `data-theme`.
   Applying the theme in a `useLayoutEffect` fixes the ordering, because all
   layout effects run before any passive effect.

**Deviations**

- **`role="img"` is not on the map container**, though §4.10 asks for it. It
  declares an element a single graphic whose contents are not exposed, so
  nesting the zoom buttons inside it is `nested-interactive` — a serious WCAG
  4.1.2 failure, which axe caught. It cannot move to the canvas wrapper either,
  because MapLibre injects its own attribution button there. The summary reaches
  assistive technology through a labelled region plus a visually-hidden
  description carrying the same sentence.

**Live API calls:** none — OpenFreeMap basemap tiles only, which the app already
loaded before this work.

---

## Redesign phase 6 — When to go · 2026-08-06

Best departure and the daylight window, built together because they share the
strip (§6.2, §6.3).

**Done**

- `DepartureStrip.jsx` — the headline, the daylight line, and six hour chips.
  `payload.best_departure` has been in the API response since the backend was
  written and the UI ignored it.
- `lib/sun.js` — NOAA short-form solar position, computed in the browser. No
  network call: asking a service what time it gets dark would mean sending it
  the user's coordinates.
- `DaylightGuard.jsx` — at most one warning and at most one action.
- `vitest` added as a devDependency; 23 tests for the solar maths.

**Two bugs the tests found**

1. **A route crossing midnight produced no warning at all.** The first version
   asked `end > sunset-of-the-day-the-end-falls-on`; for a walk from 23:30 to
   00:30 that end lands on a day whose sunset is eighteen hours in its *future*,
   so a walk entirely in darkness passed silently. Replaced with "how light is
   it at this moment", which handles midnight without special-casing it.
2. **The longitude correction had both signs inverted** — worth 5.3 hours at
   Colombo, and *every one of the twenty-two tests still passed*. A longitude
   error moves sunrise and sunset by the same amount, so day length stays
   correct and only absolute times are wrong; the equator test compared lengths,
   and London is at 0.13 E where the error is fifteen seconds. It took a real
   route reporting "Daylight today: 16:44 – 05:08" to show it. There is now a
   test at a far longitude, asserting a *property* — the midpoint of sunrise and
   sunset is solar noon — rather than an almanac figure taken on trust.

**Decisions**

- **The daylight layer goes quiet when the viewer's timezone and the route's
  longitude disagree.** Sun times are absolute instants and correct anywhere,
  but `Intl` formats in the viewer's timezone, so a Colombo route read from
  California shows Californian clock times for a Sri Lankan sunset. A place's
  civil timezone cannot be derived from coordinates without a tz database;
  solar offset can, and three hours of slack admits the genuinely wide zones
  while excluding the other side of the world. Sentence and moon glyphs go
  together — half a signal is worse than none.
- The shorten action disappears once sunset has passed. Offering to finish
  before a sunset that has been and gone is nonsense.

---

## Redesign phase 7 — Turn-by-turn steps · 2026-08-06

**Done**

- `routing.py` requests instructions and parses them; `models.py` gained a
  `Step` model and a `steps` field; `main.py` passes them through.
- `StepList.jsx` — a `<details>` in the detail panel, instructions written as
  sentences, barriers rendered **inside the step** they fall on, and a map
  `highlight` layer on hover or focus.

**Deviations**

- **`models.py` was touched, which the scope said not to.** There was no way
  around it: `Route` is a Pydantic model, so a field that does not exist there
  cannot reach the response however `routing.py` parses it. One `Step` model and
  one field. `accessibility.py` is untouched and nothing here goes near the
  §6.5 request-model work `models.py` was being kept clear for.
- **No `Share` or `Save` action in the detail panel**, though §4.8 lists them.
  Save is §6.8, deferred. Share has no specification and the app holds no state
  in the URL, so a share link would point at the front door.

**The fixture problem, which is the part worth reading**

Turning on `instructions` changed the request body, and fixtures are keyed on a
hash of that body — so **68 fixtures became unreachable in one commit** and the
offline suite started missing every one. This is the same coupling recorded
above as self-hosting defect 6. Resolved by starting the self-hosted server and
re-recording (16 real recordings with real instruction arrays), teaching
`make_synthetic_fixtures.py` to emit instructions, and deleting the orphans.

Two more bugs found by the new tests: a non-numeric `distance` threw and took
the whole route with it, and the end-to-end assertion revealed that the
COLOMBO→VIHARA scenario runs on a synthetic fixture that had no instructions at
all — so the feature would have shipped with no offline test data despite a
correct parser.

---

## Redesign phase 8 — Live follow mode · 2026-08-06

**Done**

- `lib/follow.js` — projection onto the line, progress, next turn, next rest
  stop, barrier proximity, sustained off-route. 22 tests.
- `FollowMode.jsx` — bottom sheet, barrier alert, off-route banner, wake lock,
  one-tap exit.

**Verified**

- **The privacy claim was measured, not asserted.** Ten positions were fed
  through follow mode with `fetch`, `XMLHttpRequest` and `sendBeacon` all
  instrumented: **zero outbound requests of any kind**, and nothing carrying a
  coordinate.
- Barrier alert fires at 145 m on a walkable route with a recorded kerb,
  `role="alert"`, naming type and description.
- Off-route does **not** fire on a single distant reading, and does fire after a
  continuous run past 15 s.
- Exit is first in the DOM, first in the tab order, and takes focus on entry.
- `Start this route` is disabled on a blocked route with the reason on
  `aria-describedby`, and absent entirely when the router gave no instructions.

**Decisions**

- **Positions project onto the segment, not onto the nearest vertex.** On a long
  straight stretch the nearest vertex can be 200 m away while the walker stands
  exactly on the line; snapping would declare them lost. There is a test for it.
- **Off-route needs a continuous run.** City GPS bounces off buildings by tens
  of metres, and a 40 m threshold tested against one sample fires constantly on
  a good walk and trains people to ignore it.
- `barriersWithin` takes no notice of a route's status. Someone who read the
  warning and chose to walk it anyway is the person who most needs telling when
  the steps are 200 m ahead.

**Two mock corrections found while testing**

Route distances are now measured from the drawn geometry — they had been
declared separately, so the rail said 1.4 km while follow mode said 2.6 km for
the same walk. And the Nature route carries a recorded kerb, because without it
nothing in the demo exercised the proximity alert: the only route with barriers
was the one that cannot be started.

---

## Redesign — definition of done · 2026-08-06

| Check | Result |
|---|---|
| Every §2 token declared once; no hard-coded hex outside the `:root` blocks | pass — `awk` check returns nothing |
| Light and dark both ship; theme persists; defaults to `prefers-color-scheme` | pass |
| axe-core 0 violations at light desktop, dark desktop, 390px | pass — 0 violations **and** 0 best-practice at all three, 42 rules passed |
| Full keyboard pass in the §9 order with a visible focus ring | pass — skip link → topbar → trip bar → departure → rail → detail → about → map → **map controls last**; 3px ring |
| No horizontal overflow at 320 / 390 / 768 / 1024 / 1440 / 1920 | pass — 0px at every width |
| Fully usable with the map element removed from the DOM | pass — all three rows readable, selection, detail, scores, confidence sentence, rest stops and steps all work with `.map` deleted |
| Greyscale: all three routes distinguishable | pass — solid / dashed / dotted, each named in words |
| A `null` score and a `0` score render differently | pass — hatched track + "not measured" versus a real empty bar |
| Backend tests | **394 passed, 0 failed** under CI conditions — verified in a clean torch-free virtualenv with no keys. On a machine with a `MAPILLARY_TOKEN` in `.env` one test fails; see BLOCKED.md #3 |
| New tests cover instruction pass-through and the solar maths incl. polar day/night | pass — 5 backend, 45 frontend |
| `prefers-reduced-motion` removes the animations | pass — the global rule collapses every transition to 0.001 ms |
| No new runtime third-party requests | pass — vitest is a devDependency; the only runtime hosts are the ones the app already used |
| Nothing new sent to the server; the live position never leaves the browser, and the UI says so | pass — measured at zero requests |
| Sunrise/sunset renders nothing rather than guessing when it cannot be computed | pass |

**Not built, as instructed:** §6.1 streaming choreography, §6.5 accessibility
profile, §6.6 barrier detail popover, §6.8 saved places.

**Live API calls this phase:** GraphHopper 16, all against the self-hosted
server and therefore unmetered.

---

# The launch programme

Branched from the same `867e8e2` as the redesign above, and unaware of it. Where
the two overlap — both added turn-by-turn directions, both added a dark mode,
both wrote a `RouteRow` — the reconciliation kept the redesign's frontend and
this programme's backend. The measurements below stand; the frontend ones
describe a layout that is no longer in the tree, and are marked where that
matters.

## Launch phase 0 · Baseline, and one number that was wrong

Branched `feat/launch` off `main` at 867e8e2.

**Where the tree actually is.** 387 tests pass offline, 2 skipped — not the 367
the audit was written against. The frontend builds clean:

| chunk | raw | gzip |
|---|---|---|
| `maplibre` | 1,055.24 kB | 283.74 kB |
| `index` js | 222.77 kB | 70.61 kB |
| `index` css | 80.30 kB | 12.79 kB |
| `index.html` | 1.16 kB | 0.63 kB |

**Three real routes, end to end.** Backend in `live` mode against the
self-hosted GraphHopper 11, 45-minute foot round trip near Hyde Park, nothing
cached: **14.0 s**, **8 GraphHopper requests** — 6 nature candidates, 1 fastest,
1 accessible, exactly the arithmetic the audit predicted. `fastest` 35.9 min /
64% checked, `nature` 22.4 min / 88% checked and genuinely greener (0.666 vs
0.646), `accessible` blocked. `segments_scored` 0, so all three are
`geometry_only`; self-hosting did nothing for BLOCKED.md §2 and it was worth
re-confirming rather than assuming.

**Then the 14 s turned out to be the wrong story.** Timing each SSE frame on
arrival, the routing loop finishes in **0.02 s** and then nothing happens for
**3.9 s**. Measured directly:

| upstream | latency |
|---|---|
| GraphHopper, one foot route, localhost | **0.024 s** |
| Open-Meteo forecast | 0.578 s |
| Open-Meteo air quality | 0.836 s |
| Overpass, one trivial bench query | **13.553 s** |

Three consecutive uncached Hyde Park requests took 4.18 s, 1.19 s and 9.36 s.
That spread is Overpass, not us.

So the audit's "the objective loop is sequential and the worst case is well over
two minutes" is right about the code and wrong about where the time goes **once
the router is your own**. Eight local routing requests cost about 0.2 s
together. The sequential enrichment — Overpass, then forecast, then air quality
— is the entire budget, and its worst leg is 13.6 s.

Which surfaces a defect nobody had written down: `HTTP_TIMEOUT_S` is **12.0 s**
and Overpass just took 13.6 s. Rest stops are already silently timing out into
`null` some fraction of the time. `null` is honest — it means "we could not
look", distinct from `[]` — so this degrades correctly rather than lying, but it
means the rest-stop feature is quietly absent at random. Phase 1.5 gathers the
three enrichment calls, which turns worst-case ≈ sum into worst-case ≈ Overpass,
and makes the timeout configurable so it can be set above Overpass's actual
tail.

**What surprised me.** That the first measurement was misleading in the
flattering direction. 14 s for eight routing requests reads like "routing is
slow, parallelise it". Parallelising the routing would have bought ~0.15 s and
left a 13 s p99 completely untouched.

**A privacy trap, reproduced deliberately.** `data/cache.db` is tracked. One
uncached request left it byte-identical on disk with the route parked in
`cache.db-wal`, which is gitignored — `git status` said clean. A checkpoint then
took the tracked file from 4 KB to 45 KB carrying a full coordinate array. It is
now guarded: `scripts/scrub_cache_db.py --check` inspects the **staged blob**,
not the working tree, because a developer can stage the dirty file and then
clean the working copy. Hooks live in `scripts/git-hooks/`.

**Live API calls:** GraphHopper self-hosted ~40 (unmetered), Overpass 5,
Open-Meteo 10, Nominatim 0.

---

## Launch phases 1–3 · What the audit got right, and two things it did not

### Phase 1 — the launch blockers

Seven fixes, each with its own commit and tests. The three that mattered most:

**The self-hosted flag.** `graphhopper_is_self_hosted()` sniffed the hostname,
which is right on a laptop and wrong the moment the router has a real name.
Four behaviours hang off it and none fails loudly; the dangerous one is that
`path_details()` drops `smoothness`, so the accessible model silently stops
excluding IMPASSABLE surfaces. Now `MEANDER_GRAPHHOPPER_SELF_HOSTED`, with the
sniff only as the default. conftest pins it in the same commit — the fixture
signature depends on it, and getting that wrong fails the whole suite on
`no_fixture`. Verified by running the suite with a hostile environment
exported: 411 passed, byte-identical.

**Nature with no baseline.** `{"objectives": ["nature"]}` is a valid public
request, and it made `route_nature` receive `fastest=None`, which switches off
*both* its bars — the 1.6× cap and the greenness floor. Every candidate becomes
acceptable and the winner ships labelled Nature with no note. Fixed by routing
a baseline whenever nature is asked for.

**Time to first route: 3.96 s → 0.03 s.** The audit read this as "the objective
loop is sequential, parallelise it". Measuring says routing was never the cost:
a self-hosted router answers a whole foot route in 24 ms, so all eight requests
together are ~0.2 s. The cost is the *shared* enrichment pass, and it sat
between routing and the first route event. Each route is now emitted twice —
immediately, then again enriched — using the merge-by-id the client already
had for narration. `enrichment_pending` says so, because `rest_stops` cannot be
null and `[]` would mean "we looked and found none".

### Phase 2 — production hardening

The rate limiter was defeated by one header: `X-Forwarded-For.split(",")[0]` is
the value the *client* sent. Now read from the right, `parts[-hops]`, defaulting
to zero trusted hops. 50 requests each inventing a different XFF now map to one
bucket.

`/healthz` and `/readyz` split from `/api/health`, verified by suspending the
router with SIGSTOP: liveness stayed 200 throughout, readiness went 503 and
came back. Readiness deliberately does **not** use `missing_keys()`, which
names MAPILLARY_TOKEN and ANTHROPIC_API_KEY — neither is needed to serve a
route, and wiring readiness to it would 503 a healthy instance for ever.

One finding worth recording because I got it wrong first: **Starlette's
GZipMiddleware does not leave streaming responses alone.** I wrote a comment
claiming it did; the test returned `content-encoding: gzip` on a
text/event-stream response. That would have silently undone the whole of Phase
1.5. ConditionalGZip decides on the request's Accept header.

### Phase 3 — the graph, which is the entire bill

|                      | demo    | countries |
|----------------------|---------|-----------|
| download             | ~370 MB | ~3.5 GB   |
| merged extract       | 346 MB  | 3.5 GB    |
| graph on disk        | 620 MB  | 6.6 GB    |
| import               | 96 s    | ~31 min   |
| minimum serve heap   | **2 GB** (1 GB OOMs) | 20 GB |
| cold start to route  | 1.1 s   | —         |
| first route          | 44 ms   | —         |

**Contraction hierarchies are gone**, and the measurement is why: CH is
incompatible with a custom model, so it only ever served `fastest`. Dropping it
costs 4 ms on that one preset (5.1 → 9.2 ms) and saves 22% of the graph and 40%
of the import. Four milliseconds against a request budget dominated by Overpass
at seconds.

**RAM_STORE vs MMAP for elevation is a no-op**, which is not what I expected.
Boot 1.1 s both ways, flexible route 12.5 vs 12.3 ms, RSS 1051 vs 1073 MB.
Elevation is consumed at import time and baked into the graph; at serve time
the setting does nothing. The audit's suggestion that RAM_STORE is "probably
the wrong call on a memory-billed container" does not hold.

**What surprised me.** Both real bugs in this phase were found by *running* the
script, not by reading it. `/usr/libexec/java_home -v 21` returns a Java 8 home
when no JDK 21 is registered — it ignores the version filter — so discovery
that trusted it turned a working machine into "Java 8 is too old". And
Geofabrik answers **HTTP 200 with an HTML page** for a region path that does
not exist, so `curl -f` succeeds and a 12 KB HTML document lands named
`.osm.pbf`; it died three steps later inside osmium. The checksum guard I had
just written treated "no published checksum" as a warning and stepped past it.
It now treats it as the failure it is.

**What I did not do.** Docker is not installed on this machine. The two
Dockerfiles, the entrypoint and the compose stack are written and reviewed but
have never been built or run. Everything above the container boundary was
exercised for real.

**Live API calls:** GraphHopper self-hosted ~120 (unmetered), Overpass ~12,
Open-Meteo ~25, Geofabrik 4 extracts.

---

## Launch phase 6.5 · The PWA, and three bugs only a real offline load finds

The brief asks for a manifest, icons, a service worker, and the app shell plus
the last result cached. The hard requirement is the one the project turns on:
**an offline-served route must be visibly labelled as cached, with its age.**

### The thing the brief does not settle, and how it was settled

The house rule is that browser storage is opt-in and labelled. The brief says
cache the last result. Those pull in opposite directions, because a *result* is
a polyline through the streets around wherever the user is standing — the most
location-revealing object this app touches.

They are only in tension if the cache is treated as one thing. It is two:

- **the shell** — HTML, JS, CSS, icons. Cached unconditionally. It is the
  program. Identical bytes for every visitor, reveals nothing, and it is the
  entire reason the app opens on a train.
- **the result** — cached **only after an explicit opt-in, off by default**, one
  route at a time and never a history, with the revocation actually deleting
  rather than merely ceasing to add.

**Map tiles are cached under neither.** A tile cache is a record of where you
have been, and they are third-party. The cost is that an offline route has no
map behind it — affordable precisely because Phase D verified the map is not
load-bearing: with `MapView` display:none, the list still carries every
duration, score, blocker and rest stop.

### Where the label lives, and why in four places

`TrustSignal`'s rule is that volume scales with severity but presence never
does. The same shape applies to age, so `lib/offline.js` is the single place
that decides the wording, tiered at 15 minutes and 6 hours — thresholds set by
the *enrichment*, which is what actually rots. A route's shape and its
accessibility findings hold for weeks; air quality, rest stops and the best
departure time are measurements of a moment.

| surface | form | why it has to be there |
|---|---|---|
| pill under the top bar | `saved 14m ago` | the one no panel snap can hide |
| compact row | `saved 14m ago` | at peek the row *is* the whole route |
| card | headline + what has gone stale | the long form, where there is room |
| results block | headline + cause | says *why* there is a saved copy |

**An unknown age is the loudest tier, not the quietest.** A missing timestamp,
an unparseable one, and one in the future because the device clock moved all
produce "Saved copy. Meander cannot tell how old it is." A cache entry that
cannot say how old it is is the one least worth trusting, and rounding that to
"0 minutes ago" would be a specific false claim rather than a missing one.

**"You are offline" and "the server is unreachable" are different sentences.**
The second is commoner and sending that user to restart a router that was never
the problem is a small lie with a real cost.

### Two bugs that were not about caching

**A departure time can expire, and `BetterLater` had no notion of it.**
`best_departure` is an absolute instant computed when the request was made, so a
tab left open past it — or a route replayed hours later — kept advising *"better
if you leave at 19:15"* at ten in the evening. It is withdrawn now, not
recomputed: choosing a new time needs the air-quality and cloud-cover series for
the hours ahead, which is exactly what an expired or cached response no longer
has. The clock ticks (`useNow`) rather than being read once, because the
ordinary way to hit this is a phone left on a table, where nothing re-renders.

**The README claimed "no browser storage."** That stopped being true at 6.7,
when the units preference landed, and nobody updated the sentence. Corrected to
a table of what is kept, when, and what it took to be allowed to keep it.

### Three bugs the browser found, and one the build did

Every one of these produced output that looked fine.

1. **`Vary: Origin` versus Vite's `crossorigin`.** Vite writes `crossorigin` on
   exactly two tags — the module script and the stylesheet — so those requests
   carry an `Origin` header while the worker's precache fetches do not. Cache
   API matching honours `Vary`, so the stored entries were rejected for the
   app's own JavaScript and CSS while the manifest and icons matched perfectly.
   The document came back from cache, the tab title was right, `#root` was in
   the DOM, and the page was blank. `ignoreVary: true` is correct rather than
   merely convenient: every shell URL is one immutable content-hashed
   representation, so there is no second variant to serve by mistake.

2. **Caching the stream deadlocked the request.** `await` on
   `response.clone().text()` before returning meant waiting for an SSE stream to
   *end* before the page saw its first byte — and against the tee's backpressure
   it never resolved at all. `event.waitUntil` instead, which is what the hook
   is for. The symptom was an empty cache, pointing nowhere near streaming.

3. **`fetch(request)` consumes the request body.** The cache key is a SHA of
   that body, and hashing it *after* the fetch throws `Request body is already
   used`. Inside `waitUntil` that rejection goes nowhere: the page got its
   routes, nothing was logged, and the only evidence was a results cache that
   existed and was empty. The key is computed before the fetch now, and the old
   entry is dropped only once the new one is ready to write — deleting first is
   the obvious order and leaves the device with neither on any failure.

4. **A non-global `String.replace` substituted a comment.** The build plugin
   fills `__VERSION__` and `__PRECACHE__` into `sw.js`; the first occurrence of
   each was the sentence in the file's own header explaining what they were. The
   worker shipped with a literal `__PRECACHE__` in it. `replaceAll`, plus an
   assertion that no placeholder survives, plus one that `/index.html` is in the
   list — the plugin also needed `enforce: 'post'`, because Vite emits the
   document after the default hook order and the first precache list was
   everything except the page.

### Verified

- **`scripts/pwa-gate.mjs`, 25/25.** It does not emulate being offline, it
  **stops the server** — `Network.emulateNetworkConditions` applies to the
  page's network stack, and the requests that matter here are the worker's, so
  an emulated run can pass while a real one fails.
- Separate from `gate.mjs` on purpose, which stays at **14/14**. That number is
  quoted elsewhere and adding checks to it would move something people read.
- **The permalink contract turns out to be what makes offline work at all.**
  Geocoding is never cached — a search box's contents are the user's words — so
  an offline reload cannot look a place up. It does not need to: the controls
  are already in the URL, and `check:permalink` guarantees the decoded state
  rebuilds a byte-identical request body, which is exactly the key the worker
  stored the result under. Two features written for unrelated reasons, and one
  is load-bearing for the other.
- `check:offline`, 13 checks in the build, covering the invariant directly:
  there is no age — including one it cannot work out — for which the label is
  absent, empty, or quieter than the situation deserves.
- A two-line row costs 20 px each, so peek grows 60 px rather than dropping a
  route or truncating "Accessible" to make room. Measured, not derived.
- 567 tests, 2 skipped. ruff clean. axe clean in the offline state too.

### What I did not do

- **No `vite-plugin-pwa`.** It is a good plugin, but it brings Workbox to
  generate a worker whose behaviour around POST caching and a permission gate is
  the interesting part of this phase, not boilerplate to delegate.
- **No rasteriser dependency for four flat-colour icons.** `scripts/make-icons.mjs`
  draws them with `node:zlib` and a distance field. The maskable variant is a
  *different drawing* — smaller against a full-bleed plate — rather than the
  standard one relabelled, which is the usual mistake and clips the corners off
  the mark. The first attempt put a dot at the end of the route to read as a
  destination; at icon sizes it touched the stroke and the whole thing read as a
  snake with a head.
- **Not tested on a real phone.** Installability is asserted from the manifest,
  the icons and a registered worker in headless Chrome. Whether the install
  prompt appears, and what the icon looks like on a home screen, is still
  BLOCKED.md-adjacent and is the same open request as Phase 5's.

**Live API calls:** GraphHopper self-hosted ~30 (unmetered), Nominatim 0
(recorded), Overpass ~6, Open-Meteo ~12.

---

## Launch phase 4 · AWS, written and not applied

Four CloudFormation stacks, a deploy workflow on GitHub OIDC, and a gate table
where every row says UNVERIFIED and names the command that would settle it.

**Nothing was applied.** The credentials here are account root and creating
billable resources was out of scope. What *was* done is run
`aws cloudformation validate-template` — a read-only call — and then `cfn-lint`,
against all four. Both pass. That is a much weaker claim than "it works", and
`infra/README.md` opens by saying so: a template that parses proves nothing
about whether a security group rule is right or two services can reach each
other.

CloudFormation rather than Terraform or CDK for exactly that reason. It is the
only one of the three whose templates can be checked against the real AWS API
without installing a provider, standing up state, or creating anything.

**What the account can actually do, checked rather than assumed.** There is no
Route 53 hosted zone, and the `freshhaul.com` certificate in us-east-1 is
`VALIDATION_TIMED_OUT` — requested, never validated, expired after 72 hours
because the DNS records were never published. So the domain and both
certificates are optional parameters and the distribution falls back to its own
`cloudfront.net` name. HANDOFF.md said "an ACM cert exists"; it exists and it is
dead, which is a different thing.

**Three settings that are load-bearing and none fails loudly**

`MEANDER_GRAPHHOPPER_SELF_HOSTED=1`, because the hostname sniff resolves a
Cloud Map name to *not* self-hosted, `path_details()` then drops `smoothness`,
and the accessible model silently stops excluding surfaces recorded as
impassable.

`MEANDER_TRUSTED_PROXY_HOPS=2`, and HANDOFF.md said 1. Both are right for
different topologies: 1 behind an ALB alone, 2 behind CloudFront *and* an ALB,
because CloudFront sets X-Forwarded-For to the viewer and the ALB appends
CloudFront's address. The app sees `viewer, cloudfront` and counts from the
right. At 1 the limiter still works — it just puts every request in the world
in one bucket, which is what makes it hard to notice.

`MEANDER_CACHE_DB` deliberately unset, because setting it points the API away
from the `data/cache.db` baked into the image and every route quietly drops to
`geometry_only`. Phase K found this in `render.yaml`.

**The cost estimate has two lines worth arguing about.** ~$108/month, and the
NAT gateway is $32 of it — more than the API it serves — while the load balancer
is $18, about as much as everything it balances. `infra/README.md` says plainly
that below this size ECS is the wrong shape and a single small instance would
do. An IaC document that only argues for itself is not much use.

**What I did not do.** No WAF: $6/month plus per-request, and the app already
has a per-IP bucket and a daily ceiling — worth adding when there is traffic to
protect, not before. No autoscaling: a scaling policy with nothing to size it
from is a guess with a bill attached. No database: there is no user data, and
adding one would create the retention question this project exists not to have.

---

## Launch phase 3, revisited · The images, finally built

Phase 3 wrote both Dockerfiles, the entrypoint and the compose stack, and never
built any of them. Building them found what building always finds.

**`.dockerignore` governs two images and was written for one.** Both Dockerfiles
build from the repository root, so the blanket `graphhopper/` exclusion — right
for keeping a multi-GB graph out of the API image — also took the router's own
`config.yml` with it. The router build failed on its first ever run.

**The graph was in the router image three times.** `docker history` on a 485 MB
graph showed 509 + 509 + 556 MB: the staging COPY, the `cp -a` into place (and
`rm -rf` afterwards writes a whiteout, so the bytes stay in the layer below),
and then a `chown -R` that rewrote every file's metadata — layers being
copy-on-write per *file*, that copied all of it again. **2.65 GB → 1.2 GB**:
create the user first, `COPY --chown` straight to the final path, leave /app
root-owned because `gh` only reads the JAR.

The conditional bake-in is two stages selected by `GRAPH_SOURCE`, which is the
only way to make a COPY conditional. It needs BuildKit, and that is the point:
BuildKit builds the selected stage alone, so `GRAPH_SOURCE=none` really produces
an image with no graph (520 MB) rather than quietly including whatever happened
to be staged.

**Verified on colima + Docker 29 + buildx, arm64.** Both images build both ways;
`docker compose up` reaches healthy on both services; `/api/health` reports
`clip_available: false`, 146 CLIP segments, and `self_hosted_source: "env"` with
`smoothness` present — which is precisely the case Phase 1.1 exists for, since
the API reaches the router at `http://graphhopper:8989`, a hostname. A real
request returns three routes with `scoring_method: "clip"`.

---

## Launch phase 7 · Technical soundness, and four bugs the new tests found

567 tests to **626**, plus a coverage floor, CI, a Makefile, a runbook and six
ADRs. The interesting part is that every new category of test found something.

**The greenness regression test — the promise nothing was checking.** The app is
named after a claim no test asserted end to end. `scripts/verify_selfhosted.py`
checks something adjacent: that the three presets return *different geometries*
against a live server. That is a check on the router, it needs a network, and it
would pass happily on three routes of identical greenness.

The invariant is not "nature is always greener" but **greener, or it admits it**
— `route_nature` ships the best it can find with a `preset_note` naming the
promise it missed. Which is exactly the shape of the defect found while
pre-warming the cache, where the greenness floor was measured without the CLIP
term while the card was rendered with it.

**Property tests over coordinates found two real bugs on their first run.** The
existing tests check the maths against hand-computable cases, which catches a
wrong formula and not the class of bug that actually bites geographic code.

`bearing_deg` could return exactly **360.0** — `atan2` gives -2.8e-14 degrees
for a due-north step across the antimeridian, Python's float modulo takes the
sign of the divisor, and 360 minus that much is not representable. The docstring
promised `[0, 360)`. And `interpolate` between -89.99999999999999 and 90.0
returns 90.00000000000001: a nanometre past the pole, and still a latitude
`models.py` refuses.

Two of the properties were themselves wrong, which was also instructive.
`SamplePoint` carries `at_m`, not `distance_m`. And `to_lonlat_pairs` rounds to
six decimal places — deliberately, so two people searching the same place
produce a byte-identical request body (Phase J, defect 3) — so the round-trip
property asserts routing precision rather than float equality. There is now a
property pinning that rounding, because it is also a privacy property: a
coordinate at full float precision is far more identifying than one at 0.1 m.

`derandomize=True`, because this is a build gate. Without it Hypothesis explores
a different set each run and the same commit can pass then fail, which is how a
property suite gets labelled flaky and deleted.

**The SSE contract, asserted against the file that parses it.** The existing
streaming tests read the stream through a helper that mirrors the frontend's
parser — right for behaviour, wrong for a wire format, because changing the
framing on both sides of a shared helper leaves every test green and the browser
blank. The last test reads the literal `line.slice(5)` out of `client.js`.
Verified by breaking it.

**`/metrics`, and a test that it can never describe a person.** Every series is
a whole-instance total with no labels, and the tests assert the *shape*: no
label, no non-integer value, no series named after a request attribute. That
last check first searched the raw text for "ip" and failed on the word "clip" in
a HELP line — the sort of check that gets deleted rather than fixed, taking the
rule with it.

**The coverage floor is 85%, measured at 87.33%,** over source modules with the
tests excluded. Statement coverage rather than branch, and the reason is
recorded: `branch = true` collides with the subprocess in
`test_privacy_guard.py`, because pytest-cov's `.pth` auto-instruments the child
without branch mode and combining the two fails the entire run. That subprocess
is the test proving the privacy guard holds in a fresh interpreter.

**The load test measures the right question, after measuring the wrong one.**
Not requests per second — that would be a measurement of Overpass, whose tail is
13.6 s against routing's 24 ms. Its first run reported p50 0.00 s and p95 9.81 s,
which is not a distribution but two: a 429 is refused in microseconds and 38 of
50 requests were refused, because all the load came from one address and shares
one bucket by design. With served and refused reported separately and the
limiter raised: 50/50 served, **p50 3.48 s, p95 5.36 s** — the shape the p95
alarm was sized for. The hint it printed named an environment variable that does
not exist.

**CI runs the suite twice**, the second time under `unshare -n` with no network
namespace at all. conftest blocks sockets and a meta-test proves the guard is
active, but if that guard were removed the suite would still pass on a
developer's network and silently start depending on it.

---

## Launch phase 8 · Finishing

`DEPLOY.md` rewritten for AWS, keeping and extending the one part of it worth
keeping — the "things that will look like bugs and are not" table, which went
from 8 rows to 15. Most of it was never about Render: `clip_available: false`,
`scoring_method: geometry_only`, identical routes from an ignored custom model,
`null` rest stops. The new rows are the silent ones — `MEANDER_CACHE_DB` set,
`smoothness` missing from `path_details`, everyone rate-limited at once — each
of which leaves the app looking healthy.

`render.yaml` and `vercel.json` moved to `docs/legacy/` with a note on what the
AWS version changed and why, and how to go back if the cheaper shape is worth
losing two of the three presets for.

**What a reviewer should still be sceptical about**, unchanged in kind from the
hostile audit and shorter than it was:

- **Nothing is deployed.** The templates validate; that is all.
- **The CLIP prompt choice rests on three location pairs**, one of which has two
  images, and the winning pair measures aesthetic appeal rather than greenery.
- **No real phone.** Everything about the mobile layout and the PWA is measured
  in headless Chrome at 390×844.
- **The naturalness and air-blend weightings are judgements**, written down
  rather than buried.

**Live API calls this phase:** Mapillary ~600 (metadata and image downloads for
the cache pre-warm), GraphHopper self-hosted ~200 (unmetered), Overpass ~40,
Open-Meteo ~60, Nominatim 0.

---

# The iOS run

## iOS phase 0 — Reconciling the two branches · 2026-08-06

The brief for this run recommended taking `feat/launch` as the base and porting
three features onto it. It also said to build both frontends, screenshot them at
390 × 844, and let the project owner choose with their eyes rather than from a
table. That happened, and **the answer came back the other way**: keep the
redesign's frontend, port the launch programme onto it.

**One thing the brief could not have known.** It was written against `main` at
`867e8e2` with both branches unmerged. By the time this run started, the
redesign had already been merged — `origin/main` was `0de9c7a`, "Merge pull
request #2". So "branch from `feat/launch`" no longer meant branching from the
trunk; it meant branching away from it and paying the reconciliation at PR time
instead of now. That is most of why the recommendation was not followed.

### What was checked before it was trusted

The brief's own provenance note says 9 of its 126 claims were wrong, and asks
the reader to expect the same ratio. Everything load-bearing was re-checked:

| claim | verdict |
|---|---|
| `res.body.getReader()` silently falls through to a non-streaming branch under a patched `fetch` | confirmed, `client.js:89` and `:95` |
| `navigator.vibrate` does nothing in WKWebView, so the 200 m barrier warning is silent | confirmed, `FollowMode.jsx:164` |
| `MEANDER_ALLOWED_ORIGINS` is `''` in the task definition | confirmed, `infra/20-services.yaml:259` |
| …and `MEANDER_ALLOW_LOCAL_ORIGINS` therefore defaults *on*, so production allowlists `localhost:5173` | confirmed, `config.py:322` |
| `env(safe-area-inset-*)` exists on `feat/launch` and not on the redesign | confirmed — and now the reason Phase 5 is implementation rather than verification |
| the redesign's `index.html` has an inline anti-flash script; `feat/launch`'s does not | confirmed — so the CSP will need its SHA-256, which the brief called a trap and it is |
| Xcode 26 minimum for Capacitor 8 | machine has 26.6; not a blocker |

**One that was wrong, and it mattered.** The brief warned that a GraphHopper
fixture is keyed on a hash of the request body, that both branches had turned
`instructions` on independently, and that this would have to be reconciled. The
implication everyone would draw is that one set of fixtures must be re-recorded
— which needs a live router, which needs a JDK 21 this machine does not have.

`build_request_body` is **byte-identical on both branches**. Diffed rather than
read. So a fixture signature means the same request on both sides, and the two
sets could simply be unioned: 136 files from the redesign, 297 from launch, 111
shared. The 111 shared ones differ only in their regeneration timestamp. The 25
and 34 unique GraphHopper signatures are not competing recordings of the same
request — they are *different requests*, exercised by tests that only exist on
one side.

Total: **322 fixture files, no re-recording, no live call.** That was the single
biggest risk in the phase and it evaporated on inspection, which is an argument
for inspecting.

### What the merge actually did

`frontend/` was resolved to main's tree **byte-for-byte** — verified with a
`diff --name-only` that came back empty, not by reading the conflicts. Thirty-
seven files from the launch frontend were dropped rather than landed unused, and
BLOCKED.md §5 lists the seven that have to come back and what each is for.
Everything else took `feat/launch`: the backend, `infra/`, the containers, the
Makefile, the scripts, the ADRs and the runbook.

**Three silent duplications the auto-merge produced**, all of which would have
been someone's afternoon:

1. `models.py` ended up with **two `class Step`** — the launch one carrying
   `lat`/`lon`, the redesign one carrying `interval` and `street_name`. Python
   keeps the last definition, so it would have "worked", and the frontend reads
   `.interval`. The launch one was deleted.
2. `routing.py` ended up with **two `_parse_instructions`**, likewise resolved
   by definition order rather than by anyone deciding.
3. `main.py` ended up with **two `steps=` in one `Route(...)` call**. That one
   is a `SyntaxError`, so it would have failed loudly — the only reason it is
   listed with the other two is that it came from the same cause.

None of the three appeared as a conflict. `git` merged each cleanly and produced
something wrong. A `compileall` pass and a duplicate-definition scan over every
backend module are what found them.

### Two tests that asserted things about the machine

Taking the baseline, before touching anything: **two frontend tests and one
backend test failed on a clean checkout**, and all three pass in CI. That split
is worse than a red suite, because CI cannot reproduce it and the developer
cannot trust it.

`sun.test.js` carried the comment *"the suite runs under TZ=UTC"* and nothing
set `TZ`. `canStateLocalTime` compares a longitude's solar offset against the
viewer's timezone, so on a machine in Asia/Colombo both assertions inverted:
London refused, Colombo accepted, and nothing in the failure named the clock.

The backend one was this project's own BLOCKED.md §3, filed and left. Its
proposed fix — `monkeypatch.delenv` — **does not work**: `Settings` is a frozen
dataclass resolved at import, so the module under test has already read the
variable. Replacing the module-level `settings` object is what reaches it.

Both are now supplied by the harness rather than by the environment, and both
have a test pinning the property directly.

### Measured

| | before | after |
|---|---|---|
| backend tests | 395 | **632** |
| frontend tests | 43 passed, 2 failed | **46** |
| statement coverage | — | **87.55%**, floor 85% |
| `cfn-lint infra/*.yaml` | — | clean, 4 templates |
| GraphHopper fixtures | 53 | 87 |
| all fixture files | 136 | 322 |

`make check` is green and now runs the whole of CI rather than most of it — the
frontend suite was not in it before.

**Live API calls this phase: zero.** Nothing in it needed a network.

### What surprised me

The reconciliation was supposed to be the hard part and the fixtures were
supposed to be the hardest part of that. Neither was. The genuinely dangerous
thing was that `git merge` reported success on three files it had quietly
broken, and two of those three would have run.

### What was deliberately not done

- **No frontend features were ported.** Not safe-area insets, not permalinks,
  not export, not the offline store. Each needs wiring into a different
  component tree than it was written for, and doing that inside a 265-file merge
  commit would make both unreviewable.
- **`pwa-gate.mjs` was not brought back and will not be** in its current form.
  It asserts that a service worker serves the shell with the server stopped.
  Service workers do not register under `capacitor://localhost`, so on the
  platform this is now aimed at it would assert nothing while reading as
  coverage.
- **The graph was not built.** `scripts/graphhopper.sh setup` needs a JDK 21 and
  this machine has Java 1.8.

## iOS phase 2 — A native origin, and a defect found by reading · 2026-08-06

Small phase, entirely server-side, deliberately landed before any shell exists —
debugging CORS through a WKWebView console is a bad way to spend a day.

`DEPLOY.md` said *"there is no CORS step, and that is deliberate."* True of the
website: one CloudFront distribution serves the SPA and proxies `/api/*`, so the
browser is same-origin. Not true of an app that serves its assets from
`capacitor://localhost` and calls the distribution over HTTPS.

**The defect underneath it was not the one the brief predicted, and it was
worse.** `infra/20-services.yaml` shipped `MEANDER_ALLOWED_ORIGINS` as `''` with
a comment explaining there was nothing to allow. But `config.py:322` reads
`_env_flag("MEANDER_ALLOW_LOCAL_ORIGINS", not origins)` — the default is *on
whenever nothing is configured*. So the deployed allowlist was never empty. It
was `('http://localhost:5173', 'http://127.0.0.1:5173')`. **Production
allowlisted the Vite dev server**, and no log line, health field or template
comment said so.

Setting `CorsOrigins` closes it — but as a side effect of the list becoming
non-empty, which is exactly the shape of thing a later tidy-up deletes. Hence a
test that names the behaviour rather than a comment that describes it.

### Two things checked rather than assumed

`_resolve_origins` does no scheme parsing at all — it splits on commas and
strips — so `capacitor://localhost` survives intact. Worth confirming: an Origin
is matched as an opaque string, and anything that normalises it produces a value
that never matches and a failure that reads as the allowlist being ignored.

Starlette's `CORSMiddleware` accepting a non-`http(s)` scheme was also checked
by making real requests through a probe app built from the real app's middleware
kwargs. Reloading `backend.main` would have been the obvious approach and the
wrong one — it hands every other test a different `limiter` and `metrics` than
`conftest` resets.

### Verified in a browser, cross-origin

The whole point of the phase, so it was exercised rather than reasoned about.
The frontend was pointed at the API with `VITE_API_BASE` so the browser made a
genuinely cross-origin request, and the API was started with an explicit
allowlist:

- the configured origin got `access-control-allow-origin` back;
- `http://localhost:5173` **did not** — the defect above, closed and visible;
- three real routes streamed and rendered in the redesign frontend, unmodified,
  with `scoring_method: "clip"` and verification meters reading 70%, 77% and 71%;
- the accessible route came back with one barrier and *"cannot be completed"*;
- no CORS error appeared in the console at any point.

`/readyz` returned 503 with the router stopped, which is the documented
behaviour and had never actually been observed before.

### One thing this run did to itself

Requesting a route wrote a row to `route_cache` in `data/cache.db` — real
coordinates, in the file that gets baked into the API image. That is finding #5
of the brief happening in miniature, within an hour of reading it. `make scrub`
removed it and restored the committed bytes, and `scripts/install-hooks.sh` has
now been run on this machine, which is not automatic on clone and is the only
thing that would catch it at commit time.

**Live API calls this phase: zero.** 632 -> 640 backend tests.

## iOS phase 1a — The graph was already there, and it hid a defect · 2026-08-06

Reported at the end of phase 2 that JDK 21 was missing and Phase 1.2 was
blocked. **Both wrong**, and wrong for the same reason: I ran `java -version`
and `/usr/libexec/java_home -V`, and neither sees a keg-only Homebrew formula.
`openjdk@21` (21.0.12) was installed the whole time, at exactly the first path
`scripts/graphhopper.sh` checks.

The script's own comment block documents the trap I walked into:

> **`/usr/libexec/java_home -v 21` does not honour the version filter when
> nothing matches.** On this machine, with only the Java 8 applet plugin
> registered, `java_home -v 21` exits 0 and prints the Java 8 home. Trusting it
> turned a working setup into "Java 8 is too old".

Which is the brief's warning about the comments in this codebase being
load-bearing, arriving as a demonstration rather than as advice. The lesson is
narrower than "read the comments": **ask the tool that owns the question.**
`scripts/graphhopper.sh regions` would have answered in one command, and it also
revealed the `demo` graph had already been built — 71-second import, GraphHopper
11.0, Sri Lanka + Greater London + Noord-Holland.

### Verified against a live router

`scripts/verify_selfhosted.py`, three of four locations: all three presets
return distinct geometry, and `smoothness` is in `path_details` at every one —
the fifth hard accessibility constraint firing from routing data, which the
hosted API cannot supply at any price.

`/readyz` returned 503 with the router stopped and 200 with it running.
Observed both ways; it had only ever been asserted.

Edinburgh failed, and it is the script that is wrong rather than the router:
its location list says `great-britain`, and the `demo` region set imports
**Greater London**. Recorded in `infra/README.md` rather than silently fixed,
because the same disagreement will bite whoever next widens coverage.

### The defect running it found

Chasing Edinburgh led to the real one. The coverage pre-flight compares the
origin against the graph's overall bounding box — and that box is a **union**.
Three separate extracts spanning Sri Lanka to Britain make a rectangle of
roughly 6°N–55°N, 1°W–80°E, and **Paris, Berlin and most of Europe are inside
the rectangle and inside none of the extracts.** They passed the check, reached
the router, came back "Cannot find point", and were told to *try moving the
start a little* — the exact sentence `coverage.py` was written to prevent,
naming Paris in its own docstring as the case it exists for, arriving by the one
path the pre-flight cannot see.

| | before | after |
|---|---|---|
| Paris | `no_route`, "move the start a little" | `outside_coverage` |
| Berlin | `no_route`, "move the start a little" | `outside_coverage` |
| Manchester | `outside_coverage` | unchanged — outside the bbox, caught up front |
| Hyde Park | routes | unchanged |

**The fix deliberately refuses to say which cause it is.** Two things produce
"Cannot find point" on a finite graph — an area never imported, and a genuinely
unroutable spot inside one that was — and `/info` reports only the union, so the
API cannot distinguish them. Naming one would be a guess presented as a
measurement, which is the habit this project exists not to have. The message
names both. Establishing the truth needs per-region boxes, which GraphHopper
does not expose and which live on the router's disk, in a different container
from the API.

Scoped narrowly: only "Cannot find point", only when the router reports a finite
extent. Against the hosted API the original advice is right and is untouched.
Five tests, including the two negative cases.

**Why this one matters more than its size.** Appendix B of the brief ranks
"reviewer tests outside the imported graph and reads it as broken" as the single
highest rejection risk on this app — and on a phone the user's location is
wherever they happen to be standing, not somewhere they typed.

### What surprised me

That the fix was found by running the verification script for an unrelated
reason. Nothing in the brief pointed at it; the pre-flight check looked correct
and its tests passed, because every test picked a point outside the union bbox.
Sydney was outside. Paris never was.

**Live API calls this phase:** GraphHopper self-hosted ~30 (unmetered), all
others zero. 640 -> 645 backend tests.

## Release phase 0/1 — Landing 84 commits, and four things the brief got wrong · 2026-08-08

The fast-forward itself was a non-event, exactly as the brief promised: `main`
was a strict ancestor of `feat/ios`, zero conflicts, 84 commits in one move. All
four ancestry claims checked before running it, all four true.

Everything interesting was around it.

### The tree was locked, and had been for four days

`git restore` failed on `Unable to create '.git/index.lock': File exists`. The
lock was **zero bytes, dated 4 August, 23:01** — four days stale, no git process
running, left behind by something that died mid-operation. Every
index-modifying git command in this repository had been failing since then,
which is a large part of why the working tree was in the state the brief
describes: 17 route rows in `cache.db`, 71 stray fixtures, five untracked docs.
Nobody was ignoring the mess. Git had stopped letting anyone clean it up.

### Four corrections to the brief

The brief is unusually accurate — every defect it names in Appendix B is real
and at the line number given. These are the places it is not.

| | the brief says | what is true |
|---|---|---|
| Phase 0 commits | "Commits: 3–4", before Phase 1 | Any commit on `main` at 867e8e2 makes it diverge and `merge --ff-only` refuses. Phase 0 has to be working-tree cleanup only; the commits come after. |
| Phase 0.2 | run `scripts/scrub_cache_db.py --check --worktree` | That script does not exist on `main`. It arrives *with* the fast-forward. |
| Phase 0.1 | "Four `docs/` files are untracked", three unique | Five, four unique. `RELEASE-PROMPT.md` postdates its own inventory. |
| Phase 0.5 | guard fixtures on coordinate precision | Does not work. See below. |

The cache.db instruction still lands correctly by accident: restoring from
`main`'s HEAD gives a 4 KB file with no tables at all — the 146 pre-warmed
segments live on `feat/ios`, not on `main` — and the fast-forward then replaces
it with the real one. 57,344 bytes, 146 segments, 27 with a NULL score, 0 route
rows, matching Appendix C exactly.

### The precision guard cannot work, and the reason is worth keeping

Phase 0.5 asks for a fourth privacy guard refusing "a fixture whose coordinates
carry more precision than the cache key rounds to". I spot-checked a stray
fixture, found `79.89860148780478` at 14 decimal places against a 4-decimal
segment grid, and nearly wrote it.

Then I measured the committed corpus. **283 of the 322 tracked fixtures already
exceed six decimal places. Some carry eighteen.** They are verbatim recordings
of upstream responses, so they carry upstream's precision by definition. The
rule would have rejected almost the entire existing corpus and still said
nothing about whether any particular file belonged there.

Compared against the 71 strays, every intrinsic property was identical:
`_meander_provenance: recorded`, same envelope, same shape, same precision. The
only real difference is that **nobody decided to add them**. So that is what the
guard checks — a fixture that is not already tracked cannot be committed —
with `MEANDER_ALLOW_NEW_FIXTURES=1` for deliberate recording. Verified failing,
passing, and passing-with-opt-in, because a guard nobody has watched fail is a
guard nobody knows works.

### The gate found two bugs in the commit that added it

Wiring the three CI-only jobs into `make check` was supposed to be plumbing. It
caught two real things immediately.

Extracting the torch-free check out of ci.yml broke it. CI ran it as a heredoc
on stdin, where `sys.path[0]` is the working directory and `import backend.main`
resolved by luck; a script file puts its own directory there instead, so the
check failed on `No module named 'backend'` — a false negative with nothing to
do with torch. It had been passing in CI for the right answer by the wrong
mechanism.

Then ruff's BLE001 rejected the blind `except Exception` in that same new file,
on the first run of the target that now runs ruff before it.

### The coverage number moved while I was correcting it

I committed a README saying 87.64%, measured twice. It is 87.67%.

The first gate run of the session was killed part-way — vitest was declared in
`package.json` at `^4.1.10` and simply absent from `node_modules`, so
`test-frontend` exited 127 — and pytest-cov had already scattered **sixteen
`.coverage.*` files** into the repository root. coverage combines those on the
next run. The 87.64% figure was therefore computed partly from statement data
recorded by code that had since been deleted.

With them gone: 2960 statements, 365 missed, 87.67%, three consecutive runs
identical. One statement of difference, and it does not matter. What matters is
that an invisible untracked file silently changed what the coverage gate
reported, while I was mid-way through correcting that very paragraph for being
stale. `.coverage.*` is gitignored now for that reason rather than for tidiness.

### Measured

| | |
|---|---|
| backend tests | **645** passed, 13.5 s (README said 632) |
| coverage | **87.67%**, 2960 statements, 365 missed, floor 85% |
| frontend tests | 46 passed, 2 files |
| build | 61 modules, 1.4 s |
| duplicate-definition scan | clean, 31 files |
| palette gate | clean |
| cfn-lint | clean, 4 templates |
| torch-free | torch, open_clip, torchvision all absent; `backend.main` imports |
| test-sandboxed | **skipped — macOS has no `unshare -n`.** CI covers it. |
| `data/cache.db` | 57,344 bytes, 146 segments, 27 NULL, 0 route rows |
| fixtures | 322 tracked, all four directories matching `git ls-files` exactly |

### What surprised me

That `make check` had been claiming, in its own success message, to be "the
whole of CI now, not most of it" — while three jobs sat outside it. The line was
true when written. Nothing about adding a CI job makes that line stop being
printed, and nobody reading a green gate has any reason to go and count.

The second one: a duplicate-definition scan on a tree that merged cleanly and
passed 645 tests found real damage on the first run. Two `_instructions` in
`make_synthetic_fixtures.py`, one from each branch, identical signatures — which
is precisely why nothing broke. The shadowed copy generated street names from a
real-sounding pool ("Market Street", "Station Road"); the surviving one
deliberately does not, and says why: a person reading a *direction* is being
told where to walk. That safety property had been one definition order away from
being switched off for 84 commits, and the test suite could not see it.

### What is not done

The three CI-only jobs are in `make check` now, but `test-sandboxed` cannot run
on this machine and says so rather than passing. It has not been verified here.

**Live API calls this phase:** zero. Everything offline, every upstream from a
committed fixture. 645 backend tests, unchanged in count — nothing added, one
dead function removed.

## Release Act III — The six live defects · 2026-08-08

Five needed a fix. The sixth was already right, and saying so is the point of
checking rather than assuming.

### 1 · Strict startup refused to boot the documented production config

`_check_startup()` raised on `missing_keys()`, the *completeness* list, which
names MAPILLARY_TOKEN and ANTHROPIC_API_KEY whenever they are unset. Neither is
needed to serve a route — `missing_required_keys()` exists to draw exactly that
line and its docstring says so — and `/readyz` was already wired to the right
one. Only the boot decision was not.

The configurations that hit it are the recommended ones: `.env.example:75` tells
you to set `MEANDER_STRICT_STARTUP` in production, `infra/20-services.yaml:272`
does, and a free-tier deployment normally has neither optional key. So the
documented production setup was a boot loop on an instance that could answer
every request put to it.

Both new tests were run against the unfixed code first. The boot case fails
there with the real error, `RuntimeError: Missing API keys: GRAPHHOPPER_KEY,
MAPILLARY_TOKEN, ANTHROPIC_API_KEY`.

### 2 · 120 requests a day, for everybody

Global, not per IP. The 121st visitor got "Meander has used up its routing
allowance for today" until midnight UTC.

The number was sized against the hosted GraphHopper's 500-credit day, and
`.env.example` said so. The router is self-hosted now, so it was protecting a
quota that no longer exists.

**The ceiling itself is not redundant, and the brief slightly undersells why.**
`fixtures.budget_applies()` skips the per-service call budgets *entirely* in live
mode — the comment above `_DEV_LIVE_CALL_BUDGET` says production is protected by
"the rate limiter and the daily route ceiling". This counter is the only guard
left on the shared upstreams, so it is re-sized rather than removed.

Measured rather than guessed. Instrumenting `fixtures.fetch` around one uncached
3-objective request:

| service | calls | limit |
|---|---|---|
| self-hosted router | 8 | free, unmetered |
| Open-Meteo | 4 | 10,000/day free tier |
| Overpass | 1 | shared community instance |

Open-Meteo is the binding constraint now and saturates near **2,500 requests a
day**. The machine gives out later — 14.0 s per uncached request with no
`--workers` is about 6,100. **2000**, keeping a fifth of Open-Meteo's allowance
in reserve.

No test depended on the old default; every one passes an explicit
`daily_ceiling`.

### 3 · An unconfigured production allowlisted the dev server

`_env_flag("MEANDER_ALLOW_LOCAL_ORIGINS", not origins)`. An empty
`MEANDER_ALLOWED_ORIGINS` is exactly what a deployment that forgot to configure
one looks like, and "forgot" resolved to "allow a page on somebody's laptop to
call production".

The previous pass documented this rather than changing it, and closed it in
CloudFormation only — which a compose deploy does not inherit, and compose is
how this is being deployed.

**The property that had to survive** is the test titled *"Local development must
need no configuration at all"*. Any fix that makes a developer configure CORS
before `make run` works has traded away the wrong thing.

So the default keys off fixture mode. `replay`/`record` are a laptop — and
`MEANDER_FIXTURES` defaults to `replay`, so someone who has configured nothing
still gets localhost. `live` is the only mode that talks to real upstreams, so it
is the honest signal for "not a laptop", and never adds localhost implicitly.

**All four tests that pinned the old behaviour pass unchanged**, because the
suite runs in replay (`conftest.py:26`). Nothing was traded. The fix is scoped to
the case they never covered.

### A bug found by writing documentation

`.env.example` lists every key with an empty value, because it is a template you
copy and fill in selectively. `_env_flag` treated an empty string as **false**
rather than as unset — unlike `_env_int` and `_env_float`, which have always
treated blank as absent.

So copying the example to `.env` and filling in only what you need set
`MEANDER_ALLOW_LOCAL_ORIGINS=''` and switched off the dev-server origins that
the same file promises need no configuration. Demonstrated both ways before
fixing:

```
replay, MEANDER_ALLOW_LOCAL_ORIGINS unset  -> ('http://localhost:5173', 'http://127.0.0.1:5173')
replay, MEANDER_ALLOW_LOCAL_ORIGINS=''     -> ()
```

An explicit `0` still overrides. Empty is not the same as zero, and only zero
should be able to beat a default.

### 4 · Eight variables with no entry, one described wrongly

"localhost:5173 is always allowed in addition to these" had already stopped
being true and is now the opposite of true in live mode.

Three of the eight are what a single-VM deploy actually turns on:
`MEANDER_ALLOW_LOCAL_ORIGINS`, `MEANDER_TRUSTED_PROXY_HOPS` (0 direct, 1 behind
Caddy, 2 behind Cloudflare and Caddy — too low and every client shares one
bucket and the app self-DoSes), and `MEANDER_CACHE_DB`, documented as *do not
set this*, because pointing it away from the committed database drops every
route to `geometry_only` and nothing reports an error.

Added a test asserting `.env.example`'s numbers against the code's. It
deliberately does not cover `infra/20-services.yaml:288`, which still calls the
HTTP timeout 12 against a real default of 20 — the templates are a portfolio
artifact the brief is explicit about not editing.

### 5 · README

Folded into Act I. 632 → 645 tests, 87.55% → 87.67%, "four verification points"
→ three, and the WCAG claim withdrawn rather than restated.

### 6 · The three score states — nothing to fix

`data/cache.db` has 27 of its 146 segments recorded with a NULL score, which is
correct behaviour: too little imagery is *no score*, not a low one. The question
was whether the UI keeps that distinct from a real 0 and from a route that was
never scored.

It does, and this was checked in a browser rather than read. Against the mock
API at 390 px and desktop, reading the live DOM:

| | rendered as |
|---|---|
| a real score | percentage + filled track (`hasFill: true`) |
| a null score | **hatched** track, no fill, the words "not measured" |
| never scored | "Scored from route shape only — no imagery available here" |

Eight score cells came back `hatched: false, hasFill: true` with percentages;
the ninth came back `hatched: true, hasFill: false, "not measured"`. The mock
carries a deliberate `shade: null` fixture *and* an all-zero route, and the
comment beside them says they exist for exactly this comparison.

Every one of the three is distinguished **by words**, so the distinction
survives a greyscale screenshot. The route identities in the same view were
`solid`, `dashed`, `dotted` — also not colour.

Verified against the real backend too: one replayed 3-objective request returned
`scores={'nature': 0.3751, 'air': 0.7343, 'shade': None}` with
`scoring_method='clip'`, so a real score and a null arrive together in one
payload and the hatch fires on live data, not only on the fixture built for it.

**Live API calls this phase:** zero. 645 → 652 backend tests, coverage 87.67% → 87.71%.

## Release Act II, phase 2 — The two nobody was tracking · 2026-08-08

`BLOCKED.md` §5 lists seven dropped capabilities. There were nine. The two it
never mentioned are the two where the *backend* shipped something the frontend
never consumed, which is a different kind of gap from "the merge dropped a
component we want back", and nothing was watching for it.

Finding them again is mechanical and worth doing before anyone calls §5 closed:
`git grep` every route in `main.py` and every field on every response model in
`models.py`, and confirm something in `frontend/src` reads it.

### ElevationProfile

`Route.elevation` on every response, twelve tests, no reader.

The threshold did not need importing from Python, which is what the brief
assumed. `models.py:116` already ships `limit_pct` on the profile itself,
carrying the same `MAX_INCLINE_PCT` the accessible preset rejects on — the
comment beside it says the point is that the drawing and the verdict cannot be
allowed to disagree. So nothing in the frontend restates 8.

Two departures from the launch source, both deliberate:

It no longer returns `null` when there is no profile. Absent elevation and a
flat route are different statements — `models.py:100-105` says exactly that
about the field — and a section that quietly disappears makes the second claim
on behalf of the first. It says so instead, mirroring how `RouteDetail` already
handles a null `rest_stops`.

The steep stretches are hatched as well as tinted, because a tinted rectangle is
colour as the only differentiator, which is not allowed anywhere else here
either.

The mock gained the field, covering all three branches the way it already covers
them for scores. Verified in a browser against each:

| route | rendered |
|---|---|
| fastest | "Climbs 7 m and descends 12 m. Steepest gradient 4.2%, within the 8% limit." 0 steep rects |
| nature | "…11.4%, which is over the 8% limit this app treats as impassable — 2 stretches marked." 2 steep rects, 2 hatch rects |
| accessible | "Climb was not measured for this route — that is not the same as it being level." no profile drawn |

### ReportBarrier, and the privacy paragraph it would have falsified

`POST /api/report-barrier`, ~16 tests, no caller.

**The thing that nearly went wrong.** `About.jsx` and `FirstRun.jsx` both said
"Nothing is stored". A barrier report is a permanent public note carrying a
coordinate and free text. Shipping the form without touching those paragraphs
would have converted a true privacy claim into a false one — the exact class of
failure the rules at the top of this project exist to prevent, arriving as a
side effect of restoring a feature rather than as a decision anybody made.

So the promise now names its exception: one write, opt-in, one press at a time,
public and permanent, said above the send button rather than below it.

**A correction to the brief.** It says the feature "needs `OSM_DEV_TOKEN`,
currently empty" and must degrade honestly when it is absent.
`backend/osm_report.py:60` says anonymous notes are permitted, so the token is
optional and an unset one produces an unattributed note, not a failure. Keying
the UI off configuration would have disabled a capability that works. It keys
off the response instead.

`pointAtDistance` is new in `lib/follow.js`, the inverse of `locateOnRoute`.
⚠ Its axis order is the dangerous part: geometry is `[lon, lat]`, `BarrierReport`
takes named `lat`/`lon`, and swapping them files a note in the wrong hemisphere
of a public database with nothing downstream to notice. Five tests, including a
round trip against `locateOnRoute` and a null return for degenerate geometry
rather than a point at `[0, 0]`, which is a real place in the Gulf of Guinea.

Both outcomes checked in a browser: on success the note id comes back and the
description clears; on failure the message says nothing was filed **and the
description is kept**, so nobody retypes what they wrote.

### The gate that had never been able to fail

Found while reading an integration spec, not while looking for it.

`no-hard-coded-colour` matched on `#[0-9a-fA-F]{3,8}\b`. `\b` is a GNU
extension and means nothing in a POSIX awk ERE, so the pattern never matched an
ordinary `color: #ff0000;`. Confirmed by running the old gate against a file
containing exactly that: **exit 0**.

It had been green in CI since it was written, against a stylesheet it was not
reading, guarding the rule the design system states more often than any other.
And it came across into `scripts/check_palette.sh` unchanged two commits earlier,
because it was lifted verbatim.

The pattern is fixed. More usefully, the gate now **proves it can fail before it
is allowed to pass**: it feeds itself a known-bad file first and refuses to
certify anything if that comes back clean. Reverting the pattern makes the script
exit 1 with "the gate did not flag a bare hex".

That is the lesson for the five gates still to be restored from `feat/launch`.
Make each one fail once, on purpose, before trusting it.

### Measured

| | |
|---|---|
| backend tests | 652, unchanged this phase |
| coverage | 87.71% |
| frontend tests | 46 → **51** (five for `pointAtDistance`) |
| interactive targets in the new form | 44, 44, 90, 46, 46 px — all ≥ 44 |
| capabilities restored | 2 of 9 |

**Live API calls this phase:** zero. Everything against the mock and the replay
fixtures.

## Act II, phase 3 — the notch, and units

Two capabilities. Neither needed a decision I could not make from the code,
except one, which is recorded below because it was the owner's to make.

### `env(safe-area-inset-*)`

The urgency was not the one the brief describes. It presents this as a fresh
opt-in; `index.html:5` has set `viewport-fit=cover` all along. So this app was
already drawing under the notch with not a single inset handled — the state the
launch branch's own comment calls "strictly worse than not opting in at all".
No `index.html` change was needed, which the brief does not say.

The brief names three targets. There are eight. The five it misses are the ones
that actually bite: `.skip-link:focus` landed at `top: 8px`, inside the status
bar, so the first thing a keyboard user reached was the one thing they could not
see. `.firstrun` replaces `div.layout` rather than nesting inside it, so it
touches three viewport edges. `.map__controls`, `.legend` and MapLibre's compact
attribution sit in corners that above 900px are the viewport's corners.

Two of the thirteen edits are not new padding but clobber fixes. `.panel {
padding: var(--s3) }` at the 420px breakpoint and `.map__controls {
inset-inline-end }` at 899px are shorthands landing after the base rules, and
each would have deleted the longhand above it with no error and no visible
change on any desktop. The three width-scoped rules go at the **end** of the
file rather than in the responsive block, because `.follow` is declared after
that block and a media-query rule placed there loses to it on source order.
That one would also have failed silently.

⚠ The anchors in the spec had drifted — `styles.css` is 1872 lines now, not the
1720 it was written against, and three of the twelve anchors pointed at
unrelated lines. The *reasoning* survived intact; only the numbers moved. Worth
saying because the next spec will have drifted further.

`height: 56px` on the topbar became `min-height`. With the global border-box,
leaving `height` alone would have subtracted the 59px inset from the content box
and clipped the 44px icon button — a 44×44 violation introduced by the fix meant
to make things safe.

Verified by substitution in a real browser, since headless Chrome reports zero
insets and always will: measure at 0, push iPhone 15 Pro values into the four
tokens, assert the deltas. Seventeen checks, portrait and landscape, at 390px
and 1200px, including the deliberate asymmetry — above 900px the panel does
*not* take a right inset, because its trailing edge is the border it shares with
the stage. Every rule reads a token rather than calling `env()` inline, which is
the only reason that substitution is faithful.

What it cannot prove is that the UA reports the right numbers. Only a device can,
and no device has run this.

### `lib/units.js` + `UnitsControl`

Not a port. The source branch published units through a module singleton and
`useSyncExternalStore`, subscribed by exactly one component — the control. Every
route distance went through a `fmtDist` that read the singleton without
subscribing, so **choosing miles re-rendered four chips and left every distance
on screen in kilometres** until something unrelated forced a render. Porting it
faithfully would have ported that. Units went into the App reducer beside
`theme` and are threaded as a prop; about 40 of the source's 159 lines were
deleted rather than carried across.

The spec enumerates 20 call sites. There are **24** — `ElevationProfile` and
`ReportBarrier` landed after it was written. Two of the 24 are hand-formatted
and so appear in no grep for `fmtDist`: `FollowMode`'s barrier-proximity alert,
which is the most safety-relevant number in the app and would have gone on
saying "180 m ahead" while everything around it changed; and
`ElevationProfile`, which hard-codes `" m"` at four sites and never called
`formatElevation` — the exact dead-code trap the spec predicted for the source
branch, reproduced here because the profile was ported before units existed.

ICU decides the clock, not folklore: `en-GB` resolves to `hour12: false`, so the
UK gets miles and a 24-hour clock. The source branch's comment claims the
opposite and its own code disagrees. `'en'` with no region maximises to `US` and
therefore to miles, which is why the control has to be findable rather than
tucked behind an empty state.

**The one thing I asked about.** Persisting the choice adds `meander:units`,
which made About's "The only thing kept in this browser is whether you chose the
light or the dark theme" false. Same shape as the `ReportBarrier` decision last
phase, and the same answer: ship it, and amend the promise to say what is
actually true. About now names both words; FirstRun's "Nothing is stored"
narrows to "No location is stored", which is the strongest true claim at the
moment it is made.

### Making the gates fail

Nineteen deliberate mutations across the two capabilities, every one caught:
eight against the safe-area suite, eleven against the units gates.

The units call-site scanner is the one that earns its place. There is no ESLint
anywhere in this repo and `units` is a defaulted parameter, so an un-threaded
call site compiles, renders, and lies quietly. Nothing else in the build can see
it.

One honest note on process: the first run reported the metric-parity check as
vacuous. It was not — my mutation script's escaping was wrong and the edit never
landed. Applying it properly, the test failed as it should. A falsification
harness needs falsifying too.

### Measured

| | |
|---|---|
| backend tests | 652, unchanged this phase |
| coverage | 87.71% |
| frontend tests | 51 → **170** |
| frontend test files | 2 → 6 |
| deliberate mutations caught | 19 of 19 |
| capabilities restored | **4 of 9** |

**Live API calls this phase:** zero. Everything against the mock and the replay
fixtures.

## Act II, phase 4 — the link, and the file

Two capabilities that both answer the same question — how does a route leave
this page — and both turned out to have a privacy edge the brief does not
mention.

### `lib/permalink.js` + `ShareButton`

The contract is one sentence: a link reproduces the same request body. The test
asserts exactly that, against `buildRouteRequest`.

**`departAt` had to be added, not ported.** The source branch has no concept of
it, because the departure strip postdates it. A faithful port would therefore
break its own headline contract for anyone who has touched that strip —
`client.js` puts `depart_at` in the body, so the link would answer a different
question than the sender was looking at. A time that has already passed is
dropped and explained rather than sent, because the strip builds its chips from
the top of the current hour and cannot offer an earlier one.

**A device fix never reaches the address bar.** `writeUrl` returns early on the
geolocation sentinel. The address bar persists into browser history, and
mirroring a satellite fix there on every state change is the one thing in this
feature that would have made "no location history" untrue. A place the user
searched for is a place they chose to name; a GPS fix is not. Sharing one is
still possible — but only by pressing the button, and the button says so first.

The link arrives by **seeding the reducer**, not by dispatching from an effect:
`nonce: 1, debounceMs: 0` out of `init()`. That is what leaves the nonce-keyed
fetch effect untouched. The alternative routes the defaults, then routes again.

⚠ **Halfway through verifying this, the dev server on 5175 died** and every
browser check went green against an error page — including two that "passed"
because the URL was empty and the DOM was blank. A vacuous pass looks exactly
like a real one. I now start my own server and assert the app actually rendered
before trusting any result.

### `lib/export.js`

**The print sheet is not in the file the brief points at.** There is no print
code in that module at all — no `window.print`, no `@media print`, not the word
"print" in its 231 lines. Restoring only the library ships three formats of four
and does not notice.

**`provenanceNote` is a rewrite, and the reason is a rule-1 violation in the
source.** It computed its own coverage clause from `route.confidence`, so a
placeholder-scored route exported "Accessibility data covers 90% of this route"
while the screen said it had not been evaluated. It now delegates to
`confidenceSentence`, so the file and the screen cannot drift. Four additions:
how the coverage was measured; unmeasured scores named rather than omitted; the
gradient limit read from the payload rather than hard-coded; and a case the spec
did not anticipate — a route exported *mid-enrichment* would otherwise bake "No
rest stops found" into a file that outlives the session.

**One spec expectation I did not meet, deliberately.** It asks that a null
confidence produce no "0%". `confidenceSentence` renders `null` and `0`
identically — "covers only 0% … do not rely on it" — and that is what
`RouteDetail` already shows on screen. Special-casing it in the exporter would
break the delegation the whole rewrite is built on. The conflation of
"unmeasured" with "measured zero" is real, but it is pre-existing, shared, and
errs conservatively, and the machine-readable GeoJSON field still reports
`null`. **It belongs in `format.js`, where it changes an accessibility claim on
screen too — so it is flagged here rather than fixed quietly.**

Two silent-failure traps in the print work: the source forces collapsed content
open with `[hidden] { display: flex !important }`, which cannot port because the
collapsed content here is `<details>` and CSS cannot open one — without the
`beforeprint` hook the sheet has no directions and no OSM caveat, and nobody
learns that until they print. And the print block has to remap its tokens under
`[data-theme='dark']` as well as `:root`, or a dark-theme user prints near-white
ink on white paper.

### The falsification harness needed falsifying, three times

Nineteen more mutations this phase, all eventually caught — but the first runs
reported four false "vacuous" results, and **every one was a bug in my mutation
script rather than a weak gate**: perl escaping that never applied the edit, an
anchor with the wrong indentation, an ambiguous anchor matching twice, and a
`-t` filter written against an assertion phrase instead of a test name.

The lesson is not "check the harness once". It is that a mutation that fails to
apply is indistinguishable, in the output, from a gate that cannot fail — and
the reflex of trusting the alarming reading is what nearly deleted a good test.
Every "vacuous" result now gets the mutation confirmed on disk before the gate is
blamed.

One genuine weakness did surface this way: the permalink round-trip helper
spreads the original state before the decoded one, so a field the encoder drops
*entirely* was masked by the original value and the request body still looked
correct. Dropping `at` survived the first run because of it.

### Measured

| | |
|---|---|
| backend tests | 652, unchanged this phase |
| coverage | 87.71% |
| frontend tests | 170 → **234** |
| frontend test files | 6 → 8 |
| deliberate mutations caught | 22 of 22 |
| capabilities restored | **6 of 9** |

**Live API calls this phase:** zero.

## Act II, phases 5 and 6 — offline, the icons, and a gate that can fail

The last three capabilities, and the two that most needed rewriting rather than
restoring.

### The offline trio

**The consent flag does not live where the brief guessed.** It is not IndexedDB
and not CacheStorage — the source keeps it in `localStorage` under
`meander.offline`, a **third** key, which this project does not allow. And the
source already contains the evidence against itself: because a worker cannot
read localStorage, it *mirrors* the flag into CacheStorage and re-pushes it on
every page load, so an evicted worker cannot come back holding a permission the
user withdrew.

Deleting the mirror removed the whole class of problem. One source of truth, in
the bucket the worker already reads; the worker's entire message channel — 21
lines — went with it, and so did the "page is not yet controlled on first load"
workaround. It also fails closed harder: wiping site data now takes the flag and
the saved route together, where a localStorage mirror could outlive the cache it
was granting permission for.

One thing I added that the spec did not ask for: `setSaveResults` reads the flag
back after writing it. If storage refuses, the worker reads "off" and saves
nothing — so a control still showing "Yes, keep them" would be promising
something no part of the system is doing. A test pins it.

`X-Meander-Cached` (worker: "this is a replay") is one letter from
`X-Meander-Cache` (server: "I had a warm cache, this answer is current"). They
mean opposite things. There is a test for exactly that confusion, because
reading the wrong one would label every fast answer stale.

Verified with the network actually cut, at the CDP level, against the built
bundle and a real registered worker: it opens. **What I did not verify
end-to-end is the worker's write path** — this build runs the mock, so no
`/api/routes` request is made, and the backend on this machine is in `live`
fixture mode, so driving it would have meant real Overpass and Open-Meteo calls.
The contract suite covers that path; the *sweep* — the half that protects
someone — is exercised for real.

### The icons

**The five committed PNGs carry the old palette in their pixels.** `#1b2430` and
`#3fae70`, written into the image data. Copying those blobs would have
reintroduced the forbidden palette as *binary*: invisible to the stylesheet
gate, which reads only `styles.css`; invisible to `git diff`; invisible to
review. So they are drawn from the tokens instead, by a generator with no
dependencies — Node's zlib is all a PNG needs.

The test asserts pixels, not bytes, and it asserts them against the stylesheet:
every opaque pixel must lie on the ramp between the two tokens, so a third
colour anywhere fails. A single pixel repainted in the launch green is caught.

### The gate

The warning in this file was right and understated it. Seven selector families
are dead, not three. Four of fourteen checks would find zero elements and pass —
and one is literally `check(label, true)`, a pass value of the constant `true`,
which cannot fail under any DOM at any viewport.

So the rewrite proves its own selectors first, and the manifest earned its place
on the first run: it refused to grade a page where the routes had never arrived.

Two checks are deliberately **not** restored. "The page itself does not scroll at
390×844" contradicts the shipped design — below 899px the document scrolls as
one, on purpose. "Every route is visible without scrolling" was a bottom-sheet
contract and there is no bottom sheet. Restoring either with a working selector
would fail correctly-built code, which is its own kind of broken gate.

**The most useful thing the gate taught me came from its own falsification.**
Putting a 36px control back went *undetected* by the first version — because a
control behind a closed drawer measures 0×0 and is filtered out as "not
rendered". A single-pass sweep silently exempts most of this app's controls. The
gate now opens each disclosure in turn (the trip-bar segments are mutually
exclusive, so they cannot all be open at once), and the same mutation is caught
by name.

Two pre-existing 44×44 violations are fixed here rather than deferred again:
`.theme-toggle` and `.preset` were both 36px, and `.preset` is on the first-run
path. A correct gate lands red otherwise, and a gate that ships red gets skipped
— the same failure as one that cannot fail.

`dash-palette.test.js` closes what the spec calls its most valuable finding:
fourteen hard-coded hexes in `dash.js` duplicate the stylesheet, the shell gate
reads only `styles.css`, and nothing checked that the two agreed. The last pair
is not a route colour at all — it is `--ink-2`, spelled out.

### On the three privacy questions

Each of these three phases changed what the app keeps, and each time the answer
was the owner's rather than mine: the units key, the coordinates in the address
bar, and now the shell cache plus the opt-in route. The pattern held all three
times — ship it, and amend the promise to say what is actually true. The one
thing I did not do was let any of them ship with the old sentence still standing.

### Measured

| | |
|---|---|
| backend tests | 652, unchanged across all four phases |
| coverage | 87.71% |
| frontend tests | 234 → **334** |
| frontend test files | 8 → 14 |
| gate checks | **25**, all green, five mutations caught |
| deliberate mutations caught this phase | 20 of 20 |
| capabilities restored | **9 of 9** |

**Live API calls across the whole of Act II:** zero.

# The deployment

## Session A — the server

Nothing had ever been deployed. `README.md`, `DEPLOY.md`, `docs/RUNBOOK.md` and
`infra/README.md` all said so, and all four were right. This session put the
API half on the internet: an Oracle Always Free A1 VM, two containers behind a
third, and a Let's Encrypt certificate on `meander-app.duckdns.org`.

### Before writing anything

Seven parallel readers went out before a line of configuration was written, one
per question I did not want to answer from memory: the exact semantics of every
`MEANDER_*` variable; the compose file and its merge rules; the complete route
table; the three claimed defects; what `make check` actually runs; the
deployment docs and `.gitignore`; and this file's own format. An eighth audited
the stale defect register in `docs/RELEASE-PROMPT.md`. Four of them came back
disagreeing with the brief they were given, which is the entire reason for
sending them.

**The one that changed the deployment** was the compose reader, which did not
read the documentation on override semantics but ran the experiment. `ports`
**append** across `-f` files, deduplicated on the whole
`(host_ip, published, target, protocol)` tuple. So the obvious spelling —
listing `127.0.0.1:8000:8000` in the overlay — does not replace `8000:8000`, it
*adds a second binding*, and the merged project publishes both. I diffed the two
spellings through `docker compose config` and watched it happen: without
`!override`, an unauthenticated API sits on `0.0.0.0` past Caddy, past TLS and
past the rate limiter. That is the single most important line in
`compose.prod.yml` and it is a YAML tag.

The same reader established that a service cannot be removed by omission
(`!reset null` does it; `!override {}` fails validation), which is what stops a
Vite dev server starting on a public VM.

### Three things that were already wrong

`frontend/vercel.json` was recorded in two places as having been *moved* to
`docs/legacy/`. It had been copied — byte-identical, sha256 `dc91c087…`, for 157
commits. Deleting it made both sentences true. The `REPLACE-WITH-YOUR-RENDER-HOST`
placeholder stays in the legacy copy on purpose: in a Render blueprint the API
host genuinely is unknown until you create the service, so a placeholder is the
honest value there and a live CSP hole here.

`scripts/graphhopper.sh` defaulted to a 24 GB import heap while
`GH_REGION_SET` defaulted to `demo`, so running it with no arguments asked for
three times the heap the graph needs and failed on this machine with a message
about the JVM rather than about the region set. The comment above it already
apologised for the trap, which is not the same as removing it.

`docs/RELEASE-PROMPT.md` told its reader to go and fix `make check` (fixed in
`1749aa0`) and to delete `VITE_API_PROXY_TARGET` as dead config. It is read at
`vite.config.js:16`, and the comment three lines above records the bug that
reading it closed. That second one is the dangerous kind of stale documentation:
actionable, and wrong.

### A gate that was failing on hardware

`make check` was red on this VM before this session touched anything, and not
for any reason to do with the code. Two tests in `icons.test.js` exceeded
vitest's 5 s default on 2 ARM cores. One measured **14.6 s** — not because
scanning five PNGs is slow, but because it called `expect()` once per pixel per
forbidden colour, about 1.3 million times, and each call builds matcher state
whether or not it fails. Collecting the hits and asserting once takes the same
test to **0.2 s** with the same assertion. The other measured 5018 ms against a
5000 ms default, which is a coin toss rather than a gate; it shells out to the
icon generator, so the work is real and it got explicit patience instead.

I made the changed one fail before trusting it — adding the accent the icons
*are* drawn in to the forbidden list, and watching it name `icon-512.png` and
`icon-maskable-512.png`.

### The edge

A bare `reverse_proxy` would have published `/metrics`. The app registers
**eleven** routes and only seven are in `backend/main.py`: FastAPI adds
`/openapi.json`, `/docs`, `/docs/oauth2-redirect` and `/redoc` by itself, and
nothing in the codebase turns them off in any environment. `/docs/oauth2-redirect`
is the one a blocklist misses, which is why the Caddyfile is an allowlist —
`/api/*` and `/healthz`, everything else 404.

I proved that is Caddy refusing rather than the app lacking the routes: all four
private paths return **200 on `127.0.0.1:8000` and 404 through the public
hostname**, and `/metrics` really does serve Prometheus text on loopback.

DNS-01 rather than HTTP-01, so renewal never depends on a port or on a proxy
rule. The certificate was issued **9 seconds** after Caddy started.

### What I could not prove

**Ports 8000, 8989 and 8990 are not reachable from the public internet — but I
could not demonstrate that from outside.** I tried a third-party HTTP relay and
it turned out to be worthless as an instrument: it failed on both controls, an
open port on an unrelated host and port 80 on this VM by raw IP, while
succeeding against `https://meander-app.duckdns.org/healthz`. A test that
reports "blocked" for everything is the same defect as a gate whose regex never
matches, and reporting its failures as evidence would have been dishonest.

What is conclusive, from inside: `iptables -t nat -L DOCKER` holds exactly three
rules — `dst 127.0.0.1 dpt:8000`, `dst 0.0.0.0/0 dpt:80`, `dst 0.0.0.0/0
dpt:443`. There is no DNAT rule for 8989, 8990 or 2019 at all, so a packet
arriving for those ports has no path into any container. And the API's rule is
restricted by *destination address*, so a packet addressed to the public IP does
not match it.

That last detail is worth keeping. Docker's published-port DNAT happens in `nat
PREROUTING` and is then evaluated in `FORWARD`, **not** `INPUT` — so the
instance's `REJECT` rule at the end of the INPUT chain would not have stopped a
container published on `0.0.0.0`. The loopback binding is doing the work, not
the firewall. Anyone who reasons "iptables only allows 22/80/443, so a published
port is safe" is wrong on this machine.

I had written the opposite into `compose.prod.yml` — that the firewall was a
second layer behind the bind — and a verifier that took the comment at its word
disproved it with counters: across a window carrying 13 new HTTPS connections
the `nat` and `filter DOCKER` counters each moved by 13 while INPUT's
`dpt:443` counter did not move at all. The comment is corrected. The outcome
was never unsafe; the reasoning was, which is worse, because it is the reasoning
that decides whether the bind looks redundant later.

### A better instrument than the one I gave up on

The verifier got the outside-the-VM question much closer to closed than I did,
by building a test that can return **three** answers rather than two. From this
box, against the public IP: 443, 80 and 22 *succeed*; 8000, 8989 and 8990
*time out*; and via the VM's own LAN address, where the loopback DNAT cannot
match, 8000/8989/8990 come back *connection refused*. Refused and filtered are
different failures, and separating them separates the two layers.

The decisive part is the negative control. `rpcbind` (111) and `cupsd` (631)
**are** bound to `0.0.0.0` on this host — and on the public IP they time out
too. So a timeout means "filtered upstream", not "nothing listening", proven on
a case where something certainly is listening.

What remains genuinely open: every packet in that test originated on this VM's
own VNIC and hairpinned out and back. If OCI short-circuits the hairpin without
consulting the ingress security list, those timeouts are gateway behaviour
rather than proof of the list. The DNAT evidence stands regardless — there is
nothing on 8989/8990 to reach — but the security list itself still wants one
command from a laptop on another network.

The VCN security list also cannot be inspected from here — there is no `oci`
CLI on the box. That both firewall layers pass 443 is proven only by the fact
that requests arrive.

### Decisions

**GraphHopper is published nowhere**, not even on loopback. It is
unauthenticated and compute-unbounded and 8990 is Dropwizard's admin connector.
On the ECS shape a private subnet enforced that; here the compose network is the
only boundary there is.

**HTTP/3 is off.** Caddy advertises it by default and both firewall layers pass
TCP only, so a browser reading the `Alt-Svc` header opens a QUIC connection to a
port nothing answers and waits for its own timeout — a first-visit stall with no
error anywhere.

**`MEANDER_CACHE_DB` stays unset**, with the reason written at the place someone
would go to add it.

**A missing `DUCKDNS_TOKEN` aborts `docker compose config`** rather than
starting a Caddy that cannot answer a challenge and fails minutes later in a log
nobody is tailing.

**`caddy_data` is a named volume.** It holds the ACME account key and the
certificate; on an anonymous volume every `up` is a fresh account asking for a
fresh certificate, and Let's Encrypt permits five duplicates a week.

### Deviations

`make check` needed `python3.12-venv`, then Python 3.13 from deadsnakes — the
Makefile hardcodes `python3.13` and the deploy image is `python:3.13-slim`, so
matching it was the right answer rather than relaxing the target — and then
Chromium from snap, because `gate` was skipping for want of a browser.

All three go in `scripts/provision-vm.sh` when it is written. `gate` needs
`CHROME_PATH=/snap/bin/chromium`, since the target looks for `google-chrome` by
name and there is no such binary on ARM64.

With those, **`make check` runs with zero skips on this VM**: 650 backend tests,
349 frontend, 25 gate checks, all green. That is the whole of CI on the
deployment machine, which is worth more than it sounds — the layout gate had
never been run anywhere but CI, and it is the one this repo already caught
grading nothing at all.

(The gate is 35 checks as of the phone pass. The ten new ones are a second load
that enters follow mode and re-runs the overflow check, the 44 x 44 sweep and
axe there, in both themes. See §13.)

**Installing Chromium put a printer daemon on the box.** The snap pulls in
`cups`, which starts `cupsd` and `cups-browsed` listening on `0.0.0.0:631`. It
is not reachable — `cupsd` is a host process, so INPUT rule 7 rejects it on any
real interface, which is exactly the protection Docker-published ports do *not*
get — but a print server has no business on a public web server and I put it
there. `sudo snap stop --disable cups.cupsd cups.cups-browsed` removes it; I was
not able to run that here.

Worth noting how nearly I fooled myself on this one: `curl http://10.0.0.120:631/`
from the VM returns **200**, which looks like proof of exposure and is not.
INPUT rule 3 is `-i lo -j ACCEPT`, and traffic to a local address is routed over
`lo`, so that request never met the REJECT. The same shape of mistake as the
relay, in the opposite direction — a test that says "reachable" for something
unreachable.

`rpcbind` is on `0.0.0.0:111` for the same reason and with the same mitigation.
That one predates this session.

**Nothing is pushed.** This clone has no credential helper, no stored
credential, no `gh` and no private key, so `git push` cannot even ask for a
username. `BLOCKED.md` §6 has the exact command a human needs.

### Measured

| | |
|---|---|
| certificate issued | **9 s** after Caddy started, DNS-01, Let's Encrypt |
| `/healthz` over TLS | `{"status":"ok","version":"0.1.0"}`, verify result 0 |
| private paths 404 through Caddy | 6 of 6 — and 200 of 4 tested on loopback |
| three-objective request, uncached | **15.5 s**, 28,751 bytes, HTTP 200 |
| distinct geometries | **3 of 3** — 8 and 37 shared leading points before diverging |
| `scoring_method` | `clip` on all three; `synthetic_upstream` false on all three |
| segments in the baked-in cache | **146**, `segments_clip` 146 |
| graphhopper — anon RSS / `memory.peak` | **966 MiB** / **1057 MiB**, limit 5 GiB |
| api — anon RSS / `memory.peak` | **61 MiB** / **142 MiB**, limit 1 GiB |
| caddy — anon RSS / `memory.peak` | **11 MiB** / **23 MiB**, limit 256 MiB |
| OOM kills | 0 on all three; swap used 0 |
| host memory in use | 2,106 MB of 11,927 MB |
| graph import on this VM | 234 s at 8g, 486 MB graph-cache |
| upstream failures | 0 |
| backend tests | 652, coverage 87.71% |
| frontend tests | **349** |

### Proving the custom model is executed rather than accepted

Three different geometries is the right criterion but not a sufficient one:
these are round trips, and three different loops could come from seed variation
rather than from the model doing anything. `routing.py:670` pins
`round_trip.seed = 42`, so the A/B is clean, and the verifier ran it against the
router directly — same body, the only difference being `custom_model`:

| | points | distance | geometry |
|---|---|---|---|
| without `custom_model` | 84 | 2492 m | identical to `fastest` |
| with the accessible model | 86 | 2761 m | 8 shared leading points, then divergence |

The no-model result *is* the fastest route, exactly. That is the failure this
criterion exists to catch, and it did not happen. The router also compiles the
rules rather than ignoring what it does not recognise: a rule on a made-up
encoded value returns **400 Cannot compile expression**, and so does a
`smoothness` comparison against a made-up value. And the rules had material to
act on — the fastest loop crosses `sand` twice and reports two sand blockers;
the accessible route reports none.

**One honest limit on that.** Sending only the smoothness rule returned the
fastest route unchanged, because this loop's smoothness values are
`{good, excellent, missing}` and never reach `BAD` or `IMPASSABLE`. So this
deployment has proven the smoothness rule *reaches* the graph and is *valid* —
which is the thing the hostname sniff silently breaks — but has not yet proven
it ever *excludes* a way. The surface rules did the work here. A route through a
genuinely rough segment would close that gap and nothing so far has.

The `accessible` objective came back `status: "blocked"` with *"Hard
accessibility constraints reject this route."* and one substantive blocker: a
22.8% descent against an 8% limit. The custom model has no incline term, so
gradient is caught downstream by the assessor and reported rather than passed —
a blocked route with a drawn geometry is a verdict about a route, not a missing
one, and it is still a third distinct geometry.

### Someone is already using it, from the wrong URL

Caddy's log shows a real iPhone hitting `POST /api/routes` from
`https://7ff77dbe.meander-eoc.pages.dev` — a **per-deployment** Pages hostname.
It is being CORS-rejected, precisely as `compose.prod.yml` documents on purpose,
and the request dies as `context canceled` when the browser gives up on the SSE
stream. The configuration is right and the person testing is on a URL production
will never accept. The stable project URL is the only one in the allowlist.

That client arrived from `104.28.120.31`, which is a Cloudflare/iCloud Private
Relay egress address, and the counters show `rate_limited_total: 12`. The proxy
hop count is correct — the app is reading the real peer — but "one IP is one
user" stops holding behind a privacy relay, and relayed users will share a
single 12-token bucket. Worth a decision later; not a misconfiguration now.

**On the limits, which the measurements do not by themselves justify.** 5 GiB
for the router is defensible for a better reason than 1057 MiB of observed peak:
`/proc/1/cmdline` shows `-Xmx3g`, so the ceiling that matters is 3 GiB of
permitted heap plus metaspace, thread stacks, code cache and direct buffers —
realistically 3.5–4 GiB. 5 GiB sits above that and 2 GiB would not. The
right basis is what the JVM is *allowed* to commit, not what it has committed so
far. What no measurement here can give is the peak under sustained load: a Java
heap grows under GC pressure, not under request count, and nothing has yet
pushed it. That number is unknown, and bounded above rather than measured.

**Live API calls this phase:** one uncached three-objective request against the
real upstreams — 1 route request, 1 cache miss, 1 blocked route, 0 upstream
failures by the app's own counters. The router is self-hosted and unmetered;
Open-Meteo and Overpass were called for that one request.

## Session B — the frontend, and proof · 2026-08-10

Session A's report ended by saying the API was live. I did not take that on
trust, and it held: the certificate is a real Let's Encrypt one issued for
`meander-app.duckdns.org`, `notBefore Aug 9 21:39:38 2026`, `notAfter Nov 7`,
`/healthz` returns `{"status":"ok","version":"0.1.0"}`, `/api/health` reports
`self_hosted: true` with `self_hosted_source: "env"` and `smoothness` present in
`path_details`, and `/metrics` and `/readyz` both 404. Uptime at that moment was
37,962 s — a little over ten and a half hours since the API container started.

I did not run on the VM. This session ran on the operator's Mac, and the VM's
`authorized_keys` does not carry the key on this machine — port 22 answers, the
handshake does not. So half of what follows is deployed and verified, and half
is committed and waiting for three commands. BLOCKED.md §7 has them. That split
runs through everything below and I have tried to be exact about which side of
it each claim sits on.

**Seven readers before anything was written**, which is the only reason the
first of these was found before the deploy rather than after.

`vite.config.js:41-46` sweeps every file in `public/` into the service worker's
precache, filtering only `sw.js` and `.map`. Session B's first instruction was
to put `_headers` and `_redirects` in that directory. Both would have landed in
`PRECACHE`, and `cache.addAll()` is atomic — one non-OK response rejects the
whole promise and no service worker registers at all. The cost of getting that
wrong is not a missing cache entry, it is the entire offline capability, and the
only trace is a failed install nobody is watching. Fixed before either file
existed.

Both ends of that are now measured and they disagree, which is worth writing
down. Under `wrangler pages dev`, `GET /_headers` is a 502 once Pages has
consumed the file — non-OK, install fails outright. Production answers `200
text/html`, the SPA shell. So a developer would have seen offline break loudly
and production would have quietly cached a copy of `index.html` under
`/_headers`. My first commit message asserted the 404 reading as though it were
the production answer; the next one corrected it.

**`_redirects` contains no rules, and that is the decision.** The brief said not
to write a bare `/* /index.html 200` because it turns same-origin `/api` calls
into 200-with-HTML. Cloudflare's own documentation says something worse:
"Redirects are always followed, regardless of whether or not an asset matches
the incoming request." Rules are consulted *before* the asset lookup and the
top-most match wins, so a catch-all would have served the HTML shell for
`/assets/index-*.js`, for `/sw.js`, for every icon. The site would not have
rendered at all. It is also unnecessary — Pages does that fallback automatically
whenever the build has no top-level `404.html`, which is why `/r/abc` and
`/some/deep/link` already returned 200 with the shell before I touched anything.

The `/api/*` hole is real and `_redirects` cannot close it: Cloudflare supports
200 and the redirect codes, and documents `/blog/* /blog/404.html 404` as an
explicitly unsupported example. There is no rule that answers 404. So it is
closed at the other end — the Pages build now fails when `VITE_API_BASE` is not
an https origin, is the project's own origin, or is a host the CSP will not
permit. Gated on `CF_PAGES`, so `make check` is untouched.

**The CSP is live.** Before: `curl -sSI https://meander-eoc.pages.dev/` returned
`referrer-policy` and `x-content-type-options` and nothing else. After: the
policy is on `/`, on the hashed assets, on `sw.js`, on the manifest, on the
icons and on the SPA-fallback response for a path with no file behind it — which
is the one that matters for permalinks. `/assets/*` carries `immutable`,
everything else `max-age=0, must-revalidate`, and neither is comma-joined,
because Pages joins duplicate header names across matching rules and
`Cache-Control` is therefore never on `/*`.

Push to `main` and Pages rebuilt in under two minutes, every time. That is the
deploy mechanism for this half and it needs no credential I do not have.

**Then five hostile reviewers, none of whom had written any of it.** They could
not break the CSP. They broke every gate around it.

- `/api/health%0a` reached the health handler. Caddy compared it against
  `not path /api/health`, found it different, and let `path /api/*` proxy it —
  and Starlette compiles a literal route to `^/api/health$`, where Python's `$`
  matches immediately before a trailing newline. I verified both halves myself:
  `caddy:2.11.4` with an echo upstream answering 200 for `%0a` and 404 for the
  bare path, and `compile_path('/api/health')[0].match('/api/health\n')`
  returning a match. Excluding a path means enumerating every spelling of it,
  and there is always one more. It is now an allowlist of literals, which also
  closes the thing the file's own comment had been promising falsely: `/api/*`
  published every route the app will ever have.
- `csp-hash.test.js` passed with the policy moved out of `/*` and under
  `/index.html` — a pattern the `_headers` file itself documents as a 308 nobody
  consumes — while every document shipped with no CSP. It passed with a bogus
  hash in `script-src` and the real one in `style-src`. And it hashed
  `index.html` while the browser runs `dist/index.html`, which Vite is free to
  differ from because it substitutes `%VITE_*%` inside the HTML.
- The precache test was `X === X`: it asserted `isPrecachable(x) ===
  !PAGES_CONTROL_FILES.includes(x)` against an implementation that was that
  expression. Removing an entry removed its own assertion.
- The build assertion accepted `VITE_API_BASE=https://meander-eoc.pages.dev` —
  the app pointed at itself, the exact defect it existed to prevent.

That is the fourth, fifth, sixth and seventh check this repository has produced
that could not fail, and I wrote four of them in one afternoon. Every mutation
above was re-run against the rewritten gates and each one now fails. The one I
am least comfortable about is that I had already "falsified" the precache gate
before shipping it, three ways, and all three falsifications were of the wrong
thing.

**The browser gate is the point of this session.** `frontend/scripts/live-gate.mjs`,
in the same shape as `scripts/gate.mjs` — raw CDP, no dependencies, a manifest
that must match before anything is graded. Against the live site, in Chrome 151:
21 pass, 1 fails, 2 are not checkable here.

It got three things wrong about itself first. It latched onto whichever
`/api/routes` request came first, which is the CORS preflight, and concluded the
stream had no chunks. It counted the console errors produced deliberately by its
own negative control. And it asserted a time spread unconditionally, which fails
on a healthy deployment whenever someone ran it recently — a cached route
replays in 0.06 s, which timing alone cannot tell from buffering. It now reads
`X-Meander-Cache` and skips that assertion with the reason.

Measured, cold: **6 chunks over 2.9 s**, at 1, 17, 112, 143, 2916 and 2949 ms.
Caddy is not buffering. The CORS negative control is the half that matters —
routes arrive from `https://meander-eoc.pages.dev` and the identical request
from another origin is refused by the browser, so the allowlist is doing real
work rather than the server merely being willing. Pointed at the same build
served without `_headers`, 8 checks fail, which is how I know it can.

**The one failure is real and is not mine.** `sw.js:186` returns early for any
cross-origin request — the line that guarantees a tile cache never becomes a
record of where you have been, and it is right. But this deployment serves the
site and the API from different hosts, so *every* API call is cross-origin and
the `/api/routes` branch below it never runs. I granted consent through the
prefs cache exactly as the page does, ran a search, waited three seconds, and
counted: **zero results caches, nothing stored**. Meanwhile About.jsx tells the
user their last routes are kept, labelled with their age, and deleted when they
choose No. All three are false. §1 says to ask before touching the privacy
promise and the consent control *is* the privacy surface, so it is written up in
BLOCKED.md §8 with the three ways out rather than changed on my judgement.

The offline permalink, which a reviewer flagged as theoretically broken, works —
`SHELL_MATCH` is `ignoreVary` and not `ignoreSearch`, but the `/index.html`
fallback covers it. Checked, not assumed.

**What I could not do.** The whole feature list on a real phone. Device
emulation at 390×844 with a fake geolocation is not a phone: no touch, no
WebKit, no install-to-home-screen, no real GPS, no cellular. That line in the
gate is a SKIP with its reason spelled out rather than a pass, and it is the
honest answer.

**Not deployed:** the Caddyfile and the rate-limit default. Until three commands
run on the VM, `/api/health` is still public and one address can still sustain
4,320 requests a day against a 2,000/day ceiling. `/api/health` reports the live
refill rate, which is how to tell which one is running.

**Live API calls this phase:** roughly a dozen route requests across the gate
runs and the streaming measurements, most of them served from the route cache
and refunded. Two were cold.

---

## Session C, part one — §8, and a deploy that had never happened

The brief said §8 only, and to confirm §7 had landed before building on it. It
had not, and that took the first hour.

### The reload that could not fail

BLOCKED.md §7 listed three commands and said to run them on the VM. Someone ran
them. All three exited 0. `/api/health` was still public afterwards, and the
rate limiter was still refilling at 3.0 rather than 1.0.

`Caddyfile` is bind-mounted as a *single file*, so Docker binds the **inode**,
not the path. `git pull` does not edit in place — it writes a new file and
renames it over the old — so the pull that brought Session B's Caddyfile down
gave the path a new inode and left the container holding the unlinked previous
one. 1311390, 7571 bytes, still carrying `path /api/* /healthz`. `caddy reload`
read exactly what it was told to read, correctly logged **"config is
unchanged"**, and exited 0.

The other half was blunter: `--force-recreate api` replaces a container and
rebuilds nothing, and the backend is baked into the image rather than mounted.
The new container came up healthy carrying the previous evening's code.

Both commands report success while changing nothing, which is this repo's
recurring bug arriving in a deploy step rather than in a gate. Recreating
`caddy` re-resolves the mount; `build api` was the missing verb. Verified over
the public hostname afterwards: `/api/health`, its `%0a` variant, `/metrics`,
`/readyz` and `/openapi.json` all **404**, `/healthz` ok, live refill **1.0**,
`self_hosted_source: "env"`, `smoothness` still in `path_details`.

### §8 — the store moves to the page

The operator chose option 3. `sw.js`'s cross-origin early return is untouched;
it was never the thing that was wrong. The store is now
`src/lib/resultsStore.js`, written by `client.js` after a completed stream.

It stores **less** than the worker did, which is what let this happen without
re-opening the privacy question. The final payload rather than the raw stream,
so no progress events and no duplicate routes from the two-pass enrichment. A
SHA-256 of the request rather than the request, so the unrounded GPS fix that
used to sit in the cache key — `url#body`, enumerable by any script on the
origin — is not written at all. One entry at one fixed key, so "only the most
recent one is kept" is structural rather than a delete-then-put two tabs can
interleave.

Retention is deliberately unchanged: the bucket is named for the installed
shell cache, so a deploy still replaces it and `forgetResults()` still finds it
by prefix. With no shell installed there is no version to bind to and it stores
nothing — which is also why iOS does not quietly start storing, where no worker
registers and DEPLOY.md still records the affordance as inert.

The worker's own store had to go rather than sit there dead. In production it is
unreachable, but `vite preview` serves the build same-origin, and there both
halves would write. Two writers cannot both honour "only the most recent one is
kept".

**Three shipped sentences stopped being true** the moment the store worked, all
of them true before only because nothing was ever written: `UnitsControl.jsx`
("the only things Meander keeps — never a place, never a route"),
`ReportBarrier.jsx` ("Nothing else you do in Meander is stored"), and
`README.md`'s "deleted from two independent paths" — one path now that the
worker no longer sweeps. About.jsx needed no change. Everything it promised is
now true, which was the point.

### The gate, and three things it got wrong about itself

The old check was one assertion — "a route is actually saved" — and that is not
what the control promises. Three promises, three checks now, plus nothing saved
before being asked, the previous search gone rather than hidden, and the set
coming back on a reload with the network off.

I watched it fail first, and then watched it fail three more times for reasons
that were mine:

1. **The consent control is not on the first-run screen.** `App.jsx:460`
   replaces the whole panel with `<FirstRun>` until there is an origin, and
   About lives at the foot of that panel — so pressing a chip on the bare site
   returned `no-fieldset`. A failed press leaves consent ungranted, so "nothing
   is saved without consent" then **passed**, with the control never found.
2. **The two searches were the same search.** `minutes=30` and `minutes=45`;
   `permalink.js:80` writes `min`, and an unrecognised key is ignored rather
   than rejected, so both decoded to the default. One entry after two identical
   requests proves nothing was replaced. The gate now captures both POST bodies
   and refuses to grade "only the most recent" unless they differ.
3. **A warm server cache failed the chunk-count check.** The existing skip
   covered the timing assertion and not the one above it. Measured: **1 chunk,
   51,517 bytes** on a deployment whose streaming is fine.

Final run: **31 passed, 0 failed, 3 not checkable here**, exit 0.

```
ok  nothing is saved before the user has been asked         [0 entries in 0 bucket(s)]
ok  a route is actually saved when the user consents        [1 entry at /__meander__/last-routes]
ok  the two searches are actually different requests        [114B vs 114B, differing]
ok  only the most recent set is kept, after a second search [1 entry across 1 bucket(s)]
ok  the saved set is stamped with the time it was written   [X-Meander-Cached … (4s ago)]
ok  the saved set comes back on a reload with no network
ok  the replayed set is labelled as saved, with its age, on screen
ok  the search before it is gone, not merely hidden
ok  choosing "No" deletes the saved set immediately, without a reload
```

A 429 now reports as *not graded* rather than as "nothing stored". The section
spends three tokens against a bucket of 12 refilling at 1/min, so two runs
inside a few minutes exhaust it — and every store assertion then reports exactly
the symptom of the bug the section exists to catch. I hit this for real on the
third run and briefly believed I had broken the store.

### Twenty-six agents, told to break it

Six attackers on named scenarios — consent withdrawn mid-stream, two searches in
a row, quota exhausted, private browsing, a reload with no network, plus an open
hunt — then twenty verifiers whose only job was to refute what the attackers
filed. Thirty-one claims, eighteen serious enough to verify, **four survived**.

- **A `Cache` handle outlives `caches.delete(name)`.** The bucket leaves the
  registry, the handle keeps working, and a put through it lands where
  `caches.keys()` cannot see it — so `forgetResults()`, which deletes by name,
  can never reach it. Withdraw consent between `caches.open()` and the write
  landing and the result is a route on disk that nothing in the app can delete.
  The same shape as the Caddyfile above: the name was rebound, the handle was
  not. It now deletes through the handle it already holds.
- **Two shells meant two sets.** `caches.open(SHELL_CACHE)` is the install
  handler's first statement and commits the bucket immediately; `addAll` is
  atomic and a single non-OK URL rejects it; a rejected install means `activate`
  never runs, and its keep-set is the only pruner. Two shells then coexist, the
  page picks `sort()[0]`, and which one wins is a coin flip on a content hash.
  Two buckets, one set each, is two sets. The store now sweeps every results
  bucket before it writes, which makes exactly-one structural rather than
  dependent on the worker lifecycle.
- **A withdrawal only held while the page did.** The undo is two round trips
  long; a tab closed inside that window left a route consent no longer covered.
  Reading the flag at boot now sweeps when the answer is not yes.
- **A "No" the disk was too full to record did not stop the storing.** The
  existing routes *were* deleted — which is what made it hard to see — but the
  flag write threw, the catch swallowed it, the read-back agreed, and the
  control sprang back to "Yes, keep them". The next search stored again.
  Deleting the entry needs no new bytes, which is exactly why it works when
  writing one does not.

A fifth, found while fixing those: the link dying **mid-stream** was guarded
nowhere. `fetch` was; the reader loop was not, so a raw `TypeError` reached the
banner as the browser's untranslated string and the store — holding the answer —
was never asked. It is the same walk as being offline at the start.

Each fix has a test that was watched failing without it. Two of those tests were
themselves vacuous on the first attempt. The consent-check mutation kept 22/22
green because the second check masked the first, and only counting the *writes*
caught it — a store that writes a coordinate to disk and then deletes it has
still written it. The orphaned-bucket test passed with its fix removed, because
the sweep re-created the bucket and nothing ever wrote into the orphan it was
supposed to observe.

### What I did not do

**§9 is new and open.** `permalink.js:147` returns before `replaceState` when
the origin is geolocated, so the address bar keeps the *previous* search, and
because the guard keys on the origin nothing written afterwards lands either.
Search a place, press "Use my location", and the URL is frozen for the rest of
the session; a reload boots the abandoned search. It makes `About.jsx:51-52`
false in that case. Reproduced and written up rather than fixed: `permalink.js`
is shared by the share button, the round-trip suite and `App.jsx`'s init, and
this session was scoped to §8.

**A geolocated search still cannot replay after a reload.** The request body
carries unrounded coordinates, so a second GPS fix never hashes the same. The
saved set is there and is still deleted on "No" — nothing About.jsx promises is
false — but the walk-out-of-signal journey only recovers for a search that came
from a link. Making it recover means matching on *rounded* coordinates, which
changes what "the same search" means and would replay a saved walk for someone
standing tens of metres away. That is a decision about the privacy surface, and
§1 reserves it.

**Live API calls this phase:** about twenty route requests across six gate runs,
most served from the route cache. One run was rate-limited outright, which is
why the gate now knows what a 429 means.

## Session C, part two — the two geolocated defects · 2026-08-10

Both of last session's open items were about the same person: someone who
started a walk from where they were standing rather than from a link. §9 said
the address bar froze on the search before it. The note under it said a device
fix could never replay, because a fresh measurement never hashes the same twice.
They are one problem seen from two ends, and closing one without the other would
have moved the failure rather than removed it.

### Confirmed by measuring, not by reading

Last session's lesson was that "confirmed" had meant "committed" and not
"deployed". So before touching anything: `/healthz` answering `{"status":"ok"}`
over valid TLS, `/metrics` returning 404 from outside, GraphHopper still
unpublished, the API bound to `127.0.0.1:8000`, 408 frontend tests green, and
the live gate at **31 passed, 0 failed, 3 not checkable**. All of it measured
here, none of it taken from a file.

### The address bar

`writeUrl` returned before `replaceState` for a geolocated origin. The refusal
was right and is the whole reason `About.jsx` can promise what it promises — but
*returning* left standing whatever was already there, and because the guard keys
on the origin, nothing written afterwards could repair it. Search a place, press
"Use my location", and the URL held the abandoned place for the rest of the
session; a reload booted it, because `init` seeds `nonce: 1` off whatever
`decodeState` finds.

It writes an empty query now. That is not a tidier way of writing nothing: it is
the only way the bar can say "there is no search here to reload", which is the
true statement once the origin is one this module will not record.

The test stub was the other half, exactly as §9 predicted. The old one recorded
calls and left `location.search` at `''` forever, so every assertion about the
bar was really an assertion about the *first* write — and a stale bar is only
visible on the second. It moves `location.search` now, and the device-fix test
asserts on the content of every write rather than on a call count. The count was
the weaker claim, and the fix makes it the wrong one.

### The same spot, which had meant the same bytes

The key now hashes the request with the origin snapped to a 4 dp grid, and
`readRoutes` probes the eight neighbouring squares. The request body is
untouched — full precision still goes to the router — and the destination stays
byte-exact, because it is always a geocoded place with no jitter to absorb.

The neighbourhood is not belt-and-braces, and this is the number that decided
it: rounding alone loses **64%** of re-queries at 5 m, because two fixes that
close share a square only if no grid line runs between them and a square is
6.93 m wide east-west at this latitude. A store that replayed on a coin flip
would be worse than one that never replayed — it would look intermittent rather
than absent.

Measured rather than asserted, which is what the brief asked for:

| | |
|---|---|
| replay stops between | **7.01 m and 25.59 m** of the saved fix, at 51.5074 |
| method | bisection, 9 positions across one square × 36 bearings |
| 5 m | always replays — 2 m of margin at the worst position |
| 200 m | never replays |

The first version of that measurement said 10.39–19.28 m and was flattering
itself: `REQ`'s origin sits exactly on two grid lines, dead centre of its square,
which is the best place a saved fix can be. Sweeping the corners is what turned
it honest.

An independent agent derived 6.9287 m guaranteed-hit and 26.2243 m
guaranteed-miss from the geometry alone. The suite measured 7.00 and 25.58 from
positions 0.49 of a square off-centre on bearings stepped 10° apart. They agree
to the discretisation, which is the strongest evidence here that either is right.

### The gate could not see any of this

Every store check in `live-gate.mjs` started from a permalink — a coordinate
that is byte-identical on every reload. That is the easy case and it was the
only case, which is how the gate sat at 31/0 while both defects were live in
production. Five checks now cover the device fix, and one online search pays for
them: the replay checks run offline, where a request costs no rate-limit token.

**The first run of those checks failed, and the store was innocent.** The gate
already replaces `navigator.geolocation` wholesale in its boot script, hard-coded
to one coordinate, so `Emulation.setGeolocationOverride` could never reach the
page. The override moved to 200 m, the app kept answering from the original
coordinate, and the gate reported *"a fix two hundred metres away does not replay
it — FAILED · the match is too wide"*. It was grading its own stub. That is the
exact failure this file exists to catch, arriving from the inside, and it only
surfaced because it failed loudly instead of passing. The coordinate the page
will actually report is now read back and asserted before anything is graded —
without that, a stub which failed to install makes the 200 m check pass for the
best-looking wrong reason.

Proven able to fail: a worktree with the early return restored, built through the
same vite pipeline and served locally, fails both address-bar checks. Only
`permalink.js` differs between the two runs. Honestly, the second check went red
on its "the bar is empty" clause and not on its "nothing booted" clause — no run
has yet watched routes render from a stale URL.

### What the attackers found, which is most of the value here

Nine agents, none of whom wrote the code they attacked. The rounding arithmetic
survived everything — half-value asymmetry, negative zero, float error in
`deg * 1e4`, the poles, non-finite input. What did not survive:

- **A consent race I introduced.** `readRoutes` checked the flag once and then
  ran up to nine digests before answering. Press "No" during the first and the
  payload still came back on the fifth — drawn on the map, announced as a saved
  copy, and held in React state, exportable to GPX, for the rest of the session.
  The window was one await wide before the neighbourhood existed. Widening the
  match widened the window with it. A withdrawal a read can outrun is not a
  withdrawal.
- **My anti-vacuity guard was itself vacuous.** "Moves a point the distance it
  says it does" compared `offsetBy` against `metresBetween` — algebraic inverses
  sharing one constant, so any error in both cancelled. Doubling the
  metres-per-degree left it green and silently rewrote the headline measurement
  to 14.00–51.16 m. It is graded against haversine now, which shares nothing
  with it.
- **The grid-line test asserted its own arithmetic.** It computed the cell edge
  with a local copy of `Math.round(x * 1e4)`. Against a store mutated to
  `Math.floor` the pair sat mid-square, the case degraded to "the same point
  replays", and it passed. It bisects with the store's own `gridCell` now, which
  is why that function is exported.
- **Nothing distinguished a ±1 probe from a ±2 one.** `nearest > 5` and
  `furthest < 200` are satisfied by an enormous family, including one where two
  different searches answer for each other at 38.43 m. There is a band now.
- **"A few paces" understated the radius by about four times.** Measured
  envelope 9.56–20.82 m from a fix. Both places say about twenty-five metres.
- **A sentence that was never true.** "There is one entry, at one fixed URL,
  readable only by presenting a request that hashes to the stored digest" was
  false before this session and after it. The digest is a field *inside* the
  value, not the key: `readRoutes` matches the URL, parses the whole envelope,
  and only then compares. Two things in this repo already do the digest-free
  read. Corrected rather than deleted, and the correction says so — otherwise
  the widening looks like it spent a defence that was never there.

One mutation of mine survived and deserved to: `gridCell` → `Math.floor` shifts
every boundary by half a square and is otherwise the same grid. A draft test
killed it by pinning a coordinate pair across the meridian, which would have
been an arbitrary alignment dressed up as a guarantee. `Math.trunc` is a real
defect — it folds the square straddling zero to double width — and that one is
caught, by width and not by alignment.

Session C part one ran at four survivors across 26 agents and two vacuous tests.
This ran at six survivors across nine, and three vacuous tests, all three mine.
The rate did not improve. Assuming it would have been the mistake.

### What I did not do

**§10 — the grid is sized for a jitter this app never receives.** `App.jsx:429`
asks for the position with `enableHighAccuracy: false`, which is the wifi/cell
provider, which returns centroids stepping by tens of metres rather than the
sixth decimal the comment claimed. Measured 52.7% replay at σ = 8 m: the
neighbourhood removed the coin flip caused by grid lines and left the one caused
by fix error. The comment is corrected and the behaviour is not, because all
three fixes — `enableHighAccuracy: true`, a coarser grid, or reading
`coords.accuracy` which `App.jsx:414` discards — widen what "the same spot"
means, and §1 reserves that.

**§11 — the replay only works with the controls left at their defaults.** The
grid forgives the origin; everything else is byte-exact, and an empty address bar
carries no minutes or mode. Tap "1 hr" — a chip `FirstRun` puts directly above
the locate button — and the reload rebuilds a 35-minute request that misses. Not
a regression, since the pure geolocated flow never replayed at all before this
session, but it means the feature works for the search nobody customised. The
gate presses locate without touching the dial, so it grades exactly that case.
Written down rather than left as coverage.

**The antimeridian is a dead zone** and above ~85° the feature is off rather
than degraded. Both documented in `resultsStore.js`, neither fixed.

**`README.md` still opens "What is deployed: Nothing".** That is §4/C3 and the
brief said not to start it.

**`npm test` dirties the working tree.** `icons.test.js:184` shells out to
`make-icons.mjs`, which regenerates five PNGs to different bytes every run.
Pre-existing, noticed here because it kept appearing in `git status`, not fixed.

**Live API calls this phase:** about a dozen route requests across four gate
runs, most served from the route cache. No run was rate-limited.

# The phone pass · 2026-08-12

Nine parts, on branch `phone-pass`, from `e6ed697`. Everything below was
measured on the Oracle A1 VM with the real stack up: self-hosted GraphHopper,
the real API on `127.0.0.1:8000`, and Chromium 150.0.7871.128 from snap at
`/snap/bin/chromium`.

## §13 — Follow mode had never been looked at by anything

The brief's first instruction was to point the gate at follow mode *before*
changing any follow-mode code, on the grounds that a number nobody has
reproduced is not a measurement. That turned out to matter twice.

**Nothing had ever entered this screen.** `gate.mjs` reaches the app's
collapsibles two ways — `document.querySelectorAll('details')` and
`[aria-expanded]` — and "Start this route" is neither, so the gate had never
seen `.follow`. The 16 vitest files contain 331 `it()`/`test()` call sites and
render no components at all: no jsdom, no testing-library, no browser-mode
vitest. Two suites read `FollowMode.jsx` as *source text*
(`units-callsites.test.js`, and `follow.test.js` covers the geometry module), so
the file was not unpinned — but its DOM had never existed anywhere outside a
real user's phone.

The gate is now 35 checks. The ten new ones load 390x844, scroll to the Start
button the way a thumb has to, click it, wait for `.follow`, and then re-run the
overflow check, the 44 x 44 sweep and axe in both themes, plus the live-region
count. `.follow` and `.sheet` are in a manifest of their own rather than the
top-level one: the gate's stated rule is that a selector matching zero elements
is a failure and not a skip, so listing them up there would fail every load that
does not enter follow mode.

**What the new pass found, at `e6ed697`, in a real browser.** The a11y baseline
is clean — axe reports nothing in either theme and every target clears 44 x 44,
which is worth knowing because it means what follows is a layout defect and not
an accessibility one. The layout check fails:

```
FAIL  [follow] the sheet fits inside the follow layer
      [sheet overhangs by 25.36px, layer past viewport by -431.17px, map strip 64px]
```

Per device, the spill past `.stage`'s border box:

| device | viewport | predicted | measured |
|---|---|---|---|
| iPhone SE | 375x667 | +24.0 | **+23.98** |
| iPhone 13 mini | 375x812 | +15.3 | **+15.28** |
| iPhone 14/15 | 390x844 | +13.4 | **+13.36** |
| Pixel 7 | 412x915 | +9.1 | **+9.11** |
| iPad portrait | 768x1024 | +2.6 | **+2.56** |

The map strip above the sheet is **64px on every viewport**, exactly as
predicted, because `padding-top` 12 + exit 44 + gap 8 are three fixed pixel
values and none of them scale with the screen.

**Two things the arithmetic got wrong, and one it got right for the wrong
reason.**

1. The spill past `.follow`'s *content box* at 390x844 is **25.36px**, not
   13.36px. 13.36 is the spill past the *stage's border box*. The two differ by
   `.follow`'s 12px `padding-bottom`, and the per-device table above is the
   border-box number.
2. **The sheet does reach the trip bar on a 390x844 phone.** The prediction of
   2.6px of clearance assumed `.panel` has 16px of top padding. It does above
   420px; at 390px `styles.css:1715` overrides it to `var(--s3)` = **12px**.
   Measured: `.panel.top` 412.83, `.seg.top` 424.83, `.sheet.bottom` 426.19 —
   the sheet overlaps the first segment by **1.36px**.
3. The landscape squeeze reproduces: at 844x390 the sheet box is 154.0px against
   170px of content, `scrollHeight > clientHeight`, so the text clips. The
   predicted content height of 208.3px is wrong but the failure is real, and it
   is the `min-height: 30vh` overriding `min-height: auto` that permits it.
   iPhone SE *portrait* does **not** clip (box 200.09 against 198 of content).

**The scroll jump is real and much larger than described.** Scrolling to "Start
this route" the way a thumb must, then clicking, the document teleports:

| device | scrollY before | after |
|---|---|---|
| iPhone 14/15 | 1338 | 0 |
| iPhone SE | 1736 | 0 |
| Pixel 7 | 1570 | 0 |

That is `exitRef.current?.focus()` with no `preventScroll`. The further
prediction — that the Stop button lands *under* the 56px topbar — does not
reproduce, and it cannot: `.stage` is `order: -1`, so it is the first thing in
the document, the scroll clamps at 0, and the button sits at y=121. The jump is
the defect; the burial is not.

**The map controls really are buried.** `document.elementFromPoint` at
`.map__controls`' own centre returns a `<span>` from inside `.follow`.
`.follow` is z-index 30 over `.map__controls` at 5, so the recentre and zoom
controls sit underneath the overlay whose whole design justification is that the
map underneath stays reachable.

**A limiter finding fell out of this for free.** The first measurement pass ran
against the real API rather than the mock, drove `rate_limited_total` from 21 to
27 in a single run over seven viewports, and left **three of the seven with no
routes at all**. Capacity 12, refill 1.0/min, one bucket shared with geocode.
That is Part 2's thesis reproducing itself on the machine, unprompted.

## §13.1 — Follow mode goes full-screen, and §6.7 is amended rather than broken

**The decision, written down because it changes a spec.** DESIGN-HANDOFF §6.7
says the sheet is deliberately not a modal, because the map underneath must stay
pannable. Full-screen changes what "underneath" means, and the two available
readings are not equivalent:

- Sheet full-screen, map left behind it. A focus trap is then correct for the
  sheet and makes the map unreachable, which reverses §6.7 outright.
- **Map inside the full-screen layer.** The trap contains both, so the map stays
  reachable while the rest of the app is properly out of the way.

The second was taken. Mechanically it means the class goes on `.stage`, not on
`.follow`: the stage already contains `MapView` *and* the overlay, so promoting
the stage takes the map with it. MapLibre is never unmounted, the
single-instance rule holds, and no route layer is rebuilt. §6.7's requirement is
met by a different arrangement of the same parts: **underneath becomes inside.**

`.stage` is not resized in any other state, so gate check 5
(`stage.bottom <= panel.top + 2` at 390x844) still measures an ordinary load and
still passes.

Above 900px nothing changes. The stage there is a column beside a panel that
stays legitimately usable, and trapping focus would take the rest of the app
away for no reason. The breakpoint is one constant, `MOBILE_LAYOUT` in
`lib/media.js`, read by both the stylesheet's media query and the JavaScript
decision — a second literal `899` is how a layer becomes modal on one side of a
breakpoint while the layout stays two-column on the other.

### Measured after, in the same browser as before

| device | map strip before | after | sheet spill before | after |
|---|---|---|---|---|
| iPhone SE 375x667 | 64px | **395.7px** | +23.98px | **0** |
| iPhone 13 mini 375x812 | 64px | **540.7px** | +15.28px | **0** |
| iPhone 14/15 390x844 | 64px | **592.2px** | +13.36px | **0** |
| Pixel 7 412x915 | 64px | **703.0px** | +9.11px | **0** |
| landscape 844x390 | 64px | **156.2px** | clipped its own text | **0, not clipped** |
| iPad portrait 768x1024 | 64px | **790.2px** | +2.56px | **0** |

The layer sits exactly on the viewport on every one of them
(`fb.bottom - innerHeight` is 0.00), and the sheet is no longer clipped in
landscape — `min-height: 0` lets flex shrink it and `overflow-y: auto` scrolls
what does not fit, instead of an explicit `min-height` overriding
`min-height: auto` and hiding the remainder.

### A simulated walk along the route's own geometry

Driven through a scripted `watchPosition` at 390x844, 61 vertices of the
`fastest` route:

```
   0%  to-turn 0.4 mi  banner "Chatham Street"            now "Continue onto Galle Road"
  50%  to-turn Now     banner "York Street"               now "Turn right onto Chatham Street"
  75%  to-turn Now     banner "Main Street"               now "Keep left onto York Street"
  90%  to-turn 0.2 mi  banner "Arrive at your destination" now "Bear right onto Main Street"
 100%  progress 100%
```

The banner names the turn **ahead** and the demoted line names the step you are
inside. Before this, the step you were inside was the largest thing on the
screen — GraphHopper names a manoeuvre at the *start* of its interval, so that
was always the turn already taken, and `steps[stepIndex + 1]` was never rendered
at all. `Step.sign` had been on the wire since the first day there were steps and
`grep -rn '\.sign\b' frontend/src` returned zero lines; it is now the glyph.

The camera holds **z16.89**, which is 0.400 m/px at 51.5 N — computed from a
target metres-per-pixel rather than pinned to z17, because the same zoom is
0.59 m/px in Colombo and this app routes in both.

**Arrival, and the sentence it replaces.** Sixty metres past the final vertex the
sheet reads "You have arrived." and `offRoute` stays false through eighteen
seconds of holding still — comfortably past the fifteen-second sustain that used
to turn walking to the door into "You've left the route."

**The accuracy gate.** A fix reporting 2 km of accuracy, in the Gulf of Guinea,
leaves progress untouched and raises the visible "Poor signal" strip. Before,
`FollowMode.jsx:79` kept longitude and latitude and discarded accuracy, heading,
speed and timestamp, so nothing could reject it.

### The privacy trace

Recorded with CDP `Network.enable` over a full session against the **real** API
(not the mock): forty-one fixes along the line, a poor fix, an off-route
excursion, arrival, and Stop.

```
Requests before follow mode opened : 70
Requests during the follow session : 3
   GET Fetch https://tiles.openfreemap.org/fonts/Noto%20Sans%20Italic/0-255.pbf
   GET Fetch https://tiles.openfreemap.org/fonts/Noto%20Sans%20Regular/0-255.pbf
   GET Fetch https://tiles.openfreemap.org/fonts/Noto%20Sans%20Bold/0-255.pbf
Distinct coordinate needles searched: 81
CLEAN: no request carried a live coordinate.
```

Every latitude and longitude the watch reported was searched for, at four
decimal places (~11 m), in every request URL and body. Nothing matched, and no
`/api` request was made at all.

**The camera following the walker discloses nothing to the tile host either, and
that was checked rather than assumed.** OpenFreeMap's vector source declares
`maxzoom: 14`, so every zoom past 14 is served by overzooming tiles the client
already holds — and the whole-route view had already fetched exactly those z14
tiles. Hence three requests in the session and none of them a tile.
