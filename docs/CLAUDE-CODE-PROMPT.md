# Prompt for Claude Code

Save `DESIGN-HANDOFF.md` into the repo (suggested: `docs/DESIGN-HANDOFF.md`) before running this.
Then paste everything below the line into Claude Code from the repo root.

---

Read `docs/DESIGN-HANDOFF.md` in full before writing any code. It is the specification for this
work; where it disagrees with your instincts, it wins. Also read `README.md`, `PROGRESS.md` and
`BLOCKED.md` first — this project has strong, deliberate constraints and I do not want them
re-litigated.

## What we're doing

A full visual and structural redesign of `frontend/`, moving to a dark-green design system, plus
four new features. The current UI is honest and accessible but cluttered: three route cards each
stack eight paragraphs of similarly-weighted grey text, and nine form fields sit on screen before
you get an answer. The redesign fixes hierarchy, not correctness.

## Rules that override everything else

These are load-bearing. Violating one is a defect, not a style disagreement.

1. **A missing OSM tag renders as `UNKNOWN`, never as "accessible".** No visual treatment may imply
   a step-free claim the data does not support.
2. **Colour is never the only differentiator.** Every route keeps a colour *and* a dash pattern
   *and* a text label. It must survive greyscale.
3. **The confidence sentence stays visible** — never a tooltip, never behind a disclosure, never
   truncated. `confidenceSentence()` in `lib/format.js` remains the source of truth; the new
   4-segment meter is a summary that sits *alongside* it, not a replacement.
4. **The route list is a complete text substitute for the map.** The app must be fully usable with
   the map element removed from the DOM. Test this.
5. **Nothing is stored server-side, and this scope sends nothing new to the server.** The only
   new client-side state is the theme preference in `localStorage`. In follow mode the live
   position never leaves the browser — every calculation runs against geometry already downloaded.
6. **No new runtime third-party requests.** Fonts stay local-stack. No CDN, no analytics.
7. **All interactive targets ≥ 44 × 44 px.**
8. **Do not touch the fetch model.** The single `nonce`-keyed effect in `App.jsx`, the per-trigger
   `DEBOUNCE` map, the abort-on-refetch, and the "keep the previous answer on screen while
   refetching" behaviour are all deliberate. Extend the reducer; do not restructure it.
9. **Keep the existing combobox in `PlaceInput.jsx` as-is.** The `aria-activedescendant` listbox is
   correct. Restyle it, do not rewrite it.
10. The 367 backend tests must stay green.

## Build order

Work in phases. **Commit at the end of each phase and stop for my review before starting the next.**
Do not do all eight in one pass. Phases 1–5 are the redesign; 6–8 are the new features.
Phase 8 depends on phase 7 — follow mode consumes the step data.

### Phase 1 — Design system
Replace the token block in `frontend/src/styles.css` with §2 of the handoff. Add the
`[data-theme="dark"]` block and a theme toggle in the topbar that persists to
`localStorage['meander:theme']` and defaults to `prefers-color-scheme`. Update the colours in
`lib/dash.js` — **dash arrays and `swatchBackground()` are unchanged**. No hard-coded hex may
survive outside the `:root` blocks; grep for `#` in the CSS to confirm.

### Phase 2 — Layout shell
Build the two-column grid from §3: panel (`minmax(360px,420px)`) + stage (`minmax(0,1fr)`).
The `minmax(0,1fr)` matters — a plain `1fr` takes min-content sizing from the map SVG and produces a
12 px horizontal overflow on mobile. Move the header prose into the topbar, collapse the footer into
the `<details>` from §4.9 keeping every existing sentence, and add the demo-data ribbon (§4.2).

### Phase 3 — Trip bar
Replace `Controls.jsx` with `TripBar.jsx` + `TripDrawer.jsx` per §4.3. Four segments — From, To,
Time & travel, Compare — each showing its current value and opening one inline drawer at a time.
Keep the native range input and its `aria-valuetext`; add the four preset pills. Verify the debounce
behaviour is byte-for-byte what it was.

### Phase 4 — Rail and detail *(the core change)*
This is the one that removes the clutter. Replace `RouteList.jsx` / `RouteCard.jsx` with
`RouteRail.jsx` + `RouteRow.jsx` + `RouteDetail.jsx` per §4.6–4.8.

Uniform-height comparison rows for all routes; full detail for the selected route only. Each row is
a single `<button>` containing only phrasing content — do not nest `<p>`, `<dl>` or `<ul>` inside
it; that is invalid HTML and screen readers flatten it into one unreadable label. The existing
`RouteCard` documents this constraint; honour it.

Add `verificationTier()` to `lib/format.js` for the 4-segment meter (thresholds in §4.7). A `null`
score and a `0` score must render differently — hatched track plus "not measured" versus a real
empty bar. They are different statements.

### Phase 5 — Map
Theme-aware paint properties, a `--raised` casing under the selected line, rest-stop circles,
barrier markers, the bottom-left legend, and 44 px map controls placed **last in the tab order**.
Preserve the single-instance lifecycle, the `jump`-when-hidden guard, and the collapsed-canvas fix —
those were real bug fixes, not accidents.

### Phase 6 — When to go: best departure + daylight window
Build both together; they share the departure strip.

1. **Best departure window** (§6.2) — `payload.best_departure` already exists in the API response
   and the UI ignores it, as it does the Open-Meteo weather and air-quality data. Add the strip and
   the 6-hour chip row, wired to the existing `departAt` field in `buildRouteRequest`. If the data
   is absent the strip does not render at all — never show a placeholder time.
2. **Daylight window** (§6.3) — **sunrise and sunset, both ends of the day.** A 6 a.m. walker needs
   the sunrise boundary as much as an evening walker needs sunset. Compute client-side in
   `lib/sun.js` (NOAA solar position, ~40 lines, no new network call), including civil dawn and
   civil dusk. Show "Daylight today: 05:58 – 18:24" in the strip; warn in the detail panel when a
   route finishes after sunset **or starts before sunrise**; offer `Shorten to finish before
   sunset` / `Start at sunrise instead`.

   Three things here will bite if you skip them:
   - **Polar day and polar night are real.** Above the Arctic circle there are dates with no
     sunrise or no sunset. Render "The sun does not set here today." Never fabricate a time, never
     fall back to a default.
   - **A failed calculation renders nothing**, not a warning and not a guess.
   - Out-of-daylight hour chips need a **moon glyph as well as** the darker tint — tint alone makes
     daylight a colour-only signal, which rule 2 forbids.

### Phase 7 — Turn-by-turn step list
**Feature 1, §6.4.** This is also the data layer for phase 8, so it comes first.

Backend, `routing.py` only: pass the GraphHopper instruction array through to the route payload.
Nothing else in `backend/` changes.

Frontend: `StepList.jsx`, a `<details>` in the detail panel. Instructions written as **sentences**
in the narration's voice — "Turn left onto Green Path and follow it for 400 m", never
`TURN_LEFT · 400m`. A barrier that falls on a step renders **inside that step** as a `.note--warn`;
that placement is the whole point, since it puts the barrier where the user would actually meet it.
Hovering or focusing a step highlights that segment on the map.

If the router returns no instructions, render *"Step-by-step directions are not available for this
route."* Never synthesise them.

### Phase 8 — Live follow mode
**Feature 4, §6.7.** The largest item. It consumes phase 7's instruction array — do not start it
until phase 7 is merged.

Read §6.7 in full; the short version:

- **The live position is never transmitted.** Every calculation happens in the browser against
  geometry already downloaded. Say so in the UI when follow mode starts, not just in a privacy
  page. If you find yourself adding a request that carries a coordinate, stop and ask me.
- Bottom sheet showing current step, distance to next turn, next rest stop, and progress.
- **Barrier proximity warning at 200 m**, `role="alert"` plus one vibration — and it fires even for
  barriers on a route the user chose to follow anyway. That warning is the app's reason to exist.
- Off-route: >40 m for >15 *continuous* seconds. Use the sustained threshold, not a single reading,
  or city GPS noise will fire it constantly.
- Wake lock in a try/catch — unsupported on several browsers, must never throw.
- **Exit is one tap, always visible, first in the tab order** within follow mode.
- Announce the current step through the **existing** polite live region. Do not add a second one.
- Degrade properly: permission denied → drop back to the detail panel with the step list open.
  A blocked route cannot be started at all. Follow mode must never be the only way to read a route.

### Not in scope
§6.1 streaming choreography, §6.5 accessibility profile, §6.6 barrier detail popover and §6.8
saved places are **specified in the handoff but deferred**. Do not build them without asking me
first. They are written up so the in-scope work doesn't design them out.

What this scope means in practice: `models.py` and `accessibility.py` are untouched, the only
backend change is the instruction array in `routing.py`, the only new client storage is the theme
preference, and **nothing new is sent to the server** — including, especially, the live position.

## Before you call any phase done

- `npx axe-core` (or the existing a11y test) at light desktop, dark desktop, and 390 px mobile —
  **0 violations**, matching the current build's standard.
- Full keyboard pass in the §9 focus order, visible focus ring throughout.
- No horizontal overflow at 320 / 390 / 768 / 1024 / 1440 / 1920.
- Delete the map element in devtools — the app is still fully usable.
- Greyscale the screenshot — all three routes still distinguishable.
- Backend tests green.

## How to work

- Ask me before changing anything in `backend/` beyond the instruction array phase 7 requires.
  `models.py` and `accessibility.py` should not change at all.
- If a spec detail is missing, **ask rather than invent** — especially anything touching
  accessibility claims or the privacy promise.
- Keep the existing commenting style in the components. Those comments explain *why*, and several
  of them record real bugs that were fixed; do not strip them.
- Commit per phase with the repo's existing message style (`feat(rail): …`, `fix(map): …`).
- Update `PROGRESS.md` as you go, in the voice it is already written in.
