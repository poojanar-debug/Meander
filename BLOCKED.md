# Blocked

Things this run could not finish, what was tried, and what needs a human.

**Four entries are open — §5, a deliberate deferral with a list; §6, which
needs one credential only a human can supply; and §10 and §11, both found by
agents attacking the fix for §9 rather than reviewing it, and both needing a
decision about the privacy surface rather than a patch.**

| | |
|---|---|
| §0 free tier cannot route nature/accessible | **resolved** — self-hosted GraphHopper 11 |
| §1 no `GRAPHHOPPER_KEY`, fixtures synthetic | **resolved** — a real key exists; live routing works |
| §2 no `MAPILLARY_TOKEN`, CLIP unvalidated | **resolved** — token supplied; cache pre-warmed, prompt re-ranked |
| §3 prototype sources missing | **resolved** — worked around, nothing outstanding |
| §4 two suites asserted things about the machine | **resolved** — TZ and the Mapillary token are now supplied by the harness |
| §5 the merge took main's frontend entirely | **open** — deliberate; §5 lists what has to come back and when |
| §6 the deployment VM cannot push to GitHub | **open** — needs a credential only a human can supply |
| §7 the Caddyfile and rate limit are committed, not deployed | **resolved** — the documented commands were not enough; both needed the container replaced, not reloaded |
| §8 the saved-route store is inert and the UI says otherwise | **resolved** — option 3: the store re-based on the page, and it stores less than the worker did |
| §9 the address bar freezes on the search before a geolocated one | **resolved** — the refusal now clears the bar instead of declining to touch it, and the key rounds so a device fix can replay at all |
| §10 the grid is calibrated for a precision this app does not ask for | **open** — `enableHighAccuracy: false` returns tens of metres, not fractions; ~53% replay at σ = 8 m. Three fixes, all of them privacy decisions |
| §11 a geolocated search only replays with the controls at their defaults | **open** — an empty address bar carries no minutes or mode, so the reload rebuilds a different request |

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

---

# The iOS run

Everything above predates the decision to ship Meander as a native app. New
findings go here rather than into a resolved section, so the numbering above
keeps meaning what it meant.

## 4 · Two suites asserted things about the machine they ran on — RESOLVED

**Discovered:** 2026-08-06, taking the baseline before the iOS work.
**RESOLVED:** the same day, in the two commits before the reconciliation merge.

Both were green in CI and red on a developer's laptop, which is the worst
possible split — CI cannot reproduce it and the developer cannot trust it.

**`sun.test.js`** carried a comment reading *"the suite runs under TZ=UTC"* and
nothing set `TZ`. It was true by accident: GitHub's runners are UTC, and
`.github/workflows/ci.yml` set it for that job only. `canStateLocalTime`
compares a longitude's solar offset against the *viewer's* timezone, so on a
machine in Asia/Colombo both expectations inverted — London refused, Colombo
accepted — with nothing in the output naming the clock. `vite.config.js` now
forces `TZ=UTC` for the test run, and the comment is an assertion.

**`test_fetching_imagery_without_a_token_fails_loudly`** was this file's own §3
on the redesign branch. It asserted that fetching imagery with no
`MAPILLARY_TOKEN` raises `ScoringUnavailable` naming the variable, and only did
so on a machine that happened not to have one. The fix that entry proposed —
`monkeypatch.delenv` — **does not work**, and that is worth recording: `Settings`
is a frozen dataclass resolved once at import, so the module under test has
already read the variable and clearing it changes nothing. Replacing the
module-level `settings` is what reaches it, which is the idiom
`test_fixtures.py` already used to inject a GraphHopper key.

> ⚠ **The two branches numbered this file differently.** On the redesign branch
> the entry above was **§3** and prototype sources were §4; on `feat/launch`
> there was no test-failure entry at all and prototype sources were §3. This
> file follows `feat/launch`'s numbering, because that is the branch whose
> claims match the merged tree. A reference to "BLOCKED.md #3" written before
> 2026-08-06 may mean either.

## 5 · The reconciliation merge took main's frontend entirely

**Status:** closed for the web release; one row remains open for iOS.
Not a defect — a deferral with a list, now worked through.

**Updated 2026-08-08, during the release pass.** Two capabilities are back, and
two more were found that this section never tracked at all. See "What has come
back" below the table.

`feat/ios` merged `feat/launch` for its backend, infrastructure, containers,
scripts and documentation, and resolved `frontend/` to main's tree
byte-for-byte. Thirty-seven files from the launch frontend were dropped in that
merge rather than landed unused.

These are the ones the iOS work actually needs back, and each has to be **wired
into this frontend**, not copied next to it:

| what | why iOS needs it | phase |
|---|---|---|
| `env(safe-area-inset-*)` in `styles.css` | this frontend has none at all; the notch and home indicator are unhandled | 5 |
| `lib/permalink.js` | deep links, so a shared Meander link opens the app | 4.6 |
| `lib/export.js` | GPX/GeoJSON through the native share sheet | 4.3 |
| `lib/offline.js`, `lib/offlineStore.js` | saved routes, re-based on Preferences — service workers do not register under `capacitor://localhost` | 4.4 |
| `lib/units.js` | miles and a 12-hour clock from the locale | — |
| `public/` icons + `manifest.webmanifest` | the icon set Phase 7 extends | 7 |
| `scripts/gate.mjs` | the Phase 5 layout gate, 14 checks | 5 |

### What has come back

| what | commit | note |
|---|---|---|
| `ElevationProfile` | `378beec` | **Was tracked by nothing.** `Route.elevation` is on every response with twelve tests behind it and no UI read a byte of it. The gradient threshold arrives on the wire as `limit_pct`, so the drawing cannot drift from the verdict. |
| `ReportBarrier` | `898810f` | **Was tracked by nothing.** `POST /api/report-barrier` has ~16 tests and had no caller. Shipping it required amending the privacy paragraphs in `About.jsx` and `FirstRun.jsx`, because it is the only write this application makes. |

Both were absent from the table above. The table was written from the iOS
brief's list of what iOS needed, and these two are cases where the *backend*
shipped a capability the frontend never consumed — a different kind of gap, and
one nothing was watching for. `git grep`ing each endpoint and each `models.py`
response field against `frontend/src` is what found them, and is worth repeating
before calling this section closed.

Two corrections to what was believed about them:

- `ReportBarrier` was thought to require `OSM_DEV_TOKEN`. It does not.
  `backend/osm_report.py:60` records that anonymous notes are permitted, so an
  unset token yields an unattributed note rather than a broken feature. Keying
  the UI off configuration would have disabled a working capability.
- `ElevationProfile` was expected to need the 8% constant imported from
  `accessibility.py` somehow. It does not: `models.py:116` already ships
  `limit_pct` on every profile.

### Still open

**None, for the web release.** All seven rows in the table above are back, along
with the two the table never tracked. What each of them actually needed, as
opposed to what the table said, is recorded in `PROGRESS.md` under Act II
phases 3-6.

Three of them are not restorations and should not be read as such:

- **`lib/offlineStore.js` was rewritten.** The source kept its consent flag in
  `localStorage` under a third key, which this project's rules do not permit,
  and then mirrored it into CacheStorage anyway because a worker cannot read
  localStorage. The flag now lives only in CacheStorage. One source of truth,
  and it fails closed harder.
- **`lib/units.js` dropped its store.** The source published units through a
  module singleton subscribed by exactly one component, so choosing miles
  re-rendered the control and left every distance on screen in kilometres.
  Units are threaded as a prop.
- **`scripts/gate.mjs` was rewritten**, per the warning below, and now refuses
  to grade anything until its own selectors match.

**The Capacitor rebase is a separate, still-open row**, and conflating it with
the web work is what the original row did. A service worker never registers
under `capacitor://localhost`, so the iOS build needs the same capability on
Preferences rather than CacheStorage. The labelling contract in
`lib/offline.js` is storage-agnostic and carries across unchanged; only
`offlineStore.js` and `sw.js` need native equivalents.

⚠ **`scripts/gate.mjs` is a rewrite, not a port, and for a sharper reason than
recorded here.** It selects on `.row__button`, `.sheet__handle` and
`.sheet__scroll`, none of which exist in this frontend, so roughly half its
checks would find zero elements and pass vacuously — the same objection this
section already raises against `pwa-gate.mjs`. Every selector has to be
re-targeted, and the gate has to assert its selectors match something before
asserting anything about them.

That is not hypothetical here. The hard-coded-colour gate was found during this
pass to have been **incapable of failing since it was written** — `\b` is not a
word boundary in a POSIX awk ERE, so `#[0-9a-fA-F]{3,8}\b` never matched an
ordinary `color: #ff0000;`. It had been green in CI against a stylesheet it was
not reading. `01160fb` fixes the pattern and makes the gate self-test before it
is allowed to certify anything. Any gate restored from `feat/launch` should be
made to fail once, on purpose, before it is trusted.

**`scripts/pwa-gate.mjs` is deliberately not on that list**, and the reasoning
splits by platform now that a worker exists on the web.

For **iOS** the original objection stands unchanged: there is no service worker
under `capacitor://localhost`, so the gate would have nothing to assert about,
and a gate that cannot fail is worse than no gate. It needs rewriting against
the native store or replacing with an on-device check.

For the **web** it was not restored either, but for a different reason: as
written it asserts `localStorage.getItem('meander.offline')` — a third storage
key, which this project does not allow, and one this tree deliberately does not
have. What it was really guarding is now covered without it: the shell-opens-
offline claim is verified with the network cut at the browser level, and the
worker's own invariants — nothing cross-origin cached, an unversioned prefs
cache, one saved response, no replay of a stream that ended in an error — are
asserted by `frontend/src/lib/sw-contract.test.js`, which runs in `make check`
rather than needing a browser at all.

The CI jobs that graded the dropped code went with it. They come back with it.

## 6 · The deployment VM has no credential for `git push`

**Discovered:** 2026-08-09, on the first commit of the deployment session.

The repository on this VM is a working clone on `main`, tracking
`origin/main` at `https://github.com/poojanar-debug/Meander.git`. Commits work.
Pushing does not:

```
$ git push origin main
fatal: could not read Username for 'https://github.com': No such device or address
```

**What was tried, and what is actually absent.** This is a missing credential
and nothing else — not a network fault, not a permissions problem on the remote:

| | |
|---|---|
| `~/.git-credentials` | absent |
| `credential.helper` | unset, in every scope (`git config --list --show-origin`) |
| `gh` CLI | not installed, so `gh auth` cannot supply one either |
| `GITHUB_TOKEN` / `GH_TOKEN` in the environment | unset |
| `~/.ssh/` | holds `authorized_keys` only — no private key, so an SSH remote has nothing to offer either |

DNS and egress are fine: the same box resolves and reaches `github.com`, and
pulled `caddy:2.11.4` from Docker Hub during this session.

**What the human has to do.** Either, once, from a shell on this VM:

```bash
# a fine-grained PAT with Contents: read and write on poojanar-debug/Meander
git config --global credential.helper store
git push origin main          # prompts for username + PAT, then remembers it
```

or, if an SSH key is preferred:

```bash
ssh-keygen -t ed25519 -C meander-vm -f ~/.ssh/id_ed25519 -N ''
cat ~/.ssh/id_ed25519.pub     # add as a deploy key with write access
git remote set-url origin git@github.com:poojanar-debug/Meander.git
git push origin main
```

**Until then**, commits accumulate locally and are not lost — `git log
origin/main..main` lists exactly what is waiting. Nothing in this file's
resolution changes any code; the deployment itself does not depend on the push
succeeding, only the visibility of the history does. The brief for this work
asks for a push after every phase, and that is the one instruction this session
could not carry out.

---

## 7 · ~~The Caddyfile and the rate limit are committed but not deployed~~ — RESOLVED

**Resolved:** 2026-08-10, during Session C, on the VM. **Both documented commands
ran, both exited 0, and neither did anything.** See "What actually deployed it"
at the end of this section — the commands in this entry were wrong, and wrong in
a way that reported success.

**Opened:** 2026-08-10, during Session B.

Session B changed two things that only take effect on the VM, and Session B did
not run on the VM. It ran on the operator's Mac.

- `Caddyfile` — `/api/health` is no longer in the public allowlist, and the
  allowlist is now literal paths rather than `/api/*`. Until Caddy reloads,
  `https://meander-app.duckdns.org/api/health` is still public and still
  discloses the router's internal endpoint, the key booleans, the counters and
  the rate limiter's configuration. Verified still open at the time of writing.
- `backend/config.py` — `per_ip_refill_per_min` is 1.0 rather than 3.0. Until
  the API container restarts, one address can still sustain 4,320 requests a day
  against a 2,000/day ceiling. `/api/health` reports the live value under
  `rate_limit.per_ip_refill_per_min`, which is how to tell which is running.

**What was tried.** SSH from this machine, three users, with the key that is
here:

```
$ ssh -i ~/.ssh/meander_oci -o BatchMode=yes ubuntu@130.210.61.235 'echo OK'
ubuntu@130.210.61.235: Permission denied (publickey).
opc@130.210.61.235:    Permission denied (publickey).
root@130.210.61.235:   Permission denied (publickey).
$ nc -z 130.210.61.235 22
Connection to 130.210.61.235 port 22 [tcp/ssh] succeeded!
```

Port 22 is open; this key is not in `authorized_keys`. Its fingerprint is
`SHA256:UIzMOvy71ZPWES9LxmqbHjfbRtBIBViAEzl/mTONos8`. Nothing about the
frontend was blocked by this — Cloudflare Pages builds from `main` on push, and
that half is live and verified.

**What the human has to do**, from a shell on the VM:

```bash
cd ~/Meander
git pull
docker compose -f docker-compose.yml -f compose.prod.yml exec caddy \
  caddy reload --config /etc/caddy/Caddyfile
docker compose -f docker-compose.yml -f compose.prod.yml up -d --force-recreate api
```

**Then confirm all four, from a laptop rather than from the VM:**

```bash
curl -s -o /dev/null -w '%{http_code}\n' https://meander-app.duckdns.org/api/health     # want 404
curl -s -o /dev/null -w '%{http_code}\n' https://meander-app.duckdns.org/api/health%0a  # want 404
curl -fsS https://meander-app.duckdns.org/healthz                                       # want status ok
```

and, from the VM itself:

```bash
curl -s 127.0.0.1:8000/api/health | jq .rate_limit.per_ip_refill_per_min       # want 1
```

The second of those is the one worth running. `%0a` is the byte that defeated
the first version of this change: Caddy compared it as a different path and let
it through, and Starlette's `^/api/health$` matched it anyway, because Python's
`$` also matches before a trailing newline.

### What actually deployed it

Session C ran the three commands above on the VM. All three exited 0. Afterwards
`https://meander-app.duckdns.org/api/health` still returned **200**, and
`/api/health` was still public. Two separate reasons, and both commands report
success while changing nothing:

**1. `caddy reload` reloaded a file that no longer exists.** `Caddyfile` is
bind-mounted as a *single file*:

```
/home/ubuntu/Meander/Caddyfile -> /etc/caddy/Caddyfile
```

A single-file bind mount binds the **inode**, not the path. `git pull` does not
edit a file in place — it writes a new one and renames it over the old — so the
pull that brought Session B's Caddyfile down gave the path a new inode and left
the container holding the unlinked old one. Measured:

```
$ stat -c '%i %s' Caddyfile                                  # host
1311395 10666
$ docker exec meander-caddy-1 stat -c '%i %s' /etc/caddy/Caddyfile
1311390 7571
```

Two different files. `caddy reload` dutifully read `/etc/caddy/Caddyfile`,
found the pre-Session-B config, and logged:

```
{"level":"info","msg":"config is unchanged"}
{"level":"info","logger":"admin.api","msg":"load complete"}
```

Exit 0. **A reload that could not fail.** The running allowlist was still the
old `path /api/* /healthz`, confirmed straight out of the admin API:

```
$ docker exec meander-caddy-1 wget -qO- http://127.0.0.1:2019/config/ \
    | grep -o '"path":\[[^]]*\]'
"path":["/api/*","/healthz"]
```

**2. `--force-recreate api` recreated the container from a stale image.**
`--force-recreate` replaces the container; it does not rebuild the image, and
the backend is baked in rather than mounted. The new container came up carrying
the image built the previous evening:

```
$ docker exec meander-api-1 grep -n 'per_ip_refill_per_min: float' /app/backend/config.py
271:    per_ip_refill_per_min: float = 3.0        # repo says 1.0, at config.py:292
```

So the container restarted, healthily, still serving 3.0.

**The commands that worked**, both of which replace rather than refresh:

```bash
cd ~/Meander
docker compose -f docker-compose.yml -f compose.prod.yml up -d --force-recreate caddy
docker compose -f docker-compose.yml -f compose.prod.yml build api
docker compose -f docker-compose.yml -f compose.prod.yml up -d --force-recreate api
```

Recreating `caddy` re-resolves the bind mount against the current path, so the
container gets the current file. `build api` is the step this entry omitted.

**Verified after**, from this VM over the public hostname:

```
/api/health        -> 404
/api/health%0a     -> 404
/metrics           -> 404
/readyz            -> 404
/openapi.json      -> 404
/healthz           -> {"status":"ok","version":"0.1.0"}
```

and locally, `rate_limit.per_ip_refill_per_min` is now **1.0**, with
`routing.self_hosted_source: "env"` and `smoothness` still in `path_details`.

The lesson generalises past this entry: **`caddy reload` cannot detect that it
is reading a replaced file, and `--force-recreate` cannot detect that its image
is stale.** Both failure modes are silent and both present as a successful
deploy. Check the effect over the wire, never the exit code. `docs/RUNBOOK.md`
should carry the single-file bind-mount trap; Session C's C3 covers that file.

---

## 8 · ~~The saved-route store does nothing in production, and the UI says it does~~ — RESOLVED

**Resolved:** 2026-08-10, during Session C, by **option 3** — the operator's
choice. The store is re-based on the page: `frontend/src/lib/resultsStore.js`,
written by `client.js` after a completed stream. `sw.js`'s cross-origin early
return is untouched, because it was never the thing that was wrong.

What the live gate measures now, against `https://meander-eoc.pages.dev`, each
promise on its own rather than one "something was stored" check:

```
ok  nothing is saved before the user has been asked      [0 entries in 0 bucket(s)]
ok  a route is actually saved when the user consents     [1 entry at /__meander__/last-routes]
ok  the two searches are actually different requests     [114B vs 114B, differing]
ok  only the most recent set is kept, after a second search   [1 entry across 1 bucket(s)]
ok  the saved set is stamped with the time it was written [X-Meander-Cached … (4s ago)]
ok  the saved set comes back on a reload with no network
ok  the replayed set is labelled as saved, with its age, on screen
      [pill: Showing a saved copy from just now. · badge: Saved · just now]
ok  the search before it is gone, not merely hidden      [no replay, as promised]
ok  choosing "No" deletes the saved set immediately, without a reload
      [1 entry before, 0 after, 0 bucket(s) left]
```

**It stores less than the worker did**, not more, which is what let this happen
without re-opening the privacy question:

- the final payload rather than the raw stream, so no progress events and no
  duplicate routes from the two-pass enrichment;
- a SHA-256 of the request rather than the request, so no unrounded GPS fix sits
  in a cache key any script on the origin can enumerate — the worker's key was
  `url#body`;
- one entry at one fixed key, so "only the most recent" is structural rather
  than a delete-then-put two tabs can interleave.

**Retention is unchanged.** The bucket is named for the installed shell cache,
so it is versioned against the same build the worker versions itself against, a
deploy still replaces it, and `forgetResults()` still finds it by prefix. With
no shell installed there is no version to bind to and it stores nothing — which
is also why iOS does not quietly start storing (see DEPLOY.md's iOS table).

**Three shipped sentences had to change**, because they were true only while the
store was inert: `UnitsControl.jsx` ("the only things Meander keeps — never a
place, never a route"), `ReportBarrier.jsx` ("Nothing else you do in Meander is
stored"), and `README.md`'s "deleted from two independent paths" — one path now
that the worker no longer sweeps. About.jsx needed no change; everything it
promised is now true.

**Opened:** 2026-08-10, during Session B. Not caused by Session B.

`sw.js:186` returns early for any cross-origin request — the one line that
guarantees map tiles are never cached, and it is right. But this deployment sets
`VITE_API_BASE=https://meander-app.duckdns.org` while the site is served from
`https://meander-eoc.pages.dev`, so **every** API call is cross-origin and the
`/api/routes` branch at `sw.js:188` never executes. `handleRoutes`,
`storeResult`, `mayStoreResults` and the `forgetResults()` branch are all
unreachable in production.

**Measured in a real browser against the live site**, not inferred —
`frontend/scripts/live-gate.mjs` grants consent through the prefs cache exactly
as the page does, runs a route search, waits, and then counts:

```
FAIL  a route is actually saved when the user consents
      [consent granted, search completed, 0 results cache(s), nothing stored]
```

The affordance still ships. `About.jsx` renders the control unconditionally, the
tick appears when you grant consent, and the hint says: *"The last set of routes
is kept on this device, in the browser's cache store… Only the most recent one
is kept, it is always labelled with its age, and choosing 'No' deletes it
immediately."* Nothing is kept, nothing is labelled, and "No" deletes a cache
that was never written. A user who consents, walks out of signal and reloads
gets the shell and an error where the routes were.

This is the failure mode this project's own DEPLOY.md names for iOS — "A control
that does nothing is the exact dishonesty this project refuses" — arriving on the
web by a different route.

**Why this session did not fix it.** Three options, and all three are the
operator's call rather than a bug fix:

1. **Remove the control** until it works. Honest immediately, and loses a
   feature that took three commits to build.
2. **Proxy `/api/*` through Pages** so the API is same-origin again and the
   worker sees it. Needs a Pages Function; also re-opens the same-origin `/api`
   surface that `_redirects` and the build assertion were written to close, and
   would put a Cloudflare Worker in the request path for every route search.
3. **Re-base the store on the page rather than the worker** — Cache Storage or
   IndexedDB written by `client.js` after a completed stream. Keeps the feature
   and the promise, and is the largest change.

§1 of the deployment brief says to ask before touching the privacy promise, and
the consent control *is* the privacy surface: it is the only place the app asks
permission to store anything about a person. Changing it unilaterally — in
either direction — is exactly the decision that rule reserves.

**Why the entry stayed open until now.** Three options, all of them the
operator's call rather than a bug fix. The operator chose 3.

---

## 9 · ~~The address bar freezes on the search before a geolocated one~~ — RESOLVED

**Opened:** 2026-08-10, during Session C. **Not caused by Session C** — this is
`permalink.js` behaviour that predates the saved-route work. It was found by a
subagent attacking §8's store, survived an independent attempt to refute it, and
is recorded here rather than fixed because §8 was the session's scope and this
is a different file with its own test suite.

`permalink.js:147` refuses to write a device fix to the address bar:

```js
if (state.origin?.name === GEOLOCATED) return
```

That refusal is right, and `About.jsx:47-53` is built on it: *"A place taken
from your device is never written there — only a place you searched for."*

**But it returns before `replaceState`, so it does not clear what is already
there — and the guard keys on the origin, so nothing else gets written either.**
Search for a place, then press "Use my location", and the URL stays on the
abandoned place for the rest of the session. Change the minutes, change the
mode: still nothing, because the same guard runs first.

**Reproduced** with a `window` stub whose `replaceState` actually mutates
`location.search`. The existing suite's stub leaves `search: ''`, which is
exactly why this case has never been covered:

1. `writeUrl` for a named place sets `?from=51.560215,-0.163000&fromName=…`
2. `writeUrl` for a geolocated origin returns at `:147` — `location.search`
   unchanged
3. a later `writeUrl` with `minutes: 90, mode: 'bike'` also no-ops
4. `decodeState()` off that stale search returns the **old** place, and
   `App.jsx:98-107` seeds `nonce: 1`, so the fetch effect issues a request for
   the abandoned search on the next load

**Two consequences, and the second is the one that matters.**

- `About.jsx:51-52` says *"your search is kept in the address bar, so a reload
  keeps it and the link is shareable."* After a geolocated search, a reload
  restores **a different search** — the one before it. The sentence is false in
  that case, and false in the direction that surprises someone.
- It blunts §8's offline reload. A reload with no network rebuilds the request
  from the URL, and if the URL holds the wrong search, the digest cannot match
  the saved set. **The store is not what fails here** — the gate's offline
  replay passes, because it reloads a permalink that is actually current.

**What the fix probably is**, for whoever picks it up: clear the query rather
than returning, when the origin is geolocated — `replaceState` to the bare path
— and move the guard so that it suppresses only the origin rather than the whole
write. Both need a test with a `replaceState` that mutates `location.search`;
the stub that does not is why this survived.

**Not attempted here.** `permalink.js` is shared by the share button, the
permalink round-trip suite and `App.jsx`'s init, and this session was scoped to
§8.

### Resolved: 2026-08-10, the session after

`writeUrl` now writes an empty query instead of returning, so a geolocated
origin **clears** the address bar rather than declining to touch it. The refusal
was always right; returning was the bug. `About.jsx` says what clearing means —
a reload starts fresh rather than reopening the search before it — so the
sentence at `:51-52` is no longer false in either direction.

The test stub was the other half, exactly as predicted above. `replaceState` now
moves `location.search`, and the device-fix test asserts on the *content* of
every write rather than on a call count, because the count was the weaker claim
and the fix makes it the wrong one.

Proven able to fail rather than assumed: a worktree with the early return
restored, built through the same vite pipeline and served locally, fails both of
the new live-gate checks. Only `permalink.js` differs between the two runs.

```
early return restored   bar after: ?from=51.507400,-0.127800&…&min=30&mode=foot   FAIL
fix in place            bar after: (empty)                                        PASS
```

The second half of the entry below is closed too: the key now hashes the origin
snapped to a 4 dp grid with a 3×3 neighbourhood probe, so a device fix replays.
Measured 7.01–25.59 m at 51.5074 — 5 m always replays, 200 m never does.

### Also found, and deliberately not changed

**A geolocated search cannot replay after a reload, and rounding is the only way
it could.** `App.jsx:419-420` puts `position.coords` into the request body
unrounded, so a second GPS fix from the same spot is a different body, a
different SHA-256, and a miss. The saved set is still there and still deleted on
"No" — nothing about the promise is false — but the walk-out-of-signal journey
only recovers for a search that came from a link. Making it recover would mean
matching on **rounded** coordinates, which changes what "the same search" means
and would replay a saved walk for someone standing some tens of metres away.
That is a product decision about the privacy surface, not a bug fix, so it is
the operator's under §1 of the deployment brief. Recommended precision if it is
taken: 3–4 decimal places, and say so in the copy.

---

## 10 · The grid is calibrated for a precision this app does not ask for — OPEN

**Opened:** 2026-08-10, by an agent attacking the rounded cache key it had not
written. Not a defect in the arithmetic — that survived every attack — but in
the premise the arithmetic was chosen on.

`resultsStore.js` snaps the origin to a 4 dp grid and probes the eight
neighbouring squares, which gives a guaranteed match to 7 m and a far edge at
~26 m. The comment justifying that used to say two fixes from one doorstep
"differ in the sixth decimal", i.e. 0.11 m. **That is wrong about this app.**

`App.jsx:429` is the only `getCurrentPosition` feeding the origin:

```js
{ enableHighAccuracy: false, timeout: 10000, maximumAge: 60000 }
```

`enableHighAccuracy: false` is an explicit request for the wifi/cell provider
rather than GPS. That provider returns access-point and cell centroids which
step by tens of metres, not fractions of one. Measured, two independent fixes of
one standing person, 2-D Gaussian, 200k trials per cell:

| σ of one fix | 1 m | 3 m | 5 m | 8 m | 10 m | 20 m |
|---|---|---|---|---|---|---|
| London | 100% | 96.6% | 81.0% | **52.7%** | 39.1% | 12.6% |
| equator | 100% | 99.6% | 92.7% | 70.7% | 55.3% | 18.9% |
| Tromsø | 99.8% | 81.1% | 55.5% | 32.4% | 23.6% | 7.1% |

At σ = 8 m the store replays about half the time. `resultsStore.js` says of the
grid-line problem that *"a store that replayed on a coin flip would be worse
than one that never replayed, because it would look intermittent rather than
absent"* — the neighbourhood removed the coin flip caused by grid lines and left
the one caused by fix error.

**What was done:** the comment was corrected, so the file no longer claims a
jitter magnitude the app does not receive. The behaviour was not changed.

**What a human has to decide,** because all three widen what "the same spot"
means and that is a privacy decision rather than a bug fix — §1 of the
deployment brief reserves it:

1. `enableHighAccuracy: true` in `App.jsx:429`. Costs battery and a slower first
   fix; makes the existing grid fit the data.
2. A coarser `KEY_DP`, or a 5×5 probe. 5×5 takes the guaranteed match to 13.9 m
   and the far edge to 39.3 m — and 39 m is far enough that "the same spot" is
   no longer a fair description of what was matched.
3. Read `position.coords.accuracy`, which `App.jsx:414` currently discards, and
   choose the grid from it. The most honest of the three and the most code: it
   makes the match as wide as the fix deserves and no wider.

**Do not take (2) without changing the copy again.** About and the consent hint
now say "about twenty-five metres", measured.

### Two smaller things found in the same round, both left alone deliberately

**The antimeridian is a dead zone.** Two points 2 m apart either side of ±180°
longitude are 3,600,000 squares apart, so nothing on one side ever replays for
anything on the other, at any separation — measured at 2.13 m, 10.6 m, 21.3 m,
42.6 m, 106 m and 213 m, all misses, with a same-side control at 6.39 m
replaying. Same at the pole for two longitudes 180° apart. Cost of the gap is
one network request; cost of closing it is a second wrap-around rule inside the
one function that decides whether two searches are the same. Documented in
`resultsStore.js` rather than fixed.

**Above ~85° latitude the feature is off rather than degraded.** 3 m due east is
15 squares at 89°, and 15,454 at 89.999°. The existing comment covers this in
kind; it now covers it in degree.

---

## 11 · A geolocated search only replays with the controls left at their defaults — OPEN

**Opened:** 2026-08-10, by an agent tracing the end-to-end journey rather than
the module. This is the direct cost of §9's fix, and it is worth stating plainly
because it blunts the feature §10 exists to serve.

The grid forgives the origin and nothing else — deliberately, since a
destination is a geocoded place with no jitter to absorb. But `keyedRequest`
spreads the rest of the request byte-exact, and **an empty address bar carries no
minutes, mode, objectives or departure time.** So after a reload:

```
online:  tap "1 hr" → Use my location → saved at minutes: 60
offline: reload → minutes back to the default 35 → Use my location, 4 m away
expected:  the saved walk comes back
actual:    miss → "Could not reach the Meander server."
proof:     the same request with minutes: 60 replays
```

`FirstRun.jsx:56-59` offers 20 / 35 / 1 hr / 2 hr as one-tap chips directly above
"Use my location", so a non-default search is the ordinary path, not the corner.
Retry rebuilds the same defaulted request and misses again, and the user is
never told a saved walk exists — `OfflineBar` is gated on routes that have not
arrived.

**Not a regression.** Before this session the pure geolocated flow left the bar
empty too, and the byte-exact key meant it never replayed at all. The flow where
bar *content* changed is permalink-then-locate, and there the old behaviour was
the §9 defect: the controls survived only because the whole abandoned search
did, and a reload re-ran it.

**The live gate grades the case that works.** `live-gate.mjs` presses locate
without touching the dial, so its "a fix five metres away replays" check is true
and narrow. Recorded here rather than quietly left as coverage.

**What the fix probably is:** write the non-location fields to the address bar
even when the origin is a device fix — `min`, `mode`, `obj`, `at` are not
location and are already in the URL for a searched place — and teach
`decodeState`/`init` to restore them from an origin-less query **without**
seeding `nonce: 1`, so a reload rebuilds the controls and asks for nothing. That
keeps every promise §9 made: no coordinate in the bar, nothing booted on reload.
Not done here because it changes `decodeState`'s contract, which the permalink
round-trip suite pins, and this session was scoped to the two defects above.

