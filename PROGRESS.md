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
