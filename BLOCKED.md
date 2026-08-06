# Blocked

Things this run could not finish, what was tried, and what needs a human.

**Nothing is open.**

| | |
|---|---|
| §0 free tier cannot route nature/accessible | **resolved** — self-hosted GraphHopper 11 |
| §1 no `GRAPHHOPPER_KEY`, fixtures synthetic | **resolved** — a real key exists; live routing works |
| §2 no `MAPILLARY_TOKEN`, CLIP unvalidated | **resolved** — token supplied; cache pre-warmed, prompt re-ranked |
| §3 prototype sources missing | **resolved** — worked around, nothing outstanding |

---

## 0 · ~~The GraphHopper free tier cannot route the nature or accessible presets~~ — RESOLVED

**Resolved:** 2026-08-04, by self-hosting, which was option 2 below.

`scripts/graphhopper.sh setup && scripts/graphhopper.sh serve` builds and runs an open-source
GraphHopper 11 with no flexible-mode restriction. Point `MEANDER_GRAPHHOPPER_URL` at it and both
presets route for real. Verified by `scripts/verify_selfhosted.py` at four points, one per
imported region: all three presets answer and their geometries differ.

Self-hosting also bought something the paid plan would not have. The graph is built with
`smoothness` as an encoded value, so the accessible custom model can now *exclude* ways recorded
as `IMPASSABLE` rather than only reporting them after the fact. That is one of the five hard
accessibility constraints, and until now it could never fire from routing data — the hosted API
does not expose it at any price tier.

The cost is that coverage is now finite: only places inside the imported extracts can be routed.
`scripts/graphhopper.sh regions` prints what is built in.

The original finding, kept because the capability matrix is still the reference for anyone
deploying against the hosted API instead:

<details>
<summary>Original entry</summary>

**Discovered:** 2026-08-04, on the first live request with a real API key.

**What happens**

Both presets steer the router with a `custom_model`. A custom model requires
flexible mode (`"ch.disable": true`), and flexible mode is a paid feature:

```
POST /api/1/route   ->  400  "Free packages cannot use flexible mode"
POST /api/1/route   ->  400  "The 'custom_model' parameter is currently not
                              supported for speed mode"
```

**What the free tier does allow**, established by probing it directly:

| | |
|---|---|
| profiles | `car`, `bike`, `foot` only — `hike` is rejected |
| point-to-point routing | works |
| **round trips** (`algorithm=round_trip`) | **works**, as long as `ch.disable` is not also sent |
| **path details** (`surface`, `road_class`, `road_environment`) | **works** — so the accessibility engine, geometry scoring and confidence are all unaffected |
| `custom_model` | rejected |

**How it behaves now**

`fastest` works everywhere, and so does everything downstream of it: real
accessibility assessment, blockers, rest stops, air quality, shade, best
departure. `nature` and `accessible` return `status: "blocked"` with the reason
quoted above, rather than quietly returning the fastest route a second time
under a different name.

**What you need to do — pick one**

1. **A paid GraphHopper plan** enables flexible mode, and both presets start
   working with no code change.
2. **Self-host GraphHopper.** The open-source server has no such restriction;
   point `GRAPHHOPPER_URL` in `backend/config.py` at it.
3. **Accept two of three.** The app is honest about it and still does the thing
   it exists for on the fastest route — it will still tell you about the steps,
   the cobbles and the gradients on the way.

A fourth option not yet built: approximate the nature preset on the free tier by
routing through a green waypoint found via Overpass, which needs no custom
model. That is a real feature rather than a config change, so it is not done.

</details>

---

## 1 · ~~No `GRAPHHOPPER_KEY` in the environment — routing fixtures are synthetic~~ — RESOLVED

**Resolved:** 2026-08-04. A real key is now configured in `.env`, and with
`MEANDER_FIXTURES=live` the app routes any location inside the imported graph.
An uncached three-objective round trip near Hyde Park returned three real
routes in 14.0 s across 8 GraphHopper requests.

**The committed fixtures are still synthetic**, and that is deliberate rather
than unfinished. They are what makes the keyless demo work offline, they are
labelled `synthetic` in their envelope, and every route derived from one is
forced to `scoring_method: "placeholder"` with `synthetic_upstream: true`. A
recorded fixture would silently drop that labelling, so re-recording is a
decision about what the demo should claim, not a bug to fix.

⚠ Before re-recording, read the fixture-signature note at the end of this file.

<details>
<summary>Original entry</summary>

**Discovered:** Phase A, 2026-08-04

**What I tried**

```
curl "https://graphhopper.com/api/1/route?point=6.9271,79.8612&point=6.9497,79.8500&profile=foot&key=NOKEY"
-> HTTP 401
```

Checked the process environment for `GRAPHHOPPER_KEY`, `MAPILLARY_TOKEN` and `ANTHROPIC_API_KEY`.
None are set, and there is no `.env` anywhere on the machine to source one from.

**Consequence**

No real GraphHopper response can be recorded, so `fixtures/graphhopper/*.json` cannot be populated
from the live service during this run.

**How it was worked around**

`backend/fixtures.py` supports a third fixture provenance, `synthetic`, alongside `recorded`. Every
synthetic fixture carries `"_meander_provenance": "synthetic"` in its envelope, `/api/health`
reports the count, and any route derived from one is labelled `scoring_method: "placeholder"` in
the API response. Nothing synthetic is ever presented as a real measurement.

The synthetic GraphHopper fixtures are hand-built from the documented response schema with
plausible Colombo/London geometry, so the parsing, geometry, scoring and accessibility paths are
all exercised end to end.

**What you need to do**

1. Get a free key at https://www.graphhopper.com/ (500 credits/day).
2. `echo 'GRAPHHOPPER_KEY=...' >> .env`
3. Re-record the fixtures against the live service:

```bash
MEANDER_FIXTURES=record python3 -m backend.record_fixtures --service graphhopper
```

That command replaces every synthetic GraphHopper fixture with a recorded one and stays inside the
80-call budget. Recorded fixtures drop the `placeholder` label automatically.

</details>

---

## 2 · ~~Mapillary token absent — CLIP scoring cannot be validated against real imagery~~ — RESOLVED

**Resolved:** 2026-08-06, by a token from the project owner. This was the last open blocker.

`data/cache.db` now ships **146 pre-warmed segment scores** across all five test locations, and
`POST /api/routes` returns `scoring_method: "clip"` for the first time in the project's history.
27 of the 146 are recorded with a NULL score — points where Mapillary had fewer than two usable
frames — which is deliberately distinct from a low score, and they are what stops
"we could not look" being read as "there is nothing there".

**What real imagery changed, and it was not what Phase G expected**

The prompt-variant ranking largely inverted. On generated reference images four of seven pairs
scored the asphalt texture higher, including the spec's own `v1_extreme`; on real imagery **all
seven separate in the right direction** on the London pairs. PROGRESS.md's Phase G entry had
already warned this was possible, and it was right to.

Across three real pairs only `v2_plain` and `v1_extreme` hold everywhere. `v3_nature` — the
variant Phase G chose — and `v5_street`, which separates widest in London, **both invert on the
Colombo pair**, scoring the city fort greener than the park. `ACTIVE_PROMPT_VARIANT` is now
`v2_plain`; the full table and the reasoning are in `backend/scoring.py` beside the constant.

**Two defects this uncovered, both fixed and both with tests**

- Mapillary answers a *dense* bounding box with HTTP 500 and "reduce the amount of data",
  regardless of `limit`. Density tracks how photographed a place is, so it fails precisely on the
  busy roads the scorer most needs — Euston Road failed every time, Hyde Park never did. The box
  now halves and retries down to a floor.
- `route_nature` judged its "greener than fastest" bar with `score_geometry` called *without* the
  CLIP term, while the card showed the score *with* it — CLIP is weight 0.45, the largest term.
  Harmless while the cache was empty and wrong the moment it was not: the first warmed run served
  a Nature route scoring 0.4806 against a fastest route at 0.4854, and passed the floor.

**What is still worth being sceptical about**

- **n is small.** 4 to 6 images per location, and only 2 at Viharamahadevi — which is the single
  point deciding the one pair that separates the candidates, and the only non-European pair.
- **`v2_plain` measures aesthetic appeal, not greenery**, while the score it feeds is presented as
  a nature score. The two correlate on this sample; a photogenic stone street would score well
  without a tree in it. A construct mismatch, not a bug, and the reason every response still
  carries `scoring_method`.
- Regions nobody has pre-warmed still return `geometry_only`, and say so.

To re-run either step:

```bash
MEANDER_FIXTURES=record python3 -m scripts.compare_prompts --green hyde-park-london --grim euston-road-london
MEANDER_FIXTURES=record python3 -m backend.batch_score
```

---

## 3 · ~~Prototype sources referenced by HANDOFF.md were not present~~ — RESOLVED

Worked around completely; nothing is outstanding. Kept for the record.

**Discovered:** Phase A, 2026-08-04

`HANDOFF.md` names `Waypoint.dc.html` and `mock-api.js` as the source of truth for frontend
behaviour. Neither file exists on this machine (searched `~/Downloads` to depth 3).

**How it was worked around** — the frontend and `src/api/mock.js` were built from the HANDOFF
specification itself, which describes the state model, the streaming shape, the six objectives,
the dash table, the colour tokens and the required blocked-accessible fixture in enough detail to
reimplement faithfully. The mock emits four progress events over ~2.2 s, one route every ~420 ms,
then a narration pass at +700 ms, and includes the blocked-accessible fixture with
`confidence: 0.41` and two blockers, exactly as specified.

**What you need to do** — if the original prototype turns up, diff `frontend/src/api/mock.js`
against it; the contract shape should match.

---

## Before you re-record any fixture

A fixture is keyed on a **hash of the outgoing request body**. `path_details()`,
`_base_body()`, the two custom models and the round-trip parameters are all
inside that hash. Change any one of them and every committed GraphHopper fixture
misses at once, so the offline test suite — the whole safety net — fails
wholesale with `no_fixture` 503s rather than with anything that points at the
cause.

This has already cost this project a debugging session; PROGRESS.md records it
as self-hosting defect #6. `backend/tests/conftest.py` pins
`MEANDER_GRAPHHOPPER_URL` and `MEANDER_GRAPHHOPPER_SELF_HOSTED` for exactly this
reason — those two decide `path_details()`, and therefore the signature.

If you change what the app sends GraphHopper, re-record in the **same commit**
and confirm the suite passes offline before pushing.
