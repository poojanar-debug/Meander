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
