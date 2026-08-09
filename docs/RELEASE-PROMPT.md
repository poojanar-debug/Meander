# Meander — public release prompt

Paste everything below the line into Claude Code, from the repository root
(`~/Meander/Meander`), in a fresh session.

---

You are taking Meander to a **public, working, publicly-linkable release** on a
free hosting stack, with every feature it has ever grown actually reachable in
the shipped UI.

Read this whole brief before you start. The most important thing in it is the
next section, because the obvious mental model of this repo is wrong.

---

## 0 · The state of the world — read this first, it is not what `git log` shows

**The checked-out `main` is 84 commits behind the real head of development.**
Do not form any impression of this project from the working tree.

```
main                    = 867e8e2   ← what you will see on checkout
origin/main             = 0de9c7a   ← +26: the frontend redesign, four new
                                        features, and the first CI
feat/launch             = 534c863   ← +49 from 867e8e2: backend hardening,
                                        containers, AWS IaC, PWA, exports,
                                        real CLIP scores, coverage floor
feat/ios                = 46d4772   ← +84: contains ALL of the above, plus a
                                        reconciliation merge and 5 iOS commits
```

Three facts that follow, all verified:

- **`feat/ios` contains everything.** `feat/launch` is an ancestor of it;
  `origin/main` is an ancestor of it; `claude/code-prompt-design-handoff-b8efa1`
  is an ancestor of `origin/main`. There is nothing left unmerged.
- **`main ← feat/ios` is a fast-forward** — `main` is a strict ancestor. Zero
  conflicts. Nothing needs merging, rebasing or conflict resolution. (It will
  still refuse to run until Phase 0 clears the working tree; see there.)
- **The hard part really was hard.** `feat/launch` and `origin/main` each
  rebuilt the frontend independently from the same pre-redesign base — 247
  conflicting hunks, two incompatible design-token vocabularies, disagreement
  about what colour "Fastest" is. Commit `66eaef3` (`ios-p0`) resolved it by
  taking **main's frontend byte-for-byte and feat/launch's everything-else**,
  after both were built and screenshotted at 390×844. That decision is settled.
  **Do not reopen it.** Reversing it would cost the 247 hunks again plus 2,240
  lines of integrated redesign plus six commits on top.

**The price of that decision, and the reason this brief exists:** the merge
dropped exactly **37 files** from the launch frontend. Nine of them are
capabilities the project still advertises. Two — `/api/report-barrier` and
`Route.elevation` — are fully-built, fully-tested backend features that
**nothing in the shipped UI calls**. `BLOCKED.md` §5 tracks seven of the nine
and is the only open blocker in the file. The other two are tracked by nothing.

So the remaining work is, in order: **rescue the working tree, land it, restore
what the merge dropped, close the live defects, and put it on the internet.**

---

## 1 · Ground rules

**Read in full before writing code**, all from `feat/ios` via
`git show feat/ios:<path>`: `README.md`, `BLOCKED.md` (all of it, §5
especially), `docs/RUNBOOK.md`, `docs/adr/README.md` and `docs/adr/0001`–`0006`,
`infra/README.md`, `DEPLOY.md`, `CONTRIBUTING.md`, `docs/API.md`. `PROGRESS.md`
is 2,000+ lines; read the last 400 and grep the rest.

**Two more, and these are on disk only — they exist on no git ref at all**, so
read them with `cat`, not `git show`: `docs/CLAUDE-CODE-PROMPT.md` and
`docs/IOS-LAUNCH-PROMPT.md`. They are earlier briefs and **both are now largely
spent** — the redesign one was executed and merged, and the iOS one recommended
a frontend direction that was subsequently overruled on evidence. Read them for
context. Do not execute them. This document supersedes both. Phase 0 tells you
how to stop them being destroyed.

The constraints below are not up for renegotiation. Several are the reason the
project is worth anything:

1. **A missing OpenStreetMap tag means `UNKNOWN`, never "accessible".** A false
   step-free claim can strand a real person. This outranks shipping.
2. **Colour is never the only differentiator.** Every route identity must
   survive a greyscale screenshot.
3. **`confidenceSentence()` stays visible and stays the source of truth.**
   `VerificationMeter` sits alongside it, never instead of it.
4. **The route list is a complete text substitute for the map.** Delete the map
   element in devtools; the app must still be usable. Test it, do not assume it.
5. **Privacy is load-bearing.** No location history, no cookies, no analytics.
   `localStorage` is for theme and units only. Follow-mode position never leaves
   the browser. The repo has *three* independent guards against committing a
   `cache.db` with route history — a pre-commit hook, a build-time assertion in
   the `Dockerfile`, and `test_privacy_guard.py`. Do not weaken any of them.
6. **No new third-party runtime requests.** Fonts stay on the local stack.
7. **All interactive targets ≥ 44 × 44 px.**
8. **Do not restructure the fetch model.** The `nonce`-keyed effect in
   `App.jsx`, the per-trigger debounce map, abort-on-refetch and
   keep-previous-answer are deliberate and were arrived at by fixing real bugs.
9. **The full gate stays green at every commit.** Not at the end — every commit.
   `make check` is `lint dupes coverage test-frontend build colour infra-lint
   torch-free test-sandboxed gate` (`Makefile:127`), and that is every job CI
   runs — including the three that once lived only in CI: the suite re-run
   under `unshare -n` (`ci.yml:92`), the torch-free import check (`:110`) and
   the hard-coded-colour gate (`:167`). This paragraph used to say `check`
   omitted them and to ask for that to be fixed; it was, in `1749aa0`, and
   `Makefile:131-134` narrates the correction.

   Two of those targets *skip* rather than fail on a machine that cannot run
   them — `test-sandboxed` off Linux, `gate` without Chrome. Both print a skip
   line. Read it; a skip is not a pass.

**Say only what is true.** This codebase has an unusually honest voice — the
README withdraws a claim rather than restating it; `BLOCKED.md` §2 keeps its own
scepticism list after being closed; `infra/README.md` marks most of its own
gates UNVERIFIED and is careful to say which ones have actually been run. Match
that register. If you cannot verify something, write down that you could not.

---

## 2 · Where this is going

| piece | host | cost |
|---|---|---|
| React SPA (`frontend/dist`) | **Cloudflare Pages** — static requests free and unmetered | $0 |
| FastAPI + GraphHopper, both containers, colocated | **Oracle Cloud Always Free**, `VM.Standard.A1.Flex`, 2 OCPU / 12 GB ARM, Ubuntu 24.04 | $0 |
| Route/segment cache | the committed `data/cache.db` (146 pre-warmed CLIP segments) | $0 |

**This is a much smaller job than it looks**, because `docker-compose.yml`,
`Dockerfile` and `graphhopper/Dockerfile` already exist, already default to
ARM64 with the Graviton rationale written into the header, and have already been
verified end-to-end under compose on a laptop. What is missing is TLS, the
public-VM hardening, and the Cloudflare Pages side.

**About the AWS stack.** `infra/` holds four CloudFormation templates
provisioning ECR, a VPC, ECS Fargate, an ALB and CloudFront. They are complete,
`cfn-lint` clean, and **have never been applied**. They cost **~$108/month**, of
which **~$50 is pure infrastructure tax** — a NAT gateway at $32 (more than the
API it serves) and an ALB at $18 (about as much as everything it balances).
`infra/README.md:132-153` says as much about itself, honestly. **Leave them
exactly as they are.** Do not apply them, do not delete them, do not "fix" them.
They are a portfolio artifact and a documented alternative.

⚠ **`docs/adr/0004-ecs-fargate.md` explicitly rejected the shape you are about
to build** — it is titled "ECS Fargate rather than App Runner, Lambda **or a
VM**", and `:39-43` rejects "a single EC2 instance with docker compose". This
repo keeps ADRs seriously. **Act V writes ADR 0007 superseding it**, with the
honest reason (cost, for a student project that has to run for free), and marks
0004 superseded rather than wrong. Do not just leave the contradiction sitting
in `docs/adr/`.

Three Oracle risks to handle explicitly, not discover:

- **`Out of host capacity`** on A1 shapes is common and long-standing. Script
  the retry across availability domains. If it has not come up after an hour,
  stop and tell Poojana; the fallback is a Hetzner CX23 at €4.49/month, 2 vCPU /
  4 GB, same compose file, not revocable.
- **Idle reclamation** needs CPU *and* network *and* memory all under 20% p95
  over 7 days. A JVM holding a 3 GB heap already clears the memory bar. Add an
  uptime ping anyway.
- **Oracle halved this tier on 15 June 2026 with no announcement.** Treat it as
  revocable. Everything must be reproducible from scripts in the repo.

---

## 3 · How to work

**Commits.** An explicit requirement: the history must read as a development
story. The existing history already does this well — go and read it. Subjects
are lowercase, conventional-prefixed, and say *why* rather than *what*:

```
fix(map): jump rather than fly when the page is hidden
fix(nature): honour the duration cap, and never label a route green when it is not
merge: the launch backend under the redesign frontend
fix(coverage): stop telling Paris to move the start a little
```

- **3–8 commits per phase**, not one. Every logical step is a commit.
- Body text wherever the reasoning is not obvious from the diff — especially
  when you fix something that looked deliberate.
- **Never rewrite history, never squash, never force-push.** The 84 commits you
  are about to inherit are the point.
- Push after every phase so the history appears incrementally.
- Work on `main` after Phase 1.
- Tag `v1.0.0-rc1` when the dropped capabilities are back, `v1.0.0` at release.

**`PROGRESS.md`** is the build log, 2,000+ lines, first-person, honest about what
did not work and specific about numbers. Append in that voice at the end of every
phase. Its last entries record a load test whose first run reported "p50 0.00 s /
p95 9.81 s — not a distribution but two", and then explained why. That is the
register.

**`BLOCKED.md`** is for what genuinely needs a human. §5 is open and this brief
closes most of it. New blockers get the existing format — what you tried, the
exact error, what the human must do, the exact command — then move to work that
is not blocked. Do not stall.

**Ask before:** changing `models.py` or `accessibility.py` semantics; spending
money; adding a runtime dependency to `requirements-deploy.txt`; reopening the
`66eaef3` frontend decision; anything touching an accessibility claim or the
privacy promise. Otherwise decide, proceed, and write down what you decided.

---

# ACT I — Rescue the tree, then land the work

## Phase 0 · Do not lose anything, and do not commit a coordinate

The working tree is dirty, it contains **119 KB of content that exists on no git
ref**, and `data/cache.db` on disk is **currently carrying route history**. Do
this first, carefully, before touching git history.

1. **Preserve the three unique documents.** Four `docs/` files are untracked:
   `DESIGN-HANDOFF.md`, `CLAUDE-CODE-PROMPT.md`, `IOS-LAUNCH-PROMPT.md`,
   `design-mockup.html`. **Only `DESIGN-HANDOFF.md` exists on a ref** (`f8cf3d9`
   on `origin/main`). The other three — 119 KB including both briefs §1 tells
   you to read — exist **nowhere in git**. Copy all four somewhere safe outside
   the repo *now*. Commit the three unique ones to `main` after the
   fast-forward; they are project history and belong in the repo.
2. **`data/cache.db` on disk is not the committed one.** Check it with
   `python3 scripts/scrub_cache_db.py --check --worktree` — note **`--worktree`**;
   without it the script inspects the *staged blob*, which is clean, and you get
   a false pass. As of writing, the on-disk file has **17 `route_cache` rows and
   0 `segment_scores`**: it has gained route history and lost all 146 pre-warmed
   CLIP scores. Scrub it, then `git restore --source=HEAD -- data/cache.db`.
   `git checkout --` does *not* reliably undo this; `PROGRESS.md` records that
   lesson being learned the hard way, and `make scrub` is the supported path.
3. **Do not commit the ~71 untracked fixtures.** `fixtures/graphhopper/*.json`,
   `fixtures/open_meteo/*.json`, `fixtures/overpass/*.json` were written by the
   *old* code with `MEANDER_FIXTURES=live`, before `70891eb` stopped production
   writing a fixture per upstream call. Spot-check one: un-rounded `[lon, lat]`
   at 14 decimal places. Move them out of the repo or delete them.
4. **Three tracked fixtures are modified**:
   `fixtures/nominatim/{479a731b3ccbadc0,71a3db6150e3b153,9135d7541e49b153}.json`.
   They differ only in a recording timestamp and are identical between `main`
   and `feat/ios`, so they will not block anything — but check them rather than
   assume, since the gate for this phase is "nothing containing a coordinate
   enters git".
5. **Stop it recurring.** `70891eb` fixes the production write path, but the
   fixture directories are tracked and any `record_fixtures` run or any older
   checkout reproduces the spill. Add a fourth guard alongside the three that
   exist — a pre-commit check that refuses a fixture whose coordinates carry
   more precision than the cache key rounds to, or at minimum a `CONTRIBUTING.md`
   section. Given the privacy claim is load-bearing, prefer the guard.
6. **Install the hooks.** `scripts/install-hooks.sh` is **not automatic on
   clone**, and the repo has already leaked a `cache.db` once for exactly that
   reason. Run it, and check whether `CONTRIBUTING.md` tells a new contributor
   to.
7. Gitignore the `.fuse_hidden*` pattern in `data/` (there are four).

*Commits: 3–4. Nothing in them contains a coordinate.*

## Phase 1 · Fast-forward, then verify you actually have what you think

1. `git fetch --all --tags`
2. **Clear the two things that will abort the merge.** `main ← feat/ios` is a
   true fast-forward, but git refuses while (a) untracked
   `docs/DESIGN-HANDOFF.md` would be overwritten by a tracked file, and (b)
   `data/cache.db` is locally modified. Phase 0 handles (b); move (a) aside.
   Then `git checkout main && git merge --ff-only feat/ios`.
3. Push `main`. Push the tags. Commit the three rescued documents.
4. **Now verify the tree, because a clean merge is not a working tree.**
   `66eaef3` found three things git merged cleanly and *wrongly*, none of which
   showed as a conflict: two `class Step` in `models.py`, two
   `_parse_instructions` in `routing.py`, two `steps=` kwargs in one `Route(...)`
   call. They were caught by `compileall` and a duplicate-definition scan, not by
   tests. Re-run both and add the duplicate-definition scan to CI — it is the
   check that catches a whole class of silent merge damage.
5. Run the full gate. **Record the real numbers.** `README.md:46` claims 632
   backend tests; `PROGRESS.md`'s last two entries record 640 then 645. Coverage
   is quoted as 87.55% in the README and 87.52% in `66eaef3`'s own measured
   block, and 13 tests have landed since either. Whatever the run actually
   prints is the number you quote from here on, and the number you correct the
   README to.
6. Bring the graph up and route a real request end to end under compose, per
   `docs/RUNBOOK.md`. Confirm `/api/health` reports `self_hosted_source: "env"`
   and `smoothness` in `path_details` — those two prove the accessible preset
   can actually exclude impassable ways.

*Commits: 3–5.*

---

# ACT II — Restore what the merge dropped

This is the "all the features, new and old, actually working" part of the job.
Nine capabilities exist on `feat/launch`, are gone from the shipped frontend, and
are still advertised by the README or backed by live backend endpoints.

**They must be wired into this frontend, not copied next to it.** `BLOCKED.md`
§5 is emphatic about that and it is right — the two frontends have disjoint
component trees and incompatible token vocabularies. Read the launch version with
`git show feat/launch:<path>`, understand it, then write it against
`TripBar`/`RouteRail`/`RouteDetail` and the current tokens. Do not restore
`--space-*`, `--text-*`, `--ink: #14213d` or the launch route palette; the
current `--s1..--s8`, `--t-*` and dark-green palette win.

Order matters: the two untracked regressions come first, because they are the
only cases where a shipped backend feature currently does nothing at all.

## Phase 2 · The two nobody is tracking

1. **`ReportBarrier`** — `POST /api/report-barrier` is live
   (`backend/main.py:1211`), locked to the OSM dev server, with ~16 tests behind
   it (`test_barrier_reporting.py` 12 + `test_streaming_and_reporting.py` 4), and
   **no UI calls it**. Port `feat/launch:frontend/src/components/ReportBarrier.jsx`
   (157 lines) into `RouteDetail`. It needs `OSM_DEV_TOKEN`, currently empty —
   the feature must degrade honestly when it is absent, not present a form that
   silently fails.
2. **`ElevationProfile`** — `Route.elevation` is populated on every response
   (`backend/main.py:556-558`, `backend/elevation.py`, 12 tests) and **no UI
   reads it**. Port `feat/launch:frontend/src/components/ElevationProfile.jsx`.
   It shades the stretches that break the same 8% gradient limit
   `accessibility.py` rejects on, importing the constant rather than restating
   it. Keep that property.

## Phase 3 · Safe areas and units

3. **`env(safe-area-inset-*)`** — the current `styles.css` has none at all. The
   launch version declares `--safe-top/right/bottom/left` at
   `feat/launch:frontend/src/styles.css:96-101` and consumes them at `:301-303`,
   `:457`, `:478`, `:512-513`, `:520-521`, `:585-586`, `:595-596`, `:1022`. Port
   the concept into this frontend's topbar, panel and footer. Headless Chrome at
   390×844 reports zero insets, so **this cannot be verified in CI** — verify it
   on a real iPhone in Safari and say in `PROGRESS.md` that that is how.
4. **`lib/units.js`** (159 lines) + `UnitsControl` — miles and a 12-hour clock,
   defaulted from the locale. This is the second permitted `localStorage` key.
   Every distance and time in `RouteRow`, `RouteDetail`, `StepList` and
   `DepartureStrip` goes through it.

## Phase 4 · Share and export

5. **`lib/permalink.js`** (135 lines) + `ShareButton` — encode the whole request
   in the URL, decode on load. `check-permalink.mjs` came with it; bring that
   back too (Phase 6). ⚠ This depends on Phase 11's SPA rewrite being scoped
   correctly — a bare catch-all breaks it in a way that looks like a frontend bug.
6. **`lib/export.js`** — GPX 1.1 (as `<trk>`, not `<rte>`), GeoJSON with each
   barrier as its own feature, Google/Apple Maps handoff URLs, a print sheet.
   **Keep `provenanceNote`**: the accessibility caveat travels with the exported
   file. A GPX that leaves the app without its confidence sentence attached is
   exactly the failure mode rule 1 exists to prevent.

## Phase 5 · Offline, icons, manifest

7. **`lib/offline.js`** (161) **+ `lib/offlineStore.js`** (170) **+ `sw.js`**
   (290) + `OfflineBar` / `OfflineControl` / `TakeItWithYou`. The README
   currently *withdraws* the offline claim rather than restating it — "It no
   longer installs or opens offline, and that is a regression this tree owns."
   Close that.
   - Three caches: the shell always; **results only on explicit consent**;
     preferences unversioned.
   - **Map tiles are never cached** — "a tile cache is a record of where you
     have been." Keep that comment.
   - Saved routes are labelled with their age everywhere they appear, and a
     saved departure time expires.
8. **`frontend/public/`** — it does not exist on this branch. Restore the 5
   icons + `manifest.webmanifest`, and `make-icons.mjs` that generates them.
   `index.html` currently has no favicon, no manifest link, no apple-touch-icon.

## Phase 6 · Put the gates back — and this is not plumbing

Five frontend quality gates existed on `feat/launch`; **all five were dropped as
files.** What survives is the palette *check*, re-implemented as inline `awk` at
`ci.yml:160`. And the CI knows about neither the loss nor the gap:
`.github/workflows/deploy.yml:54-55` still asserts that `npm run build` runs
`check:palette`, `check:permalink` and `check:offline`. On this branch `build` is
bare `vite build`. **A deploy workflow that believes in three gates it does not
have is worse than one with none.**

- **`scripts/gate.mjs`** (254 lines, 14 checks: 6 per theme × 2 + 2 desktop) —
  no vertical scroll at 390×844, no sideways overflow at 320, axe-core zero
  violations across wcag2a/2aa/21a/21aa, 44×44 targets, all repeated in dark.
  ⚠ **This is a rewrite, not a port.** It selects on `.row__button`,
  `.sheet__handle` and `.sheet__scroll` — **none of which exist anywhere in this
  frontend.** Half its checks would find zero elements and pass vacuously, which
  is precisely the objection §5 raises against `pwa-gate.mjs`: a gate that
  cannot fail reads as coverage. Re-target every selector at the real component
  tree, and assert the selectors match something before asserting anything about
  them.
- **`check-permalink.mjs`** and **`check-offline.mjs`** return with the features
  they check, in Phases 4 and 5.
- **`pwa-gate.mjs`** (544 lines) — bring it back for the *web* release. §5
  excludes it on iOS grounds, and that reasoning is right *for iOS*. This is a
  web release; the service worker is real here, so the gate can fail, so it
  earns its place.
- **`axe-core` is a devDependency nothing runs.** Its only consumer is the
  manual `frontend/a11y.html` harness, which is not even in the Vite build
  inputs. Script it or remove the dependency.
- Fix `deploy.yml:54-55` to describe what actually runs.
- `ci.yml:33` notes that a branch with no open PR gets no CI — which is why
  `feat/ios` went 84 commits without one. Decide whether that trade still holds
  now that everything lands on `main`.

**Gate for Act II:** every capability the README claims is reachable in the
shipped UI. `git grep` for each backend endpoint and each `models.py` response
field and confirm something in `frontend/src` consumes it. Then update
`BLOCKED.md` §5 — close what closed, and add the two items it never tracked.

**Tag `v1.0.0-rc1`.**

---

# ACT III — Close the live defects

Six things are actually wrong on `feat/ios`. Each gets a fix and a test.

1. **`MEANDER_STRICT_STARTUP=1` refuses to boot without `MAPILLARY_TOKEN` or
   `ANTHROPIC_API_KEY`.** `backend/main.py:124` calls `settings.missing_keys()`
   — the *completeness* list — where it should call `missing_required_keys()`
   (`backend/config.py:283`), whose own docstring says neither key is needed to
   serve routes. `.env.example:75` tells you to set strict startup in production
   and `infra/20-services.yaml:272` does. **Highest-impact defect for a fresh
   deploy.** Keep the completeness list for `/api/health`; boot on the required
   list.

2. **⭐ `MEANDER_DAILY_ROUTE_CEILING` is 120 routed requests per UTC day,
   globally, for everybody.** `backend/config.py:260`/`:349`, enforced
   unconditionally at `backend/ratelimit.py:101-110` with *"Meander has used up
   its routing allowance for today. It runs on a free tier with a fixed daily
   quota."* `.env.example:77` justifies it as staying under the **hosted
   GraphHopper** quota — a rationale that **evaporates entirely once the router
   is self-hosted**, which it now is. A publicly-linkable release that stops
   answering for everyone after 120 requests is the single largest functional
   gap in this whole plan. Raise it to something that reflects what the VM can
   actually serve, keep a ceiling (it is a real DoS guard), and rewrite the
   `.env.example` comment to say what it is now protecting. Note the per-service
   live-call budgets are fine — `config.py:142-152` already skips them in live
   mode.

3. **An empty `MEANDER_ALLOWED_ORIGINS` allowlists the Vite dev server in
   production.** `backend/config.py:322` —
   `_env_flag("MEANDER_ALLOW_LOCAL_ORIGINS", not origins)` defaults to `True`
   when the list is empty. Found during the iOS work and fixed *at the
   infrastructure layer only*, by giving the CloudFormation parameter a
   non-empty default — a fix a compose deploy does not inherit. Worse,
   `docker-compose.yml:51-52` ships the unsafe pair explicitly, and that is the
   file most likely to be copied onto the VM.
   ⚠ **This is not a one-line change, and the brief you are reading previously
   understated it.** Four tests depend on the current behaviour, because
   `backend/tests/conftest.py` never sets `MEANDER_ALLOWED_ORIGINS`:
   `test_client_ip_and_cors.py:105-112`, `:115-121`, `:205-221`, `:292-309`. The
   one at `:115` is titled *"Local development must need no configuration at
   all"* — that is a **deliberately pinned design property**, not an oversight.
   So decide the replacement first: either `conftest.py` sets an origin and the
   dev default goes away, or the default keys off something explicit
   (`MEANDER_ENV`, or the presence of `MEANDER_FIXTURES=live`). Whichever you
   pick, change the tests *with* the behaviour and say in the commit body which
   property you traded and why. Do not just flip the default and delete the
   failing tests.

4. **`.env.example` is wrong and incomplete.** Line 71 claims localhost is
   "always allowed in addition", which stopped being true. Eight variables the
   code reads are undocumented: `MEANDER_ALLOW_LOCAL_ORIGINS`,
   `MEANDER_TRUSTED_PROXY_HOPS`, `MEANDER_CACHE_DB`, `MEANDER_DRAIN_TIMEOUT_S`,
   `MEANDER_HTTP_TIMEOUT_S`, `MEANDER_HTTP_CONNECT_TIMEOUT_S`,
   `MEANDER_REQUEST_DEADLINE_S`, `MEANDER_PATH_DETAILS`. The first three are
   precisely the ones a single-VM deploy depends on.

5. **Stale README claims.** `:46` on the test count and coverage. `:52-56` says
   verification ran "at four points, one per imported region" — under the default
   `demo` region set it is three, and `PROGRESS.md:2010-2013` records exactly
   that.

6. **`data/cache.db` has 27 of its 146 segments recorded with a NULL score.**
   That is correct behaviour — too little imagery is recorded as *no score*, not
   a low one — but check the UI renders three states distinctly: a real score, a
   null score, and a route that was never scored. A hatched track for `null`
   exists in the design system; confirm it fires.

**Do not "fix" these — they are deliberate and documented:**

- uvicorn runs with **no `--workers`** (`Dockerfile:74-75`): the rate limiter,
  daily ceiling, metrics and route cache are all per-process.
- the route cache is **wiped on every container rebuild** (no volume, for
  privacy).
- **`scripts/verify_selfhosted.py:60` lists Edinburgh**, which is outside the
  demo extract. The comment at `:43-55` already explains it, `46d4772` added
  skip-and-name handling, and `PROGRESS.md:2018-2021` records the decision to
  document rather than silently fix. Leave it.
- **`MEANDER_HTTP_TIMEOUT_S` already defaults to 20** (`config.py:218`). The 12 s
  figure in `infra/20-services.yaml:288` describes the *old* default.
- **18 of the 87 committed GraphHopper fixtures are synthetic** and stay that
  way; the other 69 are `recorded`. The rule is about the synthetic subset, not
  the whole directory.

---

# ACT IV — Put it on the internet

## Phase 8 · A compose file for a public machine

`docker-compose.yml` was written for a laptop — its own header says "Local
development: API + router + frontend, one command", and `make compose-up` and
the RUNBOOK both depend on that. **So split it: keep `docker-compose.yml` as the
laptop file and add `compose.prod.yml` as an override.** Do not turn the
development file into a production one; that breaks `make compose-up`, the
RUNBOOK and DEPLOY.md in one edit.

The production overlay does six things:

1. **Drop the `frontend` service.** It is `node:22-slim` running `npm run dev` —
   a Vite dev server. Cloudflare Pages hosts the build. Drop the
   `frontend_node_modules` volume with it. Also remove `VITE_API_PROXY_TARGET`
   from the dev file entirely: `vite.config.js` hard-codes the proxy target and
   reads no such variable, so it is dead config that reads as live.
2. **Stop publishing the API on `0.0.0.0`.** `"8000:8000"` →
   `"127.0.0.1:8000:8000"`. On a public VM the current setting puts an
   unauthenticated API straight on the internet, past any proxy and any
   Cloudflare rate limit. **Keep GraphHopper unpublished** — it is
   unauthenticated and compute-unbounded, and on a single VM the compose network
   is the only boundary there is. Verify with `docker compose ps`, not by
   reading the file.
3. **Add TLS, with explicit path matchers.** Nothing terminates TLS anywhere in
   the repo, and a Pages frontend on HTTPS calling `http://<ip>:8000` is blocked
   as mixed content. Add Caddy. Two things it must get right:
   - **It must not buffer.** `/api/routes` is SSE and `backend/main.py:997` sets
     `X-Accel-Buffering: no` for exactly this. Caddy streams by default; nginx
     would need `proxy_buffering off`.
   - **Route by path, not with a catch-all.** `/metrics`, `/healthz` and
     `/readyz` are **not** under `/api`, and `backend/main.py:1268-1270`
     documents `/metrics` as deliberately unauthenticated on the assumption it
     is only reachable from inside the network: *"Scrape it from inside the VPC;
     the load balancer has no rule that reaches it from outside."* A bare
     `reverse_proxy` publishes it. Proxy `/api/*` publicly; expose `/healthz`
     only to the uptime ping (or bind it to localhost and have the ping run on
     the VM); do not expose `/metrics` at all.
   Two hostname options, **ask Poojana which**:
   - *A domain on Cloudflare* (~$10/yr) plus a Cloudflare Tunnel from the VM —
     no inbound ports at all, automatic TLS, API on a subdomain of the site.
   - *DuckDNS plus Caddy's DNS-01 challenge* — $0, scruffier hostname.
4. **Set the environment properly.** `MEANDER_ALLOWED_ORIGINS` to the Pages
   origin — **and see Phase 11 about preview deployments, because this is an
   exact-string allowlist** (`test_client_ip_and_cors.py:160-164` pins that);
   `MEANDER_ALLOW_LOCAL_ORIGINS=0`; `MEANDER_TRUSTED_PROXY_HOPS` to the real hop
   count (1 behind Caddy alone, 2 behind Cloudflare *and* Caddy — left at 0,
   every client on earth shares one 12-token bucket and the app self-DoSes);
   `MEANDER_DAILY_ROUTE_CEILING` to the value decided in Act III defect 2;
   `MEANDER_FIXTURES=live`. **Leave `MEANDER_CACHE_DB` unset** — setting it
   points the API away from the baked-in pre-warmed scores and every route
   silently drops to `geometry_only`.
5. **Add resource limits.** There are none. Measured: the router serves the demo
   graph at 1,051–1,073 MB RSS with `GH_HEAP=3g`. `mem_limit: 5g` on the router,
   ~1g on the API. That leaves ~6 GB of the VM free.
6. **Restart policies and healthchecks are already right** — `unless-stopped` on
   both, `api` waits on `service_healthy`, `start_period: 120s` for graph load.
   Leave them.

## Phase 9 · The graph

1. Use the **`demo` region set** — three bbox'd extracts (Sri Lanka, Greater
   London, Noord-Holland, ±0.5° ≈ 55 km each). Recorded: 346 MB merged extract →
   **485 MB graph** with CH removed (ADR 0006). Import time appears in the repo
   three times — 96 s with CH, 58 s without (`graphhopper/config.yml:31-36`), and
   71 s for the actual demo build (`PROGRESS.md:2005`). Expect roughly a minute;
   measure yours and record it. Cold start 1.1 s, first route 44 ms. The
   `countries` set is 6.6 GB, ~31 minutes and a **20 GB serve heap** — it will
   not fit on this VM. Do not try it.
2. **Override the heaps before running `setup`.** `scripts/graphhopper.sh:61-62`
   defaults to `GH_IMPORT_HEAP=24g` and `GH_HEAP=20g`, sized for `countries`.
   These are `-Xmx` ceilings with `-Xms` at 4g/2g, so the JVM will *start*
   fine — the failure is subtler and worse: it will happily consume far more of
   the VM than you intended, and the script's own comment at `:53-56` notes that
   OOM tends to arrive *after* a successful import, "a confusing place to fail".
   Export `GH_IMPORT_HEAP=8g` and `GH_HEAP=3g`. While in there, change the
   *defaults* to the demo numbers and move the `countries` figures into the
   comment — the current defaults are a trap the script apologises for.
3. `setup` needs **JDK 21, osmium-tool and curl on the host** — none are in any
   container, and this is the one part of the pipeline that is not containerised.
   Import on the VM (12 GB is ample for a 346 MB extract with an 8 GB heap)
   rather than rsyncing gigabytes from a laptop.
4. `scripts/publish_graph.sh --local`, then a **BuildKit** build with
   `GRAPH_SOURCE=local`. BuildKit is required — the classic builder walks every
   stage and would copy the graph even when the build asked for none. Ubuntu's
   packaged `docker.io` may not default to it; use `docker buildx` or
   `DOCKER_BUILDKIT=1`. Confirm the image lands near 1.2 GB, not 2.65 GB — the
   `graphhopper/Dockerfile` header documents the three-copies-of-the-graph bug
   that produced the larger number.
5. Document the coverage boundary: 55 km boxes mean a 6-hour car budget (≈198 km
   at the conservative 550 m/min) falls outside coverage. `backend/coverage.py`
   says "Meander does not cover that area yet" rather than "try moving the start
   a little" — verify that path fires, since it was a live defect as recently as
   `3872ca7`.

## Phase 10 · The VM

1. Oracle Cloud → `VM.Standard.A1.Flex`, 2 OCPU / 12 GB, **Ubuntu 24.04 ARM**
   (not Oracle Linux — its firewalld defaults are a time sink).
2. **Two firewall layers will bite you**: the VCN security list *and* the
   instance's own iptables. Open 80/443 in both, or neither, depending on whether
   you chose the tunnel.
3. **Write `scripts/provision-vm.sh`** — it does not exist yet. A comment for
   every step that has to happen in the Oracle console. Assume the tier gets
   reclaimed and this has to be re-run from scratch.
4. Uptime ping against idle reclamation, plus an external monitor. Point it at
   `/healthz`, and make sure Phase 8.3's path matchers actually let it through.

## Phase 11 · Cloudflare Pages

The frontend is **not Pages-ready** — five concrete gaps:

1. **`frontend/public/` does not exist.** Phase 5 creates it.
2. **No `_headers`, no `_redirects`.** What exists is `frontend/vercel.json` and
   a byte-identical copy in `docs/legacy/`, and **Pages ignores both**.
3. **⚠ The SPA rewrite must exclude `/api/*`.** Do **not** write a bare
   `/* /index.html 200`. `vercel.json:8` deliberately scopes its rewrite; a
   catch-all turns any same-origin `/api` call into **200 with an HTML body**,
   and `frontend/src/api/client.js:89-90` then calls `res.json()` on it and
   throws a raw `SyntaxError` straight into the error banner. (On a genuine 404
   the client handles it correctly via `toApiError` at `:62-64` — the catch-all
   is what breaks it.) This also breaks Phase 4's permalinks in a way that looks
   like a frontend bug.
4. **The CSP contains a literal placeholder** —
   `https://REPLACE-WITH-YOUR-RENDER-HOST.onrender.com` in `connect-src`. Port
   the whole policy into `_headers` with the real API host substituted, and keep
   `https://tiles.openfreemap.org` in both `img-src` and `connect-src`. There is
   no `<meta http-equiv>` fallback in `index.html`, so without `_headers` there
   is no CSP at all.
5. **`VITE_API_BASE` must be set at Pages build time**, and **preview
   deployments each get their own `*.pages.dev` hostname.**
   `MEANDER_ALLOWED_ORIGINS` is an exact opaque-string allowlist — no wildcards.
   Decide now: either previews point at the same API and you accept that CORS
   will reject them, or previews build against a mock, or you add a
   pattern-matching origin check to the backend. **Write the decision down**;
   silently-broken previews are how this bites later.

`docs/legacy/README.md:18-19` warns that this two-host CORS/CSP loop was "the
split deployment's most error-prone step — the site stayed broken until *both*
edits were made". Pages + VM reintroduces exactly that topology, which is
precisely what the AWS single-distribution design existed to avoid. Write the
two edits as one checklist item, not two.

## Phase 12 · Prove it

- `curl` the health endpoint; then make the same request **from the deployed
  site in a browser**. curl does not enforce CORS and that is the classic false
  pass.
- Three genuinely different route geometries. `smoothness` in path details.
  `scoring_method: "clip"` on a pre-warmed segment. No `placeholder`, no
  `synthetic_upstream`.
- **SSE actually streams** — watch the network panel for progressive events, not
  one buffered blob at the end. This is what a badly-configured proxy breaks and
  it will present as "the app is just slow".
- `/metrics` is **not** reachable from the public internet. `/healthz` is
  reachable by the monitor and nothing else.
- The whole Act II feature list, on the live site, on a real phone.
- Rewrite `DEPLOY.md` for this deployment. Keep its "Things that will look like
  bugs and are not" table — 15 rows and excellent — and grow it: A1 capacity
  errors, both firewall layers, BuildKit, the heap defaults, the `_headers` CSP,
  mixed content, `MEANDER_TRUSTED_PROXY_HOPS`, the SPA rewrite excluding `/api`.
- Update `README.md`: live URL at the top, and "**What is deployed: Nothing**"
  finally stops being true.

**Tag `v1.0.0`.**

---

# ACT V — Release

## Phase 13 · The hostile audit

`PROGRESS.md` records a previous hostile self-audit that found seven defects.
Do it again, harder, and assume that one was too kind.

1. **Verify every claim in `README.md`, `DEPLOY.md` and `docs/API.md` against
   the running instance**, not against the source. Anything you cannot verify
   comes out or gets a hedge.
2. **Real phone, real cellular.** Portrait and landscape, light and dark, safe
   areas, offline install. Everything about the mobile layout has so far been
   measured in headless Chrome at 390×844, and the README says so.
3. **Kill each upstream in turn** — GraphHopper, Overpass, Open-Meteo, Nominatim
   — and confirm the *UI* degrades honestly. The backend has tests for this; the
   frontend end of it is untested.
4. **Load test.** `scripts/load_test.py` exists; its usage is
   `--users 10 --requests 50`, and the recorded p50 3.48 s / p95 5.36 s run was
   exactly that, from one address, with the limiter raised. ⚠ It **refuses a
   non-local URL without `--i-mean-it`** and warns that a run against a
   deployment spends real upstream quota — with `MEANDER_FIXTURES=live` those 50
   requests are 50 real Overpass and Open-Meteo calls charged against the daily
   ceiling. Plan the run; do not fire it casually. Get the VM's numbers into
   `PROGRESS.md`.
5. **Grep for anything that could carry a coordinate** into a log line, a
   fixture, an outbound request or the committed database. Run all four privacy
   guards (three existing plus the one Phase 0 adds). The claim is load-bearing.
6. Full gate: the CI matrix, plus the restored browser gates, plus axe in both
   themes at three widths, plus no horizontal overflow at
   320/390/768/1024/1440/1920, plus greyscale, plus map-deleted.
7. Write it up in `PROGRESS.md` — including what you found and did **not** fix,
   and why.

## Phase 14 · Release

1. **Write `docs/adr/0007-single-vm-over-fargate.md`**, superseding ADR 0004.
   State the real reason — ~$108/month against a student budget for a project
   that must run at $0 — and what was given up: no managed rollback, no
   autoscaling, one machine, a revocable free tier. Mark 0004 superseded in
   `docs/adr/README.md`, not deleted. Add the corresponding paragraph to
   `infra/README.md` so the templates explain their own unapplied status.
2. `README.md`: live URL, a short GIF, honest status. **Keep the scepticism
   section at `:394-412` intact** — the prompt pair measures aesthetic appeal
   rather than greenery, the evidence is four to six images per location, two at
   Viharamahadevi. That paragraph is the most credible thing in the document.
3. `BLOCKED.md`: close §5 with what came back and what did not.
4. GitHub description, topics, About panel. A real release note on `v1.0.0`:
   what it does, what it does not, what is honest about it.
5. Final `PROGRESS.md` entry: total commits, test count, coverage, and the
   running cost — **$0/month**, which is worth saying out loud.

---

## The standing done-bar

Every phase, not just the last:

- [ ] The full gate green — `make check` **plus** the three CI-only jobs
      (`unshare -n`, torch-free import, hard-coded colour). Quote real numbers.
- [ ] The restored browser gates green, with their selectors verified to match
      something before they assert anything
- [ ] axe-core: 0 violations at light desktop, dark desktop, 390 px
- [ ] Full keyboard pass, visible focus ring, map controls last in tab order
- [ ] No horizontal overflow at 320 / 390 / 768 / 1024 / 1440 / 1920
- [ ] Delete the map element in devtools — app still fully usable
- [ ] Greyscale the screenshot — every route still distinguishable
- [ ] No new third-party runtime request
- [ ] No coordinate in any log, fixture, outbound request, or `data/cache.db`
- [ ] `PROGRESS.md` updated in its existing voice
- [ ] Committed and pushed

---

## Appendix A · The nine dropped capabilities

Seven are tracked in `BLOCKED.md` §5. Two are tracked by nothing.

| # | what | on `feat/launch` | why it matters | tracked? |
|---|---|---|---|---|
| 1 | `ReportBarrier.jsx` | `frontend/src/components/ReportBarrier.jsx`, 157 lines | `POST /api/report-barrier` is live with ~16 tests and no caller | **no** |
| 2 | `ElevationProfile.jsx` | `frontend/src/components/ElevationProfile.jsx` | `Route.elevation` on every response, 12 tests, no reader | **no** |
| 3 | `env(safe-area-inset-*)` | `styles.css:96-101`, consumed in 9 places | this frontend has none; notch and home indicator unhandled | §5 |
| 4 | `lib/units.js` + `UnitsControl` | 159 lines | miles and 12-hour clock from locale | §5 |
| 5 | `lib/permalink.js` + `ShareButton` | 135 lines | share and deep-link the whole request | §5 |
| 6 | `lib/export.js` | — | GPX/GeoJSON/maps handoff/print, with `provenanceNote` | §5 |
| 7 | `lib/offline.js` 161 + `offlineStore.js` 170 + `sw.js` 290 | three files | the README currently *withdraws* the offline claim | §5 |
| 8 | `public/` icons + `manifest.webmanifest` | 6 files + `make-icons.mjs` | no favicon, no manifest, no apple-touch-icon today | §5 |
| 9 | `scripts/gate.mjs` | 254 lines, 14 checks | the frontend's main automated layout/a11y gate | §5 |

Also dropped and worth a look before you decide: `BetterLater.jsx` (renders
`best_departure` **with** expiry handling that `DepartureStrip` lacks),
`TrustSignal.jsx` + `trustTier()` (a second take on `VerificationMeter`),
`BlockedRouteCard.jsx`, `lib/media.js`, `pwa-gate.mjs` (544 lines),
`check-permalink.mjs`, `check-offline.mjs`, `check-palette.mjs`.

## Appendix B · The live defect register on `feat/ios`

| # | where | what |
|---|---|---|
| 1 | `backend/main.py:124` | strict startup uses `missing_keys()` not `missing_required_keys()` → boot loop without optional keys |
| 2 | `backend/config.py:260`, `ratelimit.py:101-110` | **120 routed requests per day, globally**, justified by a hosted-GraphHopper quota that no longer applies |
| 3 | `backend/config.py:322` | empty `MEANDER_ALLOWED_ORIGINS` allowlists the Vite dev server; `docker-compose.yml:51-52` ships the unsafe pair; 4 tests pin the current behaviour |
| 4 | `.env.example:71` + omissions | one wrong claim; 8 undocumented variables, 3 of which a VM deploy depends on |
| 5 | `README.md:46`, `:52-56` | test count and coverage stale; "four verification points" is three under the demo set |
| 6 | `.github/workflows/deploy.yml:54-55` | asserts three frontend gates that no longer exist |
| 7 | `Makefile:127` | ~~claims `check` "is the whole of CI now"; three CI jobs are outside it~~ **closed in `1749aa0`.** `check` is `lint dupes coverage test-frontend build colour infra-lint torch-free test-sandboxed gate` — every job in `ci.yml`, verified by comparing command strings rather than target names. `test-sandboxed` (off Linux) and `gate` (no Chrome) print a skip line rather than fail; a skip is not a pass |
| 8 | `frontend/package.json` | `axe-core` is a devDependency nothing runs; `a11y.html` is not in the build inputs |
| 9 | `scripts/graphhopper.sh:61-62` | heap defaults sized for a region set that cannot run on the target VM |
| 10 | `docker-compose.yml:60-61` | publishes the API on `0.0.0.0` |
| 11 | `docker-compose.yml` | no TLS, no resource limits, `frontend` is a dev server, `VITE_API_PROXY_TARGET` is dead config |
| 12 | `frontend/` | no `public/`, no `_headers`, no `_redirects`; CSP holds a `REPLACE-WITH-YOUR-RENDER-HOST` placeholder |
| 13 | `docs/adr/0004` | explicitly rejects the deployment shape this brief builds; needs superseding, not ignoring |

No `TODO`, `FIXME`, `XXX` or `HACK` exists anywhere in `backend/`,
`frontend/src/`, `scripts/` or `infra/`. No broken imports. That part is clean.

## Appendix C · Numbers worth having to hand

Every figure below is quoted from the repo's own records, not freshly measured.
Re-measure the starred ones in Phase 1 and correct them where they have drifted.

| | |
|---|---|
| ⭐ backend tests | 645 per `PROGRESS.md`'s last entry; `README.md:46` still says 632 |
| frontend tests | 46 (`follow.test.js` 22 + `sun.test.js` 24) |
| ⭐ coverage | 87.55% in the README, 87.52% in `66eaef3`'s measured block, floor 85% — and 13 tests have landed since either |
| `data/cache.db` | 57,344 bytes, 146 segment scores, 27 with NULL score, 0 route-cache rows — **verified directly** |
| demo graph | 346 MB merged extract → 485 MB graph (CH removed) |
| demo import time | 96 s with CH, 58 s without, 71 s for the actual build — three numbers, all in the repo |
| demo runtime | 1.1 s cold start, 44 ms first route, router RSS 1,051–1,073 MB at `GH_HEAP=3g` |
| `countries` graph | 3.5 GB → 6.6 GB, ~31 min import, **20 GB heap** — will not fit |
| router image | 1.2 GB with graph baked in (was 2.65 GB before the layer fix) |
| one uncached 3-objective request | 14.0 s wall clock, 8 GraphHopper requests |
| load test | 10 users × 50 requests → p50 3.48 s, p95 5.36 s, one address, limiter raised |
| AWS stack if applied | ~$108/mo, ~$50 of it NAT gateway + ALB |
| this deployment | $0/mo |

## Appendix D · Hosting facts, current as of 8 August 2026

**Nothing in the repo attests to any of these. Verify before relying on them.**

- **Oracle Always Free** was halved on **15 June 2026** with no announcement:
  4 OCPU / 24 GB → **2 OCPU / 12 GB** Ampere ARM. Still 200 GB block storage and
  10 TB egress.
- **Cloudflare Pages** — static asset requests free and unlimited on all plans.
  500 builds/month, 20,000 files, 25 MiB per file.
- **Render** cut Hobby bandwidth 100 GB → **5 GB**; workspaces auto-migrated
  **1 August 2026**. Free services still sleep after 15 minutes.
- **AWS** withdrew the 12-month free tier in July 2025; Free-plan accounts close
  after **6 months**.
- **Vercel Hobby is non-commercial personal use only** — soliciting donations
  counts as commercial.
- **Netlify** free is now **300 credits/month, hard-capped** (~15 GB).
- **Hetzner** CX23: €3.99 + €0.50 IPv4, 2 vCPU / 4 GB / 40 GB / 20 TB. The
  fallback if Oracle will not allocate.

## Appendix E · What not to do

- Do not reopen the `66eaef3` frontend decision.
- Do not apply the AWS templates. Do not delete them either.
- Do not add `torch` to `requirements-deploy.txt` — CI has a job that fails if
  you do, and the API only ever *reads* CLIP scores from `cache.db`.
- Do not set `MEANDER_CACHE_DB`. Every route silently drops to `geometry_only`.
- Do not add `--workers` or replicas. Rate limiter, daily ceiling, metrics and
  cache are per-process by design (`Dockerfile:74-75`) — N workers means N daily
  ceilings and 1/N the cache hit rate.
- Do not publish GraphHopper's port, and do not publish `/metrics`.
- Do not write a bare `/* /index.html 200` on Pages.
- Do not test CORS with curl.
- Do not re-record fixtures casually. They are keyed on a hash of the outgoing
  request body; change `path_details()`, `_base_body()`, a custom model or a
  round-trip param and you miss **every** fixture at once and the suite fails
  wholesale with `no_fixture` 503s. `BLOCKED.md:228` is the warning; read it
  first.
- Do not commit a `data/cache.db` carrying `route_cache` rows. Check it with
  `--check --worktree`; plain `--check` inspects the staged blob and will pass a
  dirty file.
- Do not let a route with unknown accessibility data render as accessible.
  Ever, under any deadline pressure.

---

## One stretch goal, only after the deploy is live

The 12 GB VM changes the economics that forced the offline/online CLIP split.
That split exists because Render's free tier has 512 MB; here the router uses
~1 GB and the API ~200 MB, leaving roughly 6 GB spare. A `MEANDER_CLIP_LIVE`
flag — default off, `requirements-deploy.txt` untouched, full `requirements.txt`
installed only in a separate image — would let the VM score uncached segments on
demand. That turns "146 pre-warmed segments" into "anywhere inside the graph,
slower the first time", which is the headline capability the original project
plan wanted and never got.

**Verify aarch64 torch wheels exist before promising it to anyone**, and do not
let it delay the release by a single day.
