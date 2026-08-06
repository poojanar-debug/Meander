# Blocked

Things this project could not finish, what was tried, and what needs a human.

Entries that have since been resolved are kept rather than deleted, marked
**RESOLVED**, and say what resolved them — the workaround each one describes is
still load-bearing in the code, and deleting the entry would leave the reason
for it unexplained.

**Last verified:** 2026-08-06, against the environment in `.env`.

---

## 0 · The GraphHopper free tier cannot route the nature or accessible presets

**Discovered:** 2026-08-04, on the first live request with a real API key.
**RESOLVED:** 2026-08-04 by self-hosting. Residual constraints below.

**What happened**

Both presets steer the router with a `custom_model`. A custom model requires
flexible mode (`"ch.disable": true`), and flexible mode is a paid feature:

```
POST /api/1/route   ->  400  "Free packages cannot use flexible mode"
POST /api/1/route   ->  400  "The 'custom_model' parameter is currently not
                              supported for speed mode"
```

`fastest` worked and everything downstream of it worked; `nature` and
`accessible` returned `status: "blocked"` with that reason quoted, rather than
quietly returning the fastest route a second time under a different name.

**What resolved it**

Option 2 from the list this entry used to end with: a self-hosted GraphHopper.
The open-source server has no flexible-mode restriction. `scripts/graphhopper.sh`
builds it, `MEANDER_GRAPHHOPPER_URL` points the app at it, and
`scripts/verify_selfhosted.py` checks that all three presets return distinct
geometry at four locations. Self-hosting also exposed the `smoothness` tag,
which the hosted API never did — one of the five hard accessibility constraints
could not fire from routing data at all until then. See PROGRESS.md,
*Self-hosted GraphHopper*, for the six defects that surfaced on the way.

**What is still true, and will bite**

1. **The self-hosted server has to actually be running.** It is not running as
   of this writing (`curl localhost:8989` refuses the connection). With
   `MEANDER_GRAPHHOPPER_URL` set and nothing listening, routing fails; unset it
   and the app falls back to the hosted API, where this entry's original
   symptom returns exactly as described above. Start it with:

   ```bash
   scripts/graphhopper.sh serve
   ```

2. **Only imported regions can be routed.** The graph covers Sri Lanka, the
   Netherlands and Great Britain — the `REGIONS` list at the top of
   `scripts/graphhopper.sh`. Anywhere else has no path at any preset. Add a
   Geofabrik path and re-run `setup` to widen it; `scripts/graphhopper.sh
   regions` prints what is currently built in.

3. `ch.disable` is conditional on which server is in use, and has to stay that
   way — `round_trip` requires it self-hosted and is rejected with it hosted.
   That logic is in `routing.py` and is not cosmetic.

---

## 1 · No `GRAPHHOPPER_KEY` in the environment — routing fixtures are synthetic

**Discovered:** Phase A, 2026-08-04.
**RESOLVED:** a key is present in `.env`, and `MEANDER_FIXTURES=live`.

**What happened**

No key was available when the project was built, so no real GraphHopper response
could be recorded. `backend/fixtures.py` grew a third provenance, `synthetic`,
alongside `recorded`: every synthetic fixture carries
`"_meander_provenance": "synthetic"`, `/api/health` reports the count, and any
route derived from one is labelled `scoring_method: "placeholder"` and
`synthetic_upstream: true`. Nothing synthetic was ever presented as a real
measurement.

**Current state**

| | |
|---|---|
| `GRAPHHOPPER_KEY` | set |
| `MEANDER_FIXTURES` | `live` |
| `MEANDER_BUDGET_*` | raised to 100,000 — the development guard rails are no longer the binding limit |
| `fixtures/graphhopper/` | 68 fixtures, of which **18 are still synthetic** |

**What is still true**

The eighteen original synthetic fixtures are still in the tree. They are
correct to keep — they are what the offline test suite runs against, and they
are why the suite never opens a socket — but it means a replayed request that
lands on one is still demonstration data, still labelled as such, and still must
not be followed. That labelling is not vestigial; the UI's demo ribbon keys on
it.

To replace them with recordings:

```bash
MEANDER_FIXTURES=record python3 -m backend.record_fixtures --service graphhopper
```

---

## 2 · Mapillary token absent — CLIP scoring cannot be validated against real imagery

**Discovered:** Phase A, 2026-08-04.
**PARTIALLY RESOLVED:** the token is now present. The measurement it was blocking
has still not been made.

**What is now unblocked**

`MAPILLARY_TOKEN` is set in `.env`, so imagery can be fetched and
`scripts/compare_prompts.py` can be run against real street photography.

**What is still blocked, and it is the part that mattered**

`data/cache.db` **contains no tables at all** — it is a 4 KB empty file that the
app creates its schema in on first connect. There are no CLIP rows anywhere, so:

- **every route still scores `geometry_only`**, never `clip`. The CLIP path is
  unit-tested but has never produced a number that reached a user.
- `ACTIVE_PROMPT_VARIANT` in `backend/scoring.py` is still `v3_nature`, chosen
  against **procedurally generated reference images** — a foliage texture against
  an asphalt texture — not against real street photography. Four of the seven
  pairs tried, including the one originally specified, ranked an asphalt image as
  *more* scenic than a foliage one. That is a warning about how brittle
  zero-shot aesthetic scoring is, and it has still not been re-checked.
- the Phase G acceptance criterion — does CLIP rank Hyde Park above Euston Road —
  remains unmeasured.

**What you need to do**

1. Rank the prompt variants on real imagery:

```bash
MEANDER_FIXTURES=record python3 -m scripts.compare_prompts --location
```

2. If a different variant wins, set `ACTIVE_PROMPT_VARIANT` in
   `backend/scoring.py` to it, then pre-warm the cache and commit the result:

```bash
MEANDER_FIXTURES=record python3 -m backend.batch_score --location hyde-park-london --location euston-road-london
```

Note that this needs the **full** `backend/requirements.txt`, with torch. The
deploy image deliberately has neither torch nor open-clip-torch and reads the
committed `cache.db` instead — see the README's architecture split.

---

## 3 · One backend test fails, for an environmental reason

**Discovered:** 2026-08-06, taking a baseline before the frontend redesign.

`backend/tests/test_scoring.py::test_fetching_imagery_without_a_token_fails_loudly`
asserts that requesting imagery with no `MAPILLARY_TOKEN` raises
`ScoringUnavailable` naming the missing variable. A token is now present in
`.env` (see #2), so the call gets past that guard and dies further down on a
missing fixture instead:

```
Regex: 'MAPILLARY_TOKEN'
Input: 'No fixture for mapillary request 451de727c24f885a …'
```

Unsetting the variable makes it pass, which confirms the cause. **The test is
right and the environment changed under it.** The suite is otherwise green:

```
1 failed, 388 passed
```

**What you need to do** — decide which of these the project wants:

1. Have the test clear `MAPILLARY_TOKEN` for its own duration via
   `monkeypatch.delenv`, so it tests the no-token path regardless of the
   developer's environment. This is the ordinary fix.
2. Have `conftest.py` neutralise the token for the whole suite, as it already
   does for `MEANDER_GRAPHHOPPER_URL` — that variable was made hermetic for
   exactly this class of bug (PROGRESS.md, self-hosting defect 6).

Either is a change to `backend/tests/`, which the current frontend redesign
scope does not authorise, so it is recorded here rather than done.

---

## 4 · Prototype sources referenced by HANDOFF.md were not present

**Discovered:** Phase A, 2026-08-04.
**SUPERSEDED:** 2026-08-06 by `docs/DESIGN-HANDOFF.md`.

`HANDOFF.md` named `Waypoint.dc.html` and `mock-api.js` as the source of truth
for frontend behaviour. Neither file existed on this machine (searched
`~/Downloads` to depth 3). The frontend and `src/api/mock.js` were built from
the HANDOFF specification itself, which described the state model, the streaming
shape, the six objectives, the dash table, the colour tokens and the required
blocked-accessible fixture in enough detail to reimplement faithfully.

This no longer needs resolving: `docs/DESIGN-HANDOFF.md` is now the frontend
specification, it is in the repo, and it supersedes the missing prototype. If
the original ever turns up it is of historical interest only.
