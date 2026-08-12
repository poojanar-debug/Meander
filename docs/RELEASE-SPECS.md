# Meander — integration specs for the dropped capabilities

Generated 2026-08-08 from a survey of `main` at `219bf77`, one agent per
capability. Each read the `feat/launch` source, the current component tree, and
the backend, then wrote a plan against **this** frontend.

**Read the spec for a capability before starting it.** Several of them found
things the release brief got wrong — the `limit_pct` field already travelling on
the wire, `OSM_DEV_TOKEN` being optional, the colour gate being incapable of
failing. Those corrections are in here, and two of them changed what got built.

⚠ These are specs, not gospel. They were written by reading, not by running. Where
one contradicts the code in front of you, the code wins — and say so in the commit.

Two of the nine are already done and are kept here for the reasoning:
`ElevationProfile` (`378beec`) and `ReportBarrier` (`898810f`).

---

## Permalink: encode the whole route request in the URL, decode it on load, and a ShareButton that copies/shares the link (lib/permalink.js + ShareButton.jsx + the check-permalink contract check)

**OPEN**

### Sources read on `feat/launch`
- git show feat/launch:frontend/src/lib/permalink.js — 135 lines (read in full)
- git show feat/launch:frontend/src/components/ShareButton.jsx — 59 lines (read in full)
- git show feat/launch:frontend/scripts/check-permalink.mjs — 131 lines (read in full)
- git show feat/launch:frontend/src/App.jsx — 522 lines (read the permalink-relevant regions: :1 imports, :12 ShareButton import, :19 permalink import, :34-57 initialState/withRefetch, :187-197 initialStateFromUrl + useReducer, :226-284 the one fetch effect, :286-300 the writeUrl effect, :440-465 the ShareButton mount)
- git show feat/launch:frontend/src/styles.css — 2024 lines (read :1-90 token block and :1665-1684 the .share/.share__status/.share__url rules, plus the print media block at :1763)

### Plan

## 0. What the launch source actually is

`feat/launch:frontend/src/lib/permalink.js` (135 lines) exports four pure-ish functions:

- `encodePlace/decodePlace` (module-private) — `lat.toFixed(6),lon.toFixed(6)`; `COORD_DP = 6` chosen to match `backend/routing.py:920 GEOCODE_COORD_DECIMALS = 6` (verified: it is 6, and `routing.py:978-979` rounds every geocode result to it). Six is therefore *lossless* for any place picked from search.
- `encodeState({origin, dest, minutes, mode, objectives})` → `'?from=…&fromName=…&to=…&toName=…&min=…&mode=…&obj=a,b'` or `''` when there is no origin. Omits `mode` when `'auto'`; omits `fromName` when the name is the geolocation sentinel `'Your location'`.
- `decodeState(search = window.location.search)` → a *partial* state or `null`. Validates every field and sets keys **conditionally**, so an unrecognised value leaves the key absent rather than `undefined` (this is what makes `{...initialState, ...decoded}` safe).
- `writeUrl(state)` — `history.replaceState`, never `pushState`; no-ops when the URL is already correct.
- `shareUrl(state)` — absolute `origin + pathname + query`.

`ShareButton.jsx` (59 lines) is a three-rung ladder: `navigator.share` → `navigator.clipboard.writeText` → a read-only `<input>` the user can copy by hand. `AbortError` from a cancelled share sheet is explicitly not a failure. Status is announced via a local `role="status"` and auto-clears after 4000 ms.

Neither file references a colour, a route palette entry, or `lib/dash.js`. The only design tokens involved are the three CSS rules at `feat/launch:frontend/src/styles.css:1665-1684`.

---

## 1. NEW FILES

### 1a. `/Users/poojana/Meander/Meander/frontend/src/lib/permalink.js` (~155 lines)

Port of the launch module with **five substantive changes**. Everything else (the coordinate precision, the conditional-key discipline, the hostile-input validation, replaceState-not-pushState) transfers verbatim.

**Change 1 — no bare `window` access.** The launch version's default parameter is `search = window.location.search` (`permalink.js:96`) and `writeUrl`/`shareUrl` touch `window` unguarded. That is why `check-permalink.mjs:33-36` had to fake a global `window`. Vitest on this repo runs in the **node** environment (no jsdom in `frontend/package.json:21-26`), so guard inside the module instead:

```js
const loc = () => (typeof window === 'undefined' ? null : window.location)

export function decodeState(search) {
  const query = search ?? loc()?.search ?? ''
  ...
}
export function writeUrl(state) {
  const l = loc()
  if (!l || typeof window.history?.replaceState !== 'function') return
  ...
}
export function shareUrl(state) {
  const l = loc()
  if (!l) return ''
  ...
}
```

**Change 2 — derive the vocabularies, do not restate them.** Launch hard-codes two literal Sets at `permalink.js:41-42`. On `main` both already exist as single sources:

```js
import { OBJECTIVES as ROUTE_OBJECTIVES } from './dash.js'   // lib/dash.js:20
import { MODE_VERB } from './format.js'                       // lib/format.js:7

const OBJECTIVES = new Set(ROUTE_OBJECTIVES.map((o) => o.id))       // fastest,scenic,accessible,quiet,shade,air
const MODES = new Set(['auto', ...Object.keys(MODE_VERB)])          // auto,foot,bike,car
```

Verified equivalent: `lib/dash.js:20-69` carries exactly the six ids launch listed, and `MODE_VERB` (`format.js:7`) carries `foot|bike|car`, which with `'auto'` is exactly the four options in `TripBar.jsx:9-14 MODES`. Neither module is a component and neither touches `import.meta.env`, so `permalink.js` stays importable under plain node.

**Change 3 — `MIN_MINUTES`/`MAX_MINUTES`/step.** Launch used `20/360` and snapped to 5. Both still hold on `main`: `App.jsx:23-24` (`MIN_MINUTES = 20`, `MAX_MINUTES = 360`) and `TimeDial.jsx:3-5` (`MIN 20`, `MAX 360`, `STEP 5`). Keep the launch constants and add a comment naming those two anchors so a future change to the dial is caught.

**Change 4 — `departAt` must be encoded. This field did not exist on `feat/launch`.** It is a real request field on `main`: `api/client.js:36` does `if (departAt) body.depart_at = departAt`. If the permalink omits it, the contract "a shared link reproduces the same request" is false for every user who has touched the departure strip. Encode it as `at`:

```js
if (departAt) params.set('at', departAt)
```

and on decode, validate **and expire** it:

```js
const at = params.get('at')
if (at) {
  const when = new Date(at)
  // The strip's own floor: DepartureStrip.jsx:33-34 builds its chips from the
  // top of the current hour, so an instant before that is one the UI cannot
  // offer and must not silently send. Drop it and say so.
  const floor = new Date(); floor.setMinutes(0, 0, 0)
  if (!Number.isNaN(when.valueOf())) {
    if (when >= floor) state.departAt = when.toISOString()
    else state.expiredDeparture = true
  }
}
```

`state.expiredDeparture` is a decode-time flag, not app state; `App`'s `init()` converts it to a one-sentence hint (§2c below). Note `when.toISOString()` rather than the raw string: it normalises `+05:30` and `Z` forms to one representation so the request body is stable.

**Change 5 — `writeUrl` never writes a geolocated origin.** `App.jsx:308-313` sets `name: 'Your location'` with the device's raw GPS fix. Continuously mirroring that into the address bar is the one thing in this feature that would make `About.jsx:30-32` ("no location history … used to answer this one request and then discarded") literally untrue, because the address bar persists into browser history. Launch already treats that string as special (it suppresses `fromName`), so reuse the same sentinel:

```js
export const GEOLOCATED = 'Your location'   // must equal App.jsx:310

export function writeUrl(state) {
  // A place the user typed is a place they chose to name. A GPS fix is not.
  // Share still works for it — but only when the user presses the button.
  if (state.origin?.name === GEOLOCATED) return
  ...
}
```

`encodeState`/`shareUrl` still encode the coordinates for a geolocated origin — the user pressing Share is an explicit act — and `ShareButton` warns before the press (§1c).

### 1b. `/Users/poojana/Meander/Meander/frontend/src/lib/permalink.test.js` (~150 lines)

The port of `check-permalink.mjs`. **Do not restore the `.mjs` script.** See §5 for the full rationale and test list.

### 1c. `/Users/poojana/Meander/Meander/frontend/src/components/ShareButton.jsx` (~80 lines)

Port of the launch component, with four changes:

1. **No second live region.** Launch used a local `<p role="status">` (`ShareButton.jsx:50`). `App.jsx:372-374` is the one polite live region for the whole app and `FollowMode.jsx:171-178` routes through it via `onAnnounce` rather than opening a second. ShareButton must do the same: take an `onAnnounce` prop, call it with the outcome sentence, and render the same sentence **visibly** as a plain `<p className="share__status">` with no `role`. (Visible *and* announced; not announced twice.)
2. **`departAt` is threaded through** so the copied link matches what is on screen: `shareUrl({ origin, dest, minutes, mode, objectives, departAt })`.
3. **A standing caveat for a geolocated origin**, rendered *before* the press, not after:
   ```jsx
   {origin?.name === GEOLOCATED && (
     <p className="field__hint">This link contains your current coordinates.</p>
   )}
   ```
4. **Target size.** `.button` already carries `min-height/min-width: var(--target)` (`styles.css:661-662`), so the button is compliant by inheriting the existing class. The fallback `<input className="share__url">` is styled by the existing `input[type='text']` rule (`styles.css:636`) — check it clears 44px or add `min-height: var(--target)` to `.share__url`.

Keep unchanged: the `navigator.share` → clipboard → visible-input ladder, the `AbortError`-is-not-a-failure branch (`ShareButton.jsx:33-35` — a cancelled share sheet must never report "failed"), the 4000 ms auto-clear, `if (!url) return null`.

---

## 2. EDITS TO EXISTING FILES (every anchor is a real line on `main`)

### 2a. `frontend/src/App.jsx:16` and `:18` — imports
Add after `App.jsx:16` (`import TripBar …`):
```js
import ShareButton from './components/ShareButton.jsx'
```
Add after `App.jsx:18` (`import { applyTheme, … } from './lib/theme.js'`):
```js
import { decodeState, writeUrl } from './lib/permalink.js'
```

### 2b. `frontend/src/App.jsx:62` — one key in `initialState`
Insert between `debounceMs: 0,` (`:62`) and the closing `}` (`:63`):
```js
  // A one-sentence explanation of something the incoming link could not be
  // honoured verbatim. Null in every other case.
  linkNote: null,
```

### 2c. `frontend/src/App.jsx:65-69` — seed the reducer from the URL
This is the whole of "decode on load triggers the fetch". Replace `init`:

```js
/** Resolved at mount rather than at module load, so the read is not a side
 *  effect of importing this file. */
function init(state) {
  const seeded = { ...state, theme: initialTheme() }
  const shared = decodeState()
  if (!shared) return seeded

  const { expiredDeparture, ...fields } = shared
  // nonce 1 rather than 0: the fetch effect ignores 0 (nothing has been asked
  // for yet), and a link *is* a request. debounceMs is already 0, so the one
  // fetch effect fires on the first render with the link's inputs — applying
  // the link in an effect instead would route the defaults first and then
  // route again, spending two requests and briefly showing the wrong answer.
  // Phase is seeded to 'loading' so the rail shows the right number of
  // skeletons immediately instead of one empty paint.
  return {
    ...seeded,
    ...fields,
    phase: 'loading',
    nonce: 1,
    debounceMs: 0,
    linkNote: expiredDeparture
      ? 'That link asked to leave at a time that has already passed. These routes are for leaving now.'
      : null,
  }
}
```

**The nonce-keyed effect at `App.jsx:206-258` is not touched — not one character.** In particular `[state.nonce]` at `:258`, the `eslint-disable-next-line react-hooks/exhaustive-deps` at `:257`, and the abort ordering at `:211-213` are all left exactly as they are. `initialState.debounceMs` is already `0` (`App.jsx:62`), so the seeded fetch fires on the next macrotask. `{phase:'loading', progress:null}` is an already-reachable state (`App.jsx:118` produces it), so `StatusBanner` and `RouteRail` need no change; `RouteRail.jsx:32` `showSkeletons` becomes true and `expected` (`App.jsx:440`) is the link's own `objectives.length`.

StrictMode note: `main.jsx:12` wraps in `<StrictMode>`, so React calls `init` twice in dev. `decodeState` is pure and reads a stable `window.location.search`, so this is harmless.

### 2d. `frontend/src/App.jsx:71-73` — clear the note on any refetch
```js
function withRefetch(state, patch, debounceMs) {
  return { ...state, ...patch, nonce: state.nonce + 1, debounceMs, error: null, linkNote: null }
}
```
One added key in an existing object literal. Rule 8 forbids restructuring the reducer; this is the same shape of addition the codebase's own extension recipe uses.

### 2e. `frontend/src/App.jsx:260` — the URL-writing effect (new, separate)
Insert immediately after `useEffect(() => () => abortRef.current?.abort(), [])` at `:260`:

```js
  // The address bar follows the controls. replaceState, never pushState — a
  // slider drag would otherwise put fifty entries behind the back button.
  // Deliberately its own effect: folding it into the nonce effect would mean
  // adding these six values to that dependency array, which is exactly what
  // the comment at :255-257 forbids.
  useEffect(() => {
    writeUrl({
      origin: state.origin,
      dest: state.dest,
      minutes: state.minutes,
      mode: state.mode,
      objectives: state.objectives,
      departAt: state.departAt,
    })
  }, [state.origin, state.dest, state.minutes, state.mode, state.objectives, state.departAt])
```

This effect dispatches nothing, reads no design tokens, and therefore has no interaction with the `useLayoutEffect` ordering guarantee at `App.jsx:273-275`.

### 2f. `frontend/src/App.jsx:418` — render the link note
Insert between `</DepartureStrip>` (`:417`) and `<div id="results">` (`:419`):
```jsx
          {state.linkNote && <p className="field__hint">{state.linkNote}</p>}
```
**Not inside `DepartureStrip`.** `DepartureStrip.jsx:21` returns `null` whenever `best_departure` is absent, which is the common case; anything mounted inside it disappears. `App.jsx:431-433` already works around exactly this for `state.reason`, and this follows that precedent.

### 2g. `frontend/src/App.jsx:457-458` — mount `ShareButton`
Insert between `</RouteDetail>` (`:457`) and `</div>` (`:458`, closing `#results`):
```jsx
            {hasRoutes && (
              <ShareButton
                origin={state.origin}
                dest={state.dest}
                minutes={state.minutes}
                mode={state.mode}
                objectives={state.objectives}
                departAt={state.departAt}
                onAnnounce={announce}
              />
            )}
```
`hasRoutes` is already computed at `App.jsx:341`. This mirrors launch's placement (after the route list, gated on `hasRoutes`) and keeps the link at the level of the *search*, which is what it encodes — not at the level of the selected route.

**Rejected mount points, and why:**
- `RouteDetail.jsx:175` (the generic `children` slot) — the link reproduces the search, not the route; and `RouteDetail.jsx:177-180` is a standing prohibition (see 2i).
- `RouteRail.jsx:41` (the empty right-hand slot in `.results-head`) — `.results-head` is `display:flex; align-items:baseline` (`styles.css:264-270`); ShareButton is a three-element vertical stack with a 44px control, which baseline-aligns badly against an `<h2>`. Also `RouteRail.jsx:34` returns `null` on zero routes, which would hide the control's own layout box mid-stream.

### 2h. `frontend/src/components/About.jsx:29-33` — make the privacy paragraph true again
The link now puts coordinates in the address bar for searched origins. Amend to:
```jsx
        <p>
          Nothing is stored. No cookies, no analytics, no location history — your coordinates are
          used to answer this one request and then discarded. The only thing kept in this browser
          is whether you chose the light or the dark theme.
        </p>

        <p>
          One exception you can see: your search is kept in the address bar, so a reload keeps it
          and the link is shareable. A location taken from your device is never written there —
          only a place you searched for. Nothing is added to the back button either way.
        </p>
```
`FirstRun.jsx:112-115` and `FollowMode.jsx:239-241` need **no** change: the first is about storage, the second about live position during follow mode, and neither claim is affected.

### 2i. `frontend/src/components/RouteDetail.jsx:177-180` — retire a comment whose premise is now false
The comment currently reads, in part, that "the app holds no state in the URL, so a share link would point at the front door and say nothing about the route." That is the exact condition this change removes. Replace with:
```jsx
      {/* Still no Save — §6.8 is deferred. Share is no longer here either, but
          for a different reason: the link encodes the *search*, not the
          selected route, so it belongs beside the rail (App.jsx, inside
          #results) rather than inside one route's detail. */}
```

### 2j. `frontend/src/styles.css:110` — a monospace family token
Insert after `--font-body` (ends `:110`), inside the theme-invariant `:root` (`:106-138`):
```css
  /* A URL is checked character by character; a proportional face makes 1/l and
     0/O ambiguous. System stack only — a webfont would be a third-party
     request (see the file header, :4-6). */
  --font-mono: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
```

### 2k. `frontend/src/styles.css:1720` — the `.share` section, appended at end of file
The responsive block sits mid-file (`:1409-1486`), so new sections go at the end and carry their own media queries. Append after `:1720`:
```css
/* ----------------------------------------------------------------- share */

.share {
  display: flex;
  flex-direction: column;
  gap: var(--s2);
  align-items: flex-start;
  margin-top: var(--s4);
}
.share__status {
  margin: 0;
  font-size: var(--t-small);
  color: var(--ink-2);
}
.share__status:empty {
  display: none;
}
.share__url {
  align-self: stretch;
  min-height: var(--target);
  font-family: var(--font-mono);
  font-size: var(--t-small);
}
```
Zero hex literals, so `ci.yml:149-170` (`no-hard-coded-colour`) passes unchanged.

### 2l. `.github/workflows/deploy.yml:54-55` — delete a comment that was already false
The two comment lines claim `npm run build` runs `check:palette`, `check:permalink` and `check:offline`. None of those scripts exist (`frontend/package.json:11` is a bare `vite build`). Because this spec puts the permalink contract in `npm test` rather than in a build hook, replace both lines with the truth:
```yaml
        # The permalink contract and the sun/follow suites run in ci.yml's
        # `frontend` job (npm test) and in `make check`. This step only builds.
```
Do **not** add a `check:permalink` npm script. Wiring one into `package.json:11` would put a gate on the deploy path only, invisible to `make check` and to `ci.yml`'s frontend job — the exact asymmetry `Makefile:62-70` was written to avoid.

### 2m. `frontend/vercel.json` — verify, do not edit
`vercel.json:8` is already `{"source": "/((?!assets/).*)", "destination": "/index.html"}`. See §6 for why this is *not* the hazard the brief describes.

---

## 3. TOKEN MAPPING

Every token the launch source touches, and its replacement. **No `--space-*`, `--text-*`, `--ink: #14213d`, or launch route colour may appear in the ported files.**

| Launch token | Launch value | Where used in this capability | Current replacement | Current value | Note |
|---|---|---|---|---|---|
| `--space-4` | 16px | `styles.css:1666` `.share { margin-top }` | `--s4` | 16px | exact |
| `--space-2` | 8px | `styles.css:1669` `.share { gap }` | `--s2` | 8px | exact |
| `--text-1` | 0.875rem (14px) | `:1674` `.share__status`, `:1681` `.share__url` | `--t-small` | 0.8125rem (13px) | **not exact.** 13px is the established secondary-text size on `main` — `.field__hint` uses it (`styles.css:625`), as do `.sheet__row` and `.detail__figures`. Matching the neighbours beats matching the old pixel value. Do **not** introduce a 14px token. |
| `--ink-muted` | `#545f71` | `:1675` `.share__status { color }` | `--ink-2` | `#55645a` light / `#9baea1` dark (`styles.css:23`, `:72`) | The redesign's muted ink. Themed in both blocks already. |
| `--page` | `#f7f4ee` | not used here | `--paper` | `#f6f3ec` / `#0c1611` | listed for completeness |
| `--recessed` | `#f2eee5` | not used here | `--sunken` | `#ede9df` / `#080f0b` | |
| `--ink` | `#14213d` (navy) | not used here | `--ink` | `#16241c` / `#e8efe8` | **Same name, different value.** The launch navy must never be written as a literal; the name already resolves correctly on `main`. |
| `--radius-control` | 6px | not used here | `--r-sm` | 8px | if any radius is needed on `.share__url` |
| `--radius-card` | 8px | not used here | `--r-md` | 12px | |
| `--radius-chip` | 999px | not used here | `--r-pill` | 999px | exact |
| `--rule` | `#ddd6c6` | not used here | `--rule` | `#dcd5c6` / `#26362c` | same name |
| `--font-body` | same declaration | inherited via `font: inherit` on `.button` | `--font-body` | identical stack (`styles.css:109-110`) | no change |
| *(none — launch hard-coded the stack at `styles.css:1682`)* | `ui-monospace, SFMono-Regular, Menlo, monospace` | `.share__url` | **new** `--font-mono` | see §2j | Launch inlined the family; on `main` families are tokens, so add one. Not a colour, so the `ci.yml` hex gate is unaffected. |
| **Launch route palette** — `--route-fastest #2f6fd0`, `--route-scenic #2e8b57`, `--route-accessible #7a4fc4`, `--route-quiet #b06a1f`, `--route-shade #12756c`, `--route-air #b03050`, plus `--score-scenic/-air/-shade` aliases | | **not used by this capability at all** | `--route-*` on `main` (`styles.css:44-49` / `:86-91`) and their `lib/dash.js:20-69` mirrors | | `permalink.js` and `ShareButton.jsx` reference no colour. The only contact point is `permalink.js` importing `OBJECTIVES` from `dash.js` for its **id set** — the `color`/`colorDark` fields are never read. Nothing in this change may write a route hex. |
| `--selected-border`, `--warn-border`, `--map-casing` | | not used here | `--rule-strong`, `--warn-rule`, *(no equivalent — the redesign has no map casing token)* | | listed so an implementer who copies a neighbouring launch rule by accident knows what to do |

**Verification step for the implementer:** after adding the `.share` section, `grep -n -E "\-\-space-|\-\-text-|\-\-ink-muted|\-\-page\b|\-\-recessed|\-\-radius-" frontend/src/styles.css frontend/src/components/ShareButton.jsx frontend/src/lib/permalink.js` must return nothing.

---

## 4. PROJECT RULES AND HOW THE DESIGN SATISFIES EACH

**R1 — A missing OSM tag means UNKNOWN, never "accessible".**
Not directly engaged (no scores travel in the URL). The same *discipline* is applied to link input twice, and both are load-bearing: (a) `decodeState` sets keys **conditionally**, so an unrecognised `mode=teleport` leaves the key absent and `{...initialState, ...decoded}` keeps `'auto'` — it never becomes `undefined` and then `mode: undefined` in the request body; (b) an `at` in the past is dropped rather than sent, because a departure time the UI cannot offer is not a departure time it should claim. The user is told (`state.linkNote`) rather than silently given a different answer.

**R2 — Colour is never the only differentiator; must survive greyscale.**
ShareButton adds no colour-carrying state. Copy/failure are distinguished by **sentence text**, not by a green/red tint: "Link copied. It reproduces these exact routes." vs "Could not copy automatically — the link is below." The failure state additionally changes the DOM (a visible `<input>` appears), which is a structural, not chromatic, difference. `.share__status` uses `--ink-2`, the same neutral as every other hint.

**R3 — The route list is a complete text substitute for the map.**
Untouched. The permalink adds nothing to the map and removes nothing from the rail. `MapView` is not re-mounted or re-gated: `App.jsx:466` still gates on `hasRoutes`, and the first-run gate at `App.jsx:352` still keys on `origin`. A link seeds `origin`, so first-run is skipped and the panel renders — the single-MapLibre-instance rule (`App.jsx:348-352`, `MapView.jsx:148-189`) is unaffected because the map is still created once, on the first render where routes exist, and never unmounted.

**R4 — No location history, no cookies, no analytics; localStorage is theme and units ONLY.**
This is the rule this capability comes closest to, so it is satisfied by four separate mechanisms:
- **No storage of any kind.** `permalink.js` touches no `localStorage`, `sessionStorage`, `indexedDB` or cookie. The two existing storage touch points (`lib/theme.js:20`, `:29`, key `meander:theme`) and the pre-paint duplicate at `index.html:28` stay the only ones. `About.jsx`'s "the only thing kept in this browser" sentence remains true.
- **No history entries.** `replaceState`, never `pushState` (`permalink.js` `writeUrl`), and an early return when the URL is already correct. Dragging the time dial produces zero back-button entries.
- **A device GPS fix is never auto-written.** `writeUrl` returns early on `origin.name === 'Your location'` (§1a change 5). Only a place the user searched for goes into the address bar.
- **Explicit consent for the rest.** A geolocated origin *can* be shared, but only when the user presses the button, and `ShareButton` states "This link contains your current coordinates." before the press.
- **No analytics.** The link is generated in-page; nothing is reported anywhere.

**R5 — No new third-party runtime requests.**
`permalink.js` and `ShareButton.jsx` make **zero** network calls. `navigator.share` and `navigator.clipboard` are platform APIs, not requests. `--font-mono` is a system stack — no `@font-face`, no CDN (`styles.css:4-6`). The two `fetch` call sites in the app (`client.js:75`, `:132`) are unchanged, so `vercel.json:28`'s `connect-src` needs no new host.

**R6 — All interactive targets ≥ 44×44 px.**
The Share control uses the existing `.button` class, which already sets `min-height: var(--target); min-width: var(--target)` (`styles.css:661-662`). The fallback URL field gets an explicit `min-height: var(--target)` in `.share__url` (§2k). No new sub-44px control is introduced — and note the two *pre-existing* violations (`.theme-toggle` 36px at `styles.css:406`, `.preset` 36px at `:527`) are not a precedent to copy.

**R7 — One live region for the whole app.**
`ShareButton` takes `onAnnounce` and calls `App.jsx:198-202 announce` rather than rendering its own `role="status"`. This is the change from the launch component (`ShareButton.jsx:49-53`) and it follows `FollowMode.jsx:171-178`. The visible `.share__status` paragraph carries no `role`, so nothing is announced twice.

**R8 — Do not restructure the nonce-keyed fetch effect.**
Satisfied by seeding, not by dispatching. `App.jsx:206-258` is byte-identical after this change: same body, same `[state.nonce]` dependency array at `:258`, same `eslint-disable-next-line` at `:257` (which must survive or `ci.yml`'s frontend job fails lint), same abort-inside-the-timer ordering at `:211-213`. A link arrives as `nonce: 1, debounceMs: 0` out of `init()`, and the effect that already exists does the rest. The URL-*writing* effect is a separate `useEffect` added after `:260` with its own dependency array; it never dispatches, so it cannot feed back into the fetch.

**R9 — Strict two-level BEM, state read from ARIA not from JS-toggled classes.**
`share`, `share__status`, `share__url` — one block, two elements, no modifiers, no third level. The component has no toggled visual state class: the two outcomes differ by *text content* and by whether the `<input>` is in the DOM.

**R10 — `null` ≠ `0` ≠ `[]`.**
`encodeState` returns `''` (not `null`, not a bare `'?'`) when there is no origin, and `ShareButton` returns `null` on an empty url. `decodeState` returns `null` for "no link", and omits keys rather than emitting `undefined`. An `obj=` that filters down to empty leaves `objectives` absent so `initialState`'s `['fastest','scenic','accessible']` survives — it does not become `[]`, which would render an empty rail the user cannot recover from (the condition `App.jsx:87-88` exists to prevent).

---

## 5. TESTS

### 5a. Where, and why not a `.mjs` script

**Put the contract in vitest at `/Users/poojana/Meander/Meander/frontend/src/lib/permalink.test.js`, and do not restore `frontend/scripts/check-permalink.mjs`.** Three concrete reasons:

1. **It runs everywhere for free.** `npm test` is already `ci.yml:140-144` (frontend job, `TZ: UTC`) and `Makefile:53-54` (`make check`). A `check:permalink` npm script chained into `package.json:11 build` would run on the deploy path and in `make build`, but **not** in the `frontend` CI job's test step — the same split-gate problem `Makefile:62-70` documents and `deploy.yml:54-55` currently lies about.
2. **It deletes the module-slicing hack.** `check-permalink.mjs:26-31` reads `client.js` as text and rebuilds `buildRouteRequest` with `new Function(source.slice(indexOf('export function buildRouteRequest'), indexOf('export class ApiError')))` because plain node cannot resolve `import.meta.env`. Under vitest the vite transform handles it, so the test just does `import { buildRouteRequest } from '../api/client.js'`. The slice would still work today (`client.js:28` and `client.js:39` are in the right order) but it breaks silently the moment someone reorders that file.
3. **`TZ: UTC` is already pinned** at `vite.config.js:32`, which the `departAt` expiry tests need. A standalone `.mjs` would inherit the developer's timezone — precisely the failure mode that comment was written about.

### 5b. The suite — 16 cases

Ported from `check-permalink.mjs:57-129`, with four new ones for `departAt` and two for the geolocation guard.

`describe('encode / decode round trip')`
1. **round trip preserves every field** — origin name, dest name, minutes, mode, objectives array (deep equal). Fixture: `{origin:{lat:6.933727,lon:79.85008,name:'Colombo Fort'}, dest:{lat:51.507489,lon:-0.162207,name:'Hyde Park'}, minutes:65, mode:'bike', objectives:['scenic','accessible']}`.
2. **THE CONTRACT: the same request body comes out the other side** — `expect(buildRouteRequest({...FULL, ...decodeState(encodeState(FULL))})).toEqual(buildRouteRequest(FULL))`. This is the one that matters; it is why `COORD_DP` is 6.
3. **coordinates survive to routing precision** — `|Δlat| < 1e-5`, `|Δlon| < 1e-5`.
4. **a loop has no destination rather than a null one** — with `dest: null`, `decoded.dest` is `undefined` and `'destination' in buildRouteRequest(...)` is `false` (guards `client.js:35`).
5. **no origin means no link at all** — `encodeState({...FULL, origin:null}) === ''` and `shareUrl(...) === ''`.
6. *(new)* **an unset optional key is absent, not undefined** — `expect('mode' in decodeState('?from=6.9,79.8')).toBe(false)`; same for `dest`, `minutes`, `objectives`, `departAt`. This is what makes the spread in `init()` safe.

`describe('departure time')` *(all new — `departAt` did not exist on feat/launch)*
7. **a future departure round-trips into the request body** — `departAt` one hour ahead; `buildRouteRequest` before and after are `toEqual`, and `body.depart_at` is present in both.
8. **a departure before the current hour is dropped and flagged** — `at` set to two hours ago; `decoded.departAt` is `undefined`, `decoded.expiredDeparture` is `true`.
9. **a departure inside the current hour is kept** — `at` set to `now` with minutes zeroed; kept (matches the floor `DepartureStrip.jsx:33-34` uses to build its chips).
10. **a garbage timestamp is dropped without flagging an expiry** — `?at=yesterday` → `departAt` undefined, `expiredDeparture` undefined.

`describe('hostile input: somebody else wrote this link')`
11. **a garbage coordinate is rejected outright** — `?from=notacoord`, `?from=999,999`, `?from=51.5` all → `null`.
12. **minutes is clamped to the range the dial can show** — `min=99999` → undefined; `min=-5` → undefined; `min=63` → `65` (snapped to the 5-minute step, matching `TimeDial.jsx:5 STEP`).
13. **an unknown mode or objective is dropped, not passed through** — `mode=teleport` → undefined; `obj=scenic,rm -rf,air` → `['scenic','air']`.
14. **objectives are deduplicated and capped at three** — `obj=scenic,scenic,air,shade,quiet,fastest` → length 3, all distinct (matches the `.slice(-3)` cap at `App.jsx:90`).
15. **a hostile name cannot be unbounded** — 5000-character `fromName` → `origin.name.length <= 120`.
16. **a missing name degrades to the coordinates** — `decodeState('?from=51.50749,-0.16221').origin.name` matches `/51\.5/`.

`describe('writeUrl and shareUrl')` — these need a `window`; stub it per-test with `vi.stubGlobal`, and `vi.unstubAllGlobals()` in `afterEach`:
17. *(new)* **a geolocated origin is never written to the address bar** — with `origin.name === 'Your location'`, `writeUrl` leaves `replaceState` uncalled (spy, `toHaveBeenCalledTimes(0)`); but `shareUrl` still returns a non-empty URL containing the coordinates.
18. *(new)* **`writeUrl` uses replaceState, never pushState** — spy on both; `pushState` must be `toHaveBeenCalledTimes(0)`. This is the "no location history" rule as an executable assertion.
19. **"Your location" is not put in a shared link's name** — `encodeState` output does not contain `fromName` (ported from `check-permalink.mjs:86-89`).

### 5c. What is deliberately not tested, and why

**No ShareButton component test.** There is no `jsdom` and no `@testing-library/react` in `frontend/package.json:21-26`, and this repo has zero component tests. Adding either means new devDependencies for one component. Instead, the logic worth asserting lives in `permalink.js` (`shareUrl`) and is covered above; the component is a three-branch ladder over two platform APIs. The a11y story for it is the existing manual harness — **add `.share button` coverage there**: `frontend/src/a11y.jsx:53` is `const ROW_SELECTOR = 'button.route, .card'`; the harness's target-size and axe passes (`a11y.jsx:85`, `:88`) will pick the new button up automatically since they run over the whole document, but a reviewer should run `frontend/a11y.html` once with a permalink in the query string to confirm the seeded-from-URL path renders clean.

**No backend test.** The permalink is client-only; no endpoint, no model, no new field on the wire. `backend/routing.py:920 GEOCODE_COORD_DECIMALS = 6` is already asserted by `backend/tests/test_geocode.py:60-63`, which is the anchor `COORD_DP` depends on — cite it in a comment in `permalink.js` so the coupling is discoverable from the JS side.

---

## 6. WHERE THE BRIEF IS WRONG

**(a) "This depends on the Cloudflare Pages SPA rewrite being scoped to exclude `/api/*`; a bare catch-all breaks it in a way that looks like a frontend bug." — The premise about permalinks is wrong, and on the shipped deployment the hazard does not exist at all.**

Three separate corrections:

1. **Permalinks do not need an SPA rewrite.** They are **query-string-only**. `encodeState` returns `'?…'`, and `writeUrl` composes `` `${window.location.pathname}${query}` `` — the pathname is carried through unchanged and is always whatever the app was loaded at (`/`). No permalink ever creates a new path segment. A bare `/* /index.html 200` maps `/` to `index.html`, which is what already happens. **The link resolves fine either way.** The permalink is a bystander here, not a dependent.
2. **The real hazard is `/api/*`, and it is not permalink-specific.** A bare catch-all turns any same-origin `/api` call into `200 text/html`. `client.js:89` tests `!contentType.includes('text/event-stream')`, takes the JSON branch, and `client.js:90` calls `res.json()` on HTML → a raw `SyntaxError`, which `toApiError` never sees because that path only runs on `!res.ok` (`client.js:86`). That breaks *every* request — first load, dial drag, retry — not just links opened from a permalink. The brief's own `docs/RELEASE-PROMPT.md:598-608` states this correctly; the trailing sentence at `:607-608` ("This also breaks Phase 4's permalinks in a way that looks like a frontend bug") is the part that misattributes it.
3. **On what actually ships, the hazard is already closed twice over.** `deploy.yml` publishes to S3/CloudFront, not Cloudflare Pages. `infra/30-web.yaml:187-199` gives `/api/*` its own CloudFront behaviour pointed at the ALB, and `infra/30-web.yaml:212-218` applies `CustomErrorResponses` only to the default behaviour — the template says so in a comment at `:213-216`: an API 404 "travels through untouched because `/api/*` is a different behaviour". Separately, `vercel.json:8` is already scoped as `/((?!assets/).*)`. So there is nothing to fix for this capability today; the warning is a live constraint on a *future* Cloudflare Pages `_redirects` file, which does not exist (`grep` for `_redirects` across the repo returns nothing).

**(b) "lib/permalink.js (135 lines) + ShareButton" understates the port.** `permalink.js` is 135 lines and `ShareButton.jsx` is 59, both correct. But the launch module has **no concept of `departAt`**, because `DepartureStrip` is a redesign-era feature that postdates `feat/launch`. A straight port therefore **breaks its own headline contract** on `main`: `client.js:36` puts `depart_at` in the request body, so any user who has picked a departure hour would share a link that produces a different answer than the one they were looking at. That is exactly the failure `check-permalink.mjs`'s central assertion exists to prevent. Encoding `at` (§1a change 4) is not an enhancement; it is required for the ported test to be honest.

**(c) "check-permalink.mjs came with it" — restoring it is the wrong move, and two of its mechanics no longer hold.** It is 131 lines and it is a good test *suite*, but as a script it (i) needs a faked global `window` (`:33-36`), (ii) reconstructs `buildRouteRequest` by slicing `client.js` as a string and `new Function`-ing it (`:26-31`), and (iii) would have to be wired into `package.json:11` — which is the very chaining `deploy.yml:54-55` already falsely claims exists, and which `make check` and `ci.yml`'s frontend test step would still not run. Port the assertions to vitest; drop the script.

**(d) A rule collision the brief does not mention at all.** `frontend/src/components/RouteDetail.jsx:177-180` is a standing in-code prohibition: "No Share or Save … the app holds no state in the URL, so a share link would point at the front door and say nothing about the route." That comment is not decoration — it is the reason there is no Share control on `main`. Shipping this capability requires editing it (§2i), and an implementer who mounts ShareButton without doing so leaves the codebase asserting the opposite of what it does.

**(e) A privacy collision the brief does not mention.** `App.jsx:308-313` sets `name: 'Your location'` with the device's raw GPS coordinates, and `About.jsx:30-32` promises "no location history — your coordinates are used to answer this one request and then discarded." The launch `writeUrl` would mirror that GPS fix into the address bar on every state change, and the address bar persists into browser history. The launch module's header comment acknowledges the general tension but does **not** distinguish a searched place from a device fix. §1a change 5 and §2h close this; without them the change ships a false statement in the About panel.

### Risks and the rules that constrain it

**What could break**

1. **The nonce-keyed fetch effect (`App.jsx:206-258`) is the highest-risk surface and this design does not touch it.** The seeding approach (`nonce: 1, debounceMs: 0` out of `init()`) is what makes that possible. Any implementer tempted to "apply the link in a useEffect" instead will (a) fire two requests — defaults then link — and briefly show the wrong routes, and (b) need to add dependencies to `[state.nonce]` at `:258`, which the comment at `:255-257` forbids and which `react-hooks/exhaustive-deps` would then flag. **The `eslint-disable-next-line` at `App.jsx:257` must survive verbatim or `ci.yml`'s frontend job fails.**

2. **`withRefetch` (`App.jsx:71-73`) is the single funnel for seven action types.** Adding `linkNote: null` is one key in an existing literal, but a typo there breaks minutes, mode, objectives, origin, dest, retry and departAt simultaneously. Verify by exercising each once.

3. **Conditional-key discipline in `decodeState` is load-bearing.** If a validation branch ever assigns `state.mode = undefined` instead of skipping the assignment, `{...initialState, ...decoded}` will overwrite `'auto'` with `undefined`, and `buildRouteRequest` (`client.js:32`) will put `mode: undefined` in the body — which `JSON.stringify` drops, silently changing what the backend receives. Test 6 in §5b exists specifically to catch this.

4. **StrictMode double-invokes `init()`** (`main.jsx:12`). `decodeState` must stay pure — no `history` writes, no announcements, no fetch.

5. **The new URL-writing effect refires on every `objectives` toggle** because the reducer produces a new array (`App.jsx:89-91`). That is correct and cheap (`replaceState` plus an equality guard), but it must never be merged into the fetch effect.

6. **`phase: 'loading'` seeded at mount** puts `StatusBanner` into `{phase:'loading', progress:null}` before any progress event. That combination is already reachable via `App.jsx:118` (`case 'loading'` sets `progress: null`), so it is not a new state — but confirm `StatusBanner.jsx:39,51,54` (which read `progress.pct`) are null-guarded before relying on it.

7. **`DepartureStrip.jsx:21` returns `null` whenever `best_departure` is absent.** Mounting the `linkNote` hint inside it would make it invisible in the common case. It goes at `App.jsx:418`, outside, following the precedent already set for `state.reason` at `App.jsx:431-433`.

8. **Coordinate precision is a contract, not a preference.** `COORD_DP = 6` matches `backend/routing.py:920 GEOCODE_COORD_DECIMALS = 6` (asserted by `backend/tests/test_geocode.py:60-63`). Five decimals shortens the URL and breaks byte-identity of the request body. The launch comment records that this was tried and caught.

9. **`origin.name === 'Your location'` is a string sentinel duplicated across three places once this lands** (`App.jsx:310`, `permalink.js` `encodeState`, `permalink.js` `writeUrl`). Export it as a constant from `permalink.js` and have `App.jsx:310` import it, or the guard silently stops working the day someone rewords the label.

**Project rules that constrain this**

- **Rule 8 — do not restructure the reducer or the one fetch effect.** Satisfied by seeding; the effect is byte-identical afterwards.
- **No location history / no cookies / no analytics; localStorage is theme and units only.** No storage touched; `replaceState` only; a device GPS fix is never auto-written; `About.jsx:29-33` amended so the visible promise matches the behaviour.
- **One live region.** `ShareButton` announces through `App.jsx:198-202 announce` via an `onAnnounce` prop, not a second `role="status"` — the launch component had one at `ShareButton.jsx:50` and it must not be ported as-is.
- **Colour is never the only differentiator.** Outcomes differ by sentence text and by DOM structure, never by hue.
- **All targets ≥ 44×44.** Inherited from `.button` (`styles.css:661-662`); `.share__url` gets an explicit `min-height: var(--target)`.
- **No hard-coded hex outside the two `:root` blocks** — enforced by `ci.yml:149-170`. The `.share` section introduces no colour literal.
- **No new third-party runtime requests.** Zero network calls added; `--font-mono` is a system stack, no `@font-face`.
- **Launch tokens are forbidden.** `--space-*`, `--text-*`, `--ink-muted`, `--page`, `--recessed`, `--radius-*` and the launch route palette must not appear; §3 gives the replacement for each, and the grep in §3 is the check.
- **Two-level BEM, state styled off ARIA.** `share` / `share__status` / `share__url`, no modifiers, no `is-` classes.
- **`RouteDetail.jsx:177-180`** is an in-code prohibition on a Share control that must be edited, not ignored.

### Tests

**New file: `/Users/poojana/Meander/Meander/frontend/src/lib/permalink.test.js`** — a vitest suite (not a restored `frontend/scripts/check-permalink.mjs`). It is picked up automatically by `npm test` (`frontend/package.json:13`), which already runs in `ci.yml:140-144` with `TZ: UTC` and in `make check` via `Makefile:53-54`. No new npm script, no new CI wiring, no edit to `frontend/package.json:11`. Because vitest applies the vite transform, the test imports `buildRouteRequest` directly from `../api/client.js` instead of the string-slicing `new Function` hack at `check-permalink.mjs:26-31`. Vitest's environment is node (no jsdom in devDeps), so `permalink.js` must guard its own `window` access and only the `writeUrl`/`shareUrl` cases need `vi.stubGlobal('window', …)` with `vi.unstubAllGlobals()` in `afterEach`.

Sixteen cases in four describes:

`encode / decode round trip` — (1) round trip preserves every field; (2) **THE CONTRACT**: `buildRouteRequest({...FULL, ...decodeState(encodeState(FULL))})` deep-equals `buildRouteRequest(FULL)`; (3) coordinates survive to routing precision (<1e-5, anchored to `backend/routing.py:920 GEOCODE_COORD_DECIMALS = 6`); (4) a loop has no destination rather than a null one — `'destination' in body === false`, guarding `client.js:35`; (5) no origin means no link at all — `encodeState` returns `''` and `shareUrl` returns `''`; (6) *new* — an unset optional key is **absent, not `undefined`** (`'mode' in decoded === false`), which is what makes the spread in `init()` safe.

`departure time` *(all new; `departAt` does not exist on feat/launch)* — (7) a future departure round-trips and `depart_at` is byte-identical in the request body; (8) a departure before the top of the current hour is dropped and `expiredDeparture` is set (floor matches `DepartureStrip.jsx:33-34`); (9) a departure inside the current hour is kept; (10) a garbage timestamp is dropped without flagging an expiry.

`hostile input: somebody else wrote this link` (ported from `check-permalink.mjs:92-129`) — (11) `?from=notacoord`, `?from=999,999`, `?from=51.5` all decode to `null`; (12) `min=99999`/`min=-5` dropped, `min=63` snaps to `65` (matching `TimeDial.jsx:5 STEP = 5`); (13) `mode=teleport` dropped, `obj=scenic,rm -rf,air` → `['scenic','air']`; (14) objectives deduplicated and capped at three (matching `App.jsx:90 .slice(-3)`); (15) a 5000-character `fromName` is truncated to ≤120; (16) a missing name degrades to the coordinates.

`writeUrl and shareUrl` (needs a stubbed `window`) — (17) *new* — a geolocated origin (`name === 'Your location'`) leaves `history.replaceState` uncalled while `shareUrl` still returns a usable link; (18) *new* — `pushState` is never called, which is the "no location history" rule as an executable assertion; (19) `encodeState` never emits `fromName` for `'Your location'` (ported from `check-permalink.mjs:86-89`).

**Deliberately no ShareButton component test.** `frontend/package.json:21-26` has no jsdom and no `@testing-library/react`, and the repo has zero component tests; adding either for one component is not worth a new devDependency. The testable logic (`shareUrl`) is covered above. Its accessibility is covered by the existing manual harness at `frontend/a11y.html` / `frontend/src/a11y.jsx` — run it once with a permalink in the query string so the seeded-from-URL path is audited, and note the axe and target-size passes at `a11y.jsx:85` and `:88` scan the whole document, so the new `.share button` is picked up without editing `ROW_SELECTOR` at `a11y.jsx:53`.

**No backend test.** The permalink is client-only: no endpoint, no model field, nothing new on the wire. The one backend coupling — six-decimal geocode rounding — is already asserted by `backend/tests/test_geocode.py:60-63`; cite that file in a comment beside `COORD_DP` in `permalink.js` so the coupling is discoverable from the JS side.

---

## env(safe-area-inset-*) — notch and home-indicator handling, ported from feat/launch into the redesign frontend on main

**OPEN**

### Sources read on `feat/launch`
- feat/launch:frontend/src/styles.css — 2024 lines. Read in full for `safe-area|env(|dvh|100vh` (9 hits for --safe-*), then read :1-140 (token block, incl. the --safe-* declarations at :98-101 and their comment at :94-97), :248-303 (.app/.shell/.header/.topbar), :440-610 (.sheet--peek :457, .sheet--full :478, .sheet__scroll :512-513, .sheet__snaps :520-521, .controls-sheet__bar :585-586, .controls-sheet__scroll :595-596), :996-1030 (MapLibre control rules incl. .maplibregl-ctrl-top-right :1022), :1570-1650 (desktop media query that unwinds the sheet).
- feat/launch:frontend/index.html — 34 lines. Read :1-30. Confirms viewport-fit=cover at :5 and the manifest/icon block at :11-15 (out of scope here).
- feat/launch:frontend/scripts/gate.mjs — 254 lines. Grepped for the viewport mechanism: Emulation.setDeviceMetricsOverride at :74-78 (width/height/deviceScaleFactor:2/mobile), 390x844 at :7, :136-137, :185; 320x844 at :172. This is the evidence for the 'cannot be verified in CI' claim.
- feat/launch:frontend/src/components/Topbar.jsx — 0 lines (does not exist on feat/launch; the launch top bar is .topbar__origin/.topbar__time, styled only in CSS). Checked so the topbar mapping is grounded.

### Plan

== A. SCOPE ==

One file changes: /Users/poojana/Meander/Meander/frontend/src/styles.css. Twelve anchored edits plus one new section appended at the end.

ZERO JSX changes, zero JS changes, zero dependency changes, zero build changes. frontend/index.html needs NO edit: it already carries `viewport-fit=cover` at index.html:5. That is the whole reason this is urgent rather than cosmetic — main is currently opted into painting under the notch with not one inset handled, which is the state the launch comment (feat/launch:styles.css:96-97) calls "strictly worse than not opting in at all".

Verified absent on main: `grep -rn "safe-area\|--safe-\|env(" frontend/src frontend/index.html frontend/a11y.html` returns nothing.


== B. NEW FILES ==

1. /Users/poojana/Meander/Meander/frontend/src/styles.safe-area.test.js — the only new file. Source-text invariant suite over styles.css and index.html. Responsibilities and contents in the `tests` field. Placed next to its subject (styles.css) rather than in lib/, because its subject is the stylesheet, not a module; picked up by vitest's default include with no config change.

No new CSS file, no new component, no new lib module. A safe-area "module" would be wrong: nothing in JS reads these values, and reading device geometry back through getComputedStyle would be a fingerprinting surface for no gain. Unlike --route-*, these tokens are NOT mirrored in lib/dash.js.


== C. EDITS TO EXISTING FILES (all anchors are current-tree line numbers on main) ==

--- EDIT 1 · styles.css:137 — declare the tokens ---
The theme-invariant :root block is styles.css:106-138. Insert after line 137 (`  --target: 44px;`), before the closing `}` at :138. This block, not either colour block: safe insets are device geometry, exactly like --target, and are theme-invariant by the same argument the comment at :104-105 already makes.

    --safe-top: env(safe-area-inset-top, 0px);
    --safe-right: env(safe-area-inset-right, 0px);
    --safe-bottom: env(safe-area-inset-bottom, 0px);
    --safe-left: env(safe-area-inset-left, 0px);

Comment to carry with them (four load-bearing facts):
  * index.html:5 already sets viewport-fit=cover; these make that opt-in honest.
  * The `0px` fallback is not decoration. Without it, on a UA where the inset name is unrecognised the property is invalid at computed-value time and every calc() below collapses — taking the ordinary --s4 padding with it.
  * Read through these tokens, never env() directly. That indirection is what makes the geometry testable by substitution (see the probe in EDIT 13).
  * `padding-inline` below is logical and env() is physical. This app is LTR-only (index.html:2 is lang="en"; there is no [dir] or :dir() selector anywhere in styles.css). If RTL is ever added, the inline pairings invert.

--- EDIT 2 · styles.css:284 — .topbar, drop the fixed height ---
Replace  `  height: 56px;`  with  `  min-height: calc(56px + var(--safe-top));`
`box-sizing: border-box` is global (:140-144), so `height: 56px` + `padding-top` would eat the inset out of the content box and clip the 44px .icon-button (:328-331) and the 36px .theme-toggle (:400-414). min-height rather than height so the bar can also grow under large Dynamic Type. .topbar is `flex: none` in a `100dvh` flex column (:218-223), so min-height is what sizes it; .layout shrinks by the same amount, which is correct — the strip under the status bar was never usable map.

--- EDIT 3 · styles.css:286 — .topbar, the actual insets ---
Replace  `  padding-inline: var(--s4);`  with:

    padding-top: var(--safe-top);
    padding-inline: calc(var(--s4) + var(--safe-left)) calc(var(--s4) + var(--safe-right));

Padding, never margin: .topbar's `background: var(--raised)` (:287) must keep painting edge-to-edge under the status bar. .topbar is `position: sticky; top: 0` (:289-290) — at <=899px .app is `height: auto` (:1417-1421) and the document scrolls, so the bar genuinely pins under the notch; at >=900px .app is 100dvh and nothing scrolls past it, where --safe-top is 0 anyway on every desktop.

--- EDIT 4 · styles.css:193 — .skip-link inline start ---
Replace  `  inset-inline-start: var(--s2);`  with  `  inset-inline-start: calc(var(--safe-left) + var(--s2));`

--- EDIT 5 · styles.css:206 — .skip-link:focus ---
Replace  `  top: var(--s2);`  with  `  top: calc(var(--safe-top) + var(--s2));`
The brief does not mention this one. Today the focused skip link lands at top:8px — inside the status-bar strip on a notched phone, i.e. the first thing a keyboard user reaches is the one thing they cannot see.

--- EDIT 6 · styles.css:347 — .ribbon ---
After  `  padding: var(--s2) var(--s4);`  add:

    padding-inline: calc(var(--s4) + var(--safe-left)) calc(var(--s4) + var(--safe-right));

Only inline: the ribbon never touches the top edge, because Topbar always renders above it (App.jsx:376, :378).

--- EDIT 7 · styles.css:245 — .panel base ---
After  `  padding: var(--s4);`  add:

    padding-inline-start: calc(var(--s4) + var(--safe-left));
    padding-bottom: calc(var(--s4) + var(--safe-bottom));

This one rule is the entire "panel and footer" half of the brief. .about (:361-375) is the footer — Survey C §8 and About.jsx:4 confirm the old footer was collapsed into the About disclosure — and it is pinned to the panel's bottom by .panel__spacer (:258-263). It is in normal flow, so it needs no rule of its own; the panel's padding-bottom is what lifts it off the home indicator. Same for .departure (:1490), .steps (:1560), .detail__actions (:1711) and everything else inside the panel.
padding-inline-END is deliberately not here: at >=900px the panel's trailing edge is the border it shares with .stage (:248), not the viewport. It is added at <=899px in EDIT 13.

--- EDIT 8 · styles.css:1467 — the 420px override, THE CLOBBER FIX ---
Inside `@media (max-width: 420px)` (:1465-1475), `.panel { padding: var(--s3); }` is a four-side shorthand that lands AFTER the base rule and silently deletes both longhands from EDIT 7. Replace the rule body (:1466-1468) with:

    .panel {
      padding: var(--s3);
      padding-inline-start: calc(var(--s3) + var(--safe-left));
      padding-inline-end: calc(var(--s3) + var(--safe-right));
      padding-bottom: calc(var(--s3) + var(--safe-bottom));
    }

inline-end is unconditional here because <=420px is always single-column.

--- EDIT 9 · styles.css:889 — .map__controls ---
Replace  `  inset-inline-end: var(--s3);`  with  `  inset-inline-end: calc(var(--s3) + var(--safe-right));`
.stage's trailing edge is the viewport's at every width. The controls are 44px .map__ctrl buttons (:894-910); this moves them, never resizes them.

--- EDIT 10 · styles.css:1451 — the 899px override, SECOND CLOBBER FIX ---
Inside `@media (max-width: 899px)` (:1416-1456), replace  `    inset-inline-end: var(--s2);`  with  `    inset-inline-end: calc(var(--s2) + var(--safe-right));`
`top: var(--s2)` at :1450 stays as-is: at <=899px the stage sits below the topbar in document flow, so its top edge is already past the inset.

--- EDIT 11 · styles.css:919 — .legend ---
Replace  `  inset-block-end: var(--s3);`  with  `  inset-block-end: calc(var(--s3) + var(--safe-bottom));`
inset-inline-start (:920) is untouched: the stage's leading edge is interior at every width where the legend renders — it is `display: none` below 900px (:1443-1445).

--- EDIT 12a · styles.css:553 — .firstrun ---
After  `  padding: var(--s6) var(--s4);`  add:

    padding-inline: calc(var(--s4) + var(--safe-left)) calc(var(--s4) + var(--safe-right));
    padding-bottom: calc(var(--s6) + var(--safe-bottom));

The brief's "topbar, panel and footer" misses this. App.jsx:380 is a ternary: FirstRun REPLACES div.layout, so .firstrun is a direct child of .app and its box touches left, right and bottom of the viewport. .firstrun__card is inside it and needs nothing.

--- EDIT 12b · styles.css:1621 — .follow ---
After  `  padding: var(--s3);`  add:

    padding-inline-end: calc(var(--s3) + var(--safe-right));

Bottom is width-scoped, in EDIT 13. .follow is `position: absolute; inset: 0` (:1614-1615) inside .stage; .sheet inside it is `margin-top: auto; align-self: stretch` (:1669-1671), so the padding-bottom added in EDIT 13 is what lifts the follow sheet off the home indicator.

--- EDIT 13 · append a new section after styles.css:1720 ---
The three width-scoped rules and the MapLibre rule go in a NEW section at the END of the file, not in the responsive block at :1409-1486. Survey A §6 states the reason and it is decisive here: that block sits mid-file and `departure`, `steps` and `follow` are declared after it, so `@media (max-width:899px) { .follow {...} }` placed at :1416 would LOSE to `.follow {...}` at :1613 — same specificity, later source wins, media queries add none. It would fail silently.

    /* ------------------------------------------------------------- safe area */

    /* Below 900px the panel is the only column, so its trailing edge is the
     * viewport's. Above it, the stage is. */
    @media (max-width: 899px) {
      .panel { padding-inline-end: calc(var(--s4) + var(--safe-right)); }
    }

    /* Above 900px the stage reaches the bottom of the viewport, so the follow
     * sheet must clear the home indicator. Below it the stage is a 230px band
     * at the TOP of the document (:1428-1431, order:-1) and the indicator is
     * nowhere near it — 34px there would eat an eighth of the band for nothing. */
    @media (min-width: 900px) {
      .follow { padding-bottom: calc(var(--s3) + var(--safe-bottom)); }
    }

    /* MapLibre's compact attribution button. attributionControl is enabled at
     * MapView.jsx:179 and this file has no .maplibregl-* rule at all, so the
     * button sits in the literal corner of the stage — which above 900px is the
     * corner of the viewport. Padding on the container, not margin: MapLibre
     * gives its own children `margin: 0 10px 10px 0`, and a margin here would
     * replace that rather than add to it. Physical sides, to match MapLibre's
     * own physical class names. */
    .map .maplibregl-ctrl-bottom-right { padding-right: var(--safe-right); }
    @media (min-width: 900px) {
      .map .maplibregl-ctrl-bottom-right,
      .map .maplibregl-ctrl-bottom-left { padding-bottom: var(--safe-bottom); }
    }

    /* PROBE — to exercise any of this on a machine that reports no insets,
     * which is every desktop browser and every headless Chrome:
     *
     *   const r = document.documentElement.style
     *   r.setProperty('--safe-top','59px');  r.setProperty('--safe-right','0px')
     *   r.setProperty('--safe-bottom','34px'); r.setProperty('--safe-left','0px')
     *
     * (iPhone 15 Pro portrait. Landscape, notch to the left: 0/59/21/59.)
     * Every rule above reads the token, never env() directly, precisely so this
     * substitution is faithful. It proves the arithmetic and the stacking. It
     * cannot prove the UA reports the right numbers — only a device can. */

MapLibre attaches its control containers to the element it is handed, which is .map__canvas (see the comment at :859-869), a child of .map — so `.map .maplibregl-ctrl-bottom-right` matches as a descendant.


== D. TOKEN MAPPING ==

Every launch token appearing at the nine safe-area sites, mapped. The headline finding: this capability touches NO colour token and NO type token. Only spacing and --target are in play, which makes it the lowest-risk of the nine ports.

| launch token | launch value | current equivalent | current value | used at a safe-area site? |
|---|---|---|---|---|
| --space-1 | 4px  | --s1 | 4px  | no (only :1647, out of scope) |
| --space-2 | 8px  | --s2 | 8px  | YES — :302, :520, :521 |
| --space-3 | 12px | --s3 | 12px | YES — :302, :303, :512, :513, :520, :521 |
| --space-4 | 16px | --s4 | 16px | YES — :585, :586, :595, :596 |
| --space-5 | 24px | **--s6** (NOT --s5) | 24px | YES — :596 |
| --space-6 | 32px | **--s7** (NOT --s6) | 32px | no |
| --space-7 | 48px | **none** — scale stops at --s8 (40px). Use calc(var(--s8) + var(--s2)) or re-step the design. | — | no |
| --space-8 | 64px | **none**. Use calc(var(--s8) + var(--s6)). | — | no |
| --target  | 44px | --target | 44px | identical name and value in both files; no mapping needed |

THE TRAP: the two spacing scales are identical for steps 1-4 and DIVERGE from step 5. Launch is 4/8/12/16/24/32/48/64; current is 4/8/12/16/20/24/32/40. An index-for-index port silently turns 24px into 20px at every --space-5 site. Map by VALUE, not by index.

Tokens the launch sites reference indirectly, for completeness — none is needed by this port, and none may be reintroduced:

| launch token | current equivalent |
|---|---|
| --text-1 (0.875rem / 14px) | no exact match. --t-small is 0.8125rem (13px), --t-body 0.9375rem (15px). Not used at any of the 9 sites — it appears at feat/launch:519 (.sheet__snap), :1573, :1638, :1645, all sibling rules. |
| --text-2 .. --text-6 | --t-body / --t-h3 / --t-h2 / --t-metric / --t-display, by value, not by index. Not used at any of the 9 sites. |
| --ink: #14213d | --ink: #16241c. Not used at any of the 9 sites. |
| launch route palette (--route-fastest #2f6fd0, --route-scenic #2e8b57, --route-accessible #7a4fc4, --route-quiet #b06a1f, --route-shade #12756c, --route-air #b03050) | current dark-green palette at styles.css:44-49 / :86-91, mirrored in lib/dash.js:24-77. Not used at any of the 9 sites. Do not touch. |
| --page / --recessed / --ink-muted / --warn-border | --paper / --sunken / --ink-2 / --warn-rule |
| --selected-border | no equivalent. Use --accent. |
| --map-casing | no equivalent. The current map uses --raised for the same job (MapView.jsx:336, :394, :411). |
| --radius-control 6px / --radius-card 8px / --radius-chip 999px | --r-sm 8px / --r-sm 8px / --r-pill 999px |

ON THE --safe-* NAMES THEMSELVES: --safe-top/right/bottom/left are not --space-*, not --text-*, not --ink, and not a route colour, so the prohibition does not reach them. They also carry no value from the launch design system — the value comes from the UA at substitution time — so there is nothing to reintroduce. Keeping the launch names keeps the two branches' comments and any future diff legible. If zero name overlap is preferred, rename to --inset-top/right/bottom/left, and do it before the first consumer lands, not after.


== E. LAUNCH SITE -> CURRENT SITE MAPPING ==

| feat/launch site | what it is there | current equivalent | edit |
|---|---|---|---|
| :98-101 declarations | :root, above the dark block | theme-invariant :root at :106-138, after --target:137 | EDIT 1 |
| :302-303 .topbar padding T/R/L | absolute bar floating over a full-bleed map | .topbar :279-292 — sticky 56px bar, first child of .app | EDITS 2, 3 |
| :457 .sheet--peek height + --safe-bottom | snap-point peek height must clear the home indicator | **no equivalent** — there is no bottom sheet on main (Survey C §8). The concern maps to the bottom-most flow content: .panel's padding-bottom | EDIT 7 |
| :478 .sheet--full `calc(100dvh - 72px - --safe-top)` | full-height sheet minus chrome minus notch | **no equivalent, and no port needed.** Nothing on main computes a height against the viewport minus chrome. .app is a plain 100dvh flex column (:218-223) whose first child now absorbs --safe-top as padding, so the arithmetic happens by layout rather than by calc. .sheet's `min-height: 30vh` (:1673) is bounded by .stage, not by the viewport. | none |
| :512-513 .sheet__scroll padding L/R | the app's scroll container | .panel :238-249 — the app's scroll container | EDITS 7, 8, 13 |
| :520-521 .sheet__snaps padding + --safe-bottom | bottom-pinned control strip | **no equivalent** (no snap buttons). Bottom-pinned content on main is .about, pinned by .panel__spacer :258-263, in normal flow inside .panel | EDIT 7 |
| :585-586 .controls-sheet__bar padding L/R | modal controls header | .tripbar :428-437 — **and it needs nothing.** At >=900px it is `position: sticky; top: 0` inside .panel, so `top: 0` is the panel's already-inset padding box, not the viewport. At <=899px it is `position: static` (:1436-1438). A naive port would add --safe-top here and push it 47px down for no reason. | none |
| :595-596 .controls-sheet__scroll padding | modal controls body | .drawer :507-517, inside .tripbar, inside .panel — inherits the panel's insets | none |
| :1022 .maplibregl-ctrl-top-right margin-top | keep MapLibre's zoom cluster below the notch | **split.** MapLibre's NavigationControl is not used on main — MapView ships its own .map__controls (:886-894, MapView.jsx:596), which needs --safe-right, not --safe-top. MapLibre's compact attribution IS enabled (MapView.jsx:179) and has no rule in this file at all. | EDITS 9, 10, 13 |
| — (no launch equivalent) | | .skip-link :191-207 | EDITS 4, 5 |
| — (no launch equivalent) | | .legend :917-928 | EDIT 11 |
| — (no launch equivalent) | | .firstrun :550-555 | EDIT 12a |
| — (no launch equivalent) | | .follow :1613-1623 | EDITS 12b, 13 |


== F. WHAT THE BRIEF GETS WRONG ==

Checked line by line against feat/launch and against main. Six corrections; one confirmation.

1. WRONG (line numbers). "declares --safe-top/right/bottom/left at feat/launch:frontend/src/styles.css:96-101". The declarations are at **:98-101**. Lines :94-97 are the explanatory comment. docs/IOS-LAUNCH-PROMPT.md:649 says "around line 98" and is the one that is right — the two project docs contradict each other.

2. WRONG (line numbers). "consumes them at :301-303". The declaration begins at **:302**; :300-301 is the comment.

3. WRONG (count), in the brief's own table. docs/RELEASE-PROMPT.md:734 says "consumed in 9 places". Counting consumption DECLARATIONS from an independent grep of the whole 2024-line file: :302, :457, :478, :512, :520, :585, :595, :1022 = **8**. The enumerated list at RELEASE-PROMPT.md:313-315 has 8 entries and is COMPLETE — I found no site it omits. The table at :734 disagrees with the prose at :313.

4. WRONG (target doesn't exist). "Port the concept into this frontend's topbar, panel and footer." **There is no footer on main.** Survey C §8 and About.jsx:4 confirm it was collapsed into the About disclosure. "Footer" resolves to .about (:361-375), which correctly needs no rule of its own — it is in normal flow inside .panel.

5. INCOMPLETE, and this is the substantive one. The brief names three targets; there are eight. It omits: .skip-link:focus (:206 — lands at top:8px, inside the status bar, so the first thing a keyboard user reaches is invisible), .firstrun (:553 — App.jsx:380 replaces div.layout entirely, so it is a direct child of .app and touches three viewport edges), .map__controls (:889, plus the clobbering override at :1451), .legend (:919), .follow (:1621), and MapLibre's compact attribution button (enabled MapView.jsx:179, styled nowhere in this file). It also omits the two shorthand-clobber traps at :1467 and :1451, either of which makes the port a silent no-op at that breakpoint.

6. INCOMPLETE, and it changes the severity. The brief presents this as a fresh opt-in. It is not: **frontend/index.html:5 already sets `viewport-fit=cover`.** main is therefore already in the state the launch comment calls "strictly worse than not opting in at all" — drawing under the notch with nothing handled. The upside is that no index.html change is needed, which the brief does not say.

7. TRUE BUT UNDERSTATED. "Headless Chrome at 390x844 reports zero insets so this cannot be verified in CI." Correct, and the mechanism is Emulation.setDeviceMetricsOverride (feat/launch:frontend/scripts/gate.mjs:74-78), which sets width/height/DPR/mobile and does not synthesize insets. Two things it misses: (a) there is no headless-Chrome gate on main at all to add a check to — Makefile:62-70 records that `gate` and `pwa-gate` were deleted in the reconciliation merge and frontend/scripts/ does not exist, and Survey C §8 shows seven of gate.mjs's fourteen selector families are dead on main, so it cannot simply be revived; (b) the geometry IS testable by overriding the four tokens, which is the whole reason to route every site through a token instead of calling env() inline. What is untestable off-device is only whether the UA supplies the right numbers.

8. CONFIRMED. "the current styles.css has none at all" (RELEASE-PROMPT.md:315, IOS-LAUNCH-PROMPT.md:653, BLOCKED.md:300). Correct: zero matches for `safe-area`, `--safe-`, or `env(` across frontend/src, frontend/index.html and frontend/a11y.html.

### Risks and the rules that constrain it

== WHAT COULD BREAK ==

1. SHORTHAND CLOBBER — the highest-probability failure, and it fails SILENTLY. A later `padding:` or `inset-inline-end:` shorthand resets every side and deletes the safe-area longhand. Two live sites: styles.css:1467 (`.panel { padding: var(--s3) }` inside @media max-width:420px, after the base rule at :245) and styles.css:1451 (`.map__controls { inset-inline-end: var(--s2) }` inside @media max-width:899px, after :889). EDITS 8 and 10 fix both; tests 5 and 6 stop the next one.

2. SOURCE ORDER vs THE MID-FILE RESPONSIVE BLOCK. The responsive block is at :1409-1486 but `departure` (:1488), `steps` (:1558) and `follow` (:1609) are declared AFTER it. A media-query rule for .follow added at :1416 loses to the base rule at :1613 — equal specificity, later source wins, media queries contribute none. This is why EDIT 13 appends a new trailing section instead. Getting it wrong produces no error and no visible change on any desktop.

3. `height: 56px` -> `min-height`. With the global `box-sizing: border-box` (:140-144), leaving `height` in place means the 47px top inset is subtracted from the content box and the 44px .icon-button (:328-331) and 36px .theme-toggle (:400-414) are clipped. Growing the bar shrinks .layout by the same amount inside the 100dvh flex column — correct, since that strip was never usable. Verify visually that the 56px of chrome specified in DESIGN-HANDOFF §3 is preserved on desktop, where --safe-top is 0.

4. LOGICAL vs PHYSICAL. `padding-inline` is logical; env(safe-area-inset-left/right) is physical. Safe because the app is LTR-only: index.html:2 is lang="en" and there is no [dir] or :dir() selector anywhere in styles.css. This is a deliberate deviation from feat/launch, which used physical four-value `padding` shorthands. If RTL is ever added, all four inline pairings invert and need :dir(rtl) overrides — the token-block comment must say so. The one exception is EDIT 13's MapLibre rule, which uses physical `padding-right` to match MapLibre's own physical class name.

5. env() SUPPORT. On a UA that does not know env() at all, the function is left unresolved and the enclosing calc() is invalid at computed-value time — which throws away the ordinary --s4 padding too. The usual two-declaration fallback does NOT work here: a custom property accepts any token stream, so the env() declaration always wins at parse time regardless. No @supports guard is proposed, because styles.css already depends on `:has()` (:1129) and `dvh` (:222, :1420), both of which shipped strictly later than env() in every engine — env() is not the binding constraint. If a guard is wanted anyway it must wrap the CONSUMPTION, not the declaration: @supports (padding: env(safe-area-inset-top)).

6. MAPLIBRE INTERNALS. EDIT 13 targets .maplibregl-ctrl-bottom-right, a class MapLibre owns. A MapLibre major could rename it; failure mode is the attribution drifting back into the corner, not a broken layout. Padding rather than margin so MapLibre's own `margin: 0 10px 10px 0` on the children survives rather than being replaced. Adjacent gap, out of scope but worth naming: main has NO .maplibregl-* rule at all, so the compact attribution button also misses the 44px floor that feat/launch fixed at :1004-1008.

7. TOKEN NAMING. --safe-* reuses launch identifiers. Argued permissible in the plan (not --space-*, not --text-*, not --ink, not a route colour; no launch VALUE is imported — the value is UA-supplied). If a reviewer wants zero overlap, rename to --inset-* before the first consumer lands.

8. NOT A RISK, worth stating so nobody adds it: do not expose these to JS. MapView.jsx:42's token() reads only colour tokens (:56-61, :336, :377, :394, :411, :453), and the useLayoutEffect ordering guarantee at App.jsx:264-275 exists for palette repaints. Safe insets never reach the canvas, so nothing joins that path.


== PROJECT RULES, AND HOW THIS SATISFIES EACH ==

RULE: A missing OSM tag means UNKNOWN, never "accessible".
Not engaged. This capability renders no data and makes no claim about any route. It changes padding only. Specifically it does not touch the null-vs-0-vs-[] distinctions at RouteRow.jsx:99-121, RouteDetail.jsx:106-153 or format.js:125-137.

RULE: Colour is never the only differentiator; the UI must survive greyscale.
Satisfied by construction: the diff contains zero colour declarations and zero hex literals. The CI gate at ci.yml:158-170 (awk over styles.css for `#[0-9a-fA-F]{3,8}` outside the two :root blocks) stays green — EDIT 1 lands inside a `^:root {` block and every other edit is calc() arithmetic. Greyscale rendering is byte-identical.

RULE: The route list is a complete text substitute for the map.
Preserved and slightly reinforced. The only map-side changes are .map__controls, .legend and the MapLibre attribution — all decoration over the map. .rail and RouteRow are untouched. Note .legend is already display:none below 900px (:1443-1445) precisely because the rail is the legend there.

RULE: No location history, no cookies, no analytics; localStorage is theme and units ONLY.
Satisfied absolutely. env() is resolved by the UA inside the style engine; nothing is persisted, nothing is transmitted, and no JS reads it. No new localStorage key — the two existing touch points (lib/theme.js:20, :29, key `meander:theme`) and the pre-paint duplicate at index.html:28 are untouched. The About copy at About.jsx:29-33, FirstRun.jsx:112-115 and FollowMode.jsx:239-241 stays true as written.

RULE: No new third-party runtime requests.
Satisfied. Pure CSS. No import, no dependency, no font, no icon, no build-step change. package.json (26 lines) and vite.config.js (35 lines) are untouched; the only external hosts remain the OpenFreeMap style URL (MapView.jsx:6) and the API base (client.js:19).

RULE: All interactive targets >= 44x44 px.
Satisfied and improved. Every edit adds padding around a target or moves it; none resizes one. Three specific guarantees: (a) EDIT 2 exists solely so the topbar's 44px .icon-button is not clipped by its own new padding; (b) .map__ctrl and .hour keep `width/height: var(--target)` (:896-898, :1519-1520) — EDIT 9 moves the cluster, not the buttons; (c) .follow__exit keeps `min-height: var(--target)` (:1638). The two pre-existing 36px gaps (.theme-toggle :406, .preset :527, both noted in Survey A §7.1) are neither fixed nor worsened here — do not fold them into this change.

RULE (house style, Survey A §6): state is read from ARIA attributes, not JS-toggled classes; one live region.
Not engaged — no JSX changes at all, so no new class, no new attribute, no second live region.

RULE (styles.css:10-13): every colour declared once, in the two :root blocks.
Satisfied; see the greyscale rule above. EDIT 1 adds four non-colour custom properties to the THIRD :root block (:106-138), the theme-invariant one, alongside --target — matching the comment at :104-105 that keeps type/space/shape out of the palette blocks.

### Tests

== 1. THE CI-RUNNABLE TEST ==

NEW FILE: /Users/poojana/Meander/Meander/frontend/src/styles.safe-area.test.js

Why here and why this shape. vitest's default include is `**/*.{test,spec}.?(c|m)[jt]s?(x)`, so the file is collected by `npm test` (package.json:13) with no config change; that flows into `make test-frontend` (Makefile:53-54) -> `make check` (Makefile:72) and into the CI `frontend` job (ci.yml:140-144). vite.config.js:20-33 sets no `environment`, so the run is plain Node and `node:fs` is available — which is the only shape available, since there is no jsdom and no browser. It sits beside styles.css rather than in lib/ because its subject is the stylesheet, not a module; the two existing suites (src/lib/sun.test.js 255 lines, src/lib/follow.test.js 185 lines) are the same node-only shape.

Preamble:

    import { readFileSync } from 'node:fs'
    import { fileURLToPath } from 'node:url'
    import { describe, expect, it } from 'vitest'
    const css  = readFileSync(fileURLToPath(new URL('./styles.css', import.meta.url)), 'utf8')
    const html = readFileSync(fileURLToPath(new URL('../index.html', import.meta.url)), 'utf8')
    const SIDES = ['top', 'right', 'bottom', 'left']
    // Every body of `selector { ... }` in source order.
    const bodies = (sel) => [...css.matchAll(new RegExp(`\\${sel}\\s*\\{([^}]*)\\}`, 'g'))].map((m) => m[1])

Seven assertions:

T1 — "each inset token is declared exactly once, with an explicit 0px fallback".
  For each side: expect(css.match(new RegExp(`--safe-${side}:\\s*env\\(safe-area-inset-${side},\\s*0px\\)`,'g'))).toHaveLength(1)
  WHY: the fallback is the difference between "this device has no inset" and "this padding declaration is invalid at computed-value time and vanishes, taking the --s4 with it". Dropping `, 0px` is a one-character regression that no rendering check on a desktop would ever catch.

T2 — "env() is never called outside the token block".
  expect((css.match(/env\(/g) ?? [])).toHaveLength(4)
  WHY: the probe in EDIT 13 and any future gate work by overriding the four custom properties. A rule that calls env() inline is invisible to that override — it would be the one site the substitution test silently cannot reach.

T3 — "the tokens live in the theme-invariant block, not a palette block".
  Slice the dark block (from `[data-theme='dark'] {` to the next `\n}`) and assert it contains no `--safe-`. Also assert `css.indexOf('--safe-top') > css.indexOf('--target: 44px')`.
  WHY: device geometry is not palette. A --safe-* in either colour block would have to be duplicated in the other and would drift.

T4 — "the topbar does not pin a fixed height".
  const [topbar] = bodies('.topbar'); expect(topbar).not.toMatch(/^\s*height:/m); expect(topbar).toMatch(/--safe-top/)
  WHY: this is the single most likely regression. Restoring `height: 56px` alongside `padding-top` clips the 44px .icon-button out of the content box (global border-box at :140-144) — a 44x44 violation introduced by the fix meant to be safe.

T5 — "every rule that resets .panel's padding restates the safe-area sides".
  for (const b of bodies('.panel')) if (/padding:/.test(b)) expect(b).toMatch(/--safe-bottom/)
  WHY: this is the exact trap at styles.css:1467. Three .panel rules exist (base :238, the 899 override :1432, the 420 override :1466); only the ones carrying a shorthand can clobber, and this catches every future one.

T6 — "every rule that resets .map__controls' trailing inset restates --safe-right".
  for (const b of bodies('.map__controls')) if (/inset-inline-end:/.test(b)) expect(b).toMatch(/--safe-right/)
  WHY: same trap, second instance, at styles.css:1451.

T7 — "index.html still opts into the full viewport".
  expect(html).toMatch(/viewport-fit=cover/)
  WHY: the tokens are only ever non-zero because of one attribute in a different file. This is exactly the cross-file coupling index.html:22-23 already documents for the `meander:theme` key ("the two must agree"), and it is the one deletion that would make every rule above a no-op with no other symptom.

OPTIONAL EIGHTH, cheap, and it belongs with whichever of the nine ports lands first — either in this file or in a sibling styles.tokens.test.js:
  expect(css).not.toMatch(/--space-\d|--text-\d|--radius-(control|card|chip)|--ink-muted|--recessed\b/)
  WHY: mechanises the standing prohibition on the launch token vocabulary, so the next port cannot smuggle it back in a copied rule.

Cost: adds one file and ~40 lines to a suite that currently runs two files. No new dependency, no config change, no runtime change.


== 2. WHAT CANNOT BE TESTED IN CI, AND WHY — say this in PROGRESS.md ==

The brief is right that this cannot be verified in CI, and the reason is worth stating precisely because it is stronger than "the numbers are zero":

  * Headless Chrome's only viewport control in the gate that used to exist is Emulation.setDeviceMetricsOverride (feat/launch:frontend/scripts/gate.mjs:74-78, driven at 390x844 from :136-137). It sets width, height, deviceScaleFactor and the mobile flag. It does not synthesize safe-area insets. env(safe-area-inset-*) therefore resolves to the 0px fallback, every rendered assertion produces byte-identical output with the feature present and absent, and the test would be one that CANNOT FAIL. A green check there would be worse than no check.
  * There is also nothing to add it to. Makefile:62-70 records that the `gate` and `pwa-gate` targets were deleted in the reconciliation merge; frontend/scripts/ does not exist on main; and Survey C §8 shows seven of gate.mjs's fourteen selector families are dead here, so reviving it is a separate job with three unrelated hard failures.

  * WHAT IS TESTABLE OFF-DEVICE: the arithmetic and the stacking, by substituting the four tokens. Paste the probe from EDIT 13 into any browser console at any width and the layout must behave exactly as it does on device. This is the reason every rule reads a token rather than calling env() inline, and T2 is what keeps that property true. It proves the CSS is correct; it cannot prove the UA reports the right numbers.


== 3. THE DEVICE PASS — the only verification that closes this ==

Run it in Safari on a notched iPhone with a home indicator, and record in PROGRESS.md: device model, iOS version, orientation, and the four values read back from the probe expression. RELEASE-PROMPT.md:319-320 requires the note; make it specific enough to be re-run.

  a. Portrait. The wordmark baseline clears the status bar. Scroll to the document end: the About summary and the last route row clear the home indicator.
  b. Landscape, notch to the LEFT, then rotate 180 and repeat with it to the RIGHT. Nothing in .topbar, .ribbon or .panel sits under the sensor housing in either rotation. The map still paints under it. This is the rotation-asymmetry case the probe's symmetric defaults will not catch.
  c. Landscape on a >=900px-wide phone — an iPhone 15 Pro Max is 932pt in landscape, which crosses the breakpoint into the TWO-COLUMN desktop layout on a phone. Confirm: .panel is the left column and takes --safe-left; .stage takes --safe-right; .legend clears the indicator; enter follow mode and confirm the sheet does too (this is the only path that exercises EDIT 13's min-width:900px .follow rule on real hardware).
  d. Add to Home Screen, launch standalone. --safe-top grows because the browser chrome is gone — the case a browser tab never shows.
  e. Focus the skip link with an external keyboard in portrait. It must land BELOW the status bar (EDIT 5).
  f. Both themes at each step: the topbar's background must paint edge-to-edge through the inset strip, not leave a band of --paper above it.

---

## ElevationProfile — draw the route's climb in the detail panel and mark the stretches that break the same gradient limit the accessibility engine rejects on, with the limit arriving as an API field (`ElevationProfile.limit_pct`) rather than as a duplicated JS constant or a generated file.

**DONE** — kept for the reasoning

### Sources read on `feat/launch`
- git show feat/launch:frontend/src/components/ElevationProfile.jsx — 116 lines (the whole component; read in full)
- git show feat/launch:frontend/src/styles.css — 2400+ lines total; read :1-140 (the launch token block) and :1867-1943 (the .spark / .profile rules this component depends on)
- git show feat/launch:frontend/src/components/RouteCard.jsx — 190+ lines; read :13 (import) and :96 / :175 (the two mount points: compact sparkline in the card, full profile in the expanded body)
- git show feat/launch:frontend/src/components/BlockedRouteCard.jsx — 100+ lines; read :3 (import) and :89 (mount point on the blocked card)
- git show feat/launch:backend/elevation.py — 125 lines; byte-identical to /Users/poojana/Meander/Meander/backend/elevation.py on main (verified with diff). Read in full.

### Plan

﻿# ElevationProfile — integration spec

Repo root `/Users/poojana/Meander/Meander`. All line anchors verified against the current tree (HEAD `8644ff2`; `frontend/src` and `backend/` unchanged from `46d4772`).

---

## 0. THE MECHANISM: how the JS gets the Python constant

**Answer: neither a generated file nor a build step. It is an API field that is already on the wire, and the frontend never performs the comparison at all.**

The chain, all of it existing code:

- `backend/accessibility.py:90` — `MAX_INCLINE_PCT = 8.0`, a bare module-level float.
- `backend/elevation.py:27-31` — `build_profile` *imports* it (`from .accessibility import INCLINE_SMOOTHING_WINDOW_M, MAX_INCLINE_PCT, _resample_elevation`).
- `backend/elevation.py:92` — `over = np.abs(gradients) > MAX_INCLINE_PCT` computes **which stretches break the limit**, server-side.
- `backend/elevation.py:124` — `limit_pct=MAX_INCLINE_PCT` puts **the number itself** on the same object.
- `backend/models.py:99-116` — `ElevationProfile` carries `steep_spans: list[list[int]]` and `limit_pct: float`.
- `backend/main.py:490` (`_guard("elevation_profile", build_profile, …)`) → `backend/main.py:556-558` (`elevation=ElevationProfile(**vars(assessment.elevation)) …`).

So the JS receives, in one object, both the marked spans and the number that explains them. **The frontend's only use of `limit_pct` is to print it.** It does not compare a gradient to a threshold anywhere — it draws the rectangles the server marked. That is the strongest possible form of "import rather than restate": there is no threshold in the JS to drift.

I verified this end to end. `PYTHONPATH=. .venv/bin/python` + `TestClient`, `POST /api/routes`, body = Colombo Fort → Viharamahadevi, 25 min, mode auto (the exact body `backend/tests/test_api_routes.py:16-24` uses), `Accept: text/event-stream`:

```
fastest    | pending True  | ok      | n=120 asc=42.1 desc=39.1 max=49.3 limit=8.0 dN=3720.0 spans=[[0,2],[3,6],[62,66],[70,73],[83,85],[112,114],[116,119]]
scenic     | pending True  | ok      | n=120 asc=53.7 desc=50.7 max=49.3 limit=8.0 dN=4200.0 spans=[[0,2],[3,6],[55,58],[62,64],[73,75],[77,80],[90,93],[93,95],[113,115],[117,119]]
accessible | pending True  | blocked | n=120 asc=44.2 desc=41.2 max=40.0 limit=8.0 dN=3580.0 spans=[[3,5],[15,18],[20,22],[33,36],[37,40],[43,45],[89,91],[95,97],[116,119]]
… then the same three ids again with pending False and byte-identical elevation objects.
```

**Why not a generated JS file** (e.g. a Make/CI step writing `frontend/src/lib/limits.generated.js` from `accessibility.py`):

1. There is no codegen step to hang it on. `frontend/package.json:8-15` is plain `vite` / `vite build` / `vitest run`; `frontend/vite.config.js` has no plugin that reads `backend/`; `scripts/` contains no generator.
2. **CI's frontend job has no Python.** `.github/workflows/ci.yml:123-147` runs `actions/setup-node@v4` and nothing else — no `setup-python`. A generated file would either break that job or need a checked-in artefact that can silently go stale.
3. It would be a *second copy that can be stale at runtime*. `deploy.yml:97-118` rolls the API and `deploy.yml:120-136` publishes the bundle to S3/CloudFront as separate steps, and CloudFront caches the bundle. A backend change to `MAX_INCLINE_PCT` would leave the old number baked into every cached client while the spans it labels came from the new one. `limit_pct` cannot go stale relative to `steep_spans`, because both are produced by the same call (`elevation.py:92` and `:124`) and travel in the same object.
4. The backend already prints the sentence too: `backend/accessibility.py:250-254` formats the `incline` Finding description as `"A gradient of X% up, steeper than the 8% limit."` from `MAX_INCLINE_PCT`. That string reaches the UI verbatim as a `Blocker.description` (`RouteDetail.jsx:33`). A generated constant would be a *third* home for the same number.

**The rule for the implementer, stated as a checkable invariant:** the literal `8` must not appear as a gradient threshold anywhere in `frontend/src`. Enforced by test T5 below (feed `limit_pct: 5`, assert the sentence says `5%` and never `8%`).

---

## 1. NEW FILES

### 1a. `frontend/src/lib/elevation.js` (new, ~95 lines)

Pure module. No DOM, no network, no storage. Holds every number and every sentence so the component is layout only and so the logic is testable under the existing node-environment vitest (`frontend/vite.config.js:20-34` sets only `env: { TZ: 'UTC' }` — **there is no jsdom, so component-render tests are not possible without a new devDependency; do not add one**). Same precedent as `lib/sun.js` + `lib/sun.test.js` and `lib/follow.js` + `lib/follow.test.js`.

```js
/** Elevation-profile geometry and sentences.
 *
 * Nothing here knows what 8% is. The limit and the stretches that break it both
 * arrive on the wire, computed by backend/elevation.py:92,124 from
 * backend/accessibility.py:90 MAX_INCLINE_PCT. There is no generated constants
 * file and there must not be one: a second copy of the number can be stale
 * against the spans it labels, and this one cannot.
 */
import { fmtClimb, fmtDist } from './format.js'

export const VIEW_W = 100
export const VIEW_H = 40
/** Below this the route is drawn as a centred flat line rather than scaled. */
const FLAT_M = 1

/**
 * Clamp to the arrays, drop empties, merge touching or overlapping spans.
 *
 * Two reasons this is not optional:
 *   1. backend/elevation.py:112 clamps the exclusive end to `len(thin_grid)`,
 *      so `b` can equal the array length and `xs[b]` would be undefined.
 *   2. The thinning rescale at backend/elevation.py:106-115 can push two
 *      originally-separate spans into contact — the live fixture returns
 *      [[90,93],[93,95]] on the scenic route. Counting those as two stretches
 *      contradicts elevation.py:89-90, which says one stretch is one thing to
 *      mark. Merging restores the backend's own stated intent.
 */
export function mergeSpans(spans, n) {
  if (!Array.isArray(spans) || !(n > 1)) return []
  const last = n - 1
  const clamped = spans
    .filter((s) => Array.isArray(s) && s.length === 2)
    .map(([a, b]) => [
      Math.max(0, Math.min(last, Math.trunc(a))),
      Math.max(0, Math.min(last, Math.trunc(b))),
    ])
    .filter(([a, b]) => b > a)
    .sort((p, q) => p[0] - q[0])
  const out = []
  for (const [a, b] of clamped) {
    const prev = out.at(-1)
    if (prev && a <= prev[1]) prev[1] = Math.max(prev[1], b)
    else out.push([a, b])
  }
  return out
}

/** Projection into the 100x40 view box, or null when there is nothing to draw. */
export function profileGeometry(profile) {
  const ys = profile?.elevations_m
  const xs = profile?.distances_m
  if (!ys?.length || !xs?.length || xs.length !== ys.length) return null

  const minY = Math.min(...ys)
  const maxY = Math.max(...ys)
  const rise = maxY - minY
  const maxX = xs.at(-1) || 1
  const px = (i) => (xs[i] / maxX) * VIEW_W
  // A route flatter than a metre is drawn down the middle. Scaling it would
  // amplify sensor noise into a mountain range; pinning it to the floor (what
  // `|| 1` on the divisor actually does) would read as a valley.
  const py =
    rise < FLAT_M
      ? () => VIEW_H / 2
      : (i) => VIEW_H - ((ys[i] - minY) / rise) * (VIEW_H - 2) - 1

  const line = ys.map((_, i) => `${px(i).toFixed(2)},${py(i).toFixed(2)}`).join(' ')
  return { line, area: `0,${VIEW_H} ${line} ${VIEW_W},${VIEW_H}`, minY, maxY, maxX, px }
}

/**
 * The profile as prose. The SVG is aria-hidden, so this is the whole of the
 * feature for anyone not looking at it.
 *
 * A null profile is "the router returned no elevation", which is a different
 * statement from "this route is flat" and must not render as one — the same
 * distinction lib/format.js:133-137 makes for rest stops.
 */
export function climbSentence(profile) {
  if (!profile?.elevations_m?.length) {
    return 'Climb was not measured for this route. That is not a statement that it is level.'
  }
  const { ascent_m: up, descent_m: down, max_gradient_pct: max, limit_pct: limit } = profile
  const spans = mergeSpans(profile.steep_spans, profile.elevations_m.length)
  const head = `Climbs ${fmtClimb(up)} and descends ${fmtClimb(down)}. Steepest gradient ${max}%`
  return spans.length
    ? `${head}, over the ${limit}% limit this app treats as impassable.`
    : `${head}, within the ${limit}% limit.`
}

/** Where the steep stretches are, or null when there are none. */
export function steepSentence(profile) {
  const xs = profile?.distances_m
  if (!xs?.length) return null
  const spans = mergeSpans(profile.steep_spans, xs.length)
  if (!spans.length) return null
  const ranges = spans.map(([a, b]) => `${fmtDist(xs[a])} to ${fmtDist(xs[b])}`)
  const list =
    ranges.length === 1 ? ranges[0] : `${ranges.slice(0, -1).join(', ')} and ${ranges.at(-1)}`
  const count = spans.length === 1 ? 'one stretch' : `${spans.length} stretches`
  return (
    `Steeper than ${profile.limit_pct}% for ${count} — ${list} along the route. ` +
    'That is the same limit the accessible route refuses to cross.'
  )
}
```

### 1b. `frontend/src/components/ElevationProfile.jsx` (new, ~70 lines)

Layout only. Returns a **fragment**, because `RouteDetail` supplies the `<section>` and the `<h4>`.

```jsx
import { useId } from 'react'

import {
  VIEW_H,
  VIEW_W,
  climbSentence,
  mergeSpans,
  profileGeometry,
  steepSentence,
} from '../lib/elevation.js'
import { fmtDist } from '../lib/format.js'

/**
 * The route's shape.
 *
 * **The marked stretches are not decoration.** They are the same gradient the
 * accessibility engine rejects on, and both the stretches and the threshold
 * travel on the wire (steep_spans, limit_pct) rather than being recomputed or
 * restated here, so the drawing cannot drift from the verdict. This file
 * contains no gradient threshold — see lib/elevation.js.
 *
 * The SVG is aria-hidden and paired with a text summary, because a polyline is
 * not an accessible description of anything. The summary carries the same
 * facts, including where each steep stretch is, so nothing is available only to
 * someone looking at the picture.
 */
export default function ElevationProfile({ profile }) {
  const fillId = useId()      // both useId calls stay above the early return
  const hatchId = useId()
  const summary = climbSentence(profile)
  const geom = profileGeometry(profile)

  if (!geom) return <p className="field__hint">{summary}</p>

  const steep = mergeSpans(profile.steep_spans, profile.elevations_m.length)
  const warn = steepSentence(profile)

  return (
    <>
      <svg
        className="profile__svg"
        viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
        preserveAspectRatio="none"
        aria-hidden="true"
        focusable="false"
      >
        <defs>
          <linearGradient id={fillId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" className="profile__fill-top" />
            <stop offset="100%" className="profile__fill-bottom" />
          </linearGradient>
          {/* Hatch, not a tint. A 22% wash of --warn-ink is 1.45:1 against
              --sunken: under the 3:1 graphical-object threshold and gone in
              greyscale. Same reasoning as .score__track--hatched. */}
          <pattern
            id={hatchId}
            patternUnits="userSpaceOnUse"
            width="4"
            height="4"
            patternTransform="rotate(45)"
          >
            <rect width="4" height="4" className="profile__steep-ground" />
            <line x1="0" y1="0" x2="0" y2="4" className="profile__steep-rule" />
          </pattern>
        </defs>

        <polygon points={geom.area} fill={`url(#${fillId})`} />

        {/* Drawn under the line, so the line stays readable over the hatch. */}
        {steep.map(([a, b]) => (
          <rect
            key={`${a}-${b}`}
            className="profile__steep"
            x={geom.px(a)}
            y="0"
            width={Math.max(0.6, geom.px(b) - geom.px(a))}
            height={VIEW_H}
            fill={`url(#${hatchId})`}
            vectorEffect="non-scaling-stroke"
          />
        ))}

        <polyline
          className="profile__line"
          points={geom.line}
          vectorEffect="non-scaling-stroke"
        />
      </svg>

      <div className="profile__axis tabular" aria-hidden="true">
        <span>{Math.round(geom.minY)} m</span>
        <span>{fmtDist(geom.maxX)}</span>
        <span>{Math.round(geom.maxY)} m</span>
      </div>

      <p className="profile__summary">{summary}</p>

      {warn && (
        <p className="profile__warn">
          <span className="profile__glyph" aria-hidden="true">⚠</span>
          {warn}
        </p>
      )}
    </>
  )
}
```

Notes for the implementer:
- `patternTransform="rotate(45)"` combined with `preserveAspectRatio="none"` shears the hatch to roughly 33° at the panel's usual width (~340px / 100 units horizontally, 88px / 40 units vertically). That is intentional and acceptable — the hatch's job is to be a non-colour signal, not to be geometrically true.
- Using an opaque hatch **pattern** rather than a translucent fill also means adjacent or overlapping spans cannot double-darken.
- `vectorEffect="non-scaling-stroke"` on the rect keeps the 1px boundary crisp under the non-uniform scale. Same trick the launch source used on the polyline (`feat/launch:…/ElevationProfile.jsx:63,97`).

### 1c. `frontend/src/lib/elevation.test.js` (new) — see the `tests` field.

---

## 2. EXISTING FILES TO EDIT

### 2a. `frontend/src/components/RouteDetail.jsx` (205 lines) — two edits

**Edit 1 — import.** Insert after line 11 (the closing `} from '../lib/format.js'`), matching `RouteRow.jsx:3` where the component import follows the lib imports:

```jsx
import ElevationProfile from './ElevationProfile.jsx'
```

**Edit 2 — mount.** Insert at **`RouteDetail.jsx:103`**, i.e. between the blocked notice (`{blocked && (…)}` closes at `:102`) and `<section className="detail__section">` "Along the way" (`:104`):

```jsx
      <section className="detail__section">
        <h4 className="detail__h">Climb</h4>
        <ElevationProfile profile={route.elevation} />
      </section>
```

Rationale for this position rather than `:124` (between "Along the way" and "Directions"): on the `accessible` preset the profile is the picture of a barrier the panel has just listed in words. `backend/accessibility.py:239-256` emits an `incline` Finding whose description reads *"steeper than the 8% limit"*, and `RouteDetail.jsx:100` renders it through `Barriers`. Putting the drawing directly under that note is the whole point of the feature. `:124` is an acceptable fallback if the blocked note ever moves.

Why direct import and not the injection pattern at `RouteDetail.jsx:172-175`: that comment scopes the generic slot to *phase-specific extras* that need App state — `StepList` needs `setHighlight` (`App.jsx:447`), `DaylightGuard` needs `origin`/`departAt`/two dispatchers (`App.jsx:450-456`). `ElevationProfile` needs nothing but `route.elevation`, which `RouteDetail` already has. **`App.jsx` is not edited at all.**

`.detail__section` is `display:flex; flex-direction:column; gap: var(--s2)` (`styles.css:1279-1283`), so the fragment's four children stack with no margin work.

### 2b. `frontend/src/lib/format.js` (209 lines) — one addition

Insert at **`format.js:56`**, immediately after `fmtDist` (which ends at `:55`):

```js
/**
 * Metres of climb. Deliberately not fmtDist: that rounds to the nearest 10 m
 * below a kilometre (:53), which would report 42 m of ascent as 40 m. A route
 * distance tolerates that; a climb figure quoted against an 8% limit does not.
 * Separate function so a future imperial toggle has one seam, not two.
 */
export function fmtClimb(metres) {
  if (metres == null || Number.isNaN(metres)) return '—'
  return `${Math.round(metres)} m`
}
```

### 2c. `frontend/src/styles.css` (1720 lines) — one appended section

Append after **`styles.css:1720`** (end of file, after `.detail__actions .button--primary:disabled`). Per the survey's §6 guidance, new sections go at the end and carry their own media queries; none is needed here.

```css
/* ------------------------------------------------------- elevation profile */

.profile__svg {
  width: 100%;
  height: 88px;
  display: block;
  background: var(--sunken);
  border: 1px solid var(--rule);
  border-radius: var(--r-sm);
  overflow: hidden;
}
.profile__line {
  fill: none;
  stroke: var(--ink);
  stroke-width: 1.5;
  stroke-linejoin: round;
}
.profile__fill-top {
  stop-color: var(--ink);
  stop-opacity: 0.18;
}
.profile__fill-bottom {
  stop-color: var(--ink);
  stop-opacity: 0.02;
}
/* Over the accessibility limit. Hatched in full-strength --warn-ink with a
   drawn boundary, not washed: a 22% tint is 1.45:1 against --sunken, which is
   below the 3:1 graphical-object threshold and disappears entirely in
   greyscale. The rules are 7.1:1 in light and 10.9:1 in dark. The same
   reasoning as .score__track--hatched at :1148-1157. */
.profile__steep-ground {
  fill: var(--warn-ground);
}
.profile__steep-rule {
  stroke: var(--warn-ink);
  stroke-width: 1.2;
}
.profile__steep {
  stroke: var(--warn-ink);
  stroke-width: 1;
}
.profile__axis {
  display: flex;
  justify-content: space-between;
  font-size: var(--t-micro);
  color: var(--ink-2);
}
.profile__summary {
  margin: 0;
  font-size: var(--t-small);
  color: var(--ink-2);
}
.profile__warn {
  margin: 0;
  font-size: var(--t-small);
  font-weight: 600;
  color: var(--warn-ink);
}
.profile__glyph {
  margin-inline-end: 3px;
}
```

**No new token is required**, so neither `:root` (`styles.css:16-62`) nor `[data-theme='dark']` (`:66-102`) is touched, and **no hex literal is added** — `ci.yml:158-170` (`no-hard-coded-colour`) stays green. `lib/dash.js` is not touched either: this component uses no route-identity colour.

### 2d. `frontend/src/api/mock.js` (346 lines) — five insertions

Without these, `VITE_MOCK_API=1` shows "Climb was not measured" on all three routes and the feature is invisible in the demo. `mock.js` is the fixture contract for any new field.

**Insert the generator immediately before `buildRoutes` at `mock.js:130`:**

```js
/**
 * A deterministic profile for a drawn geometry, shaped like the real one:
 * 120 samples, index-pair steep spans, and limit_pct as the backend sends it.
 *
 * `limit` is a parameter and not a literal 8 for the same reason the component
 * reads it off the payload — see lib/elevation.js.
 */
function profileFor(metres, { bumps, limit = 8.0, seed = 1 }) {
  const n = 120
  const distances_m = Array.from({ length: n }, (_, i) =>
    Number(((metres * i) / (n - 1)).toFixed(1)),
  )
  const elevations_m = Array.from({ length: n }, (_, i) => {
    const t = i / (n - 1)
    const base = 6 + 9 * Math.sin(Math.PI * t * seed)
    const ripple = bumps ? 4 * Math.sin(Math.PI * t * 11 * seed) : 0
    return Number((base + ripple).toFixed(1))
  })
  const deltas = elevations_m.slice(1).map((e, i) => e - elevations_m[i])
  const ascent_m = Number(deltas.filter((d) => d > 0).reduce((a, d) => a + d, 0).toFixed(1))
  const descent_m = Number(-deltas.filter((d) => d < 0).reduce((a, d) => a + d, 0).toFixed(1))
  const step = metres / (n - 1)
  const grads = deltas.map((d) => (d / step) * 100)
  const max_gradient_pct = Number(Math.max(...grads.map(Math.abs)).toFixed(1))
  const steep_spans = []
  grads.forEach((g, i) => {
    if (Math.abs(g) <= limit) return
    const prev = steep_spans.at(-1)
    if (prev && prev[1] >= i) prev[1] = i + 2
    else steep_spans.push([i, i + 2])
  })
  return { distances_m, elevations_m, ascent_m, descent_m, max_gradient_pct, steep_spans, limit_pct: limit }
}
```

**Then, one field per route object, placed after `blockers` to match `models.py:155/161` ordering:**

| Anchor | Insert |
|---|---|
| `mock.js:173` — after `blockers: [],` in `fastest` | `elevation: profileFor(fastestM, { bumps: false, seed: 1 }),` |
| `mock.js:212` — after the `blockers: [ … ],` array closes in `scenic` | `// One route with no profile at all, on the same principle as \`shade: null\` at :229 — "the router returned no elevation" is a branch nothing else exercises.`<br>`elevation: null,` |
| `mock.js:258` — after the `blockers: [ … ],` array closes in `accessible` | `// The blocked route carries the steep spans. That pairing is the feature.`<br>`elevation: profileFor(accessibleM, { bumps: true, seed: 3 }),` |
| `mock.js:282` — after `blockers: [],` in the unknown-objective stub | `elevation: null, // matches backend/main.py:637-650, which builds these without one` |

`frontend/src/api/client.js` needs **no change**: `fetchRoutes` passes route objects straight through (`client.js:117-118`), with no field whitelist.

---

## 3. WHAT IS DELIBERATELY *NOT* PORTED

**The `compact` sparkline branch (`feat/launch:…/ElevationProfile.jsx:53-68`) and the `.spark*` CSS (`feat/launch:…/styles.css:1869-1885`).** On `feat/launch` it mounted at `RouteCard.jsx:96`. That component does not exist on `main`; its replacement is `RouteRow`, and the sparkline cannot go there:

1. **Uniform row height is the component's stated purpose** (`RouteRow.jsx:30-33`). `route.elevation` is per-route nullable — null on `_blocked_route` stubs (`backend/main.py:637-650`), null whenever `build_profile` bails (`backend/elevation.py:72-73,76-77`), null on any `_guard` exception (`main.py:490`). A 26px graphic present on two rows and absent on the third is exactly the mis-alignment `styles.css:1129-1134` goes to `:has()`-selector lengths to prevent.
2. **`.route__sub` is `display:flex` with the default `nowrap`** (`styles.css:1060-1067`) and already carries four facts. A fifth overflows at 320px, which is a check the (currently absent) layout gate graded.
3. An unlabelled 26px polyline in a comparison row is decoration; the rail's job is four aligned facts.

Rejected alternative, recorded so it is not re-litigated: reserve the sparkline height rail-wide with a `.rail:has(…)` rule mirroring `styles.css:1129-1134`. It works, but it grows every row for a graphic that carries no comparable number, and it would be the second such hack in one component. Revisit only if a desktop-only wide rail lands.

Consequence: the port drops `compact` from the props entirely rather than shipping an unmounted branch.

---

## 4. TOKEN MAPPING

Every token the launch component's CSS (`feat/launch:frontend/src/styles.css:1869-1943`) and JSX depend on. **No launch token name or value is reintroduced.**

| Launch token | Launch value | Used for | Current equivalent | Current value | Note |
|---|---|---|---|---|---|
| `--space-1` | 4px | `.profile__axis` margin-top | *dropped* — `.detail__section` supplies `gap: var(--s2)` (`styles.css:1282`) | — | If an explicit gap is ever needed, `--s1` is the same 4px. |
| `--space-2` | 8px | `.profile__title` / `.profile__summary` / `.profile__warn` margins | *dropped* — same `gap: var(--s2)` | `--s2` = 8px | Margins removed in favour of the flex gap; `margin: 0` on the `<p>`s. |
| `--space-3` | 12px | `.profile` padding-top | *dropped* — the `<section>` wrapper handles it | `--s3` = 12px | The launch `.profile` block's `border-top: 1px solid var(--rule); padding-top` is replaced by `.detail__h` + section, matching every other detail section. |
| `--text-1` | 0.875rem (14px) | axis, summary, warn, title | **`--t-small`** (0.8125rem / 13px) for summary + warn; **`--t-micro`** (0.75rem / 12px) for the axis; **`--t-micro`** via `.detail__h` for the title | — | The redesign has no 14px step. Map by *role*, not by pixel: `.route__sub` (the equivalent meta line) is `--t-small` at `styles.css:1064`; `.score__head` and `.detail__pattern-note` are `--t-micro` at `:1113`/`:1295`. **Do not add a 14px token.** |
| `--ink-muted` | `#545f71` | axis + summary text, spark line | **`--ink-2`** | `#55645a` light / `#9baea1` dark | Straight rename. |
| `--ink` | **`#14213d`** (navy) | profile line stroke, both gradient stops | **`--ink`** | `#16241c` light / `#e8efe8` dark | **Same name, different value — this is the trap.** Reference the token, never the hex. |
| `--recessed` | `#f2eee5` | `.profile__svg` background | **`--sunken`** | `#ede9df` light / `#080f0b` dark | Rename. |
| `--rule` | `#ddd6c6` | `.profile` top border | **`--rule`** | `#dcd5c6` light / `#26362c` dark | Same name; repurposed here as the SVG's 1px border. |
| `--radius-control` | 6px | `.profile__svg` radius | **`--r-sm`** | 8px | Nearest current step. `--r-md` (12px) is too round for an inline chart. |
| `--warn-ink` | `#8a2c14` / dark `#ffb59b` | steep fill, warn text | **`--warn-ink`** | `#8a2c14` light / `#f5b49b` dark | Light value coincides; dark does not. Reference the token. |
| — (no launch counterpart) | — | hatch ground | **`--warn-ground`** | `#f7e9e1` light / `#2a1811` dark | New use, existing token. |
| `--font-body` | Newsreader/IBM Plex set | `.profile__title` | **`--font-body`** via `.detail__h` (`styles.css:1285`) | identical value | No change needed. |
| launch route palette — `--route-fastest #2f6fd0`, `--route-scenic #2e8b57`, `--route-accessible #7a4fc4`, `--route-quiet #b06a1f`, `--route-shade #12756c`, `--route-air #b03050`, plus `--score-*` aliases | — | **not used by this component** | — | — | ElevationProfile references no route-identity colour on either branch. There is nothing to map, and `frontend/src/lib/dash.js` is not touched. |
| `--safe-*` insets, `--page`, `--selected-border`, `--map-casing`, `--warn-border`, `--radius-card`, `--radius-chip`, `--text-2..6` | — | not used by this component | — | — | Listed only so the implementer can confirm nothing else leaks in. |

Also mapped, structurally rather than by token: launch's `<h4 className="profile__title">Climb</h4>` inside a bare `<div className="profile">` becomes `<h4 className="detail__h">Climb</h4>` inside `<section className="detail__section">`, which is the pattern at `RouteDetail.jsx:104-105`, `:125-126`, `:130-131`. This keeps the h3 → h4 heading order the axe harness audits (`a11y.jsx:85`).

---

## 5. BUILD / CI

No workflow change is required.

- `ci.yml:140-144` (`npm test`) picks up `frontend/src/lib/elevation.test.js` via vitest's default glob.
- `ci.yml:158-170` (`no-hard-coded-colour`) passes: the new CSS adds no hex.
- `ci.yml:146-147` (`npm run build`) is unaffected; no new dependency, runtime or dev.
- `Makefile:72` (`make check` = `lint coverage test-frontend build infra-lint`) covers the frontend tests and the backend suite; the new backend tests land inside `pytest backend/tests` and inside the `--cov` floor at `Makefile:50-51`.
- `deploy.yml:47` runs `pytest backend/tests` without `--cov`, so the new backend tests run there too.

### Risks and the rules that constrain it

﻿# Project rules, and how the design satisfies each

**Rule 1 — A missing OSM tag means UNKNOWN, never "accessible". Generalised: `null` ≠ `0` ≠ `[]`.**
`route.elevation === null` means "the router returned no elevation" (`backend/elevation.py:66-73` states this in terms, and `models.py:100-105` repeats it). The port therefore does **not** copy `feat/launch:…/ElevationProfile.jsx:24`'s `return null` — a silently absent section reads as "nothing to say about the climb". Instead `climbSentence(null)` returns *"Climb was not measured for this route. That is not a statement that it is level."*, rendered in `.field__hint`, exactly mirroring the rest-stop branch at `RouteDetail.jsx:106-110` and the reasoning at `lib/format.js:125-137`. Test T6 asserts that sentence differs from the flat-route sentence.
Second application: a route with real but tiny relief is drawn as a centred flat line (`FLAT_M = 1` in `profileGeometry`) and gets a measured sentence with real numbers — a *measured* flat route and an *unmeasured* one never render alike.

**Rule 2 — Colour is never the only differentiator; must survive greyscale.**
This is where the launch source actually fails (see the errors section). The steep bands get, in order of independence from hue:
1. a **hatch pattern** (`<pattern>` of 45°-rotated rules) — pure luminance structure, survives greyscale and every form of colour blindness;
2. a **drawn boundary** on each rect (`stroke: var(--warn-ink); stroke-width: 1`, `vectorEffect="non-scaling-stroke"`);
3. a **⚠ glyph** plus `font-weight: 600` on the warning paragraph, the same triple the verification meter uses (`styles.css:1193-1201`, `VerificationMeter.jsx:31-36`);
4. **the sentence itself**, which names the limit, the count and the position of every stretch.
Measured contrast of `--warn-ink` rules against `--sunken`: **7.07:1** light (`#8a2c14` on `#ede9df`), **10.9:1** dark (`#f5b49b` on `#080f0b`). Both clear the 3:1 graphical-object threshold with margin. For comparison, the launch rule's `fill: var(--warn-ink); opacity: 0.22` computes to **1.45:1** — it fails.
The profile line itself is `--ink` on `--sunken`, which is the app's maximum luminance separation.

**Rule 3 — The route list is a complete text substitute for the map; the graphic is never the only representation.**
The SVG is `aria-hidden="true" focusable="false"`; the axis row is `aria-hidden` too (it duplicates the summary's numbers). Everything the drawing shows is in the two `<p>`s: total ascent, total descent, steepest gradient, whether the limit is broken, how many stretches break it, **and where each one starts and ends**. The last of those is an addition — the launch summary said only "N stretches marked", so position was available to sighted users alone. Test T11 pins the positions.

**Rule 4 — No location history, no cookies, no analytics; localStorage for theme and units ONLY.**
This feature reads nothing and writes nothing. No `localStorage`, `sessionStorage`, `document.cookie` or `indexedDB` call is added; the two existing touch points (`lib/theme.js:20,29`, `index.html:28`) are untouched, so the promise at `About.jsx:29-33` stays true and needs no rewording. Elevation data is already in the response and is not persisted anywhere.

**Rule 5 — No new third-party runtime requests.**
Zero network calls. The SVG is inline markup, the hatch is an inline `<pattern>` (no image, no icon font — the same reason `TripBar.jsx:16-17` inlines its icons), and no font, CDN or asset is referenced. No new dependency of any kind: `package.json` is not edited, so neither `dependencies` (`:16-20`) nor `devDependencies` (`:21-26`) grows. **In particular, do not add jsdom** to make component tests possible — the logic is in a pure module instead.

**Rule 6 — All interactive targets ≥ 44×44 px.**
The feature introduces **no interactive element at all** — no button, no `<details>`, no link, no tooltip. Nothing is focusable (`focusable="false"` on the SVG defends against the IE/Edge legacy default). So `--target` (`styles.css:137`) is not engaged, and the two existing sub-44px offenders (`.theme-toggle` `:406`, `.preset` `:527`) are neither worsened nor cited as precedent. A `title=` tooltip — which the launch compact branch used at `:55` — is deliberately not ported: tooltips are keyboard- and touch-inaccessible.

**Repo-local invariants also honoured:**
- `styles.css:10-13` / `ci.yml:158-170` — no hex outside the two token blocks. The new CSS uses only existing tokens, so neither `:root` block is edited.
- `lib/dash.js:20-69` route-palette duplication — untouched; this component uses no route colour.
- `RouteRow.jsx:11-34` span-only rule — not engaged, because nothing is added to `RouteRow` (see §3 of the plan).
- `App.jsx:372-374` single live region — nothing here announces; no second live region is opened.
- `App.jsx:273-275` `useLayoutEffect` theme ordering — not engaged; unlike `MapView.jsx:42`, this component reads **no** token at runtime via `getComputedStyle`. All colour resolves in CSS.
- `App.jsx:206-258` fetch effect — untouched. No new reducer case, no `DEBOUNCE` key, no `nonce` bump, no `buildRouteRequest` field.
- Hook order — both `useId()` calls sit above the early return, matching `feat/launch:…/ElevationProfile.jsx:23-24`.

---

# What could break

1. **`enrichment_pending` must NOT gate this.** Unlike rest stops and the air/shade scores (`models.py:175-184`), elevation is **final on the first SSE pass**. My probe shows the `pending: true` and `pending: false` route events carrying byte-identical elevation objects for all three ids. Gating the profile on `!enrichment_pending` would blank it for the streaming window for no reason. Test B5 pins this. (Separately, Survey B's finding that `rest_stops: []` renders "no rest stops" during that window is a real defect — **out of scope here**, and this spec must not be read as fixing it.)
2. **`steep_spans` upper bound can equal the array length.** `backend/elevation.py:112` clamps `b` to `len(thin_grid)`, not `len - 1`. `xs[120]` on a 120-element array is `undefined`, which propagates as `NaN` into an SVG `x`/`width` and silently produces an invisible or full-width rect. `mergeSpans` clamps both ends; the launch source clamped only inside the width expression (`:93`) and would have produced `undefined` in the new position sentence. Test T3.
3. **Touching spans inflate the count.** Live fixture: scenic returns `[[90,93],[93,95]]`. Unmerged, the sentence says ten stretches where there are nine. Test T1. Root cause is the thinning rescale at `backend/elevation.py:106-115`; the client-side merge is a presentation fix, not a backend fix — an optional backend cleanup is noted in the tests field.
4. **Steep spans are common, not rare.** On the shipped replay fixtures every one of the three routes has them (7, 10 and 9 raw spans) and `max_gradient_pct` reaches 40–49%. Anyone who assumes the warning paragraph is an edge case will under-design it. It will be on screen for most demo routes, and with 9 merged spans the position sentence runs long. That is accepted: it is the only representation for a non-sighted reader, and it lives in a paragraph, not a chip.
5. **`preserveAspectRatio="none"` shears the hatch.** ~33° instead of 45° at typical panel widths. Cosmetic, intentional, documented in the CSS comment so nobody "fixes" it by switching to `meet` — which would letterbox the polyline and misalign the steep rects from the line they mark.
6. **`--ink` is a name collision, not a shared value.** Launch `--ink: #14213d` (navy) vs current `#16241c` (dark green). Copy-pasting the launch CSS block wholesale reintroduces `--space-*`, `--text-*`, `--recessed`, `--ink-muted` and `--radius-control`, none of which are defined on `main`: every one silently resolves to nothing, which for `font-size: var(--text-1)` means inherited size and for `background: var(--recessed)` means transparent. It will *look* almost right and be wrong. Retype the rules from the mapping table; do not `git checkout` the block.
7. **The blocked accessible route does have a profile.** It goes through `_scored_route` (`main.py:530` sets `status`, `:536-558` builds the `Route`), not `_blocked_route` (`:637-650`). So `RouteDetail` renders the blocked note *and* the profile together — verify visually that the two warn-toned blocks (`.note--warn` at `styles.css:1325` and `.profile__warn`) stacked adjacently do not read as one alarm. If they do, move the section to `RouteDetail.jsx:124`.
8. **axe coverage is manual.** `frontend/a11y.jsx:85` runs `axe.run(document, …)`, so the profile *is* audited — but only when someone opens `frontend/a11y.html` by hand: nothing in `ci.yml`, `deploy.yml`, the `Makefile` or `package.json` invokes it (`grep -rn "a11y"` across those returns zero hits), and `a11y.html` is not a Vite build input (`vite.config.js:11-19` declares no `rollupOptions.input`). Run it manually once, in both themes, after this lands.
9. **`fmtClimb` vs a future units toggle.** The project rules reserve a `units` localStorage key, implying an imperial toggle is coming. `fmtClimb` is added as the single seam for elevation metres; if that feature lands and threads a unit through `fmtDist`, it must thread the same one through `fmtClimb` or the panel will read "42 m climb over 2.3 miles".
10. **Mock and wire must not drift.** Adding `elevation` to `mock.js` creates a second description of the field's shape. The `profileFor` generator mirrors `build_profile`'s output contract (120 samples, index pairs, `limit_pct`); if the backend contract changes, `mock.js:130` is the second place to edit. This is the same known duplication the survey flags for `api/mock.js` generally.
11. **Nothing currently proves the profile reaches the wire.** All 12 tests in `backend/tests/test_elevation.py` (163 lines) call `build_profile` directly; `grep -n "api_client\|/api/routes" backend/tests/test_elevation.py` is empty, and neither `test_api_routes.py` nor `test_sse_contract.py` mentions elevation. The `ElevationProfile(**vars(assessment.elevation))` dataclass→pydantic conversion at `main.py:557` is unguarded. Until tests B1–B5 land, a rename in `backend/elevation.py`'s dataclass would break the UI with a green suite.

### Tests

﻿## Frontend — NEW FILE `frontend/src/lib/elevation.test.js`

vitest, node environment (no jsdom, none needed). Follows `frontend/src/lib/follow.test.js:1-11` for import style. Runs under `npm test` → `ci.yml:140-144` and `Makefile:53-54`.

Shared fixtures at the top of the file:

```js
const N = 20
const XS = Array.from({ length: N }, (_, i) => i * 100)          // 0 … 1900 m
const YS = Array.from({ length: N }, (_, i) => 10 + Math.sin(i) * 3)
const FLAT = { distances_m: XS, elevations_m: XS.map(() => 12), ascent_m: 0,
               descent_m: 0, max_gradient_pct: 0, steep_spans: [], limit_pct: 8 }
const HILLY = { distances_m: XS, elevations_m: YS, ascent_m: 42.4, descent_m: 39.1,
                max_gradient_pct: 12.6, steep_spans: [[10, 15]], limit_pct: 8 }
```

| # | Name | Asserts | Why it exists |
|---|---|---|---|
| **T1** | `merges spans the thinning rescale left touching` | `mergeSpans([[90,93],[93,95]], 120)` → `[[90,95]]` | The live scenic-route fixture returns exactly this pair. Unmerged, the sentence claims ten stretches where there are nine, contradicting `backend/elevation.py:89-90`. |
| **T2** | `keeps spans that are genuinely separate` | `mergeSpans([[0,2],[3,6]], 120)` → `[[0,2],[3,6]]` | Guards against an over-eager merge. Also from the live fixture. |
| **T3** | `clamps the exclusive end the backend can emit` | `mergeSpans([[116,120]], 120)` → `[[116,119]]` | `backend/elevation.py:112` clamps `b` to `len(thin_grid)`, so `xs[120]` is `undefined`. Without this, the position sentence prints `—` and the rect gets `NaN`. |
| **T4** | `drops empty and inverted spans` | `mergeSpans([[5,5],[9,4],[-3,-1]], 120)` → `[]` | Defensive; a zero-width rect is invisible but a reversed one gets a negative width. |
| **T5** | **`quotes the limit from the payload, never a literal 8`** | `climbSentence({...HILLY, limit_pct: 5})` matches `/\b5%/` and `expect(s).not.toMatch(/8\s*%/)`; repeat with `limit_pct: 12` → matches `/\b12%/`. Same two assertions for `steepSentence`. | **This is the anti-restatement gate.** It is the executable form of "import the constant rather than restate it": if anyone hard-codes 8 in the JS, this fails. Cite it in the test's comment. |
| **T6** | `an unmeasured profile is not a flat one` | `climbSentence(null)`, `climbSentence(undefined)`, `climbSentence({})` all equal the not-measured sentence; it matches `/not measured/`, contains no digit (`expect(s).not.toMatch(/\d/)`), and `expect(climbSentence(null)).not.toEqual(climbSentence(FLAT))` | Rule 1 in code. `null` and "flat" are different statements. |
| **T7** | `a flat route draws down the middle, not along the floor` | `profileGeometry(FLAT).line` has no `NaN`, and every y-coordinate equals `'20.00'` (`VIEW_H / 2`) | The launch comment at `:32-33` claims `span = maxY - minY \|\| 1` prevents a line pinned to an edge. It does not — it yields `py = 39` on a 40-unit box. This pins the fix. |
| **T8** | `rejects a payload whose arrays disagree` | `profileGeometry({distances_m:[0,1], elevations_m:[1,2,3], …})` → `null`; the component then renders the not-measured hint rather than a garbled line | The launch source had no such guard. |
| **T9** | `survives a zero-length route` | `profileGeometry({distances_m: XS.map(()=>0), elevations_m: YS, …}).line` has no `NaN` | Exercises the `xs.at(-1) \|\| 1` fallback. |
| **T10** | `no steep spans means no warning` | `steepSentence(FLAT)` → `null`; `climbSentence(FLAT)` matches `/within the 8% limit/` and does **not** match `/stretch/` | The quiet path must stay quiet. |
| **T11** | **`names where each steep stretch is`** | `steepSentence(HILLY)` contains `'1.0 km'` (`fmtDist(XS[10])`) and `'1.5 km'` (`fmtDist(XS[15])`) | The SVG is aria-hidden, so position must be in the text. Launch shipped only a count — this test is the reason the sentence changed. |
| **T12** | `counts stretches in words the way the app speaks` | one merged span → `/for one stretch/`; two → `/for 2 stretches/`; and with three, the list joins as `"A, B and C"` | Matches the house style in `lib/format.js:182-183`. |

## Backend — APPEND to `backend/tests/test_api_routes.py` (currently 383 lines)

These close the gap the survey correctly identified: all 12 tests in `backend/tests/test_elevation.py` (163 lines) call `build_profile` directly and **nothing asserts the profile survives onto the wire**. Use the existing `api_client` fixture (`backend/tests/conftest.py:137`) and the existing `_body()` helper (`test_api_routes.py:16-24`).

| # | Name | Asserts |
|---|---|---|
| **B1** | `test_routable_routes_carry_an_elevation_profile` | For every route in `payload["routes"]` with non-empty `geometry`: `r["elevation"]` is not `None` and has exactly the seven keys `distances_m, elevations_m, ascent_m, descent_m, max_gradient_pct, steep_spans, limit_pct`. Guards the unguarded `ElevationProfile(**vars(...))` conversion at `backend/main.py:557`. |
| **B2** | **`test_the_wire_limit_is_the_accessibility_constant`** | `from backend.accessibility import MAX_INCLINE_PCT`; for every route, `r["elevation"]["limit_pct"] == MAX_INCLINE_PCT`. **The backend half of the anti-drift pair with T5.** Together they prove the number the UI prints is the number the engine rejects on, with no third copy anywhere. |
| **B3** | `test_profile_arrays_agree_and_are_capped` | `len(distances_m) == len(elevations_m)`, `3 <= len <= MAX_PROFILE_POINTS` (imported from `backend.elevation`), and `distances_m` is non-decreasing. Pins the payload shape `profileGeometry` relies on. |
| **B4** | `test_steep_span_indices_stay_inside_the_arrays` | For every `[a, b]`: `0 <= a < b <= len(elevations_m)`. Note the `<=` — this test **documents** that `b` may equal the length (`backend/elevation.py:112`), which is precisely why `mergeSpans` clamps. Add a comment saying so and pointing at T3. |

## Backend — APPEND to `backend/tests/test_sse_contract.py` (currently 197 lines)

| # | Name | Asserts |
|---|---|---|
| **B5** | `test_elevation_is_already_final_on_the_first_pass` | Collect all `route` events. For each id, the event with `enrichment_pending is True` and the one with `False` have **equal** `elevation` objects, both non-`None`. Probe-verified. This is the test that licenses the UI *not* to gate the profile on `enrichment_pending` the way it must for rest stops and air/shade (`backend/models.py:175-184`). |

## Backend — OPTIONAL, `backend/tests/test_elevation.py` (currently 163 lines, 12 tests)

| # | Name | Asserts |
|---|---|---|
| **B6** | `test_thinning_can_leave_two_spans_touching` | Construct an elevation series that yields two separate raw spans which collide after the rescale at `backend/elevation.py:106-115`, and assert the returned `steep_spans` contain a pair where `spans[i][1] == spans[i+1][0]`. |

B6 documents the behaviour the client merges around. If the team would rather fix it at the source, the change is a merge pass appended after `elevation.py:115` — but then **keep `mergeSpans` and keep T1 anyway**: the client must stay correct against an older backend, and the clamp in T3 is needed regardless.

## Manual check (not automatable in this repo)

Open `frontend/a11y.html` (`npm run dev`, then the harness route) with a selected route in **both themes** and confirm `window.__axeResults.violations.length === 0`. Nothing in `ci.yml`, `deploy.yml`, the `Makefile` or `package.json` runs it — `grep -rn "a11y"` across those returns zero hits — so this is a one-time human step. While there, screenshot the profile and desaturate it to confirm the hatched bands are still legible; that is the only greyscale check the repo has.

---

## Offline: saved routes, the consent gate, the service worker, and the age labelling contract (lib/offline.js + lib/offlineStore.js + sw.js + OfflineBar / OfflineControl)

**OPEN**

### Sources read on `feat/launch`
- git show feat/launch:frontend/src/lib/offline.js — 161 lines (read in full)
- git show feat/launch:frontend/src/lib/offlineStore.js — 170 lines (read in full)
- git show feat/launch:frontend/sw.js — 290 lines (read in full)
- git show feat/launch:frontend/src/components/OfflineBar.jsx — 42 lines (read in full)
- git show feat/launch:frontend/src/components/OfflineControl.jsx — 61 lines (read in full)
- git show feat/launch:frontend/src/components/TakeItWithYou.jsx — 81 lines (read in full; NOT part of this capability — see risks)
- git show feat/launch:frontend/src/lib/pwa.js — 42 lines (read in full)
- git show feat/launch:frontend/scripts/check-offline.mjs — 174 lines (read in full)
- git show feat/launch:frontend/vite.config.js — 134 lines (read lines 1-130: the meanderServiceWorker plugin, API_PROXY, devHttps)
- git show feat/launch:frontend/src/api/client.js — 232 lines (read lines 60-175: cacheStampFrom and its application to the SSE and JSON paths)
- git show feat/launch:frontend/src/App.jsx — 520 lines (read lines 160-290 plus a full grep for offline symbols: cacheStamp, useOnline, useCacheAge, the announce preamble, the OfflineBar mount)
- git show feat/launch:frontend/src/components/BetterLater.jsx — 66 lines (read lines 1-60: departureHasPassed + useNow, the expiry behaviour)
- git show feat/launch:frontend/src/components/TrustSignal.jsx — 78 lines (read lines 20-90: the per-route cachedNotice branch)
- git show feat/launch:frontend/src/components/RouteRow.jsx — lines 1-60 (the row__cached chip)
- git show feat/launch:frontend/src/components/TopBar.jsx — lines 1-60 (the topbar__cached pill)
- git show feat/launch:frontend/src/styles.css — 1790 lines (read the token :root block lines 1-120, and the .topbar__cached 374-395, .better-later 904-935, .offline 939-970, .row__cached 1115-1130, .trust--cached 1334-1352 blocks)
- git show feat/launch:frontend/src/lib/units.js — 159 lines (line count only; a separate capability, cited because it is the second permitted localStorage key)
- git ls-tree -r feat/launch --name-only -- frontend/public — 6 files (manifest.webmanifest + 5 PNGs; the manifest link is a dependency of this spec, not part of it)

### Plan

## 0. The storage question, answered first, because it changes the design

The capability brief guesses "offlineStore presumably uses IndexedDB/CacheStorage". **It uses neither. It uses localStorage.**

- `feat/launch:frontend/src/lib/offlineStore.js:31` — `const KEY = 'meander.offline'`
- `:36` `localStorage.getItem(KEY)`, `:88` `localStorage.setItem(KEY, JSON.stringify({saveResults}))`, `:99` `localStorage.removeItem(KEY)`
- There is no `indexedDB` anywhere in the launch offline code.
- **CacheStorage appears only in `sw.js`** — `caches.open(SHELL_CACHE | RESULTS_CACHE | PREFS_CACHE)`.

So a byte-for-byte port adds a **third localStorage key**, which breaks the rule "localStorage is for theme and units ONLY". Launch's own design already contains the fix: the worker cannot read localStorage (`offlineStore.js:24-27`), so the flag is *mirrored* into `PREFS_CACHE` at `sw.js:107-115`, and re-pushed on every page load (`offlineStore.js:70-80`, `pwa.js:28`) so an evicted worker cannot come back holding a withdrawn permission.

**Decision: delete the mirror. The consent flag lives only in CacheStorage, in the `meander-prefs` bucket the worker already owns, written and read directly by the page.**

Why this is still consistent with the privacy promise:

1. CacheStorage is origin-scoped and is **never transmitted**. Unlike a cookie it is not attached to any request, so it cannot become an identifier.
2. The prefs bucket holds one body of four or five bytes — `true` or `false` — at `/__meander__/save-results`. It is exactly as revealing as `meander:theme`, i.e. not at all.
3. The shell bucket holds the program. Identical bytes for every visitor, derived from the build. It says nothing about anybody, which is the argument `sw.js:22-25` already makes.
4. The results bucket is the only location-bearing store. It holds **exactly one** entry — `sw.js:141-142` deletes every existing key before putting the new one — it is written only when the flag reads `true` (`sw.js:171`), and it is deleted from two independent paths on revocation (`sw.js:110` and `sw.js:176`).
5. **Single source of truth beats a mirror, and it fails closed harder.** A browser wiping site data wipes the flag and the saved route together. The localStorage mirror could in principle survive a CacheStorage eviction and re-grant permission for a cache that no longer exists.
6. `window.caches` is `undefined` on an insecure origin, so the read yields "off". Failing closed is the only correct direction for a flag guarding a write of someone's location — which is the reasoning already written at `sw.js:99-102`.

Consequence to design for: the read is asynchronous. `useOfflineSetting()` returns `{ saveResults, chosen, ready }` and renders as *off* until `ready`. Off-until-proven-on is the honest default anyway.

Second consequence: `sw.js`'s whole `message` handler (`sw.js:105-125`, ~21 lines) can go. The page writes the prefs cache itself and sweeps results caches by name prefix, so it needs no live worker — which also removes the "page is not yet controlled on first load" workaround at `offlineStore.js:63-67`.

---

## 1. NEW FILES

### 1a. `/Users/poojana/Meander/Meander/frontend/src/lib/offline.js` (~165 lines)

Straight port of `feat/launch:frontend/src/lib/offline.js`. **The seven exported functions change by not one character** — they are pure, they are the contract, and the tests below execute every branch.

Exports: `cacheAgeMs(cachedAt, now)`, `cacheTier(ageMs)`, `formatCacheAge(ageMs)`, `cacheChipText(ageMs)`, `cachedNotice(ageMs)`, `offlineBarText(ageMs, online)`, `departureHasPassed(when, now)`.
Constants: `AGEING_MS = 15 * 60 * 1000`, `STALE_MS = 6 * 60 * 60 * 1000`.

Behaviour that must survive the port intact:
- `cacheAgeMs` returns `null` for missing, unparseable, **and future** timestamps (launch `:42-52`). `null` is not zero.
- `cacheTier(null) === 'loud'` (launch `:55`). An entry that cannot say how old it is is the least trustworthy, not the most.
- `cachedNotice` always returns a non-empty `headline` for every input (launch `:97-131`).

One comment edit only: launch `offline.js:12` says "the same rule `TrustSignal` applies to accessibility coverage". `TrustSignal` does not exist on this branch. Repoint at `frontend/src/lib/format.js:114 verificationTier` and `frontend/src/components/VerificationMeter.jsx`, which are the same escalate-with-severity pattern on `main`.

### 1b. `/Users/poojana/Meander/Meander/frontend/src/lib/offlineStore.js` (~150 lines)

**Rewritten**, not ported. No localStorage. Shape:

```
export const PREFS_CACHE = 'meander-prefs'
export const PREF_URL = '/__meander__/save-results'
export const RESULTS_PREFIX = 'meander-results-'
// Duplicated in frontend/sw.js — the worker cannot import from src/. The two
// must agree on these three strings. Same arrangement, and the same standing
// warning, as index.html:22-23 / lib/theme.js:14.
```

- `getOfflineSetting()` → the cached snapshot `{ saveResults, chosen, ready }`.
- `refreshOfflineSetting()` — async; `caches.open(PREFS_CACHE)` → `match(PREF_URL)` → `text() === 'true'`. Every path wrapped; any throw (no `caches`, storage disabled, quota) resolves to `{saveResults:false, chosen:false, ready:true}`.
- `setSaveResults(bool)` — `cache.put(PREF_URL, new Response(bool ? 'true':'false'))`; when `false`, also `forgetResults()`. Emits to subscribers.
- `forgetResults()` — `caches.keys()`, delete every key `startsWith(RESULTS_PREFIX)`. **Never touches `meander-shell-*` or `meander-prefs`.** Page-side so it works with no worker running; `sw.js`'s else-branch keeps its own belt-and-braces copy.
- `clearOfflineSetting()` — delete the pref entry, then `forgetResults()`.
- `useOfflineSetting()` — `useSyncExternalStore`, with a mount effect that kicks `refreshOfflineSetting()` once.
- `useNow(intervalMs = 30_000)` — ported verbatim from launch `:138-146`. Keep the comment: a phone left on a table is the ordinary case.
- `useCacheAge(cachedAt, intervalMs = 30_000)` — ported verbatim from launch `:127-129`.
- `useOnline()` — ported verbatim from launch `:155-170`, including the comment that `navigator.onLine` reports the link and not reachability and is used **only** to choose between two wordings.

Deleted relative to launch: `SW_MESSAGE`, `SW_FORGET`, `syncToServiceWorker`, and the `read()` localStorage function.

### 1c. `/Users/poojana/Meander/Meander/frontend/sw.js` (~270 lines)

Port of `feat/launch:frontend/sw.js` with three deletions and nothing added.

**Keep verbatim, all of it:**
- the header comment `sw.js:1-41`, and in particular the block at `:28-40` naming what is never cached. The sentence *"a tile cache is a record of where you have been"* is required to survive word for word.
- `VERSION`/`SHELL_CACHE`/`RESULTS_CACHE` at `:43-45`, and **`PREFS_CACHE = 'meander-prefs'` with no `${VERSION}` in it** — that is what makes the permission survive a deploy without being silently re-granted or revoked.
- `install`/`activate` (`:53-80`), including `cache: 'reload'` and the keep-set.
- `mayStoreResults()` (`:93-103`) — unchanged; it already reads the prefs cache, which is now the only writer.
- `routeCacheKey` (`:129-137`), `storeResult` (`:150-168`) with the `"type":"done"` requirement and the `"type":"error"` rejection, and the delete-after-write ordering.
- `handleRoutes` (`:181-215`) with the key computed **before** the fetch and the copy drained inside `waitUntil` — both comments are scar tissue and must stay.
- `SHELL_MATCH` with `ignoreVary: true` (`:236`) and its comment.
- the `fetch` listener (`:270-289`), including `if (url.origin !== self.location.origin) return` — **this single line is what enforces "map tiles are never cached"** and it must be asserted by a test, not trusted.

**Delete:**
- the whole `message` listener, `sw.js:105-125`. The page owns the flag now.
- `forgetResults` stays (`sw.js:89-91`); it is still called from `handleRoutes`'s else branch at `:176`.

### 1d. `/Users/poojana/Meander/Meander/frontend/src/lib/pwa.js` (~40 lines)

Port of launch `pwa.js` minus the `syncToServiceWorker()` chain. `registerServiceWorker()` stays gated on `import.meta.env.PROD` (launch `:17`) and stays deferred to the `load` event (launch `:24`). Keep `unregisterServiceWorkers()` — the future PWA gate needs it.

### 1e. `/Users/poojana/Meander/Meander/frontend/src/components/OfflineBar.jsx` (~50 lines)

Port of launch `OfflineBar.jsx`, same name so it maps 1:1 onto the `BLOCKED.md` §5 checklist. Same props `{ ageMs, online }`, same three paragraphs. Changes:
- the docstring's reference to the sheet's peek snap is meaningless here; replace with: this is mounted at `App.jsx:379` as a sibling of `Ribbon`, inside `.app` (`styles.css:218-224`, a `100dvh` flex column) and **above** `.layout`. `.panel` is the only thing that scrolls (`styles.css:238-248`), so this cannot be scrolled away. That is the "no panel position can hide it" surface.
- add `⚠` (`aria-hidden`) before the headline at `amber` and `loud`, matching `Ribbon.jsx:26-28`. Volume must not be colour-only.
- `role="status"` stays. It is an inert region, **not** a second live region — the announcement still goes through the one at `App.jsx:372-374`.

### 1f. `/Users/poojana/Meander/Meander/frontend/src/components/OfflineControl.jsx` (~70 lines)

Port of launch `OfflineControl.jsx`. Structure survives exactly: `fieldset.chips` > `legend` > `.chips__row` > two `button.chip` with `aria-pressed`, plus a `p.field__hint` whose text depends on the setting. `.chip` already carries `min-height: var(--target)` (`styles.css:783`); add `min-width: var(--target)` to the new modifier if the shorter label falls under 44px.

Wording changes required:
- the docstring cross-references `UnitsControl`, which does not exist here. Point at `lib/theme.js:1-12` instead — same argument, same shape, and it is the only other browser write.
- the on-state hint must now say **where** it is kept, because the answer changed: "…stored on this device in the browser's cache store — not in a cookie, and never sent anywhere."
- add one sentence to the off-state hint: the app shell is cached either way, and that is the program and not a route.

Mount point: **inside `About`**, not the trip bar. Reasons, in order: (1) the control that changes the privacy promise belongs against the sentence that states it (`About.jsx:29-33`); (2) `RouteDetail.jsx:176-180` is a standing prohibition on Save controls in the detail panel, and a per-route save is exactly what it forbids — this is a standing permission, not a per-route save, and putting it in About keeps the distinction visible; (3) a fifth `TripBar` segment produces an orphan half-row in the two-column `.tripbar__grid` (`styles.css:444-448`); (4) About is already reachable in one click from the topbar `?` (`App.jsx:357-363` opens it, scrolls it into view and focuses the summary).

### 1g. `/Users/poojana/Meander/Meander/frontend/src/styles.css` — new section, appended after line 1720

A new banner-comment section `/* --------------------------------------------------------------- offline */` at the **end** of the file. Do not edit the responsive block at `1409-1486`; `departure`, `steps` and `follow` are already declared after it, so the file's own convention is that a new section carries its own media query.

Blocks: `.offline`, `.offline--amber`, `.offline--loud`, `.offline__headline`, `.offline__detail`, `.offline__detail--map`, `.offline__icon`, `.badge--cached`, `.badge--cached-amber`, `.badge--cached-loud`, `.detail__cached`.

**Zero new colour tokens.** Everything reuses `--sunken`, `--rule-strong`, `--warn-ground`, `--warn-rule`, `--warn-ink`, `--ink-2`, `--shadow-1`. `scripts/check_palette.sh` (run by `Makefile:67-68` and `ci.yml:157-158`) therefore stays green without a token addition.

### 1h–1k. Tests — see the tests field.

---

## 2. EDITS TO EXISTING FILES — every one anchored to a real line

### `frontend/src/api/client.js` (160 lines)

The stamp is applied **once, at the boundary**. A route object that travels any distance through the app without it can be rendered as current by any component that touches it.

- **after `:70`** (end of `toApiError`) — add `cacheStampFrom(res)`, ported from launch `client.js:88-89`. Keep launch's comment that `servedFromCache`/`cachedAt` are camelCase on purpose, because every server field is snake_case and the casing is the signal that these did not come off the wire. **Add a warning the launch file did not need:** `X-Meander-Cached` (worker, "this is a replay") is one letter from `X-Meander-Cache` (server, `backend/main.py:1134,1136,1145,1161`, "the server had a warm cache for a completely current answer"). They mean opposite things. Do not conflate them, and do not read `X-Meander-Cache` here.
- **after `:86`** (`if (!res.ok) throw await toApiError(res)`) — `const stamp = cacheStampFrom(res)` plus the `mark` / `markPayload` helpers from launch `:110-113`.
- **`:91`** `json.routes.forEach(onRoute)` → `json.routes.forEach((route) => onRoute(mark(route)))`
- **`:92`** `return json` → `return markPayload(json)`
- **`:117`** `else if (evt.type === 'route') onRoute(evt.route)` → `onRoute(mark(evt.route))`
- **`:118`** `else if (evt.type === 'done') final = evt.payload` → `final = markPayload(evt.payload)`

`api/mock.js` needs no change: mock mode never goes through a worker, so `servedFromCache` is simply absent and every surface below is a no-op.

### `frontend/src/App.jsx` (491 lines)

- **after `:9`** (`import MapView`) — `import OfflineBar from './components/OfflineBar.jsx'`
- **after `:18`** — `import { cacheAgeMs, formatCacheAge } from './lib/offline.js'` and `import { useCacheAge, useOnline } from './lib/offlineStore.js'`
- **between `:179` and `:181`** (after `reducer`, before `App`) — module-scope `cacheStamp(routes)`, ported from launch `App.jsx:173-177`:
  ```js
  function cacheStamp(routes) {
    const hit = routes.find((route) => route.servedFromCache)
    return hit ? { cachedAt: hit.cachedAt ?? null } : null
  }
  ```
  Keep launch's reason (`:162-172`): reading it off the routes rather than holding it in the reducer means it cannot drift from what is rendered, and the moment a live route lands the stamp is gone with no separate state to clear. **This is why no reducer case, no `DEBOUNCE` key and no `initialState` field are added.**
- **after `:190`** (`const aboutRef = useRef(null)`) — `const online = useOnline()`
- **after `:195`** (the `mode` useMemo) —
  ```js
  const cached = useMemo(() => cacheStamp(state.routes), [state.routes])
  const ageMs = useCacheAge(cached?.cachedAt)
  ```
- **`:246`** `announce(announceRoutes(payload?.routes ?? arrived))` → prepend the preamble, launch `App.jsx:266-272`. A listener gets the caveat **before** the three durations, in the same order a sighted reader meets it:
  ```js
  const stamp = cacheStamp(payload?.routes ?? arrived)
  const preamble = stamp
    ? `Showing a saved copy from ${formatCacheAge(cacheAgeMs(stamp.cachedAt))}. `
    : ''
  announce(preamble + announceRoutes(payload?.routes ?? arrived))
  ```
- **after `:378`** (`<Ribbon routes={state.routes} />`) — `{cached && <OfflineBar ageMs={ageMs} online={online} />}`
- **`:435-442`** `<RouteRail …>` — add `cacheAgeMs={ageMs}`
- **`:444-457`** `<RouteDetail …>` — add `cacheAgeMs={ageMs}`

**Do not touch** `:257` (the `eslint-disable-next-line react-hooks/exhaustive-deps`), `:258` (`[state.nonce]`), or the abort ordering at `:211-213`. Nothing here is a fetch input; nothing bumps the nonce.

### `frontend/src/components/RouteRail.jsx` (59 lines)

- **`:31`** signature — add `cacheAgeMs` to the destructure.
- **`:48-54`** — pass `cacheAgeMs={cacheAgeMs}` to `RouteRow`.

Nothing else. The `results-head` right-hand slot at `:41` is deliberately left empty; the age belongs on the row, not on the heading.

### `frontend/src/components/RouteRow.jsx` (136 lines)

- **`:35`** signature — add `cacheAgeMs`.
- **insert before `:70`** — i.e. between `</span>` closing `.badge--blocked` at `:69` and `<span className="route__dur tabular">` at `:70`. The position is forced: `.route__dur` uses `margin-inline-start: auto` (`styles.css:1044`), so anything appended after it is pushed off to the right of the duration.
  ```jsx
  {route.servedFromCache && (
    <span className={`badge badge--cached badge--cached-${cacheTier(cacheAgeMs)}`}>
      <span className="visually-hidden">Saved copy from {formatCacheAge(cacheAgeMs)}. </span>
      <span aria-hidden="true">{cacheChipText(cacheAgeMs)}</span>
    </span>
  )}
  ```
  This is launch `RouteRow.jsx:52-56` retargeted at `main`'s `.badge` vocabulary. **Every element is a `<span>`**, which is the hard constraint documented at `RouteRow.jsx:11-34`.
  `cacheChipText` is guaranteed ≤ 20 characters (launch check-offline `:96-100`, ported below), which is what keeps the row height uniform — the whole point of the component per `RouteRow.jsx:30-33`.

### `frontend/src/components/RouteDetail.jsx` (205 lines)

- **`:58`** signature — add `cacheAgeMs`.
- **insert at `:103`** — between `)}` closing the blocked note at `:102` and `<section className="detail__section">` at `:104`. Above "Along the way", for the reason this file already gives at `:55-56` about the blocked notice: it changes whether any of the rest matters.
  ```jsx
  {route.servedFromCache && (() => {
    const { tier, headline, detail } = cachedNotice(cacheAgeMs)
    return (
      <div className={tier === 'quiet' ? 'note detail__cached' : 'note note--warn detail__cached'}>
        <p className="note__title">{headline}</p>
        {detail && <p className="note__sub">{detail}</p>}
      </div>
    )
  })()}
  ```
  `.detail` is `flex-column; gap: var(--s4)` (`styles.css:1234-1244`), so no margin work is needed.

### `frontend/src/components/DepartureStrip.jsx` (84 lines)

This fixes a defect that exists on `main` **independently of offline**: `best_departure` is an absolute instant computed when the request was made, and nothing here can expire it. A tab left open past it renders "Leave at 19:15" at nine in the evening. A replayed cached response makes it hours worse.

- **`:1`** — add `import { departureHasPassed } from '../lib/offline.js'` and `import { useNow } from '../lib/offlineStore.js'`.
- **insert at `:20`**, as the **first statement of the function body** — `const now = useNow()`. This ordering is load-bearing: `:21` is an early `return null`, and a hook after it violates the rules of hooks.
- **replace `:47-52`** (the `<p className="departure__head">`) with a branch. When `departureHasPassed(bestDeparture, now)`, render the withdrawal instead of the time:
  > "Meander suggested a better time to set off, but it has already passed."

  Withdrawn, not recomputed — launch `BetterLater.jsx:26-28`: choosing a new time needs the air-quality and cloud-cover series for the hours ahead, which is exactly what an expired or cached response no longer has.
- **Keep the hour chips at `:56-81` unchanged.** They are computed from `now` (`:33-40`) and are still correct and still useful. Launch's `BetterLater` returned early because it owned nothing else; this component owns the chips.
- **Do not touch the guard at `:21`.** The strip's non-rendering when there is no `best_departure` is a known, separate trap (`App.jsx:431-433` already works around it). Changing it changes when the strip appears at all, which is out of scope.

### `frontend/src/components/About.jsx` (53 lines)

**This edit is mandatory, not cosmetic. The moment the worker precaches the shell, `About.jsx:29-33` becomes a false statement, and it is the sentence the whole privacy promise rests on.**

- **`:1`** — add `import OfflineControl from './OfflineControl.jsx'`.
- **replace `:29-33`.** Current text: "Nothing is stored. No cookies, no analytics, no location history … The only thing kept in this browser is whether you chose the light or the dark theme." Replacement must state three things and no more: no cookies / no analytics / no location history (unchanged and still true); the app itself is kept so it opens without a network, and it says nothing about anybody; a *route* is kept only if you ask, one at a time, always labelled with its age, deleted the moment you say no.
- **insert `<OfflineControl />` after that paragraph and before `:35`** (the cache-stats block).

### `frontend/src/main.jsx` (12 lines)

- **after `:6`** — `import { registerServiceWorker } from './lib/pwa.js'`
- **after `:12`** (the closing `)` of the render call) — `registerServiceWorker()`

### `frontend/vite.config.js` (35 lines)

- **`:1-2`** — add `import { createHash } from 'node:crypto'`, `import { existsSync, readFileSync, readdirSync } from 'node:fs'`, `import { dirname, join } from 'node:path'`, `import { fileURLToPath } from 'node:url'`; `const here = dirname(fileURLToPath(import.meta.url))`.
- **before `:4`** — the `meanderServiceWorker()` plugin, ported from launch `vite.config.js:41-92`. Keep `apply: 'build'`, `enforce: 'post'` (without it the first build produced a precache with no document in it), the `replaceAll` (a non-global replace hit the mention inside `sw.js`'s own header comment and shipped a literal `__PRECACHE__`), the post-substitution assertion, and the derived-not-stamped version — `Date.now()` would change the worker's bytes on every build and evict the shell whether or not anything changed.
  **One change:** launch `:57` calls `readdirSync(join(here,'public'))` unguarded. `frontend/public/` does not exist on this branch. Wrap it in `existsSync` so this lands independently of the icons capability.
- **`:5`** `plugins: [react()]` → `plugins: [react(), meanderServiceWorker()]`
- **`:6-10`** — restore launch's `API_PROXY` const with `process.env.VITE_API_PROXY_TARGET || 'http://localhost:8000'` (launch `:11-20`), and **add `preview: { proxy: API_PROXY }`**. Two reasons, both in scope: `vite preview` is the only way to exercise the worker at all and currently has no `/api` proxy, so every route request 404s; and `docker-compose.yml:78` sets `VITE_API_PROXY_TARGET` that nothing reads, so the compose frontend resolves `localhost:8000` *inside its own container* and every `/api` call is a connection refused that presents as the backend being down.

### `frontend/index.html` (55 lines)

- **after `:11`** (`<title>`) — the manifest link, `theme-color`, favicon and apple-touch-icon. **Only if `frontend/public/` lands in the same change.** A `<link rel="manifest">` pointing at a 404 is worse than no manifest. If the icons capability ships separately, add nothing here and say so in the commit.
- **Do not touch `:25-42`.** The pre-paint theme script must stay inline and unhashed; the SW will cache whatever `index.html` it is given, so a broken theme flash would be cached too.
- **Flag, do not fix here:** `frontend/vercel.json:28` carries `script-src 'self'` with no `'unsafe-inline'`, nonce or hash, which would kill that inline script. It is latent today because nothing deploys via Vercel (`deploy.yml` publishes to S3/CloudFront and sets no security headers at all), but the SW makes the failure sticky.
- **No CSP change is needed for the worker.** `vercel.json:28` already carries `worker-src 'self' blob:`, and `default-src 'self'` covers `/sw.js` and the manifest.

### `.github/workflows/deploy.yml`

- **`:54-55`** — the comment claims `npm run build` runs `check:palette`, `check:permalink` and `check:offline`. It has never been true on this branch (`package.json:11` is bare `vite build`), and after this change the offline contract is a vitest file, not a build step. Rewrite it to name what actually runs.
- **`:128-136`** — these lines already exclude/include `sw.js` and `*.webmanifest` and invalidate `/sw.js` and `/manifest.webmanifest`, for files this build has never emitted. Once `sw.js` is emitted they start doing their job, and the `max-age=0, must-revalidate` at `:133` is correct for it. **No edit — but verify** that `aws s3 sync --delete --exclude 'sw.js'` does not delete the remote `sw.js` on the first pass. The AWS CLI applies filters to both sides of the comparison, so it should not, but this is worth proving once rather than asserting.

### `Makefile`

**No new target.** `test-frontend` (`:55-56`) runs `npm test`, which picks up every new `*.test.js` automatically, and it is already a prerequisite of `check` (`:112`). This is the deliberate counter-proposal to restoring `check-offline.mjs` as a fourth bespoke runner — see the tests field.

### `README.md` (463 lines)

- **`:63-68`** — the withdrawal paragraph ("⚠ It no longer installs or opens offline, and that is a regression this tree owns"). Rewrite: the worker and the offline store are back, on the web substrate; the *native* rebase for Capacitor is still open.
- **`:331`** — "no service worker cache, no map tiles, no cookie, no history" is now false in its first clause. Rewrite: no map tiles, no cookie, no history — all still true and all still enforced.
- **`:326-330`** — the "What the browser keeps" table gains three rows: `meander-shell-<hash>` (the program; unconditional; identical for every visitor), `meander-prefs` (one word, `true` or `false`; unversioned so a deploy cannot re-grant it), `meander-results-<hash>` (**one** route response; only on explicit consent; deleted on revocation).
- **`:335-338`** — delete the blockquote explaining the withdrawal.
- **`:344-349`** — **already wrong today**, independent of this change. It states the labelling contract in the present tense and cites `frontend/scripts/check-offline.mjs`, which does not exist on this branch. Repoint at `frontend/src/lib/offline.test.js`; the prose becomes true again as this lands.
- **`:441-443`** — already correct once the feature exists. No edit.
- **`:46`** — "46 frontend tests" changes.

### `BLOCKED.md`

- **`:303`** — the row `lib/offline.js, lib/offlineStore.js | saved routes, re-based on Preferences — service workers do not register under capacitor://localhost | 4.4`. Close it for the **web** release and open a distinct row for the Capacitor rebase. The two are not the same work and the current row conflates them.
- **`:308-313`** — the paragraph excluding `pwa-gate.mjs`. Its reasoning is exactly right *for iOS* and exactly wrong for this release: the worker is real here, so the gate can fail, so it earns its place. Amend rather than delete — the iOS objection still stands for the iOS build.

### Risks and the rules that constrain it

## Token mapping — every launch token this capability's source touches

Reintroducing any name in the left column is forbidden. Mapping is by **role**, then by value; where the two disagree, role wins.

### Spacing (used by `.offline`, `.topbar__cached`, `.better-later`, `.trust--cached`)

| launch | px | current | px | note |
|---|---|---|---|---|
| `--space-1` | 4 | `--s1` | 4 | exact |
| `--space-2` | 8 | `--s2` | 8 | exact |
| `--space-3` | 12 | `--s3` | 12 | exact |
| `--space-4` | 16 | `--s4` | 16 | exact |
| `--space-5` | 24 | `--s6` | 24 | **not `--s5`** — the scales diverge above step 4 |
| `--space-6` | 32 | `--s7` | 32 | not `--s6` |
| `--space-7` | 48 | — | — | no equivalent; `--s8` is 40. Use `--s8`, or `--s7 + --s3` if 48 is load-bearing |
| `--space-8` | 64 | — | — | no equivalent. Use `--s8` (40) |

The offline CSS only reaches `--space-4`, so every substitution here is exact.

### Type

| launch | rem | current | rem | note |
|---|---|---|---|---|
| `--text-1` | 0.875 (14) | `--t-small` | 0.8125 (13) | **no 14px exists on this branch.** `--text-1` is launch's declared readable floor; `--t-small` is the equivalent role and is what `.note` uses (`styles.css:1323`) |
| `--text-2` | 1 (16) | `--t-body` | 0.9375 (15) | body → body |
| `--text-3` | 1.125 (18) | `--t-h3` | 1.0625 (17) | |
| `--text-4` | 1.375 (22) | `--t-h2` | 1.375 (22) | exact |
| `--text-5` | 1.75 (28) | `--t-metric` | 1.75 (28) | exact |
| `--text-6` | 2.25 (36) | `--t-display` | 2 (32) | |

### Surfaces, ink, warning

| launch | current | note |
|---|---|---|
| `--page` | `--paper` | |
| `--raised` | `--raised` | same name, different value — fine |
| `--recessed` | `--sunken` | **the one every offline block uses** |
| `--rule` | `--rule` | |
| `--rule-strong` | `--rule-strong` | |
| `--ink: #14213d` | `--ink` (`#16241c`) | same name; the *value* is what is forbidden. Never write either hex outside the two `:root` blocks |
| `--ink-muted` | `--ink-2` | |
| `--warn-ground` | `--warn-ground` | same name |
| `--warn-border` | `--warn-rule` | **name change — the easiest mistake in this port** |
| `--warn-ink` | `--warn-ink` | same name |
| `--selected-border` | — | no equivalent. Use `--accent` |
| `--map-casing` | — | no equivalent; not used by this capability |

### Radius, shape, target

| launch | current | note |
|---|---|---|
| `--radius-control` (6px) | `--r-sm` (8px) | |
| `--radius-card` (8px) | `--r-md` (12px) | `.route` uses `--r-md` (`styles.css:998`); match the card, not the pixel |
| `--radius-chip` (999px) | `--r-pill` (999px) | exact |
| `--target` (44px) | `--target` (44px) | identical, keep |

### Route palette — none of it, and none of the launch values

| launch | current | note |
|---|---|---|
| `--route-fastest: #2f6fd0` | `--route-fastest` (`#c2703d` / dark `#e8a46f`) | |
| `--route-scenic: #2e8b57` | `--route-scenic` | |
| `--route-accessible: #7a4fc4` | `--route-accessible` | |
| `--route-quiet: #b06a1f` | `--route-quiet` | |
| `--route-shade: #12756c` | `--route-shade` | |
| `--route-air: #b03050` | `--route-air` | |
| `--score-scenic/-air/-shade` | — | aliases that do not exist here; use `--route-*` |

**No offline surface uses a route colour and none should start.** The saved-copy tiers are warn-family, not route-family; borrowing a route hue would make "saved" look like an objective.

### Things with no current equivalent

| launch | what to do |
|---|---|
| `--safe-top/-right/-bottom/-left` | absent on this branch entirely. **Design the OfflineBar as flow content, not `position: fixed`,** so this capability takes no dependency on the separate safe-area work |
| `@media (prefers-color-scheme: dark)` (launch's dark mechanism) | this branch themes on `[data-theme='dark']` (`styles.css:66`), set pre-paint by `index.html:39`. Any new token goes in **both** `:root` (`styles.css:16-62`) and `[data-theme='dark']` (`:66-102`) |
| `box-shadow: 0 2px 10px rgb(0 0 0 / 12%)` (`.topbar__cached`) | a raw colour that `scripts/check_palette.sh` would **not** catch (it greps for `#[0-9a-fA-F]{3,8}`). Use `var(--shadow-1)` |

---

## Project rules, and how the design satisfies each

**1. A missing OSM tag means UNKNOWN, never "accessible".** This capability is the same rule applied to time. `cacheAgeMs` returns `null` for missing, unparseable and future timestamps, and `cacheTier(null) === 'loud'` — the loudest tier, not the quietest. An entry that cannot say how old it is is treated as the least trustworthy, exactly as `null` scores render "not measured" (`RouteRow.jsx:99-121`) rather than an empty bar. The three-way distinction is preserved end to end: `servedFromCache` absent = live; present with a timestamp = saved, age known; present with `cachedAt: null` = saved, age unknown and loud.

**2. Colour is never the only differentiator; it must survive greyscale.** The tier is carried four ways before colour is reached: (a) **the text itself changes** — `cachedNotice(ageMs).detail` is `null` at `quiet` and a full paragraph naming air quality, rest stops and the departure time at `amber` and `loud`; (b) a `⚠` glyph at `amber`/`loud`, matching `Ribbon.jsx:26-28` and `VerificationMeter.jsx:31-36`; (c) font weight 600 → 700; (d) border width 1px → 2px with a 4px → 6px left edge. Print the page in greyscale and all four survive.

**3. The route list is a complete text substitute for the map.** Strengthened, not weakened. Map tiles are never cached — `sw.js:277`'s origin guard is the line that enforces it, and the comment at `sw.js:28-40` is the reasoning. So offline the map is blank by construction, and `OfflineBar` says so in words when `!online`: "Map tiles are not kept on your device… Everything the routes say is in the list." Every duration, score, blocker and rest stop is in the rail regardless (`MapView.jsx:117-124`, `:540-555`).

**4. No location history, no cookies, no analytics.** No cookie is set — CacheStorage is never transmitted, which is the substantive difference from a cookie. No analytics. **No history**, and this is structural rather than promised: `sw.js:141-142` deletes every existing key before writing, so the results cache holds exactly one entry, and `handleRoutes`'s catch path (`sw.js:203-207`) rethrows rather than serving an entry keyed to a *different* request — handing back a route to somewhere else because it was the only thing on disk would be worse than an error. Off by default (`sw.js:99-102` fails closed on any unreadable flag), revocation is a real delete from two independent paths, and the results cache is versioned so a deploy drops it.

**5. localStorage is for theme and units ONLY.** Satisfied by not writing localStorage at all — see §0. The consent flag lives in CacheStorage. `offlineStore.test.js` spies on `window.localStorage.setItem` and asserts zero calls, so the rule is enforced mechanically rather than by review. The only localStorage touch points on `main` stay exactly two: `lib/theme.js:20,29` plus the duplicate at `index.html:28`.

**6. No new third-party runtime requests.** Net **negative** — the worker serves the shell from disk. Nothing new is fetched, no Workbox, no `vite-plugin-pwa`, no new dependency of any kind (launch `vite.config.js:31-35` gives the reasoning and it holds here). The only external hosts remain OpenFreeMap and the API.

**7. All interactive targets ≥ 44×44 px.** The only interactive controls added are the two `.chip`s in `OfflineControl`, and `.chip` already carries `min-height: var(--target)` (`styles.css:783`). Add `min-width: var(--target)` for the shorter label. `OfflineBar` and the row badge are non-interactive.

**8. One live region for the whole app.** `OfflineBar` uses `role="status"` as an inert region and does **not** announce. The announcement is prepended to the existing single live region at `App.jsx:372-374`, via `announce()` at `App.jsx:246`, so the caveat is heard before the durations.

**9. Rule 8 of the handoff — do not restructure App.jsx's reducer.** Nothing is added to `initialState`, `DEBOUNCE` or the switch. The stamp is derived from `state.routes` at render (launch `App.jsx:162-172`). The fetch effect's dependency array (`App.jsx:258`), its `eslint-disable` (`:257`) and its abort ordering (`:211-213`) are untouched.

**10. `RouteRow` may contain only `<span>`.** The badge is a `<span>` containing two `<span>`s. Stated at `RouteRow.jsx:11-34`.

---

## What could break

1. **`About.jsx:29-33` becomes a lie the instant the worker installs**, even with consent off, because the shell is cached unconditionally. If the About edit is skipped the app ships a false privacy statement. This is the single highest-severity item in the change and it is a text edit, which is exactly the kind that gets dropped.

2. **`X-Meander-Cached` vs `X-Meander-Cache`.** One letter apart, opposite meanings — worker replay vs a warm server-side cache serving a completely current answer (`backend/main.py:1134,1136,1145,1161`). Reading the wrong one labels live routes as saved and destroys the credibility of the label.

3. **`readdirSync(join(here,'public'))`** at launch `vite.config.js:57` throws on this branch; `frontend/public/` does not exist. Unguarded, it breaks `npm run build`, which breaks `make check` (`Makefile:58-59`), `ci.yml:146-147` and `deploy.yml:56`. Guard with `existsSync`.

4. **`useNow()` must be the first statement in `DepartureStrip`**, before the early `return null` at `:21`. A hook after a conditional return is a runtime error under StrictMode.

5. **`vite preview` currently has no `/api` proxy.** The worker can only be exercised against a real build, so without the `preview.proxy` addition the offline path cannot be tested locally at all — every route request 404s and it looks like a worker bug.

6. **`vercel.json:28` CSP has `script-src 'self'`** with no allowance for the inline pre-paint theme script at `index.html:25-42`. Latent today; the SW would cache the resulting flash. Out of scope to fix, in scope to flag.

7. **A cached SSE stream replays both enrichment passes.** `storeResult` (`sw.js:150-168`) only stores a stream containing `"type":"done"`, so the enriched second pass is always present — but during replay the app briefly re-renders the first pass, where `enrichment_pending: true` and `rest_stops: []` make `RouteDetail.jsx:111-112` print "No rest stops found along this route." That false claim exists on `main` today for live requests (see Survey B §4c) and offline replays it faster. Not caused by this change; worth fixing in the same pass by gating on `enrichment_pending`.

8. **A registered worker outlives the code that registered it.** Once shipped, a user with `sw.js` installed keeps it until it is explicitly unregistered. Reverting this change by deleting the file does **not** un-ship it. `unregisterServiceWorkers()` in `lib/pwa.js` is the escape hatch; keep it.

9. **`deploy.yml:129`'s `--delete --exclude 'sw.js'`** — verify empirically that the excluded object is not deleted from the bucket on the first sync pass. A deleted-then-restored `sw.js` between the two passes is a window in which a returning visitor gets a 404 for their worker.

---

## Where the brief is WRONG

**1. `TakeItWithYou` is not part of this capability, and the brief lists it twice.** `feat/launch:frontend/src/components/TakeItWithYou.jsx` is 81 lines and contains **zero** offline code. Its only import is `../lib/export.js` (`appleMapsUrl`, `downloadGeoJson`, `downloadGpx`, `googleMapsUrl`). It is GPX/GeoJSON download plus the Google/Apple Maps handoff warning — which is `docs/RELEASE-PROMPT.md:334-338`, item 6, Phase 4, `lib/export.js`. Bundling it here would either duplicate that work or make this change depend on a module (`lib/export.js`) that has nothing to do with caching. Excluded. If it lands with the export capability, note that `RouteDetail.jsx:176-180` is a standing prohibition on Share/Save controls in the detail panel and must be read first.

**2. "offlineStore presumably uses IndexedDB/CacheStorage" — it uses neither. It uses localStorage.** `offlineStore.js:31,36,88,99`, key `meander.offline`. CacheStorage appears only in `sw.js`. This is not a quibble: a byte-for-byte port silently violates the "theme and units only" rule, and the parenthetical guess would have let it through. Note also that the launch key uses a **dot** (`meander.offline`) where this branch's theme key uses a **colon** (`meander:theme`, `lib/theme.js:14`) — the namespaces never agreed.

**3. `check-offline.mjs` should not come back as a script.** `docs/RELEASE-PROMPT.md:376` says it "returns with the features they check". It existed on `feat/launch` because that branch **had no test runner** — its `package.json` scripts were `dev`/`build`/`preview` plus four bespoke `check:*` runners, and no `vitest`. This branch has vitest wired into `Makefile:55-56`, `Makefile:112` and `ci.yml:140-142`. Restoring it would add a second runner with its own reporter, its own pass/fail convention and its own place to be forgotten, for assertions vitest already runs. Port the twelve checks into `frontend/src/lib/offline.test.js` instead; they then run in `make check` and CI with no new wiring.

**4. `BLOCKED.md:303`'s reason for deferral does not apply to this release.** It says offline must be "re-based on Preferences — service workers do not register under `capacitor://localhost`". That is true and it is a real constraint **for the Capacitor build**. This is a web release; the worker registers, so it is the correct substrate here. The row conflates two pieces of work and should be split.

**5. `BLOCKED.md:308-313` and the brief disagree about `pwa-gate.mjs`, and the brief is right.** BLOCKED.md excludes it because "a gate that cannot fail is worse than no gate". That reasoning is sound on iOS and unsound here. Worth resolving in the same commit so the two documents stop contradicting each other.

**6. README already restates the offline contract as if it were live, two paragraphs after withdrawing it.** `README.md:335-338` withdraws the claim; `README.md:344-349` then says "A route served from that cache is always labelled as saved, with its age, on the row, on the card and on a pill under the top bar…" in the present tense and cites `frontend/scripts/check-offline.mjs` — **a file that does not exist on this branch**. Same for `README.md:441-443`. So the README does not simply withdraw the claim, as the brief states; it withdraws it and then re-asserts it. Both need editing, and the citation needs repointing.

**7. The three line counts in the brief are correct.** `offline.js` 161, `offlineStore.js` 170, `sw.js` 290 — all verified. So are "three caches: shell always; results only on explicit consent; preferences unversioned" (`sw.js:43-45`, `:99-102`, `:171`) and "map tiles are never cached" (`sw.js:28-33`, enforced at `:277`).

### Tests

## 1. `/Users/poojana/Meander/Meander/frontend/src/lib/offline.test.js` — NEW, ~210 lines

The twelve checks from `feat/launch:frontend/scripts/check-offline.mjs` (174 lines), ported one-for-one into `describe`/`it` with `vitest`. Same fixed clock: `const NOW = Date.parse('2026-08-06T12:00:00Z')`. Picked up automatically by `npm test`, which `Makefile:55-56` runs and `Makefile:112` requires, and which `ci.yml:140-142` runs.

`describe('cacheAgeMs')`
1. an age is measured from the stored timestamp — ISO string and `Date` both.
2. a missing or unparseable timestamp is `null`, not `0` — `null`, `undefined`, `''`, `'yesterday afternoon'`.
3. **a timestamp in the future is `null`, not fresh.** The device clock moved; "0 minutes ago" would be a specific false claim.

`describe('wording')`
4. the age reads the way a person would say it — the six boundaries at launch `:78-85` (`20s`→"less than a minute ago", `70s`→"a minute ago", `14m`→"14 minutes ago", `2h`→"2 hours ago", `30h`→"a day ago", `3d`→"3 days ago").
5. an unknown age says so rather than picking a number — `formatCacheAge(null)`, `cacheChipText(null)` matches `/unknown/`, `cachedNotice(null).headline` matches `/cannot tell how old/`.
6. **the chip stays ≤ 20 characters for every input** including `null`. This is the assertion that keeps rail rows a uniform height, which is the stated point of `RouteRow` (`RouteRow.jsx:30-33`).
7. being offline and the server being down are worded differently — and `offlineBarText(ms, true)` must **not** contain "You are offline". Sending someone to restart a working router is the failure this prevents.

`describe('escalation')`
8. the tier escalates monotonically with age across nine samples and never falls.
9. `cacheTier(null) === 'loud'`.
10. past the enrichment threshold the notice **names** what has gone stale — for `30m`, `5h`, `1d` and `null`, `detail` is non-empty and matches `/[Aa]ir quality/` and `/best time to leave|out of date/`.

`describe('THE CONTRACT')`
11. **every possible age produces a visible label carrying the age itself.** Thirteen inputs including `null`, `0`, `1`, `Number.MAX_SAFE_INTEGER`. For each: `headline` is non-empty, `tier` is one of the three, `chipText` is non-empty, and the headline contains either `formatCacheAge(ms)` or `'cannot tell how old'`. A bug that let one age fall through to "no notice" would not look like a bug — the card would render as though the data were live.

`describe('departure expiry')`
12. a departure time that has passed is `true`, a future one is `false`; `null`, `''` and `'soon'` are all `false` — there is nothing to withdraw, and rendering a withdrawal where no suggestion existed invents a recommendation in order to retract it.

## 2. `/Users/poojana/Meander/Meander/frontend/src/lib/offlineStore.test.js` — NEW, ~160 lines

Needs a fake `CacheStorage`: a `Map` of name → `Map` of url → `Response`, installed with `vi.stubGlobal('caches', fake)`. No new dependency.

- absent pref entry → `{ saveResults: false, chosen: false }`.
- `setSaveResults(true)` writes the body `'true'` to `/__meander__/save-results` in the cache named `meander-prefs` — **and nowhere else**.
- `setSaveResults(false)` writes `'false'` **and** deletes every cache whose name starts with `meander-results-`, while leaving `meander-shell-*` and `meander-prefs` intact. Assert all three.
- `clearOfflineSetting()` removes the pref entry and sweeps results.
- **`caches` undefined** (insecure origin) → resolves to off, throws nothing.
- **`caches.open` rejects** (storage disabled / quota) → resolves to off, throws nothing. Fail closed is the only safe direction.
- **THE RULE TEST: `vi.spyOn(window.localStorage, 'setItem')` records zero calls** across every operation above. This is what enforces "localStorage is theme and units only" by construction rather than by review, and it is the test most likely to catch a future regression that "just adds a small flag".
- `useNow` re-renders on its interval (`vi.useFakeTimers()`), and clears the interval on unmount.
- `useCacheAge` returns `null` for a `null` `cachedAt` and recomputes as the fake clock advances — the "phone left on a table shows 'saved 2 minutes ago' an hour later" failure.
- `useOnline` flips on `window` `online` / `offline` events and removes both listeners on unmount.

## 3. `/Users/poojana/Meander/Meander/frontend/src/api/client.test.js` — NEW, ~140 lines

`vi.stubGlobal('fetch', …)` returning a hand-built `Response`. No new dependency. This is the test that stops a saved route being rendered as a current one.

- an SSE response **with** `X-Meander-Cached: 1` and an `X-Meander-Cached-At` timestamp: every route passed to `onRoute`, and every route in the resolved payload, carries `servedFromCache: true` and that `cachedAt`.
- the **JSON fallback path** (`client.js:89-93`) marks routes identically. Easy to fix one branch and forget this one.
- `X-Meander-Cached: 1` with **no** `X-Meander-Cached-At` → `cachedAt: null`, not `undefined` and not a timestamp.
- a response **without** the header leaves routes untouched: assert `'servedFromCache' in route === false`, not merely falsy.
- **`X-Meander-Cache: hit`** (the server's own header, `backend/main.py:1134`) does **not** produce a stamp. One letter apart, opposite meanings.

## 4. `/Users/poojana/Meander/Meander/frontend/src/lib/sw-contract.test.js` — NEW, ~70 lines

Reads `frontend/sw.js` as text (`readFileSync(new URL('../../sw.js', import.meta.url))`). A worker cannot be imported into vitest, but its invariants are still checkable, and these are the ones whose violation would be silent and irreversible.

- the file contains the sentence **`a tile cache is a record of where you have been`** verbatim. The comment is a project requirement; a grep is how it stays one.
- `PREFS_CACHE` is assigned a **literal with no `${VERSION}`** — matches `/const PREFS_CACHE = ['"]meander-prefs['"]/`. If a deploy re-versioned it, consent would be silently revoked on every release.
- the fetch listener contains `url.origin !== self.location.origin`. **This one line is the whole map-tile guarantee.**
- the fetch listener contains `url.pathname.startsWith('/api/')` — the geocode query string is what the user typed into a search box.
- no third-party host string appears anywhere: `openfreemap`, `mapillary`, `open-meteo`, `graphhopper`.
- `storeResult` contains both `'"type":"done"'` and `'"type":"error"'` — a truncated or errored stream is not a result.
- both `__VERSION__` and `__PRECACHE__` are present, so the build plugin has something to substitute. Pairs with the plugin's own post-substitution assertion (launch `vite.config.js:87-89`); together they close the loop that shipped a literal `__PRECACHE__` once.

## 5. Deliberately NOT added

**No React component tests.** There is no jsdom, no `@testing-library/react` and no component test anywhere in `frontend/src` today. Adding them for this capability would introduce two devDependencies and a testing convention the rest of the tree does not follow, for surfaces whose entire logic already lives in the pure layer — `cachedNotice` is proven to return a headline for every input, so a component that renders `cachedNotice(ageMs).headline` cannot render nothing. The rendering itself belongs to the rewritten `scripts/gate.mjs` (Phase 6) and the manual `frontend/a11y.html` harness. If the gate rewrite lands, add one assertion to it: **with a stamped route in state, at least one element matching `.offline, .badge--cached, .detail__cached` is present in the DOM** — and assert the selector matches something before asserting anything about it, which is the objection §5 raises against the old gate.

**No `frontend/scripts/check-offline.mjs`.** Superseded by test file 1. See the sixth point in the risks field.

---

## frontend/public/ — the PWA icon set, manifest.webmanifest, the dependency-free generator that draws them, and the five <head> tags index.html is missing.

**OPEN**

### Sources read on `feat/launch`
- git show feat/launch:frontend/scripts/make-icons.mjs — 215 lines (the whole generator; read in full)
- git show feat/launch:frontend/public/manifest.webmanifest — 35 lines / 873 bytes (blob 979d342; read in full)
- git show feat/launch:frontend/index.html — 34 lines; the head block this capability needs is :8-15
- git show feat/launch:frontend/public/favicon-32.png — binary, 387 bytes (blob b218fc9)
- git show feat/launch:frontend/public/apple-touch-icon.png — binary, 1317 bytes (blob 7a00ea8)
- git show feat/launch:frontend/public/icon-192.png — binary, 2115 bytes (blob 8e7b85a)
- git show feat/launch:frontend/public/icon-maskable-512.png — binary, 3776 bytes (blob f4cc010)
- git show feat/launch:frontend/public/icon-512.png — binary, 6151 bytes (blob d0538d2)
- git show feat/launch:frontend/package.json — 28 lines (checked for the `icons` script and the build chain)
- git show feat/launch:frontend/vite.config.js — 134 lines (checked for a publicDir override: there is none)
- git show feat/launch:frontend/scripts/check-palette.mjs — 72 lines (read to establish which gate, if any, the icon colours were under)
- git show feat/launch:frontend/src/styles.css — read :50-59 (launch route palette) and :61-104 (launch surface/ink tokens) for the token mapping
- git show feat/launch:frontend/src/lib/dash.js — read :47-67 (FALLBACK_COLORS) to confirm the launch scenic green

### Plan

## 0. The single most important finding, up front

**This is not a restore. Do not `git checkout feat/launch -- frontend/public/`.**

The five committed PNGs are drawn in launch-palette colours baked into the pixels:
`make-icons.mjs:35` `INK = [27,36,48]` = **`#1b2430`**, `:36` `PATH = [63,174,112]` = **`#3fae70`**.
Copying those blobs reintroduces the forbidden palette as **binary** — invisible to
`scripts/check_palette.sh` (which reads only `frontend/src/styles.css`), invisible to
`git diff`, invisible to review. The PNGs must be **re-rendered** from the recoloured
generator. I verified the generator reproduces the launch blobs byte-for-byte from
source (all five sha256s match on Node 26), so the drawing is trustworthy — only the
two colour constants change.

Verified state at HEAD `bcf268c`: `git diff 46d4772..HEAD -- frontend` is **empty**, so
every `frontend/` line number in the surveys and below is current. `frontend/public/`
does not exist. `frontend/index.html` (55 lines) contains **zero** `<link>` elements.

---

## 1. NEW FILES (10)

### 1.1 `frontend/scripts/make-icons.mjs` — ~225 lines

Start from `git show feat/launch:frontend/scripts/make-icons.mjs` (215 lines) verbatim,
then make exactly four changes. Everything else — the geometry (`:52-56`), `meander()`,
`distToPath`, `insideRoundedSquare`, the 4×4 supersampler, the CRC/PNG encoder, the
`ICONS` table at `:199-207` — is unchanged and correct.

**Change 1 — the two colour constants (`:35-36`).** Replace:

```js
const INK = [27, 36, 48, 255]
const PATH = [63, 174, 112, 255]
```

with:

```js
// The plate is --brand (styles.css:27) and the mark is --route-scenic's
// dark-theme value (styles.css:87, mirrored at lib/dash.js:33). The icon is a
// single un-themed artefact drawn on a dark plate, so the dark block is the
// right place to read the mark from — that is what the dark values are for.
// Pinned by scripts/make-icons.test.js: these two arrays are compared against
// styles.css on every `npm test`, because nothing else looks at them.
// #1c4633
const INK = [28, 70, 51, 255]
// #6fc38e
const PATH = [111, 195, 142, 255]
```

**Change 2 — correct the false comment at `:32-34`.** The launch comment reads
"Ink from the dark theme, path in the scenic green that the app already uses for the
greenest route. One concept, one colour — the same rule check-palette enforces between
styles.css and dash.js." **All three clauses were false on `feat/launch`** (see the
`risks` field). Replace the whole comment with the one written into Change 1, which
states a claim that is now actually enforced.

**Change 3 — make the module importable (`:209-215`).** Today lines 209-213 run
`mkdirSync`/`writeFileSync` at import time, so a test cannot import `render`. Replace
`:209-215` with:

```js
export { INK, PATH, ICONS, render, encodePng }

/** Written only when this file is run as a script, so the test can import the
 *  drawing without the side effect. */
export function writeIcons(dir = outDir) {
  mkdirSync(dir, { recursive: true })
  for (const { file, size, opts } of ICONS) {
    const png = encodePng(size, render(size, opts))
    writeFileSync(join(dir, file), png)
    console.log(`  ${file.padEnd(24)} ${size}x${size}  ${(png.length / 1024).toFixed(1)} kB`)
  }
  console.log(`\n${ICONS.length} icons written to ${dir}`)
}

// `import.meta.main` is Node >= 24 and CI runs 22 (ci.yml:127), so compare the
// resolved paths instead. resolve() both sides: argv[1] may be relative.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  writeIcons()
}
```

and widen the `node:path` import at `:27` to `import { dirname, join, resolve } from 'node:path'`.

**Change 4 — nothing else.** In particular keep `:12-14` ("The output is committed, so
a normal build never runs this") and `:16-21` (the maskable rationale). Both are now
backed by tests.

### 1.2 `frontend/public/manifest.webmanifest` — 35 lines

`git show feat/launch:frontend/public/manifest.webmanifest` **verbatim except lines
10-11**, which become:

```json
  "background_color": "#1c4633",
  "theme_color": "#1c4633",
```

Keep launch's exact formatting (the expanded icon objects at `:16-33`) so the diff
against `feat/launch` stays two lines. Everything else already fits this tree:
- `:2` `"name": "Meander — routes for the time you have"` is byte-identical to
  `frontend/index.html:11`'s `<title>`.
- `:5-7` `id`/`start_url`/`scope` = `/` matches `infra/30-web.yaml:146`
  `DefaultRootObject: index.html` and `frontend/vercel.json:8`'s SPA rewrite.
- `:15-33` declares three icons; the fourth and fifth files
  (`apple-touch-icon.png`, `favicon-32.png`) are referenced from `<head>`, not here.

### 1.3-1.7 The five PNGs — **generated, never copied**

```
npm --prefix frontend run icons
git add frontend/public/*.png
```

Expected output (measured with the recoloured constants, Node 26):

| file | size | bytes |
|---|---|---|
| `favicon-32.png` | 32×32 | 390 |
| `apple-touch-icon.png` | 180×180 | 1322 |
| `icon-192.png` | 192×192 | 2122 |
| `icon-maskable-512.png` | 512×512 | 3782 |
| `icon-512.png` | 512×512 | 6166 |

Total ≈ 13.8 kB. A few bytes' drift on another zlib build is expected and fine —
that is why the test below asserts *pixel* equality, not byte equality.

I rendered and inspected the recoloured set: the mark reads clearly at 512, the maskable
variant is full-bleed with the whole mark inside r=0.307 of centre, and the Apple icon is
opaque to the corners.

### 1.8 `frontend/scripts/tokens.mjs` — ~30 lines (new, small, build-time only)

A reader for `frontend/src/styles.css` so the generator's tests and the manifest's tests
read the same source of truth the stylesheet is. **Nothing under `frontend/src/` imports
it** — it must never enter the bundle. (The runtime equivalent already exists and is
`lib/dash.js:58 cssVar()`; this is its build-time twin.)

```js
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const CSS = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'styles.css')

// styles.css has two `:root {` blocks: colour at :16-62 and type/space/shape at
// :106-138. search() finds the first, which is the only one with colours in it.
const OPENER = { light: /^:root \{$/m, dark: /^\[data-theme='dark'\] \{$/m }

export function token(name, theme = 'light') {
  const css = readFileSync(CSS, 'utf8')
  const start = css.search(OPENER[theme])
  if (start < 0) throw new Error(`no ${theme} token block in styles.css`)
  const block = css.slice(start, css.indexOf('\n}', start))
  const m = block.match(new RegExp(`^\\s*${name}:\\s*(#[0-9a-fA-F]{3,8})\\s*;`, 'm'))
  if (!m) throw new Error(`${name} is not declared in the ${theme} block`)
  return m[1].toLowerCase()
}

/** '#1c4633' -> [28, 70, 51, 255], the shape make-icons.mjs draws with. */
export function rgba(hex) {
  const h = hex.replace('#', '')
  const n = h.length === 3 ? [...h].map((c) => c + c) : h.match(/../g)
  return [parseInt(n[0], 16), parseInt(n[1], 16), parseInt(n[2], 16), 255]
}
```

### 1.9 `frontend/scripts/make-icons.test.js`, 1.10 `frontend/scripts/manifest.test.js`

See the `tests` field. Both live in `frontend/scripts/`, **not** `frontend/public/` —
Vite copies `publicDir` to `dist/` verbatim, so a test file in `public/` would ship.

---

## 2. EXISTING FILES TO EDIT (3)

### 2.1 `frontend/index.html` — insert after line 6

Current head, for the anchor:

```
 4      <meta charset="UTF-8" />
 5      <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
 6      <meta name="color-scheme" content="light dark" />          ← INSERT AFTER THIS LINE
 7-10   <meta name="description" ... />
 11     <title>Meander — routes for the time you have</title>
 12-24  (comment explaining the pre-paint script)
 25-42  (the pre-paint theme script)
```

Insert exactly this, at the same 4-space indent, between `:6` and `:7` — the same slot
launch used (`feat/launch:frontend/index.html:8-15`):

```html

    <!-- Installable, and identifiable in a tab strip.

         The theme colour is the icon plate, not either theme's page background.
         A value tracking the page would have to change with the theme, and this
         file cannot do that without duplicating the theme logic a second time
         (it already duplicates it once, below, and that duplication is called
         out at :22-23). --brand is the app's identity in both themes, so a
         static value is honest rather than a compromise.

         This hex is the one colour literal outside src/styles.css. It is
         repeated in public/manifest.webmanifest and in scripts/make-icons.mjs;
         scripts/manifest.test.js fails if the three ever disagree, and
         scripts/make-icons.test.js fails if any of them drifts from --brand. -->
    <link rel="manifest" href="/manifest.webmanifest" />
    <meta name="theme-color" content="#1c4633" />
    <link rel="icon" type="image/png" sizes="32x32" href="/favicon-32.png" />
    <link rel="apple-touch-icon" href="/apple-touch-icon.png" />
    <meta name="apple-mobile-web-app-title" content="Meander" />
```

Five tags, no script — so this does not interact with the `script-src 'self'` problem
that the inline pre-paint block at `:25-42` already has.

`frontend/a11y.html` needs **no** change: Vite's dev server serves `publicDir` at `/`,
so the favicon resolves there too.

### 2.2 `frontend/package.json` — one line after `:11`

```
 11     "build": "vite build",
        "icons": "node scripts/make-icons.mjs",     ← INSERT
 12     "preview": "vite preview",
```

**Do not chain `icons` into `build`.** The output is committed
(`make-icons.mjs:12-14`); a build that regenerates binaries dirties the tree on every
`make build` and on every CI run. No new dependency is added — the generator uses only
`node:zlib`, `node:fs`, `node:url`, `node:path`.

### 2.3 `.github/workflows/deploy.yml` — the publish step, `:128-136`

Current text (read at HEAD):

```
128           aws s3 sync frontend/dist/ "s3://$BUCKET/" \
129             --exclude 'index.html' --exclude 'sw.js' --exclude '*.webmanifest' \
130             --cache-control 'public, max-age=31536000, immutable' --delete
131           aws s3 sync frontend/dist/ "s3://$BUCKET/" \
132             --exclude '*' --include 'index.html' --include 'sw.js' --include '*.webmanifest' \
133             --cache-control 'public, max-age=0, must-revalidate'
134           aws cloudfront create-invalidation \
135             --distribution-id ${{ secrets.CLOUDFRONT_DISTRIBUTION_ID }} \
136             --paths '/index.html' '/sw.js' '/manifest.webmanifest' >/dev/null
```

**Edit A — `:129`, add a continuation line after it.** Without this the five
root-level, *unhashed* PNGs land in the immutable sync and are frozen at the edge for a
year; regenerating an icon would never reach a returning visitor.

```
129             --exclude 'index.html' --exclude 'sw.js' --exclude '*.webmanifest' \
                --exclude 'favicon-32.png' --exclude 'apple-touch-icon.png' --exclude 'icon-*.png' \
```

(`--delete` on this sync will not delete the excluded keys — the filter applies to both
sides — so there is no window where the icons are absent from the bucket.)

**Edit B — `:132`.** Drop `--include '*.webmanifest'` (Edit C uploads it explicitly) and
add the icons:

```
132             --exclude '*' --include 'index.html' --include 'sw.js' \
                --include 'favicon-32.png' --include 'apple-touch-icon.png' --include 'icon-*.png' \
```

**Edit C — new command after `:133`.** `X-Content-Type-Options: nosniff` is forced at
the edge (`infra/30-web.yaml:90`), so a manifest served as `binary/octet-stream` is
refused outright. `aws s3 sync` guesses from `mimetypes`; the bundled interpreter in
AWS CLI v2 is not the one I can check here (local Python 3.13 does map
`.webmanifest` → `application/manifest+json`, but that is not what runs in the action).
`sync` cannot set a per-object content type, so use an explicit `cp`:

```
          aws s3 cp frontend/dist/manifest.webmanifest "s3://$BUCKET/manifest.webmanifest" \
            --content-type 'application/manifest+json' \
            --cache-control 'public, max-age=0, must-revalidate'
```

**Edit D — `:136`, add the five icon paths:**

```
136             --paths '/index.html' '/sw.js' '/manifest.webmanifest' \
                        '/favicon-32.png' '/apple-touch-icon.png' \
                        '/icon-192.png' '/icon-512.png' '/icon-maskable-512.png' >/dev/null
```

No CSP change is needed anywhere. `infra/30-web.yaml:104-114` and
`frontend/vercel.json:28` both carry `default-src 'self'` (which covers `manifest-src`)
and `img-src 'self' …` (which covers the icons). **Do not edit either policy** for this
work.

---

## 3. Order of operations

1. Write `frontend/scripts/tokens.mjs`.
2. Write `frontend/scripts/make-icons.mjs` (launch source + the four changes).
3. Add the `icons` script to `package.json:11`.
4. `npm --prefix frontend run icons` → creates `frontend/public/` and the five PNGs.
5. Write `frontend/public/manifest.webmanifest`.
6. Edit `frontend/index.html` after `:6`.
7. Write the two test files; `npm --prefix frontend test` must be green.
8. Edit `.github/workflows/deploy.yml`.
9. `make check` (now includes `colour` via `scripts/check_palette.sh` — Makefile:67-68,
   :112 — and `test-frontend` at Makefile:55-56, which is what picks up the new tests).
10. `npm --prefix frontend run build` and confirm `frontend/dist/` contains
    `manifest.webmanifest` and the five PNGs at the root. `vite.config.js` (35 lines)
    does not override `publicDir`, so Vite's default `<root>/public` → `dist/` copy applies.

### Risks and the rules that constrain it

## Token mapping — every launch token this capability's source touches

The source is a build script, a JSON file and five HTML head tags. It uses **no**
`--space-*`, **no** `--text-*` and **no** CSS at all. I grepped the three source files
for the launch vocabulary and it is absent. What it does carry is two raw hex literals
and their three hand-kept copies. All five must be remapped.

| Launch value | Where it appears on `feat/launch` | What launch called it | Current equivalent | Value to use |
|---|---|---|---|---|
| `#1b2430` (as `[27,36,48,255]`) | `make-icons.mjs:35` `INK` | "Ink from the dark theme" — **false**, see below | `--brand` (light block), `styles.css:27` | `[28, 70, 51, 255]` |
| `#1b2430` | `index.html:12` `<meta name="theme-color">` | icon plate | `--brand`, `styles.css:27` | `#1c4633` |
| `#1b2430` | `manifest.webmanifest:10` `background_color` | icon plate | `--brand`, `styles.css:27` | `#1c4633` |
| `#1b2430` | `manifest.webmanifest:11` `theme_color` | icon plate | `--brand`, `styles.css:27` | `#1c4633` |
| `#3fae70` (as `[63,174,112,255]`) | `make-icons.mjs:36` `PATH` | "the scenic green … for the greenest route" — **false**, see below | `--route-scenic`, **dark** block, `styles.css:87` (mirrored `lib/dash.js:33` `colorDark`) | `[111, 195, 142, 255]` |
| launch `--ink: #14213d` | `feat/launch:styles.css:67` | body ink | `--ink: #16241c`, `styles.css:23` | not used by this capability |
| launch `--route-scenic: #2e8b57` | `feat/launch:styles.css:51`, `dash.js:49` | greenest route | `--route-scenic: #2f7d53` light / `#6fc38e` dark, `styles.css:45` / `:87` | dark value only |
| launch `--radius-card/-control/-chip` | `feat/launch:styles.css:82-84` | radii | `--r-sm/--r-md/--r-lg/--r-pill`, `styles.css:131-134` | not used — the icon's corner radius is a fraction of its own size (`make-icons.mjs:107` `cornerRadius = 0.22`), not a CSS token |
| `--space-*`, `--text-*` | — | — | `--s1`..`--s8` (`styles.css:120-127`), `--t-*` (`styles.css:112-118`) | **not present in this source at all** |

**Why the mark reads from the *dark* block while the plate reads from the *light* one.**
The icon is one un-themed artefact on a dark plate. The dark block exists to supply
values that work on dark surfaces; taking `--route-scenic`'s light value (`#2f7d53`)
gives 3.21:1 against the plate, taking the dark value (`#6fc38e`) gives **5.00:1**
(measured, sRGB piecewise). State this rule in the comment so nobody "fixes" it later.

**Forbidden-value check.** After the change, `git grep -i '1b2430\|3fae70\|14213d\|2e8b57'`
over `frontend/` must return nothing. Grepping the *committed PNGs* will not find them —
that is exactly why the blobs must be regenerated rather than copied.

---

## Project rules, and how the design satisfies each

**1. A missing OSM tag means UNKNOWN, never "accessible".** Not engaged — this capability
touches no route data, no `models.py` field, no scoring. It adds five static files and
five head tags. Nothing here can render a claim about a route.

**2. Colour is never the only differentiator; must survive greyscale.** Engaged, and made
checkable. The icon has exactly two colours; if they were close in luminance the mark
would vanish for anyone who does not perceive the hue difference. Measured contrast
plate↔mark is **5.00:1**, well over the 3:1 WCAG sets for graphical objects and over the
3.34:1 that `lib/dash.js:9-12` already treats as the floor for this palette. Test 4 in
`make-icons.test.js` asserts `>= 3`. Separately, the drawing itself is a *shape* — a
stroked meander — not a colour swatch, so it is still identifiable in a monochrome
launcher.

**3. The route list is a complete text substitute for the map.** Not engaged; no route UI
changes. Worth noting the manifest carries a `description` (`:4`) that is the same text
substitute the app already promises, so an installed app's store-card text agrees with
`index.html:7-10`.

**4. No location history, no cookies, no analytics; localStorage is theme and units only.**
Satisfied and unaffected. Nothing added reads or writes storage. The two existing
`meander:theme` touch points (`lib/theme.js:20`, `:29`) plus the inline duplicate
(`index.html:28`) are untouched — the new head block sits at `:7`, above the comment at
`:12-24` and the script at `:25-42`, and adds no script. A manifest enables an OS
home-screen entry, which is a bookmark held by the OS, not app storage. **`About.jsx:29-33`
("Nothing is stored… The only thing kept in this browser is whether you chose the light or
the dark theme") stays true verbatim and needs no edit.**

**5. No new third-party runtime requests.** Satisfied by construction and by test. Every
href in the new head block and every `src` in the manifest is root-relative
(`/manifest.webmanifest`, `/favicon-32.png`, `/apple-touch-icon.png`, `/icon-*.png`) and
resolves to a same-origin static file. Test 6 in `manifest.test.js` asserts the manifest
contains no `http://` or `https://` substring at all. The generator adds **no npm
dependency** — `node:zlib` only, which is why `make-icons.mjs:6-10` refused `sharp`. The
existing CSPs (`infra/30-web.yaml:104-114`, `vercel.json:28`) need no widening; `img-src
'self'` and the `default-src 'self'` fallback for `manifest-src` already cover this.

**6. All interactive targets >= 44×44 px.** Not engaged — nothing interactive is added.
`--target` (`styles.css:137`) is untouched.

**7. Launch tokens must never be reintroduced.** The whole reason the PNGs are
regenerated. See the mapping table and the grep check above.

**8. `styles.css` is the single source of every colour (`styles.css:10-13`).** This
capability necessarily puts a hex outside it — a PNG cannot reference `var()`, and neither
can a `.webmanifest`. That is the same legitimate duplication `lib/dash.js:19` already has
(MapLibre paints to a canvas). It is handled the same way: the duplicate is declared, and
`make-icons.test.js` compares it to `styles.css` on every `npm test`. **Do not** point
`scripts/check_palette.sh` at `make-icons.mjs` — its awk (`check_palette.sh:24-28`) exempts
only lines inside a `:root {` or `[data-theme='dark'] {` block, so it would flag both
constants and there is no way to suppress it.

---

## What could break

1. **`deploy.yml:128-130` freezes the icons for a year.** The five PNGs are unhashed
   root-level names and fall into the `immutable` sync. Fixed by Edit A. Survey C
   predicted the manifest include at `:132` "starts working correctly by accident"; that
   is only half right — the *icons* land in the wrong sync and the manifest still ships
   with a guessed Content-Type.
2. **Manifest Content-Type + `nosniff`.** `infra/30-web.yaml:90` forces
   `X-Content-Type-Options: nosniff`; a manifest served as `binary/octet-stream` is
   rejected rather than sniffed. Fixed by Edit C.
3. **No service worker, so Chrome will not offer install.** Chrome's install criteria
   require a SW with a fetch handler; `sw.js` is deliberately absent (`Makefile:102-110`).
   iOS Safari's Add to Home Screen *does* honour `display: standalone` and the
   apple-touch-icon without one, so the capability is real on iOS and partial on Android.
   **Do not write UI or README copy claiming the app is "installable"** until Phase 5's
   `sw.js` lands. Restoring `public/` and restoring offline are two deliverables, not one.
4. **Byte reproducibility across Node/zlib.** `deflateSync(level 9)` reproduced the launch
   blobs exactly here on Node 26, but CI runs Node 22 (`ci.yml:127`). A byte-equality test
   would be a latent flake. Test 3 decodes both sides and compares **pixels**, which is
   zlib-independent.
5. **`frontend/vercel.json:8`** rewrites `/((?!assets/).*)` → `/index.html`. Vercel applies
   `rewrites` only after the filesystem check, so real static files at the root should win
   — but this is worth confirming if Vercel ever becomes a live target. It is **not** the
   shipping path: `deploy.yml` publishes to S3/CloudFront, where
   `infra/30-web.yaml:212-218` rewrites only 403/404, i.e. only when the object is genuinely
   missing. If you want belt and braces, widen the lookahead to
   `/((?!assets/|icon-|favicon-|apple-touch-icon|manifest\.webmanifest).*)`.
6. **Nothing blocks the commit.** `.gitignore` has no `public/` and no `*.png` entry
   (`dist/` at `:25` does not match). The pre-commit hook
   (`scripts/git-hooks/pre-commit:21-22`) runs `scrub_cache_db.py --check` and
   `check_new_fixtures.py`, and the latter is scoped to `fixtures/`
   (`check_new_fixtures.py:55`, `--diff-filter=A -- fixtures/`). Five PNGs under
   `frontend/public/` are unaffected.
7. **A second `:root {` block exists** at `styles.css:106`, holding type/space/shape. The
   `token()` helper uses `search()` (first match) so it reads the colour block at `:16`.
   If someone reorders those blocks the helper throws with a named error rather than
   returning a wrong colour.

### Tests

Two new files, both under `frontend/scripts/`. Vitest's `defaultInclude` is
`**/*.{test,spec}.?(c|m)[jt]s?(x)` and `defaultExclude` is only `**/node_modules/**` and
`**/.git/**` (verified in `frontend/node_modules/vitest/dist/chunks/defaults.9aQKnqFk.js:5-6`),
so files in `scripts/` are collected. `vite.config.js:20-34` sets no `environment`, so the
default `node` env applies and `node:fs`/`node:zlib` are available. These run under
`npm test` → `Makefile:55-56 test-frontend` → `make check` (Makefile:112) and
`ci.yml:141-142`. **Do not put test files in `frontend/public/`** — Vite copies that
directory to `dist/` verbatim.

Both files need a small PNG decoder. Put it at the top of `make-icons.test.js` and export
it, or duplicate the ~20 lines; the images are filter-type-0 on every row
(`make-icons.mjs:181-187`), so decoding is: walk the chunks, read IHDR w/h/bitdepth/colourtype,
`inflateSync(concat(IDAT))`, then drop the leading `0` byte from each of `h` rows. I ran
exactly this against the recoloured set and all five decode cleanly at `bd=8, ct=6`.

---

## `frontend/scripts/make-icons.test.js` (~130 lines, 6 tests)

Imports `{ ICONS, INK, PATH, render }` from `./make-icons.mjs` and `{ rgba, token }` from
`./tokens.mjs`.

**1. `the plate is --brand and the mark is --route-scenic, read from styles.css`**
```js
expect(INK).toEqual(rgba(token('--brand', 'light')))     // [28, 70, 51, 255]
expect(PATH).toEqual(rgba(token('--route-scenic', 'dark'))) // [111, 195, 142, 255]
```
This is `check-palette.mjs`'s actual job — CSS↔JS agreement — scoped to the two hexes the
icon owns. Survey C established that job is currently ungated entirely
(`check_palette.sh:17` reads only `frontend/src/styles.css`), and the icon constants sit in
a third file no gate has ever looked at.

**2. `the mark is the same green lib/dash.js paints the scenic route`**
Read `../src/lib/dash.js`, parse the `scenic` entry's `colorDark` (`dash.js:33`), and compare
case-insensitively to `token('--route-scenic', 'dark')`. Closes the CSS↔`dash.js` drift gap
at the one colour this capability depends on, for free. (`dash.js` carries 14 hexes at
`:24-77` that nothing checks; this covers one pair and is the natural place to widen later.)

**3. `every committed icon is exactly what the generator draws`**
For each of the five `ICONS` entries: decode `../public/<file>`, assert IHDR
`width === height === size`, and `expect(Buffer.compare(decoded.px, render(size, opts))).toBe(0)`.
Catches a hand-edited PNG, a colour change nobody re-ran the generator for, and a
wrong-size file. Pixel comparison, not byte comparison — see risk 4.

**4. `the mark survives greyscale against the plate`**
Compute WCAG relative luminance of `INK` and `PATH` and assert the contrast ratio is
`>= 3`. Measured: **5.003**. This is project rule 2 turned into an assertion.

**5. `the maskable icon keeps the whole mark inside the safe circle`**
Decode `icon-maskable-512.png`. Assert (a) alpha is 255 at all four corners — it is
full-bleed; (b) every pixel matching `PATH` lies within `0.40 * width` of the centre.
Measured max mark radius **0.3073**. Then assert the same measurement on `icon-512.png`
is **greater** than 0.40 — measured **0.4958** — proving the two really are different
drawings. This is the exact mistake `make-icons.mjs:16-21` warns about ("Emitting the
standard artwork with `purpose: maskable` is the usual mistake"), and nothing has ever
checked it. The test fails the moment someone points `purpose: maskable` at `icon-512.png`.

**6. `the apple touch icon is opaque to its corners`**
iOS composites onto its own rounded rect and ignores transparency
(`make-icons.mjs:204-205`). Decode `apple-touch-icon.png` and assert every pixel has
alpha 255. Measured `minAlpha = 255`. (Contrast: `icon-192`, `icon-512` and `favicon-32`
correctly have `minAlpha = 0` — transparent outside the rounded plate.)

---

## `frontend/scripts/manifest.test.js` (~90 lines, 7 tests)

Reads `../public/manifest.webmanifest`, `../index.html` and `./tokens.mjs`.

**1. `the manifest names the app the title bar names`**
`manifest.name` === the `<title>` text of `index.html:11`
(`Meander — routes for the time you have`), and `manifest.short_name` === the
`apple-mobile-web-app-title` meta content (`Meander`). Two names that drift is how an
installed app ends up labelled differently from the tab.

**2. `every icon the manifest declares exists, at the size it claims`**
For each entry in `icons[]`: strip the leading `/`, assert `existsSync` under `public/`,
decode the IHDR and assert `${w}x${h}` equals the declared `sizes` string.

**3. `exactly one icon is maskable, and it is a different file`**
`icons.filter(i => i.purpose === 'maskable')` has length 1, its `src` is not
`/icon-512.png`, and the two files' bytes differ.

**4. `theme_color, background_color and the meta tag are all the icon plate`**
All three, lowercased, equal `token('--brand', 'light')` (`#1c4633`). Pins the three-way
duplication called out in the `index.html` comment. This is the test that makes the one
hex literal outside `styles.css` safe.

**5. `index.html declares the five head tags and each href resolves`**
Assert the head contains `rel="manifest"`, `rel="icon"`, `rel="apple-touch-icon"`,
`name="theme-color"` and `name="apple-mobile-web-app-title"`; extract each `href` and
assert the corresponding file exists under `public/`. A renamed icon that nothing points
at is otherwise silent — the browser just shows a default glyph.

**6. `the manifest asks for nothing off-origin`**
`expect(rawText).not.toMatch(/https?:\/\//)`. Directly enforces "no new third-party
runtime requests" against the one file most likely to grow an absolute URL later
(screenshots, shortcuts, related_applications all take them).

**7. `start_url, scope and id are all "/"`**
Matches `infra/30-web.yaml:146` `DefaultRootObject: index.html` and the SPA rewrite at
`vercel.json:8`. A `start_url` of `/index.html` or a scoped subpath would launch the
installed app outside its own scope on the CloudFront deployment.

---

## No backend tests

Nothing in `backend/` is touched. No new pytest file, no change to
`backend/tests/`, and the coverage floor (`ci.yml` backend job) is unaffected.

---

## ReportBarrier — port feat/launch's barrier-reporting form into the redesign's RouteDetail, wired to the live POST /api/report-barrier, with honest degradation keyed on the server's 503 rather than on the (irrelevant) OSM_DEV_TOKEN.

**DONE** — kept for the reasoning

### Sources read on `feat/launch`
- git show feat/launch:frontend/src/components/ReportBarrier.jsx — 157 lines (read in full)
- git show feat/launch:frontend/src/api/client.js — 208 lines (read :180-208, the reportBarrier function at :190-208)
- git show feat/launch:frontend/src/lib/format.js — 303 lines (read :25-60 fmtDist, :160-180 BLOCKER_TYPE_NAMES/blockerTypeName, :245-303 pointAtDistance/polylineLength)
- git show feat/launch:frontend/src/styles.css — 2024 lines (read :1-90 the token block, :1940-2020 the .report* block at :1947-2011)
- git show feat/launch:frontend/src/components/RouteCard.jsx — 224 lines (grepped: imports at :14, mounts <ReportBarrier route={route}/> at :199)
- git show feat/launch:frontend/src/components/BlockedRouteCard.jsx — 101 lines (grepped: imports at :4, mounts at :92)
- git ls-tree -r feat/launch --name-only -- frontend/src/components — 22 components, to confirm ReportBarrier.jsx exists there and not on main

### Plan

All paths absolute. Current tree = /Users/poojana/Meander/Meander, branch `main`. HEAD has moved to 8644ff2 since the brief was written, but `git diff 46d4772..HEAD -- frontend/src backend/` is EMPTY, so every line number below is valid for both.

=====================================================================
0. WHAT THE LAUNCH COMPONENT NEEDS THAT MAIN DOES NOT HAVE
=====================================================================
`feat/launch:ReportBarrier.jsx:3-4` imports:
  - `reportBarrier` from `../api/client.js`  → ABSENT on main (client.js ends at `geocode`, :154-160)
  - `BLOCKER_TYPE_NAMES` from `../lib/format.js` → ABSENT on main
  - `pointAtDistance`   from `../lib/format.js` → ABSENT on main
  - `polylineLength`    from `../lib/format.js` → ABSENT on main
  - `fmtDist`           from `../lib/format.js` → PRESENT, /Users/poojana/Meander/Meander/frontend/src/lib/format.js:51
So the port is 2 new files + 6 edited files.

=====================================================================
1. NEW FILE — /Users/poojana/Meander/Meander/frontend/src/lib/geometry.js  (~60 lines)
=====================================================================
Responsibility: two pure great-circle helpers, no DOM, no network, no storage.
  export function polylineLength(geometry)        // [lon,lat][] → metres
  export function pointAtDistance(geometry, targetM)  // → {lon, lat} | null

Port the bodies VERBATIM from `feat/launch:frontend/src/lib/format.js:254-286` (pointAtDistance)
and `:287-303` (polylineLength). Keep launch's `R = 6371008.8`.

Three placement decisions, each with a reason the implementer must not undo:
 (a) NOT in `lib/format.js`. That file's own header (format.js:1-2) scopes it to strings that
     "can end up in a screen reader". Trigonometry is not formatting; launch put it there and
     it was wrong.
 (b) NOT imported from `lib/follow.js`, even though `follow.js:17 haversineM` and
     `follow.js:39 cumulativeDistances` already do this maths. `follow.js:5-9` is a standing
     prohibition: "Nothing in this file makes a request, and nothing that calls it may either."
     ReportBarrier does make a request. Duplicating ~10 lines of trig with a stated reason
     follows the existing precedent at `lib/dash.js:32-41` (the route palette is duplicated in
     JS for a stated mechanical reason). Put that reason in the file header and cite follow.js:5-9.
 (c) The 6371008.8-vs-6371000 difference from `follow.js:13` is immaterial here because the
     value is only ever consumed as a RATIO (see §3 "length domain"), never displayed. Say so
     in the header so nobody "fixes" it later.

=====================================================================
2. NEW FILE — /Users/poojana/Meander/Meander/frontend/src/components/ReportBarrier.jsx (~175 lines)
=====================================================================
Signature: `export default function ReportBarrier({ route, onAnnounce })`
(launch took only `{ route }`; `onAnnounce` is required — see §3 "live region").

Hooks first, guards after (launch got this right, keep it):
  const formId = useId()
  const [open, setOpen] = useState(false)
  const [type, setType] = useState('barrier')
  const [description, setDescription] = useState('')
  const [atM, setAtM] = useState(0)
  const [result, setResult] = useState({ status: 'idle' })
  const statusRef = useRef(null)
  const geometry = route?.geometry ?? []
  if (!route || geometry.length < 2) return null

=====================================================================
3. THE SIX DELIBERATE DIVERGENCES FROM THE LAUNCH SOURCE
=====================================================================

3.1 LENGTH DOMAIN — fixes a real defect in the launch version.
  `feat/launch:ReportBarrier.jsx:39` computes `total = Math.round(polylineLength(geometry))`
  and `:97` displays `fmtDist(total)`. In the redesign this form sits inside `.detail`, a few
  centimetres below `/Users/poojana/Meander/Meander/frontend/src/components/RouteDetail.jsx:81`
  which displays `fmtDist(route.distance_m)`. Those are two different numbers for the same
  route — server distance vs client length over a simplified polyline — shown in one panel.
  Replace with:
      const lineM  = polylineLength(geometry)                 // internal only, never displayed
      const totalM = Math.round(route.distance_m ?? lineM)    // the only number the user sees
      const frac   = totalM > 0 ? atM / totalM : 0
      const at     = pointAtDistance(geometry, frac * lineM)
  Slider: `min={0} max={totalM} step={Math.max(10, Math.round(totalM / 100))}`.
  The two slider extremes still land on the two ends of the line regardless of the mismatch.

3.2 LIVE REGION — mandatory.
  `feat/launch:ReportBarrier.jsx:148` is `<p className="report__status" role="status">`. That is
  a SECOND live region. The app has exactly one, at
  /Users/poojana/Meander/Meander/frontend/src/App.jsx:372-374, and `FollowMode.jsx:171-178`
  routes through an `onAnnounce` prop rather than opening another.
  → Drop `role="status"`. Drop any `role="alert"` too.
  → On settle call `onAnnounce?.(sentence)`; App wires it to `announce` (App.jsx:198-202).
  → Additionally move focus to the status paragraph on settle (`tabIndex={-1}` + `statusRef`),
    so a keyboard user lands on the outcome without a live region.

3.3 NETWORK ERROR HANDLING — mandatory.
  `feat/launch:client.js:200-208` has NO try/catch around `fetch`, unlike its two siblings on
  main (`client.js:81-84` and `client.js:133-136`). Ported as-is, a dropped connection surfaces
  as `TypeError: Failed to fetch`. Wrap it (see §4A).

3.4 WARNING PLACEMENT.
  `feat/launch:ReportBarrier.jsx:127-133` puts the dev-server warning after the fields and
  before the button, with a comment (`:127-128`) saying it is "said before the button, not
  after. Somebody offering real local knowledge should know where it is going before they
  spend the effort." The fields ARE the effort. Render it FIRST, immediately after the title.

3.5 TRIGGER BUTTON.
  Do NOT port `feat/launch:styles.css:1947-1960 .report__open` — it is
  `background: none; border: 0; text-decoration: underline` with height-only sizing.
  Use `<button type="button" className="button report__open">`. `.button`
  (styles.css:654-661) already carries `min-height: var(--target); min-width: var(--target)`.
  Co-classing a block element onto `.button` is the existing pattern
  (`FirstRun.jsx:30` → `button.button--primary.firstrun__locate`).

3.6 NO OPTIMISTIC MUTATION.
  The report must not touch `route`. No push into `route.blockers`, no score change, no
  `dispatch`, no nonce bump (`App.jsx:71-73 withRefetch` untouched). Meander does not read the
  dev server back; the success copy says so (§5a).

=====================================================================
4. EDITS TO EXISTING FILES — each anchored to a real line
=====================================================================

4A. /Users/poojana/Meander/Meander/frontend/src/api/client.js
  Append after line 160 (end of `geocode`). Port `feat/launch:client.js:190-208` WITH a
  try/catch and WITH a mock branch:

      /** File an obstruction as an OSM note. The only write this app makes.
       *  ⚠ Targets api06.dev.openstreetmap.org, the OSM *development* server; the
       *  backend asserts that host at call time (backend/osm_report.py:36-44). */
      export async function reportBarrier(report, { signal } = {}) {
        if (isMock) {
          const { mockReportBarrier } = await import('./mock.js')
          return mockReportBarrier(report, { signal })
        }
        let res
        try {
          res = await fetch(url('/api/report-barrier'), {
            method: 'POST',
            signal,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(report),
          })
        } catch (err) {
          if (err?.name === 'AbortError') throw err
          throw new ApiError('Could not reach the Meander server. Nothing was sent.')
        }
        if (!res.ok) throw await toApiError(res)
        return res.json()
      }

  `toApiError` (client.js:50-70) already lifts `body.error.message`/`body.error.kind` and
  `Retry-After` into `err.retryAfter` — which nothing currently renders. This port renders it.
  Body must be EXACTLY `{lat, lon, type, description}`: `backend/models.py:210` sets
  `model_config = ConfigDict(extra="forbid")`, so any extra key is a 422.

4B. /Users/poojana/Meander/Meander/frontend/src/api/mock.js  (346 lines)
  Append `mockReportBarrier` after `mockGeocode` (:341). It must NOT fake success — it should
  reproduce the shipped deployment's behaviour:
      export async function mockReportBarrier() {
        await delay(400)
        throw new ApiError(
          'Barrier reporting is not available on this server right now. Nothing was sent.',
          { status: 503, kind: 'barrier_report' },
        )
      }
  (import `ApiError` from './client.js'; mock.js is lazily imported by client.js so the cycle
  is resolved at call time — verify no top-level cycle, and if there is one, construct a plain
  object with `name:'ApiError', status, kind, message` instead.)
  No change to the route/envelope fixture contract at mock.js:322-327.

4C. /Users/poojana/Meander/Meander/frontend/src/lib/format.js
  Insert after `SCORING_METHOD_LABEL` (ends at :151), porting
  `feat/launch:frontend/src/lib/format.js:160-175` verbatim including its comment:

      /** The names the backend can actually emit — `_span_verdicts` produces
       *  "steps", "surface", "smoothness", "barrier"; `incline_findings` produces
       *  "incline". Nothing else is invented here: a name for a type the backend
       *  cannot emit would be a promise about data that does not exist. */
      export const BLOCKER_TYPE_NAMES = {
        steps: 'Steps', surface: 'Surface', smoothness: 'Surface condition',
        barrier: 'Barrier', incline: 'Gradient',
      }
      export function blockerTypeName(type) {
        return BLOCKER_TYPE_NAMES[type] ?? 'Obstruction'
      }

  RECOMMENDED follow-up (small, separable): `RouteDetail.jsx:33` currently renders the raw key
  (`<strong>{b.type}:</strong>` → "steps:"). With the select saying "Steps", the two disagree.
  Change to `blockerTypeName(b.type)`. Check `StepList.jsx:111-115` for the same wording before
  changing it there.

4D. /Users/poojana/Meander/Meander/frontend/src/components/RouteDetail.jsx  (205 lines)
  Two edits, plus one comment amendment.
  (i) :58 — add a named slot prop, following the `stepList` precedent:
        export default function RouteDetail({ route, theme, stepList, report, onStart, children })
  (ii) insert at :199 — between `)}` (end of the `.detail__actions` block, :198) and
       `<p className="detail__pattern-note">` (:200):
        {report}
       WHY a named slot and not `children` (:175): `children` renders ABOVE `.detail__actions`,
       which would put a secondary report control above the primary "Start this route" button.
       WHY not inside `.detail__actions`: that container is gated at :181 on
       `onStart && route.steps?.length > 0`. Barrier reporting must work on blocked and
       step-less routes — launch mounted it on BOTH `RouteCard.jsx:199` and
       `BlockedRouteCard.jsx:92`.
  (iii) :176-180 is a standing prohibition on Share/Save. Add one sentence so the next reader
       does not read it as covering Report: Report has a live, tested endpoint and does
       something; Share and Save still do not.

4E. /Users/poojana/Meander/Meander/frontend/src/App.jsx
  (i) insert import at :10 (before `import RouteDetail from './components/RouteDetail.jsx'`):
        import ReportBarrier from './components/ReportBarrier.jsx'
  (ii) insert one line after :447 (the `stepList={...}` line), inside the `<RouteDetail>` open
       tag that spans :444-449:
        report={<ReportBarrier route={selectedRoute} onAnnounce={announce} />}
  Nothing else in App changes. No reducer case, no DEBOUNCE key (App.jsx:26-34), no touch of
  the fetch effect's dependency array (:258) or the eslint-disable at :257 — this control does
  not refetch, following the `theme`/`follow`/`highlight` precedent.

4F. /Users/poojana/Meander/Meander/frontend/src/styles.css  (1720 lines)
  (i) EDIT the existing control rule at :636-638 — add one selector line so the textarea
      inherits border, radius, background, padding and `min-height: var(--target)` instead of
      a second copy of them:
          input[type='text'],
          input[type='search'],
          textarea,
          select {
  (ii) APPEND a new banner section at line 1721 (after the `follow` section, 1609-1720). Note
      the `responsive` block sits mid-file at 1409-1486, so a new section at the end carries
      its own media query if it needs one — this one does not.

          /* ---------------------------------------------------------------- report */
          .report__open { align-self: flex-start; margin-top: var(--s2); }
          .report {
            display: flex; flex-direction: column; gap: var(--s3);
            border: 1px solid var(--rule-strong); border-radius: var(--r-sm);
            background: var(--raised); padding: var(--s3); margin-top: var(--s2);
          }
          .report__title { margin: 0; font-family: var(--font-body); font-size: var(--t-body); font-weight: 700; }
          .report__warn { margin: 0; }              /* colour comes from .note--warn */
          .report__text { resize: vertical; min-height: var(--target); }
          .report__actions { display: flex; gap: var(--s2); flex-wrap: wrap; }
          .report__actions .button--primary:disabled { opacity: 0.55; cursor: not-allowed; }
          .report__status { margin: 0; font-size: var(--t-small); font-weight: 600; }
          .report__status:empty { display: none; }
          .report__handoff { margin: var(--s2) 0 0; font-size: var(--t-small); }

      ZERO hex literals → the CI gate at `.github/workflows/ci.yml:158-170` stays green, and
      `styles.css:10-13`'s invariant holds. No new token is needed: `--warn-ink`,
      `--warn-ground`, `--warn-rule` already exist in both `:root` (styles.css:52-54) and
      `[data-theme='dark']` (styles.css:66-102).

4G. /Users/poojana/Meander/Meander/frontend/src/components/About.jsx — REQUIRED, not cosmetic.
  :29-33 currently promises: "Nothing is stored. No cookies, no analytics, no location history
  — your coordinates are used to answer this one request and then discarded." A barrier report
  publishes a coordinate and free text to a public database, permanently. Shipping the form
  without amending this makes the app's privacy statement false. Append to that paragraph:
      "The one exception is a barrier you choose to report: that publishes the point you picked
       and the words you wrote to the OpenStreetMap development server, permanently and in
       public. Nothing is sent unless you press Send report."
  `FirstRun.jsx:112-115` and `FollowMode.jsx:239-241` make narrower claims that stay true — do
  not edit them.

=====================================================================
5. THE MARKUP, IN ORDER (open state)
=====================================================================
<form className="report" onSubmit={submit} aria-labelledby={`${formId}-title`}>
 1. <h4 className="report__title" id={`${formId}-title`}>Report a barrier</h4>
    (h4 matches the sibling section headings' level, RouteDetail.jsx:105/126/131, so the
     heading outline stays correct. Do NOT reuse `.detail__h` — styles.css:1284-1291 is a
     micro uppercase eyebrow, not a card title.)
 2. THE WARNING, FIRST:
    <p className="note note--warn report__warn">
      <span aria-hidden="true">⚠ </span>
      This goes to the OpenStreetMap <strong>development</strong> server, not the live map.
      It is disposable data that no navigation app reads — the write path is real, but it
      will not help strangers yet.
    </p>
 3. <p className="field__hint">Meander can only reject a barrier somebody has already
    recorded. If you found one it did not know about, this is how it gets known.</p>
    (reuse `.field__hint`, styles.css:623 — do not port launch's `.report__where`.)
 4. .field + .field__label + native <select> over `Object.entries(BLOCKER_TYPE_NAMES)`.
    Native select is already 44px (styles.css:645-648) and is what TripBar.jsx:190-201 uses.
 5. .field + .field__label + <input type="range">. Label:
      How far along the route? <span className="tabular">{fmtDist(atM)}</span> of{' '}
      <span className="tabular">{fmtDist(totalM)}</span>
    Keep `aria-valuetext={`${fmtDist(atM)} along the route`}`. Range is already
    `height: var(--target)` (styles.css:743-749); `.tabular` exists at styles.css:209.
 6. .field + .field__label + <textarea className="report__text" rows={3} maxLength={500}
    required placeholder="e.g. Four steps up to the bridge, no ramp">.
    500 matches `backend/models.py:215 description: str = Field(max_length=500)`; over-length
    is a 422 (asserted at backend/tests/test_streaming_and_reporting.py:186).
 7. <div className="report__actions"> submit `.button.button--primary`
    (disabled while sending or `!description.trim()`) + cancel `.button`.
 8. <p className="report__status" ref={statusRef} tabIndex={-1}> — NO role attribute.

=====================================================================
6. EXACTLY WHAT THE UI SHOWS, PER OUTCOME
=====================================================================
(a) 200 with a note id — `{status:'submitted', note_id, target, message}` from
    backend/main.py:1236-1244:
      "Thank you. Filed on the OpenStreetMap development server as note {id}.
       Meander does not read that server back, so this route's scores have not changed."
    The second sentence is new and is required by the UNKNOWN rule — a user who has just
    reported steps must not be left believing the app now knows about them.
    Clear the textarea. Leave the route untouched.

(b) 200 with `note_id: null` — `backend/osm_report.py:103-114` returns None when OSM's body
    carries no id, and `backend/tests/test_barrier_reporting.py:108` asserts that is not an
    error. Same sentence, without the id clause.

(c) 503 — THE SHIPPED DEFAULT, and the real "unavailable" case.
    `backend/osm_report.py:85-90` → `backend/main.py:1234 _error("barrier_report", ...)` →
    `backend/main.py:360-361` produces
      {"error":{"kind":"barrier_report",
                "message":"Barrier reporting is not available on this server right now.
                           Nothing was sent."}}
    `client.js:55-57` lifts that message verbatim. Render, inside `.note.note--warn` (⚠ glyph
    + border + weight, not colour alone), with THE FORM STILL PRESENT AND THE TYPED
    DESCRIPTION PRESERVED:
      title: the server's sentence, verbatim.
      sub:   "Meander received it and discarded it — it was not written anywhere and was not
              logged."  (True and checkable: the FixtureMissing path at osm_report.py:85-90
              logs nothing, and the transport path at :92 logs only the exception type.
              Do NOT write "nothing left your browser" — that would be false.)
      then, revealed only in this state, the manual handoff:
        <p className="report__handoff">You can still put this on the map yourself. Meander
        never writes to the live OpenStreetMap — you can, as a mapper, from your own account.</p>
        <textarea readOnly rows={3} value={noteText} />   // the exact text we would have sent
        <a className="button"
           href={`https://www.openstreetmap.org/note/new#map=18/${lat}/${lon}`}>
          Open OpenStreetMap at this point
        </a>
      The coordinate goes in the URL FRAGMENT, not a query string, so it is never sent to
      osm.org's server; `frontend/vercel.json:20` already sets `Referrer-Policy: no-referrer`.
      `About.jsx:43` already links to openstreetmap.org, so this is not a new host relationship
      and it is user-initiated navigation, not a runtime request.
    Leave Send enabled — the 503 can clear (the `osm_dev` live-call budget is 20/day,
    `backend/config.py:160`, and resets at UTC midnight).

(d) 429 — `backend/main.py:1220-1226`, with a `Retry-After` header. Render `err.message`
    verbatim plus, when `err.status === 429 && err.retryAfter > 0`, "Try again in
    {retryAfter} seconds." `client.js:68` already parses that header into `err.retryAfter` and
    NOTHING renders it today; this closes that gap at zero cost.

(e) 422 / 502 / 500 — same `.note.note--warn`, `err.message` verbatim. 500 is the
    host-assertion refusal (`osm_report.py:40-44`) and its wording is already correct for a user.

(f) Network failure / mock mode — "Could not reach the Meander server. Nothing was sent."
    In `VITE_MOCK_API=1` the mock throws the 503 sentence, so the demo shows the shipped
    deployment's real behaviour rather than a fictional success.

=====================================================================
7. THE TOKEN-ABSENT CASE — the direct answer
=====================================================================
There are three sub-cases and only one of them is a failure:

 (1) Token absent + MEANDER_FIXTURES=replay  ← today's shipped default and today's AWS deploy.
     The token is irrelevant. `fetch(..., service="osm_dev")` raises FixtureMissing (there is
     no `fixtures/osm_dev/` directory; `fixtures/` holds graphhopper, mapillary, nominatim,
     open_meteo, overpass). UI = outcome (c) above.

 (2) Token absent + MEANDER_FIXTURES=live + budget remaining.
     THE REPORT IS FILED, ANONYMOUSLY, AND SUCCEEDS. `backend/osm_report.py:60-63` states the
     token is optional; `:69-70` adds the header only when set. Asserted twice:
     `backend/tests/test_barrier_reporting.py:130` and `backend/tests/test_hardening.py:188`
     (`assert "Authorization" not in seen`). UI = outcome (a)/(b).
     COPY CONSTRAINT: the success sentence must never say "your note", must not offer to edit
     or delete it, and must not claim attribution — the frontend cannot know whether a token
     was set, and an anonymous note cannot be managed. Launch's wording is already free of
     those claims; add a code comment saying why it must stay that way.

 (3) The frontend CANNOT detect the token, at all. `backend/main.py:1385-1391` deliberately
     refuses to name unset secrets ("free reconnaissance"); `OSM_DEV_TOKEN` is in neither
     `Settings.missing_keys()` nor `missing_required_keys()` (backend/config.py:264-299), so
     `keys_ok`, `/readyz` and `/api/health` all stay green whether it is set or not.
     Therefore "hide the form when the token is absent" is not implementable, and the only
     honest client-side signal is the HTTP status. That is what this design keys on.

=====================================================================
8. OPTIONAL P1 — pre-flight, so effort is never wasted
=====================================================================
§6(c) degrades honestly but only AFTER the user types. To honour
`feat/launch:ReportBarrier.jsx:127-128` fully ("before they spend the effort"), add a
side-effect-free capability read on the SAME path — no new host, no CSP change:

  backend/main.py, immediately after `report_barrier` ends at :1244:
      @app.get("/api/report-barrier")
      async def report_barrier_capability() -> dict[str, Any]:
          """Whether a report filed right now would reach the dev server.
          Creates no note. Computed from the same conditions submit_barrier hits,
          so the answer cannot drift from the behaviour."""
          from .osm_report import reporting_availability
          return reporting_availability()

  backend/osm_report.py, new `reporting_availability()` returning
      {"available": bool, "reason": str | None, "target": PERMITTED_HOST}
  where `reason`, when unavailable, is BYTE-IDENTICAL to the 503 message so there is one
  wording in the system. Compute from `fixtures.current_mode()` (backend/fixtures.py:530) and
  `fixtures.budget_applies("osm_dev")` (backend/fixtures.py:322) — confirm that function's
  return contract before relying on it.
  DO NOT include an `attributed`/token field: that would leak whether a secret is set and
  contradict the policy at backend/main.py:1385-1391.

  Frontend: call it LAZILY on the first click of the trigger, never on mount; cache per
  session. When `available === false`, render no fields at all — replace the form with:
      <p className="note note--warn"><span aria-hidden="true">⚠ </span>
        <strong>Reporting a barrier is switched off on this server.</strong></p>
      <p className="field__hint">The write path exists and is tested, but this deployment
        cannot reach the OpenStreetMap development server, so nothing you typed would be
        filed. If you want this on the map, add a note yourself — that goes to the live map,
        which Meander never writes to.</p>
      <a className="button" href="https://www.openstreetmap.org/note/new">Open OpenStreetMap</a>
  If the probe itself errors, FALL BACK to rendering the form (§6 behaviour). Unknown is not
  "unavailable": refusing on an unknown would hide a working feature, and the 503 path is
  already honest.

=====================================================================
9. TOKEN MAPPING — launch vocabulary → current vocabulary
=====================================================================
Sources: `feat/launch:frontend/src/styles.css:1947-2011` (the .report* block) and `:11-90`
(launch's :root). None of the left-hand names may appear in the new CSS.

| launch token      | launch value        | used by .report*                       | CURRENT equivalent | note |
|-------------------|---------------------|----------------------------------------|--------------------|------|
| --space-2         | 8px                 | .report__open pad, .report__actions gap, .report__warn pad, .report margin-top | --s2 (8px) | exact 1:1 |
| --space-3         | 12px                | .report gap+pad, .report__text pad, .report__warn pad | --s3 (12px) | exact 1:1 |
| --space-1/-4/-5/-6/-7/-8 | 4/16/24/32/48/64 | unused here                        | --s1/--s4/--s6/--s7/(none)/(none) | launch's 48 and 64 have no equivalent; the redesign tops out at --s8=40px. Use --s8, do not add a token. |
| --text-1          | 0.875rem (14px)     | .report__open, .report__where, .report__warn, .report__status | **--t-small (0.8125rem / 13px)** | NOT 1:1. Launch's floor was 14px; the redesign's small step is 13px and is what `.field__hint` (styles.css:625) and `.note` (styles.css:1323) already use. Match the neighbours. Do not invent a 14px token. |
| --text-2          | 1rem (16px) = launch body | .report__title                    | **--t-body (0.9375rem / 15px)** | 1:1 by ROLE (both are the body size). If the title reads too quiet next to `.detail__title`, step up to --t-h3 (1.0625rem) — but never hard-code a size. |
| --text-3/-4/-5/-6 | 18/22/28/36px       | unused here                            | --t-h3 / --t-h2 / --t-metric / --t-display | listed for completeness |
| --radius-control  | 6px                 | .report, .report__text, .report__warn  | **--r-sm (8px)** | the redesign has no 6px radius; --r-sm is what every other control uses (styles.css:641, 659) |
| --radius-card     | 8px                 | unused here                            | --r-md (12px) or --r-sm | — |
| --radius-chip     | 999px               | unused here                            | --r-pill | — |
| --ink             | **#14213d** (navy)  | .report__open colour                   | --ink (#16241c light / #e8efe8 dark) | SAME NAME, DIFFERENT VALUE. Keep the name, never the value, never the hex. |
| --ink-muted       | #545f71             | .report__where                         | **--ink-2** | renamed |
| --raised          | #fffdf8             | .report bg, .report__text bg           | --raised | same name, re-valued, dark override at styles.css:66-102 |
| --rule-strong     | #c3bdae             | .report border, .report__text border   | --rule-strong | same name |
| --warn-ink        | #8a2c14             | .report__warn text                     | --warn-ink | same name, both themes |
| --warn-ground     | #f3e6de             | .report__warn bg                       | --warn-ground | same name |
| --warn-border     | #cf9f88             | .report__warn border                   | **--warn-rule** | RENAMED. `--warn-border` does not exist on main. In practice: drop all three and use the `.note.note--warn` class (styles.css:1318-1329), which already composes them. |
| --page / --recessed | #f7f4ee / #f2eee5 | unused here                            | --paper / --sunken | renamed |
| --selected-border, --map-casing | #8fa0bd, #ffffff | unused here                 | no equivalent; none needed | do not introduce |
| --target          | 44px                | .report__open                          | --target (44px) | identical |
| --font-body       | IBM Plex Sans stack | .report__title                         | --font-body | byte-identical declaration on both branches |
| launch route palette: --route-fastest #2f6fd0, --route-scenic #2e8b57, --route-accessible #7a4fc4, --route-quiet #b06a1f, --route-shade #12756c, --route-air #b03050 (feat/launch:styles.css:50-55) | blue-led | NOT used by .report* | current dark-green palette --route-* (styles.css:44-49 light, :86-91 dark, mirrored in lib/dash.js:20-69) | **The report UI must reference no route colour at all.** Do not add a route swatch, edge or tint to the form. |
| --score-scenic / --score-air / --score-shade (aliases, feat/launch:styles.css:57-59) | — | NOT used by .report* | no equivalent, none needed | — |

Two launch declarations to DROP rather than map:
  - `.report__open { background: none; border: 0; text-decoration: underline }` → replaced by
    `.button`, for the 44×44 rule.
  - `.report__warn`'s three colour declarations → replaced by the `.note--warn` class.
Keep `.report__status:empty { display: none }` — token-free and still useful.

=====================================================================
10. WHAT THE BRIEF GOT WRONG (checked against the source, not assumed)
=====================================================================
W1. "It needs OSM_DEV_TOKEN" — FALSE. The token is OPTIONAL.
    backend/osm_report.py:60-63 says so in terms ("Anonymous notes are permitted by the OSM
    API, so the token is optional rather than required"); :69-70 adds the header only when
    set. Two tests assert the anonymous path files successfully:
    backend/tests/test_barrier_reporting.py:130 `test_without_a_token_it_still_files_anonymously`
    and backend/tests/test_hardening.py:188 `test_no_token_still_files_an_anonymous_note`
    (which asserts `"Authorization" not in seen`).

W2. "the feature MUST degrade honestly when the token is absent" — NOT IMPLEMENTABLE AS
    WRITTEN. The frontend has no channel that reveals the token. backend/main.py:1385-1391
    deliberately withholds which secrets are unset; OSM_DEV_TOKEN is absent from both
    `missing_keys()` and `missing_required_keys()` (backend/config.py:264-299), so keys_ok,
    /readyz and /api/health are identical either way. The design must key on the 503 status.

W3. The real cause of unavailability is FIXTURE MODE, not the token. MEANDER_FIXTURES defaults
    to `replay` (backend/config.py:302-306) and there is no `fixtures/osm_dev/` directory, so
    `fetch(..., service="osm_dev")` raises FixtureMissing → caught at osm_report.py:85-90 →
    503 "Barrier reporting is not available on this server right now. Nothing was sent."
    Asserted at backend/tests/test_streaming_and_reporting.py:174. Setting OSM_DEV_TOKEN on
    the current AWS deployment would change nothing (it appears in no infra template — only
    .env.example:50 and docs/legacy/render.yaml:39).

W4. "~16 tests behind it" — UNDERCOUNT. The real figure is 25:
    test_barrier_reporting.py 12 + test_streaming_and_reporting.py 10 (:137, :157 parametrised
    ×4, :164, :174, :182, :186, :191) + test_hardening.py 3 (:160, :188, :214).
    The hardening trio is missed entirely.

W5. Correct in the brief, confirmed: 157 lines; POST /api/report-barrier is live at
    backend/main.py:1211; NO UI calls it (`reportBarrier` is absent from
    frontend/src/api/client.js, whose only two fetch calls are :75 and :132).

W6. NOT IN THE BRIEF, but blocking: the launch component opens a SECOND live region
    (`role="status"`, feat/launch:ReportBarrier.jsx:148). The current app permits exactly one
    (App.jsx:372-374) and FollowMode.jsx:171-178 routes through `onAnnounce` instead.

W7. NOT IN THE BRIEF: `feat/launch:frontend/src/api/client.js:200-208 reportBarrier` has no
    try/catch around `fetch`, unlike `realFetchRoutes` (client.js:81-84) and `realGeocode`
    (client.js:133-136). Ported verbatim, a dropped connection shows "TypeError: Failed to fetch".

W8. NOT IN THE BRIEF: the launch form displays a route total computed client-side
    (ReportBarrier.jsx:39 → :97) that will not equal `route.distance_m` shown at
    RouteDetail.jsx:81 in the same panel. §3.1 fixes it.

### Risks and the rules that constrain it

WHAT COULD BREAK

R1. About.jsx becomes a false statement the moment this ships. /Users/poojana/Meander/Meander/frontend/src/components/About.jsx:29-33 promises "Nothing is stored… your coordinates are used to answer this one request and then discarded." A barrier report is a permanent public write of a coordinate plus free text. Edit 4G is not optional; if it is skipped, this port converts a true privacy claim into a false one, which is the exact class of failure the project's rules exist to prevent.

R2. Axis order. route.geometry is [lon, lat] (lib/follow.js:10); pointAtDistance returns {lon, lat}; BarrierReport wants named lat/lon (backend/models.py:212-213). Swapping them files a note in the wrong hemisphere ON A PUBLIC DATABASE. backend/tests/test_barrier_reporting.py:95 asserts server-side rounding but nothing asserts the axis order end to end. The geometry unit tests below are the only guard.

R3. extra="forbid" (backend/models.py:210). Any extra key in the POST body is a 422. Do not add a client-side `route_id`, `label` or timestamp "for context".

R4. Two totals in one panel — see W8. If the implementer ports ReportBarrier.jsx:39 verbatim, the form will say "of 2.4 km" beside a header saying "2.5 km" (RouteDetail.jsx:81).

R5. Rate-limit bucket sharing. backend/main.py:1220 calls `limiter.check(_client_ip(request))` — the same limiter object as /api/routes. Two reports in quick succession can spend tokens the user's next route search needs. Confirm against backend/ratelimit.py before shipping; if the bucket is shared, decide deliberately whether a report should cost a token.

R6. CSP. frontend/vercel.json:28 carries `form-action 'none'`, so the port MUST keep event.preventDefault() + fetch (a native form submit would be blocked). It also still contains the literal placeholder `https://REPLACE-WITH-YOUR-RENDER-HOST.onrender.com` in connect-src — harmless today because .github/workflows/deploy.yml:120-136 publishes to S3/CloudFront and sets no security headers at all, but if Vercel is ever used with a split VITE_API_BASE the report POST is blocked exactly as the routes POST would be.

R7. The mock import cycle. client.js lazily imports mock.js; mock.js importing ApiError back from client.js at module top level may create a cycle under Vite. If it does, construct a plain error object in the mock rather than restructuring client.js.

R8. StrictMode. frontend/src/main.jsx:12 wraps App in StrictMode. submit() is an event handler so it is not double-invoked — do not move the POST into a useEffect, which would double-file a note.

R9. Coverage gap this port widens. .github/workflows/deploy.yml:54-55 claims `npm run build` runs check:palette, check:permalink and check:offline; none exists (frontend/package.json:11 is a bare `vite build`, there is no frontend/scripts/). Adding a new interactive component to a frontend with no component-test harness widens a gap that comment already misrepresents. Note also that deploy.yml:56 runs `npm ci && npm run build` and never `npm test` — only .github/workflows/ci.yml:140-144 runs the frontend suite.

PROJECT RULES THAT CONSTRAIN THIS, AND HOW THE DESIGN SATISFIES EACH

Rule: a missing OSM tag means UNKNOWN, never "accessible".
  → The report never mutates `route`: no optimistic push into route.blockers, no score change, no dispatch, no nonce bump (App.jsx:71-73 untouched). The success sentence states explicitly that Meander does not read the dev server back and the scores have not changed (§6a). The `type` select offers exactly the five categories the backend can emit (BLOCKER_TYPE_NAMES, ported with its comment) — a sixth would be a promise about data that cannot exist. The 503 copy says "was not written anywhere", never "we'll look into it".

Rule: colour is never the only differentiator (must survive greyscale).
  → The dev-server warning is ⚠ glyph + <strong> + a 1px --warn-rule border + the prose itself (the .note.note--warn pattern at styles.css:1318-1329, matching VerificationMeter.jsx:31-36). Outcome states are distinguished by wording, not tone. The disabled submit is opacity + cursor + the native `disabled` attribute, not hue.

Rule: the route list is a complete text substitute for the map.
  → The position is chosen with a slider over distance along the route, never a map tap — which is exactly why launch chose it (ReportBarrier.jsx:15-19) and the only design that works for someone who never looks at the map. MapView.jsx is not touched and no marker is added. The label states the position in words ("400 m of 2.5 km") and the slider carries aria-valuetext.

Rule: no location history, no cookies, no analytics; localStorage for theme and units only.
  → The component writes no storage and reads no geolocation; the coordinate is derived from route.geometry the app already downloaded plus a slider the user moved. lib/theme.js:14 THEME_KEY stays the only key, and index.html:28's hard-coded duplicate stays in sync by not changing. The osm.org fallback link puts the coordinate in the URL FRAGMENT (#map=18/lat/lon), which browsers never send to the server, and vercel.json:20 already sets Referrer-Policy: no-referrer. Edit 4G keeps the stated privacy position true.

Rule: no new third-party runtime requests.
  → The POST goes to the same API_BASE as /api/routes and /api/geocode (client.js:19-21) — same host, no connect-src change. The optional P1 probe reuses the same path. The openstreetmap.org link is user-initiated navigation, not a page-issued request, and About.jsx:43 already links there.

Rule: all interactive targets ≥ 44×44 px.
  → Trigger, submit, cancel and the fallback link all use `.button` (styles.css:654-661, min-height AND min-width var(--target)). The select inherits min-height var(--target) (styles.css:645-648); the range is height var(--target) (styles.css:743-749); the textarea gets min-height var(--target) plus rows={3}. Launch's `.report__open` (feat/launch:styles.css:1947-1960) is deliberately NOT ported because it constrains height only. Note styles.css:406 (.theme-toggle) and :527 (.preset) are pre-existing 36px violations — a gap, not a precedent.

Rule (redesign): only the shipped token vocabulary; --space-*/--text-*/--ink:#14213d and the launch route palette are forbidden.
  → Full mapping in the plan. The new CSS section contains zero hex literals, so ci.yml:158-170 and the styles.css:10-13 invariant both hold, and no new token is added in either :root block.

Rule (app-level): one live region.
  → role="status" is dropped from the ported markup; outcomes route through onAnnounce → App.jsx:198-202 announce() → the single region at App.jsx:372-374, exactly as FollowMode.jsx:171-178 does. No role="alert" is added (the one at RouteDetail.jsx:96 is pre-existing and stays the sole exception). Focus moves to the status paragraph as a non-live-region backstop.

Rule: RouteRow and VerificationMeter may contain only <span>.
  → Not touched. The report lives in RouteDetail, which is ordinary flow content.

Rule: api/mock.js is the fixture contract.
  → One new export added; the route object keys and the envelope at mock.js:322-327 are unchanged.

### Tests

CONSTRAINT FIRST: there is NO component-test infrastructure. frontend/package.json:21-26 lists only @vitejs/plugin-react, axe-core, vite, vitest — no jsdom, no happy-dom, no @testing-library/react — and frontend/vite.config.js:20-33 sets only `test.env.TZ`. A ReportBarrier.test.jsx would require 2-3 new devDependencies plus `environment: 'jsdom'`. Do NOT add them as part of this port. Test the pure parts and the contract instead.

=====================================================================
T1. NEW — /Users/poojana/Meander/Meander/frontend/src/lib/geometry.test.js
=====================================================================
Runs under the existing config; model it on frontend/src/lib/follow.test.js:15-21, which uses an
equatorial line (1e-5° of longitude ≈ 1.113 m) so the numbers are checkable by hand.
  1. polylineLength of a two-point equatorial line 0.001° apart ≈ 111.3 m (±0.5 m).
  2. polylineLength([]) === 0 and polylineLength([[0,0]]) === 0.
  3. polylineLength(null) === 0 (launch's guard, format.js:301).
  4. pointAtDistance(line, 0) is the first vertex.
  5. pointAtDistance(line, polylineLength(line)) is the LAST vertex — exercises the
     `i === geometry.length - 1` branch (feat/launch:format.js:87), which is easy to break.
  6. pointAtDistance(line, 2 × length) CLAMPS to the last vertex; is not null and is not NaN.
  7. pointAtDistance(line, halfway) lands within 1 m of the middle vertex.
  8. A line containing a DUPLICATED vertex (zero-length segment) does not divide by zero —
     launch guards with `seg > 0 ? … : 0` at format.js:88; assert a finite result.
  9. pointAtDistance(null, 100) === null and pointAtDistance([], 100) === null.
 10. pointAtDistance([[10, 20]], 100) === {lon: 10, lat: 20} (single-vertex branch, format.js:69).
 11. THE INVARIANT THIS PORT DEPENDS ON (§3.1): given a client length L and a server distance
     D with D ≠ L, assert that frac=0 → first vertex and frac=1 → last vertex, i.e. the two
     slider extremes map to the two ends of the route regardless of the mismatch.
 12. RETURNED SHAPE IS {lon, lat}, not [lon, lat] — the guard against R2.

=====================================================================
T2. NEW — /Users/poojana/Meander/Meander/frontend/src/lib/format.test.js  (does not exist today)
=====================================================================
  1. Object.keys(BLOCKER_TYPE_NAMES) is exactly ['steps','surface','smoothness','barrier','incline']
     — no more, no fewer. This is the frontend half of the "no invented category" rule.
  2. blockerTypeName('unmapped-thing') === 'Obstruction'.
Creating this file also gives the frontend suite a home for future format assertions; it costs
nothing (vitest already picks up *.test.js).

=====================================================================
T3. APPEND — /Users/poojana/Meander/Meander/backend/tests/test_barrier_reporting.py
=====================================================================
Currently 12 tests; append after `test_a_successful_report_says_where_it_went` (:177).
  1. test_the_unavailable_message_is_the_one_the_ui_shows
     Assert the 503 body's message is byte-identical to
     "Barrier reporting is not available on this server right now. Nothing was sent."
     The frontend now renders it verbatim. Today nothing pins the wording —
     test_streaming_and_reporting.py:174 asserts only the substring "Nothing was sent", so a
     reword would silently change the UI.
  2. test_the_error_envelope_is_the_shape_the_client_parses
     Assert the 503 body is exactly {"error": {"kind": ..., "message": ...}}. client.js:55-57
     reads body.error.message / body.error.kind and silently falls back to
     "The server returned 503." if the shape changes.
  3. test_a_429_carries_retry_after
     backend/main.py:1220-1226 sets the header and the frontend now renders it
     (client.js:68 → "Try again in N seconds"). Today test_barrier_reporting.py:161 and
     test_streaming_and_reporting.py:191 assert only the 429 status, never the header.
  4. test_the_success_body_names_the_development_server
     Assert `target == "api06.dev.openstreetmap.org"` and that `message` does not contain the
     word "live". Protects the copy contract the UI restates.

=====================================================================
T4. NEW CROSS-HALF TEST — backend/tests/test_accessibility.py (or T3's file)
=====================================================================
  test_the_blocker_type_names_the_ui_offers_are_ones_the_backend_emits
  Assert the five keys the frontend offers match the categories `_span_verdicts` produces
  ("steps", "surface", "smoothness", "barrier") plus "incline" from `incline_findings`, both in
  backend/accessibility.py. Paired with T2.1, this makes silent drift between the select's
  options and the backend's vocabulary impossible.

=====================================================================
T5. ONLY IF P1 (§8) IS TAKEN — backend/tests/test_barrier_reporting.py
=====================================================================
  1. test_the_capability_probe_creates_no_note — GET /api/report-barrier with the `osm`
     fixture installed (test_barrier_reporting.py:33-58); assert `sent == {}`.
  2. test_the_capability_probe_says_unavailable_in_replay_mode — default api_client
     (conftest.py:137-143); assert available is False and that `reason` is byte-identical to
     the 503 message, so there is exactly one wording in the whole system.
  3. test_the_capability_probe_does_not_reveal_whether_a_token_is_set — run with and without
     OSM_DEV_TOKEN; assert the response body is identical both times. This is the test that
     keeps the probe inside the policy stated at backend/main.py:1385-1391.

=====================================================================
T6. MANUAL a11y HARNESS — /Users/poojana/Meander/Meander/frontend/src/a11y.jsx
=====================================================================
The form is a new interactive region with a select, a range, a textarea and two buttons — the
kind of thing axe catches. Add `.report` to ROW_SELECTOR at a11y.jsx:53 (currently
'button.route, .card') and open the form in the harness setup before the axe.run calls at
a11y.jsx:85/88. Note this is a MANUAL gate: grep over ci.yml, deploy.yml, Makefile and npm
scripts returns zero hits for the harness, so it will not run in CI.

=====================================================================
T7. EXPLICITLY NOT RECOMMENDED
=====================================================================
Do not revive feat/launch:frontend/scripts/gate.mjs (254 lines) to cover this. Seven of its
fourteen selector families (.topbar__origin, .controls-sheet__bar, .row__button, .card,
.sheet__handle, .sheet__scroll, .footer) do not exist on main; it would fail for reasons
unrelated to the report form and teach people to skip the gate. Likewise do not restore
check-palette.mjs as-is — it keys on '@media (prefers-color-scheme: dark)' and
'const FALLBACK_COLORS = {', neither of which exists in the redesign.

=====================================================================
MANUAL VERIFICATION BEFORE MERGE
=====================================================================
  a. `cd frontend && npm run dev:mock` — the form opens, submits, and shows the 503 copy plus
     the manual handoff. (The mock reproduces production, so this is the real path.)
  b. Backend at MEANDER_FIXTURES=replay + `npm run dev` — same 503 path against the real API,
     with the typed description preserved and the retry button live.
  c. Greyscale the panel (browser filter) — the warning block and every outcome state are still
     distinguishable.
  d. Keyboard only, both themes: tab to the trigger, complete the form, submit, confirm focus
     lands on the outcome and the App live region announces it once.
  e. `make check` (Makefile:72) — lint, backend coverage, frontend tests, frontend build,
     cfn-lint. The colour gate (ci.yml:149-170) is not in `make check`, so run its awk by hand
     against frontend/src/styles.css, or push and let CI run it.

---

## lib/export.js — take the route with you: GPX 1.1 (`<trk>`), GeoJSON with each barrier as its own feature, Google/Apple Maps handoff URLs, and a print sheet — with `provenanceNote()` as the single source of the accessibility caveat, embedded in all four.

**OPEN**

### Sources read on `feat/launch`
- git show feat/launch:frontend/src/lib/export.js — 231 lines (the whole capability: provenanceNote, safeName, toGpx, toGeoJson, download, downloadGpx, downloadGeoJson, sampleWaypoints, googleMapsUrl, appleMapsUrl)
- git show feat/launch:frontend/src/components/TakeItWithYou.jsx — 81 lines (the only consumer; three buttons + a disclosure-gated maps handoff)
- git show feat/launch:frontend/src/components/RouteCard.jsx — 224 lines (read for the mount point only: imports TakeItWithYou at :15, renders it at :201 with route/origin/dest)
- git show feat/launch:frontend/src/styles.css — 2024 lines (read two regions: the `.takeaway` block at :1685-1744, and the ENTIRE print sheet at :1746-1824 — the print sheet is CSS, not JS; plus the launch token block at :11-104 for the token mapping)
- git show feat/launch:frontend/src/lib/format.js — 303 lines (read fmtDur :15-23 and fmtDist :36-40 — the two functions export.js imports; on launch fmtDist delegates to units.js formatDistance, on main it does not)
- git show feat/launch:frontend/src/lib/units.js — 159 lines (line count only; confirmed export.js does NOT import it — the units capability is separable from this one)
- git show feat/launch:frontend/src/lib/permalink.js — 135 lines (line count only; confirmed export.js does NOT import it — the share capability is separable from this one)

### Plan

## 0. What is actually being ported (read this first)

`feat/launch:frontend/src/lib/export.js` is 231 lines and contains **three** of the four formats. The print sheet is **not in it** — it is `window.print()` at `feat/launch:frontend/src/components/TakeItWithYou.jsx:32` plus a 78-line `@media print` block at `feat/launch:frontend/src/styles.css:1746-1824`. And `provenanceNote` reaches only **two** of the four (GPX, GeoJSON). Closing that to four is the substance of this spec — see §5 and §7.

Nothing about this capability touches the network, storage, the reducer, the fetch effect, or `MapView`. It is additive.

---

## 1. NEW FILES

### 1a. `/Users/poojana/Meander/Meander/frontend/src/lib/export.js` (~250 lines)

Pure string/URL generation plus one DOM helper. **No import from `lib/units.js` or `lib/permalink.js`** — this capability is independent of the other two Phase-4 ports.

```js
import { SCORING_METHOD_LABEL, confidenceSentence, fmtDist, fmtDur, restStopName }
  from './format.js'
```

Exports, in order:

| export | signature | notes |
|---|---|---|
| `provenanceNote` | `(route) => string` | §5. The one string. |
| `exportStamp` | `(route, now = new Date()) => { filename, isoTime }` | Replaces launch's `safeName`. **One `now` for both**, fixing the launch defect where `safeName` and `toGpx` each called `new Date()` and could straddle UTC midnight (`export.js:53-54` vs `:113`). `filename` = `` `meander-${route.id}-${isoTime.slice(0,10)}`.replace(/[^a-z0-9-]/gi,'') ``; `isoTime` = `now.toISOString()`. |
| `toGpx` | `(route, { origin, dest } = {}, now) => string` | §4a |
| `toGeoJson` | `(route) => string` | §4b |
| `sampleWaypoints` | `(geometry, max = 8) => number[][]` | copy verbatim from `export.js:196-202` — it is correct (keeps first and last, even index step). |
| `googleMapsUrl` | `(route) => string \| null` | copy from `export.js:206-219`. Uses `route.mode`, which Survey B lists as UNREACHABLE — **this port is what makes `Route.mode` reachable**. It is present in the mock (`frontend/src/api/mock.js:162, 187, 228, 277`) and on the model (`backend/models.py:150`), so no fallback plumbing is needed beyond the existing `?? 'walking'`. |
| `appleMapsUrl` | `(route) => string \| null` | copy from `export.js:223-233`, but replace the misleading `sampleWaypoints(route.geometry, 2)` with an explicit first/last read plus a comment saying Apple's URL scheme has **no** via-point parameter, so the shape is discarded entirely. |
| `download` | `(filename, contents, mime) => void` | copy from `export.js:167-180` verbatim, **including** the `setTimeout(..., 1000)` revoke — the Safari comment at `:177-179` is load-bearing. This is the only function in the file that touches `document`; keep it last and keep it out of every unit test (§6). |
| `downloadGpx`, `downloadGeoJson` | thin wrappers | as `export.js:182-187`, but compute one `now` and pass it to both `exportStamp` and `toGpx`. |

Deliberately **not** ported: nothing. Deliberately **added**: `exportStamp`, and `provenanceNote` delegating to `confidenceSentence` (§5).

### 1b. `/Users/poojana/Meander/Meander/frontend/src/lib/export.test.js` (~230 lines) — see §6.

### 1c. `/Users/poojana/Meander/Meander/frontend/src/components/TakeItWithYou.jsx` (~130 lines)

Derived from `feat/launch:frontend/src/components/TakeItWithYou.jsx` (81 lines), with four changes.

```jsx
export default function TakeItWithYou({ route, origin, dest, onAnnounce }) {
  const [confirmHandoff, setConfirmHandoff] = useState(false)
  if (!route) return null

  const note = provenanceNote(route)
  const exportable = (route.geometry?.length ?? 0) >= 2
  const google = exportable ? googleMapsUrl(route) : null
  const apple  = exportable ? appleMapsUrl(route)  : null
  ...
}
```

Structure (BEM, two levels, matching Survey A §6):

```
<>                                                    ← fragment: two siblings
  <section className="takeaway" aria-labelledby="takeaway-h">   ← screen only
    <h4 className="detail__h" id="takeaway-h">Take it with you</h4>
    <div className="takeaway__row">
      <button className="button" …>Download GPX</button>        (gated on `exportable`)
      <button className="button" …>Download GeoJSON</button>    (gated on `exportable`)
      <button className="button" …onClick={() => window.print()}>Print</button>
    </div>
    <p className="takeaway__note">…the file carries the coverage figure and any barriers…</p>

    {(google || apple) && (
      <>
        <button className="link-button" aria-expanded={confirmHandoff}
                aria-controls="takeaway-handoff" onClick={…}>
          Open in a maps app for turn-by-turn
        </button>
        <div className="takeaway__warn" id="takeaway-handoff" hidden={!confirmHandoff}>
          <p className="takeaway__warn-title" id="takeaway-warn-title">
            <span aria-hidden="true">⚠ </span>
            <strong>This will not be the same route.</strong> …
          </p>
          <p id="takeaway-provenance">{note}</p>          ← §4c
          <div className="takeaway__row">
            <a className="button" href={google} target="_blank" rel="noreferrer noopener"
               aria-describedby="takeaway-warn-title takeaway-provenance">Google Maps</a>
            <a className="button" href={apple}  … same aria-describedby>Apple Maps</a>
          </div>
        </div>
      </>
    )}
  </section>

  <section className="printsheet" aria-hidden="true">                ← print only
    <h4 className="printsheet__h">Where this came from</h4>
    <p className="printsheet__note">{note}</p>
    <p className="printsheet__stamp">Printed from Meander, {stamp.isoTime}.</p>
  </section>
</>
```

The four changes from launch:

1. **`.takeaway__disclose` is deleted; reuse `.link-button`** (`frontend/src/styles.css:1351-1365`), which already carries `min-height: var(--target)` and the underline idiom. One fewer block, one fewer 44px risk.
2. **The drawer uses `hidden={!open}`, not `{open && …}`**, matching `TripDrawer.jsx:14-20` — the panel keeps its id so `aria-controls` always resolves.
3. **`provenanceNote` is rendered inside the handoff warning** and the two links are `aria-describedby` it (§4c).
4. **A `beforeprint`/`afterprint` effect** expands every closed `<details>` and restores it afterwards:
   ```js
   useEffect(() => {
     let opened = []
     const before = () => {
       opened = [...document.querySelectorAll('details:not([open])')]
       opened.forEach((d) => { d.open = true })
     }
     const after = () => { opened.forEach((d) => { d.open = false }); opened = [] }
     addEventListener('beforeprint', before); addEventListener('afterprint', after)
     return () => { removeEventListener('beforeprint', before); removeEventListener('afterprint', after) }
   }, [])
   ```
   This exists because launch's CSS trick — `.card__detail[hidden] { display: flex !important }` at `feat/launch:frontend/src/styles.css:1792-1794` — **does not port**: on `main` the collapsed content is `<details>` (`StepList.jsx:86`, `About.jsx:17`), and a `<details>` cannot be forced open from CSS in the browsers this ships to. Without this hook the printed sheet loses the turn-by-turn directions and the OSM caveat — the two things the sheet exists for. It fires for Cmd-P as well as for the button.

`onAnnounce` is called after each download (`onAnnounce('GPX file saved.')`) and routed to App's single live region (`App.jsx:372-374`) exactly as `FollowMode` does (`FollowMode.jsx:171-178`). **No second live region.**

---

## 2. EXISTING FILES — every edit anchored

### 2a. `/Users/poojana/Meander/Meander/frontend/src/components/RouteDetail.jsx` (205 lines)

**Edit 1 — `RouteDetail.jsx:58`.** Add a named slot:
```js
export default function RouteDetail({ route, theme, stepList, takeaway, onStart, children }) {
```
A **named slot**, not the generic `children` slot at `:175`, for two reasons an implementer will otherwise get wrong: (a) the exports must render for a **blocked** route and for a route with **no steps**, and the `children` slot sits before the `onStart && route.steps?.length > 0` gate at `:181` where a reader will assume they are coupled; (b) "Take it with you" must come *after* "Start this route", and `children` is already occupied by `DaylightGuard` (`App.jsx:450-456`), which belongs above the actions.

**Edit 2 — replace the comment at `RouteDetail.jsx:177-180`.** It currently reads "No Share or Save… A control that does nothing reads as broken rather than as unbuilt." That standing prohibition is about **Share** (a permalink, still not built — `lib/permalink.js` is a different port) and **Save** (§6.8, deferred). A file download is neither: it produces the route itself, offline, with no URL state and no storage. The comment must be rewritten to say so rather than deleted, or the next reader will read the new block as a violation:
```
{/* Still no Share and no Save: Share needs URL state this app does not hold,
    and Save is §6.8. Download is a third thing — it hands the user the route
    they are looking at, as a file, with the confidence sentence written into
    it. Nothing is stored and nothing is sent. */}
```

**Edit 3 — insert `{takeaway}` at `RouteDetail.jsx:199`**, i.e. after the `)}` closing the actions block on `:198` and before `<p className="detail__pattern-note">` on `:200`.

### 2b. `/Users/poojana/Meander/Meander/frontend/src/App.jsx` (491 lines)

**Edit 4 — `App.jsx:16`.** Add `import TakeItWithYou from './components/TakeItWithYou.jsx'` (the import block at `:4-16` is not alphabetised — `FirstRun` leads — so append after `TripBar`).

**Edit 5 — `App.jsx:448`**, inside the existing `<RouteDetail …>` call at `:444-457`, alongside `stepList={…}`:
```jsx
takeaway={
  <TakeItWithYou
    route={selectedRoute}
    origin={state.origin}
    dest={state.dest}
    onAnnounce={announce}
  />
}
```
`announce` is already in scope (`App.jsx:198-202`) and already debounced 350 ms. `state.origin` / `state.dest` are the `{name, lat, lon}` objects `PlaceInput` produces (`PlaceInput.jsx:133`); `toGpx` reads only `.lat` / `.lon`.

**No other App edit.** No `DEBOUNCE` key, no reducer case, no `nonce` bump, no change to `buildRouteRequest`. Export is a read of state that already exists — the four-step refetch recipe in Survey A §4.5 does **not** apply, and `App.jsx:255-258` (the dependency array and the `eslint-disable`) must not be touched.

### 2c. `/Users/poojana/Meander/Meander/frontend/src/styles.css` (1720 lines)

**Edit 6 — insert three tokens after `styles.css:137`** (`--target: 44px;`), inside the theme-invariant `:root` block that opens at `:106` and closes at `:138`:
```css
  /* Print is theme-invariant on purpose: a dark-theme sheet would either waste
   * a cartridge or print as light-grey ink on white. These live in this block,
   * not the two colour blocks, because they do not change with the theme. */
  --print-paper: #ffffff;
  --print-ink: #000000;
  --print-rule: #999999;
```
This placement is **required**, and I verified it: the CI gate at `.github/workflows/ci.yml:158-170` scans for a hex outside a block opened by `^:root {` or `^\[data-theme='dark'\] {`. I ran that exact awk against a probe copy of `styles.css` with these three lines inserted at 137 and a `@media print` block appended — **it passes**. I ran it again with launch's literal `#fff` / `#000` / `#999` in the print block — see §7 defect 8 for what happened.

**Edit 7 — append two new banner sections at the end of the file, after `styles.css:1720`.** Per Survey A §6, new sections go at the end and carry their own media query; the responsive block at `:1409-1486` must not be edited.

```css
/* ------------------------------------------------------- take it with you */

.takeaway { display: flex; flex-direction: column; gap: var(--s2);
            padding-top: var(--s3); border-top: 1px solid var(--rule); }
.takeaway__row { display: flex; flex-wrap: wrap; gap: var(--s2); }
/* .button sets min-height/min-width: var(--target) (styles.css:661-662), but an
 * <a> is inline and min-height does not apply to it. This is what makes the two
 * handoff links 44px tall rather than 20. */
.takeaway__row .button { display: inline-flex; align-items: center;
                         justify-content: center; text-decoration: none; }
.takeaway__note  { margin: 0; font-size: var(--t-small); color: var(--ink-2); }
.takeaway__warn  { background: var(--warn-ground); border: 1px solid var(--warn-rule);
                   border-radius: var(--r-sm); color: var(--warn-ink);
                   padding: var(--s3); font-size: var(--t-small);
                   display: flex; flex-direction: column; gap: var(--s2); }
.takeaway__warn[hidden] { display: none; }   /* the flex would beat `hidden` */
.takeaway__warn p { margin: 0; }

.printsheet { display: none; }

/* ------------------------------------------------------------------ print */
/* One sheet: the numbers, the coverage sentence, the barriers, the directions,
 * the provenance block. The map is a WebGL canvas that prints as a grey
 * rectangle at best, so it is dropped — the rail and the detail have always been
 * the full text substitute for it, which is exactly what makes this possible.
 * Everything hidden below is chrome. Nothing hidden below is content. */
@media print {
  :root,
  [data-theme='dark'] {
    color-scheme: light;
    --paper: var(--print-paper);  --raised: var(--print-paper);
    --sunken: var(--print-paper); --rule: var(--print-rule);
    --rule-strong: var(--print-ink);
    --ink: var(--print-ink);      --ink-2: var(--print-ink);
    --warn-ground: var(--print-paper); --warn-rule: var(--print-ink);
    --warn-ink: var(--print-ink);
    --shadow-1: none;             --shadow-2: none;
  }
  @page { margin: 14mm; }

  .topbar, .skip-link, .tripbar, .departure, .stage,
  .takeaway, .panel__spacer, .map__controls, .legend { display: none !important; }

  .app    { height: auto; display: block; }
  .layout { display: block; }
  .panel  { overflow: visible; border-inline-end: 0; padding: 0; }

  .printsheet { display: block; margin-top: var(--s4);
                border-top: 2px solid var(--print-ink); padding-top: var(--s3); }
  .printsheet__h    { font-size: var(--t-micro); text-transform: uppercase;
                      letter-spacing: 0.04em; margin: 0 0 var(--s1); }
  .printsheet__note { margin: 0; font-size: var(--t-small); }
  .printsheet__stamp{ margin: var(--s1) 0 0; font-size: var(--t-micro); }

  /* Backgrounds are not printed by default, so a tinted warning would print as
   * plain text. Weight and a rule carry it instead — the same reason the on-screen
   * warn tier carries a glyph as well as a hue. */
  .note--warn, .banner--warn { border: 2px solid var(--print-ink); font-weight: 600; }
  .route, .note, .detail__section, .step, .printsheet { break-inside: avoid; }
  .verify__seg { box-shadow: inset 0 0 0 1px var(--print-ink); }
  .verify__seg.is-on { background: var(--print-ink); print-color-adjust: exact; }

  a::after { content: ' (' attr(href) ')'; font-size: 9pt; word-break: break-all; }
  .about a::after { content: ''; }   /* the credits paragraph is five links in one sentence */
}
```

Notes on what is deliberately **kept** in print, against launch's block: `.ribbon` (the demonstration-data warning is content, not chrome — `Ribbon.jsx:25`), `.banner--warn`, the whole `.rail`, and the `.about` disclosure (the OSM-tagging caveat and the attributions at `About.jsx:23-47`). Launch hid `.card__more`; there is no equivalent on `main`.

### 2d. Files explicitly NOT edited

`frontend/src/api/mock.js` — do **not** add an `elevation` key. The elevation clause in `provenanceNote` is conditional (`if (route.elevation)`), so it stays dark under `VITE_MOCK_API=1` and lights up for free if the `ElevationProfile.jsx` port lands. `frontend/src/components/About.jsx` — no edit: this capability adds **no** storage key, so the promise at `About.jsx:29-33` ("The only thing kept in this browser is whether you chose the light or the dark theme") stays true verbatim. `frontend/src/a11y.jsx` — no edit; `ROW_SELECTOR` at `:53` is unaffected.

---

## 3. TOKEN MAPPING — every launch token this capability's CSS touches

Sources: `feat/launch:frontend/src/styles.css:1685-1744` (`.takeaway`), `:1746-1824` (print), `:11-104` (the launch `:root`). **None of these launch names may appear in the ported CSS.**

| launch token | value on launch | used at (feat/launch) | use on `main` instead | exact? |
|---|---|---|---|---|
| `--space-2` | 8px | `styles.css:1692, 1703, 1707, 1723, 1740` | `--s2` (8px) | identical |
| `--space-3` | 12px | `:1689, 1707, 1736` | `--s3` (12px) | identical |
| `--space-4` | 16px | (print margins) | `--s4` (16px) | identical |
| `--space-5` | 24px | — | `--s6` (24px) — **not** `--s5`, which is 20px on `main` | value-matched, index shifted |
| `--space-6/7/8` | 32/48/64px | — | `--s7` (32px); **48px and 64px have no equivalent** — the current scale tops out at `--s8: 40px`. Use `--s8` and do not invent a step. | — |
| `--text-1` | 0.875rem (14px, declared "the floor") | `:1697, 1706, 1714, 1720, 1737` | **No exact match.** `--t-small` is 0.8125rem (13px), `--t-body` is 0.9375rem (15px). Body-weight copy (`.takeaway__note`, `.takeaway__warn`, `.takeaway__row .button` inherits) → `--t-small`. | approximate; the 14px floor rule does not exist on `main` |
| `--text-2` | 1rem | — | `--t-body` | approximate |
| `--text-3/4/5/6` | 1.125/1.375/1.75/2.25rem | — | `--t-h3`(1.0625) / `--t-h2`(1.375) / `--t-metric`(1.75) / `--t-display`(2rem) | `--t-h2` and `--t-metric` exact; the other two are near |
| `--ink` | **#14213d** (navy) | `:1726` | `var(--ink)` — **same name, different value** (#16241c dark green, `styles.css:23`; #e8efe8 dark, `:73`). Use the name; **never copy the hex.** This is the single most likely accident in this port. | name survives, value must not |
| `--ink-muted` | #545f71 | `:1715` | `--ink-2` (**renamed**) | renamed |
| `--page` | #f7f4ee | — | `--paper` (**renamed**) | renamed |
| `--recessed` | #f2eee5 | — | `--sunken` (**renamed**) | renamed |
| `--raised` | #fffdf8 | — | `--raised` (same name) | name survives |
| `--rule` | #ddd6c6 | `:1688` | `--rule` (same name) | name survives |
| `--rule-strong` | #c3bdae | — | `--rule-strong` (same name) | name survives |
| `--selected-border` | #8fa0bd | — | **no equivalent.** Selection is `aria-pressed` styling off `--brand` (`styles.css:1010`). Use `--rule-strong` or `--brand`. | — |
| `--warn-ground` | #f3e6de | `:1732` | `--warn-ground` (same name) | name survives |
| `--warn-border` | #cf9f88 | `:1733` | `--warn-rule` (**renamed**) | renamed |
| `--warn-ink` | #8a2c14 | `:1735` | `--warn-ink` (same name and, in light theme, the same value) | name survives |
| `--radius-control` | 6px | `:1734` | `--r-sm` (8px) | near |
| `--radius-card` | 8px | — | `--r-md` (12px) or `--r-sm` (8px) | `--r-sm` is the value match |
| `--radius-chip` | 999px | — | `--r-pill` (999px) | identical |
| `--target` | 44px | `:1722` | `--target` (44px) | identical |
| `--font-body` | IBM Plex Sans stack | `:1696` | `--font-body` (same name, same stack) | identical |
| `--map-casing` | #ffffff | — | **no equivalent and none needed** — export draws nothing on the map. | — |
| `--safe-top/right/bottom/left` | `env(safe-area-inset-*)` | launch print block does not use them | **absent on `main`** (a separate capability). The print block must not reference them. | — |
| launch route palette `--route-fastest #2f6fd0`, `--route-scenic #2e8b57`, `--route-accessible #7a4fc4`, `--route-quiet #b06a1f`, `--route-shade #12756c`, `--route-air #b03050` (`:50-55`) | — | **not used by this capability at all.** Do not import `lib/dash.js`; do not put any colour in the GPX or the GeoJSON. A hex in an exported file would be a fourth copy of the palette (after `styles.css:44-49`, `styles.css:86-91`, `lib/dash.js:24-77`) and there is no gate on it (Survey C §7). | n/a |
| launch `--score-scenic/air/shade` aliases (`:57-59`) | — | not used | **removed on `main`**; score colour is the route colour. | — |
| bare `#fff` / `#000` / `#999` in the launch print block (`:1798, 1804-1806, 1811-1812`) | — | print | **new tokens `--print-paper` / `--print-ink` / `--print-rule`** in the theme-invariant `:root` (Edit 6). Never bare hex. | new |

---

## 4. HOW `provenanceNote` IS EMBEDDED IN EACH FORMAT

One function, one string, four carriers. The invariant an implementer must preserve: **the byte sequence in the GPX `<desc>`, the GeoJSON `note`, the handoff disclosure and the printed sheet is the same string.** Tests in §6 assert this.

### 4a. GPX 1.1 — two `<desc>` elements

```xml
<metadata>
  <name>Meander — Scenic</name>
  <desc>{esc(provenanceNote(route))}</desc>
  <time>{isoTime}</time>
  <copyright author="OpenStreetMap contributors">
    <license>https://opendatacommons.org/licenses/odbl/</license>
  </copyright>
</metadata>
<wpt …>…</wpt>                     ← Start, Destination, one per blocker
<trk>
  <name>{esc(route.label)}</name>
  <desc>{esc(provenanceNote(route))}</desc>   ← the same string, again
  <trkseg><trkpt lat="…" lon="…"></trkpt>…</trkseg>
</trk>
```

- **Twice, on purpose.** Garmin Connect reads `trk/desc`; Strava and several viewers read `metadata/desc`; some read neither and show only `name`. Duplicating costs ~400 bytes and removes the "whichever one this consumer happens to read" failure. Element order is GPX 1.1 schema order (`metadata`, `wpt*`, `rte*`, `trk*`) — do not move the waypoints below the track.
- **`<trk>`, never `<rte>`.** `<rte>` means "navigate via these waypoints" and every consumer re-derives its own path from them — which silently discards the accessibility steering that is the whole point. `<trk>` is the literal line. There is a test asserting the string `<rte` never appears.
- **No `<ele>`.** Verified against the current backend, and launch's reasoning at `export.js:66-75` is correct: `Route.geometry` is declared `list[list[float]]  # [[lon, lat], ...]` at `backend/models.py:147`, and `from_post_point` at `backend/routing.py:149-151` drops GraphHopper's third ordinate on the way in. Per-vertex elevation is **not on the wire**. `route.elevation` is a *separately resampled and thinned* profile (`backend/elevation.py:36 MAX_PROFILE_POINTS = 120`, `_thin` at `:55-60`) with its own distance grid, so attaching one of its samples to a trackpoint would invent an elevation for a coordinate that does not have one — and the consumer would then compute a climb figure and present it as measured. The climb goes in the description instead, attributed.
- **Barriers are `<wpt>`, not just prose** (`export.js:83-101`). On a watch with no screen for the card they are the only surviving warning. Add a `<desc>` to each barrier waypoint carrying `blockerTypeName(b.type)` — launch put the type nowhere, losing it on export.
- Every interpolated value goes through `esc()` (`export.js:17-18`) against `& < > " '`.

### 4b. GeoJSON — `properties.note` on **every** feature

```json
{ "type": "FeatureCollection", "features": [
  { "type": "Feature",
    "geometry": { "type": "LineString", "coordinates": [...] },
    "properties": {
      "name": …, "id": …, "duration_min": …, "distance_m": …, "mode": …, "status": …,
      "scoring_method": …,
      "synthetic_upstream": route.synthetic_upstream ?? false,
      "accessibility_coverage": route.confidence ?? null,
      "enrichment_pending": route.enrichment_pending ?? false,
      "note": "<provenanceNote>",
      "attribution": "Route data © OpenStreetMap contributors, ODbL"
    } },
  { "type": "Feature",
    "geometry": { "type": "Point", "coordinates": [lon, lat] },
    "properties": { "kind": "barrier", "type": …, "description": …,
                    "note": "<provenanceNote>" } }        ← added; see below
]}
```

- Each barrier is its own Point Feature (launch `export.js:152-156`) so a GIS user can style, filter and count them without parsing a description string.
- **Change from launch: the barrier features also carry `note`.** Launch put it only on the LineString. Every GIS tool on earth can select one feature and export it alone, at which point a launch-format barrier point travels with no caveat at all. Same reasoning as the duplicated GPX `<desc>`.
- `accessibility_coverage` is `route.confidence ?? null` — **never `?? 0`**. Launch's `provenanceNote` does coerce to 0 (`export.js:22`); that coercion must not be repeated here or in the note (§5).
- `enrichment_pending` added because a mid-stream export is otherwise indistinguishable from a settled one, and Survey B §4c shows the first-pass route carries `rest_stops: []` and null air/shade while `enrichment_pending` is true.

### 4c. Google / Apple Maps handoff — the URL **cannot** carry it, so the note gates the link

This is the honest answer and it must be written into the code comment, because the naive reading of the brief ("provenanceNote travels with each of the four formats") is impossible here:

1. The two URL schemes have no free-text field. Google's `dir/?api=1` accepts `origin`, `destination`, `waypoints`, `travelmode`; Apple's accepts `saddr`, `daddr`, `dirflg`. Nothing else survives.
2. Even if there were a field, **attaching Meander's provenance to a Google route would itself be a false claim** — Google and Apple re-plan from the endpoints with their own engine. None of Meander's steering survives, including the accessibility constraints; handing the endpoints of a route Meander rejected for steps to Apple Maps hands the steps straight back.

So the embedding is **structural, not textual**: the links do not exist in the DOM until the user opens the disclosure, the disclosure body renders `provenanceNote(route)` verbatim in a `<p id="takeaway-provenance">`, and both `<a>` elements are `aria-describedby="takeaway-warn-title takeaway-provenance"` — so a screen-reader user hears the caveat as part of the link, not as a paragraph they may have skipped. The warning paragraph itself must additionally say what the URL does carry: **the start and end coordinates are sent to Google or Apple**. Launch's warning (`TakeItWithYou.jsx:47-58`) never says this, and it is the only point in the whole app where a coordinate leaves for a third party.

Also required, and already in launch: `target="_blank" rel="noreferrer noopener"`. `noreferrer` matters independently of the `Referrer-Policy: no-referrer` header at `frontend/vercel.json:24`, because the S3/CloudFront deploy path sets no headers at all (Survey C §5).

### 4d. Print sheet — a print-only `.printsheet` section carrying the same string

`RouteDetail` already shows `confidenceSentence(...).text` at `RouteDetail.jsx:163-170`. That is **not** the same string as `provenanceNote`, which additionally carries the demonstration-data line, the barrier count, the climb and the ODbL attribution. Relying on it would mean the printed sheet says less than the GPX of the same route.

So `TakeItWithYou` renders a second `<section className="printsheet">`, `display: none` on screen and `display: block` in `@media print`, containing `provenanceNote(route)` verbatim plus a `Printed from Meander, {isoTime}` stamp. This is what makes the sheet the fourth carrier rather than an approximation of one. It is `aria-hidden="true"` because the same content is already on screen in the disclosure and in the confidence note; adding a third copy to the a11y tree would be noise.

The `beforeprint` hook (§1c change 4) is part of this format, not an extra: without it the sheet loses `StepList`'s directions and `About`'s OSM caveat.

---

## 5. `provenanceNote` — the rewrite (this is the part that is not a copy)

Launch's version (`export.js:21-49`) writes its **own** coverage sentence from `route.confidence`. Keep the shape; replace the coverage clause. In order:

1. `` `Meander ${route.label} route: ${fmtDur(route.duration_min)}, ${fmtDist(route.distance_m)}.` `` — unchanged. Note `fmtDist` is `frontend/src/lib/format.js:51-55` and is metric-only on `main`; if the `lib/units.js` port later lands, `fmtDist` delegates and the export follows the user's preference with **no change here**. That is why export.js imports `fmtDist` and not `formatDistance`.
2. If `route.synthetic_upstream`: `'BUILT FROM DEMONSTRATION DATA, NOT A LIVE ROUTING RESPONSE. Do not follow it.'` — unchanged, uppercase intact.
3. **Replaced.** `confidenceSentence(route.confidence, route.scoring_method, route.confidence_note).text`, verbatim. This is the whole point of the rewrite: it picks up the `scoring_method === 'placeholder'` branch (`format.js:79-84`), the `< 0.3` / `< 0.6` / else tiers (`:86-98`), and — critically — the **server's own wording** when `confidence_note` is present (`format.js:77`), which is what `RouteDetail.jsx:163` renders on screen. After this change the file and the screen say the same sentence by construction.
4. **New.** `SCORING_METHOD_LABEL[route.scoring_method] ?? route.scoring_method` (`format.js:147-151`). A coverage percentage with no statement of *how* it was measured is a number this project does not want quoted.
5. **New.** Rest stops, three-way: `restStopSentence(route.rest_stops)` when non-empty (`format.js:173-187`, currently an unused export — Survey A §1b lists it as free to adopt); `'Rest stops were not checked for this route — that is not the same as there being none.'` when `route.rest_stops == null`; `'No rest stops found along this route.'` when `[]`.
6. **New.** Unmeasured scores named: for each of `scenic`, `air`, `shade` where `route.scores?.[k] === null`, emit `'Scenic, shade: not measured.'` A GPX consumer that sees no mention of shade will assume anything; a file that says "not measured" cannot.
7. `${route.blockers.length} recorded barrier(s) on this route.` when non-empty — unchanged.
8. `${route.steps.length} directions included.` when non-empty — unchanged.
9. Elevation, when `route.elevation` is present — **amended**: `` `Climbs ${Math.round(a)} m, descends ${Math.round(d)} m, steepest ${max}%` `` plus, when `limit_pct` is present, `` ` against a ${limit}% limit` ``. Never hard-code 8. The constant is `MAX_INCLINE_PCT = 8.0` at `backend/accessibility.py:90`, has no JS export and no codegen step, and travels per-route on the wire as `ElevationProfile.limit_pct` (`backend/models.py:116`, set at `backend/elevation.py:124`).
10. `if (route.status !== 'ok')`: the rejection sentence — unchanged.
11. `'Route data © OpenStreetMap contributors, ODbL.'` — unchanged, always last.

Joined with `' '`.

---

## 6. TESTS

**New file: `/Users/poojana/Meander/Meander/frontend/src/lib/export.test.js`.** It joins `sun.test.js` (255) and `follow.test.js` (185) in `frontend/src/lib/`, runs under the existing `npm test` → `vitest run` (`frontend/package.json:13`), which `make check` invokes via `Makefile:53-54` and CI via `.github/workflows/ci.yml:140-144`. Same idiom as `follow.test.js:1` (`import { describe, expect, it } from 'vitest'`).

**Hard constraint the implementer must respect:** `frontend/vite.config.js:20-33` declares `test: { env: { TZ: 'UTC' } }` and **no `environment`**, so vitest runs in Node. There is no `document`, no `URL.createObjectURL`, no `DOMParser`. Adding `jsdom` would be a new devDependency in a project whose only frontend devDeps are `@vitejs/plugin-react`, `axe-core`, `vite`, `vitest` (`package.json:21-26`) — do not. Therefore:
- `download`, `downloadGpx`, `downloadGeoJson` and `TakeItWithYou` are **not unit-tested**; say so in a comment at the top of `download()`.
- Everything else is a pure function and is fully testable. Importing `export.js` must not execute any DOM code — keep `download` a function body, never a module-level statement.
- Well-formedness is checked with a ~15-line stack-based tag scanner defined in the test file, not a parser.
- Pin `now` by passing an explicit `new Date('2026-08-08T09:30:00Z')` to `exportStamp`/`toGpx`; never let a test read the clock.

Fixtures: three route objects at the top of the file, shaped exactly like `frontend/src/api/mock.js:155-178` (`fastest`, well-verified, no blockers), `:180-217` (`scenic`, one blocker, three rest stops), `:221-…` (`accessible`, `status: 'blocked'`, `scores.shade: null`, `scoring_method: 'geometry_only'`), plus two synthetic edge cases: `rest_stops: null`, and `scoring_method: 'placeholder'` with `confidence: 0.9`.

| # | describe / it | asserts |
|---|---|---|
| 1 | `provenanceNote` · contains the confidence sentence verbatim | includes `confidenceSentence(r.confidence, r.scoring_method, r.confidence_note).text` for all three mock routes |
| 2 | · a placeholder-scored route never states a percentage | `scoring_method: 'placeholder', confidence: 0.9` → contains `'has not been evaluated'`, and `expect(note).not.toMatch(/\d+%/)`. **This is the rule-1 regression test**; launch's version emits "covers 90%" here. |
| 3 | · the server's `confidence_note` wins | a route with a bespoke `confidence_note` → that exact string appears and the client-side wording does not |
| 4 | · `null` coverage is not 0% | `confidence: null` → no `'0%'` |
| 5 | · rest stops: three distinct answers | `null` → `'not checked'`; `[]` → `'No rest stops found'`; populated → the count. Three separate `expect`s, and each other's phrasing absent. |
| 6 | · a null score is named | `scores.shade === null` → `'not measured'` and the word `Shade` |
| 7 | · demonstration data is shouted | `synthetic_upstream: true` → contains `'BUILT FROM DEMONSTRATION DATA'` |
| 8 | · a blocked route says so | `status: 'blocked'` → contains `'rejected by the accessibility constraints'` |
| 9 | · elevation quotes the limit from the payload | `elevation: { …, max_gradient_pct: 8.4, limit_pct: 8 }` → contains `'8.4%'` and `'8% limit'`; and with `limit_pct` absent, no bare limit is invented |
| 10 | · ODbL attribution is always last | ends with `'Route data © OpenStreetMap contributors, ODbL.'` for all fixtures |
| 11 | `toGpx` · is a track, not a route | contains `'<trk>'`; `expect(gpx).not.toContain('<rte')` |
| 12 | · carries the note twice, escaped | `gpx.match(/<desc>/g).length === 2`; both bodies equal `esc(provenanceNote(r))` |
| 13 | · escapes XML metacharacters | a blocker description containing `&`, `<`, `"`, `'` → none appear raw; `&amp;`/`&lt;`/`&quot;`/`&apos;` do |
| 14 | · emits no `<ele>` | `expect(gpx).not.toContain('<ele')`, even with `route.elevation` populated |
| 15 | · coordinate order | `lat="…"` equals `geometry[i][1]`, `lon="…"` equals `geometry[i][0]`, to 6 dp |
| 16 | · one waypoint per barrier, plus start and destination | `wpt` count === `blockers.length + 2`; each barrier description present |
| 17 | · well-formed and correctly declared | stack scanner balances; contains `version="1.1"` and `xmlns="http://www.topografix.com/GPX/1/1"`; `<wpt>` precede `<trk>` |
| 18 | `toGeoJson` · parses, and the line is feature 0 | `JSON.parse` → `features[0].geometry.type === 'LineString'` |
| 19 | · each barrier is its own Point feature | `features.length === blockers.length + 1`; every tail feature is `Point` with `properties.kind === 'barrier'` |
| 20 | · the note is on every feature | every `f.properties.note === provenanceNote(r)` |
| 21 | · coverage is null, never 0 | `confidence: null` → `properties.accessibility_coverage === null` |
| 22 | `googleMapsUrl` · caps waypoints and sets travelmode | ≤10 points; `travelmode=bicycling` for `mode: 'bike'`; `walking` for an unknown mode |
| 23 | · returns null below two points | `geometry: [[0,0]]` → `null` |
| 24 | `appleMapsUrl` · endpoints only | exactly `saddr`, `daddr`, `dirflg`; no `waypoints`; `dirflg=w` for `bike` |
| 25 | `sampleWaypoints` · keeps first and last | `length === max`; `at(0)` and `at(-1)` identical to the source ends; a shorter geometry returns unchanged |
| 26 | `exportStamp` · one clock read | given a fixed `now`, `filename` ends with the same date as `isoTime.slice(0,10)`; matches `/^meander-[a-z0-9-]+-\d{4}-\d{2}-\d{2}$/` |

**Two non-vitest gates worth adding in the same change** (both cheap, both catch the class of bug this capability is exposed to):

- Extend `.github/workflows/ci.yml`'s `frontend` job with a grep asserting that `frontend/src/lib/export.js` contains no `#` hex and no `fetch(` — an exported file must carry no colour and this module must make no request.
- Fix the awk in the `no-hard-coded-colour` job first (§7 defect 8), otherwise the new print block is unguarded.

No backend test changes. This capability adds no endpoint and reads no field that is not already on the model.

---

## 7. RULES, AND HOW THE DESIGN SATISFIES EACH

**Rule 1 — a missing OSM tag means UNKNOWN, never "accessible."** `provenanceNote` step 3 delegates to `confidenceSentence`, so the placeholder branch (`format.js:79-84`) and the server's `confidence_note` reach the file; `?? 0` on confidence is removed everywhere (note and GeoJSON); `rest_stops` is answered three ways (`null` / `[]` / populated) per `format.js:133-137`; `scores.x === null` is stated as "not measured" rather than omitted; the route's `label` ("Accessible") is never restated as a verdict — `status` and the confidence sentence are. Tests 2, 4, 5, 6, 21 pin all of it. This is the rule the launch source actually violates (see the corrections below).

**Rule 2 — colour is never the only differentiator; it must survive greyscale.** The exported files carry no colour at all — no `--route-*`, no `lib/dash.js` import, nothing for a consumer to mis-render. On paper: browsers do not print backgrounds by default, so the route swatch (`swatchBackground`, a JS-built gradient) prints blank — and that is fine, because `RouteDetail.jsx:200-202` names the pattern in words ("Drawn as a dashed line"). The verification meter's word and ⚠ glyph (`VerificationMeter.jsx:31-36`) survive; the print block additionally gives `.verify__seg` a 1px ink border so the four segments are countable in monochrome. `.note--warn` loses its tint in print and gains a 2px border and `font-weight: 600` instead. The handoff warning carries `⚠` plus `<strong>` plus a bordered container, not a hue.

**Rule 3 — the route list is a complete text substitute for the map.** This is what makes the print sheet possible at all: `.stage` is dropped in print (a WebGL canvas that prints as a grey rectangle at best), and the rail, the detail, the barriers and the expanded step list carry the whole answer. Everything the print block hides is chrome — trip bar, departure strip, topbar, skip link, map controls, legend, the takeaway buttons themselves. `.ribbon`, `.banner--warn`, `.rail` and `.about` are all kept, because they are content.

**Rule 4 — no location history, no cookies, no analytics; localStorage is theme and units only.** `export.js` touches no storage API of any kind and neither does the component. `download()` builds an in-memory `Blob`, clicks a detached `<a download>`, and revokes the object URL on a 1000 ms timer. No key is added, so `About.jsx:29-33` and `FollowMode.jsx:239-241` stay true without edit. The one place data leaves: the user-clicked handoff URL, which contains the endpoint coordinates — the disclosure says so in words before the link exists in the DOM, nothing is recorded, and no coordinate is ever put in a URL that *this app* fetches.

**Rule 5 — no new third-party runtime requests.** No import, no CDN, no font, no icon set (the ⚠ is a text glyph, matching `TripBar.jsx:16-17`'s inline-SVG-not-icon-font reasoning). The handoff is a user-initiated top-level navigation, not a page request: it is unaffected by `connect-src` in the CSP at `frontend/vercel.json:28`, and `navigate-to` is not in that policy (nor supported by browsers). Two forward-looking notes for whoever hardens the CSP: (a) if `navigate-to` is ever added it must list `https://www.google.com https://maps.apple.com` or the handoff dies silently; (b) `blob:` downloads are not covered by any fetch directive today, but if `object-src`/`navigate-to` are tightened, verify the download still fires. Nothing is preconnected or prefetched.

**Rule 6 — every interactive target ≥ 44×44.** The four `<button>`s and two `<a>`s use `.button`, which sets `min-height: var(--target)` *and* `min-width: var(--target)` at `styles.css:661-662`; `.takeaway__row .button { display: inline-flex }` is what makes `min-height` apply to the two anchors. The disclosure reuses `.link-button` (`styles.css:1351-1365`), already `min-height: var(--target)`; it is a text control whose label is far wider than 44px. Nothing here uses `.preset` or `.theme-toggle`, the two existing 36px violations at `styles.css:406` and `:527`.

**Rule 7 — one live region.** Download confirmations go through the `onAnnounce` prop into App's `announce()` (`App.jsx:198-202`) and the single `role="status"` region at `App.jsx:372-374`, exactly as `FollowMode.jsx:171-178` does. No second live region, no `role="alert"` on the takeaway.

**Rule 8 — do not restructure App.** Two lines added: an import and a prop. No `DEBOUNCE` key, no reducer case, no `nonce`, no touch to `App.jsx:255-258` or the abort ordering at `:211-213`.

**Rule 9 — `RouteRow` may contain only `<span>`.** Not touched. All of this lives in `RouteDetail`.

**Rule 10 — `MapView` stays a single instance and never unmounts.** Not touched; the print block only hides `.stage`, it does not unmount it, so the map is never re-created after a print.

**Rule 11 — `api/mock.js` is the fixture contract.** No new field is invented. `route.mode` (`mock.js:162, 187, 228, 277`) becomes read for the first time; `route.elevation` and `route.enrichment_pending` are read defensively and are absent from the mock, which is left alone.

---

## 8. WHAT THE BRIEF GETS WRONG

Checked against the actual source; each is verifiable at the citation given.

1. **"`lib/export.js` — … a print sheet" (`docs/RELEASE-PROMPT.md:333-334`, restated at `:737`) is wrong.** There is no print code in `feat/launch:frontend/src/lib/export.js` — no `window.print`, no `@media print`, not the word "print" anywhere in its 231 lines. The print sheet is `window.print()` at `TakeItWithYou.jsx:32` plus 78 lines of CSS at `feat/launch:frontend/src/styles.css:1746-1824`. An implementer who restores only `export.js` ships three of four formats and does not notice.
2. **"Keep `provenanceNote`: the accessibility caveat travels with the exported file" (`:335-337`) overstates what the source does.** On `feat/launch`, `provenanceNote` reaches GPX and GeoJSON only. The print sheet embeds it **nowhere** — the print CSS just prints whatever the card rendered. The maps handoff embeds it nowhere and structurally cannot. So the caveat travels with two of the four formats, not four; §4c and §4d are additions, not restorations.
3. **`provenanceNote` does not attach "its confidence sentence" — it attaches a different sentence, and one of its branches is a rule-1 violation.** `feat/launch:frontend/src/lib/export.js:22-31` computes `Math.round((route.confidence ?? 0) * 100)` and writes its own coverage string. It never consults `route.scoring_method`, so a placeholder-scored route exports "Accessibility data covers 90% of this route" while `RouteDetail` shows "Accessibility data has not been evaluated for this route. Nothing here is a measurement." (`format.js:79-84`). It also never consults `route.confidence_note`, so the server's verbatim wording — which `format.js:77` gives priority on screen — is dropped on export. This is exactly the failure the brief invokes the rule against, sitting inside the function the brief says to keep.
4. **`?? 0` turns unknown coverage into "0%".** `export.js:22`. Same class as `null` vs `[]` vs `0` elsewhere in the codebase (`format.js:133-137`).
5. **The brief's Appendix A row 6 has no line count and no path** (`docs/RELEASE-PROMPT.md:737`: `` | 6 | `lib/export.js` | — | ``). Every other row carries one. It is `frontend/src/lib/export.js`, **231 lines**, plus `TakeItWithYou.jsx` at **81** and 78 lines of CSS.
6. **A dating bug in the source.** `safeName` (`export.js:53-54`) and `toGpx` (`:113`) each call `new Date()` independently, so a download at 23:59:59.9 UTC can produce a filename dated one day and a `<metadata><time>` dated the next. The date is also UTC, so a user in Colombo downloading at 02:00 local gets yesterday. `exportStamp(route, now)` fixes both.
7. **Two comments in the source are imprecise, though their conclusions hold.** (a) `export.js:67-69` describes the elevation profile as "120 points at 20 m spacing" — 20 m is the pre-thinning grid (`INCLINE_SMOOTHING_WINDOW_M = 20.0`, `backend/accessibility.py:93`); `_thin` (`backend/elevation.py:55-60`) caps at `MAX_PROFILE_POINTS = 120`, so spacing grows beyond 20 m on any route longer than ~2.4 km. The conclusion — no honest per-vertex `<ele>` — is **correct**, and I verified it independently: `backend/models.py:147` declares geometry as `[[lon, lat], ...]` and `backend/routing.py:149-151` drops the third ordinate. (b) `export.js:191-193` says Apple's waypoints are "sampled … Apple lower"; `appleMapsUrl` calls `sampleWaypoints(route.geometry, 2)`, which is not sampling — Apple's scheme has no via-point parameter at all and the entire shape is discarded.
8. **Bonus, and it invalidates a gate the brief treats as working.** The `no-hard-coded-colour` job at `.github/workflows/ci.yml:158-170` matches `/#[0-9a-fA-F]{3,8}\b/`. **POSIX ERE has no `\b`** — awk implementations read it as a literal backspace (`\x08`), so the pattern requires a backspace after the hex and never matches. I proved this locally: `awk '/#[0-9a-fA-F]{3,8}\b/ {print}'` over a file containing `color: #fff;` prints nothing, and the same pattern without `\b` matches. I then appended launch's exact print block (`#fff`, `#000`, `#999`) to a copy of the current `styles.css` and ran the workflow's awk verbatim — **zero offenders reported**. The gate is vacuous, and the check the brief and `Makefile:74` both lean on would not have caught this port's most likely mistake. Fix: drop `\b`, or use `([^0-9a-fA-F]|$)`. (Verified on macOS BWK awk 20200816; gawk and mawk also treat `\b` as backspace — gawk spells the word boundary `\y` — so the runner behaviour should be confirmed, but the fix is a one-character edit either way.)

### Risks and the rules that constrain it

**What could break.**

1. *Silent token contamination.* `--ink` exists on both branches with different values (#14213d navy on launch, #16241c dark green on `main`, `styles.css:23`). A copy-paste that brings the hex rather than the name reintroduces the launch palette invisibly in light mode and breaks dark mode. `--warn-border` → `--warn-rule`, `--ink-muted` → `--ink-2`, `--page` → `--paper`, `--recessed` → `--sunken`, `--radius-control` → `--r-sm`, and the whole `--space-*`/`--text-*` families must be rewritten, not aliased. Aliasing (`--space-2: var(--s2)`) is forbidden: it reintroduces the vocabulary the merge deleted.

2. *The colour gate will not catch a hex here.* `.github/workflows/ci.yml:158-170` is vacuous (`\b` in an awk ERE — proven, see plan §8.8). Launch's print block ships three bare hexes; if they are pasted in, nothing fails. Fix the awk in the same change or the print block is unguarded.

3. *`display: flex` beats `hidden`.* `.takeaway__warn` is a flex column; without `.takeaway__warn[hidden] { display: none }` the disclosure never closes. Same trap `TripDrawer`/`styles.css:512` already handles for `.drawer`.

4. *`min-height` does not apply to an inline `<a>`.* The two handoff links are `<a className="button">`; without `display: inline-flex` they render ~20px tall and silently break the 44×44 rule that `.button` appears to guarantee. Launch hit this and fixed it at `feat/launch:frontend/src/styles.css:1705-1711`.

5. *Print regression on `<details>`.* Launch's `.card__detail[hidden] { display: flex !important }` does not port — on `main` the collapsed content is `<details>` (`StepList.jsx:86`, `About.jsx:17`), which CSS cannot force open. Without the `beforeprint` hook the printed sheet has no directions and no OSM caveat, and the failure is invisible until someone actually prints.

6. *Dark theme printing.* `[data-theme='dark']` is stamped on `<html>` by `frontend/index.html:39` and stays set while printing. Every existing rule resolves `var(--ink)` to `#e8efe8`. The print block **must** re-map the tokens under both `:root` and `[data-theme='dark']`, or a dark-theme user prints near-white ink on white paper.

7. *Tests cannot touch the DOM.* `frontend/vite.config.js:20-33` sets no `environment`, so vitest runs in Node: no `document`, no `URL.createObjectURL`, no `DOMParser`. If `download()` ever moves to module scope, importing `export.js` in the test crashes the suite. Adding `jsdom` to fix it would add a devDependency to a four-devDep project (`package.json:21-26`) — don't.

8. *`route.mode` becomes load-bearing for the first time.* Survey B lists `Route.mode` (`backend/models.py:150`) as UNREACHABLE; `googleMapsUrl` reads it. It is present on the wire and in every mock route (`mock.js:162, 187, 228, 277`), and the `?? 'walking'` fallback covers the rest. But it is now a field a backend change could break without any existing test noticing.

9. *Exporting a mid-stream route.* Survey B §4c: during enrichment a route arrives with `enrichment_pending: true`, `rest_stops: []` and null air/shade. A user who exports in that window gets a file saying "No rest stops found along this route" — the exact false claim `backend/models.py:176-184` was written to prevent, now baked into a file that outlives the session. `provenanceNote` step 5 must key on `enrichment_pending` as well as on `null`, and the GeoJSON carries the flag. (The underlying UI defect is out of scope for this capability but shares the fix.)

10. *A route with fewer than two geometry points.* Blocked routes still carry geometry, but guard anyway: GPX/GeoJSON buttons gated on `geometry.length >= 2`, handoff on `googleMapsUrl(route) !== null` (which returns `null` below two points), print always available.

**Project rules that constrain this and are enumerated with their satisfaction in plan §7:** UNKNOWN-never-accessible (rule 1, the reason `provenanceNote` is rewritten rather than copied); greyscale survivability; the route list as a complete text substitute for the map; no location history / no cookies / no analytics / localStorage = theme + units only; no new third-party runtime requests; 44×44 targets; the single live region (`App.jsx:372-374`); do-not-restructure-App; `RouteRow` spans-only; `MapView` single instance; `api/mock.js` as the fixture contract.

**Explicitly out of scope, do not entangle:** `lib/units.js` + `UnitsControl` (export imports `fmtDist` from `format.js`, so it inherits units for free if that port lands), `lib/permalink.js` + `ShareButton` (the "No Share" prohibition at `RouteDetail.jsx:177-180` stays in force — it is amended, not lifted), `ElevationProfile.jsx` (the elevation clause is conditional and dark until it lands), `sw.js`/offline, and `public/` icons.

### Tests

**New file — `/Users/poojana/Meander/Meander/frontend/src/lib/export.test.js`**, alongside `sun.test.js` (255) and `follow.test.js` (185). Picked up by `npm test` → `vitest run` (`frontend/package.json:13`), which `make check` runs at `Makefile:53-54` and CI runs at `.github/workflows/ci.yml:140-144`. Idiom copied from `follow.test.js:1`: `import { describe, expect, it } from 'vitest'`.

Environment constraint: `frontend/vite.config.js:20-33` declares only `test: { env: { TZ: 'UTC' } }` — no `environment`, so this runs in Node. No `document`, no `URL.createObjectURL`, no `DOMParser`. Do **not** add jsdom. Consequences: `download`, `downloadGpx`, `downloadGeoJson` and `TakeItWithYou.jsx` are untested by design (note it in a comment above `download()`); GPX well-formedness is checked with a ~15-line stack-based tag scanner defined inside the test file; `now` is always injected (`new Date('2026-08-08T09:30:00Z')`), never read from the clock.

Fixtures at the top of the file, shaped from `frontend/src/api/mock.js`: `fastest` (`mock.js:155-178`, confidence 0.88, no blockers), `scenic` (`:180-217`, one blocker, three rest stops), `accessible` (`:221-…`, `status: 'blocked'`, `scores.shade: null`, `scoring_method: 'geometry_only'`), plus `placeholderRoute` (`scoring_method: 'placeholder'`, `confidence: 0.9`), `unknownRoute` (`confidence: null`, `rest_stops: null`), and `elevated` (`elevation: { ascent_m: 66.2, descent_m: 68.7, max_gradient_pct: 8.4, steep_spans: [[42,48]], limit_pct: 8 }`).

**`describe('provenanceNote')`** — 10 tests
1. contains `confidenceSentence(r.confidence, r.scoring_method, r.confidence_note).text` verbatim, for all three mock routes.
2. **the rule-1 regression:** `placeholderRoute` → contains `'has not been evaluated'` and `expect(note).not.toMatch(/\d+%/)`. Launch's version emits "covers 90%" here.
3. a bespoke `confidence_note` appears verbatim and the client-side wording does not.
4. `confidence: null` → the string contains no `'0%'`.
5. rest stops, three answers, three assertions: `null` → `'not checked'`; `[]` → `'No rest stops found'`; populated → the count — and each other's phrasing absent.
6. `scores.shade === null` → contains `'Shade'` and `'not measured'`.
7. `synthetic_upstream: true` → contains `'BUILT FROM DEMONSTRATION DATA'`.
8. `status: 'blocked'` → contains `'rejected by the accessibility constraints'`.
9. `elevated` → contains `'8.4%'` **and** `'8% limit'`; with `limit_pct` deleted, no limit figure is invented (guards the "never hard-code 8" rule — `MAX_INCLINE_PCT` lives at `backend/accessibility.py:90` with no JS export).
10. always ends with `'Route data © OpenStreetMap contributors, ODbL.'`

**`describe('toGpx')`** — 7 tests
11. `expect(gpx).toContain('<trk>')` and `expect(gpx).not.toContain('<rte')`.
12. `gpx.match(/<desc>/g).length === 2`, and both bodies equal the XML-escaped `provenanceNote(r)`.
13. a blocker description containing `& < > " '` → no raw metacharacter survives; `&amp; &lt; &gt; &quot; &apos;` all present.
14. `expect(gpx).not.toContain('<ele')`, asserted **with** `route.elevation` populated.
15. coordinate order: for each trackpoint, `lat` = `geometry[i][1]` and `lon` = `geometry[i][0]` to 6 dp.
16. waypoint count === `blockers.length + 2` (Start, Destination, one per barrier); each barrier description and type present.
17. well-formed (stack scanner balances), declares `version="1.1"` and `xmlns="http://www.topografix.com/GPX/1/1"`, and every `<wpt>` precedes `<trk>` (GPX 1.1 schema order).

**`describe('toGeoJson')`** — 4 tests
18. `JSON.parse` succeeds; `features[0].geometry.type === 'LineString'`.
19. `features.length === blockers.length + 1`; every tail feature is a `Point` with `properties.kind === 'barrier'`.
20. **every** feature carries `properties.note === provenanceNote(r)` — including the barrier points, which launch left bare.
21. `confidence: null` → `properties.accessibility_coverage === null`, not `0`.

**`describe('googleMapsUrl' / 'appleMapsUrl' / 'sampleWaypoints' / 'exportStamp')`** — 5 tests
22. Google: ≤10 coordinate pairs total; `travelmode=bicycling` for `mode: 'bike'`; `walking` for an unrecognised mode.
23. Google: `geometry: [[0,0]]` → `null`.
24. Apple: parameter set is exactly `saddr`, `daddr`, `dirflg`; no `waypoints`; `dirflg=w` for `bike`.
25. `sampleWaypoints`: `length === max`, first and last identical to the source ends, a geometry shorter than `max` returned unchanged.
26. `exportStamp`: with a fixed `now`, `filename` matches `/^meander-[a-z0-9-]+-\d{4}-\d{2}-\d{2}$/` and its date equals `isoTime.slice(0, 10)` — the single-clock-read guarantee.

**26 tests, all pure, all in Node.**

**Two CI additions in the same change** (neither is a vitest test):
- In `.github/workflows/ci.yml`'s `frontend` job (`:123-147`), a grep asserting `frontend/src/lib/export.js` contains no `#` hex literal and no `fetch(` — an exported file must carry no colour, and this module must make no network request. These are the two invariants the unit tests cannot express.
- **Fix `.github/workflows/ci.yml:161`** first: `/#[0-9a-fA-F]{3,8}\b/` → `/#[0-9a-fA-F][0-9a-fA-F][0-9a-fA-F]/`. Proven vacuous (plan §8.8); until it is fixed the new `@media print` block has no colour gate at all.

**No backend test changes.** This capability adds no endpoint and reads no field not already on `backend/models.py`.

---

## frontend/scripts/gate.mjs — a headless-Chrome layout/accessibility gate, rewritten (not ported) against the redesign component tree, with a selector manifest that makes vacuous passes impossible; plus wiring axe-core into something automated, rewriting check-palette.mjs so the CSS↔dash.js route palette can no longer drift, and correcting the three false gate claims at .github/workflows/deploy.yml:54-55.

**OPEN**

### Sources read on `feat/launch`
- git show feat/launch:frontend/scripts/gate.mjs — 254 lines (read in full)
- git show feat/launch:frontend/scripts/pwa-gate.mjs — 544 lines (read in full)
- git show feat/launch:frontend/scripts/check-palette.mjs — 72 lines (read in full)
- git show feat/launch:frontend/scripts/make-icons.mjs — 215 lines (line count + header only; icon generation is Phase 3-5, not this capability)
- git show feat/launch:frontend/scripts/check-permalink.mjs — 131 lines (line count only; subject src/lib/permalink.js does not exist on main)
- git show feat/launch:frontend/scripts/check-offline.mjs — 174 lines (line count only; subject src/lib/offline.js does not exist on main)
- git show feat/launch:frontend/vite.config.js — 134 lines (read the meanderServiceWorker plugin tail + API_PROXY + preview/devHttps block)
- git show feat/launch:frontend/package.json — 27 lines (read in full; scripts block is the precedent for build-chaining)
- git show feat/launch:frontend/src/styles.css — token block, lines 1-90 and the dark block at 118-148 (read for the token mapping table)
- git ls-tree -r feat/launch --name-only -- frontend — 62 paths, used to prove which pwa-gate subjects are absent from main

### Plan

've# INTEGRATION SPEC — frontend/scripts/gate.mjs (rewrite), axe wiring, palette gate, deploy.yml truth

Tree state as read: `/Users/poojana/Meander/Meander`, branch `main`, HEAD **8644ff2** (survey B/C were written against 46d4772; `git diff 46d4772..HEAD -- frontend/src` is empty so all `frontend/` anchors survive, but **`Makefile` and `.github/workflows/ci.yml` have both changed** — see "BRIEF/SURVEY ERRORS" §E1). No file was edited by me.

---

## 0. WHAT THE BRIEF AND SURVEYS GOT WRONG (checked, not assumed)

**E1 — Survey C's Makefile and ci.yml anchors are stale, and the two facts it draws from them are now false.**
Commit `1749aa0 build(make): run the three gates that only ever ran in CI` landed after Survey C. Current reality:
- `Makefile` is **157 lines**, not 112. `check:` is at **`Makefile:112`** and already reads `lint dupes coverage test-frontend build colour infra-lint torch-free test-sandboxed`. Survey C's "three checks in CI but not `make check`" is **fixed**; `Makefile:74`'s "the whole of CI now" claim it called false no longer exists (the honest replacement is `Makefile:113-119`).
- `ci.yml` is **176 lines**, not 188. The inline awk at "ci.yml:149-170" is gone — `ci.yml:149-158` now runs `bash scripts/check_palette.sh` (a real file, 36 lines, repo-root `scripts/`, also wired as `Makefile:67-68 colour`). Do not re-extract it.
- The `frontend` job is **`ci.yml:123-147`**, and `no-hard-coded-colour` is **`ci.yml:149`**, `infrastructure` **`ci.yml:160`**.

**E2 — The brief says "half its checks would find zero elements and pass vacuously". The real number is 4 of 14, and one of them is worse than the brief says: it is hard-coded.**
`gate.mjs:145-148` is literally `check('[${label}] theme applied', true, …)` — the pass value is the constant `true`. It cannot fail under any DOM, any theme, any viewport. That is 2 of the 14 (once per theme). The other 2 vacuous passes are `[light|dark] the page itself does not scroll` (`gate.mjs:158-162`): when `rows.length === 0` the evaluator early-returns `{ n: 0 }` (`gate.mjs:151`), so `above.scroll` is `undefined`, `?? 0` makes it `0`, and `0 <= 1` passes. Precise ledger against the current DOM: **4 vacuous PASS, 4 hard FAIL** (route-visibility ×2 at `:159`, desktop sheet `:236`, desktop cards `:241`), **4 real** (320px overflow ×2, axe ×2), **2 real-but-poisoned** (44×44 ×2 — the `.footer` exemption at `gate.mjs:195` matches nothing on main, so the WCAG-2.2-exempt inline prose links in `About.jsx:43-46` get reported as offenders).

**E3 — "the page itself does not scroll at 390×844" is not merely mis-selectored; it contradicts the shipped design.** `styles.css:1417-1420` sets `.app { height: auto; min-height: 100dvh }` below 899px and `styles.css:1429-1430` sets `.panel { overflow-y: visible }`, with the reason written out at `styles.css:1411-1416`: below the breakpoint the page scrolls as one document by design. Restoring that check with a working selector would fail correctly-built code. It must be **re-specified**, not re-selectored. Same for "every route is visible without scrolling" — that was a bottom-sheet contract.

**E4 — "bring `pwa-gate.mjs` back for the web release … the service worker is real here" is false.** `frontend/sw.js` does not exist on `main`; `git ls-tree -r main -- frontend` has no `sw.js`, no `public/`, no `src/lib/offline.js`, `offlineStore.js`, `pwa.js`, or `permalink.js`, and `frontend/vite.config.js` (35 lines) has no `meanderServiceWorker()` plugin — that plugin lives only at `feat/launch:frontend/vite.config.js`. Nothing emits a worker, so `pwa-gate.mjs` would fail at its own precondition (`pwa-gate.mjs:329-331`, `if (!existsSync(join(root,'dist','sw.js'))) throw`) before check one. Worse, restoring it as written would **violate a project rule**: `pwa-gate.mjs:255` asserts `localStorage.getItem('meander.offline')`, a second storage key, and localStorage here is theme and units ONLY. See §6 for the honest disposition.

**E5 — `axe-core` "is a devDependency nothing runs" is false as worded, true in substance.** It has a real source consumer at `frontend/src/a11y.jsx:12` (`import axe from 'axe-core'`, called at `:85` and `:88`). What is true is that nothing automated invokes it: zero hits for `a11y` across `.github/workflows/*.yml`, `Makefile`, and `frontend/package.json`. Do not `npm uninstall axe-core` — you would break a checked-in module.

**E6 — `check-palette.mjs` cannot be restored, and Survey C's diagnosis is confirmed by reading the source.** `feat/launch:frontend/scripts/check-palette.mjs:24` splits on the literal `'@media (prefers-color-scheme: dark)'` — that string does not appear in `main`'s `styles.css` (the redesign themes on `[data-theme='dark']`, `styles.css:66`), so `lightBlock` becomes the whole file and last-match-wins captures the *dark* palette as the light one. `:31` looks for `'const FALLBACK_COLORS = {'`; `dash.js:73` says `const FALLBACK = {` and is a single style object, not a colour map. Twelve spurious failures. Rewrite required.

**E7 — one thing the brief did not say, and it is the most valuable finding here.** `frontend/src/lib/dash.js` carries **14 hard-coded hexes** (`:24-25, :32-33, :40-41, :48-49, :56-57, :64-65, :76-77`) that duplicate `styles.css:44-49` / `:86-91`, and **nothing gates them**. `scripts/check_palette.sh` reads only `styles.css`, so CSS↔JS drift is currently ungated — the exact bug `check-palette.mjs` existed to prevent. And the last pair is not a route colour at all: `dash.js:76-77` `#55645A`/`#9BAEA1` are byte-identical to `--ink-2` at `styles.css:24` / `:73`. The rewritten gate closes all 14.

**E8 — the brief's target-size premise needs a caveat before the gate is written.** Two rules already violate the 44×44 floor: `.theme-toggle { min-height: 36px }` (`styles.css:406`) and `.preset { min-height: 36px }` (`styles.css:527`, rendered by `TimeDial.jsx:73-87` and `FirstRun.jsx:60-86`, i.e. on the first-run path). A correct gate lands **red on its first run**. Fix the CSS in the same change (§4.6) — a gate that ships red gets skipped, which is the same failure mode as a gate that cannot fail.

---

## 1. NEW FILES

### 1.1 `frontend/scripts/selectors.mjs` (~120 lines) — the anti-vacuity mechanism

The single manifest of every selector any harness uses. Nothing else may hard-code a selector. Shape:

```js
export const PHASES = { FIRST_RUN: 'firstRun', ROUTES: 'routes' }

export const SELECTORS = {
  // key            css                                         min  phase          source (current tree)
  app:            { css: '.app',                                min: 1,                  src: 'src/App.jsx:366' },
  skipLink:       { css: 'a.skip-link[href="#results"]',        min: 1,                  src: 'src/App.jsx:367' },
  liveRegion:     { css: 'p[role="status"][aria-live="polite"]',min: 1,                  src: 'src/App.jsx:372' },
  topbar:         { css: 'header.topbar',                       min: 1,                  src: 'src/components/Topbar.jsx:18' },
  themeToggle:    { css: 'button.theme-toggle',                 min: 1,                  src: 'src/components/ThemeToggle.jsx:20' },
  aboutButton:    { css: '.topbar__actions button.icon-button', min: 1,                  src: 'src/components/Topbar.jsx:26' },
  about:          { css: 'details.about > summary.about__summary', min: 1,               src: 'src/components/About.jsx:17-18' },
  firstRunCard:   { css: '.firstrun__card',                     min: 1, phase: 'firstRun', src: 'src/components/FirstRun.jsx:23' },
  combobox:       { css: 'input[role="combobox"]',              min: 1,                  src: 'src/components/PlaceInput.jsx:114-117' },
  option:         { css: 'li.suggestions__item[role="option"]', min: 1, transient: true, src: 'src/components/PlaceInput.jsx:132-137' },
  layout:         { css: '.layout',                             min: 1, phase: 'routes', src: 'src/App.jsx:391' },
  panel:          { css: 'main.panel',                          min: 1, phase: 'routes', src: 'src/App.jsx:392' },
  stage:          { css: '.stage',                              min: 1, phase: 'routes', src: 'src/App.jsx:465' },
  tripbar:        { css: '.tripbar',                            min: 1, phase: 'routes', src: 'src/components/TripBar.jsx:124' },
  segment:        { css: '.tripbar__grid button.seg',           min: 4, phase: 'routes', src: 'src/components/TripBar.jsx:127-130' },
  drawer:         { css: '.drawer[role="group"]',               min: 4, phase: 'routes', src: 'src/components/TripDrawer.jsx:14-20' },
  results:        { css: '#results',                            min: 1, phase: 'routes', src: 'src/App.jsx:419' },
  rail:           { css: 'ul.rail',                             min: 1, phase: 'routes', src: 'src/components/RouteRail.jsx:44' },
  row:            { css: 'button.route',                        min: 3, phase: 'routes', src: 'src/components/RouteRow.jsx:51-53' },
  rowSub:         { css: 'button.route .route__sub',            min: 3, phase: 'routes', src: 'src/components/RouteRow.jsx:76' },
  rowScores:      { css: 'button.route .route__scores .score',  min: 9, phase: 'routes', src: 'src/components/RouteRow.jsx:97-126' },
  rowVerify:      { css: 'button.route .verify',                min: 3, phase: 'routes', src: 'src/components/VerificationMeter.jsx' },
  skeleton:       { css: 'div.route--skeleton',                 min: 0, mustBeZeroIn: 'routes', src: 'src/components/RouteRail.jsx:9' },
  detail:         { css: 'article.detail',                      min: 1, phase: 'routes', src: 'src/components/RouteDetail.jsx:70' },
  steps:          { css: 'details.steps > summary.steps__summary', min: 1, phase: 'routes', src: 'src/components/StepList.jsx:86-89' },
  map:            { css: 'section.map',                         min: 1, phase: 'routes', src: 'src/components/MapView.jsx:556' },
  mapCtrl:        { css: '.map__controls button.map__ctrl',     min: 3, phase: 'routes', src: 'src/components/MapView.jsx:597-609' },
  legendRow:      { css: '.legend .legend__row',                min: 3, phase: 'routes', wideOnly: 900, src: 'src/components/MapView.jsx:576' },
  departureHour:  { css: '.departure__hours button.hour',       min: 6, phase: 'routes', src: 'src/components/DepartureStrip.jsx:57-79' },
}

/** WCAG 2.2 SC 2.5.8 "inline" exception — the ONLY target-size exemption on this tree.
 *  styles.css:389-391 states the reason at the rule itself. `.footer` (feat/launch) has no successor. */
export const TARGET_EXEMPT = ['.about__body']

/** Everything the 44x44 sweep considers a target. */
export const TARGET_SELECTOR =
  'button:not([disabled]), a[href], input:not([type="hidden"]), select, textarea, summary, ' +
  '[role="option"], [role="button"], [tabindex]:not([tabindex="-1"])'
```

Two consumers, so a rename cannot silently un-gate anything:
- the gate calls `assertManifest()` at runtime (§1.4 check B) — a manifest entry that matches fewer than `min` aborts the whole run with **exit 3**, printing the `src` anchor. `min: 0` entries are checked only for `mustBeZeroIn`.
- `frontend/scripts/selectors.test.mjs` (§5.1) proves statically, under `npm test`, that every class/attribute token in every entry appears literally in the file its `src` names. That runs without Chrome, in CI today, on every push.

`wideOnly: 900` marks entries that legitimately vanish below the breakpoint (`.legend { display: none }`, `styles.css:1444-1446`) so their absence at 390px is expected, not a silent miss. `transient: true` marks entries that only exist mid-interaction (the suggestion listbox unmounts on pick, `PlaceInput.jsx:129`) and are asserted by `driveToRoutes()` at the moment it depends on them, not by the standing sweep.

### 1.2 `frontend/scripts/cdp.mjs` (~140 lines) — the CDP client, extracted once

`gate.mjs:26-83` and `pwa-gate.mjs:99-160` are the same ~60 lines of WebSocket/CDP plumbing, duplicated. Extract verbatim in behaviour, add Chrome launching:

- `connect(cdpUrl)`, `send(method, params)`, `evaluate(expr, awaitPromise)`, `setViewport(w, h, {dark})`, `navigate(url)`, `disconnect()` — lifted from `gate.mjs:34-83`.
- **`launchChrome()` — new, and it is why the launch gate never ran.** `gate.mjs:21` requires a Chrome already listening on `:9222`, hand-started, undocumented in any script or Makefile target. Resolve a binary from `$CHROME_PATH`, then `google-chrome`, `google-chrome-stable`, `chromium`, `chromium-browser`, then `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome` (verified present on this machine; `google-chrome` is preinstalled on `ubuntu-latest`). Spawn `--headless=new --remote-debugging-port=<port> --no-first-run --no-default-browser-check --disable-gpu --user-data-dir=<mkdtemp>`. Return `{ stop }`.
  - **Never pass `--hide-scrollbars`.** Check D measures `document.documentElement.scrollWidth` against `window.innerWidth`; hiding scrollbars changes that measurement.
  - `--no-sandbox` **only** when `process.env.CI` is set (containers need it; a developer machine should not run Chrome unsandboxed).
  - Optional `--host-resolver-rules="MAP tiles.openfreemap.org ~NOTFOUND"` behind `--no-tiles` (§1.4 "Hermeticity").
  - Adopt `pwa-gate.mjs:47-70`'s lesson verbatim: **detached process group + `process.kill(-pid)`**. Its comment explains that `npx vite` forks and killing the parent leaves the child holding the port. The same is true of Chrome's zygote.
- `withTimeout(promise, ms, label)` — the launch scripts have no timeouts on `evaluate`, so a hung page hangs the harness with no message.

### 1.3 `frontend/scripts/harness.mjs` (~180 lines) — app driving and result accounting

- `startMockServer({port})` — spawns `node_modules/.bin/vite --port <port> --strictPort` with `VITE_MOCK_API=1`, detached, polls `GET /` until 200. Direct binary, not `npx` (`pwa-gate.mjs:52-56`). **Mock, not the real backend, and that is the point**: `src/api/mock.js:299-327` is deterministic (four progress stages at 550 ms, three routes at 420 ms, a 700 ms narration pass — ~4.2 s), needs no Python, no fixtures, no `data/cache.db`, and `mock.js:331-339` supplies `Colombo Fort, Colombo, Sri Lanka` for the geocode. A `--base <url>` flag points the gate at an already-running server instead.
- `check(name, pass, detail)` and `results[]` — from `gate.mjs:124-128`, unchanged.
- **`expect(page, key, {phase, viewportWidth})`** — resolves a manifest key, counts matches, throws `VacuousGate` if below `min`. Every check that touches the DOM goes through this first. This is the "assert its selectors match something before asserting anything about them" requirement, made structural rather than remembered.
- `driveToRoutes(page)` — the rewrite of `gate.mjs:88-121`. Step by step against the real tree:
  1. **Do not click `.topbar__origin`** (`gate.mjs:92`) — no such element; `Topbar.jsx:18-32` renders only wordmark, tagline, `ThemeToggle`, `.icon-button`. There is nothing to open: on first load `App.jsx:352` puts the app in the first-run state and `FirstRun.jsx:43-49` renders a `PlaceInput` directly on screen. Assert `firstRunCard` matched, then find `combobox`.
  2. Set the value with the native setter + `input` event, exactly as `gate.mjs:95-97` (React's controlled input needs the prototype setter). Text: `'Colombo Fort'`.
  3. Poll for `option` (max 60 × 120 ms). `PlaceInput.jsx:5,47` debounces 300 ms and `mock.js:342` sleeps 220 ms.
  4. **Dispatch `mousedown`, not `click`** — `PlaceInput.jsx:138-143` is `onMouseDown` with an explicit comment that blur would close the list before a click landed. `gate.mjs:101` already does this; keep it.
  5. **Delete the `.controls-sheet__bar .button` "done" step** (`gate.mjs:104-106`). `ControlsSheet.jsx` was one of the 37 files the merge dropped; the compound selector returns `[]` and `.pop()` is `undefined`, so the step is dead code that reads like a step.
  6. Wait for the stream to **settle, not to start** — keep `gate.mjs:108-118`'s stable-count loop (its comment is right: measuring against a partial set is exactly the flattering measurement the harness exists to stop). Selector becomes `SELECTORS.row.css` (`button.route`). **`button.route`, not `.route`** — `RouteRail.jsx:9` puts `.route.route--skeleton` on a `<div>`, and `a11y.jsx:50-52` records that the loose selector was satisfied by three placeholders and audited a half-streamed result. Then additionally assert `skeleton` count is 0 (`mustBeZeroIn: 'routes'`), which the launch gate could not do at all.
  7. Return `{ rows, elapsedMs, mapState }` where `mapState ∈ {ready, fallback, pending}` — `'ready'` if `section.map canvas` exists, `'fallback'` if `.map__fallback` (`MapView.jsx:560`), else `'pending'`.

### 1.4 `frontend/scripts/gate.mjs` (~300 lines) — the rewrite

Header comment must state the score change and why, because 14/14 is a number people quote:

> This replaces a 254-line harness that scored 14/14 against a bottom-sheet layout. Four of those fourteen could not fail — two were `check(name, true)` literals (`feat/launch:gate.mjs:145-148`) and two passed on `undefined ?? 0` when their selector matched nothing (`:151`, `:158-162`). Four more measured `.row__button` / `.card` / `.sheet` / `.sheet__handle`, none of which exist. The number is now 26 and it is not comparable to 14.

**Run matrix — 4 passes:** `(390×844, light)`, `(390×844, dark)`, `(1280×800, light)`, `(1280×800, dark)`. Both themes at both widths, which is exactly the definition-of-done line at `docs/RELEASE-PROMPT.md:714`.

Theme emulation: `Emulation.setEmulatedMedia` **before** `Page.navigate` (as `gate.mjs:70-83`/`:137-138` already sequence it), and additionally clear `localStorage` between passes — `index.html:25-42` reads `meander:theme` *first* and only falls back to the media query, so a pass that toggled the theme would poison the next one. `App.jsx:280-289` follows the system only while `readStoredTheme()` is null, so a clean storage is required for the emulation to mean anything.

**Six checks per pass (24), plus 2 desktop-light extras = 26.**

- **A. `theme actually applied`** — replaces `gate.mjs:145-148`'s hard-coded `true`. Assert `document.documentElement.dataset.theme === expected` **and** that the resolved `--paper` equals the literal for that theme. The literals are not typed into the gate: parse them out of `frontend/src/styles.css` at load (`:root{` block → `--paper: #f6f3ec`, `[data-theme='dark'] {` block → `--paper: #0c1611`) with the same block scanner `check-palette.mjs` uses (§1.5). Now it can fail: a broken pre-paint script, a `data-theme` typo, or a token rename all trip it.
- **B. `every selector in the manifest matches`** — `assertManifest(phase='routes', width)`. Counted as a check so it appears in the score, but a failure additionally sets exit code 3 and stops the run: if the vocabulary has moved, every downstream measurement is meaningless and reporting `24/26` would be a lie.
- **C. layout contract for this width** — width-conditional, and this is the check that must be *re-specified* rather than re-selectored (§E3).
  - at 390: `getComputedStyle('.layout').gridTemplateColumns` resolves to **one** track; `.stage` `order === '-1'` and height `≈ max(230, 0.36 × 844) = 304px` (`styles.css:1424-1427`); `.panel` `overflowY === 'visible'` (`styles.css:1429-1430`); `.tripbar` `position === 'static'` (`styles.css:1433-1435`, whose comment explains a sticky bar would cover the map); document scrolling is **permitted**; and the design promise at `styles.css:1414-1416` — *"the trip bar and the first route row have to be reachable by thumb"* — is measured as: `.tripbar` bottom `≤ innerHeight`, and the first `button.route` top `< innerHeight`. Print the measured y and the visible fraction of that first row in `detail` every run, pass or fail, so a slow regression is legible in the log.
    ⚠ **Do not tune this threshold to whatever the first run produces.** My arithmetic from the CSS (topbar 56 + stage 304 + panel padding 12 + tripbar ~136 + departure ~90 + results head ~30) puts the first row's top near y≈676 with ~168 px of headroom, but I have not measured it. If it fails, that is a finding about the mobile layout, to be reported, not a threshold to soften.
  - at 1280: `.layout` `gridTemplateColumns` resolves to **two** tracks with the first between 360 and 420 (`styles.css:222-229` — that comment records that `1fr` instead of `minmax(0,1fr)` blew the grid ~12 px past the viewport); `.panel` `overflowY === 'auto'` (`styles.css:242`); and `document.documentElement.scrollHeight <= innerHeight + 1` — the document does **not** scroll at desktop, because `.app { height: 100dvh }` (`styles.css:216-220`) and the panel scrolls inside it. That is the real composition contract the launch check's "sheet becomes a static panel" was groping at.
- **D. `no horizontal scroll`** — the one launch check that still works verbatim (`gate.mjs:166-183`); keep its logic. Mobile passes re-measure at **320×844** and restore 390 (as `gate.mjs:167`/`:184-185` do). Desktop passes measure at 1280 and again at **900**, one pixel above the breakpoint, where the two-column grid is at its tightest. Improve the diagnostic: instead of `gate.mjs:171-173`'s bare "furthest right edge" number, walk the DOM and report the *selector path* of the widest offender. The bare number tells you a bug exists and nothing about where.
- **E. `every interactive target clears 44×44`** — `TARGET_SELECTOR` and `TARGET_EXEMPT` from the manifest. Replace `gate.mjs:195`'s dead `el.closest('.footer')` with `el.closest('.about__body')` and cite `styles.css:389-391` in the code comment. Add `summary`, `textarea` and `[tabindex]:not([tabindex="-1"])` to the sweep — the last one catches `StepList.jsx:93-103`'s focusable `<li className="step">`, a real keyboard target the launch selector missed. Skip zero-sized elements (`gate.mjs:192`). Report `tag.class WxH` plus the nearest id, capped at 6 offenders.
- **F. `axe: zero wcag2a/2aa/21a/21aa violations`** — keep `gate.mjs:204-219` unchanged in substance, including reading `node_modules/axe-core/axe.min.js` off disk and injecting it with `awaitPromise=false` (`gate.mjs:24-27`, `:205`). Run it only after check B has confirmed there are ≥3 real rows — auditing an empty page is the vacuity the whole rewrite is about, and `a11y.jsx:8-9` already says so.

**Two extras, run once in the desktop-light pass:**

- **G. `colour is not the only differentiator`** — encodes the project rule the launch gate never tested. Import `OBJECTIVES` from `../src/lib/dash.js` (pure ESM, no imports, loads in plain Node) and assert that every `button.route`'s `.route__sub` text contains either that route's `pattern` word (`solid`, `dashed`, `dotted`, `long dash`, `dash-dot`, `fine dash` — `dash.js:27,35,43,51,59,67`) or the literal `not drawn on the map` (`RouteRow.jsx:88`). Fails if someone drops the pattern text and leaves only the swatch.
- **H. `the map is never the only representation`** — assert `.legend__row` count equals `button.route` count and every `.legend__row` label (`MapView.jsx:586`) appears verbatim inside a rail row. Non-vacuous because both counts are asserted > 0 first. This is `MapView.jsx:117-124`'s promise, checked.

**Hermeticity and the basemap.** `MapView.jsx:6` fetches `https://tiles.openfreemap.org/styles/positron` — a real third-party request made by the *gate's* browser, not new production behaviour. Default: allow it, wait at most **8 s** for `canvas` or `.map__fallback`, and print `map=ready|fallback|pending` in each pass banner so the reader knows what was audited; never fail on `pending`. `--no-tiles` adds the host-resolver block for a hermetic local run. **Do not make `--no-tiles` the default** and expect a fast fallback: `MapView.jsx:255-261` only calls `setFailed` on `status === 404` or a message containing `style`, and a DNS failure matches neither, so it falls through to `MAP_LOAD_TIMEOUT_MS = 20000` (`MapView.jsx:17`) — 20 s per pass.

**Exit codes:** `0` all pass · `1` one or more checks failed · `2` harness error (`gate.mjs:249-252`) · `3` **vacuous gate** — a manifest selector matched nothing. Three is new and is the whole point: "the gate could not measure anything" must never be reported as "nothing was wrong".

### 1.5 `frontend/scripts/check-palette.mjs` (~110 lines) — rewritten, not restored

Closes the ungated drift in §E7. Two structural changes from `feat/launch`:

1. **Block scanner, not `String.split`.** A tiny brace-depth scanner returns the body of a named top-level block. Callers: `:root {` (`styles.css:16`) and `[data-theme='dark'] {` (`styles.css:66`). This is also the function check A reuses for `--paper`. Never split on `@media (prefers-color-scheme: dark)` — absent on this tree (§E6).
2. **`import { OBJECTIVES } from '../src/lib/dash.js'`, not source-slicing.** `dash.js` has no imports and touches no DOM, so plain Node loads it. This removes the `const FALLBACK_COLORS = {` failure mode permanently — a rename of the export is now an import error, not a silently empty object.

Assertions:
- for each of the 6 `OBJECTIVES` (`dash.js:20-69`): `--route-<id>` exists in **both** blocks; light value === `o.color`; dark value === `o.colorDark`, compared case-insensitively (CSS is lowercase, `dash.js` is uppercase — that difference is real and must not be reported as drift);
- every `--route-*` in either block has a matching objective id (catches a token added to CSS and forgotten in JS);
- `FALLBACK.color` / `FALLBACK.colorDark` (`dash.js:76-77`) equal `--ink-2` in the light and dark blocks respectively — verified: `styles.css:24` `#55645a`, `styles.css:73` `#9baea1`, `dash.js:76-77` `#55645A`/`#9BAEA1`. Exact match today. This is the pair Survey C counted among the 14 and nobody has ever gated.
- Total coverage: 12 route hexes + 2 fallback hexes = **all 14** of `dash.js`'s literals.

Print `Route palette consistent: 6 colours × 2 themes + the unknown fallback, CSS and dash.js agree.` and exit 0; on failure list every problem and exit 1 (same shape as `feat/launch:check-palette.mjs:62-70`).

It complements, never replaces, `scripts/check_palette.sh` (`ci.yml:157`, `Makefile:68`): that one proves *no hex escapes the two `:root` blocks*; this one proves *the two files agree on the hexes inside them*. Disjoint properties. Say so in both headers.

---

## 2. EDITS TO EXISTING FILES — every anchor verified against HEAD 8644ff2

### 2.1 `frontend/package.json`

- **`:11`** — replace `"build": "vite build"` with `"build": "npm run check:palette && vite build"`. This is the `feat/launch:frontend/package.json:11` precedent, minus `check:permalink` and `check:offline`, whose subjects (`src/lib/permalink.js`, `src/lib/offline.js`) do not exist. It is also what makes `deploy.yml:54-55` true again (§2.4).
- **after `:14`** (inside `scripts`, before the `}` at `:15`) add:
  ```json
  "check:palette": "node scripts/check-palette.mjs",
  "gate": "node scripts/gate.mjs",
  "gate:mock": "node scripts/gate.mjs --no-tiles"
  ```
  Deliberately **not** a `prebuild` hook: an invisible hook is how `deploy.yml:54-55` came to describe gates nobody could see were gone.
- No dependency changes. `axe-core@^4.12.1` (`:23`) is already present and is read off disk, never bundled.

### 2.2 `frontend/src/a11y.jsx`

- **`:53`** — `const ROW_SELECTOR = 'button.route, .card'` becomes `import { SELECTORS } from '../../scripts/selectors.mjs'` (add at `:12`-adjacent) and `const ROW_SELECTOR = SELECTORS.row.css`. `.card` matched nothing on `main`; keeping it means the harness can pass by auditing an empty page, which is the same defect as the gate's. Rewrite the comment at `:46-52`: the redesign transition it hedged for is complete, and the `button.route`-not-`.route` reason at `:50-52` **must be preserved verbatim** — it is now enforced in one place instead of two.
- **`:29`** — `document.querySelector('input[role="combobox"]')` becomes `SELECTORS.combobox.css`, so the two harnesses share one vocabulary.
- Leave `:84-101` alone. `a11y.jsx` reports best-practice violations too (`:86-90`), which the gate deliberately does not gate on; that difference is worth keeping and should be noted in the gate's header.

### 2.3 `.github/workflows/ci.yml`

Insert a new job after the `frontend` job's last line, **`ci.yml:147`** (before the blank line at `:148` and `no-hard-coded-colour:` at `:149`):

```yaml
  frontend-browser-gate:
    # The gate that measures the layout instead of asserting it. Separate job:
    # it needs Chrome and a running mock server, and a two-minute browser run
    # has no business blocking the 30-second unit suite.
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: '22', cache: npm, cache-dependency-path: frontend/package-lock.json }
      - run: npm ci
        working-directory: frontend
      # google-chrome is preinstalled on the ubuntu-latest image. Named
      # explicitly rather than resolved silently, so a runner image change
      # fails here with a clear message instead of skipping the gate.
      - run: google-chrome --version
      - name: Layout and accessibility gate
        run: npm run gate
        working-directory: frontend
```

Do **not** add it to the existing `frontend` job — a Chrome failure would then read as a unit-test failure.

### 2.4 `.github/workflows/deploy.yml` — the false claim

- **`:54-55`**, currently:
  ```
  # `npm run build` runs check:palette, check:permalink and check:offline
  # first; a failure in any of them fails the deploy before anything ships.
  ```
  Replace with a comment that is true after §2.1: `npm run build` runs `check:palette` and nothing else, and say in one line that `check:permalink` and `check:offline` return with the features they check.
- **After `:56`**, add the browser gate on the exact commit being shipped, consistent with `deploy.yml:36-38`'s stated reason for re-running the backend gates:
  ```yaml
      - name: Layout and accessibility gate
        working-directory: frontend
        run: npm run gate
  ```
- **`:129`, `:132`, `:136`** — `--exclude 'sw.js'`, `--include 'sw.js'`, and `--paths … '/sw.js'` name a file this build has never emitted (§E4). Same class of lie as `:54-55`. **Delete the three `sw.js` references now.** Leave the `*.webmanifest` / `/manifest.webmanifest` references: `frontend/public/manifest.webmanifest` is restored by the icons work (Phase 3-5), and they are inert until then — but add a one-line comment saying they are ahead of the build, so the next reader does not have to re-derive it.
- Out of scope but worth flagging in the PR: `deploy.yml:142` and `:147-148` curl `$SITE/api/healthz` and `$SITE/api/health`. `/api/health` exists (`backend/main.py:1353`); **`/api/healthz` does not** — the route is `/healthz` (`backend/main.py:1310`). Survey B found the same 404 in `DEPLOY.md:166` and `docs/RUNBOOK.md:15`.

### 2.5 `Makefile` — restore the deleted target, honestly

- **`:23-25`** — add `gate` to `.PHONY`.
- **`:102-111`** — this comment block explains why `gate` and `pwa-gate` were deleted, and half of it stops being true. Keep the `pwa-gate` half verbatim; replace the `gate.mjs` half. The sentence *"gate.mjs measures a layout this branch does not have"* was exactly right and should be retained as the reason the returning target is a rewrite. Keep `:109-111` (*"Deleted rather than left pointing at absent files"*) — it is the doctrine this whole change follows.
- Add, following the `test-sandboxed` pattern at **`Makefile:79-85`** (whose comment at `:78` — *"A gate that cannot fail must not look like a gate that passed"* — is the exact principle this capability exists to serve):
  ```make
  gate:  ## Layout and a11y in headless Chrome (says so when Chrome is absent)
  	@if [ -n "$$CHROME_PATH" ] || command -v google-chrome >/dev/null 2>&1 \
  	    || [ -x "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" ]; then \
  	    cd $(FRONT) && npm run gate ; \
  	else \
  	    echo "  SKIPPED gate — no Chrome found. Set CHROME_PATH. The ci.yml job covers it." ; \
  	fi
  ```
- **`:112`** — add `gate` to `check`, last (it is the slowest): `check: lint dupes coverage test-frontend build colour infra-lint torch-free test-sandboxed gate`.
- **`:113-119`** — the epilogue names `test-sandboxed` as the single skippable gate. Add `gate` to that sentence. Leaving it would recreate exactly the drift `1749aa0` just fixed.

### 2.6 `frontend/src/styles.css` — the two pre-existing 44×44 violations (§E8)

- **`:406`** — `.theme-toggle { min-height: 36px }` → `min-height: var(--target)`. Safe: `.topbar` is `height: 56px` (`styles.css:284`) and already contains a 44×44 `.icon-button` (`:324-325`).
- **`:527`** — `.preset { min-height: 36px }` → `min-height: var(--target)`. `.presets` is `flex-wrap: wrap` (`:518-522`), so the five pills re-flow rather than overflow; check D at 320 covers it.
- Both are graphics-free changes with no new hex, so `scripts/check_palette.sh` is unaffected.
- **If either fix is judged out of scope**, the alternative is an explicit, dated waiver array in `selectors.mjs` that the gate *prints on every run* alongside the pass count. It must never be a silent `closest()` exemption — that is how `.footer` became invisible.

### 2.7 `frontend/vite.config.js` — no change required

The gate spawns its own dev server with `VITE_MOCK_API=1`; the hard-coded `server.proxy` at `:6-10` is irrelevant to it, and the missing `preview.proxy` (present at `feat/launch:frontend/vite.config.js:124`) does not matter because the gate never uses `vite preview`. Survey C's live `VITE_API_PROXY_TARGET` bug (`docker-compose.yml:78` sets a variable `main` no longer reads) is real but is a different capability — do not fold it in.

### 2.8 `frontend/a11y.html` — no change

`:10-11` correctly documents that `vite build` takes `index.html` as its single entry. Adding a second `rollupOptions.input` would ship axe-core to users. Leave it.

---

## 3. TOKEN MAPPING

### 3.1 Design tokens — verified by grep over all four launch scripts

`gate.mjs`, `pwa-gate.mjs` and `make-icons.mjs` contain **zero** design-token references and **zero** hex literals (`grep -nE '\-\-space|\-\-text|\-\-ink|\-\-route|\-\-page|\-\-radius|#[0-9a-fA-F]{3,8}'` returns nothing for all three). `check-palette.mjs` is the only source with token vocabulary, and it references only the `--route-*` family generically via the regex at `:27`. So the launch-token risk in this capability is narrow — but it is real in one place: **the rewritten `check-palette.mjs` reads colour values, and seeding it with launch values would bake the forbidden palette into a gate.**

| Launch token / value | Where it appears in the launch source | Current equivalent | Rule |
|---|---|---|---|
| `--route-fastest: #2f6fd0` (blue) | `feat/launch:styles.css:50`; matched by `check-palette.mjs:27` | `--route-fastest: #c2703d` `styles.css:44` / dark `#e8a46f` `:86`; `dash.js:24-25` | Read from the tree; never type a value |
| `--route-scenic: #2e8b57` | `feat/launch:styles.css:51` | `#2f7d53` `styles.css:45` / `#6fc38e` `:87`; `dash.js:32-33` | as above |
| `--route-accessible: #7a4fc4` | `feat/launch:styles.css:52` | `#5b6ecf` `styles.css:46` / `#95a4f0` `:88`; `dash.js:40-41` | as above |
| `--route-quiet: #b06a1f` | `feat/launch:styles.css:53` | `#8a5cb4` `styles.css:47` / `#c2a0e8` `:89`; `dash.js:48-49` | as above |
| `--route-shade: #12756c` | `feat/launch:styles.css:54` | `#1e7a78` `styles.css:48` / `#63c4be` `:90`; `dash.js:56-57` | as above |
| `--route-air: #b03050` | `feat/launch:styles.css:55` | `#b0455f` `styles.css:49` / `#ee8aa0` `:91`; `dash.js:64-65` | as above |
| `--score-scenic/-air/-shade` (aliases) | `feat/launch:styles.css:57-59` | **no equivalent; none needed.** `RouteRow.jsx:5-9` labels scores in text and `styles.css:1391-1394` paints every fill `var(--accent)` — a score bar is not colour-coded by objective | Do not recreate |
| `--ink: #14213d` (navy) | `feat/launch:styles.css:68` | `--ink: #16241c` `styles.css:23` / `#e8efe8` `:71` | Forbidden value; use the token |
| `--ink-muted: #545f71` | `feat/launch:styles.css:72` | `--ink-2` `styles.css:24` / `:73` — **and it is load-bearing**: `dash.js:76-77` mirrors it | Assert equality in check-palette |
| `--page: #f7f4ee` | `feat/launch:styles.css:63` | `--paper` `styles.css:18` / `:68` | Gate check A reads `--paper` |
| `--recessed` | `feat/launch:styles.css:65` | `--sunken` `styles.css:20` / `:70` | rename |
| `--selected-border: #8fa0bd` | `feat/launch:styles.css:74` | none — selection is `--accent` + `aria-pressed` (`styles.css:1010-1014`) | Do not recreate |
| `--warn-border` | `feat/launch:styles.css:77` | `--warn-rule` `styles.css:40` | rename |
| `--map-casing: #ffffff` | `feat/launch:styles.css:81` | none — the redesign has `--map-land/-park/-water/-road` (`styles.css:52-55`) and no casing token | Do not recreate |
| `--space-1…8` (4/8/12/16/**24/32/48/64**) | `feat/launch:styles.css:15-22` | `--s1…--s8` = 4/8/12/16/**20/24/32/40** `styles.css:124-131` | **Not a rename — the scales diverge from step 5.** `--space-5:24px`→`--s6`; `--space-6:32px`→`--s7`; `--space-7:48px` and `--space-8:64px` have no equivalent, compose `--s8` + padding |
| `--text-1…6` (14/16/18/22/28/36 px) | `feat/launch:styles.css:32-37` | `--t-micro .75 / --t-small .8125 / --t-body .9375 / --t-h3 1.0625 / --t-h2 1.375 / --t-metric 1.75 / --t-display 2rem` `styles.css:113-120` | Semantic, not numeric. `--text-1`(14px)→`--t-small`; `--text-2`(16)→`--t-body`(15px, closest); `--text-4`(22)→`--t-h2`; `--text-6`(36)→`--t-display`(32) |
| `--radius-control/-card/-chip` | `feat/launch:styles.css:83-85` | `--r-sm 8 / --r-md 12 / --r-lg 16 / --r-pill 999` `styles.css:133-136` | rename |
| `@media (prefers-color-scheme: dark)` + `:root:not([data-theme='light'])` | `feat/launch:styles.css:118-119` | **`[data-theme='dark']` only**, `styles.css:66`, set pre-paint by `index.html:39` | This single difference is what breaks `check-palette.mjs` (§E6) |

**None of the left column may appear in any new file.** The mechanical guarantee: the only new code that touches colour is `check-palette.mjs`, and it obtains every value by reading `frontend/src/styles.css` and importing `frontend/src/lib/dash.js` — there is no literal to get wrong.

### 3.2 Selector mapping — the substantive one

| `gate.mjs` line | Launch selector | Exists on main? | Replacement | Anchor |
|---|---|---|---|---|
| `:92` | `.topbar__origin` | **no** | delete the step — `FirstRun`'s combobox is on screen at load | `App.jsx:352`, `FirstRun.jsx:43-49` |
| `:94` | `input[role="combobox"]` | yes | unchanged | `PlaceInput.jsx:117` |
| `:99-100` | `[role="option"]` | yes | tighten to `li.suggestions__item[role="option"]` | `PlaceInput.jsx:132-137` |
| `:105` | `.controls-sheet__bar .button` | **no** | delete the step (`ControlsSheet.jsx` was dropped by the merge) | — |
| `:113`, `:149`, `:233` | `.row__button` | **no** | `button.route` | `RouteRow.jsx:51-53` |
| `:113`, `:149`, `:232` | `.card` | **no** | `button.route` (same element) | `RouteRow.jsx:53` |
| `:154` | `.sheet__scroll` | **no** | `main.panel` — the only real scroll container, `overflow-y:auto` at ≥900 and `visible` below | `styles.css:242`, `:1429-1430` |
| `:195` | `.footer` (target-size exemption) | **no** | `.about__body` | `About.jsx:22`, `styles.css:389-391` |
| `:229` | `.sheet` | **exists but is the wrong thing** | `.layout` / `main.panel`. `.sheet` on main is the follow-mode step panel (`FollowMode.jsx:207`, `styles.css:1669`), reachable only after entering follow mode, which the harness never does — so `getComputedStyle(null)` and a guaranteed FAIL | `App.jsx:391-392` |
| `:231` | `.sheet__handle` | **no** | no successor — no bottom sheet, no snap points. Check C's desktop half replaces the intent | — |
| `:176`, `:190` | `*`, generic focusables | yes | keep; extend `TARGET_SELECTOR` with `summary`, `textarea`, `[tabindex]:not([tabindex="-1"])` | `selectors.mjs` |
| `pwa-gate:341` | `.shell` | **no** | `.app` | `App.jsx:366` |
| `pwa-gate:392,396` | `.row`, `.row__cached` | **no** | `li` in `ul.rail` / no successor | `RouteRail.jsx:44` |
| `pwa-gate:223,393` | `.topbar__time`, `.topbar__cached` | **no** | no successor (settings are `button.seg` drawers now) | `TripBar.jsx:127` |
| `pwa-gate:450` | `.sheet__snap` | **no** | no successor | — |
| `pwa-gate:347,455-458` | `.trust--cached`, `.trust--loud`, `.offline`, `.better-later__head`, `.better-later--expired` | **no** | none — these belong to the offline feature (§6) | — |
| `pwa-gate:211,229,522` | `.banner--warn`, `.chip`, `[role="status"][aria-live="polite"]` | **yes, all three** | unchanged — the only pwa-gate selectors that survive | `StatusBanner.jsx:10`, `ObjectiveChips.jsx`, `App.jsx:372` |

---

## 4. PROJECT RULES AND HOW THE DESIGN SATISFIES EACH

1. **A missing OSM tag means UNKNOWN, never "accessible".** The gate never asserts a score is present, only that `null` renders as text: check E's sweep and check F's axe run both walk `.score__none` / `.score__track--hatched` (`RouteRow.jsx:99-121`, `styles.css:1148-1157`) as ordinary content. `mock.js:225-232`'s `accessible` fixture carries `shade: null` deliberately, so **every gate run exercises the unmeasured branch** — the `--no-tiles`/mock default guarantees it rather than leaving it to chance.
2. **Colour is never the only differentiator (survives greyscale).** Check G, new in this rewrite, asserts every rail row names its dash pattern in text against `OBJECTIVES[].pattern` (`dash.js:27,35,43,51,59,67`). Check A asserts the theme literal rather than eyeballing a screenshot. `check-palette.mjs` keeps the CSS and the canvas palette from drifting so the map's line and the row's swatch stay the same colour — the launch script's original purpose, finally applicable again.
3. **The route list is a complete text substitute for the map.** Check H asserts legend/rail parity and that every legend label appears in the rail. The `--no-tiles` mode makes the map unavailable on purpose and the gate still requires 3 rows and 0 axe violations — i.e. the app is graded with the map absent, which is `MapView.jsx:117-124`'s claim, checked. `driveToRoutes()` records `map=pending|fallback|ready` rather than waiting on the map, so no measurement depends on a third-party tile host.
4. **No location history, no cookies, no analytics; localStorage is theme and units ONLY.** The gate writes nothing to the page except axe's own script. It *reads* `localStorage` and clears it between passes (needed so `index.html:28`'s stored-theme read does not poison theme emulation) — a clear, not a write of a new key. **This is the rule that blocks `pwa-gate.mjs`**: `pwa-gate.mjs:255` asserts `localStorage.getItem('meander.offline')` and `:236-254` drives a "Keep my last route" opt-in. Restoring it would require a third key and is out of scope (§6). Add a standing assertion to check B while we are here: after a full pass, `Object.keys(localStorage)` ⊆ `['meander:theme']` (`lib/theme.js:14`), so the privacy promise at `About.jsx:29-33` is gated rather than trusted.
5. **No new third-party runtime requests.** Nothing is added to the shipped bundle. `axe-core` stays a devDependency read off disk (`node_modules/axe-core/axe.min.js`) and injected into the *gate's* browser; `frontend/a11y.html` stays out of `rollupOptions.input` (`vite.config.js:14-18` declares no input, so `index.html` remains the single entry). No CDN, no new npm package — the CDP client is `node:` builtins plus the platform `WebSocket`, which is exactly why the launch scripts were written this way (`gate.mjs:11`).
6. **All interactive targets ≥ 44×44.** Check E, with the exemption list corrected to the one WCAG 2.2 actually grants and the two real offenders fixed at `styles.css:406` and `:527` rather than exempted (§2.6, §E8).
7. **The redesign frontend and its `--s1..--s8` / `--t-*` / dark-green vocabulary are final.** Nothing in this change touches a component or a token value. The two CSS edits replace `36px` with `var(--target)` — moving *toward* the token system, not away. Launch tokens are structurally unreachable (§3.1).
8. **`App.jsx` must not be restructured (rule 8) and `MapView` must stay a single instance.** The gate is read-only against the running app: it dispatches an `input` event and a `mousedown`, both of which a user does. It never unmounts anything, never navigates within a pass (only between passes), and never touches `window.__meanderMap` (`MapView.jsx:171`, dev-only). The StrictMode deferred-creation fix (`MapView.jsx:148-189`) is exercised, not bypassed.
9. **One live region for the whole app.** `SELECTORS.liveRegion` pins `App.jsx:372-374` at `min: 1`, and the static test (§5.1) will fail if a second `role="status"` region is introduced under a new class. `FollowMode.jsx:171-178`'s routing through `onAnnounce` is thereby protected.

---

## 5. WHAT THIS DOES NOT COVER, AND WHY (`pwa-gate.mjs`)

Restoring it is **blocked**, not deferred by preference. Its six subjects are all absent from `main` (proved by `git ls-tree -r main -- frontend`): `sw.js` (290 lines), `src/lib/offline.js`, `src/lib/offlineStore.js`, `src/lib/pwa.js`, `src/lib/permalink.js`, and `public/manifest.webmanifest` + five PNGs — plus the `meanderServiceWorker()` Rollup plugin that emits `sw.js`, which exists only in `feat/launch:frontend/vite.config.js`. It fails at `pwa-gate.mjs:329-331` before check one, and as written it needs a second localStorage key, which rule 4 forbids.

What this capability does for it, so the downstream task is mechanical rather than another 544-line rewrite:
- `cdp.mjs` absorbs `pwa-gate.mjs:99-160` (CDP client) and `:41-95` (detached preview spawn/kill, including the `npx`-forks-and-orphans lesson) — **~120 of its 544 lines are already ported by this change**.
- `harness.mjs` absorbs `check()`/`results` (`:258-263`) and `driveToRoutes` (`:170-199`), retargeted.
- `selectors.mjs` gives it a place to declare its selectors so the same anti-vacuity guard applies — the objection §5 of the brief raises against it is answered by the mechanism, not by a promise.
- The manifest already records that `.banner--warn`, `.chip` and `[role="status"][aria-live="polite"]` are its only three surviving selectors; every other one needs a successor that does not exist yet.

Write this into `Makefile:102-111`'s comment (keeping its `pwa-gate` half) rather than into a new doc, so the next reader finds it where the target used to be.

### Risks and the rules that constrain it

**What could break, and the constraints that bound it.**

**R1 — The gate lands red on its first run, and that is the expected outcome, not a bug in the gate.** Two certain failures of check E: `.theme-toggle` at `styles.css:406` and `.preset` at `styles.css:527` are both `min-height: 36px` against a `--target: 44px` floor, and `.preset` is on the first-run path (`FirstRun.jsx:60-86`). §2.6 fixes them in the same change. Check F (axe) has never been run against this frontend by anything automated — `a11y.jsx` is manual and there is no recorded result on `main` — so the violation count is genuinely unknown. **The instruction if axe reports violations: record them and fix them, or record them and fail. Do not narrow the tag list from `wcag2a/2aa/21a/21aa`.** Narrowing the rule set to reach green is the same defect as a selector that matches nothing.

**R2 — Check C's mobile threshold is specified from the CSS, not measured.** I derived the first-row-above-the-fold estimate (y≈676 of 844) by adding up `styles.css:284` (topbar 56), `:1424-1427` (stage 304), `:1429`/`:1466-1468` (panel padding 12), the tripbar grid, `:1490-1499` (departure), and `:264-270` (results head). I did not run a browser. If it fails, it is a finding about the mobile layout against the promise written at `styles.css:1414-1416`, to be reported — not a number to tune down.

**R3 — Adding `gate` to `Makefile:112`'s `check` makes `make check` depend on Chrome.** Mitigated by the `test-sandboxed` skip pattern (`Makefile:79-85`) and by adding `gate` to the epilogue at `:113-119` that currently names `test-sandboxed` as the only skippable target. Leaving the epilogue unedited would recreate exactly the drift commit `1749aa0` just closed, and would make the file dishonest a second time.

**R4 — The gate depends on `tiles.openfreemap.org` by default.** Not a new production request (`MapView.jsx:6` already makes it) but a new CI dependency, and CI flakiness in a gate is how gates get disabled. Mitigations both specified: the gate never *waits* on the map beyond 8 s and never fails on `map=pending`; `--no-tiles` gives a hermetic run. The trap if `--no-tiles` were made the default: `MapView.jsx:255-261` only calls `setFailed` on `status === 404` or a message containing `style`, and DNS `~NOTFOUND` matches neither, so it falls through to the 20 s `MAP_LOAD_TIMEOUT_MS` (`MapView.jsx:17`) — 80 s across four passes.

**R5 — Chaining `check:palette` into `frontend/package.json:11` puts a new failure in front of every `vite build`.** That is deliberate (it is what makes `deploy.yml:54-55` true), but it means `ci.yml:146`, `deploy.yml:56`, `Makefile:58-59`, and `vercel.json:4` all newly depend on the CSS and `dash.js` agreeing. I verified they agree today for all 14 hexes (6 route pairs at `styles.css:44-49`/`:86-91` vs `dash.js:24-65`, plus `--ink-2` `#55645a`/`#9baea1` at `styles.css:24`/`:73` vs `dash.js:76-77`), so the check goes in green.

**R6 — `frontend/scripts/selectors.test.mjs` is collected by `npm test` — verified, not assumed.** vitest 4.1.10's `defaultInclude` is `["**/*.{test,spec}.?(c|m)[jt]s?(x)"]` and `defaultExclude` is only `["**/node_modules/**","**/.git/**"]` (`frontend/node_modules/vitest/dist/chunks/defaults.9aQKnqFk.js:5-6`). So a `.test.mjs` under `frontend/scripts/` runs, and no `include` override is needed in `vite.config.js:20-33`. **Side effect worth knowing:** `dist/` is *not* excluded, so a `*.test.*` file that ever lands in `frontend/dist` would be collected. None does today.

**R7 — No new dependency is available for DOM tests.** There is no `jsdom` or `happy-dom` in `frontend/node_modules` and vitest has no `environment` set (`vite.config.js:20-33` sets only `env.TZ`). Every test in §5 is therefore **node-environment and pure** — filesystem reads and string assertions. Do not reach for `@testing-library/react`; adding jsdom to make a selector test possible would be a large dependency added to prove a small thing the static test already proves.

**R8 — Manifest rot is the failure mode this design trades into.** A component can be renamed and the manifest updated in the same commit, keeping the gate green while the check silently changes meaning. Partly mitigated by `src:` anchors and the static test's "the token must appear in the file the entry names" rule; not fully solvable. Say so in `selectors.mjs`'s header rather than implying the mechanism is airtight.

**R9 — Stale anchors in the surveys.** `Makefile` (157 lines now, was 112) and `.github/workflows/ci.yml` (176, was 188) both moved in commits `1749aa0`/`8974d89` after Survey C was written. Every Makefile and ci.yml line number in this spec is against HEAD **8644ff2**. All `frontend/` anchors are unchanged (`git diff 46d4772..HEAD -- frontend` is empty).

**R10 — Working-tree note.** `git status` at HEAD shows `data/cache.db` modified (81920 vs 57344 bytes). That is from a sibling survey agent's live `POST /api/routes` probe against the replay fixtures, not from this task — I edited nothing. `Makefile:145-153 scrub` is the documented way to clean it before any commit, and `git checkout --` will not do it (the pre-commit hook inspects the staged blob).

### Tests

**All four suites are node-environment and pure — no jsdom, no new dependency (see R7). All are collected by the existing `npm test` (`frontend/package.json:13` → `vitest run`), so they run in `ci.yml:140-144` and `Makefile:55-56` on day one, with no Chrome and no server.**

---

### T1 — `frontend/scripts/selectors.test.mjs` (NEW, ~90 lines) — the manifest cannot rot silently

The static half of the anti-vacuity guarantee. Reads source files with `node:fs`; asserts strings.

1. `every manifest entry names a file that exists` — `fs.existsSync(join(root, entry.src.split(':')[0]))` for all ~28 entries. Catches a deleted component before the gate ever runs.
2. `every class token in a selector appears in the file its src names` — parse each `css` string for `.foo` classes and `[attr="value"]` pairs, assert each literal appears in that file's text. Example: `SELECTORS.row.css = 'button.route'` → `'route'` must appear in `src/components/RouteRow.jsx` (it does, `:53`). This is what fails the build the moment someone renames `.route`.
3. `every class token also has a rule in styles.css` — for entries flagged `styled: true`. Catches the `a11y.jsx:53` `.card` failure mode directly: a selector with no CSS rule anywhere is almost certainly dead.
4. `no manifest selector uses a feat/launch class` — a hard denylist asserted absent from every `css` string: `row__button`, `sheet__handle`, `sheet__scroll`, `sheet__snap`, `topbar__origin`, `topbar__time`, `topbar__cached`, `controls-sheet`, `card`, `footer`, `shell`, `row__cached`, `trust--cached`, `trust--loud`, `offline`, `better-later`. **This is the test that makes "re-target every selector" enforceable rather than a review note.**
5. `min counts match the component that renders them` — `segment.min === 4` against the `segments` array literal in `TripBar.jsx:96-121`; `mapCtrl.min === 3` against the three buttons at `MapView.jsx:597-609`; `row.min === 3` against `initialState.objectives` length at `App.jsx:40`; `rowScores.min === 9` against `SCORE_ROWS.length × 3` (`RouteRow.jsx:5-9`); `departureHour.min === 6` against the hour count in `DepartureStrip.jsx`. Derive each from the source, don't restate it — a count that drifts from its producer is a gate that silently loosens.
6. `TARGET_EXEMPT contains exactly one entry, and styles.css justifies it` — asserts `['.about__body']` and that `styles.css` contains the WCAG-2.2 comment at `:389-391`. An exemption added without a documented reason fails here.

### T2 — `frontend/scripts/check-palette.test.mjs` (NEW, ~70 lines) — the palette gate itself is tested

A gate with no test is how `check-palette.mjs` came to fail on 12 colours without anyone noticing.

1. `passes against the real tree` — import the module's exported `analyse()` (factor the assertions out of the CLI wrapper so they are callable) and assert zero problems against `frontend/src/styles.css` + the real `OBJECTIVES`. Locks in today's agreement across all 14 hexes.
2. `catches a light-value drift` — feed a CSS string where `--route-scenic` is `#000000`; expect one problem naming `--route-scenic` and both values.
3. `catches a missing dark value` — CSS with a `[data-theme='dark']` block lacking `--route-air`; expect a problem.
4. `catches a --route-* with no objective` — CSS declaring `--route-scenic`; expect a problem.
5. `catches fallback drift against --ink-2` — change `--ink-2` in the fixture; expect a problem naming `dash.js:76-77`. This is the pair nothing has ever gated (§E7).
6. `case-insensitive comparison` — `#2F7D53` (dash.js style) and `#2f7d53` (CSS style) must be equal. Guards the most likely false positive in the rewrite.
7. `the block scanner does not fall back to whole-file matching` — feed CSS with **no** `[data-theme='dark']` block and assert it *reports an error*, rather than silently scanning the whole file. This is the precise defect that made the launch script read the dark palette as the light one (`feat/launch:check-palette.mjs:24`); asserting the fix means it cannot come back.

### T3 — `frontend/scripts/gate.selftest.test.mjs` (NEW, ~60 lines) — the gate cannot pass vacuously

Tests the harness's pure logic without a browser, by injecting a fake `evaluate`.

1. `expect() throws VacuousGate when the count is below min` — the core guarantee, asserted directly.
2. `a pass that finds zero rows exits 3, not 0` — drive `runPass()` with a stub returning `{count: 0}` for `SELECTORS.row`; assert the process-code result is 3 and that **no** individual check reports PASS. This is a regression test against the exact `gate.mjs:151`/`:158-162` bug: a `{n:0}` shape flowing into `?? 0` and passing.
3. `no check() call site passes a boolean literal` — read `gate.mjs`'s own source and assert no `check(` invocation has `true` or `false` as its second argument. Catches `feat/launch:gate.mjs:145-148` reappearing by copy-paste. Cheap, blunt, and it addresses the failure mode the brief understated (§E2).
4. `the check count is what the header claims` — count `check(` call sites × pass count and assert it equals the number in the header comment. Stops the header drifting from the score the way `14/14` did.
5. `every viewport in the matrix appears in the results` — assert the four pass labels are present, so a silently skipped dark pass cannot look like a clean run.

### T4 — additions to the existing suites

- **`frontend/src/lib/dash.test.js` (NEW, ~40 lines)** — `frontend/src/lib/` currently has only `sun.test.js` (255) and `follow.test.js` (185); `dash.js` has none despite being mirrored in CSS and read by the map. Add: every `OBJECTIVES` entry has a unique `id`, a unique `dash` array, and a unique non-empty `pattern` word (the greyscale rule, unit-tested); `swatchBackground()` returns a bare colour for `[1,0]` and a `repeating-linear-gradient` otherwise (`dash.js:102`); `routeColor(id,'dark')` differs from `routeColor(id,'light')` for all six; `styleFor('nonsense')` returns the `unknown` FALLBACK rather than throwing (`dash.js:82-84`).
- **`frontend/src/lib/theme.test.js` (NEW, ~25 lines)** — pure, no DOM needed for the constant: assert `THEME_KEY === 'meander:theme'` (`lib/theme.js:14`) and that `frontend/index.html` contains that exact string (`index.html:28`). `index.html:22-23` says in terms that "the two must agree on the key name" and nothing checks it. Also assert `frontend/src` contains **no other** `localStorage.setItem` call site than `theme.js:29` — the storage rule, gated. This is what would have caught `pwa-gate.mjs:255`'s second key.

### T5 — the browser gate as its own CI job

`ci.yml:148` new job `frontend-browser-gate` (full YAML in the plan, §2.3): `npm ci` → `google-chrome --version` → `npm run gate`. Separate from the `frontend` job at `ci.yml:123-147` so a Chrome-environment failure never reads as a unit-test failure. Plus `deploy.yml` after `:56`, and `Makefile` `gate` wired into `check` at `:112` with the skip-loudly pattern from `:79-85`.

**Expected first-run numbers to record in the PR, honestly:** total checks `26`; the two known target-size failures from `styles.css:406` and `:527` (fixed in the same change, §2.6); the axe violation count, **which is currently unknown for this frontend** — nothing automated has ever run it. Record whatever it is. `README.md:46`-style claims about gate scores must be updated from the real output, not from `14/14`, which measured a different application.

---

## lib/units.js + UnitsControl — miles and a 12-hour clock, defaulted from the locale, as the second and last permitted localStorage key

**OPEN**

### Sources read on `feat/launch`
- frontend/src/lib/units.js — 159 lines (the whole capability: KEY, validators, detectDistance/detectClock, module singleton + useSyncExternalStore, formatDistance/formatTime/formatElevation)
- frontend/src/components/UnitsControl.jsx — 71 lines (fieldset.chips, two chips__row groups, the storage-disclosure hint, the clearUnits escape hatch)
- frontend/src/lib/format.js — 303 lines (only :1 and :37-41 matter: fmtDist delegates to formatDistance with the implicit singleton)
- frontend/src/components/Controls.jsx — 154 lines (:5 import, :147 the only mount point <UnitsControl />)
- frontend/src/components/BetterLater.jsx — 63 lines (:3 import, :56 the only formatTime consumer; wraps it in <time dateTime>)
- frontend/src/components/RouteCard.jsx — 224 lines (:8 imports fmtDist, :92 and :185 render it — proof no route-facing component subscribes to the store)
- frontend/src/components/ElevationProfile.jsx — 116 lines (:45,:46,:101,:103 hard-code ' m' and never call formatElevation)
- frontend/src/lib/theme.js — 45 lines (currentTheme/useTheme only — proof that on feat/launch there was NO theme localStorage key)
- frontend/src/components/TimeDial.jsx — 119 lines (checked for clock/unit coupling; there is none)
- frontend/src/styles.css — 2024 lines (:11-104 the launch token block; :805-828 fieldset.chips/.chips__row/.chip; :2015-2023 .linkish)

### Plan

## 0. The core architectural decision, and why it departs from `feat/launch`

`feat/launch`'s `units.js` is a **module-level mutable singleton** (`units.js:77-79 let current`) published through `useSyncExternalStore` (`:117-124`). An exhaustive grep of `feat/launch:frontend/` shows `useUnits()` is called in **exactly one place** — `UnitsControl.jsx:15`. Every other consumer goes through `fmtDist()` (`format.js:37-41`), which reads the singleton at call time without subscribing. `RouteCard.jsx:92` and `:185` are the proof.

**Consequence: on `feat/launch`, clicking "Miles" re-rendered `UnitsControl` and nothing else. Every route distance on screen stayed in kilometres until some unrelated state change forced a re-render.** That is a live correctness bug, not a stylistic difference, and porting the store verbatim ports the bug.

**Do not port the store.** Units go in the App reducer, exactly where `theme` already lives, and are threaded as a prop. Two hops maximum (App → RouteRail → RouteRow), which is precisely how `theme` is already threaded. This gives a guaranteed full-tree re-render, makes a missed call site a visible missing prop rather than silently stale output, and introduces no new mechanism into an app whose fetch model (rule 8) must not be restructured. No React context either — context would hide the same dependency the props make explicit.

`lib/units.js` therefore becomes a **pure module**: no mutable singleton, no `useSyncExternalStore`, no `react` import. It is importable in a vitest node environment without touching `localStorage`, which is what makes it testable without adding `jsdom` (the repo has no jsdom, no testing-library, and `ci.yml:140-144` runs bare `vitest run`).

---

## 1. NEW FILES

### 1a. `/Users/poojana/Meander/Meander/frontend/src/lib/units.js` (~150 lines)

Modelled on `lib/theme.js` (57 lines), which is the house pattern for a persisted display preference. Exports:

```
export const UNITS_KEY = 'meander:units'          // colon, matching THEME_KEY at theme.js:14
export const METRIC_24 = Object.freeze({ distance: 'metric', clock: '24', chosen: false })

const VALID_DISTANCE = new Set(['metric', 'imperial'])
const VALID_CLOCK    = new Set(['12', '24'])
const IMPERIAL_REGIONS = new Set(['US', 'GB', 'MM', 'LR'])

export function detectUnits(locale = navigator?.language || 'en')   // -> {distance, clock, chosen:false}
export function readStoredUnits()                                    // -> {distance, clock, chosen:true} | null
export function storeUnits(units)                                    // try/caught, writes {distance, clock} only
export function clearStoredUnits()                                   // try/caught removeItem
export function initialUnits()                                       // readStoredUnits() ?? detectUnits()

export function formatDistance(metres, units = METRIC_24)
export function fmtClockIn(date, units = METRIC_24)
export function formatElevation(metres, units = METRIC_24)
```

Four deliberate deviations from `feat/launch:frontend/src/lib/units.js`:

1. **`detectUnits` takes a locale argument** (launch reads `navigator.language` inline at `:38` and `:50`). Without the argument the function is untestable in node. Verified against the real ICU on this machine: `'en-US'`→US, `'en-GB'`→GB, `'en'`→US, `'my'`→MM, `'si-LK'`→LK, `'xx-YY'`→YY; `'!!'`, `''`, `'en_US'` all throw `RangeError` → caught → metric. Clock detection keeps launch's approach (`units.js:46-57`): ask ICU `resolvedOptions().hour12` rather than infer from region. Verified: `en-US`→true, `en-GB`→false, `de-DE`→false.
2. **No module-level read, no `let current`, no listeners, no `useSyncExternalStore`.** Same reasoning as `App.jsx:65-66`: "resolved at mount rather than at module load, so the read is not a side effect of importing this file."
3. **`readStoredUnits` returns `null`, not a merged object** (launch `read()` at `:59-75` merges detected values into the stored ones field-by-field, so a corrupt `distance` silently inherits the locale's answer while `chosen` still reports `true`). Returning `null` on any invalid field and letting `initialUnits()` fall through to `detectUnits()` is the `theme.js:18-25` contract and is honest about which answer the user actually gave.
4. **Imperial short distances round to the nearest 10 ft, not the nearest foot.** Launch `units.js:134` is `Math.round(metres / M_PER_FOOT)`, which turns a 159 m step into "522 ft" — foot-level precision the router does not have, next to a metric branch that deliberately rounds to 10 m (`format.js:53`). Use `Math.round(metres / M_PER_FOOT / 10) * 10`.

**`formatDistance` metric branch must be byte-identical to the current `format.js:51-55`.** I verified this: launch's metric branch and the current `fmtDist` agree on **every integer metre from 0 to 200 000, zero mismatches**, including the awkward boundaries (999→"1000 m", 1000→"1.0 km", 9999→"10.0 km", 10000→"10 km", 15500→"16 km"). Keep the current tree's expression verbatim rather than launch's rewrite, so the property is obvious on inspection:
```js
if (units.distance !== 'imperial') {
  if (metres < 1000) return `${Math.round(metres / 10) * 10} m`
  return `${(metres / 1000).toFixed(metres < 10000 ? 1 : 0)} km`
}
```
(Note in passing, do **not** fix: 999 m renders as "1000 m" rather than "1.0 km". Both branches share the defect; fixing it here would break the byte-identity property that lets a metric user's output be asserted unchanged. Worth a separate issue.)

**`fmtClockIn`** replaces the hard-coded `hour12: false` at `sun.js:170`:
```js
return new Intl.DateTimeFormat(undefined, {
  hour: units.clock === '12' ? 'numeric' : '2-digit',
  minute: '2-digit',
  hour12: units.clock === '12',
}).format(date)
```
`hour: 'numeric'` in the 12-hour branch avoids "06:24 PM". Verified output at `TZ=UTC`: 18:05Z → 24h `"18:05"`, 12h `"6:05 PM"`; 00:00Z → `"00:00"` / `"12:00 AM"`; 12:00Z → `"12:00"` / `"12:00 PM"`. The 12-hour form **always carries the meridiem**; a bare "6:24" is forbidden, which is the whole substance of the objection recorded at `sun.js:163-164`.

**`formatElevation`** is dead on `feat/launch` (nothing imports it; `ElevationProfile.jsx:45,46,101,103` hard-code `" m"`). Port it anyway and make the Phase-2 `ElevationProfile` port use it — that is the only reason it should exist.

### 1b. `/Users/poojana/Meander/Meander/frontend/src/components/UnitsControl.jsx` (~75 lines)

Structural changes from `feat/launch:frontend/src/components/UnitsControl.jsx`:

- **Two `<fieldset className="chips">`, not one.** Launch puts two independent choices under a single `<legend>Units</legend>` with two unlabelled `.chips__row` divs (`:18-53`). A screen reader hears four toggles in a row with nothing saying they are two separate questions. Use `<legend>Distance</legend>` and `<legend>Clock</legend>`, following `ObjectiveChips.jsx:16-17`.
- **`className="link-button"`, not `"linkish"`.** `.linkish` (`feat/launch:styles.css:2015-2023`) has no `min-height` — a rule-7 violation. `.link-button` (`styles.css:1351-1362`) is `min-height: var(--target)`.
- **The "forget it" button is a sibling of the hint `<p>`, not nested inside it** (launch nests it at `:59-61`). `.link-button` is `align-self: flex-start; margin-top: var(--s2)` — designed as a flex child, as at `RouteDetail.jsx:38`.
- Keep launch's word labels verbatim: `Kilometres` / `Miles` / `24-hour` / `12-hour`. They are long enough that `.chip`'s `padding: var(--s2) var(--s4)` clears 44 px of width without a `min-width` rule; "12h" would not.
- Keep the `aria-pressed` toggle pattern (`.chip[aria-pressed='true']` at `styles.css:792-796`), matching `ObjectiveChips.jsx:25` and `DepartureStrip.jsx:68`, and add `<span className="chip__check" aria-hidden="true">✓</span>` when pressed exactly as `ObjectiveChips.jsx:35-39` does.
- Props: `{ units, onUnits, onClearUnits }`. No hook, no store import.
- Rewrite the storage copy. Launch says "the only thing Meander stores" and `units.js:17-18` says "the first thing this app has ever persisted in a browser" — both false here, because `meander:theme` already exists (`theme.js:14`) and `feat/launch:frontend/src/lib/theme.js` had no storage at all. The correct sentence names both keys:
  > "Saved in this browser, alongside your light/dark choice. Those two words are the only things Meander keeps — never a place, never a route."

### 1c. `/Users/poojana/Meander/Meander/frontend/src/lib/units.test.js` and `units-callsites.test.js`
See the `tests` field.

---

## 2. EXISTING FILES — every edit anchored to the current tree

### `frontend/src/lib/format.js` (209 lines)
| line | edit |
|---|---|
| `:1` (new) | `import { formatDistance } from './units.js'` |
| `:51-55` | `export function fmtDist(metres, units)` → body becomes `return formatDistance(metres, units)`. Signature is `(metres, units = METRIC_24)`. |
| `:173` | `restStopSentence(restStops, units)`; thread into `:185`'s `fmtDist(first, units)` |
| `:188` | `announceRoutes(routes, units)`; thread into `:195` |
| `:202` | `announceSelection(route, units)`; thread into `:208` |
| unchanged | `:15 fmtDur`, `:30 durationParts`, `:41 fmtDurSpoken`. **Minutes and hours are identical in both systems.** Do not add a `units` parameter to any of them; a test pins this. |

### `frontend/src/lib/sun.js` (292 lines)
| line | edit |
|---|---|
| `:165-172` | `fmtClock(date, units)` → delegate to `fmtClockIn(date, units)` from `./units.js`. Delete the `hour12: false` literal. |
| `:163-164` | Rewrite the doc comment. It currently justifies 24-hour on the grounds that "a walker reading '6:24' has to work out whether that is dawn or dusk". The replacement must say that 24-hour is the **default** where the locale implies it, and that the 12-hour form always carries an am/pm marker, which is what actually answers the objection. |
| `:175` | `daylightSentence(times, units)`; thread into `:179`, `:180` |
| `:228` | `daylightGuard({ start, end, lat, lon, units })`; thread into `:256` and `:264` |
| unchanged | `:186 roundMinutes`, `:288 minutesToFinishBySunset` — minutes, not clock times. |

### `frontend/src/App.jsx` (492 lines)
| line | edit |
|---|---|
| `:18` (after) | `import { initialUnits, storeUnits, clearStoredUnits, detectUnits, METRIC_24 } from './lib/units.js'` |
| `:59` (after) | add to `initialState`: `units: METRIC_24,` with a comment matching `:57-58`'s ("A display preference, not an input to the route request. It deliberately does not live in `withRefetch`.") |
| `:68` | `init()` becomes `return { ...state, theme: initialTheme(), units: initialUnits() }` — same "resolved at mount, not at module load" reasoning as `:65-66` |
| `:169` (after) | two new cases, immediately after `case 'theme'`, sharing its comment style:<br>`case 'units': return { ...state, units: { ...state.units, ...action.value, chosen: true } }`<br>`case 'unitsCleared': return { ...state, units: detectUnits() }` |
| `:294` (after) | `const onUnits = useCallback((patch) => { const next = { ...unitsRef.current, ...patch, chosen: true }; storeUnits(next); dispatch({ type: 'units', value: patch }) }, [])` and `const onClearUnits = useCallback(() => { clearStoredUnits(); dispatch({ type: 'unitsCleared' }) }, [])`. Simplest correct form: drop the ref and depend on `[state.units]`, mirroring `onSelect` at `:325-332` which already depends on `state.routes`. |
| `:329` | `announce(announceSelection(route, state.units))` — add `state.units` to the dep array at `:331` |
| `:246` | `announce(announceRoutes(payload?.routes ?? arrived, state.units))`. ⚠ **This is inside the nonce-keyed effect. Read `state.units` from a ref, not from the closure — adding it to the dep array at `:258` would violate rule 8 and double-fire.** Add `const unitsRef = useRef(state.units)` next to `abortRef` at `:188` plus `useEffect(() => { unitsRef.current = state.units }, [state.units])`, and call `announceRoutes(..., unitsRef.current)`. The `eslint-disable-next-line` at `:257` and the dep array `[state.nonce]` at `:258` are untouched. |
| `:409` | `<TripBar ... units={state.units} onUnits={onUnits} onClearUnits={onClearUnits} />` |
| `:417` | `<DepartureStrip ... units={state.units} />` |
| `:442` | `<RouteRail ... units={state.units} />` |
| `:447` | `stepList={<StepList route={selectedRoute} units={state.units} onHighlight={setHighlight} />}` |
| `:448` | `<RouteDetail ... units={state.units} ...>` |
| `:484` | `<FollowMode ... units={state.units} />` |
| **not edited** | `frontend/index.html:25-42`. Units do not affect first paint — no distance or clock renders before a fetch resolves — so there is no flash to prevent and no reason to duplicate the read into the pre-paint script. Mirroring the theme pattern here would add an unnecessary second copy of a storage key to keep in sync. |

### `frontend/src/components/TripBar.jsx` (209 lines)
| line | edit |
|---|---|
| `:6` (after) | `import UnitsControl from './UnitsControl.jsx'` |
| `:91` | add `units, onUnits, onClearUnits` to the destructured props |
| `:201` | **the mount point.** Insert `<UnitsControl units={units} onUnits={onUnits} onClearUnits={onClearUnits} />` as the third child of `drawer-time`, after the mode `<div className="field">` that closes at `:201` and before `</TripDrawer>` at `:202`. |

Why here and not elsewhere: a fifth segment orphans a half-row in `.tripbar__grid` (`styles.css:444-448`, 2 columns, collapsing to 1 below 380 px at `:1459-1463`). `RouteRail.jsx:41`'s empty `.results-head` slot dies with `RouteRail.jsx:34`'s `routes.length === 0` guard, and the clock is needed by `DepartureStrip`, which renders above `#results`. The topbar is a fixed 56 px with three items already. The `time` drawer is the one that already owns "how long" and "how are you travelling"; `.drawer` is `flex-column; gap: var(--s3)` (`styles.css:503-511`), so a third child needs no layout work; and it renders whether or not routes exist. Leave the segment summary at `:112` as `${minutes} min · ${verb}` — appending a unit clause would ellipsise the primary information inside a ~180 px column.

### `frontend/src/components/DepartureStrip.jsx` (84 lines)
| line | edit |
|---|---|
| `:19` | add `units` to props |
| `:29` | `daylightSentence(times, units)` |
| `:48` | `{fmtClock(recommended, units)}` — and wrap it: `<time dateTime={recommended.toISOString()}>{fmtClock(recommended, units)}</time>` inside the existing `<strong>`. This is `feat/launch:BetterLater.jsx:55-57`'s one genuinely good idea, and it matters more once the visible form is user-selectable. |
| `:76` | `{fmtClock(hour, units)}` |
| CSS note | `.departure__hours` is `flex; flex-wrap: wrap` (`styles.css:1510-1514`) and `.hour` is `min-width: var(--target)` with `font-variant-numeric: tabular-nums` (`:1520-1521`, `:1528`). "12:00 PM" is wider than "12:00" but the row wraps and the chip grows. No CSS change required; verify at 320 px. |

### `frontend/src/components/DaylightGuard.jsx` (55 lines)
| line | edit |
|---|---|
| `:15` | add `units` to props |
| `:26` | `daylightGuard({ start, end, lat: origin.lat, lon: origin.lon, units })` |
| `:454`/`:456` in App | pass `units={state.units}` at `App.jsx:450-456` |

### `frontend/src/components/RouteRail.jsx` (59 lines)
| line | edit |
|---|---|
| `:31` | add `units` to the signature, beside `theme` |
| `:52` (after) | `units={units}` on the `<RouteRow>` |
| `:6-20` | `Skeleton()` needs nothing — it renders no text |

### `frontend/src/components/RouteRow.jsx` (136 lines)
| line | edit |
|---|---|
| `:35` | add `units` to props |
| `:91` | `{fmtDist(route.distance_m, units)}` |
| `:40`, `:70-73` | **unchanged.** `durationParts(route.duration_min)` is minutes. |
| structural | No new DOM. The rule at `:11-34` (only `<span>` inside the button) is untouched — this edit changes the text inside an existing `<span>`. |

### `frontend/src/components/RouteDetail.jsx` (205 lines)
| line | edit |
|---|---|
| `:58` | add `units` to props |
| `:81` | `{fmtDur(route.duration_min)} · {fmtDist(route.distance_m, units)}` — `fmtDur` deliberately un-suffixed |
| `:118` | `{restStopName(stop.type, 1)} · {fmtDist(stop.at_m, units)}` |

### `frontend/src/components/StepList.jsx` (121 lines)
| line | edit |
|---|---|
| `:15` | `function sentence(step, units)` |
| `:23` | `${fmtDist(step.distance_m, units)}` |
| `:24` | `${fmtDist(step.distance_m, units)}` |
| `:72` | add `units` to props |
| `:104` | `{sentence(step, units)}` |
| `:108` | `` ` · ${fmtDist(step.distance_m, units)}` `` |
| `:17`, `:108` | leave the `>= 1` metre threshold. It decides *whether* to show a distance, not what unit it is in; converting it would change which steps carry a distance. |
| `:93-103` | do not touch the `onMouseEnter/Leave/Focus/Blur` handlers — they feed `App.jsx:187 setHighlight` and `MapView.jsx:437-455`. |

### `frontend/src/components/FollowMode.jsx` (245 lines)
| line | edit |
|---|---|
| `:48` | add `units` to props |
| **`:190`** | `{Math.round(closest.distanceM)} m ahead` → `{fmtDist(closest.distanceM, units)} ahead`. **This site is not in the brief's list and does not call `fmtDist`, so a grep-for-`fmtDist` port misses it.** It is the barrier-proximity alert — the single most safety-relevant number in the app — and it would have kept saying "180 m ahead" to a user who chose miles. `BARRIER_RADIUS_M = 200` (`:14`), and `fmtDist`'s 10 m granularity over 0–200 m is no coarser than the existing `Math.round`. |
| `:222` | `{fmtDist(toTurn, units)}` |
| `:227` | `{restStopName(rest.stop.type, 1)} in {fmtDist(rest.inM, units)}` |
| `:231` | **two** calls: `{fmtDist(totalM - remainingM, units)} of {fmtDist(totalM, units)}` |
| `:232` | `fmtDur(remainingMin)` unchanged |
| `:239-241` | privacy copy unchanged — it is about position, and position is still never stored |

### `frontend/src/components/About.jsx` (53 lines)
`:30-33` currently reads "The only thing kept in this browser is whether you chose the light or the dark theme." That sentence becomes false the moment this ships. Replace with: "Two things are kept in this browser: whether you chose the light or the dark theme, and whether you read distances in kilometres or miles. Nothing else — no cookies, no analytics, no location history."

### `frontend/src/components/FirstRun.jsx` (119 lines)
`:112-115` reads "Nothing is stored." — already inaccurate w.r.t. `meander:theme`, and worse with a second key. Replace with "No location is stored. Your coordinates answer this one request and are then discarded." Do not enumerate the keys here; `About` is where that belongs.

### `frontend/src/styles.css` (1720 lines)
Append **one** rule at the end of the file (after `.detail__actions .button--primary:disabled` at `:1717-1720`), as its own banner-comment section — `styles.css:1409-1486` is the responsive block and it sits mid-file, so per house convention a new section goes at the end and carries its own media query if it needs one:
```css
/* ----------------------------------------------------------------- units */

/* Two independent choices, each its own fieldset so a screen reader is told
   they are two questions. Everything else is .chips / .chip, unchanged. */
.units {
  display: flex;
  flex-direction: column;
  gap: var(--s3);
}
```
No hex literal, so `ci.yml:149-170` (`no-hard-coded-colour`) stays green. Nothing else is needed: `fieldset.chips` `:761`, `legend` `:767`, `.chips__row` `:773`, `.chip` `:778`, `.chip[aria-pressed='true']` `:792`, `.chip__check` `:798`, `.field__hint` `:623` and `.link-button` `:1351` all already exist and already satisfy `--target`.

### `frontend/src/a11y.jsx` (107 lines)
No change required — the harness mounts the real `App` and `ROW_SELECTOR` at `:53` is unaffected. Optional: after `waitForRoutes()`, click the "Miles" chip and re-run `axe.run`, so the 12-hour/imperial rendering is audited too. Note the harness is manual-only (zero references in `ci.yml`, `deploy.yml`, `Makefile`, npm scripts), so this buys nothing automated.

### Files deliberately **not** touched
`frontend/index.html` (see above), `lib/dash.js`, `lib/follow.js` (pure geometry, returns metres, no formatting), `lib/theme.js`, `components/MapView.jsx` (renders no distance or clock — `:540-544`'s visually-hidden summary names labels and dash patterns only), `components/TimeDial.jsx`, `components/StatusBanner.jsx`, `components/Ribbon.jsx`, `components/VerificationMeter.jsx`, `components/PlaceInput.jsx`, `api/client.js` (**the request body stays metric and unchanged — units are a display preference and must never reach `buildRouteRequest` at `client.js:28-38`**), `api/mock.js`.

---

## 3. COMPLETE ENUMERATION — every distance and time rendered by the current frontend

### Distances (metres → "m"/"km"), 14 call sites in 6 files
| # | file:line | expression |
|---|---|---|
| 1 | `frontend/src/components/RouteRow.jsx:91` | `{fmtDist(route.distance_m)}` in `.route__sub` |
| 2 | `frontend/src/components/RouteDetail.jsx:81` | `{fmtDist(route.distance_m)}` in `.detail__figures` |
| 3 | `frontend/src/components/RouteDetail.jsx:118` | `{fmtDist(stop.at_m)}` per rest stop |
| 4 | `frontend/src/components/StepList.jsx:23` | `` `…and follow it for ${fmtDist(step.distance_m)}.` `` |
| 5 | `frontend/src/components/StepList.jsx:24` | `` `…then continue for ${fmtDist(step.distance_m)}.` `` |
| 6 | `frontend/src/components/StepList.jsx:108` | `` ` · ${fmtDist(step.distance_m)}` `` in `.step__meta` |
| 7 | **`frontend/src/components/FollowMode.jsx:190`** | **`{Math.round(closest.distanceM)} m ahead` — hand-formatted, bypasses `fmtDist` entirely** |
| 8 | `frontend/src/components/FollowMode.jsx:222` | `{fmtDist(toTurn)}` "to the next turn" |
| 9 | `frontend/src/components/FollowMode.jsx:227` | `{fmtDist(rest.inM)}` |
| 10 | `frontend/src/components/FollowMode.jsx:231` | `{fmtDist(totalM - remainingM)}` |
| 11 | `frontend/src/components/FollowMode.jsx:231` | `{fmtDist(totalM)}` (same line, second call) |
| 12 | `frontend/src/lib/format.js:185` | `` `The first is ${fmtDist(first)} in.` `` in `restStopSentence()` — currently an unused export |
| 13 | `frontend/src/lib/format.js:195` | `${fmtDist(r.distance_m)}` in `announceRoutes()` → the live region at `App.jsx:372` |
| 14 | `frontend/src/lib/format.js:208` | `${fmtDist(route.distance_m)}` in `announceSelection()` → same live region |
| — | `frontend/src/lib/format.js:51-55` | the `fmtDist` definition itself |

### Clock times (HH:MM), 6 call sites in 2 files
| # | file:line | expression | reaches the screen at |
|---|---|---|---|
| 15 | `frontend/src/components/DepartureStrip.jsx:48` | `{fmtClock(recommended)}` | "Leave at 18:05" |
| 16 | `frontend/src/components/DepartureStrip.jsx:76` | `{fmtClock(hour)}` | each of the six hour chips |
| 17 | `frontend/src/lib/sun.js:179` | `fmtClock(times.sunrise)` in `daylightSentence()` | `DepartureStrip.jsx:54` `.departure__daylight` |
| 18 | `frontend/src/lib/sun.js:180` | `fmtClock(times.sunset)` in `daylightSentence()` | same |
| 19 | `frontend/src/lib/sun.js:256` | `(${fmtClock(to.times.sunset)} today)` in `daylightGuard()` | `DaylightGuard.jsx:38` |
| 20 | `frontend/src/lib/sun.js:264` | `(${fmtClock(from.times.sunrise)} today)` in `daylightGuard()` | same |
| — | `frontend/src/lib/sun.js:165-172` | the `fmtClock` definition itself |

### Durations (minutes/hours) — identical in both systems, must NOT be converted
`RouteRow.jsx:40,71,72` (`durationParts`) · `RouteDetail.jsx:81` (`fmtDur`) · `FollowMode.jsx:232` (`fmtDur`) · `TripBar.jsx:112` (`${minutes} min`) · `TimeDial.jsx:9-14 PRESETS`, `:39-40`, `:66-68` · `FirstRun.jsx:103` · `StatusBanner.jsx:69` ("Add 30 minutes") · `format.js:15-22`, `:30-38`, `:41-49` · `sun.js:253`, `:261` ("about N minutes after sunset"). A test pins this.

### Explicitly not a distance or a time
`About.jsx:37` — `cache.segments_scored.toLocaleString()` is a count. `MapView.jsx:478`, `:535` — animation durations in ms.

---

## 4. TOKEN MAPPING

`UnitsControl.jsx` on `feat/launch` contains **zero** token references — no inline styles, no CSS-in-JS. Every launch token below reaches this capability through the CSS rules backing its class names (`feat/launch:styles.css:805-828` for `.chips`/`.chips__row`/`.chip`, `:2015-2023` for `.linkish`). The current tree's equivalents already exist and already use the correct tokens, so **the port needs one new five-line rule and imports no launch token at all**. The full table is given because an implementer reading launch CSS will meet these names.

### Spacing — launch `--space-N` (8 steps) → current `--sN` (8 steps). **The scales diverge at step 5.**
| launch | value | current | value | note |
|---|---|---|---|---|
| `--space-1` | 4px | `--s1` | 4px | exact |
| `--space-2` | 8px | `--s2` | 8px | exact — used by `.chips__row` gap, `.chip` gap |
| `--space-3` | 12px | `--s3` | 12px | exact — use for `.units` gap |
| `--space-4` | 16px | `--s4` | 16px | exact — used by `.chip` inline padding |
| `--space-5` | 24px | **`--s6`** | 24px | ⚠ **not `--s5`.** `--s5` is 20px; the current scale inserts a step launch does not have. Mapping by number is wrong from here down. |
| `--space-6` | 32px | `--s7` | 32px | ⚠ off-by-one |
| `--space-7` | 48px | **none** | — | largest current step is `--s8`=40px. Use `--s8`, or `calc(var(--s8) + var(--s2))` if 48 is load-bearing. Not needed by this capability. |
| `--space-8` | 64px | **none** | — | use `calc(var(--s8) + var(--s6))`. Not needed by this capability. |

### Type — launch `--text-N` (6 steps) → current `--t-*` (7 named steps)
| launch | value | current | value | note |
|---|---|---|---|---|
| `--text-1` | 0.875rem (14px) | **literal `0.875rem`** | — | ⚠ **`--t-small` is 0.8125rem (13px), not 14px.** The current `.chip` (`styles.css:779`) and `fieldset.chips legend` (`:768`) both hard-code `0.875rem` rather than use a token. Match them; do not "improve" it to `--t-small` or the chips shrink relative to `ObjectiveChips`. |
| `--text-2` | 1rem | `--t-body` | 0.9375rem | nearest |
| `--text-3` | 1.125rem | `--t-h3` | 1.0625rem | nearest |
| `--text-4` | 1.375rem | `--t-h2` | 1.375rem | exact |
| `--text-5` | 1.75rem | `--t-metric` | 1.75rem | exact |
| `--text-6` | 2.25rem | `--t-display` | 2rem | nearest |
| — | — | `--t-micro` | 0.75rem | current-only |

### Radius
| launch | value | current | value |
|---|---|---|---|
| `--radius-chip` | 999px | `--r-pill` | 999px — exact, used by `.chip` |
| `--radius-card` | 8px | `--r-sm` | 8px — exact |
| `--radius-control` | 6px | `--r-sm` | 8px — nearest; no 6px step exists |
| — | — | `--r-md` 12px, `--r-lg` 16px | current-only |

### Surface and ink — several are **renames**, and `--ink` is the trap
| launch | launch value | current | current value | note |
|---|---|---|---|---|
| `--ink` | **`#14213d`** (navy) | `--ink` | **`#16241c`** (dark green) | ⚠ **same name, different colour.** The forbidden hex. Use the token; never copy the value. |
| `--ink-muted` | `#545f71` | **`--ink-2`** | `#55645a` | renamed — used by `.field__hint` (`styles.css:624`) |
| `--page` | `#f7f4ee` | **`--paper`** | `#f6f3ec` | renamed |
| `--recessed` | `#f2eee5` | **`--sunken`** | `#ede9df` | renamed |
| `--raised` | `#fffdf8` | `--raised` | `#fffefa` | same name, new value — used by `.chip` background |
| `--rule` | `#ddd6c6` | `--rule` | `#dcd5c6` | same name, new value |
| `--rule-strong` | `#c3bdae` | `--rule-strong` | `#c4bca8` | same name, new value — used by `.chip` border |
| `--selected-border` | `#8fa0bd` | **none** | — | **no equivalent.** Use `--accent` (`#2f7d53`), which is exactly what `.chip[aria-pressed='true']` at `styles.css:792-796` already does (border-color + inset ring). |
| `--warn-border` | `#cf9f88` | **`--warn-rule`** | `#d3a184` | renamed |
| `--warn-ground` / `--warn-ink` | | same names | new values | |
| `--map-casing` | `#ffffff` | **none** | — | not needed by this capability |
| — | — | `--brand`, `--brand-hover`, `--brand-on`, `--brand-tint`, `--ok-ink` | | current-only; `--brand-tint` is the pressed-chip fill, `--ok-ink` the check glyph |

### Route palette — same six names, six different values. Not used by this capability; listed so no launch hex is ever pasted.
| name | launch | current (light) | current (dark) |
|---|---|---|---|
| `--route-fastest` | `#2f6fd0` blue | `#c2703d` | `#e8a46f` |
| `--route-scenic` | `#2e8b57` | `#2f7d53` | `#6fc38e` |
| `--route-accessible` | `#7a4fc4` | `#5b6ecf` | `#95a4f0` |
| `--route-quiet` | `#b06a1f` | `#8a5cb4` | `#c2a0e8` |
| `--route-shade` | `#12756c` | `#1e7a78` | `#63c4be` |
| `--route-air` | `#b03050` | `#b0455f` | `#ee8aa0` |
| `--score-scenic/air/shade` | aliases of the above | **deleted** | use `--route-*` directly |

### Unchanged across both branches
`--target: 44px` (exact — `.chip`'s `min-height`), `--font-display`, `--font-body`.

### Not tokens but part of the same port
| launch | current |
|---|---|
| `.linkish` (`feat/launch:styles.css:2015-2023`) — no `min-height`, a rule-7 violation | **`.link-button`** (`styles.css:1351-1362`) — `min-height: var(--target)` |
| `--safe-top/right/bottom/left` (`feat/launch:styles.css:98-101`) | absent on `main`; Phase 3, out of scope here |

### Theming mechanism
Launch themed via `@media (prefers-color-scheme: dark)`. The current tree themes via `[data-theme='dark']` (`styles.css:66`), stamped pre-paint by `index.html:39`. Any dark-mode rule copied from launch CSS must be re-targeted. This capability adds no colour, so nothing to re-target.

---

## 5. PROJECT RULES AND HOW THIS SATISFIES EACH

**Rule 1 — a missing OSM tag means UNKNOWN, never "accessible"; `null` ≠ `0` ≠ `[]`.** `formatDistance(null | undefined | NaN)` returns `'—'`, never `'0 m'` / `'0 ft'`. This is asserted for both unit systems (test 3). No unit conversion touches `route.scores.*`, `rest_stops`, `confidence` or `scoring_method`; `restStopSummary` (`format.js:133-137`) and the `route.rest_stops == null` branch at `RouteDetail.jsx:106-112` are untouched. `formatElevation` likewise returns `'—'` for null rather than `'0 m'`, which matters because the Phase-2 `ElevationProfile` port will feed it `ascent_m` from a profile that is `null` on the blocked-route path (`backend/main.py:637-650`).

**Rule 2 — colour is never the only differentiator.** The four chips carry fill + border + inset ring + font-weight + a `✓` glyph (`styles.css:792-804`, `chip__check` at `:798`), identical to `ObjectiveChips`. The rendered strings themselves are the differentiator between systems: "km"/"m" versus "mi"/"ft", "18:05" versus "6:05 PM". Nothing about units is signalled by colour anywhere.

**Rule 3 — `confidenceSentence()` stays visible and stays the source of truth.** Untouched. `format.js:68-100` takes no `units` parameter and renders no distance.

**Rule 4 — the route list is a complete text substitute for the map.** Every one of the 20 enumerated sites is in the panel, the rail, the detail, the step list or the live region. `MapView` renders no distance or clock, so no map-only unit exists. `announceRoutes` and `announceSelection` (`format.js:188`, `:202`) carry units through to the single live region at `App.jsx:372-374`, so a screen-reader user who chose miles hears miles. No second live region is opened.

**Rule 5 — privacy; `localStorage` is for theme and units only.** Exactly one new key, `meander:units`, bringing the total to two. The stored value is a two-field JSON object whose fields are validated against `Set(['metric','imperial'])` and `Set(['12','24'])` on both write and read, so the key is **structurally incapable of holding a coordinate** — and that is asserted by a regex test on the raw stored string, not merely claimed in a comment as it is at `feat/launch:units.js:24-25`. Nothing is written until the user clicks a chip; the detected default is recomputed each load and never persisted, so a user who expresses no preference leaves no trace. `clearStoredUnits()` removes the key entirely. Both accesses are try/caught (`theme.js:19-25` precedent) so Safari private mode degrades to a tab-lifetime preference. A source-scan test asserts that `localStorage` appears in exactly two files. The copy at `About.jsx:30-33` and `FirstRun.jsx:112-115` is corrected so the UI's promise matches the code. `DESIGN-HANDOFF.md:562` (`meander:profile`) and `:642` (`meander:places`) describe a third and fourth key — those features stay deferred; this rule now has a test standing behind it.

**Rule 6 — no new third-party runtime requests.** `Intl.DateTimeFormat` and `Intl.Locale` are platform built-ins. No package added to `frontend/package.json`. No `@font-face`, no CDN, no network call of any kind.

**Rule 7 — all interactive targets ≥ 44 × 44 px.** The four chips use `.chip` (`min-height: var(--target)`, `styles.css:781`) and word labels long enough to clear 44 px horizontally with `padding: var(--s2) var(--s4)`. The "forget it" control uses `.link-button` (`min-height: var(--target)`, `:1354`) rather than launch's `.linkish`, which has none. No new control uses `.theme-toggle` or `.preset`, the two pre-existing 36 px violations (`styles.css:406`, `:527`).

**Rule 8 — do not restructure the fetch model.** No change to `DEBOUNCE` (`App.jsx:26-34`), to `withRefetch` (`:71-73`), to the nonce-keyed effect (`:206-258`), to the dep array `[state.nonce]` (`:258`), to the `eslint-disable-next-line` (`:257`), or to the abort ordering (`:211-213`). `case 'units'` follows the `theme` precedent (`:166-169`) and returns a plain spread — it never calls `withRefetch`, so changing units cannot trigger a request. `state.units` never reaches `buildRouteRequest` (`App.jsx:220-227`, `client.js:28-38`); the wire format stays metric. The one point of contact with the effect is `announceRoutes` at `:246`, and it reads through a ref precisely so the dep array does not grow.

**Rule 9 — the full gate stays green at every commit.** New CSS contains no hex, so `ci.yml:149-170` passes. No Python touched, so `backend`, `suite-opens-no-sockets`, `deploy-image-is-torch-free` and `infrastructure` are unaffected. `npm test` gains three files and `npm run build` is unaffected. `make check` (`Makefile:72`) covers `test-frontend` (`:53-54`) and `build` (`:56-57`), so the new tests run in both `make check` and `ci.yml:140-147`. There is no ESLint config anywhere in the repo, so the only frontend gates are vitest and the Vite build — which is exactly why the call-site enforcement below has to be a test rather than a lint rule.

---

## 6. WHAT THE BRIEF GETS WRONG

**(a) "Every distance and time in `RouteRow`, `RouteDetail`, `StepList` and `DepartureStrip`" (`docs/RELEASE-PROMPT.md:324-325`) — the list is incomplete, and the omissions include the most safety-critical number in the app.** Those four files hold 7 of the 20 sites. Missing: `FollowMode.jsx` (5 distance sites at `:190`, `:222`, `:227`, `:231`×2), `lib/format.js` (3 at `:185`, `:195`, `:208`, two of which write the live region), `lib/sun.js` (4 clock sites at `:179`, `:180`, `:256`, `:264` — and note that `DepartureStrip`'s own daylight line and `DaylightGuard`'s entire warning are produced *inside `sun.js`*, so editing `DepartureStrip` alone leaves them 24-hour), and `DaylightGuard.jsx`, which renders clock times without containing a formatter call at all. **`FollowMode.jsx:190` is the worst of these**: `{Math.round(closest.distanceM)} m ahead` is hand-formatted, so it does not appear in a grep for `fmtDist`, and it is the barrier-proximity alert.

**(b) "This is the second permitted `localStorage` key" (`:323`) — true of the current tree, but the launch source says the opposite and its comments must not be copied.** `feat/launch:frontend/src/lib/units.js:17-18` states this is "the first thing this app has ever persisted in a browser", and `UnitsControl.jsx:57` renders "the only thing Meander stores" to the user. Both were correct on `feat/launch`, where `lib/theme.js` (45 lines) contains no `localStorage` at all — it only *reads* `data-theme` off the document. Ported verbatim, that sentence becomes a visible false claim next to `About.jsx:29-33`. Related: the launch key is `'meander.units'` with a **dot** (`units.js:28`) while the current theme key is `'meander:theme'` with a **colon** (`theme.js:14`). Use the colon.

**(c) The brief presents `lib/units.js` as portable at 159 lines. It is not portable as written — it contains a correctness bug.** The `useSyncExternalStore` store (`units.js:81-124`) is subscribed by exactly one component on all of `feat/launch` (`UnitsControl.jsx:15`, verified by exhaustive grep). Every route-facing distance goes through `format.js:37-41 fmtDist`, which reads the module singleton without subscribing — `RouteCard.jsx:92` and `:185` are the proof. Changing units therefore re-rendered the control and left every distance on screen stale. Roughly 40 of the 159 lines (the singleton, the listener set, `emit`, `subscribe`, `useUnits`) must be deleted, not ported.

**(d) `formatElevation` (`units.js:154-159`) is dead code on `feat/launch`.** Nothing imports it. `ElevationProfile.jsx` — the one component that renders metres of climb — hard-codes `" m"` at `:45`, `:46`, `:101` and `:103` and never calls it. So the launch branch shipped an elevation profile that ignored the user's unit choice. Port `formatElevation`, but only on condition that the Phase-2 `ElevationProfile` port actually uses it.

**(e) `units.js:8-9` claims "the UK reads distance in miles and time in 12 hours" — its own code disagrees.** `detectClock()` (`:46-57`) asks ICU rather than the region, and ICU resolves `en-GB` to `hour12: false`. Verified. So a UK browser gets miles + a 24-hour clock. That is the right answer; the comment is wrong and should not be copied.

**(f) A behaviour worth surfacing before it is shipped, not a brief error:** `Intl.Locale('en').maximize().region` is `'US'`, so a browser reporting a bare `en` (no region) defaults to **miles**. Verified. That is launch's behaviour. It is defensible only because the locale is the default and not the decision — which makes the visibility of `UnitsControl` a requirement rather than a nicety, and is the strongest argument for the `drawer-time` mount over the `RouteRail` slot that vanishes in the empty state.

### Risks and the rules that constrain it

## What could break

**1. A missed call site renders the wrong unit silently.** There are 20 sites across 8 files and no ESLint anywhere in the repo (`find . -name '*eslint*'` returns nothing; the `eslint-disable-next-line` at `App.jsx:257` is inert). A `units` parameter defaulted to `METRIC_24` means an un-threaded call site keeps compiling, keeps rendering, and keeps saying "1.4 km" to a user who chose miles. Mitigation is `units-callsites.test.js` (see `tests`), which is a source scan in the same spirit as the awk at `ci.yml:158-170`. **Without that test this change is not safe to merge**, because the failure mode is invisible in every existing gate.

**2. `announceRoutes` at `App.jsx:246` is inside the nonce-keyed effect.** The obvious edit — read `state.units` from the closure and add it to the dep array at `:258` — violates rule 8 and double-fires every fetch. Read it from a ref. The dep array `[state.nonce]`, the `eslint-disable-next-line` at `:257` and the abort ordering at `:211-213` must survive the diff byte-for-byte.

**3. The 12-hour clock is the one place this can regress readability.** `sun.js:163-164` is a standing argument for 24-hour: "a walker reading '6:24' has to work out whether that is dawn or dusk." That objection is answered only if the am/pm marker is always present, which is why `hour12: true` must be paired with `hour: 'numeric'` and never post-processed or trimmed. A test asserts the meridiem. Existing rendering at `TZ=UTC` verified: `"18:05"` / `"6:05 PM"`, `"00:00"` / `"12:00 AM"`, `"12:00"` / `"12:00 PM"`.

**4. Layout at 320 px.** `.hour` chips (`styles.css:1516-1529`) grow from "18:00" to "6:00 PM". The row is `flex-wrap: wrap` (`:1512`) so it reflows rather than overflowing, but six wider chips may go to three rows and push `#results` down. `.route__dur` uses `margin-inline-start: auto` (`:1044`) and is unaffected (durations do not change). `.detail__figures` and `.sheet__metric` carry `tabular` (`styles.css:209`) — imperial strings are still tabular-numeric, so no alignment break. Verify at 320 px and 390 px in both themes; `gate.mjs` cannot do this (it is deleted, and per `Makefile:62-70` it measures a layout this branch does not have).

**5. Metric output must not shift by one character.** Verified: the launch metric branch and the current `format.js:51-55` agree on every integer metre from 0 to 200 000 with zero mismatches, including 999→"1000 m", 1000→"1.0 km", 9999→"10.0 km", 10000→"10 km", 15500→"16 km". Keep the current expression verbatim rather than launch's rewrite, and pin it with the parity test. Any refactor that "cleans up" `.toFixed(metres < 10000 ? 1 : 0)` risks breaking a property nothing else would catch.

**6. Adding a third `localStorage` key.** `DESIGN-HANDOFF.md:562` (`meander:profile`) and `:642` (`meander:places`) describe two more. Rule 5 permits exactly two. The source-scan test makes a third key a CI failure rather than a review question — but it also means whoever implements saved places must consciously delete that assertion, which is the point.

**7. `enrichment_pending` interaction (already broken, do not make it worse).** The backend sets `enrichment_pending: true` on first-pass routes and the UI has never read it (`models.py:184`), so `rest_stops: []` renders "No rest stops found along this route" during the enrichment window (`RouteDetail.jsx:111-112`). Rest-stop *distances* (`RouteDetail.jsx:118`) now go through `formatDistance`. Do not "fix" the null/empty branches while threading units — that is a separate change with its own reasoning, and conflating them makes both harder to review.

**8. Fifth TripBar segment.** If anyone reaches for one instead of the `drawer-time` mount: `.tripbar__grid` is `minmax(0,1fr) minmax(0,1fr)` (`styles.css:444-448`), collapsing to one column below 380 px (`:1459-1463`). A fifth segment orphans a half-row, and a new `key` falls through `Icon`'s default at `TripBar.jsx:54-58` to the hamburger glyph.

## Project rules that constrain this

All nine at `docs/RELEASE-PROMPT.md:80-98` are addressed item-by-item in §5 of the plan. The four that actively shape the design rather than merely permitting it:

- **Rule 5 (privacy)** forces the validated-enum storage shape, the opt-in-only write, the `clearStoredUnits` escape hatch, and the copy edits at `About.jsx:30-33` and `FirstRun.jsx:112-115`. It is also why the key must be provably incapable of holding a coordinate, asserted rather than commented.
- **Rule 8 (fetch model)** forces the reducer-plus-prop design over any store, forces `case 'units'` to bypass `withRefetch`, forces `state.units` out of `buildRouteRequest`, and forces the ref at `App.jsx:246`.
- **Rule 4 (text substitute for the map)** forces `announceRoutes`/`announceSelection` to take units, which is what drags `format.js` and the live region into scope — the part the brief's four-file list omits.
- **Rule 1 (UNKNOWN ≠ a value)** forces `'—'` for null/NaN in both systems, in `formatDistance` and `formatElevation` alike.

Plus one constraint the brief does not state: **the repo has no jsdom and no testing-library**, and `ci.yml:140-144` runs bare `vitest run` in a node environment. Every test below must therefore be pure-function or source-scan. That is the reason `detectUnits` takes a locale argument and the reason `units.js` must not read storage at module load.

### Tests

## New file: `/Users/poojana/Meander/Meander/frontend/src/lib/units.test.js`

Node environment, no new dependency. `TZ` is already forced to `UTC` by `frontend/vite.config.js:33`, so clock assertions are deterministic; the *locale* is not pinned (it resolves to `en-US` on this machine and on GitHub runners), so locale-sensitive assertions must be written as patterns, not exact strings.

1. **`formatDistance` metric parity — the "nothing changes for a metric user" gate.** Inline the pre-port `fmtDist` from `format.js:51-55` as a frozen reference, then loop `for (let m = 0; m <= 200000; m += 1)` asserting `formatDistance(m, METRIC_24) === reference(m)`. I ran this: zero mismatches. Add an explicit table for the boundaries so a failure names itself: 0, 5, 9, 12, 95, 999→`'1000 m'`, 1000→`'1.0 km'`, 9994, 9999→`'10.0 km'`, 10000→`'10 km'`, 10500→`'11 km'`, 15500→`'16 km'`, 42195.
2. **`formatDistance` imperial.** `IMPERIAL = {distance:'imperial', clock:'12'}`. Assert: 0→`'0 ft'`; 30.48→`'100 ft'`; 159→`'520 ft'` (10-ft granularity, the deliberate deviation from `feat/launch:units.js:134`); 160→`'0.1 mi'`; 1609.344→`'1.0 mi'`; 16093.44→`'10 mi'`; 42195→`'26 mi'`. Plus a monotonicity property across 0..50000 step 7: the numeric part must never decrease as metres increase (catches a mis-signed threshold at the ft/mi crossover).
3. **UNKNOWN is never zero — rule 1.** `for (const u of [METRIC_24, IMPERIAL]) for (const v of [null, undefined, NaN]) expect(formatDistance(v, u)).toBe('—')`. Same for `formatElevation`. Assert explicitly that no output equals `'0 m'` or `'0 ft'` for those inputs.
4. **`fmtClockIn`.** For `new Date('2026-08-08T18:05:00Z')`: 24h `toBe('18:05')`; 12h `toMatch(/^6:05\s?(AM|PM|am|pm|a\.m\.|p\.m\.)$/i)` and `not.toMatch(/^18/)`. Midnight `T00:00:00Z`: 24h `toBe('00:00')` — a regression guard against `'24:00'`, which some ICU builds emit for `hour12: false`; 12h must contain `12:00` and a meridiem. Noon `T12:00:00Z`: 12h must contain `12:00` and a meridiem. **A dedicated assertion that the 12-hour output always matches `/(AM|PM|am|pm|a\.m\.|p\.m\.)/i`** across all 24 hours of a day — this is the test that keeps `sun.js:163-164`'s objection answered.
5. **`detectUnits(locale)` — the reason the argument exists.** Verified against real ICU: `'en-US'`→imperial, `'en-GB'`→imperial + clock `'24'` (contradicting `feat/launch:units.js:8-9`; assert the real behaviour and cite it), `'en'`→imperial (maximizes to US — assert this deliberately so the surprise is documented), `'my'`→imperial (MM), `'si-LK'`→metric, `'ta-LK'`→metric, `'de-DE'`→metric + clock `'24'`, `'xx-YY'`→metric. Invalid tags `'!!'`, `''`, `'en_US'` all throw `RangeError` inside `Intl.Locale` — assert `detectUnits` returns metric and **does not throw**. Assert `detectUnits(...).chosen === false` always.
6. **Storage round-trip.** `beforeEach` installs a Map-backed `globalThis.localStorage` stub (`getItem`/`setItem`/`removeItem`); `afterEach` deletes it. Assert: `readStoredUnits()` → `null` when absent; round-trips all four combinations with `chosen: true`; returns `null` for `'{"distance":"furlongs","clock":"12"}'`, for `'{"clock":"12"}'`, for `'not json'`, for `'null'`, for `'[]'`; `clearStoredUnits()` removes the key and `initialUnits()` then falls through to the detected default with `chosen: false`.
7. **Never throws when storage throws — the Safari private-mode case.** Stub whose `getItem`/`setItem`/`removeItem` all throw. Assert `readStoredUnits()` → `null`, `storeUnits({...})` → no throw, `clearStoredUnits()` → no throw, `initialUnits()` → a valid object. Mirrors `theme.js:19-25`, `:27-34`.
8. **The key cannot hold a coordinate — rule 5, asserted rather than commented.** For all four combinations: call `storeUnits`, read the raw string back off the stub, and assert `toMatch(/^\{"distance":"(metric|imperial)","clock":"(12|24)"\}$/)`. Then attempt `storeUnits({distance:'metric', clock:'24', lat: 6.9271, lon: 79.8612, chosen: true})` and assert the raw stored string still matches that regex — i.e. extra fields are dropped by construction. `feat/launch:units.js:24-25` only claims this in prose.
9. **Key discipline.** `import { THEME_KEY } from './theme.js'` and `{ UNITS_KEY }` from `./units.js`; assert `UNITS_KEY === 'meander:units'`, `THEME_KEY === 'meander:theme'`, and `UNITS_KEY !== THEME_KEY`. Guards against re-importing launch's dotted `'meander.units'`.

## New file: `/Users/poojana/Meander/Meander/frontend/src/lib/units-callsites.test.js`

A source scan with `node:fs` + `new URL('../components/X.jsx', import.meta.url)`. No dependency, no jsdom. It exists because the repo has **no ESLint**, so nothing else can catch a missed call site. Same class of gate as the awk at `ci.yml:158-170`.

10. **No single-argument `fmtDist`.** Across `components/RouteRow.jsx`, `RouteDetail.jsx`, `StepList.jsx`, `FollowMode.jsx`, `lib/format.js`: assert zero matches for `/\bfmtDist\(\s*[^,)]+\)/`. (`fmtDist(totalM - remainingM, units)` has a comma before `)` so it does not match; the definition `fmtDist(metres, units = METRIC_24)` likewise does not.) Failure message must name the file and the matched text.
11. **No single-argument `fmtClock`.** Across `components/DepartureStrip.jsx` and `lib/sun.js`: zero matches for `/\bfmtClock\(\s*[^,)]+\)/`.
12. **No hard-coded `hour12`.** `lib/sun.js` must not contain `hour12: false` or `hour12: true`; the value must be computed from `units.clock`.
13. **No hand-formatted metres.** `components/FollowMode.jsx` must not contain the literal `' m ahead'` — the exact string at the current `:190`. Generalise with `/\}\s*m\s+ahead/` and `/Math\.round\([^)]*\)\}\s*m\b/` across the component set.
14. **Exactly two `localStorage` files — rule 5 as a gate.** Walk every `.js`/`.jsx` under `frontend/src`, collect those containing `localStorage`, and assert the set is exactly `{'lib/theme.js', 'lib/units.js'}`. Separately read `frontend/index.html` and assert its only `meander:` literal is `meander:theme` (the pre-paint script at `:28`) — i.e. nobody duplicated the units read into first paint.

## Extend: `/Users/poojana/Meander/Meander/frontend/src/lib/sun.test.js` (255 lines)

**No existing test breaks.** `daylightSentence` is called at `:79`, `:87`, `:102` — all polar/null cases with no clock string. `daylightGuard` is called at `:114`, `:124`, `:135`, `:146`, `:156`, `:171`, `:183`, `:193`, `:204` and the only text assertion that could touch a clock is `:130`'s `/finishes about 2[0-9] minutes after sunset/`, which stops before the parenthetical. With `units = METRIC_24` as the default, all nine keep passing unchanged.

15. Add to the `daylightGuard` describe (after `:132`): the same London 2026-03-20 17:50→18:37 case with `units: {distance:'metric', clock:'12'}` — assert `guard.text` matches `/(AM|PM|am|pm)/i` and does not match `/\(18:/`. Then the same case with `METRIC_24` — assert it matches `/\(18:1\d today\)/`, pinning the pre-port string byte-for-byte.
16. Add to the `daylightSentence` describe: a non-polar London instant — `daylightSentence(t, METRIC_24)` `toMatch(/^Daylight today: 0\d:\d\d – 1\d:\d\d\.$/)`; with `clock:'12'` it must contain two meridiem markers and no `18:`.
17. Add a `fmtClock` describe (the function has no direct test today): 24h at `T18:05Z` `toBe('18:05')`; 12h contains `6:05` and a meridiem; `fmtClock(new Date('nope'), units)` → `null`; `fmtClock('2026-01-01', units)` → `null` (not a `Date`).

## New file: `/Users/poojana/Meander/Meander/frontend/src/lib/format.test.js`

There is no `format.test.js` today. Three suites, all rule-facing:

18. **Live region carries the chosen unit — rule 4.** A minimal fixture route `{id:'scenic', label:'The green way', status:'ok', duration_min:26, distance_m:2400, confidence:0.8, scoring_method:'clip'}`. `announceRoutes([r], IMPERIAL)` must contain `'mi'` and must not contain `'km'`; `announceRoutes([r], METRIC_24)` the reverse and `toContain('2.4 km')`. Same for `announceSelection`.
19. **Durations are never converted — the guard against a "helpful" implementer.** For every `m` in `[0, 1, 19, 20, 59, 60, 61, 90, 120, 359, 360]`, assert `fmtDur(m)`, `fmtDurSpoken(m)` and `durationParts(m)` produce identical output whether or not a units object is in play, and that none of the three accepts a second parameter that changes anything: `expect(fmtDur(m)).toBe(fmtDur(m, IMPERIAL))`. Also assert `fmtDur.length === 1` — the signature must not have grown.
20. **`restStopSentence` threads units.** `restStopSentence([{type:'bench', at_m:340}], IMPERIAL)` contains `'ft'` and not `'m.'`; with `METRIC_24` it contains `'340 m'`. (Currently an unused export, `format.js:173`; testing it now means the Phase-2/4 features that adopt it inherit the coverage.)

## Where these run

`frontend/package.json:13` `"test": "vitest run"`, picked up by vitest's default `**/*.test.js` include. That script is invoked by `Makefile:53-54` (`test-frontend`, a prerequisite of `make check` at `:72`) and by `.github/workflows/ci.yml:140-144` with `TZ: UTC`. So all six files above run on every push and every PR with no workflow edit. Note `deploy.yml:56` runs only `npm ci && npm run build` and never `npm test` — a pre-existing gap worth naming in `PROGRESS.md`, not worth fixing inside this change.

## Manual verification (cannot be automated here)

`gate.mjs` is deleted (`Makefile:62-70`) and `a11y.jsx` is manual-only (zero references in `ci.yml`, `deploy.yml`, `Makefile` or npm scripts). So record in `frontend/PROGRESS.md`, in the style of `:28`: switch to Miles + 12-hour, reload, confirm the choice survives; confirm every one of the 20 enumerated sites changed together in a single click (no stale kilometre anywhere — this is the regression that `feat/launch` shipped); confirm the six hour chips still fit at 320 px in both themes; open `a11y.html`, click Miles, re-run `axe.run` and confirm zero wcag2a/2aa violations; and confirm in devtools Application → Local Storage that exactly two keys exist and that `meander:units` holds only the two words.

---

# Appendix · the three surveys the specs were written against

## Survey 1

＃ Frontend build, gates and static assets — as-is map

All paths absolute. Repo root `/Users/poojana/Meander/Meander`, `main` @ `46d4772`. `feat/launch` @ `534c863`.

---

## 1. `frontend/package.json` — scripts and dependencies

`/Users/poojana/Meander/Meander/frontend/package.json` (26 lines)

**Scripts** (`:8-15`)

| Script | Command | Line |
|---|---|---|
| `dev` | `vite` | `:9` |
| `dev:mock` | `VITE_MOCK_API=1 vite` | `:10` |
| `build` | `vite build` | `:11` |
| `preview` | `vite preview` | `:12` |
| `test` | `vitest run` | `:13` |
| `test:watch` | `vitest` | `:14` |

There is **no `prebuild` hook and no `check:*` script**. `npm run build` is a bare `vite build`. This is the fact that falsifies `deploy.yml:54-55` (§5 below).

**Dependencies** (`:16-20`)

| Package | Range | Consumer |
|---|---|---|
| `maplibre-gl` | `^5.6.1` | `frontend/src/components/MapView.jsx`; also named as a manual chunk at `frontend/vite.config.js:16` |
| `react` | `^19.1.0` | throughout `frontend/src` |
| `react-dom` | `^19.1.0` | `frontend/src/main.jsx`, `frontend/src/a11y.jsx:14` |

**devDependencies** (`:21-26`)

| Package | Range | Consumer | Verdict |
|---|---|---|---|
| `@vitejs/plugin-react` | `^4.3.4` | `frontend/vite.config.js:2` (import), `:5` (`plugins: [react()]`) | consumed |
| `axe-core` | `^4.12.1` | `frontend/src/a11y.jsx:12` — `import axe from 'axe-core'` | **see below** |
| `vite` | `^6.0.7` | `package.json:9,11,12`; `Makefile:82` | consumed |
| `vitest` | `^4.1.10` | `package.json:13-14`; test block at `frontend/vite.config.js:20-33`; two suites: `frontend/src/lib/follow.test.js`, `frontend/src/lib/sun.test.js` | consumed |

### axe-core — the brief's claim is half right, and the imprecision matters

The brief (`/Users/poojana/Meander/Meander/docs/RELEASE-PROMPT.md:382-384`, restated at `:759`) says:

> "**`axe-core` is a devDependency nothing runs.** Its only consumer is the manual `frontend/a11y.html` harness, which is not even in the Vite build inputs."

**Refuted as literally written; confirmed in substance.** `axe-core` *does* have a real source consumer — `/Users/poojana/Meander/Meander/frontend/src/a11y.jsx:12` imports it and `:85` / `:88` call `axe.run(...)`. So "no consumer in the repo" is false; a `npm uninstall axe-core` would break a checked-in module.

What is true, and is the actionable part:

1. **Nothing automated invokes it.** `grep -rn "a11y" --include="*.yml" --include="Makefile" --include="*.json" --include="*.mjs" --include="*.sh"` over the repo returns **zero** hits. Not in `ci.yml`, not in `deploy.yml`, not a Make target, not an npm script.
2. **`frontend/a11y.html` is not a build input.** `frontend/vite.config.js:11-19` sets `build.rollupOptions.output` only — there is no `rollupOptions.input`, so Vite's default single-entry (`index.html`) applies. Confirmed empirically: the checked-out `frontend/dist/` contains only `index.html`, `assets/index-C_YjsaXL.css`, `assets/maplibre-ChAaPfnC.js`, `assets/index-2a5NEG8E.js` — no a11y chunk. The harness itself documents this at `frontend/a11y.html:10-11`.
3. **Its selector set is already partly stale.** `frontend/src/a11y.jsx:53` is `const ROW_SELECTOR = 'button.route, .card'`. `button.route` matches the current redesign (`frontend/src/components/RouteRow.jsx:53`); `.card` matches nothing on `main` (§8). The comment at `:46-52` explains the two-selector hedge was deliberate for the redesign transition — so **`a11y.jsx` is the one harness someone already ported**, and it is the precedent for what `gate.mjs` needs.

So: **no devDependency is genuinely unconsumed.** The real gap is that the a11y harness is manual-only and half its selectors are dead.

---

## 2. `frontend/vite.config.js` — `VITE_API_PROXY_TARGET` is confirmed dead

`/Users/poojana/Meander/Meander/frontend/vite.config.js` (34 lines)

- **Build inputs:** none declared. `build.rollupOptions` (`:14-18`) sets `output.manualChunks: { maplibre: ['maplibre-gl'] }` only. Default single entry = `frontend/index.html`. `frontend/a11y.html` is therefore excluded.
- **Plugins:** `[react()]` (`:5`). No service-worker plugin (contrast `feat/launch`, §7).
- **Proxy — hard-coded** (`:6-10`):
  ```js
  server: {
    proxy: {
      '/api': { target: 'http://localhost:8000', changeOrigin: true },
    },
  },
  ```
  No `preview.proxy` block at all, so `vite preview` serves the real build with **no `/api` proxy** — every route request 404s against a preview server.
- **Test env** (`:20-33`): `test: { env: { TZ: 'UTC' } }`. Note this is `defineConfig` imported from `'vite'` (`:1`), not `'vitest/config'` — works at runtime, but the `test` key is untyped there.

### The claim: verified

`VITE_API_PROXY_TARGET` is **read nowhere on `main`.** Repo-wide grep (excluding `node_modules`, `dist`) returns exactly two hits, neither of them a read:

- `/Users/poojana/Meander/Meander/docker-compose.yml:78` — `VITE_API_PROXY_TARGET: http://api:8000` (**sets** it)
- `/Users/poojana/Meander/Meander/docs/RELEASE-PROMPT.md:762` — the brief itself

The consumer was dropped in the `66eaef3` merge. On `feat/launch` it existed at `frontend/vite.config.js:11-20`:

```js
const API_PROXY = {
  // localhost is right when the backend runs on the same machine. Under
  // docker compose the API is a different container, so `localhost` here
  // would be the *frontend* container and every /api call would fail with
  // a connection refused that looks like the backend being down.
  '/api': {
    target: process.env.VITE_API_PROXY_TARGET || 'http://localhost:8000',
    changeOrigin: true,
  },
}
```

**Consequence, and it is a live bug not just dead config:** `docker-compose.yml:78` sets the variable precisely so the frontend container proxies to the `api` container. On `main` the variable is ignored and `vite.config.js:8` resolves `http://localhost:8000` *inside the frontend container* — connection refused on every `/api` call, presenting as "the backend is down". The comment that explained this was deleted along with the code. Either restore the `process.env` read or delete `docker-compose.yml:78`; leaving both is the worst state.

Also on `feat/launch` and now absent: `preview: { proxy: API_PROXY, https: devHttps() }` (`feat/launch:frontend/vite.config.js:124`) and the `MEANDER_DEV_CERT`/`MEANDER_DEV_KEY` HTTPS helper (`:111-116`).

---

## 3. `frontend/index.html` — no favicon, no manifest, no apple-touch-icon, no CSP meta

`/Users/poojana/Meander/Meander/frontend/index.html` (55 lines).

Head contents in order: `<meta charset>` (`:4`), `<meta name="viewport" ... viewport-fit=cover>` (`:5`), `<meta name="color-scheme" content="light dark">` (`:6`), `<meta name="description">` (`:7-10`), `<title>` (`:11`), a commented block (`:12-24`) and an inline pre-paint theme script (`:25-42`) that reads `localStorage['meander:theme']` and `prefers-color-scheme`, then stamps `document.documentElement.dataset.theme` and `style.colorScheme`. Body: `#root` (`:45`), a `<noscript>` block (`:46-52`), the module entry `/src/main.jsx` (`:53`).

`grep -niE "favicon|manifest|apple-touch|Content-Security-Policy|theme-color|<link"` over the file returns **nothing**.

| Asset / tag | Present on `main`? |
|---|---|
| `<link rel="icon">` / favicon | **No** |
| `<link rel="manifest">` | **No** |
| `<link rel="apple-touch-icon">` | **No** |
| `<meta name="theme-color">` | **No** |
| `<meta name="apple-mobile-web-app-title">` | **No** |
| CSP `<meta http-equiv>` | **No** |
| Any `<link>` element at all | **No** |

The theme script is inline and unhashed, so **any CSP that adds `script-src 'self'` without `'unsafe-inline'` or a nonce/hash will kill pre-paint theming** and reintroduce the light-flash the comment at `:13-18` exists to prevent. The only CSP in the repo is `frontend/vercel.json:28`, delivered as a header, and it carries `script-src 'self'` — plus a literal `https://REPLACE-WITH-YOUR-RENDER-HOST.onrender.com` placeholder in `connect-src`. That combination is currently unshipped only because nothing deploys via Vercel; `deploy.yml` publishes to S3/CloudFront and sets **no security headers at all**.

For comparison, `feat/launch:frontend/index.html:11-15` had the full set:
```html
<link rel="manifest" href="/manifest.webmanifest" />
<meta name="theme-color" content="#1b2430" />
<link rel="icon" type="image/png" sizes="32x32" href="/favicon-32.png" />
<link rel="apple-touch-icon" href="/apple-touch-icon.png" />
<meta name="apple-mobile-web-app-title" content="Meander" />
```
It had **no** inline theme script — so restoring those five lines is additive and does not conflict with `main:index.html:25-42`.

---

## 4. `frontend/public/`

- **On `main`: does not exist.** `ls frontend/public` → `No such file or directory`. `git ls-tree -r main -- frontend/public` → empty.
- **On `feat/launch`: exists, six files.** `git ls-tree -r feat/launch --name-only -- frontend/public`:

| File | Bytes |
|---|---|
| `frontend/public/apple-touch-icon.png` | 1317 |
| `frontend/public/favicon-32.png` | 387 |
| `frontend/public/icon-192.png` | 2115 |
| `frontend/public/icon-512.png` | 6151 |
| `frontend/public/icon-maskable-512.png` | 3776 |
| `frontend/public/manifest.webmanifest` | 35 lines |

`manifest.webmanifest` declares `name`, `short_name`, `id`/`start_url`/`scope` = `/`, `display: standalone`, `background_color`/`theme_color` `#1b2430`, `categories: ["navigation","travel","health"]`, and three icons (`icon-192` any, `icon-512` any, `icon-maskable-512` maskable).

The icons are **generated, not pasted**: `feat/launch:frontend/scripts/make-icons.mjs` (215 lines) draws them with `node:zlib` only — no `sharp`, no rasteriser dependency (`:1-27`). It notes at `:12-14` that output is committed so a normal build never runs it, and at `:16-21` that the maskable variant is a *different drawing*, not the same artwork reflagged. **Restoring `public/` therefore costs zero new runtime or dev dependencies** — the generator is dependency-free and the PNGs total ~13.7 KB.

Related gaps on `main`, both confirmed by repo-wide `find`: **no `_headers`, no `_redirects`** anywhere. `frontend/dist/` is gitignored (`.gitignore:22`) but a stale build from Aug 4 is sitting in the worktree.

---

## 5. CI and deploy workflows

### `/Users/poojana/Meander/Meander/.github/workflows/ci.yml` (188 lines)

Triggers: `push: branches: [main]` (`:37-38`) and `pull_request` (`:39`). Concurrency keyed on PR number with fallback to ref, `cancel-in-progress: true` (`:44-46`). `permissions: contents: read` (`:48-49`).

**Six jobs.**

| Job | Lines | Steps |
|---|---|---|
| `backend` | `:53-82` | `checkout@v4` `:56`; `setup-python@v5` 3.13 `:57-58`; `pip install -r backend/requirements-dev.txt` `:65`; **Lint** `python -m ruff check backend/ scripts/` `:67-68`; **Tests, with the coverage floor** `python -m pytest backend/tests --cov --cov-report=term:skip-covered` `:79-82` |
| `suite-opens-no-sockets` | `:84-100` | `checkout` `:96`; `setup-python` `:97-98`; `pip install -r backend/requirements-dev.txt` `:99`; **`sudo unshare -n "$(command -v python)" -m pytest backend/tests -q`** `:100` |
| `deploy-image-is-torch-free` | `:102-121` | `checkout` `:107`; `setup-python` `:108-109`; `pip install -r backend/requirements-deploy.txt` `:111`; **torch/open_clip/torchvision must all be absent** — heredoc asserting `importlib.util.find_spec` is `None` for all three, then `import backend.main` `:112-121` |
| `frontend` | `:123-147` | `checkout` `:126`; `setup-node@v4` node 22, npm cache on `frontend/package-lock.json` `:127-128`; `npm ci` `:129-130`; **Tests** `npm test` with `TZ: UTC` `:140-144`; `npm run build` `:146-147` |
| `no-hard-coded-colour` | `:149-170` | `checkout` `:155`; **No hex outside the token blocks** — inline awk over `frontend/src/styles.css` `:157-170` |
| `infrastructure` | `:172-188` | `checkout` `:178`; `setup-python` `:179-180`; `pip install cfn-lint && cfn-lint infra/*.yaml` `:182-188` |

### `/Users/poojana/Meander/Meander/.github/workflows/deploy.yml` (148 lines)

One job, `deploy` (`:31`), `workflow_dispatch` only (`:7-16`) with a `deploy_router` boolean input defaulting false. `concurrency: group: deploy, cancel-in-progress: false` (`:18-20`). `permissions: contents: read, id-token: write` (`:22-24`). Env `AWS_REGION: ap-south-1`, `PROJECT: meander` (`:26-28`).

Steps: `checkout` `:34`; `setup-python` `:39-40`; **Backend tests and lint** `:41-48` (`pip install -r backend/requirements-dev.txt`, `pytest backend/tests`, `ruff check backend/ scripts/`); `setup-node` `:50-51`; **Build the frontend** `:52-56`; **Assume the deploy role** (OIDC) `:58-62`; `amazon-ecr-login@v2` `:64-65`; **Build and push the API image** `:67-78`; **Build and push the router image** (conditional) `:80-95`; **Roll the API service** `:97-118`; **Publish the frontend** `:120-136`; **Prove it is actually serving** `:138-148`.

### Checks that run in CI but NOT in `make check` — exactly three, as the brief says

`make check` = `lint coverage test-frontend build infra-lint` (`Makefile:72`). Mapping each CI job:

| CI job | In `make check`? | Via |
|---|---|---|
| `backend` — Lint | yes | `Makefile:44-45` |
| `backend` — coverage | yes | `Makefile:50-51` |
| `frontend` — tests | yes | `Makefile:53-54` |
| `frontend` — build | yes | `Makefile:56-57` |
| `infrastructure` | yes | `Makefile:59-60` |
| **`suite-opens-no-sockets`** | **no** | — |
| **`deploy-image-is-torch-free`** | **no** | — |
| **`no-hard-coded-colour`** | **no** | — |

Line numbers for the three:

1. **Suite re-run under `sudo unshare -n`** — job `ci.yml:84-100`; the command is **`ci.yml:100`**:
   ```
   - run: sudo unshare -n "$(command -v python)" -m pytest backend/tests -q
   ```
2. **Torch-free import check** — job `ci.yml:102-121`; the assertion block is **`ci.yml:112-121`**, with the install it grades at `ci.yml:111` (`requirements-deploy.txt`, a file `make check` never touches — `Makefile:39-40` installs `requirements-dev.txt`).
3. **Hard-coded-colour gate** — job `ci.yml:149-170`; the awk is **`ci.yml:158-170`**.

This makes **`Makefile:74`** — `@echo "  Green — and this is the whole of CI now, not most of it."` — false. It is five of eight CI checks.

Two further CI/`make` divergences worth folding into the spec, neither in the brief:
- `make check` runs against `$(VENV)` (`Makefile:14-15`), which `make install` populates from `backend/requirements.txt` **with torch** (`Makefile:35-37`). CI installs `requirements-dev.txt` (no torch). So the local and CI import graphs genuinely differ, and the two CLIP tests skip in CI but not locally.
- `deploy.yml:47` runs `python -m pytest backend/tests` with **no `--cov`** — the coverage floor from `pyproject.toml` is not enforced on the deploy path, only in `ci.yml:82`. And `deploy.yml` never runs the frontend test suite at all: `:56` is `npm ci && npm run build`.

### The `deploy.yml:54-55` assertion — quoted, and false

`/Users/poojana/Meander/Meander/.github/workflows/deploy.yml:50-56`:

```yaml
      - uses: actions/setup-node@v4
        with: { node-version: '22', cache: npm, cache-dependency-path: frontend/package-lock.json }
      - name: Build the frontend
        working-directory: frontend
        # `npm run build` runs check:palette, check:permalink and check:offline
        # first; a failure in any of them fails the deploy before anything ships.
        run: npm ci && npm run build
```

Lines `:54-55` are the two comment lines. **All three named gates are absent from `main`:**

- `frontend/package.json:11` is `"build": "vite build"` — no chaining, no `pre` hook.
- There are no `check:palette` / `check:permalink` / `check:offline` scripts (`package.json:8-15`).
- `frontend/scripts/` does not exist on `main`.

The comment describes `feat/launch:frontend/package.json:11`, which really was `"build": "npm run check:palette && npm run check:permalink && npm run check:offline && vite build"`.

**Two of the three could not be restored as-is even if the scripts came back**, because their subjects were deleted in the same merge: `check-permalink.mjs` imports `src/lib/permalink.js` (`feat/launch:frontend/scripts/check-permalink.mjs:20-22`) and `check-offline.mjs` imports `src/lib/offline.js` (`feat/launch:frontend/scripts/check-offline.mjs:24-32`). Neither module exists on `main` — `frontend/src/lib/` holds only `dash.js`, `follow.js`, `follow.test.js`, `format.js`, `sun.js`, `sun.test.js`, `theme.js`.

**Also stale in the same job:** the S3 publish step names files this build never emits. `deploy.yml:128-133` excludes/includes `'sw.js'` and `'*.webmanifest'`, and `:134-136` invalidates `'/sw.js'` and `'/manifest.webmanifest'`. On `main` there is no `sw.js` (deleted by the merge) and no manifest (no `public/`). Harmless today — the `--include` matches nothing and CloudFront happily invalidates absent paths — but it is the same class of lie as `:54-55`: the workflow describes a build that no longer exists. If `public/manifest.webmanifest` is restored (§4), `:128-133` starts working correctly by accident, which is worth knowing before touching it.

---

## 6. The Makefile

`/Users/poojana/Meander/Meander/Makefile` (112 lines). Variables: `VENV ?= .venv` `:14`, `PY ?= $(VENV)/bin/python` `:15`, `FRONT ?= frontend` `:16`.

**The `check` target — `Makefile:72-74`:**

```make
check: lint coverage test-frontend build infra-lint  ## Everything CI runs, fastest failure first
	@echo
	@echo "  Green — and this is the whole of CI now, not most of it."
```

**Its five prerequisites, verbatim:**

```make
lint:  ## ruff over backend/ and scripts/
	$(PY) -m ruff check backend/ scripts/
```
(`:44-45`)

```make
coverage:  ## The suite with the coverage floor from pyproject.toml
	$(PY) -m pytest backend/tests --cov --cov-report=term:skip-covered
```
(`:50-51`)

```make
test-frontend:  ## The frontend suite. TZ is pinned in vite.config.js, not here
	cd $(FRONT) && npm test
```
(`:53-54`)

```make
build:  ## Frontend build
	cd $(FRONT) && npm run build
```
(`:56-57`)

```make
infra-lint:  ## CloudFormation templates. Nothing is deployed; see infra/README.md
	$(VENV)/bin/cfn-lint infra/*.yaml && echo "infra ok"
```
(`:59-60`)

None declares an order-only dependency on `install` / `install-ci`, so `make check` assumes a populated `.venv` and a populated `frontend/node_modules`.

**The Makefile already documents the removal of the browser gates** — `Makefile:62-70`, immediately above `check`:

```make
# The two browser gates — `gate` and `pwa-gate`, driving headless Chrome over
# CDP — used to live here. They went in the reconciliation merge along with the
# frontend they graded: gate.mjs measures a layout this branch does not have,
# and pwa-gate.mjs asserts that a service worker serves the shell, which is
# meaningless on the platform this is now being built for. BLOCKED.md §5 lists
# what comes back and when.
#
# Deleted rather than left pointing at absent files. A make target that fails
# with "No such file or directory" teaches people to skip the gates.
```

This is the honest counterpart to `deploy.yml:54-55`. The Makefile deleted the targets and said so; `deploy.yml` kept the claim and deleted the code. Note the Makefile comment's own assessment — *"gate.mjs measures a layout this branch does not have"* — is confirmed exactly by §8 below.

---

## 7. The gate scripts on `feat/launch`

`frontend/scripts/` does not exist on `main`. On `feat/launch` (read with `git show feat/launch:<path>`):

| File | Lines | What it does |
|---|---|---|
| `frontend/scripts/gate.mjs` | **254** | Phase-5 layout/a11y gate over CDP at 390×844 light+dark plus 1280×800 desktop. Five checks (`:9-13`): route visible without scrolling, no sideways scroll at 320, axe zero wcag2a/2aa/21a/21aa, every target ≥44×44, desktop composition. Loads axe from `node_modules/axe-core/axe.min.js` (`:24-27`) — so it is the automated consumer `axe-core` currently lacks. |
| `frontend/scripts/pwa-gate.mjs` | **544** | Service-worker / offline / install gate over CDP. |
| `frontend/scripts/check-permalink.mjs` | **131** | Permalink round-trip + "decoded state produces a byte-identical API request body" (`:1-10`). Imports `src/lib/permalink.js` (`:20-22`) and lifts `buildRouteRequest` out of `src/api/client.js` by source-slicing (`:26-31`). |
| `frontend/scripts/check-offline.mjs` | **174** | "A saved route is never presented as a current one" (`:1-16`). Imports seven pure functions from `src/lib/offline.js` (`:24-32`). |
| `frontend/scripts/check-palette.mjs` | **72** | Route-palette single-source check. |
| `frontend/scripts/make-icons.mjs` | 215 | Icon generator (§4). Not in the brief's list but in the same directory and dependency-free. |
| `frontend/sw.js` | 290 | The service worker `pwa-gate.mjs` grades. |

`gate.mjs` and `pwa-gate.mjs` were never wired into `feat/launch`'s `package.json` scripts (`feat/launch:frontend/package.json:8-17` lists only `check:palette`, `check:permalink`, `check:offline`, `icons`) — they were Make targets, now deleted per `Makefile:62-70`.

### Where the palette check lives now: inline awk in `ci.yml`

`/Users/poojana/Meander/Meander/.github/workflows/ci.yml:149-170`, quoted in full:

```yaml
  no-hard-coded-colour:
    # DESIGN-HANDOFF §2 requires every colour to be declared once, in the two
    # :root blocks. That is a checkable property, so it is checked rather than
    # trusted — a stray hex in a component rule is exactly the kind of thing
    # that survives review and then breaks dark mode.
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: No hex outside the token blocks
        run: |
          set -euo pipefail
          offenders=$(awk '
            /^:root \{|^\[data-theme=.dark.\] \{/ { inblock = 1 }
            inblock && /^\}/ { inblock = 0; next }
            !inblock && /#[0-9a-fA-F]{3,8}\b/ { print FILENAME ":" NR ": " $0 }
          ' frontend/src/styles.css)
          if [ -n "$offenders" ]; then
            echo "$offenders" >&2
            echo "Hard-coded colour outside the :root blocks. Add a token instead." >&2
            exit 1
          fi
          echo "every colour is declared in the token blocks"
```

**This is a different and weaker check than `check-palette.mjs`. It is not a port.** They do not overlap at all:

| | `check-palette.mjs` (`feat/launch`) | `no-hard-coded-colour` (`ci.yml:149-170`) |
|---|---|---|
| Files read | `src/styles.css` **and** `src/lib/dash.js` (`:20-21`) | `src/styles.css` only |
| Asserts | CSS `--route-*` values match `dash.js` fallbacks in both directions (`:39-51`); every route colour has a dark value (`:55-60`) | no hex literal appears outside the `:root` / `[data-theme=dark]` blocks |
| Catches CSS↔JS drift | **yes** | **no** |
| Catches a stray hex in a component rule | no | yes |

I ran the awk verbatim against the current tree: **it passes** (no output, exit 0). Its block-matching is sound against the redesign — `frontend/src/styles.css:16` `:root {`, `:66` `[data-theme='dark'] {` (the awk's `.dark.` matches the single quotes), `:106` a second `:root {` for type/space/shape.

**But the drift it does not cover is real and present.** `frontend/src/lib/dash.js` carries **14 hard-coded hexes** the CI gate never looks at:

```
frontend/src/lib/dash.js:24-25   '#C2703D' / '#E8A46F'   (fastest)
frontend/src/lib/dash.js:32-33   '#2F7D53' / '#6FC38E'   (scenic)
frontend/src/lib/dash.js:40-41   '#5B6ECF' / '#95A4F0'   (accessible)
frontend/src/lib/dash.js:48-49   '#8A5CB4' / '#C2A0E8'   (quiet)
frontend/src/lib/dash.js:56-57   '#1E7A78' / '#63C4BE'   (shade)
frontend/src/lib/dash.js:64-65   '#B0455F' / '#EE8AA0'   (air)
frontend/src/lib/dash.js:76-77   '#55645A' / '#9BAEA1'   (unknown fallback)
```

These are duplicates of `frontend/src/styles.css:44-49` (light) and `:86-91` (dark). Nothing checks that the two agree. `dash.js:32-41` explains why the duplication exists and is legitimate — MapLibre paints to a canvas and `setPaintProperty` cannot resolve `var(--route-scenic)` — which is exactly the situation `check-palette.mjs` was written for.

**`check-palette.mjs` cannot simply be restored — it would fail on the redesign for two structural reasons.** I simulated its logic against the current tree:

1. `:24` splits on the literal `'@media (prefers-color-scheme: dark)'`. The redesign has **no such string** in `styles.css` — `indexOf` returns `-1`, so `lightBlock` is the entire 37,978-char file and `darkBlock = css.slice(-1)` is a single character. The redesign themes via the `[data-theme='dark']` attribute (`styles.css:66`), set pre-paint by `index.html:39`.
2. `:31` looks for `'const FALLBACK_COLORS = {'`. `dash.js:73` declares `const FALLBACK = {` — a single style object (`id`/`label`/`color`/`colorDark`/`dash`/`pattern`), not a colour map. `fallbackBlock` comes back empty, `jsColors` is `{}`.

Net effect if restored unmodified: `cssColors` silently captures the **dark** values (last-match-wins over the whole file — I confirmed it yields `fastest: '#e8a46f'`, i.e. `styles.css:86`, not `:44`), every one reports "no fallback in dash.js", and every one reports "has no dark-theme value". Twelve spurious failures. A rewrite against `[data-theme='dark']` and the `OBJECTIVES` array shape is required, not a `git checkout`.

---

## 8. `gate.mjs` — every selector, and whether it exists on `main`

Source: `git show feat/launch:frontend/scripts/gate.mjs`. Current frontend: `/Users/poojana/Meander/Meander/frontend/src` (32 files; `styles.css` is 1720 lines and defines **160** distinct top-level classes).

| # | Selector | `gate.mjs` line | Exists in `frontend/src`? | Evidence |
|---|---|---|---|---|
| 1 | `.topbar__origin` | `:92` | **NO** | `Topbar.jsx` renders `.topbar`, `.topbar__brand`, `.topbar__wordmark`, `.topbar__tagline`, `.topbar__actions`, `.icon-button` (`Topbar.jsx:18-28`). No origin control in the top bar at all. |
| 2 | `input[role="combobox"]` | `:94` | **YES** | `components/PlaceInput.jsx:117` `role="combobox"` |
| 3 | `[role="option"]` | `:99`, `:100` | **YES** | `components/PlaceInput.jsx:135` |
| 4 | `.controls-sheet__bar .button` | `:105` | **PARTIAL — descendant is absent** | `.button` exists (`styles.css`, plus 8 components incl. `RouteDetail.jsx`, `FirstRun.jsx`). `.controls-sheet__bar` matches nothing; `ControlsSheet.jsx` was one of the 37 deleted files. The compound selector therefore returns `[]` and `[...].pop()` is `undefined`. |
| 5 | `.row__button, .card` | `:113` | **NO — both halves** | see below |
| 6 | `.row__button, .card` | `:149` | **NO — both halves** | same |
| 7 | `.sheet__scroll` | `:154` | **NO** | `styles.css` defines `.sheet`, `.sheet__step`, `.sheet__metric`, `.sheet__metric-unit`, `.sheet__row`, `.sheet__privacy` — no `__scroll` |
| 8 | `*` | `:176` | trivially yes | — |
| 9 | `button:not([disabled]), a[href], input, select, [role="option"]` | `:190` | **YES** (generic) | — |
| 10 | `.footer` (via `el.closest('.footer')`) | `:195` | **NO** | The footer was collapsed into `About.jsx` in the redesign (`About.jsx:4-9`, `Topbar.jsx:9`); classes are `.about`, `.about__body`, `.about__summary` |
| 11 | `.sheet` | `:229` | **YES, but wrong thing** | `components/FollowMode.jsx:207` `<section className="sheet" aria-label="Following this route">`; `styles.css:1669`. See below. |
| 12 | `.sheet__handle` | `:231` | **NO** | no such class in the 160-class list |
| 13 | `.card` | `:232` | **NO** | zero `className` occurrences; zero CSS rules. Only textual mentions in comments (`styles.css:40`, `:1441`, `App.jsx:348`, `RouteDetail.jsx:52`) and the dead half of `a11y.jsx:53` |
| 14 | `.row__button` | `:233` | **NO** | zero occurrences anywhere in `frontend/src` |

### The brief's specific claim: verified

`.row__button`, `.sheet__handle` and `.sheet__scroll` **do not exist on `main`** — zero hits each across `.jsx`, `.js` and `.css` in `frontend/src`. Add to that list: `.topbar__origin`, `.controls-sheet__bar`, `.card`, `.footer`. Seven of the fourteen selector families are dead.

### What replaced them

- **Route rows are `button.route`**, not `.row__button` / `.card`. `components/RouteRow.jsx:53`: `` className={`route${blocked ? ' route--blocked' : ''}`} ``. Skeletons are `<div className="route route--skeleton">` (`components/RouteRail.jsx:9`) — which is why `a11y.jsx:53` uses `button.route` and not `.route`; the comment at `a11y.jsx:50-52` records that the looser selector matched three placeholders and audited a half-streamed result. **Any rewrite of `gate.mjs` must inherit that distinction.**
- The rail row's parts are `.route__edge`, `.route__body`, `.route__top`, `.route__name`, `.route__dur`, `.route__dur-unit`, `.route__sub`, `.route__pattern`, `.route__scores` (`styles.css:991-1208`).
- **There is no bottom sheet.** The layout is `.app` → `.layout` → `.panel` + `.stage` (`App.jsx:366,391,392,465`), with `.rail` for the route list. No handle, no snap points, no scroll container.
- `.sheet` on `main` is the **follow-mode step panel** (`FollowMode.jsx:207`), living inside `.follow` (`styles.css:1611-1624`, `position: absolute; inset: 0`), reachable only after a user enters follow mode.

### Consequence: `gate.mjs` fails on `main` for the wrong reasons

Tracing it against the current DOM:

- `driveToRoutes()` (`:88-121`) — `:92` finds no `.topbar__origin`, so it skips the click and falls through to `:94`; `input[role="combobox"]` **is** present, so it may still type "Colombo Fort" and pick a suggestion. `:105`'s "done" button is `undefined`, so the sheet-close step no-ops harmlessly. Then `:113` counts `.row__button, .card` = **0** forever, `stable` never increments past 0, and the loop burns its full 120 × 150 ms ≈ **18 s** before returning `'ok, 0 routes'`.
- Check 1 (`:148-164`) — `rows` is empty, `above.n === 0`, so `above.n > 0` is false → **FAIL**, reported as "0/0 route rows fully in view". The `.sheet__scroll` lookup at `:154` yields `null`, so `sheetOverflow` is `0` and contributes nothing.
- Check 4 (`:189-202`) — runs, but the `.footer` exemption at `:195` never fires, so any inline prose link in `About.jsx` that WCAG 2.2 exempts will now be reported as a sub-44px offender. **False positives, not false negatives** — but it will mask real ones.
- Check 5 desktop (`:228-244`) — `document.querySelector('.sheet')` is `null` unless follow mode is active, which the harness never enters. `s?.position` is `undefined ≠ 'static'` → **FAIL**. Then `desktop.cards > 0` is `0 > 0` → **FAIL**.

So restoring `gate.mjs` unmodified produces **three hard failures and one class of false positive**, none of which is a real defect in the shipped frontend. The two checks that would still grade something real — no horizontal scroll at 320 (`:171-184`) and axe zero-violations (`:204-219`) — are selector-independent and survive intact.

`pwa-gate.mjs` is worse: it shares every dead selector (`:177` `.topbar__origin`, `:189` `.controls-sheet__bar .button`, `:194`/`:210` `.row__button, .card`, `:420` `.row__button`, `:423` `.sheet__scroll`, `:426` `.sheet`, `:450` `.sheet__snap`, `:452` `.card`) and adds more that never existed on `main` — `.shell` (`:341`), `.row` (`:392`), `.row__cached` (`:396,397`), `.topbar__cached` (`:393`), `.topbar__time` (`:223`), `.trust--cached` / `.trust--loud` (`:347,455`), `.offline` (`:347,456`), `.better-later__head` (`:457`), `.better-later--expired` (`:458`), `.sheet__snap` (`:450`). It also asserts a `link[rel="manifest"]` (`:277`) that `index.html` does not have (§3) and a service worker that does not exist. Selectors that **do** survive: `.banner--warn` (`:211,346,399` — `StatusBanner.jsx`), `.chip` (`:229` — `ObjectiveChips.jsx`), `[role="status"][aria-live="polite"]` (`:522` — `App.jsx:372`).

---

## Summary of verdicts on the brief's claims

| Claim | Verdict |
|---|---|
| `axe-core` is a devDependency with **no consumer** | **Refuted as worded.** Consumer exists at `frontend/src/a11y.jsx:12`. **Confirmed in substance:** nothing automated invokes it (zero hits in `ci.yml`, `deploy.yml`, `Makefile`, npm scripts), `a11y.html` is not a build input, and `a11y.jsx:53`'s `.card` half is already dead. |
| `VITE_API_PROXY_TARGET` is read nowhere / dead config | **Verified.** Set at `docker-compose.yml:78`, read nowhere. Consumer lost from `vite.config.js` in `66eaef3`; `vite.config.js:8` hard-codes `http://localhost:8000`. **Escalation:** this actively breaks the compose stack, it is not merely inert. |
| `index.html` has no favicon / manifest / apple-touch-icon / CSP meta | **Verified.** No `<link>` element of any kind. |
| `frontend/public/` absent on `main`, present on `feat/launch` | **Verified.** Six files, ~13.7 KB, regenerable dependency-free via `make-icons.mjs`. |
| Three checks in CI but not `make check` | **Verified.** `ci.yml:100` (`sudo unshare -n`), `ci.yml:112-121` (torch-free), `ci.yml:158-170` (colour awk). `Makefile:74`'s claim is false. |
| `deploy.yml:54-55` asserts three frontend gates that do not exist | **Verified.** `package.json:11` is bare `vite build`; no `check:*` scripts; no `frontend/scripts/`. Two of the three could not run anyway — `src/lib/permalink.js` and `src/lib/offline.js` were deleted in the same merge. Same job also references `sw.js` and `*.webmanifest` at `:128-136`, neither of which the build emits. |
| `.row__button`, `.sheet__handle`, `.sheet__scroll` do not exist | **Verified**, and the list is longer: also `.topbar__origin`, `.controls-sheet__bar`, `.card`, `.footer`. |
| 37 files dropped by the merge | **Verified exactly.** `git diff --diff-filter=D --name-only feat/launch main -- frontend` returns 37: 6 under `public/`, 6 under `scripts/`, 17 components, 7 `lib/` modules, `sw.js`. |
| The palette check "now lives as inline awk in `ci.yml`" | **Partly refuted.** `ci.yml:149-170` is a *different* check — same file, different property, disjoint coverage. `check-palette.mjs`'s actual job (CSS↔`dash.js` agreement, 14 hexes at `dash.js:24-77`) is currently **ungated**. And the script cannot be restored as-is: it keys on `@media (prefers-color-scheme: dark)` (absent — the redesign uses `[data-theme='dark']` at `styles.css:66`) and on `const FALLBACK_COLORS = {` (`dash.js:73` says `const FALLBACK = {`). Simulated: 12 spurious failures, and `cssColors` silently reads the dark palette as the light one. |


---

## Survey 2

> Verified against the tree at `/Users/poojana/Meander/Meander` on `main`. HEAD moved from `46d4772` to `3ed36b9` while I was reading, but `git diff 46d4772..HEAD -- frontend/src` is **empty** and `frontend/src` is clean, so every line number below is valid for both commits. No file was edited.

---

# 1. The component tree

## 1a. Inventory — `frontend/src/components/` (20 files, zero orphans)

| File | Purpose (one line) | Rendered by |
|---|---|---|
| `About.jsx` (53) | Collapsed footer: OSM-tagging caveat, privacy statement, cache stats, attributions. `forwardRef` so App can open+scroll it. | App |
| `DaylightGuard.jsx` (55) | At most one warning about walking in the dark, with at most one fix. Renders `null` when it cannot compute. | App, into `RouteDetail`'s `children` |
| `DepartureStrip.jsx` (84) | "Leave at HH:MM" + six hour chips. Renders `null` when there is no `best_departure`. | App |
| `FirstRun.jsx` (119) | The empty state — three decisions, replaces panel + stage entirely. | App |
| `FollowMode.jsx` (245) | Live walking sheet over the stage. Non-modal. Makes no network call. | App |
| `MapView.jsx` (614) | The single MapLibre instance, route lines, markers, legend, own zoom controls. | App |
| `ObjectiveChips.jsx` (50) | Six objective chips, max three selected. | TripBar |
| `PlaceInput.jsx` (179) | Debounced geocode combobox with `aria-activedescendant`. | TripBar ×2, FirstRun ×1 |
| `Ribbon.jsx` (34) | Non-dismissible demonstration-data warning. | App |
| `RouteDetail.jsx` (205) | Everything about the *selected* route. Two injection slots. | App |
| `RouteRail.jsx` (59) | The comparison list + results heading + streaming skeletons. | App |
| `RouteRow.jsx` (136) | One comparison row. **A single `<button>` containing only `<span>`.** | RouteRail |
| `StatusBanner.jsx` (76) | The only thing that changes during a refetch. Phase-driven. | App |
| `StepList.jsx` (121) | Turn-by-turn `<details>`, barriers folded into the step they occur on. | App, into `RouteDetail`'s `stepList` prop |
| `ThemeToggle.jsx` (31) | Light/dark switch. Labels the theme you will *get*. | Topbar |
| `TimeDial.jsx` (91) | Native `<input type="range">` + preset pills. Also **exports `PRESETS`**. | TripBar (and `PRESETS` imported by FirstRun) |
| `Topbar.jsx` (35) | 56px sticky bar: wordmark, tagline, theme toggle, About button. | App |
| `TripBar.jsx` (209) | Four segments → four inline drawers. Owns only which drawer is open. | App |
| `TripDrawer.jsx` (20) | One inline drawer. Uses `hidden`, never unmounts. | TripBar ×4 |
| `VerificationMeter.jsx` (43) | Four segments + a word. **Only phrasing content.** | RouteRow |

Locally-defined sub-components (not files, but real mount points):
- `TripBar.jsx:18` `Icon({name})` — inline 22×22 SVG, `className="seg__dot"`. Cases: `from`, `to`, `time`, default (`compare`).
- `RouteRail.jsx:6` `Skeleton()` — one `<li>` holding row height.
- `RouteDetail.jsx:23` `Barriers({blockers})` — first 8 shown, rest behind "and N more".

## 1b. Inventory — `frontend/src/lib/` and `frontend/src/api/`

| File | Purpose | Consumers |
|---|---|---|
| `lib/dash.js` (115) | Route identity table: `OBJECTIVES`, `DASH`, `styleFor`, `routeColor`, `swatchBackground`. Mirrors `--route-*`. | RouteDetail, RouteRow, ObjectiveChips, MapView |
| `lib/format.js` (209) | All string formatting + `verificationTier` + `confidenceSentence` + live-region sentences. | App, TripBar, TimeDial, RouteRow, RouteDetail, RouteRail, StepList, VerificationMeter, FollowMode |
| `lib/sun.js` (292) | NOAA short-form solar maths, in-browser, **no network call**. | DepartureStrip, DaylightGuard |
| `lib/follow.js` (153) | Follow-mode geometry, all local. **Nothing here makes a request.** | FollowMode |
| `lib/theme.js` (57) | The only storage touch in the app. | App |
| `lib/sun.test.js` (255), `lib/follow.test.js` (185) | vitest. Runner forces `TZ: UTC` (`vite.config.js`). | — |
| `api/client.js` (160) | `buildRouteRequest`, `fetchRoutes` (SSE + JSON fallback), `geocode`, `usingMockApi`, `ApiError`. | App, PlaceInput, Ribbon |
| `api/mock.js` (346) | Fixtures behind `VITE_MOCK_API=1`. Lazy-imported. | client.js only |
| `main.jsx` (12) | `createRoot` → `<StrictMode><App/></StrictMode>`. | — |
| `a11y.jsx` (107) | Dev-only axe harness (`a11y.html`). Selector `'button.route, .card'` at `a11y.jsx:53`. | — |

**Exported but currently unused — free for a new feature to adopt rather than reinvent:** `format.js:173 restStopSentence()`, `format.js:8 MODE_NOUN`, `VerificationMeter.jsx:18 showSentence` prop (never passed `false`).

## 1c. The actual mount hierarchy, from `App.jsx:365`

```
App                                             App.jsx:181
├─ a.skip-link → #results                       :367
├─ p.visually-hidden[role=status][aria-live=polite]  :372   ← the ONE live region
├─ Topbar                                       :376
│   ├─ ThemeToggle                              Topbar.jsx:25
│   └─ button.icon-button (About)               Topbar.jsx:26
├─ Ribbon                                       :378
└─ firstRun ? FirstRun : div.layout             :380  (ternary; gate at :352)
   ├─ FirstRun                                  :381
   │   ├─ button.button--primary.firstrun__locate  FirstRun.jsx:30
   │   ├─ PlaceInput                            FirstRun.jsx:43
   │   └─ fieldset.chips.firstrun__time         FirstRun.jsx:56  (uses TimeDial's PRESETS)
   └─ div.layout                                :391
      ├─ main.panel                             :392
      │  ├─ TripBar                             :393
      │  │  ├─ div.tripbar__grid → 4× button.seg (+ Icon)  TripBar.jsx:125
      │  │  ├─ TripDrawer#drawer-from → PlaceInput, button, hint  :152
      │  │  ├─ TripDrawer#drawer-to → PlaceInput, hint            :170
      │  │  ├─ TripDrawer#drawer-time → TimeDial, select#mode-select  :183
      │  │  └─ TripDrawer#drawer-compare → ObjectiveChips         :204
      │  ├─ DepartureStrip                      :411
      │  ├─ div#results                         :419
      │  │  ├─ StatusBanner                     :420
      │  │  ├─ p.field__hint (reason w/o departure)  :431
      │  │  ├─ RouteRail                        :435
      │  │  │  └─ ul.rail → RouteRow ×n → VerificationMeter
      │  │  │                (or Skeleton ×expected)
      │  │  └─ RouteDetail                      :444
      │  │     ├─ stepList prop = <StepList/>   :447   ← element created by App
      │  │     └─ children     = <DaylightGuard/>  :450 ← element created by App
      │  ├─ div.panel__spacer                   :460
      │  └─ About (ref=aboutRef)                :462
      └─ div.stage                              :465
         ├─ MapView         (only when hasRoutes)    :467
         └─ FollowMode      (only when followRoute)  :480
```

**Consequence worth stating for integration specs:** `StepList` and `DaylightGuard` are *instantiated in App* and passed down as elements. Their props come straight from App state (`App.jsx:447`, `450-456`); `RouteDetail` never touches them. Any new panel-level feature can follow either pattern — a new named slot prop, or an additional element inside `children`.

---

# 2. Exact mount points

## 2.1 `TripBar` — `frontend/src/components/TripBar.jsx`

Two independent insertion surfaces.

**(a) A fifth segment** — push onto the `segments` array, `TripBar.jsx:96-121`:
```jsx
96   const segments = [
97     { key: 'from',    label: 'From',          value: …, placeholder: … },
104    { key: 'to',      label: 'To',            value: …, placeholder: !dest },
110    { key: 'time',    label: 'Time & travel', value: `${minutes} min · ${verb}`, … },
116    { key: 'compare', label: 'Compare',       value: `${objectives.length} type…`, … },
121  ]
```
Insert a new object at **`:120`** (before the closing `]`). Each entry needs `{key, label, value, placeholder}`. The `key` is load-bearing three times: `Icon name={segment.key}` (`:135`), `aria-controls={'drawer-'+key}` (`:132`), `id={'seg-key-'+key}` (`:137`). A new key falls through `Icon`'s default at `TripBar.jsx:54-58` (the hamburger glyph) unless a branch is added before it.

*Layout caution:* `.tripbar__grid` is `grid-template-columns: minmax(0,1fr) minmax(0,1fr)` (`styles.css:444-448`) and collapses to `1fr` below 380px (`styles.css:1459-1463`). A fifth segment produces an orphan half-row.

**(b) A fifth drawer** — the four `TripDrawer` calls run `:152-206`. Insert after **`TripBar.jsx:206`**, before `</div>` at `:207`:
```jsx
204  <TripDrawer id="drawer-compare" labelledBy="seg-key-compare" open={open === 'compare'}>
205    <ObjectiveChips objectives={objectives} theme={theme} onToggle={onToggleObjective} />
206  </TripDrawer>
       ← new <TripDrawer id="drawer-X" labelledBy="seg-key-X" open={open === 'X'}> goes here
207  </div>
```
`TripDrawer` (`TripDrawer.jsx:14-20`) is `div.drawer[role=group][aria-labelledby]` with `hidden={!open}`; children are laid out `flex-column; gap: var(--s3)` (`styles.css:503-511`). Mutual exclusion is free — `toggle()` at `TripBar.jsx:93` sets a single `open` string.

**(c) Inside an existing drawer** — the `time` drawer already stacks two children:
```
183  <TripDrawer id="drawer-time" …>
184    <TimeDial … />                     :184-189
190    <div className="field"> …mode select… </div>   :190-201
202  </TripDrawer>
```
A third control inserts at **`TripBar.jsx:201`**. The `compare` drawer has exactly one child; insert at **`TripBar.jsx:205`**.

## 2.2 `RouteRail` — `frontend/src/components/RouteRail.jsx`

```jsx
36   return (
37     <section aria-labelledby="routes-heading">
38       <div className="results-head">
39         <h2 className="results-head__title" id="routes-heading">
40           {showSkeletons ? 'Working out your routes' : waysBack(routes.length)}
41         </h2>
                                    ← designed slot: see below
42       </div>
43
44       <ul className="rail">
45         {showSkeletons
46           ? Array.from({ length: expected }, (_, i) => <Skeleton key={i} />)
47           : routes.map((route) => (
48               <RouteRow key={route.id} route={route} selected={…} theme={theme} onSelect={onSelect} />
55             ))}
56       </ul>
57     </section>
```

- **A rail-level control (sort, filter, unit toggle) goes at `RouteRail.jsx:41`.** `.results-head` is `display:flex; align-items:baseline; justify-content:space-between` (`styles.css:264-270`) with the h2 as its only child — the right-hand slot is empty and was clearly built for a second child.
- **A new row-level fact goes inside `RouteRow`, not here.** See 2.3.
- **Guard to respect:** `RouteRail.jsx:34` — `if (routes.length === 0 && !showSkeletons) return null`. Anything mounted inside `<section>` disappears in the empty state. `expected` (`:31`, fed from `state.objectives.length` at `App.jsx:440`) drives the skeleton count.

## 2.3 `RouteRow` — the hard constraint

`RouteRow.jsx:51-133` is **one `<button>` and every descendant is a `<span>`.** The comment at `RouteRow.jsx:11-34` is a standing instruction: a `<p>`, `<dl>`, `<ul>` or `<div>` in here is invalid HTML and screen readers flatten the whole row into one label. Insert points inside `.route__body` (`:59-132`), in DOM order:

| Where | Lines | Note |
|---|---|---|
| `span.route__top` | `:60-74` | name, badges, duration. `.route__dur` uses `margin-inline-start:auto` (`styles.css:1044`), so a new child must go **before** `:70` to sit left of the duration. |
| `span.route__sub` | `:76-95` | pattern swatch · distance · rest stops · blocked. Append at `:94`. |
| `span.route__scores` | `:97-126` | 3-column grid (`styles.css:1097-1102`). Adding a fourth entry to `SCORE_ROWS` (`RouteRow.jsx:5-9`) requires editing `repeat(3, …)` at `styles.css:1099`. |
| after `VerificationMeter` | `:128-131` | a new full-width span row inserts at **`:131`**, before `</span>` at `:132`. |

Uniform row height is the point of this component (`RouteRow.jsx:30-33`). Note the cross-row alignment hack at `styles.css:1129-1134`: `.rail:has(.score__none) .score__head { min-height: 3em }` reserves the second line across the *whole* rail.

## 2.4 `RouteDetail` — `frontend/src/components/RouteDetail.jsx`

Full JSX skeleton of `article.detail` (`:70-203`), with every seam:

```
 70  <article className="detail" aria-labelledby="detail-title">
 71    <header className="detail__head">                    :71-83
 72      span.detail__pattern (swatchBackground)            :72-76
 77      h3#detail-title.detail__title                      :77-79
 80      p.detail__figures.tabular  (dur · dist)            :80-82
 83    </header>
 86    p.detail__narration  |  p.detail__narration--pending :86-93
 95    {blocked && div.note.note--warn[role=alert]}         :95-102
104    <section className="detail__section">  "Along the way"  :104-123
125    <section className="detail__section">  "Directions"     :125-128
127        {stepList}            ← NAMED SLOT, filled at App.jsx:447
130    <section className="detail__section">  "What this route scores"  :130-158
163    div.note (confidence sentence, verbatim)             :163-170
175    {children}               ← GENERIC SLOT, filled at App.jsx:450-456
181    {onStart && route.steps?.length > 0 && div.detail__actions}  :181-198
200    p.detail__pattern-note                               :200-202
203  </article>
```

- **The generic slot is `RouteDetail.jsx:175`.** It is explicitly documented (`:172-174`) as the place phase-specific extras attach so `RouteDetail` "stays about layout and the phases stay separable". A second child added to `App.jsx:450-456` lands here, after the confidence note and before the action button.
- **A new named slot** follows the `stepList` pattern: add a prop to the signature at `RouteDetail.jsx:58` and render it inside a new `<section className="detail__section"><h4 className="detail__h">…</h4>{prop}</section>`. Existing sections are the template at `:104`, `:125`, `:130`.
- **A new section between existing ones** inserts cleanly at `:124` or `:129`. `.detail` is `flex-column; gap: var(--s4)` (`styles.css:1234-1244`) — no margin work needed.
- **A new action button** joins `div.detail__actions` at `RouteDetail.jsx:191` (after "Start this route"). That container is `flex-column; align-items:flex-start` (`styles.css:1711-1716`).
- **Guards:** `:59` `if (!route) return null` — the whole article vanishes with no selection. `:181` gates actions on `onStart && route.steps?.length > 0`.
- `RouteDetail.jsx:176-180` is a standing prohibition on Share/Save controls. Read it before adding either.

## 2.5 `StepList` — `frontend/src/components/StepList.jsx`

```
 86  <details className="steps">
 87    <summary className="steps__summary">Directions · N steps</summary>   :87-89
 90    <ol className="steps__list">
 91      {steps.map((step, i) => (
 93        <li className="step" onMouseEnter/Leave/Focus/Blur → onHighlight tabIndex={0}>  :93-103
104          <p className="step__text">{sentence(step)}</p>
105          {step.street_name && <p className="step__meta">…</p>}          :105-110
111          {barriers.get(i)?.map(… <p className="note note--warn step__barrier">)}  :111-115
116        </li>
118    </ol>
119  </details>
```

- **A per-step child** (elevation delta, surface, a report control) inserts at **`StepList.jsx:115`**, after the barrier paragraphs, inside `<li className="step">`. Unlike `RouteRow`, this is *not* inside a button — `<p>`, `<div>`, `<button>` are all legal here.
- **A list-level child** inserts at `:117` (after `</ol>`, inside `<details>`) or at `:89` (in the summary row).
- **Do not disturb** `onMouseEnter/onMouseLeave/onFocus/onBlur` at `:98-101` — these feed `App.jsx:187 setHighlight`, which drives the map's `highlight` source (`MapView.jsx:437-455`). A nested focusable child will fire `onFocus` on the `<li>` by bubbling and change the highlight; that may or may not be wanted.
- **Guard:** `:75-81` returns a bare `p.field__hint` when `steps.length === 0` — nothing else renders.
- `barriersByStep()` (`:39-63`) is the nearest-vertex matcher; it needs `step.interval` as `[startIdx, endIdx]` into `route.geometry`.

## 2.6 `DepartureStrip` — `frontend/src/components/DepartureStrip.jsx`

```
 45  <section className="departure" aria-labelledby="departure-head">
 47    <p className="departure__head" id="departure-head"> Leave at <strong>…</strong> — reason </p>  :47-52
 54    {daylight && <p className="departure__daylight">{daylight}</p>}
 56    <div className="departure__hours" role="group" aria-label="Choose a departure hour">
 57      {hours.map((hour) => …
 64        <button className={dark ? 'hour hour--dark' : 'hour'} aria-pressed={pressed}
 69                onClick={() => onDepartAt(hour.toISOString())}>
 71          {dark && <span className="hour__moon" aria-hidden="true">☾</span>}
 74          {fmtClock(hour)}
 77          {dark && <span className="visually-hidden"> — after dark</span>}
 78        </button>
 81    </div>
 82  </section>
```

- **A new row** inserts at **`DepartureStrip.jsx:55`** (between the daylight sentence and the hour chips) or **`:81`** (after the chip group, before `</section>`). `.departure` is `flex-column; gap: var(--s2)` (`styles.css:1490-1499`).
- **THE TRAP, and it is a real one:** `DepartureStrip.jsx:21` — `if (!recommended || Number.isNaN(recommended.valueOf())) return null`. The **entire strip does not render** whenever the backend returns no `best_departure`. Anything mounted inside it is invisible in that (common) case. `App.jsx:431-433` already works around this by rendering the bare `reason` outside the strip. A new always-on control belongs at `App.jsx:418` (between `DepartureStrip` and `div#results`), not inside `DepartureStrip`.
- Second guard: the daylight layer (`:27-28`, `:62`) goes silent entirely when `canStateLocalTime(origin.lon)` is false. `.hour` is `min-height/min-width: var(--target)` (`styles.css:1519-1520`) — already compliant.

---

# 3. The complete design token vocabulary

**50 unique custom properties**, all defined in `frontend/src/styles.css`, across three blocks: `:root` at **`styles.css:16-62`** (colour), `[data-theme='dark']` at **`:66-102`** (the same 33 colour names, re-valued), and a second `:root` at **`:106-138`** (type/space/shape — theme-invariant by design, per the comment at `:104-105`).

**Verified absent:** no `--space-*`, no `--text-*`, no `--ink: #14213d`. The launch-branch vocabulary is not present anywhere in this file.

## The `:root` colour block, quoted verbatim (`styles.css:16-62`)

```css
:root {
  /* -- surface and ink (§2.1) -------------------------------------------- */
  --paper: #f6f3ec;
  --raised: #fffefa;
  --sunken: #ede9df;
  --rule: #dcd5c6;
  --rule-strong: #c4bca8;
  --ink: #16241c;
  --ink-2: #55645a;

  /* -- brand and accent --------------------------------------------------- */
  --brand: #1c4633;
  --brand-hover: #122e21;
  --brand-on: #f6f3ec;
  --brand-tint: #e4ede5;
  --accent: #2f7d53;
  --ok-ink: #1c5e3c;

  /* -- warning ------------------------------------------------------------ */
  --warn-ink: #8a2c14;
  --warn-ground: #f7e9e1;
  --warn-rule: #d3a184;

  /* -- route identity (§2.3) ---------------------------------------------
   * Graphics only — map lines, the 4px card edge, swatches, the legend. Never
   * as text on paper: --route-fastest clears the 3:1 graphical-object
   * threshold but not the 4.5:1 text threshold. Mirrored in lib/dash.js,
   * which is what the map reads. */
  --route-fastest: #c2703d;
  --route-scenic: #2f7d53;
  --route-accessible: #5b6ecf;
  --route-quiet: #8a5cb4;
  --route-shade: #1e7a78;
  --route-air: #b0455f;

  /* -- map palette (§2.4) -------------------------------------------------- */
  --map-land: #e9e5d8;
  --map-park: #cfe0c9;
  --map-water: #c6dae4;
  --map-road: #fbfaf6;

  /* -- elevation (§2.6) ---------------------------------------------------- */
  --shadow-1: 0 1px 2px rgb(22 36 28 / 6%), 0 2px 8px rgb(22 36 28 / 6%);
  --shadow-2: 0 2px 4px rgb(22 36 28 / 8%), 0 8px 24px rgb(22 36 28 / 10%);

  color-scheme: light;
}
```

## The theme-invariant `:root` block, quoted verbatim (`styles.css:106-138`)

```css
:root {
  --font-display: 'Newsreader', 'Iowan Old Style', 'Palatino Linotype', Palatino, Georgia,
    'Times New Roman', serif;
  --font-body: 'IBM Plex Sans', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto,
    'Helvetica Neue', system-ui, sans-serif;

  --t-display: 2rem;
  --t-h2: 1.375rem;
  --t-h3: 1.0625rem;
  --t-metric: 1.75rem;
  --t-body: 0.9375rem;
  --t-small: 0.8125rem;
  --t-micro: 0.75rem;

  /* 4px base. The handoff writes this as "--s1 … --s10" and then enumerates
   * eight values; eight is what the rest of the document references. */
  --s1: 4px;
  --s2: 8px;
  --s3: 12px;
  --s4: 16px;
  --s5: 20px;
  --s6: 24px;
  --s7: 32px;
  --s8: 40px;

  --r-sm: 8px;
  --r-md: 12px;
  --r-lg: 16px;
  --r-pill: 999px;

  /* Every interactive target must be at least this in both dimensions. */
  --target: 44px;
}
```

## Grouped index (all 50)

| Group | Names | Count | Dark override? |
|---|---|---|---|
| **Spacing** | `--s1 --s2 --s3 --s4 --s5 --s6 --s7 --s8` (4/8/12/16/20/24/32/40 px) | 8 | no |
| **Type — families** | `--font-display` (Newsreader/serif), `--font-body` (IBM Plex Sans/system) | 2 | no |
| **Type — scale** | `--t-display --t-h2 --t-h3 --t-metric --t-body --t-small --t-micro` | 7 | no |
| **Radius** | `--r-sm --r-md --r-lg --r-pill` | 4 | no |
| **Target** | `--target` (44px) | 1 | no |
| **Surface / ink** | `--paper --raised --sunken --rule --rule-strong --ink --ink-2` | 7 | yes |
| **Brand / accent** | `--brand --brand-hover --brand-on --brand-tint --accent --ok-ink` | 6 | yes |
| **Warning** | `--warn-ink --warn-ground --warn-rule` | 3 | yes |
| **Route palette** | `--route-fastest --route-scenic --route-accessible --route-quiet --route-shade --route-air` | 6 | yes |
| **Map palette** | `--map-land --map-park --map-water --map-road` | 4 | yes |
| **Elevation** | `--shadow-1 --shadow-2` | 2 | yes |

Dark values (`styles.css:66-102`): `--paper:#0c1611 --raised:#132019 --sunken:#080f0b --rule:#26362c --rule-strong:#3a4e42 --ink:#e8efe8 --ink-2:#9baea1 --brand:#7fc79b --brand-hover:#9ad6b0 --brand-on:#0a1710 --brand-tint:#17281e --accent:#8fd3a9 --ok-ink:#8fd3a9 --warn-ink:#f5b49b --warn-ground:#2a1811 --warn-rule:#6b3a24 --route-fastest:#e8a46f --route-scenic:#6fc38e --route-accessible:#95a4f0 --route-quiet:#c2a0e8 --route-shade:#63c4be --route-air:#ee8aa0 --map-land:#16221b --map-park:#1d3527 --map-water:#152a33 --map-road:#24332b`.

## Rules a new feature must honour

1. **`styles.css:10-13` is a checkable invariant:** "No hard-coded hex may appear anywhere else in this file… `grep '#' styles.css` outside these two blocks is how it gets checked." A new colour = a new token in **both** `:root` and `[data-theme='dark']`.
2. **`--route-*` are duplicated in JS.** `lib/dash.js:20-69` carries `color`/`colorDark` per objective because MapLibre paints to a canvas and cannot resolve `var()` (`dash.js:86-96`, `MapView.jsx:39-43`). Any route-palette change must land in both files or the map and the swatches disagree.
3. **`MapView.jsx:42 token(name)`** reads tokens at runtime via `getComputedStyle(document.documentElement)`. Tokens actually read by the map: `--map-land --map-park --map-water --map-road --ink` (`MapView.jsx:56-61`), `--raised` (`:336`, `:394`, `:411`), `--accent` (`:377`, `:453`). This is why `App.jsx:273` uses `useLayoutEffect` — see §4.6.
4. No `@font-face`, no CDN. `styles.css:4-6` — a webfont would leak every visitor's IP.

---

# 4. State flow

All of this lives in `frontend/src/App.jsx`. **Rule 8 forbids restructuring it**, and the mechanism is small enough to extend without touching a line of it.

## 4.1 The shape

`useReducer(reducer, initialState, init)` — `App.jsx:182`. `initialState` at `:36-63`; `init()` at `:67-69` resolves the theme at mount rather than at module load, "so the read is not a side effect of importing this file".

State keys and their refetch status:

| Key | Line | Bumps `nonce`? |
|---|---|---|
| `minutes`, `mode`, `objectives`, `origin`, `dest`, `departAt` | `:38-51` | **yes** |
| `phase`, `routes`, `selected`, `progress`, `cache`, `reason`, `bestDeparture`, `error`, `geoDenied` | `:37-54` | no (results) |
| `follow` | `:56` | **no**, deliberately (`:54-55`) |
| `theme` | `:59` | **no**, deliberately (`:57-58`, `:166-167`) |
| `nonce`, `debounceMs` | `:61-62` | the mechanism itself |

Two pieces of state live **outside** the reducer on purpose:
- `highlight` / `setHighlight` (`:187`) — "it changes on every mousemove across a list and has no business triggering the fetch effect".
- `announcement` (`:183`), written through the debounced `announce()` at `:198-202` (350 ms).

## 4.2 The per-trigger debounce map — `App.jsx:26-34`

```js
const DEBOUNCE = {
  minutes: 400,   mode: 120,   objectives: 120,
  place: 0,       retry: 0,    departure: 200,
}
```
Six keys, five distinct values. `place: 0` is shared by both `origin` and `dest` (`:99`, `:102`) — a place is already debounced 300 ms upstream inside `PlaceInput` (`PlaceInput.jsx:5, 47`), so debouncing again would stack.

## 4.3 `withRefetch` — the single funnel, `App.jsx:71-73`

```js
function withRefetch(state, patch, debounceMs) {
  return { ...state, ...patch, nonce: state.nonce + 1, debounceMs, error: null }
}
```
Every refetching action routes through it: `minutes` `:78`, `mode` `:85`, `toggleObjective` `:95`, `origin` `:99`, `dest` `:102`, `retry` `:105`, `departAt` `:108`. Note it also clears `error` — so a retry is not a special path.

## 4.4 The one fetch effect — `App.jsx:206-258`

```js
useEffect(() => {
  if (!state.origin) return undefined          // :207
  if (state.nonce === 0) return undefined      // :208

  const timer = setTimeout(async () => {       // :210  — debounce lives HERE
    abortRef.current?.abort()                  // :211  — abort-on-refetch
    const controller = new AbortController()   // :212
    abortRef.current = controller              // :213
    dispatch({ type: 'loading' })              // :215  — keep-previous-answer
    …
    const payload = await fetchRoutes(buildRouteRequest({…}), {
      signal: controller.signal,               // :229
      onProgress: (evt) => dispatch({type:'progress', value: evt}),   // :230
      onRoute:    (route) => { arrived.push(route); dispatch({type:'route', value: route}) }, // :231-234
    })
    if (controller.signal.aborted) return      // :237
    dispatch({ type: 'settled', … })           // :239-245
    announce(announceRoutes(payload?.routes ?? arrived))  // :246
  } catch (err) {
    if (err?.name === 'AbortError') return     // :248
    dispatch({ type: 'error', value: err })    // :249
  }
  }, state.debounceMs)                         // :252

  return () => clearTimeout(timer)             // :254
  // eslint-disable-next-line react-hooks/exhaustive-deps
}, [state.nonce])                              // :255-258
```

Four properties, each with a precise location:

- **Nonce-keyed.** Dependency array is `[state.nonce]` and nothing else (`:258`). `state.debounceMs`, `state.minutes` etc. are read inside the closure but not depended on — the comment at `:255-257` says reading them "would double-fire". **The `eslint-disable-next-line` at `:257` must survive any edit**; without it CI lint fails (`react-hooks/exhaustive-deps`).
- **Debounce.** The timer wraps the whole async body (`:210`, `:252`). Cleanup (`:254`) only clears the timer, so a *rapid* second change cancels the first before it ever starts a request — no abort needed.
- **Abort-on-refetch.** `abortRef.current?.abort()` is at `:211`, **inside the timer, not in the cleanup**. An in-flight request is therefore killed at the moment its successor is about to launch, not when the effect re-runs. Plus a mount-scoped `useEffect(() => () => abortRef.current?.abort(), [])` at `:260`.
- **Keep-previous-answer.** `case 'loading'` (`:116-119`) sets only `phase`, `progress`, `error` — "Routes and selection are deliberately preserved: the previous answer stays on screen and interactive until the new one lands." `StatusBanner.jsx:1-6` documents the same contract from the other side.

Two behaviours a spec writer must not be surprised by:
- **Mid-stream, the list is a merge, not a replacement.** `case 'route'` (`:124-144`) merges incoming routes into `state.routes` **by id**, re-sorts by `state.objectives.indexOf(...)` (`:132-134`), and only picks a new `selected` if the current one vanished (`:139-142`). Wholesale replacement happens later, at `case 'settled'` → `routes: action.routes ?? state.routes` (`:151`). So during a refetch a stale route can coexist with a fresh one until `settled` lands.
- **`onRoute`/`onProgress` dispatch without an abort check** (`:230-234`). Aborting the fetch stops the reader, which is what actually halts them.

## 4.5 How a new control triggers a refetch — the four-step recipe

This adds lines; it restructures nothing.

1. **`App.jsx:27-34`** — add one key to `DEBOUNCE`, e.g. `surface: 200`.
2. **`App.jsx:36-63`** — add the field to `initialState` with a safe default.
3. **`App.jsx:76-178`** — add one `case` alongside the others:
   ```js
   case 'surface':
     return withRefetch(state, { surface: action.value }, DEBOUNCE.surface)
   ```
4. If the value must reach the server, thread it through **two** places: the `buildRouteRequest({…})` call site at `App.jsx:220-227`, and the builder itself at `api/client.js:28-38` (which omits absent optional fields rather than sending `null` — see `:35-37`).

Then wire the control's callback as `onX={(value) => dispatch({ type: 'surface', value })}`, exactly like `onMinutes` at `App.jsx:403` or `onDepartAt` at `:416`.

**Do not touch** the dependency array at `App.jsx:258`, the eslint-disable at `:257`, or the abort ordering at `:211-213`.

**If the new control must NOT refetch** (a display preference, a client-side toggle), follow the `theme` and `follow` precedent: a plain `return { ...state, key: value }` case with a comment saying why (`App.jsx:166-174`), or lift it out of the reducer entirely like `highlight` (`:185-187`).

**Guard to be aware of:** the effect early-returns while `!state.origin` (`:207`). A control used before an origin exists will bump the nonce harmlessly; the value is picked up on the first fetch that does run, because the closure reads current state.

## 4.6 The theme path (separate, and load-bearing)

`useLayoutEffect`, not `useEffect`, at `App.jsx:273-275`. The comment at `:264-272` explains: React runs children's passive effects before the parent's, so `MapView`'s theme effect (`MapView.jsx:292-296`) was reading `getComputedStyle` for the **outgoing** palette and repainting the basemap in the colours being left. Layout effects run before all passive effects, so this now lands first. **Any new component that reads tokens at runtime inherits this ordering guarantee — and would break it if it moved the theme write into a passive effect.**

System-preference following (`:280-289`) is deliberately conditional on `!readStoredTheme()`: an explicit choice must survive the laptop flipping to dark at sunset.

---

# 5. localStorage

**Exactly two touch points, one key, no cookies, no sessionStorage, no indexedDB.** Verified by grep across `frontend/src`, `frontend/index.html`, `frontend/a11y.html`.

| Location | Operation | Key |
|---|---|---|
| `frontend/src/lib/theme.js:20` (`readStoredTheme`) | `getItem` | `meander:theme` |
| `frontend/src/lib/theme.js:29` (`storeTheme`) | `setItem` | `meander:theme` |
| `frontend/index.html:28` (inline pre-paint script) | `getItem` | `'meander:theme'` — hard-coded string |

- The key constant is `THEME_KEY = 'meander:theme'` at `lib/theme.js:14`.
- Values are validated to `'light' | 'dark'` by `isTheme` (`theme.js:16`) — anything else reads as `null`.
- **Both accesses are try/caught** (`theme.js:19-25`, `27-34`). Safari private mode throws on `setItem`, and `index.html:29-32` notes it throws on *read* too. Failure degrades to a tab-lifetime preference.
- Callers: `App.jsx:18` imports `applyTheme, initialTheme, readStoredTheme, storeTheme, systemTheme`; writes happen only in `onTheme` (`App.jsx:291-294`); reads in `init()` (`:68`) and the system-preference listener (`:281`, `:285`).
- **The duplication at `index.html:25-42` is intentional and must be kept in sync** — the comment at `:12-24` explains React cannot paint the theme before first paint. `index.html:22-23`: "the two must agree on the key name."
- The user-facing promise this backs is `About.jsx:29-33`: "The only thing kept in this browser is whether you chose the light or the dark theme." Also stated at `FirstRun.jsx:112-115` and `FollowMode.jsx:239-241`. Adding a second key means editing that copy.

---

# 6. CSS class naming convention

**Strict two-level BEM: `block`, `block__element`, `block--modifier`, `block__element--modifier`.** Single underscore never appears; the element separator is always `__` and the modifier separator always `--`. No nesting beyond one element level (`route__body`, never `route__body__top`).

## The real block names (28)

Layout/shell: `app`, `layout`, `panel`, `stage`, `topbar`, `ribbon`, `about`
Trip input: `tripbar`, `seg`, `drawer`, `field`, `place-row`, `suggestions`, `dial`, `chips`, `chip`, `preset`, `presets`, `firstrun`
Results: `results-head`, `rail`, `route`, `score`, `scores`, `badge`, `verify`, `sk`, `detail`, `stops`/`stop`, `note`, `blockers`, `banner`
Map: `map`, `legend`, `marker`
Time: `departure`, `hour`, `steps`, `step`
Follow: `follow`, `sheet`
Atoms: `button`, `link-button`, `icon-button`, `theme-toggle`, `skip-link`, `visually-hidden`, `tabular`

## Modifiers actually in use (13)

`button--primary`, `badge--showing`, `badge--blocked`, `banner--warn`, `note--warn`, `route--blocked`, `route--skeleton`, `score__track--hatched`, `scores__unmeasured` (element, not modifier), `seg__v--placeholder`, `detail__narration--pending`, `hour--dark`, `follow__alert--soft`, `marker--blocker`, `verify--ok`, `verify--warn`, `sk--title/--sub/--scores/--verify`.

## Three conventions beyond plain BEM

1. **State is read from ARIA attributes, not from JS-toggled classes.** This is the dominant pattern and a new component should follow it:
   - `.seg[aria-expanded='true']` `styles.css:468`
   - `.preset[aria-pressed='true']` `:541`
   - `.chip[aria-pressed='true']` `:792`
   - `.hour[aria-pressed='true']` `:1535`
   - `.route[aria-pressed='true']` `:1010`
   - `.suggestions__item[aria-selected='true']` `:714`
   - `.drawer[hidden]` `:512`
   - `.detail__actions .button--primary:disabled` `:1717`

   The upshot: **the accessible state and the visual state cannot drift**, because they are the same attribute. A new interactive control should style off `aria-*`, not off a `is-active` class.
2. **Two `is-` state classes exist as exceptions**, both where no ARIA attribute fits: `.verify__seg.is-on` (`:1181`, `:1185`) and `.legend__row.is-selected` (`:938`).
3. **Element-tag-qualified blocks** where the tag carries semantics: `fieldset.chips` (`:761`), `fieldset.chips legend` (`:767`). Bare element selectors are used for form controls: `input[type='text'], input[type='search'], select` (`:636`), `input[type='range']` (`:743`).

## File organisation (`styles.css`, 1720 lines)

Banner-comment sections, in source order: tokens `1-138`, reset/utilities `140-211`, `layout 213`, `topbar 277`, `ribbon 340`, `about 359`, `trip bar 426`, `first run 548`, `banner 812`, `map 848`, `rail 977`, `detail 1232`, `responsive 1409`, `departure 1488`, `steps 1558`, `follow 1609`. **Note the responsive block sits in the middle (`1409-1486`), not at the end** — `departure`, `steps` and `follow` are declared *after* it. A new section should go at the end and carry its own media query rather than editing the `1416` block, unless it needs to override.

Breakpoints: `899px` (map moves above panel; `:1416-1456`), `420px` (`:1465-1475`), `379px` (tripbar grid → 1 column; `:1459-1463`), plus `prefers-reduced-motion: reduce` (`:1477-1486`).

## Two dead selectors — do not treat as API

- **`styles.css:1438` `.route-list`** — inside the 899px query, `grid-template-columns: 1fr`. No JSX anywhere uses this class. Pre-redesign leftover.
- **`a11y.jsx:53` `'button.route, .card'`** — `.card` is the pre-redesign row and has no CSS rule. Kept deliberately so the harness spans the change (comment at `a11y.jsx:46-52`). Note the same comment's warning: `button.route` and not `.route`, because skeletons carry `.route` on a `<div>`.

---

# 7. Constraints and discrepancies a spec writer must know

1. **`--target: 44px` is honoured in 13 places but violated in two.** `.theme-toggle { min-height: 36px }` (`styles.css:406`) and `.preset { min-height: 36px }` (`styles.css:527`) are below the stated 44×44 floor. `.preset` is used in both `TimeDial.jsx:73-87` and `FirstRun.jsx:59-86`, so this is on the first-run path. Inline links are explicitly exempted with a WCAG 2.2 citation at `styles.css:389-391`. Any new control should use `var(--target)`, and these two are a pre-existing gap, not a precedent.
2. **`RouteRow` and `VerificationMeter` may contain only `<span>`.** `RouteRow.jsx:11-34`, `VerificationMeter.jsx:5-16`.
3. **`null` ≠ `0` ≠ `[]` throughout.** `route.scores.<k> === null` → hatched track + "not measured" (`RouteRow.jsx:99-121`, `styles.css:1148-1157`; `RouteDetail.jsx:149-153`). `rest_stops === null` → "not checked", `[]` → "none found" (`format.js:125-137`, `RouteDetail.jsx:106-112`). This is the UNKNOWN-not-accessible rule in code.
4. **Colour is never the only differentiator** — every route carries a dash pattern (`dash.js:20-69`) reproduced as a CSS gradient (`dash.js:99-115`) and named in text (`RouteRow.jsx:84`, `RouteDetail.jsx:201`). Dark hours carry `☾` + a visually-hidden "— after dark" as well as the tint (`DepartureStrip.jsx:71-77`). Warn tiers carry `⚠` + weight (`VerificationMeter.jsx:31-36`, `styles.css:1193-1201`). Chip selection is fill + border + weight + glyph (`styles.css:798-804`).
5. **One live region for the whole app** — `App.jsx:372-374`. `FollowMode` routes through it via `onAnnounce` rather than opening a second (`FollowMode.jsx:171-178`). A new feature must do the same.
6. **No third-party runtime requests.** Icons are inline SVG specifically to avoid an icon font (`TripBar.jsx:16-17`); fonts are local-only (`styles.css:4-6`); sun times are computed in-browser (`sun.js:11-13`); follow mode makes no call at all (`follow.js:3-9`, `FollowMode.jsx:22-30`). The only external hosts are the OpenFreeMap style URL (`MapView.jsx:6`) and the same-origin/`VITE_API_BASE` API (`client.js:19`).
7. **The map is never the only representation.** `MapView.jsx:117-124`, `:546-555` (why `role="img"` cannot go on the container), `:540-544` (the visually-hidden summary). The rail is the accessibility story.
8. **`MapView` must stay a single instance and must never unmount.** `App.jsx:348-352` gates on `origin`, not on `routes`, for exactly this reason. The StrictMode deferred-creation fix (`MapView.jsx:148-189`), the visibility-aware load deadline (`:191-216`), and the `jump`-not-`fly` hidden-tab guard (`:470-476`) are all marked "should not be tidied away".
9. **`api/mock.js` is the fixture contract** for any new field. Route object keys: `id, label, status, geometry, duration_min, distance_m, mode, scores{scenic,air,shade}, scoring_method, confidence, rest_stops[{lat,lon,type,at_m}], steps[{text,distance_m,duration_min,street_name,sign,interval}], blockers[{type,lat,lon,description}], narration, synthetic_upstream, confidence_note, status_note`. Envelope: `{routes, best_departure, reason, cache{segments_scored,hit_rate}}` (`mock.js:322-327`). The `accessible` fixture deliberately carries `shade: null` as the only exerciser of the unmeasured branch (`mock.js:225-232`).


---

## Survey 3

## 0. Scope note — read this first

My shell's cwd (`/Users/poojana/Meander/Meander/.claude/worktrees/meander-deploy-polish-f9aa37`) is a **stale worktree** that does not contain `backend/elevation.py`, `backend/coverage.py`, `backend/health.py`, or `backend/tests/test_barrier_reporting.py`. Every citation below is against the real checkout at **`/Users/poojana/Meander/Meander`**, branch `main` @ `46d4772`, verified with `git rev-parse`.

Everything below was proven by grep over the whole of `/Users/poojana/Meander/Meander/frontend/` (excluding `node_modules`/`dist`) plus two live probes against the shipped replay fixtures. "UNREACHABLE" means an exhaustive grep returned zero hits outside `api/mock.js` and `*.test.js`.

**Load-bearing proof of exhaustiveness:** the entire frontend makes exactly **two** network calls. There is no dynamic URL construction, no `EventSource`, no `axios`, no second client.

- `/Users/poojana/Meander/Meander/frontend/src/api/client.js:75` — `fetch(url('/api/routes'), …)`
- `/Users/poojana/Meander/Meander/frontend/src/api/client.js:132` — `fetch(url('/api/geocode?q=…'), …)`
- `url` is `(path) => \`${API_BASE}${path}\`` (`client.js:21`), and `API_BASE` is a build-time env string (`client.js:19`). Both call sites pass a **literal** path. No other `fetch(` exists in `frontend/src/`.

---

## 1. Every HTTP route in `backend/main.py`

| # | Method | Path | Line | Handler |
|---|--------|------|------|---------|
| 1 | POST | `/api/routes` | `backend/main.py:1103` | `post_routes` |
| 2 | GET | `/api/geocode` | `backend/main.py:1177` | `geocode` |
| 3 | POST | `/api/report-barrier` | `backend/main.py:1211` | `report_barrier` |
| 4 | GET | `/metrics` | `backend/main.py:1252` | `prometheus_metrics` |
| 5 | GET | `/healthz` | `backend/main.py:1310` | `healthz` |
| 6 | GET | `/readyz` | `backend/main.py:1322` | `readyz` |
| 7 | GET | `/api/health` | `backend/main.py:1353` | `health` |

That is the complete set. `main.py:255`/`:279` are exception handlers and `:288`/`:310` are middleware, not routes. There is no `APIRouter`, no `include_router`, no `add_api_route`, and no route decorator anywhere else in `backend/` — confirmed by a repo-wide grep for `@app.(get|post|put|delete|patch|websocket)` and `@router.*`.

### Endpoint reachability

| Endpoint | Consumed by | Verdict |
|---|---|---|
| `POST /api/routes` | `frontend/src/api/client.js:75` ← `fetchRoutes` ← `App.jsx:219` | **reachable** |
| `GET /api/geocode` | `frontend/src/api/client.js:132` ← `geocode` ← `components/PlaceInput.jsx:3` | **reachable** |
| `POST /api/report-barrier` | *nothing* | **UNREACHABLE** |
| `GET /metrics` | *nothing in UI or infra* — only prose in `docs/RUNBOOK.md:17`, `docs/RELEASE-PROMPT.md:515` | **UNREACHABLE** (by design — see §7 note) |
| `GET /healthz` | not the UI; `docker-compose.yml:64`, `infra/20-services.yaml:316` | unreachable from UI, **live in infra** |
| `GET /readyz` | not the UI; `infra/20-services.yaml:371` (`HealthCheckPath`), alarm at `:451` | unreachable from UI, **live in infra** |
| `GET /api/health` | *nothing anywhere* — no UI caller, no infra caller | **UNREACHABLE** |

**Side finding (a real doc bug, cheap to fix):** `DEPLOY.md:166`, `docs/RUNBOOK.md:15` and `docs/IOS-LAUNCH-PROMPT.md:397` all tell an operator to run `curl -s $SITE/api/healthz`, and `docs/RUNBOOK.md:17` says `curl -s $SITE/api/metrics`. **Neither path exists.** The routes are `/healthz` and `/metrics`, *not* under `/api`. `grep -n "api/healthz\|api/metrics" backend/main.py` returns nothing. The runbook's first two diagnostic commands 404 against a healthy instance.

---

## 2 & 3. Every response-model field, and who consumes it

All models in `/Users/poojana/Meander/Meander/backend/models.py`.

### `Route` (`models.py:143-184`)

| Field | Model line | Consumed by | Verdict |
|---|---|---|---|
| `id` | `:144` | `App.jsx:127`, `MapView.jsx:322`, `RouteDetail.jsx:61` | ok |
| `label` | `:145` | `RouteDetail.jsx:78`, `MapView.jsx:322,523,542`, `lib/format.js:195,208` | ok |
| `status` | `:146` | `App.jsx:135`, `RouteRow.jsx:37`, `RouteDetail.jsx:62`, `MapView.jsx:516`, `lib/format.js:190,194,204` | ok |
| `geometry` | `:147` | `MapView.jsx:314,322-323,445-446,463-466,538`, `FollowMode.jsx:49`, `RouteRow.jsx:38`, `StepList.jsx:83` | ok |
| `duration_min` | `:148` | `RouteRow.jsx:40`, `RouteDetail.jsx:81`, `DaylightGuard.jsx:16,24`, `FollowMode.jsx:135-136`, `lib/format.js:195,208` | ok |
| `distance_m` | `:149` | `RouteRow.jsx:91`, `RouteDetail.jsx:81`, `FollowMode.jsx:51`, `lib/format.js:195,208` | ok |
| **`mode`** | `:150` | **nothing** — `grep -rn "route\.mode\|r\.mode\|selectedRoute\.mode\|followRoute\.mode" frontend/src/` is empty. The UI recomputes it client-side instead (`App.jsx:192-195` → `lib/format.js` `effectiveMode`) | **UNREACHABLE** |
| `scores.scenic` | `:87` | `RouteRow.jsx:102` + `RouteDetail.jsx:134` via `SCORE_ROWS` (`RouteRow.jsx:6`) | ok |
| `scores.air` | `:88` | same, `RouteRow.jsx:7` | ok |
| `scores.shade` | `:89` | same, `RouteRow.jsx:8` | ok |
| `scoring_method` | `:152` | `RouteRow.jsx:130`, `RouteDetail.jsx:65,166`, `lib/format.js:207` | ok |
| `confidence` | `:153` | `RouteRow.jsx:129`, `RouteDetail.jsx:64`, `VerificationMeter.jsx:18-38` | ok |
| `rest_stops` | `:154` | `RouteDetail.jsx:106,111,115`, `RouteRow.jsx:93`, `MapView.jsx:426`, `FollowMode.jsx:132` | ok (but see the defect in §4c) |
| `blockers` | `:155` | `RouteDetail.jsx:100`, `MapView.jsx:517`, `StepList.jsx:83`, `FollowMode.jsx:140-141` | ok |
| `steps` | `:160` | `StepList.jsx:73`, `RouteDetail.jsx:181`, `FollowMode.jsx:129-131` | ok |
| **`elevation`** | `:161` | **nothing** — see §4 | **UNREACHABLE** |
| `narration` | `:162` | `RouteDetail.jsx:87-88` | ok |
| `synthetic_upstream` | `:166` | `Ribbon.jsx:18`, `RouteDetail.jsx:167` | ok |
| `confidence_note` | `:169` | `RouteDetail.jsx:66` | ok |
| `status_note` | `:173` | `RouteDetail.jsx:98`, `lib/format.js:196,205` | ok |
| **`enrichment_pending`** | `:184` | **nothing** — `grep -rn "enrichment" frontend/` returns zero hits | **UNREACHABLE** |

### `Step` (`models.py:126-140`)

| Field | Line | Consumed by | Verdict |
|---|---|---|---|
| `text` | `:135` | `StepList.jsx:16,93`, `FollowMode.jsx:177,218` | ok |
| `distance_m` | `:136` | `StepList.jsx:17,23,24,108` | ok |
| **`duration_min`** | `:137` | **nothing** — no `step.duration_min` anywhere | **UNREACHABLE** |
| `street_name` | `:138` | `StepList.jsx:105,107` | ok |
| **`sign`** | `:139` | **nothing** — `grep -rn "\.sign\b" frontend/src/` is empty | **UNREACHABLE** |
| `interval` | `:140` | `StepList.jsx:56,98,100`, `lib/follow.js:93,106,107` | ok |

### `ElevationProfile` (`models.py:99-116`) — every field UNREACHABLE

| Field | Line | Verdict |
|---|---|---|
| `distances_m` | `:107` | **UNREACHABLE** |
| `elevations_m` | `:108` | **UNREACHABLE** |
| `ascent_m` | `:109` | **UNREACHABLE** |
| `descent_m` | `:110` | **UNREACHABLE** |
| `max_gradient_pct` | `:111` | **UNREACHABLE** |
| `steep_spans` | `:115` | **UNREACHABLE** |
| `limit_pct` | `:116` | **UNREACHABLE** |

Grep for all seven names across `frontend/` returns **zero hits**. The only occurrence of the word "elevation" in the entire shipped frontend is `frontend/src/styles.css:57` — `/* -- elevation (§2.6) --- */`, a Material-style *shadow-depth* token block (`--shadow-1`, `--shadow-2`). It has nothing to do with terrain.

### `RestStop` (`models.py:92-96`) — all consumed
`lat`/`lon` → `MapView.jsx:429`, `RouteDetail.jsx:116`; `type` → `RouteDetail.jsx:116,118`, `lib/format.js:178`, `FollowMode.jsx:227`; `at_m` → `RouteDetail.jsx:118`, `lib/format.js:184`, `lib/follow.js:115-118`.

### `Blocker` (`models.py:119-123`) — all consumed
`type`/`description` → `RouteDetail.jsx:33`, `StepList.jsx:113`, `MapView.jsx:523`, `FollowMode.jsx:190-191`; `lat`/`lon` → `MapView.jsx:519`, `StepList.jsx:47-48`, `FollowMode.jsx:159`.

### `RoutesResponse` (`models.py:192-196`) / `CacheInfo` (`:187-189`)
`routes` → `App.jsx:241`; `best_departure` → `App.jsx:244` → `DepartureStrip` (`App.jsx:412`); `reason` → `App.jsx:243`, `App.jsx:431`; `cache.segments_scored` → `About.jsx:37`; `cache.hit_rate` → `About.jsx:38`. All consumed.

### `GeocodeResponse` / `GeocodeResult` (`models.py:199-206`)
`results` → `client.js:139`; `name` → `PlaceInput.jsx:76,133,145`; `lat`/`lon` → `PlaceInput.jsx:133`. All consumed.

### `BarrierReport` (`models.py:209-215`)
`lat`, `lon`, `type`, `description` — **all four UNREACHABLE.** This is a request model with no client that constructs it.

### SSE event fields (`main.py:690`, `:847`, `:906`, `:970`)
`progress.pct` → `StatusBanner.jsx:39,51,54`; `progress.text` → `StatusBanner.jsx:43`; **`progress.segments_scored` → UNREACHABLE** (only appears in `api/mock.js:304-307`, never read); `route` → `client.js:117`; `done.payload` → `client.js:118`; `error.kind`/`.message` → `client.js:119-122`.

### Response headers
`X-Meander-Cache` (`main.py:1134,1136,1145,1161`) — **UNREACHABLE**, zero hits in `frontend/`. `Retry-After` is read into `ApiError.retryAfter` (`client.js:68,46`) but **never rendered** — grep for `retryAfter` outside `client.js` is empty, so the rate-limit wait time is captured and discarded.

---

## 4. The two headline claims — verified

### (a) `POST /api/report-barrier` — **CLAIM CONFIRMED**

Fully built: `backend/main.py:1211-1244` (rate-limited, structured error envelope, returns `{status, note_id, target, message}`), backed by `backend/osm_report.py:52-114` with a call-time host assertion at `:36-44`.

**No UI caller. Proven, not assumed:**
- No string `report-barrier`, `reportBarrier`, or `report_barrier` anywhere in `frontend/` (case-insensitive).
- The only two `fetch(` calls in the frontend are `/api/routes` and `/api/geocode` (see §0). There is no third path a dynamic URL could take.
- No `BarrierReport`-shaped body is constructed anywhere; `api/mock.js` has no barrier mock.
- The component that used to call it still exists on the other branch: `git show feat/launch:frontend/src/components/ReportBarrier.jsx` (157 lines) imports `reportBarrier` from `../api/client.js:3`, and `feat/launch:frontend/src/api/client.js:199-203` defines `reportBarrier` posting to `/api/report-barrier`. **Neither the component nor the client function is on `main`** — `git ls-tree -r feat/launch -- frontend/src` lists `ReportBarrier.jsx`; the same listing on `main` does not.

**One correction to the brief's framing:** the brief says the feature "needs `OSM_DEV_TOKEN`". It does not — see §7. Anonymous notes are explicitly supported (`osm_report.py:60-63`). The thing that *actually* breaks it on the shipped deployment is fixture mode, not the token.

**CSP is not a blocker for a port:** `frontend/vercel.json` `connect-src` is `'self' https://tiles.openfreemap.org https://REPLACE-WITH-YOUR-RENDER-HOST.onrender.com`, so a `fetch()` POST to the same API base is allowed. Note `form-action 'none'` — the port must use `fetch`, not a native form submit.

### (b) `Route.elevation` — **CLAIM CONFIRMED, with one correction**

Populated at `backend/main.py:556-558`:
```python
elevation=(
    ElevationProfile(**vars(assessment.elevation)) if assessment.elevation else None
),
```
fed by `_assess` at `backend/main.py:490` (`_guard("elevation_profile", build_profile, raw.points, raw.elevations or None)`), implemented in `backend/elevation.py:63-125`.

**No UI reader.** Zero hits for `elevation`, `distances_m`, `elevations_m`, `ascent_m`, `descent_m`, `max_gradient_pct`, `steep_spans`, `limit_pct`, `gradient`, `ascent`, `descent`, `incline`, `slope`, `steep` across all of `frontend/` (the only `gradient` hits are CSS `repeating-linear-gradient` for dash swatches, `styles.css:1152`, `lib/dash.js:114`). `feat/launch:frontend/src/components/ElevationProfile.jsx` (116 lines) reads exactly these fields at its `:26` and `:45-47` and is absent from `main`.

**Correction to the brief:** "populated on **every** response" is too strong. `build_profile` returns `None` when the router gave no elevation, when the array lengths disagree, or for fewer than 3 points (`elevation.py:72-73`, `:77-78`), and `_guard` (`main.py:607-619`) returns `None` on any exception. It is also always `None` on the blocked-route path (`main.py:637-650` constructs `Route(...)` without `elevation`).

**But in practice, on the shipped demo, it is populated with real data.** I probed it. All 86 recorded GraphHopper paths carry 3-D coordinates (`routing.py:357,385` sets `"elevation": True`; `:468` parses the third ordinate). A live `POST /api/routes` against the committed replay fixtures (Colombo Fort → Viharamahadevi, 25 min) returned:

```
fastest    : n=120, ascent 7.3 m, descent 7.7 m, max 1.9%, steep_spans [],                    limit_pct 8.0
scenic     : n=120, ascent 66.2 m, descent 68.7 m, max 8.4%, steep_spans [[42,48],[50,52],[75,79]], limit_pct 8.0
accessible : n=120, ascent 7.4 m, descent 7.6 m, max 1.8%, steep_spans [],                    limit_pct 8.0
```

So the scenic route ships three genuinely-over-8% spans, correctly marked, on every request — and nothing renders them.

### (c) Bonus defect found while proving this — `enrichment_pending` is not just unused, its absence causes a false claim

`models.py:176-184` states in terms: *"The UI must not render rest stops or the air and shade scores as measured while this is true."* The UI has never heard of the field.

I probed the SSE stream with the same body:
```
progress, progress, progress,
route fastest (enrichment_pending=true),  route scenic (true),  route accessible (true),
progress,
route fastest (false), route scenic (false), route accessible (false),
progress, done
```

The first-pass route carries `rest_stops: []` (`main.py:559-562`, `rest_stops or []` with `rest_stops=None`). The client merges by id and renders immediately (`App.jsx:124-144`). `RouteDetail.jsx:106` tests `route.rest_stops == null` → false for `[]`, so `:111-112` renders **"No rest stops found along this route."** — and `RouteRow.jsx:93` → `lib/format.js:135` renders **"no rest stops"** — during the entire enrichment window, for a route nobody has looked at yet. That is precisely the false claim `models.py:180-183` was written to prevent. (The score bars degrade honestly: `null` renders "not measured", `RouteRow.jsx:99-103`.)

Any spec for wiring these fields up should fix this too: gate on `enrichment_pending` and render the `rest_stops == null` branch's honest wording (`RouteDetail.jsx:107-110`) while it is true.

---

## 5. Test counts

Counts are pytest-collected (parametrisation expanded), run with `/Users/poojana/Meander/Meander/.venv/bin/python -m pytest --collect-only -q`.

**Barrier reporting — 25 tests total, all passing:**

| File | Tests | Note |
|---|---|---|
| `backend/tests/test_barrier_reporting.py` | **12** | whole file is barrier reporting; `12 passed` |
| `backend/tests/test_streaming_and_reporting.py` | **10** of 21 | 21 collected (18 functions, `test_any_other_host_is_refused` parametrised ×4 at `:148-157`). Streaming tests are at `:34,41,50,59,67,76,84,94,101,116,121` = 11; the remaining 10 are barrier: `:137`, `:157`(×4), `:164`, `:174`, `:182`, `:186`, `:191` |
| `backend/tests/test_hardening.py` | **3** | `:160` token sent, `:188` anonymous note, `:214` token never reaches a fixture |

**The brief undercounts this.** `docs/RELEASE-PROMPT.md:296-298` claims *"~16 tests behind it (`test_barrier_reporting.py` 12 + `test_streaming_and_reporting.py` 4)"*. The real figures are 12 + 10 + 3 = **25**. The `test_hardening.py` trio is missed entirely, and the streaming file's contribution is 10, not 4.

**Elevation — 12 tests, all passing, all unit-level:**

`backend/tests/test_elevation.py` — 12 collected, `12 passed`. `grep -rln "build_profile\|ElevationProfile" backend/` returns only `models.py`, `elevation.py`, `main.py`, `tests/test_elevation.py`.

The brief's "12 tests" is correct, but there is a **coverage gap worth naming in the spec**: all 12 test `build_profile` directly (`test_elevation.py:14`). None uses the `api_client` fixture — `grep -n "api_client\|/api/routes" backend/tests/test_elevation.py` is empty — and `test_api_routes.py` and `test_sse_contract.py` contain no mention of `elevation`. **Nothing asserts that the profile survives onto the wire.** The `ElevationProfile(**vars(...))` dataclass→pydantic conversion at `main.py:557` is unguarded by any test. My live probe is currently the only evidence it works.

---

## 6. The 8% gradient constant

```
backend/accessibility.py:90:    MAX_INCLINE_PCT = 8.0
```

Exact name **`MAX_INCLINE_PCT`**, exact value **`8.0`** (a float), at **`backend/accessibility.py:90`**, inside the block commented "Gradient limits" at `:87-93`. Its neighbours: `SUSTAINED_INCLINE_PCT = 5.0` (`:91`), `SUSTAINED_INCLINE_OVER_M = 50.0` (`:92`), `INCLINE_SMOOTHING_WINDOW_M = 20.0` (`:93`).

**Is it importable/exported anywhere a frontend build step could read it? No.**

It is a bare Python module-level float. Consumers are all Python:
- `backend/accessibility.py:240,253` (the verdict)
- `backend/elevation.py:29,52,92,124` (imported, never restated — the invariant `elevation.py:8-13` insists on)
- `backend/tests/test_elevation.py:13`, `backend/tests/test_accessibility.py:19`

There is **no** JSON/TS/JS export, no OpenAPI-schema codegen step, no shared-constants file. `frontend/package.json` scripts are plain `vite`/`vite build`/`vitest run` with no pre-build generation, and `frontend/vite.config.js` has no plugin that reads the backend. `scripts/` contains no codegen (only `graphhopper.sh`, `load_test.py`, fixture tooling, `verify_selfhosted.py`, etc.).

**However — a build-step import is not needed, and the spec should say so explicitly.** The value already travels **per route, at runtime, on the wire** as `ElevationProfile.limit_pct` (`models.py:116`, defaulted from `MAX_INCLINE_PCT` at `elevation.py:52` and set explicitly at `elevation.py:124`). My probe confirms `limit_pct: 8.0` arrives on all three routes. The `steep_spans` are likewise computed server-side against the same constant (`elevation.py:92`). So a ported `ElevationProfile.jsx` must read `profile.limit_pct` and `profile.steep_spans` off the payload and **must not hard-code `8`** — that is exactly what `feat/launch:frontend/src/components/ElevationProfile.jsx:13` documents and `:26` does (`limit_pct: limit` destructured from the profile). Preserving that is what keeps "the drawing and the verdict cannot disagree" true without any build-time coupling.

---

## 7. `OSM_DEV_TOKEN`

**What it is.** An OAuth 2.0 bearer token for `api06.dev.openstreetmap.org`, the OSM **development** server. Documented at `backend/osm_report.py:55-63` and `.env.example:47-50`.

**Where it is read** (three places, in this order):

1. `backend/config.py:342` — `osm_dev_token=_clean("OSM_DEV_TOKEN")` inside `load_settings()`. `_clean` (`config.py:330-335`) strips whitespace and maps `""` → `None`, so **an empty string and an unset variable are indistinguishable.**
2. `backend/config.py:254` — the `Settings` dataclass field, `osm_dev_token: str | None = None`.
3. `backend/osm_report.py:69-70` — the only consumer:
   ```python
   if settings.osm_dev_token:
       headers["Authorization"] = f"Bearer {settings.osm_dev_token}"
   ```
4. `backend/fixtures.py:481-489` — a safety backstop (`_assert_no_secret_in_fixture`) that deletes any recorded fixture containing the token's value.

**What happens when it is empty.** Three separate consequences, and the spec needs all three:

1. **The `Authorization` header is simply omitted** (`osm_report.py:69`). The note is filed **anonymously**, which the OSM API permits — this is deliberate, not a fallback. `osm_report.py:60-63` says so explicitly, and it is tested twice: `test_barrier_reporting.py:130` (`test_without_a_token_it_still_files_anonymously`) and `test_hardening.py:188` (`test_no_token_still_files_an_anonymous_note`, asserting `"Authorization" not in seen`).
2. **It has no effect on health, readiness, or startup.** `OSM_DEV_TOKEN` is absent from both `Settings.missing_keys()` (`config.py:264-280` — only `GRAPHHOPPER_KEY`, `MAPILLARY_TOKEN`, `ANTHROPIC_API_KEY`) and `Settings.missing_required_keys()` (`config.py:282-299`). So `/readyz` stays 200, `/api/health`'s `keys_ok` stays true, and `MEANDER_STRICT_STARTUP` will not refuse to boot.
3. **The real blocker is fixture mode, not the token.** `submit_barrier` goes through `fixtures.fetch(..., service="osm_dev")` (`osm_report.py:73-84`). The default mode is `replay` (`config.py:302-306`, `.env.example:58`), and **there is no `fixtures/osm_dev/` directory** — `ls fixtures/` shows only `graphhopper`, `mapillary`, `nominatim`, `open_meteo`, `overpass`. In replay mode the call therefore raises `FixtureMissing`, caught at `osm_report.py:85-90` and turned into HTTP **503**: *"Barrier reporting is not available on this server right now. Nothing was sent."* This is asserted by `test_streaming_and_reporting.py:174` (`test_reporting_without_a_fixture_fails_safely`).

**Deployment state:** `OSM_DEV_TOKEN=` is declared empty in `.env.example:50` and referenced only in `docs/legacy/render.yaml:39`. It appears in **no** current infra template — `grep -rn "OSM_DEV_TOKEN" infra/ docker-compose.yml Makefile` returns nothing. The current AWS deployment does not set it at all.

**Implication for the ReportBarrier port.** The honest degradation the brief asks for (`docs/RELEASE-PROMPT.md:303-305`) must key on the **503 response**, not on token presence — the frontend cannot see the token, and the token is not what breaks the feature. With `MEANDER_FIXTURES=replay` (the shipped default) the form will always 503 with a truthful "Nothing was sent" body, and the UI should surface that message verbatim rather than presenting a form that appears to succeed. A budget of 20 calls/day is already reserved for the service (`config.py:160`, `"osm_dev": 20`) for when the deployment is switched to `live`.


---
