# Blocked

Things this run could not finish, what was tried, and what needs a human.

---

## 1 · No `GRAPHHOPPER_KEY` in the environment — routing fixtures are synthetic

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

---

## 2 · Mapillary token absent — CLIP scoring cannot be validated against real imagery

**Discovered:** Phase A, 2026-08-04

Same cause as (1): `MAPILLARY_TOKEN` is unset, so no street-level imagery can be fetched and the
CLIP prompt-variant comparison has nothing real to rank.

**How it was worked around**

`backend/scoring.py`, `backend/batch_score.py` and `scripts/compare_prompts.py` are complete and
unit-tested: the bounding-box sizing, the contrastive softmax, the cache read/write, the
`scoring_method` transition to `clip`, and the rule that a point with too little imagery is
recorded as *no score* rather than a low one. `scripts/compare_prompts.py` falls back to
procedurally generated reference images — a foliage texture against an asphalt texture — which
verifies the model loads and the prompt polarity is right, but says nothing reliable about how a
prompt pair behaves on real street photography.

**So the following is still unmeasured:**

- which prompt variant actually performs best on real imagery
- whether CLIP ranks Hyde Park above Euston Road, which is the Phase G acceptance criterion
- any real `scoring_method: "clip"` route, since `data/cache.db` ships empty of CLIP rows

**What you need to do**

1. Create a client token at https://www.mapillary.com/dashboard/developers
2. `echo 'MAPILLARY_TOKEN=...' >> .env`
3. Rank the prompt variants on real imagery:

```bash
MEANDER_FIXTURES=record python3 -m scripts.compare_prompts --location
```

4. If a different variant wins, set `ACTIVE_PROMPT_VARIANT` in `backend/scoring.py` to it, then
   pre-warm the cache and commit the result:

```bash
MEANDER_FIXTURES=record python3 -m backend.batch_score --location hyde-park-london --location euston-road-london
```

---

## 3 · Prototype sources referenced by HANDOFF.md were not present

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
