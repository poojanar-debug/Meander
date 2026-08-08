# GOAL — Put Meander on the iOS App Store

You are working on **Meander**, in this repository. This document is the complete brief for
shipping it as a native iOS app. Work through it in phase order and commit as you go.

The end state: a free, iPhone-only, account-free app on the App Store, backed by a live AWS
deployment, built by CI, signed automatically, and shipped through TestFlight first.

---

## 0. Read this first

**What Meander is.** You give it where you are and how long you have. It gives you back three
routes: the fastest, the greenest, and one that holds to real accessibility constraints. No
destination means a round trip. One dial, 20–360 minutes. FastAPI backend, React + MapLibre
frontend, streaming over SSE, self-hosted GraphHopper.

**Its founding ethic**, which constrains everything below: *a missing OpenStreetMap tag means
`UNKNOWN`, never "accessible."* A false step-free claim can strand a real person. Every route
states what fraction of it was actually verified, and the wording escalates when that fraction is
low.

**Orient yourself before touching anything.** Read, in this order: `README.md`, `PROGRESS.md`
(long, but it is the build log and it explains why things are the way they are), `BLOCKED.md`,
`DEPLOY.md`, `CONTRIBUTING.md`, `docs/API.md`, `infra/README.md`, `docs/RUNBOOK.md` and the six
ADRs in `docs/adr/`. Then read `frontend/src/api/client.js`, `frontend/src/App.jsx`,
`frontend/src/components/MapView.jsx`, `frontend/index.html`, `backend/main.py` and
`backend/config.py`.

The comments in this codebase are unusually load-bearing. Several of them record a full day lost
to a silent failure. Read them before you change the line they sit above.

**Two things you should know before you form a plan.** First, this app is not a candidate for a
thin web wrapper — Apple rejects those under Guideline 4.2, and a rejection here costs a review
cycle. Phase 4 exists specifically to make the app defensibly native. Second, the project's
privacy position ("nothing is stored, no analytics, no coordinates in logs") is unusually strong
and it is worth real money in App Store terms: the privacy nutrition label can honestly say **Data
Not Collected**, which almost nothing in this category can. Do not spend that asset.

---

## 1. Where the project actually is right now

Verified against the working tree on 6 August 2026, not assumed. Confirm each of these yourself
before relying on it — the tree moves.

**`main` is not the branch you want.** `main` is at `867e8e2`. It is desktop-first, has none of
the production hardening, and its `README.md` Status section is stale.

**There are two large unmerged branches, both branched from `867e8e2`, and they overlap badly.**

| branch | commits ahead of `main` | what it contains |
|---|---|---|
| `feat/launch` | 49 | The whole AWS launch programme. Backend hardening, concurrency, health probes, observability, containers, CloudFormation, CI, **plus a full mobile-first frontend rebuild**, design system with dark mode, permalinks, GPX/GeoJSON export, maps handoff, print sheet, turn-by-turn directions, elevation profile, barrier reporting, units/locale, and a PWA with offline results. |
| `claude/code-prompt-design-handoff-b8efa1` | 25 | A *different* dark-green redesign — two-column panel + stage — plus two things `feat/launch` does not have at all: **live follow mode** (`FollowMode.jsx`, `lib/follow.js`) and a **sunrise/sunset daylight guard** (`lib/sun.js`, `DaylightGuard.jsx`). |

`git merge-tree` across the two reports **247 conflicting hunks across 45 files** — **84 hunks in
17 files** once the 28 GraphHopper fixtures are set aside. `frontend/src/styles.css` alone
accounts for 41 of them, `App.jsx` for 8, `BLOCKED.md` for 7. There are also three **modify/delete**
conflicts: `Controls.jsx`, `RouteCard.jsx` and `RouteList.jsx` are deleted on the redesign branch
and modified on `feat/launch`.

Files touched on both branches, which is a longer list than the conflicting one — these five change
on both sides but auto-merge clean, so do not budget for them: `.gitignore`, `backend/main.py`,
`backend/tests/test_routing.py`, `scripts/make_synthetic_fixtures.py`, `frontend/src/lib/format.js`.

The real conflicts are concentrated in `frontend/src/styles.css`, `frontend/src/App.jsx`,
`frontend/index.html`, `frontend/package.json`, `frontend/src/api/mock.js`, the shared components
(`MapView`, `RouteRow`, `TimeDial`), `frontend/src/lib/{dash,theme}.js`, `backend/models.py`,
`backend/routing.py`, `backend/requirements-dev.txt`, `.github/workflows/ci.yml`, and the three
long-form documents.

Both branches independently rebuilt the frontend and both added turn-by-turn directions, dark mode
and a `RouteRow` component. **A straight `git merge` is the wrong move** — 41 conflicting hunks in
one stylesheet is not a merge, it is a rewrite with extra steps — and Phase 0 tells you what to do
instead.

**Nothing is deployed.** `infra/` contains four CloudFormation stacks that `cfn-lint` passes
clean. `infra/README.md` says, correctly and in a call-out box, that none has ever been applied and
every gate in it is **UNVERIFIED**. A template that parses is not a template that works.

**There is no native shell of any kind.** No `ios/`, no `capacitor.config.ts`, no Fastlane, no
signing configuration, no icons beyond the PWA set in `frontend/public/`.

### The five findings that will cost you a day each if you meet them by surprise

These are specific to putting *this* codebase inside *this* container, and each one fails
silently — which is the failure mode this project's whole ethic is built against.

1. **Service workers do not register under `capacitor://localhost`.** Capacitor serves the app on
   iOS from a custom scheme, and WKWebView only registers service workers on `http`/`https`
   secure origins. So `frontend/sw.js` and `frontend/src/lib/pwa.js` become a **silent no-op** in
   the app — `registerServiceWorker()` catches the failure deliberately and says nothing.
   Everything `feat/launch` built for offline (the `check:offline` build gate, the `pwa-gate` Make
   target, `lib/offline.js`, `lib/offlineStore.js`, `OfflineBar.jsx`, `OfflineControl.jsx`) is
   dead on iOS. **The app would show a "save this route for offline" affordance that does
   nothing.** That is exactly the class of dishonesty non-negotiable #1 forbids. Phase 4.4 is how
   you fix it.

2. **`DEPLOY.md` Step 2 says "There is no CORS step, and that is deliberate." That stops being
   true on iOS.** The single-CloudFront-origin design means the *web* app never makes a
   cross-origin request. The *app* serves from `capacitor://localhost` and calls
   `https://<distribution>/api/*`, which is cross-origin by any definition, so preflight and CORS
   apply. `infra/20-services.yaml` line ~259 sets `MEANDER_ALLOWED_ORIGINS` to the empty string on
   purpose. Phase 2.1 changes that. The good news, already verified: the `/api/*` cache behaviour
   uses AWS-managed `AllViewerExceptHostHeader` (`b689b0a8-53d0-40ab-baf2-68738e2966ac`), which
   forwards the `Origin` header to the ALB, and `CachingDisabled`
   (`4135ea2d-6df8-44a3-9df3-4b5a84be39ad`), so responses are not cached across origins.

3. **Enabling the `CapacitorHttp` plugin will kill streaming.** It patches global `fetch` and
   `XMLHttpRequest` on native and buffers the whole response.
   `realFetchRoutes()` in `frontend/src/api/client.js` reads `res.body.getReader()` and parses SSE
   frames incrementally. Under a patched `fetch` there is no `res.body`, so the client silently
   falls through to its plain-JSON branch — the app still works, but every route arrives at once
   after the full request, and the streaming choreography the UI is built around never fires.
   **Leave `CapacitorHttp` disabled.** It is disabled by default; the risk is that you turn it on
   to "fix" CORS. Do not. Fix CORS on the server, where it belongs.

4. **The CSP moves house.** `frontend/vercel.json` was *moved* to `docs/legacy/vercel.json` on
   `feat/launch` and is no longer in the build path at all; `infra/30-web.yaml` sets the response
   headers for the *web* deployment.
   Neither reaches a native shell, which serves local files with no server in front of them. The
   app needs a `<meta http-equiv="Content-Security-Policy">` in `frontend/index.html`, and it must
   name the API origin and `https://tiles.openfreemap.org` in **both** `connect-src` and
   `img-src`. A blank map is the documented symptom of getting the tile host wrong.
   ⚠ One trap here, and it depends on Phase 0's outcome. The **redesign branch's**
   `frontend/index.html` contains an inline `<script>` that resolves the theme before first paint,
   deliberately, to stop a dark-mode user seeing a frame of cream — a `script-src 'self'` with no
   hash kills it silently and the flash comes back. `feat/launch`'s `index.html` has **no** inline
   script; it resolves the theme in the cascade instead (`lib/theme.js` says so at the top:
   *"Nothing here sets a theme — the cascade does that"*). So on the recommended base, plain
   `script-src 'self'` is correct. **If you port the redesign's anti-flash block, you must add its
   SHA-256 hash to `script-src` and a build check that the hash still matches** — it will drift the
   first time anyone edits it.

5. **`data/cache.db` is baked into the API image and its `route_cache` table holds real
   coordinates.** `feat/launch` added `make scrub`, `scripts/scrub_cache_db.py` and a pre-commit
   hook (`scripts/git-hooks/pre-commit`, installed by `scripts/install-hooks.sh`) that inspects the
   *staged* blob and refuses a `cache.db` carrying whole route payloads. **Install the hook on your
   machine** — it is not automatic on clone — and run `make scrub` before any image build.
   Publishing location history in a public artifact breaks non-negotiable #4 and there is no way to
   un-publish a container layer.

---

## 2. Ask me for these — do not guess, do not invent placeholders

**This is a standing instruction, not a one-time checklist.** Whenever you reach a point where you
need a credential, an identifier, a domain, a legal URL or a decision with a cost attached, **stop
and ask me for it by name**, tell me exactly where to get it, and wait. Do not scaffold with a
fake value and a `TODO`; a placeholder that reaches a signed build or a deployed stack is worse
than a blocked phase, because it looks finished.

Ask in batches, at the top of the phase that needs them, so I can go and collect several at once.
Everything below is a question for me, not a thing for you to decide.

### Before Phase 1 (AWS)

| what | where I get it | notes |
|---|---|---|
| AWS account ID + the region to deploy in | AWS console | `infra/README.md` assumes `ap-south-1`. Ask if that is still right — it is the closest region to Colombo and it changes the cost. |
| An AWS credential you can actually use | I will set up a named profile or export keys | `infra/README.md` notes the machine it was written on had **account root** credentials. Ask me to create a scoped IAM user or SSO profile first; do not deploy as root. |
| A registered domain, and where its DNS lives | Route 53, or my registrar | Needed for ACM. If I do not have one yet, tell me and stop — everything downstream needs it. |
| `AlarmEmail` for the CloudWatch SNS topic | me | Confirm the subscription arrives; SNS does nothing until I click it. |
| Region set: `demo` or `countries` | me — this is a **cost decision** | `demo` is a 485 MB graph and ~71 s import. `countries` is 6.6 GB, a 31-minute import and a 20 GB serve heap, and it changes `RouterMemory` and the monthly bill materially. `DEPLOY.md` puts the whole stack at about **$108/month** on `demo`. **Show me the delta before I choose.** |
| `MAPILLARY_TOKEN` | mapillary.com → dashboard → developers | Free. Only the offline batch scorer reads it. |
| `ANTHROPIC_API_KEY` | console.anthropic.com | Optional, **costs real money per call**. Without it, narration stays `null` and the card says so. Ask me whether to ship narration at all in v1. |
| `GRAPHHOPPER_KEY` | graphhopper.com | Almost certainly **not needed** — we run our own router. Ask before adding it to Secrets Manager. |

### Before Phase 3 (the shell)

| what | where I get it | notes |
|---|---|---|
| Apple Developer Program membership | developer.apple.com/programs — **$99/year** | Tell me if I do not already have one. Nothing past Phase 3 can happen without it, and enrolment can take a day or more. |
| Apple **Team ID** | developer.apple.com → Membership | Ten characters. Fastlane and the Xcode project both need it. |
| **Bundle identifier** | my choice, needs my domain | Propose `com.<my-domain-reversed>.meander` and let me confirm. It is **permanent** once the app record exists. |
| **App name**, and a fallback | App Store Connect | "Meander" is a common word and is **likely already taken**. Check availability in App Store Connect *before* creating the record, and bring me two or three alternatives that keep the name in the subtitle. Do not pick one yourself. |
| Minimum iOS deployment target | me | Recommend one and say what it costs in reach. |

### Before Phase 8 (CI/CD)

| what | where I get it | notes |
|---|---|---|
| **App Store Connect API key** — Issuer ID, Key ID, and the `.p8` file | App Store Connect → Users and Access → Integrations → App Store Connect API | Role: **App Manager**. The `.p8` downloads **once**. It goes into GitHub Actions secrets, never into the repo. Tell me the exact secret names you want. |
| Signing strategy | me | Recommend one: Fastlane `match` with a private cert repo, or Xcode automatic signing plus `app_store_connect_api_key`. Say which you prefer and why, then ask. |
| A private repo for `match` certificates, if that is the choice | GitHub | Plus the `MATCH_PASSWORD` I choose. |
| GitHub repo admin, for OIDC and secrets | me | `infra/00-platform.yaml` already provisions an OIDC deploy role with `GitHubOwner=poojanar-debug GitHubRepo=Meander`. **Confirm those are still correct** before you deploy the platform stack. |

### Before Phase 7 (metadata) — these are legal requirements, not nice-to-haves

| what | notes |
|---|---|
| **Privacy policy URL** | **Mandatory.** Every app needs one, even one that collects nothing. Offer to draft it from the project's actual behaviour and host it on the CloudFront site at `/privacy` — that is honest, free, and there is no third party to trust. Ask me to approve the text. |
| **Support URL** | Mandatory. A page or a mailto. Same offer. |
| Marketing URL | Optional. |
| App Review contact — name, phone, email | Mandatory. |
| Review notes text | Draft it; I approve it. Phase 10 says what must be in it. |
| Age rating answers | Walk me through the questionnaire rather than answering for me. |
| Copyright line, primary/secondary category | Suggest: Primary **Navigation**, Secondary **Health & Fitness**. Ask. |

---

## 3. Non-negotiables

Breaking any of these fails the task no matter how good the rest is. The first four are inherited
from the project and are not up for renegotiation; the rest are specific to this phase of work.

1. **A missing OSM tag is `UNKNOWN`, never "accessible."** No default, no heuristic, no fallback
   that turns absent data into a positive accessibility claim — and no App Store marketing copy
   that implies one either. The screenshots and the description are part of the product.
2. **Every route keeps a visible statement of how much of it was verified**, at the severity scale
   `feat/launch` established. The native shell does not get to hide it behind a tap.
3. **Nothing synthetic or placeholder is ever presented as a measurement.** `scoring_method`,
   `synthetic_upstream` and `preset_note` survive every refactor.
4. **No silent regression of privacy.** No coordinates in logs, no location history, no
   third-party analytics — and specifically **no analytics SDK, no crash reporter that ships
   coordinates, and no advertising identifier.** The privacy nutrition label must be able to say
   *Data Not Collected* truthfully at submission. If a plugin you add would falsify that, do not
   add it; come and tell me.
5. **A feature that cannot work on iOS is removed or honestly labelled — never left visible and
   broken.** This is finding #1 above and it is the single most likely way this port betrays the
   project's ethic.
6. **The live position never leaves the device.** Follow mode calculates against geometry already
   downloaded. If you find yourself adding a request that carries a coordinate, stop and ask.
7. **The test suite stays offline.** It must never open a socket. `make check` stays green at
   every commit.
8. **No `torch` in `backend/requirements-deploy.txt`.** The deploy image is deliberately CLIP-free.
9. **The route list stays a complete text substitute for the map.** The app must be fully usable
   with the map element removed. This matters more on iOS, not less — VoiceOver users get the list.
10. **Never present a route the router could not verify as though it were verified.**

If a task below appears to conflict with one of these, stop and ask.

---

## 4. How to work

**Commit discipline — a requirement, not a style note.**

- Conventional commits, matching the existing history: `feat(ios):`, `fix(capacitor):`,
  `build(fastlane):`, `docs(store):`, `chore(signing):`, `test(e2e):`.
- **Commit at every logical unit of work.** A phase should produce 3–8 commits, not one. A
  reviewer should be able to read the log and follow the reasoning.
- **Never commit a red tree.** `make check` must pass at every commit on the branch.
- Write the *why* in the body when the change is not obvious. This repo's history already does
  this well — match it.
- **Tag at each phase boundary**: `ios-p0`, `ios-p1`, … so any phase can be rolled back to.
- Work on `feat/ios`, branched from `feat/launch` (see Phase 0). Push at the end of every phase.
- Do not rewrite pushed history.

**Other rules.**

- **Verify before you act.** Where this document states a fact about the code, confirm it.
- **Add a test for every bug you fix.**
- **Stop and ask** on genuine forks: a cost decision, an irreversible choice (a bundle ID, an app
  name, a first submission), or a product question this brief does not answer. Guess freely on
  everything else and say what you guessed.
- **Test on a real iPhone.** A simulator does not have a GPS, a notch, a real WebGL driver, thermal
  throttling, or Low Power Mode. Every gate that says "on device" means on device. Ask me to run
  the ones you cannot.
- Update `PROGRESS.md` as you go, in the voice already established there: what you built, what you
  measured, what surprised you, what you deliberately did not do.

**One repo-specific trap, worth internalising now.** A GraphHopper fixture is keyed on a hash of
the outgoing request body, so any change to what the app sends GraphHopper invalidates every
committed fixture at once and the offline suite fails wholesale with `no_fixture` 503s.
`PROGRESS.md` records this as self-hosting defect #6, and `feat/launch` already hit it once more
when it turned on `instructions`. Nothing in this brief should change that body — if you find
yourself about to, re-record fixtures in the same commit.

---

# PHASE 0 — Reconcile the two branches

**This is the largest decision in the whole brief and it is a judgement call, so read this
section fully before doing anything.**

## 0.1 The recommendation, and why

**Take `feat/launch` as the base and port three features across from the redesign branch.** Do not
attempt `git merge`.

`feat/launch` is the branch that can actually ship: it has the backend hardening, the containers,
the CloudFormation, the CI, and a mobile-first frontend that puts an answer on screen without
scrolling. The redesign branch has none of that. What the redesign branch has that `feat/launch`
does not is exactly three features, and they are the three that matter most for a *phone*:

| from the redesign branch | files | why it matters on iOS |
|---|---|---|
| **Live follow mode** | `components/FollowMode.jsx`, `lib/follow.js`, `lib/follow.test.js` | This is the single strongest argument against a Guideline 4.2 rejection. It is real-time turn-by-turn walking navigation with barrier proximity warnings — categorically not a web clipping. |
| **Daylight guard** | `lib/sun.js`, `lib/sun.test.js`, `components/DaylightGuard.jsx` | Client-side NOAA solar position, no network call. Real safety value on an evening walk, and it handles polar day/night rather than fabricating a time. |

**Do not port `DepartureStrip.jsx`.** `feat/launch` already renders `payload.best_departure`, in
`components/BetterLater.jsx` (mounted at `App.jsx:440`, fed from `App.jsx:262`), and its version is
the better one — a ticking `useNow()` clock and `departureHasPassed()` withdraw the suggestion once
the window has gone, which the redesign's strip does not do. At most, reconcile the two
presentations; there is no feature to move.

Everything else on the redesign branch — the dark-green token set, the two-column panel+stage
layout, `TripBar`/`TripDrawer`, `RouteRail`/`RouteDetail`, `VerificationMeter`, `StepList` — is a
*second* answer to a question `feat/launch` already answered, and answered in a way that is better
suited to a phone. `feat/launch`'s `RouteSheet`/`RouteRow`/`TrustSignal`/`ControlsSheet` are the
bottom-sheet architecture this app wants inside a native shell.

**Before you act on this, show me the two UIs side by side** — build both branches, screenshot each
at 390 × 844, and put them in front of me. I want to make this call with my eyes, not from a table.
If I prefer the dark-green system, the port runs the other way and Phase 0 gets much longer; say so
plainly rather than absorbing it.

## 0.2 Doing the port

1. `git checkout -b feat/ios feat/launch`.
2. Confirm the baseline before you change anything: `make check` green, and record the test count.
3. Port `lib/sun.js` and `lib/sun.test.js` first — they are pure functions with tests and no
   dependency on the redesign's component tree. `feat/launch` has no `vitest`; the redesign branch
   added it. Bring the dev dependency and the `test` script across in the same commit and wire it
   into `make check`.
4. Then `DaylightGuard`, restyled onto `feat/launch`'s token set, and placed near `BetterLater` —
   they answer the same question ("when should I go?") and should read as one thought. Grep for
   hard-coded hex; `feat/launch` has a `check:palette` build gate that will fail you if any
   survives — that gate is doing its job, do not weaken it.
5. Then `lib/follow.js` + `follow.test.js`, then `FollowMode.jsx`. This is the big one. Preserve
   every behaviour from the redesign spec, and re-read the reasoning in the source comments:
   - Barrier proximity warning at **200 m**, `role="alert"` plus one vibration, and it fires even
     for barriers on a route the user chose to follow anyway. That warning is the app's reason to
     exist.
   - Off-route is **>40 m sustained for >15 continuous seconds**, not a single reading. City GPS
     noise will fire a single-reading threshold constantly.
   - Wake lock in a try/catch. It must never throw.
   - Exit is one tap, always visible, **first in the tab order** within follow mode.
   - Announce the current step through the **existing** polite live region. Do not add a second.
   - Permission denied → drop back to the detail panel with the step list open. A blocked route
     cannot be started at all.
   - Follow mode is never the only way to read a route.
6. Follow mode consumes the turn-by-turn instruction array. **Both branches already turned
   `instructions` on** — `feat/launch` in `fd4ca87 feat(directions): turn on instructions, and
   re-record every fixture with it`. Verify the payload shape `feat/launch` produces matches what
   `lib/follow.js` expects, and adapt the *port*, not the backend.
7. Leave the redesign branch alone. Do not delete it. Add a note to `PROGRESS.md` recording what
   was taken, what was left, and why — a future reader will want to know that a whole alternative
   design exists and was considered.

> **Commit:** several, one per ported feature. `feat(follow): live follow mode, ported onto the
> mobile-first shell` and so on, with the reasoning in the body.
> **Gate:** `make check` green. `make gate` (the Phase 5 UI gate) still 14/14. Follow mode works in
> a desktop browser with simulated geolocation. Test count is the sum of both branches' suites,
> and you can say what it is.
> **Tag:** `ios-p0`.

---

# PHASE 1 — Get the backend live on AWS

The app is useless without a live API, and **an App Review engineer will open it and expect real
routes**. This phase is not optional and it is not last.

Ask me for everything in the §2 "Before Phase 1" table before you start.

## 1.1 Read the infrastructure honestly first

`infra/README.md` states that nothing has been applied and every gate is UNVERIFIED. Take that at
face value. Your job in this phase is to convert those UNVERIFIED rows into either PASS with the
command that proved it, or a defect with a fix. Update the gate table in `infra/README.md` as you
go — it is the deliverable, not a formality.

## 1.2 Build and publish the graph

```bash
scripts/graphhopper.sh setup --region-set demo   # ~4 min, once. Needs JDK 21.
scripts/publish_graph.sh --local
```

Confirm the region set with me first. Then verify the coverage check actually fires: a request
whose coordinates fall outside the imported bounding boxes must produce *"Meander does not cover
that area yet"*, not a generic routing error and not *"try moving the start a little."* This
matters more on a phone than anywhere else, because the user's location is wherever they happen to
be standing.

## 1.3 Apply the four stacks, in order

`00-platform` → `10-network` → `20-services` → `30-web`, per `infra/README.md`. Before
`00-platform`, confirm `GitHubOwner` and `GitHubRepo` with me — the template currently carries
`poojanar-debug` / `Meander`.

**Run `make scrub` before building the API image.** `data/cache.db` is baked in and its
`route_cache` rows contain real coordinate arrays.

Secrets go into Secrets Manager by hand, never as CloudFormation parameters — a parameter value is
visible in `describe-stacks` for the life of the stack. `DEPLOY.md` already says this; obey it.

## 1.4 Prove it end to end, from a browser, before you touch Xcode

```bash
SITE=$(aws cloudformation describe-stacks --stack-name meander-web \
  --query 'Stacks[0].Outputs[?OutputKey==`SiteUrl`].OutputValue' --output text)

curl -s $SITE/api/healthz
curl -s $SITE/api/health | jq '.routing | {self_hosted, self_hosted_source, path_details}'
curl -N -H 'Accept: text/event-stream' -H 'Content-Type: application/json' \
  -X POST $SITE/api/routes -d '{"origin":{"lat":…,"lon":…},"minutes":35,"mode":"foot","objectives":["fastest","nature","accessible"]}'
```

The streaming check is the one that matters. **If `curl -N` returns one buffered blob at the end
rather than incremental events with visible gaps, streaming is dead through CloudFront and
everything downstream of it is theatre.** Diagnose it before continuing — the `/api/*` behaviour
is already on `CachingDisabled` + `AllViewerExceptHostHeader`, so if it still buffers, the cause
is elsewhere and you need to find it now, not after the app is built.

Also confirm: `path_details` includes `smoothness` (the self-hosted flag resolved correctly — if
it did not, one of the five hard accessibility constraints has silently stopped firing);
`/readyz` returns **503** with the router stopped; GraphHopper is not reachable from the public
internet, and prove it rather than asserting it; a 90-second request completes without a 504.

## 1.5 Write down what it costs

Put the real monthly figure in `DEPLOY.md` once you know it, alongside the estimate. Set up a
billing alarm. Tell me the number.

> **Gate:** every gate row in `infra/README.md` is PASS or a filed defect. Three real routes render
> in a desktop browser against the deployed site. Streaming is incremental. Rollback to a previous
> image tag works and is documented.
> **Tag:** `ios-p1`.

---

# PHASE 2 — Make the backend serve a native origin

Small phase, entirely server-side, and it must land before the shell exists or you will spend a
day debugging CORS through a WKWebView console you cannot easily read.

## 2.1 Allow the app's origin

`infra/20-services.yaml` sets `MEANDER_ALLOWED_ORIGINS` to `''`. Set it to the app's origin —
`capacitor://localhost` by default — plus the site origin if you keep it explicit. Add a
`CorsOrigins` stack parameter rather than hard-coding it.

⚠ **There is a live defect here, and it is not the one you would expect.**
`backend/config.py:322` reads `_env_flag("MEANDER_ALLOW_LOCAL_ORIGINS", not origins)` — the default
is *on whenever no origins are configured*. Since `infra/20-services.yaml` configures none, the
deployed task's allowlist today is not empty at all: it is
`('http://localhost:5173', 'http://127.0.0.1:5173')`. Production currently allowlists the Vite dev
server. Setting `CorsOrigins` flips that default off as a side effect, which is the behaviour you
want — but it is a side effect, so **pin it with a test** rather than leaving it to be rediscovered.

Verify `_resolve_origins()` handles a non-`http(s)` scheme without mangling it. Check
`backend/main.py`'s CORS middleware allows `OPTIONS` (it does, at L213 — `allow_methods=["GET",
"POST","OPTIONS"]`) and that `allow_headers` covers `Content-Type` and `Accept` (it does, L214).
`expose_headers` at L220 already carries `Retry-After`, `X-Meander-Cache`, `X-Request-Id`.

**Add tests** in `backend/tests/test_client_ip_and_cors.py`: a request with
`Origin: capacitor://localhost` gets the header back; a foreign origin does not; and with
`MEANDER_ALLOWED_ORIGINS` set, `localhost:5173` is **not** allowed.

## 2.2 Confirm the preflight survives CloudFront

`OPTIONS` must reach the ALB and come back with the right headers. Prove it with `curl -X OPTIONS`
carrying `Origin: capacitor://localhost` and `Access-Control-Request-Method: POST`. This is the
single most likely thing to be quietly wrong.

## 2.3 Decide the scheme deliberately, and write it down

`capacitor://localhost` is the default and it keeps `localhost` as the hostname, which is what
makes the WebView a **secure context** — required for `navigator.geolocation`, and follow mode dies
without it. If you change `server.iosScheme` for any reason, you change the `Origin` value and
Phase 2.1 has to change with it. Note the coupling in `DEPLOY.md`, in the *"things that will look
like bugs and are not"* table, which is the most useful thing in that document.

Add a row to that table for each of the five findings in §1 while you are there.

> **Gate:** preflight and a real POST both succeed from `Origin: capacitor://localhost`. Tests green.
> **Tag:** `ios-p2`.

---

# PHASE 3 — The Capacitor shell

## 3.1 Environment

Current, verified as of August 2026:

- **Capacitor 8** requires **Xcode 26.0** minimum and defaults to **Swift Package Manager** rather
  than CocoaPods. Node 22+.
- Apple requires all App Store uploads to be built with **Xcode 26 or later using an iOS 26 SDK**
  as of **28 April 2026**. These two line up; do not use an older Xcode "to be safe."

Confirm the machine has Xcode 26+ before writing any code. If it does not, that is a blocker to
raise with me, not something to work around.

## 3.2 Install and configure

Add `@capacitor/core`, `@capacitor/cli`, `@capacitor/ios` to `frontend/`, then `npx cap add ios`.
Keep the iOS project inside `frontend/ios/` and commit it — a generated-but-committed native
project is normal for Capacitor and the alternative is an unbuildable checkout.

`capacitor.config.ts` essentials:

- `webDir: 'dist'`, `appId` and `appName` from §2 (**ask me**).
- **Do not enable `CapacitorHttp`.** See finding #3. Add a comment saying why, in the style of
  this repo — someone will try to turn it on to fix a CORS error and needs to find the reason
  there.
- Leave `server.url` unset. The app ships its own assets; it is not a remote-URL wrapper. This is
  both a Guideline 4.2 argument and the reason the app opens instantly.
- Set `ios.contentInset` deliberately and note the choice.

## 3.3 Point the build at the API

`frontend/src/api/client.js` reads `VITE_API_BASE` and defaults to empty, meaning same-origin —
correct for the web build behind one CloudFront distribution, and **wrong for the app**, where
same-origin means `capacitor://localhost` and there is no API there. The iOS build must set
`VITE_API_BASE` to the absolute HTTPS API origin.

Add a separate build script (`build:ios`) rather than mutating the web one, so the web deployment
keeps its same-origin property and the two cannot drift. Add a check that fails the iOS build if
`VITE_API_BASE` is empty or not `https:` — App Transport Security will refuse plain HTTP anyway,
but failing at build time with a clear message beats failing on device with a blank screen.

## 3.4 CSP in the shell

Add the `<meta http-equiv="Content-Security-Policy">` to `frontend/index.html` per finding #4:
`'self'`, the API origin, `https://tiles.openfreemap.org` in `connect-src` **and** `img-src`,
`worker-src 'self' blob:` for MapLibre, `data:` and `blob:` for `img-src`, and the SHA-256 hash of
the inline theme script in `script-src`. Add a build check on the hash.

Do not weaken it to `'unsafe-inline'`. The hash is four lines of build script and this is a
navigation app that reads the user's location.

## 3.5 First run on a device

Get it onto a real iPhone and confirm, before adding anything native:

- The app launches to the map, offline assets and all.
- A route request succeeds and **streams** — routes appear one at a time. Check the Safari Web
  Inspector attached to the device; if all three land together, CORS is fine but streaming is not,
  and finding #3 is your first suspect.
- MapLibre renders and pans at an acceptable frame rate. WKWebView's WebGL is not the simulator's.
  Measure it; if it is bad, say so now rather than at submission.
- Geolocation prompts and returns a fix (proves the secure-context assumption in 2.3).

> **Gate:** all four of the above, on a physical iPhone, with a screen recording.
> **Tag:** `ios-p3`.

---

# PHASE 4 — Earn the "app" in App Store

This phase exists because of **Guideline 4.2**: *"Your app should include features, content, and UI
that elevate it beyond a repackaged website. If your app is not particularly useful, unique, or
'app-like,' it doesn't belong on the App Store."* And **4.2.2**: apps shouldn't primarily be *"web
clippings."*

A Capacitor build of an existing website is precisely the shape reviewers are trained to look at
hard. The defence is not an argument in the review notes; it is capability that only exists in the
app. Build it.

## 4.1 Follow mode as real background navigation *(the strongest single item)*

Follow mode ported in Phase 0 uses `navigator.geolocation.watchPosition`, which stops when the
screen locks or the app backgrounds. On a walk that is most of the time.

- Add `@capacitor/geolocation` and use the native watch.
- Add `UIBackgroundModes: [location]` **only if** you genuinely continue navigation with the screen
  off — which for a walking navigation app you do. Guideline 2.5.4 permits background location for
  its intended purpose; using it for anything else is a removal-level offence.
- `NSLocationWhenInUseUsageDescription` is required. Write a real sentence: *"Meander uses your
  location to show where you are on the route and to warn you before a barrier — it never leaves
  your phone."* Do not write "for app functionality." Reviewers read these and vague strings draw
  rejections.
- Only add `NSLocationAlwaysAndWhenInUseUsageDescription` if you actually need Always. **You
  probably do not** — When In Use plus the background mode covers screen-off navigation, and asking
  for Always without needing it is a rejection risk and a trust cost. Decide, and write down why.
- **Non-negotiable #6 still holds.** The native plugin changes where the fix comes from, not where
  it goes. Nothing leaves the device. Add a test or a guard that proves it.

## 4.2 Haptics

`@capacitor/haptics`. The barrier warning at 200 m currently calls `navigator.vibrate?.()`, which
**does nothing in WKWebView** — Safari does not implement the Vibration API. So today the app's
most important warning is silent on iOS. Replace it with a native impact, keep the `role="alert"`
announcement, and keep the visual. Three channels, because this is the warning the app exists for.

## 4.3 Share sheet and Files

`@capacitor/share` and `@capacitor/filesystem`. `feat/launch` already builds GPX and GeoJSON in
`lib/export.js` — a browser download is meaningless on iOS. Route them through the native share
sheet and let the user drop a GPX into Files, Komoot, Garmin or OsmAnd. This is a concrete
capability the website cannot have and it is genuinely the most useful thing in the export set.

Keep the Apple Maps handoff from `TakeItWithYou.jsx` and verify the URL scheme actually opens Maps
on device.

## 4.4 Replace the dead offline layer — honestly

Finding #1: the service worker never registers, so everything offline is silently inert.

- Detect the native platform (`Capacitor.isNativePlatform()`).
- Re-implement the saved-route store on `@capacitor/preferences` or the Filesystem — the data is
  small and `lib/offlineStore.js` already localises the storage decisions.
- The app shell needs no caching at all in the native build; the assets are already local. That is
  a real simplification, not a compromise.
- **Every offline-served route must still be visibly labelled as saved, with its age.**
  `feat/launch` already built that wording; keep it.
- `frontend/scripts/check-offline.mjs` stays as it is — it exercises the pure labelling logic in
  `lib/offline.js`, and that logic is still exactly right on iOS. **`make pwa-gate` is the one that
  breaks**: `frontend/scripts/pwa-gate.mjs` drives headless Chrome with the server stopped and
  asserts the service worker serves the shell, and on iOS there is no service worker to assert
  about. Rewrite it against the native store or replace it with an on-device check, and say which.
  **A gate that cannot fail is worse than no gate**, because it reads as coverage.
- If any part of offline genuinely cannot work on iOS, **remove the affordance**. Do not leave a
  button that does nothing.

## 4.5 Local notifications for best departure

`@capacitor/local-notifications`. `payload.best_departure` already exists and Phase 0 ported the
strip that renders it. "Notify me when it's the best time to leave" is a small feature, obviously
app-only, and it uses data the backend already computes.

Opt-in, per-request, no standing permission grab on launch. **Guideline 5.1.2(i): the app may not
require notifications to be enabled in order to function.** Nothing here should.

## 4.6 The rest of the native surface

- `@capacitor/status-bar` and `@capacitor/splash-screen` — theme-aware, matching the dark mode
  `feat/launch` built.
- `@capacitor/app` — handle resume, and handle a `capacitor://` deep link so the Phase 6.1
  permalinks from `lib/permalink.js` open in the app. A shared Meander link opening the app is a
  real capability and a good 4.2 data point.
- `@capacitor/network` — an honest offline banner instead of a failed fetch.

## 4.7 Write the 4.2 defence down

Add `docs/APP-REVIEW.md` listing every capability above and what it does that the website cannot.
You will paste from it into the review notes in Phase 10, and if a rejection comes, this is the
appeal.

> **Gate:** on a physical iPhone — follow mode keeps tracking with the screen locked; the barrier
> haptic fires at 200 m; a GPX reaches Files via the share sheet; a saved route opens in airplane
> mode and is labelled with its age; a departure notification arrives; a shared link opens the app.
> Record all of it — the clips become Phase 7 screenshots.
> **Tag:** `ios-p4`.

---

# PHASE 5 — Make it feel like an iPhone app

`feat/launch` did the mobile-first rebuild for a phone *browser*. A native shell is a different
set of edges.

- **Safe areas — verify, do not rebuild.** `feat/launch` already fixed this:
  `frontend/src/styles.css` defines `--safe-top/right/bottom/left` from `env(safe-area-inset-*)`
  around line 98 and consumes them in the top bar, the sheet and the footer. Your job is to check
  the values are actually right on a notched device with a home indicator — a browser at 390 × 844
  reports zero insets, so this has never been exercised. Check the sheet's peek height clears the
  home indicator. ⚠ **The redesign branch has no `env(safe-area-inset-*)` at all**, so if Phase 0
  went the other way and you ported its layout, you re-introduced this bug and this bullet becomes
  implementation work.
- **Bounce and overscroll.** WKWebView rubber-bands the document. The map must not. Set
  `overscroll-behavior` and audit `-webkit-overflow-scrolling` on the sheet.
- **Keyboard.** The place-search field with a keyboard up is the worst moment in the app. Verify
  the suggestion overlay is not pushed off screen and the sheet resizes rather than being covered.
- **Dynamic Type.** Respect the system text size. Check the layout at the largest accessibility
  sizes; `feat/launch` raised the type floor to 14 px, which helps, but 14 px is not what a user at
  AX5 has asked for.
- **VoiceOver.** A full pass with VoiceOver actually on, on device. The existing ARIA work is good
  and the axe pass is clean, but axe does not test the rotor, the swipe order, or whether the
  bottom sheet traps focus correctly under VoiceOver. Non-negotiable #9: with the map ignored, the
  route list must still be a complete answer.
- **Reduce Motion** and **Increase Contrast** — the CSS already has a `prefers-reduced-motion` kill
  switch; verify iOS drives it.
- **Dark mode** matches the system, and the status bar and splash match the theme.
- **Low Power Mode** — check follow mode degrades sanely rather than dying.
- **Attribution.** OpenStreetMap data is ODbL; the tiles come from OpenFreeMap. Attribution must be
  visible and legible in the app, not only in a `<details>`. MapLibre's compact attribution control
  escapes the 44 px target floor — `feat/launch` flagged this; confirm it is fixed.

> **Gate:** a VoiceOver-only session completes a full task — set a time, get routes, read the trust
> signal, start follow mode, exit. No layout break at the largest Dynamic Type size. No horizontal
> scroll on any device size. Zero axe violations in light and dark.
> **Tag:** `ios-p5`.

---

# PHASE 6 — Privacy, permissions and manifests

This is where the project's ethic converts into an App Store asset. Do it carefully and it is a
strength; do it sloppily and it is the most common rejection there is.

## 6.1 Privacy manifest

Add `PrivacyInfo.xcprivacy` to the app target. It declares:

- `NSPrivacyTracking`: **false**. There is no tracking.
- `NSPrivacyTrackingDomains`: empty.
- `NSPrivacyCollectedDataTypes`: **empty** — and make sure that is *true* before you write it.
  Audit every plugin you added in Phase 4.
- `NSPrivacyAccessedAPITypes`: declare each required-reason API you actually use with its reason
  code — `UserDefaults` (Capacitor Preferences uses it), file timestamp, disk space, system boot
  time, as applicable. Do not copy a boilerplate list; declare what the build actually calls.

Capacitor's own plugins ship their own manifests. Verify each one you depend on has one — a
third-party SDK without a manifest is an upload-time rejection, not a review-time one, and it is
much easier to find now than in the middle of Phase 9.

## 6.2 Nutrition label

In App Store Connect, answer **Data Not Collected**. Then go back and check it is still true. The
moment anything ships a coordinate or an identifier off device, it stops being true and this
becomes a false statement to Apple, which is a much bigger problem than a rejection.

## 6.3 Permission strings

Every `NS*UsageDescription` the build can reach. Written as sentences, specific, honest, in the
app's voice. A vague purpose string is a routine rejection.

## 6.4 Everything else in `Info.plist`

- `ITSAppUsesNonExemptEncryption` = `false`. The app uses HTTPS only, which is exempt, and setting
  this avoids the export-compliance question on every single upload.
- App Transport Security: **leave it at the default.** Do not add an exception. The API is HTTPS.
- Supported orientations: portrait, plus whatever the map genuinely benefits from — decide and say.
- `CFBundleDisplayName`, version and build number strategy (Phase 8 automates the build number).

## 6.5 No account, and say so

Guideline 5.1.1(v): *"If your app doesn't include significant account-based features, let people
use it without a login."* Meander has no accounts and should keep it that way. There is no account
deletion requirement because there is no account. Note it in the review notes so nobody looks for a
login.

## 6.6 Draft the privacy policy

From what the code actually does, not from a template. It can say something almost no navigation
app can: coordinates are not logged, there is no location history, there is no analytics, and the
live position in follow mode never leaves the device. `backend/logging_setup.py`'s redaction filter
and `backend/tests/test_privacy_guard.py` are the evidence. Host it at `/privacy` on the
CloudFront site. **Bring me the text to approve.**

> **Gate:** the manifest validates in an archive build. Every plugin's manifest present. Policy
> live at a real URL.
> **Tag:** `ios-p6`.

---

# PHASE 7 — App Store assets and metadata

## 7.1 Icons and launch screen

A full icon set from a 1024 × 1024 master, no alpha, no transparency, no rounded corners of your
own. `frontend/scripts/make-icons.mjs` already generates the PWA set from a description — extend
it rather than starting over, so one source of truth produces both.

A launch screen that matches the app's first frame, in both themes. A launch screen that flashes a
different colour than the app is the cheapest possible way to look unfinished.

## 7.2 Screenshots

Requirements as of now, verified: **1 minimum, 10 maximum**, `.png` or `.jpg`, **no alpha
channel**. You must provide either **6.5" (1284 × 2778 portrait)** or **6.9"** — everything smaller
is auto-scaled. Provide 6.9" as well if you can; the App Store prefers it.

Take them on a real device with real routes, not the mock API and not a simulator. Six that tell
the story:

1. Three routes on the map with the sheet at peek — the whole product in one frame.
2. The trust signal at high coverage, and at low coverage. **Show the honest case.** It is the
   product's actual differentiator and it will read as confidence, not as a caveat.
3. A blocked route — *"Can't complete this route"* with the barriers listed. Nothing else in this
   category shows you what it refuses to do.
4. Follow mode mid-walk with a barrier warning.
5. The elevation profile or the daylight guard.
6. Dark mode.

## 7.3 The words

Name (30 chars), subtitle (30), promotional text (170), description (4000), keywords (100),
what's new.

Two specific cautions:

- **Do not make medical claims.** `README.md` cites the clinical two-hours-a-week prescription,
  which is fine in a repository and risky in App Store metadata: health claims invite Guideline
  1.4.1 scrutiny and can push the app toward a Medical category it does not belong in. Write
  "time outdoors" and "green space", cite nothing, promise nothing clinical. Bring me the copy.
- **Do not overstate accessibility.** The app's honesty about `UNKNOWN` is the differentiator —
  write the description so a wheelchair user reading it understands exactly what the app does and
  does not know. Claiming step-free routing outright would be both a rejection risk and a
  betrayal of non-negotiable #1.

Draft everything and bring it to me. I approve the words.

> **Tag:** `ios-p7`.

---

# PHASE 8 — Fastlane and GitHub Actions

Ask me for the App Store Connect API key and the signing decision from §2 before starting.

## 8.1 Fastlane

`frontend/ios/fastlane/` with three lanes:

- `beta` — build, sign, upload to TestFlight.
- `release` — build, sign, upload for App Store review.
- `screenshots` — optional, via `snapshot`, if UI tests are worth it. Say whether they are; do not
  build them by default.

Authenticate with the App Store Connect API key, never an Apple ID and password — 2FA makes that
unusable in CI. Build numbers auto-increment from `latest_testflight_build_number`, so a rebuild
never collides.

## 8.2 GitHub Actions

A `macos-latest` runner with **Xcode 26 selected explicitly** — do not rely on the runner's
default, which moves. The workflow:

1. `make check` — the existing gate. It must pass before anything is built.
2. `npm ci && npm run build:ios` with `VITE_API_BASE` from a repository variable.
3. `npx cap sync ios`.
4. `fastlane beta`.

Secrets: `APP_STORE_CONNECT_KEY_ID`, `APP_STORE_CONNECT_ISSUER_ID`, `APP_STORE_CONNECT_KEY_P8`
(base64), and `MATCH_PASSWORD` + `MATCH_GIT_URL` if that is the signing route. **Never in the
repo.** `.gitignore` must cover `*.p8`, `*.p12`, `*.mobileprovision`.

Trigger on tag push, not on every commit — a macOS runner is expensive and a TestFlight build per
commit is noise. `infra/00-platform.yaml` already provisions an OIDC role for AWS; that is for
the backend deploy workflow and is unrelated to signing, but keep the two workflows separate and
say so in a comment.

## 8.3 Document it

`docs/RUNBOOK.md` gets an iOS section: how to cut a build, how to roll back a release, what to do
when a certificate expires (it will, in a year, and future-you will not remember), and how to get
a build out by hand if CI is down.

> **Gate:** a tag push produces a TestFlight build with no manual step.
> **Tag:** `ios-p8`.

---

# PHASE 9 — TestFlight

1. Internal testing first — me, and anyone I add. Real walks, real streets, in at least two of the
   covered regions.
2. Then external testing, which needs a **Beta App Review** — lighter than full review, but it is
   a real review and it can reject. Treat the first external submission as a rehearsal, and expect
   the same notes you would get at submission.
3. What to actually test, because a phone in a pocket is not a browser tab:
   - Follow mode on a genuine 30-minute walk. Battery drain. Thermals. Screen-lock behaviour.
   - Losing signal mid-walk. The saved route must appear, labelled, with its age.
   - A location outside the imported graph — the coverage message, not a generic error.
   - Backgrounding for ten minutes and returning mid-stream.
   - VoiceOver on a real walk, not at a desk.
   - Low Power Mode.
   - A cold launch on the oldest device you support.
4. Collect crash reports and fix them. Do **not** add a third-party crash SDK to do it — Xcode
   Organizer gives you crashes without collecting anything, and non-negotiable #4 stands.

> **Gate:** at least one full outdoor walk completed in follow mode by a human, with notes.
> **Tag:** `ios-p9`.

---

# PHASE 10 — Submit

1. Complete the App Store Connect record: metadata, screenshots, nutrition label, age rating,
   pricing (free), availability, category.
2. **Write the review notes.** Draft from `docs/APP-REVIEW.md`; I approve them. They must cover:
   - No account is needed. Nothing is behind a login. (Pre-empts a demo-account request.)
   - **Which coordinates to test from.** If the deployed graph is the `demo` region set, the app
     genuinely does not cover most of the planet, and a reviewer opening it in Cupertino will get
     *"Meander does not cover that area yet"* and may read a working app as broken. **Give them
     exact test coordinates in a covered region, and say plainly that coverage is limited by
     design and stated in the app.** This is, by some distance, the most likely cause of a
     rejection on this particular app — do not leave it to chance.
   - Why background location is used, in one sentence.
   - The 4.2 capability list: background navigation, barrier haptics, native share/Files, offline
     saved routes, departure notifications, deep links.
   - That the app collects nothing.
3. Submit. Choose manual release, not automatic — you want to see it approved before it is live.
4. **If it is rejected**, read the resolution note carefully, fix the actual thing, and reply in
   the Resolution Center with specifics. Do not resubmit unchanged. Bring me the note before you
   reply.
5. On approval: release, verify the App Store listing renders, install the shipped build from the
   store, and confirm it talks to production.

## Then finish the job

- Update `README.md` end to end, including the App Store link. Keep the Limitations section — it
  is the best part of that document and it should get *more* accurate, not shorter.
- Update `PROGRESS.md` with everything this run measured, in its established voice — including
  what surprised you and what you got wrong first time.
- Update `BLOCKED.md`. On `feat/launch` it opens with **"Nothing is open."** and all four entries
  are struck through as RESOLVED — do not assume §2 is still live, and note that the redesign
  branch's numbering diverges. If the iOS work re-opens anything, or leaves something needing a
  human (an expiring certificate, a graph that needs rebuilding, a coverage gap), **add a new
  section** rather than editing a resolved one.
- Write a summary: what changed, what you decided and why, what you deliberately did not do, and
  what a reviewer should still be sceptical about.

> **Tag:** `ios-v1`. Open the PR.

---

## Appendix A — verified findings this brief is built on

Confirm each before acting. Ordered by how much time it costs to discover late.

| # | finding | where | phase |
|---|---|---|---|
| 1 | Service workers never register under `capacitor://localhost`; the entire offline feature is a silent no-op on iOS | `frontend/sw.js`, `frontend/src/lib/pwa.js` | 4.4 |
| 2 | `DEPLOY.md` Step 2 — "there is no CORS step" — is false for the app; `MEANDER_ALLOWED_ORIGINS` is `''` in the task definition | `DEPLOY.md`, `infra/20-services.yaml` L259 | 2.1 |
| 2b | Because `MEANDER_ALLOW_LOCAL_ORIGINS` defaults to `not origins`, that empty value means production currently allowlists `localhost:5173` and `127.0.0.1:5173` | `backend/config.py` L322 | 2.1 |
| 3 | Enabling `CapacitorHttp` patches global `fetch`, removes `res.body`, and silently drops the app to the non-streaming branch | `frontend/src/api/client.js` `realFetchRoutes()` | 3.2 |
| 4 | `infra/30-web.yaml`'s response-headers CSP does not reach a native shell — the app needs its own `<meta>` CSP. (`frontend/vercel.json` was *moved* to `docs/legacy/` on `feat/launch` and is no longer in the build path.) The inline anti-flash script exists only on the redesign branch | `frontend/index.html` | 3.4 |
| 5 | `data/cache.db` is baked into the API image and holds real route coordinates; `make scrub` exists for this | `data/cache.db`, `Makefile` | 1.3 |
| 6 | `navigator.vibrate` does nothing in WKWebView — the 200 m barrier warning is silent on iOS today | `FollowMode.jsx` (redesign branch), ported in 0.2 | 4.2 |
| 7 | `VITE_API_BASE` defaults to empty (same-origin), which has no API in the app | `frontend/src/api/client.js` | 3.3 |
| 8 | Two branches from the same base (`867e8e2`), 247 conflicting hunks across 45 files — 84 in 17 once fixtures are excluded, 41 in `styles.css` alone, plus three modify/deletes. Both rebuilt the frontend independently | `feat/launch` (49 commits), `claude/code-prompt-design-handoff-b8efa1` (25) | 0 |
| 8b | `feat/launch` **does** render `best_departure`, in `BetterLater.jsx`, with expiry handling the redesign branch's strip lacks — there is no departure feature to port | `frontend/src/App.jsx` L262, L440 | 0.1 |
| 9 | `infra/` has never been applied; every gate in `infra/README.md` is UNVERIFIED and the credentials used were account root | `infra/README.md` | 1 |
| 10 | The ALB security group admits only the CloudFront origin-facing prefix list, so the app must reach the API through CloudFront — it cannot bypass it | `infra/10-network.yaml`, `infra/20-services.yaml` | 2 |
| 11 | Capacitor 8 requires Xcode 26.0 and defaults to SPM; Apple requires Xcode 26 / iOS 26 SDK for all uploads since 28 Apr 2026 | — | 3.1 |
| 12 | Screenshots: 6.5" (1284 × 2778) or 6.9" required, 1–10, no alpha channel | — | 7.2 |
| 13 | `feat/launch` already wires `env(safe-area-inset-*)` into the top bar, sheet and footer — but a desktop browser reports zero insets, so it has never actually been exercised. (The redesign branch has none at all.) | `frontend/src/styles.css` ~L98 | 5 |
| 14 | `make pwa-gate` asserts a service worker serves the shell with the server stopped — it has nothing to assert on iOS. (`check:offline` is fine; it tests pure labelling logic.) | `frontend/scripts/pwa-gate.mjs` | 4.4 |

## Appendix B — rejection risks, ranked

| risk | guideline | mitigation |
|---|---|---|
| Reviewer tests outside the imported graph, sees "not covered", reads it as broken | 2.1 | Exact test coordinates in the review notes. **Highest risk on this app.** |
| Judged a repackaged website | 4.2 / 4.2.2 | Phase 4 in full, plus `docs/APP-REVIEW.md` |
| Vague or missing purpose strings | 5.1.1 | Phase 6.3 — real sentences |
| Background location without a clear purpose | 2.5.4 | Only if genuinely used; justified in review notes |
| Nutrition label contradicts observed behaviour | 5.1.2 | Phase 6.2 — audit every plugin before answering |
| Medical/clinical claims in the description | 1.4.1 | Phase 7.3 — no clinical framing in metadata |
| Missing privacy manifest, in the app or a dependency | — | Phase 6.1 — checked at archive time |
| Missing privacy policy URL | 5.1.1 | Phase 6.6 |
| Placeholder content, or a feature that does nothing | 2.1 / 2.3 | Phase 4.4 — no dead offline affordance |
| Crash on an older device or under Low Power Mode | 2.1 | Phase 9 |

## Appendix C — what this brief deliberately does not do

Ask me before building any of these. They are all defensible; none is in scope.

- **iPad support.** Adds a required screenshot set and a second layout to defend. `feat/launch`
  has a desktop composition that would mostly carry it, so this is cheap *later* and a distraction
  *now*.
- **Android.** Capacitor makes it close to free in effort and not at all free in support surface.
  Service workers *do* work on Android, so the offline story diverges — decide it separately.
- **Accounts, saved-route history on a server, social features, a second map provider, any new
  third-party data source.** Same list `feat/launch` refused, for the same reasons.
- **Any analytics or crash SDK.** Non-negotiable #4.
- **Live Activities, widgets, App Clips, Siri Shortcuts, Apple Watch.** All genuinely good fits for
  this app — a Live Activity showing distance to the next turn is close to ideal — and all of them
  are v2.
- **Paid tiers or IAP.** Free, no IAP, for v1.

---

## Appendix D — provenance

Written 6 August 2026 against `main` at `867e8e2`, `feat/launch` at `534c863` and
`claude/code-prompt-design-handoff-b8efa1` at `373f72d`.

Every claim in this document about the repository was checked against the tree by an independent
pass: 126 discrete claims, 117 confirmed, 9 wrong and corrected before you read this. The nine
were: the departure strip (it already exists on `feat/launch`), the inline theme script (redesign
branch only), safe-area insets (already done on `feat/launch`), the conflict count (247, not 18),
the conflict file list (five of them auto-merge), the redesign branch's commit count (25),
`MEANDER_ALLOW_LOCAL_ORIGINS` (defaults *on*, not off), `vercel.json` (moved, not copied), and
`BLOCKED.md` §2 (already resolved).

That ratio is roughly what you should expect from your own reading of this brief, so **verify
before you act** — §4 says it and it is not boilerplate. The Apple-facing facts (Xcode 26 / iOS 26
SDK since 28 April 2026, Capacitor 8's Xcode 26 minimum and SPM default, the 6.5"/6.9" screenshot
requirement, the quoted text of guidelines 4.2, 5.1.1(v), 5.1.2 and 2.5.4) were taken from Apple's
and Capacitor's own documentation on that date. **Re-check them at submission time** — Apple moves
these, and a stale SDK minimum is an upload rejection, not a review one.
