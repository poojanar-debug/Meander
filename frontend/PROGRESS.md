
---

## The gate could drive a browser it did not start · 2026-08-26

`main`'s CI went red on the commit that had just passed the same gate on its
own PR. The frontend job died at the layout gate with:

```
TypeError: fetch failed
  [cause]: Error: connect ECONNREFUSED 127.0.0.1:9444
```

A re-run went green, which is the worst possible outcome: nothing was wrong
with the build, nothing was learned, and the lesson on offer was "press the
button again". Pulling the thread found four defects in about forty lines of
CDP glue, none of them touched since `73a7386` wrote the gate on 2026-08-08.

**1. `launch()` reported success whether or not it had reached a browser.**
It polled `/json/version` a hundred times at 100 ms and `break`-ed out of the
loop either way, then returned the same `{ proc, port }` in both cases. The
ECONNREFUSED came from the *next* call, so the run ended with a stack trace
about `fetch` rather than a sentence about Chrome. Success is now the only
path that returns; every other outcome prints what happened and exits 2.

**2. Ten seconds was not enough for a cold runner.** Now thirty. The number is
patience, not tolerance: nothing the gate accepts has changed, only how long
it waits for a browser to exist.

**3. `stdio: 'ignore'` threw away the reason.** A launch that fails for a real
reason — a missing shared library, a sandbox refusal, a profile another
instance holds — says so on stderr, and the gate was discarding it. stderr is
piped and the first lines are reported. Proved with a fake browser that exits
127 after writing `error while loading shared libraries: libnss3.so`; the
gate now prints that line back.

**4. The one that matters: a fixed port let the gate adopt a stranger.**
`--remote-debugging-port=9444` plus "poll until something answers" does not
identify the browser that answered. **Demonstrated on purpose**: with a Chrome
left over from an earlier run holding 9444, pointing `CHROME_PATH` at
`/bin/false` — a binary that cannot serve anything — still produced a
connected gate and twelve graded checks. Where the stale browser happens to
sit on the right page, the same path reports a **pass that means nothing**,
which is the exact failure this file's header was written to refuse.

The port is now `0`. The kernel picks a free one, Chrome announces it on
stderr, and the gate connects to that — so the port it drives is by
construction the port of the browser it spawned. Re-running the `/bin/false`
demonstration with a live decoy on 9444 now exits 2 and grades nothing.

**And the leak that manufactured the stranger.** `proc.kill()` ran in exactly
one place, after the report, so any throw in between left a headless Chrome
running — and a crashed run of this gate is what leaked the browser found on
9444 (`Inspected target navigated or closed`, from two gates sharing a port
and a profile). The browser is now reaped on `exit`, `SIGINT`, `SIGTERM`, and
on an uncaught throw or rejection, which also stops "the gate crashed" from
being reported as "checks failed".

Two smaller ones in `connect()`, both silent for the same reason:
`targets.find(t => t.type === 'page')` was dereferenced unguarded, so a
browser with no page target died on `Cannot read properties of undefined`;
and `ws.onerror = rej` rejected with an `Event`, which renders as
`[object Event]` wherever it surfaces.

**Verified, each failure path made to fail on purpose before the gate was
trusted again** — the rule BLOCKED.md §5 states and this is the first change
to actually apply it to `gate.mjs` itself:

| provoked | reported |
|---|---|
| `CHROME_PATH=/bin/false` | `Chrome exited with code 1`, exit 2 |
| a browser exiting 127 with a linker error | the linker error, verbatim, exit 2 |
| a browser that starts and never announces a port | `never announced a debugging port within 30s`, exit 2, after exactly 30 s |
| a live decoy on 9444 plus `/bin/false` | exit 2, nothing graded (was: 12 checks graded) |

And the happy path is unchanged: 69 of 69 green in a real headless Chrome.

**No application code changed.** This is entirely the harness that grades it.

---

## Somewhere to go — the destination end of a trip · 2026-08-26

The backend has accepted a `destination` since Phase C, `models.py` has
`is_loop()`, `budget_minutes()` and `straight_line_m()` built around it, and
`buildRouteRequest`, `encodeState`, `resultsStore.js`, `MapView`, `RouteDetail`
and `ExportPills` all already handled one. **Nothing on screen could set it.**
The only way to ask for a point-to-point trip was to hand-write a `?to=` link,
which App.jsx said out loud in a comment: "a destination can only arrive
through a permalink in this design".

This is the missing control, on both plan surfaces, in the 2026 language.

**Done**

- **Desktop capsule** gains a destination segment between the origin and the
  minutes, split by the same 1x22 hairline, wearing an ink dot to match the
  map's own `marker--dest`. Its popover is the same `PlaceInput` combobox the
  origin uses, plus the hint DESIGN-HANDOFF §4.3 wrote for this exact drawer:
  "Empty means a round trip — Meander brings you back to where you started."
- **Mobile plan sheet** gains a second search field under the first, the same
  input-fill row with the same magnifier, and a 44x44 clear control once a
  destination is set. It opens the same full-surface place screen.
- `PlaceSearch` now serves both ends. One `FIELDS` table decides the label, the
  placeholder and the dialog's accessible name; an unknown key falls back to
  the origin, which is the one input the app cannot run without.
- Both place segments carry a visually-hidden key ("Starting point:",
  "Destination:"), so a screen reader gets "Destination, Round trip" rather
  than a button called "Round trip".
- The mobile results summary reads `to Vondelpark · Auto` for a point-to-point
  trip instead of a dial position that did not describe it.
- `api/mock.js` draws to the destination. It used to draw every point-to-point
  route on a **fixed bearing of 22 degrees at a fixed 2100 m** whatever was
  asked for, which nothing noticed because nothing could ask. Its auto mode now
  reads the straight line through the same `deriveModeForDistance` the app
  uses, imported rather than restated.
- `gate.mjs` grades the new screen: the destination field is in the plan
  manifest, and a new `[destination]` pass picks a place through the real
  combobox, checks the clear control and the budget note exist, asserts the
  dial is *gone*, sweeps 44x44 and axe in both themes, and presses Find routes
  to prove a destination still reaches the request. 69 checks, from 56.

**Decisions**

- **The time dial is absent, not disabled, once there is a destination.**
  `buildRouteRequest` omits `minutes` from a point-to-point body and
  `encodeState` omits it from the link, so the dial cannot change that
  request — not its length, not its mode, not even its cache row. A control
  that moves and changes nothing is the one thing this UI is not allowed to
  be. The precedent is `BestWindow`, which does not render at all rather than
  name a time it cannot stand behind. On the capsule the segment goes; on the
  sheet one mono sentence stands where the dial stood.
- **No "use my location" beside the destination**, and that absence is
  load-bearing rather than an oversight. `resultsStore.js` hashes the
  destination byte-exact while snapping the origin to an ~11 m grid, and the
  reason it is allowed to is written in its own header: a device fix cannot
  reach that field. `destination-contract.test.js` asserts the `onLocate`
  handler still dispatches `type: 'origin'` and nothing else.
- **Two place names now share the capsule**, so neither keeps the 240 px it
  had. 200 each still fits "Viharamahadevi Park" whole, and because the cap is
  a hard `max-width` the pill's width is bounded by construction rather than by
  the data: measured at **840 px** with two names long enough to hit both caps,
  which leaves 92 px either side at 1024 and no horizontal scroll. "Round
  trip" takes the placeholder weight §4.3 gives a placeholder value.
- The `nonce` model is untouched. Picking a destination changes state and
  nothing else; **Find routes** is still the only thing that asks.

**Verified**

- 547 frontend tests pass, 14 of them new in
  `src/lib/destination-contract.test.js`: the mock's three routes each end
  within 5 m of the chosen point, a loop still returns to its origin, auto mode
  reads the straight line rather than the dial's default (Colombo to Kandy is a
  drive, not a walk), and both plan surfaces, the place screen and App's
  `planProps` all carry the handler.
- `node scripts/gate.mjs` — 69 of 69 green in a real headless Chrome, both
  themes, including the new destination pass.
- `npm run build` clean.

**Four things found on the way, three of them older than this change.**

- **`Find routes` broke onto two lines on every desktop window under about
  1600 px**, and had since the redesign shipped. `.capsule-wrap` is absolutely
  positioned with `left: 50%`, and an abspos box with `left` set and `right:
  auto` shrinks to fit *the space left of it* — half the viewport. The pill
  wanted 657 px at HEAD against a 640 px cap at 1280, so it squeezed the one
  child that could reflow and stood 77 px tall instead of 60. Measured against
  a build of HEAD's own sources before touching it, because a second place
  name makes the pill wider and it would have been easy to call this a
  regression. Centred with `left: 0; right: 0; margin-inline: auto; width:
  max-content` instead, which also fixes a second symptom nobody had named:
  `drop-in` ends on `transform: none`, so the centring translate was cancelled
  for the 220 ms of the animation and the capsule slid sideways into place on
  every mount. Now 776 x 60 at every width from 1024 up, and the action is one
  line and 44 px tall.
- **"Finding you…" never went away.** `onLocate` set `phase: 'locating'` and
  the `origin` case that answers it left the phase alone, so the hint sat under
  a field already showing the place it had found until Find routes moved the
  phase on. The `geoDenied` case had the right shape all along; `origin` now
  matches it.
- **`Edit plan` wrapped** once the summary beside it could hold a place name.
  That one is this change's: the row read `35 min · Auto` before, which never
  filled it. The summary truncates, the control does not.
- **And one that was the gate's own.** The first run failed
`[destination][light] every target clears 44x44` on `.sheet__grabber-hit` at
**43.999996 px** against a 44 px minimum, and passed in dark. The resting
height is exactly 44 in every state measured; picking a place unmounts the
search screen and remounts the sheet, whose height is an inline style with a
transition on it, and the sweep was landing mid-transition. It failed about
half the time. Fixed by making `pickDestination` wait for two equal readings of
the sheet's height before returning, rather than by sleeping and hoping — a
gate that fails at random teaches people to re-run it until it is green, which
is the same as not having one. Five consecutive runs green after it.

**Live API calls:** none. Verified against `VITE_MOCK_API=1`.

---

## The 2026 UI — full presentation rewrite · 2026-08-25

The presentation layer replaced wholesale with the approved 2026 mockups
(`docs/DESIGN-2026.md`):
full-viewport map, floating plan capsule + streaming card row + centered
detail modal at 1024px and up, draggable bottom sheets below it, a
full-surface place search, and the follow-mode banner/dock/cards. Everything
below the presentation layer is kept: the reducer and nonce fetch trigger,
api/client.js and its SSE merge-by-id handling, the formatters, the whole
follow-mode engine (`lib/follow.js`, `lib/followTracking.js`), the service
worker, and the contract tests.

**Done**

- New token layer: warm neutrals + five accent families (sky/mint/lilac/
  amber/rose as deep/wash/on-wash/border), stated oklch values converted to
  hex (MapLibre's colour parser reads no oklch); Hanken Grotesk (variable) and
  Space Mono self-hosted from `src/fonts/` so the precached shell includes
  them; basemap repainted to `#ECF0E6/#DEEBD3/#D9E7EE/#FBFAF6`.
- One look: the `[data-theme='dark']` block restates the light palette. It
  stays because check_palette.sh, dash-palette.test.js and make-icons.mjs are
  pinned to its shape. `color-scheme: light !important` outranks the inline
  boot script's per-preference write, which the CSP hash makes expensive to
  edit.
- Components renamed only where the subject died; every file a source-scan
  test binds to (RouteRow, RouteDetail, StepList, FollowMode, ElevationProfile,
  DepartureStrip, ReportBarrier, ManoeuvreIcon, MapView, PlaceInput) keeps its
  name and its pinned behaviours (`WORTH_SAYING_M`, `steps?.[stepIndex + 1]`,
  the layer-listener sweep, threaded units). Deleted with their subjects:
  Topbar, TripBar, TripDrawer, FirstRun, About, OfflineBar/Control,
  UnitsControl, ThemeToggle, VerificationMeter, ShareButton, TakeItWithYou
  (exports live in ExportPills now), DaylightGuard.
- Plan edits are inert; the nonce is bumped only by **Find routes**, Try
  again, and an arriving permalink. Selection, units and the follow id moved
  out of the reducer into App state, per the spec's state contract.
- gate.mjs rewritten, not ported — the previous header's own rule. Same rigor
  (selector manifests that must match, 44×44 sweeps behind every disclosure,
  axe in both themes, one live region), new subjects, plus the desktop modal
  and a driven follow pass. live-gate.mjs likewise; its consent-flow checks
  are skip()ed by name because no consent control exists in this design.

**Verified**

- vitest 533/533 · check_palette.sh (self-tested) · gate.mjs 56/56 in headless
  Chromium against the mock build · `VITE_MOCK_API=1` build clean, fonts in
  the precache manifest.
- Screenshots at 390, 320 and 1440 against the mockups, every screen. A note
  for the next person: this VM's snap Chromium needs
  `--use-angle=swiftshader` or MapLibre's canvas freezes at city-scale zooms —
  DOM state stays correct, only the composited pixels stall. The gate reads
  DOM, so it is immune; screenshots are not.

**Decisions and deviations, all deliberate**

- The a11y gate outranks the swatch where they conflict, and only there:
  filled buttons use `--sky-action` (oklch 0.55, the nearest tone where
  surface-white 14–16px text clears 4.5:1; the stated `#4E7FBE` measures
  4.01:1 and keeps every graphic use — lines, dots, the puck); text the
  mockups set tertiary `#A6A49B` (2.4:1) renders in `--ink-2`; text on tinted
  grounds uses `--ink-2-deep`; the follow provenance line runs at 70% opacity
  rather than 50% (2.99:1 over the basemap); the coverage card's subline
  drops its 75% opacity.
- `UNKNOWN` is the em dash again, by the spec's stated rule ("unknown renders
  as —"), and no-em-dash.test.js now allowlists the approved copy instead of
  banning the glyph — a stray dash still fails.
- The breakpoint constant moved 899 → 1023 (`MOBILE_LAYOUT`), still written
  once and shared.
- `--brand`/`--accent` keep their old values: they exist only for the icon
  generator, and the launcher identity is outside this spec's scope.
- Mobile results carry a small `Edit plan` row and the plan gains a
  `Back to routes` pill when reopened over results — the spec names no way
  back from results to plan, and a screen with no way out is not shippable.
- quiet/shade/air route hues are placeholders from the same oklch system
  (their chips ship disabled `· soon`); the palette test needs the table
  total.

## Redesign phase 1 — Design system · 2026-08-06

First of eight phases implementing `docs/DESIGN-HANDOFF.md`, which is now in the
repo and is the specification for the frontend.

**Done**

- The whole token layer replaced with handoff §2 — a brand-led dark green
  palette in place of the navy-on-cream one, plus a full `[data-theme="dark"]`
  block, the §2.3 route identity table, the §2.4 map palette, the §2.5 type
  scale, and §2.6 space, shape and elevation.
- Theme toggle in the topbar, persisting to `localStorage['meander:theme']` and
  defaulting to `prefers-color-scheme`. `lib/theme.js` owns the logic;
  `ThemeToggle.jsx` is the control; the reducer gained a `theme` case.
- `lib/dash.js` carries light and dark variants of all six route colours.
  **Dash arrays are untouched** and `swatchBackground()`'s gradient algorithm is
  untouched — it gained an optional theme argument and nothing else.

**Verified**

- `grep` for hard-coded hex outside the two `:root` blocks in `styles.css`
  returns nothing:
  `awk '/^:root|^\[data-theme/{b=1} b&&/^}/{b=0;next} !b&&/#[0-9a-f]{3,8}/'`
- `npm run build` clean; both themes render; the toggle round-trips and the
  choice survives a reload (`localStorage` reads back `light` after switching).

**Decisions**

- **The theme resolves in an inline `<script>` in `index.html`, not in React.**
  React commits its first effect well after the browser has painted, so a
  dark-mode visitor got a full frame of cream page before the app corrected it.
  Inline and synchronous in `<head>` is the only place early enough. It makes no
  network request — one `localStorage` read and one media query — so the
  no-third-party-requests rule still holds. The cost is that the logic exists
  twice, in the HTML and in `lib/theme.js`; they must agree on the key name.
- **A stored choice outranks the system preference permanently**, not just at
  load. Someone who explicitly picked light should stay in light when their
  laptop flips to dark at sunset. The media-query listener therefore re-checks
  storage before acting rather than only being attached conditionally.
- **Score meters lost their individual hues.** Scenic, clean air and shade were
  green, blue and amber; `--score-air` was the same blue as the Fastest route's
  line, so blue meant both "this route" and "this score". All three now use
  `--accent` and are told apart by their labels (§2.3).
- Every `localStorage` call is wrapped. Safari in private mode throws on
  *access*, not only on write, so even the read in `index.html` is in a
  try/catch.
- Physical CSS properties replaced with logical ones (`padding-inline`,
  `text-align: start`, `inset-inline-start`) ahead of the §8 RTL requirement,
  since the whole file was being touched anyway.

**Deviations**

- The handoff writes the space scale as "`--s1 … --s10`" and then enumerates
  eight values. Eight is what the rest of the document references (`--s2` gap,
  `--s5` padding, `--s8`/`--s6` first-run padding), so `--s1` … `--s8` is what
  exists.
- `Header.jsx` gained the toggle but has not yet become `Topbar.jsx` — that is
  phase 2's rename, and doing it here would have made this commit two changes.

**Live API calls:** none. The frontend was verified against `VITE_MOCK_API=1`.

## The other three objectives, released · 2026-08-26

The chip row has offered six objectives since it was written and only three
could be pressed: `quiet`, `shade` and `air` were `disabled`, read `· soon`, and
`ObjectiveChips.jsx` held a `SOON` set naming them. The backend now routes all
six, so the set is gone and nothing in this component special-cases an
objective any more — `dash.js`'s identity table is the only thing deciding what
the row offers.

**Done**

- `ObjectiveChips.jsx` loses `SOON`, `disabled` and the `· soon` span.
- Three new palette families, one per newly-pressable objective, each the
  objective's own route hue taken through the same oklch steps as the existing
  five: `--indigo-*` (quiet, H=275), `--teal-*` (shade, H=195), `--clay-*`
  (air, H=45). Contrast on wash: 7.00:1, 6.54:1, 7.08:1, against 6.30-7.60:1
  for the five already there.
- `RouteDetail.jsx` gains a fourth score bar for `Scores.quiet`, and renders
  `status_note` on `ok` routes as well as blocked ones.
- `export.js` learns the fourth score label, which is all `provenanceNote`
  needed to report it as "not measured" when it is null.
- `api/mock.js` gains real fixtures for the three, in both trip shapes.
- The gate grows from 70 checks to 85.

**status_note on an ok route had never been rendered**

The backend has always been able to emit one — `_status_note` returns
`raw.preset_note` regardless of blocked status, and `route_scenic` has set
notes like "No route near you was more scenic than the fastest one, so this is
much the same way" since it was written. `RouteDetail.jsx:220` gated on
`route.status !== 'ok'`, so none of them ever reached a screen.

That became load-bearing rather than cosmetic: the three new presets each carry
a sentence saying what their objective was inferred from, because none of the
three can be measured and a bare number under the word "Shade" invites a reader
to assume a survey. The two cases now share the slot and nothing else —
`.detail__basis-note` is neutral, because rose on that surface means "this
route is refused" everywhere else in the app.

**The card meta line stays at three scores**

`scenic · air · shade`, with `quiet` visible only in the detail panel. Not a
layout failure: `.card__meta` has no `white-space: nowrap`, so a fourth term
wraps rather than overflowing and the 320 px check still passes. But it already
wraps at three, so a fourth buys no comparison and costs every compact card a
taller meta block. The reasoning is in `CARD_SCORES`'s docstring so it does not
get silently "fixed" later.

**Deviations**

- **The new wash families are declared in `:root` only, not in both theme
  blocks.** No wash family in this stylesheet is declared twice: the
  `[data-theme='dark']` block restates the neutrals and `--route-*` and nothing
  else. Duplicating nine tokens there would have broken that pattern for no
  gain; `check_palette.sh` passes and the gate's dark-theme axe pass over the
  pressed chips confirms they render.
- **`--ink-disabled` was deleted.** Its only consumer repo-wide was the disabled
  chip, and this project does not keep dead declarations.
- `docs/DESIGN-2026.md:130` still specifies the three as "outline, disabled
  color, `· soon`". That document reproduces the approved specification verbatim
  and is not edited to match the code; a note at its head points here.

**Found in passing, both fixed**

- **A pressed chip lost its wash under the cursor.** `.chip:not(:disabled):hover`
  scored (0,3,0) against `.chip--x.is-pressed`'s (0,2,0), so on a pointer device
  hovering a selected chip replaced its accent with the neutral hover fill — and
  the wash is one of the two signals that the chip is on. Now
  `.chip:hover:not(.is-pressed)`.
- **The mock presented unmeasured data as measured.** Its unknown-objective
  fallback carried `scores: { scenic: 0, air: 0, shade: 0 }` and
  `rest_stops: []`. Zero is a measurement in this app and `[]` means "we looked
  and found none"; both are now null. The mock also had no `rest_stops: null`
  fixture at all, so the "were not checked for this route" sentence had never
  rendered in the demo.

**Components can be tested here after all.** `renderToStaticMarkup` from
`react-dom/server` works in the existing bare-Node vitest environment with no
new dependency, so the chips are rendered and asserted rather than grepped —
the new test fails against the old component. Several comments in this repo say
nothing renders a component; that is now out of date.

**Live API calls:** none. Verified against `VITE_MOCK_API=1` throughout.
