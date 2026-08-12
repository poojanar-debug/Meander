# Meander — design handoff

**Version** 1.0 · 2026-08-06
**Scope** Full frontend redesign of `frontend/` + four new features — best departure window,
daylight window (sunrise and sunset), turn-by-turn steps, live follow mode. Four more features are
specified but deferred.
**Reference implementation** `meander-redesign-mockup.html` — an interactive, self-contained
mockup of every screen and state described here. Where this document and the mockup disagree,
**this document wins**; the mockup is a static approximation with hard-coded data.
**Stack** Vite + React 18, plain CSS custom properties (no CSS framework), MapLibre GL.

---

## 0. Non-negotiables carried over from the existing build

These are not design preferences. Breaking any of them is a defect.

1. **A missing OpenStreetMap tag renders as `UNKNOWN`, never as "accessible".** No visual
   treatment may imply a step-free claim that the data does not support.
2. **Colour is never the only differentiator.** Every route carries a colour *and* a dash pattern
   *and* a text label. The design must survive greyscale.
3. **The confidence sentence is always visible** — never a tooltip, never behind a disclosure,
   never truncated.
4. **The card list is a complete text substitute for the map.** The app must be fully usable with
   the map hidden or failed.
5. **Nothing is stored server-side.** Any new local persistence is opt-in, `localStorage`-only,
   visibly labelled, and wipeable in one click.
6. **No third-party font or asset requests at runtime.** Fonts are local-stack only.
7. **All interactive targets ≥ 44 × 44 px.**
8. **Existing 367 backend tests and the WCAG 2.1 AA automated pass must both still be green.**

---

## 1. Overview

### What changed and why

The current build is honest and accessible but visually undifferentiated: three route cards each
render eight stacked paragraphs of similarly-weighted small grey text, and the control panel puts
nine decisions on screen simultaneously. The result reads as a data dump rather than an answer.

The redesign does three structural things:

| Problem | Fix |
|---|---|
| Every route shows every detail at once → nothing compares | **Comparison rail** (uniform rows, aligned metrics) + **detail panel** for the selected route only |
| Nine stacked form fields before an answer | **Trip bar** — four labelled segments with inline drawers |
| Trust information reads as grey noise | **Verification meter** — 4 segments + plain-English word, always visible |
| Two walls of prose bracket the app | Header prose → topbar; footer prose → one `<details>` disclosure |
| No dark mode for an outdoors app | Full dark theme, brand-led |
| Blue = both "Fastest route" and "Clean air score" | Route colours are identity-only; score meters use one neutral accent |

### User context

Someone with a fixed amount of time and possibly a mobility constraint, often on a phone, often
about to walk out of a door. The primary job is **decide between three routes in under ten
seconds**, then **take one with you**.

---

## 2. Design tokens

Declared once on `:root`, overridden under `[data-theme="dark"]`. Replace the entire
`:root` block in `frontend/src/styles.css`.

### 2.1 Colour — light (default)

| Token | Value | Usage | Contrast |
|---|---|---|---|
| `--paper` | `#F6F3EC` | Page background, panel background | — |
| `--raised` | `#FFFEFA` | Cards, topbar, trip bar, popovers | — |
| `--sunken` | `#EDE9DF` | Map backdrop, meter tracks, hover fills | — |
| `--rule` | `#DCD5C6` | Hairline borders | — |
| `--rule-strong` | `#C4BCA8` | Input borders, button borders | — |
| `--ink` | `#16241C` | Primary text | 14.54 : 1 on paper |
| `--ink-2` | `#55645A` | Secondary text, labels | 5.65 : 1 on paper |
| `--brand` | `#1C4633` | Wordmark, primary button fill, map pins | 9.60 : 1 |
| `--brand-hover` | `#122E21` | Primary button hover | — |
| `--brand-on` | `#F6F3EC` | Text on `--brand` | 9.60 : 1 on brand |
| `--brand-tint` | `#E4EDE5` | Selected chip fill, "recommended" badge | — |
| `--accent` | `#2F7D53` | Focus ring, meter fills, selection ring | 4.53 : 1 |
| `--ok-ink` | `#1C5E3C` | Verification meter (good) | — |
| `--warn-ink` | `#8A2C14` | Warnings, barriers, low verification | 7.73 : 1 |
| `--warn-ground` | `#F7E9E1` | Warning block background | — |
| `--warn-rule` | `#D3A184` | Warning block border | — |

### 2.2 Colour — dark (`[data-theme="dark"]`)

| Token | Value | Contrast |
|---|---|---|
| `--paper` | `#0C1611` | — |
| `--raised` | `#132019` | — |
| `--sunken` | `#080F0B` | — |
| `--rule` | `#26362C` | — |
| `--rule-strong` | `#3A4E42` | — |
| `--ink` | `#E8EFE8` | 15.76 : 1 |
| `--ink-2` | `#9BAEA1` | 7.87 : 1 |
| `--brand` | `#7FC79B` | 9.26 : 1 |
| `--brand-hover` | `#9AD6B0` | — |
| `--brand-on` | `#0A1710` | 9.26 : 1 on brand |
| `--brand-tint` | `#17281E` | — |
| `--accent` | `#8FD3A9` | 10.59 : 1 |
| `--ok-ink` | `#8FD3A9` | — |
| `--warn-ink` | `#F5B49B` | 10.44 : 1 |
| `--warn-ground` | `#2A1811` | — |
| `--warn-rule` | `#6B3A24` | — |

### 2.3 Route identity

These replace the colours in `frontend/src/lib/dash.js`. **Dash arrays are unchanged** — the
existing patterns already work. Route colours are used as **graphics only** (map lines, 4 px card
edge, swatches, legend) and **never as text on paper**, because `--route-fastest` at 3.34 : 1 clears
the 3 : 1 graphical-object threshold but not the 4.5 : 1 text threshold.

| id | light | dark | dash | pattern name |
|---|---|---|---|---|
| `fastest` | `#C2703D` | `#E8A46F` | `[1,0]` | solid |
| `scenic` | `#2F7D53` | `#6FC38E` | `[3,2]` | dashed |
| `accessible` | `#5B6ECF` | `#95A4F0` | `[1,2]` | dotted |
| `quiet` | `#8A5CB4` | `#C2A0E8` | `[6,3]` | long dash |
| `shade` | `#1E7A78` | `#63C4BE` | `[5,2,1,2]` | dash-dot |
| `air` | `#B0455F` | `#EE8AA0` | `[2,2]` | fine dash |

All six clear 3 : 1 against `--paper` and `--raised` in both themes.

**Score meters use `--accent` only.** Scenic / Clean air / Shade are distinguished by their labels,
not by hue. This removes the current collision where blue means both "the Fastest route" and "the
clean-air score".

### 2.4 Map palette

| Token | light | dark |
|---|---|---|
| `--map-land` | `#E9E5D8` | `#16221B` |
| `--map-park` | `#CFE0C9` | `#1D3527` |
| `--map-water` | `#C6DAE4` | `#152A33` |
| `--map-road` | `#FBFAF6` | `#24332B` |

Apply to the MapLibre style via `setPaintProperty` on load and on theme change, or ship two style
JSONs. The selected route line always gets a **`--raised` casing at line-width + 6 px** underneath
it so it stays legible over parks and water.

### 2.5 Typography

Unchanged pairing — this is the "same style" requirement.

| Token | Value | Usage |
|---|---|---|
| `--font-display` | `'Newsreader', 'Iowan Old Style', 'Palatino Linotype', Palatino, Georgia, serif` | Wordmark, headings, route names, durations, narration |
| `--font-body` | `'IBM Plex Sans', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, system-ui, sans-serif` | Everything else |
| `--t-display` | `2rem` / lh `1.1` | First-run headline |
| `--t-h2` | `1.375rem` | "Three ways back", detail title |
| `--t-h3` | `1.0625rem` | Route name in a rail row |
| `--t-metric` | `1.75rem` | Route duration |
| `--t-body` | `0.9375rem` / lh `1.55` | Body |
| `--t-small` | `0.8125rem` | Labels, hints, sub-rows |
| `--t-micro` | `0.75rem` | Segment keys, section headings, verification line |

Narration renders in `--font-display` at `1.0625rem` / lh `1.55`. It is the one piece of prose in
the app that a human wrote for a human; give it the serif and the breathing room.

All numerals in metrics, percentages and distances take `font-variant-numeric: tabular-nums`.

### 2.6 Space, shape, elevation

| Token | Value |
|---|---|
| `--s1 … --s10` | `4, 8, 12, 16, 20, 24, 32, 40` px (4 px base) |
| `--r-sm / --r-md / --r-lg / --r-pill` | `8 / 12 / 16 / 999` px |
| `--target` | `44px` — minimum interactive dimension |
| `--shadow-1` | light: `0 1px 2px rgb(22 36 28/6%), 0 2px 8px rgb(22 36 28/6%)` · dark: `0 1px 2px rgb(0 0 0/40%)` |
| `--shadow-2` | light: `0 2px 4px rgb(22 36 28/8%), 0 8px 24px rgb(22 36 28/10%)` · dark: `0 8px 28px rgb(0 0 0/50%)` |

---

## 3. Layout

```
┌────────────────────────────────────────────────────────────────┐
│ TOPBAR  56px                    [theme] [profile] [about]      │  sticky
├────────────────────────────────────────────────────────────────┤
│ RIBBON  (only when running on fixtures)                        │
├───────────────────────────────┬────────────────────────────────┤
│ PANEL   minmax(360px, 420px)  │  STAGE   minmax(0, 1fr)        │
│ ─ trip bar        (sticky)    │                                │
│ ─ departure strip             │        MAP  (fills)            │
│ ─ results head                │                                │
│ ─ comparison rail             │   ┌ map controls (top right)   │
│ ─ detail panel                │   └ legend       (bottom left) │
│ ─ about disclosure  (bottom)  │                                │
└───────────────────────────────┴────────────────────────────────┘
```

- `.layout { display:grid; grid-template-columns: minmax(360px,420px) minmax(0,1fr); }`
  The `minmax(0,1fr)` is **required** — a plain `1fr` takes min-content sizing from the map SVG and
  causes a 12 px horizontal overflow.
- `.panel { overflow-y:auto; min-width:0; min-height:0; }` — the panel scrolls, the map does not.
- The map is **never** unmounted between requests. Exactly one MapLibre instance for the app
  lifetime (this is already true in the current build; preserve it).

### Responsive

| Breakpoint | Behaviour |
|---|---|
| ≥ 1280px | Panel at its 420 px max. Legend visible. |
| 900 – 1279px | Panel shrinks toward 360 px. Legend visible. |
| < 900px | Single column. **Map moves to the top** (`order:-1`) at `36vh`, min 230 px. Panel scrolls beneath it in normal document flow. Legend hidden (the rail is the legend). Wordmark tagline hidden. Ribbon drops to `--t-micro`. Map controls move to `--s2` inset. |
| < 380px | Trip bar segments stack to one column. |

**Why the map goes on top on mobile:** the trip bar and the top route row must be reachable by
thumb. Putting a 36vh map above them keeps the answer visible while leaving the controls in the
lower two-thirds of the screen.

---

## 4. Components

### 4.1 `Topbar`

| Element | Spec |
|---|---|
| Height | `min-height: var(--topbar-h)` = `calc(56px + var(--safe-top))`, `--raised`, 1 px `--rule` bottom border, `position:sticky; top:0; z-index:40`. **Not `height`** — under the global `border-box`, a fixed height plus the safe-area `padding-top` eats the inset out of the content box and clips the 44px icon button, which is a 44x44 failure introduced by the fix that was meant to be safe. Pinned by `styles.safe-area.test.js`. |
| Wordmark | `--font-display` 1.375rem, `--brand`, **and a button**: the mark and the word together are the reset control, labelled ", start a new walk" for assistive technology. A button and not a link, because the action clears state rather than navigating — and because `gate.mjs` exempts an `<a>` beside sibling text from the 44x44 sweep, so a link here would go unmeasured. The mark is inline SVG in `currentColor` (10.55:1 light, 8.45:1 dark against `--raised`), hidden below 380px; the five generated PNGs cannot be reused, their `--brand` ground being 1.58:1 against the dark bar. Tagline "routes that are worth the walk" in `--font-body` 0.75rem `--ink-2`, hidden < 900px |
| Theme toggle | Pill button, 36 px min-height, label is the theme you will *get* ("Dark" in light mode). Persist to `localStorage['meander:theme']`; default to `prefers-color-scheme` |
| Profile button | Icon button 44 × 44. Opens the accessibility-profile sheet (§6.5). Shows a small `--accent` dot when a profile is active. **Not built**, and deliberately: §6.5 is deferred, and a control that opens nothing reads as broken rather than as unbuilt. When §6.5 is promoted it belongs between the theme toggle and About. |
| About | Icon button 44 × 44, scrolls the panel to the `<details>` and opens it |

### 4.2 `Ribbon` — demo-data warning

Renders **only** when any route in the current result has `synthetic_upstream === true`, or when
`usingMockApi()`. Full-width, `--warn-ground` / `--warn-ink`, 1 px `--warn-rule` bottom border,
`--t-small` weight 600, warning-triangle icon.

Copy: *"Demonstration data — routes come from fixtures, not live routing. Do not follow them."*

Not dismissible. This replaces the current per-card `card__synthetic` paragraph; keep the per-card
line **as well** when only some routes are synthetic.

### 4.3 `TripBar`

Sticky at the top of the panel, `z-index:20`. Four `.seg` buttons in a `1fr 1fr` grid, `--s2` gap.

Each segment is a `<button aria-expanded>` containing:

| Part | Spec |
|---|---|
| `.seg__dot` | 22 × 22 icon, `--brand` |
| `.seg__k` | Key. `--t-micro`, uppercase, letter-spacing `.04em`, `--ink-2` |
| `.seg__v` | Current value. `--t-body` weight 600, `white-space:nowrap; overflow:hidden; text-overflow:ellipsis`. Placeholder values (e.g. "Round trip") use weight 400 + `--ink-2` |

`.seg__text` needs `min-width:0; overflow:hidden` or long place names break the grid.

| Segment | Key | Value example | Drawer contents |
|---|---|---|---|
| 1 | FROM | `Viharamahadevi Park` | `PlaceInput` (unchanged combobox) + "Use my location" + saved places (§6.8) |
| 2 | TO | `Round trip` | `PlaceInput` + hint "Empty means a round trip — Meander brings you back to where you started." |
| 3 | TIME & TRAVEL | `35 min · walk` | Time dial + presets + mode `<select>` |
| 4 | COMPARE | `3 types` | The six objective chips |

**Drawer behaviour.** One open at a time. Opening one closes the others. Rendered inline *below*
the segment grid (not as an overlay) so the layout never jumps over the map. `hidden` attribute
toggled; `aria-expanded` on the segment; `aria-controls` pointing at the drawer id.

Segment open state: border `--accent`, `box-shadow: 0 0 0 1px var(--accent)`.

**Do not change the debounce or the auto-refetch model.** The existing `DEBOUNCE` map
(`minutes:400, mode:120, objectives:120, place:0, retry:0`) and the single `nonce`-keyed effect
stay exactly as they are. Closing a drawer does not trigger a fetch; changing a value inside it does.

### 4.4 `TimeDial`

Stays a native `<input type="range">` with `aria-valuetext`. This is correct and must not become a
custom radial control.

Additions:

- Readout above the slider: `--font-display` 2.25rem tabular number + "minutes · walking" in `--ink-2`.
- Preset pills below: **20 min / 35 min / 1 hr / 2 hr**, `aria-pressed`, 36 px min-height. A preset
  sets the slider value and fires the same `minutes` action.
- Tick labels 20 min / 2 hr / 6 hr, `aria-hidden`.

### 4.5 `ObjectiveChips`

Pill buttons, 44 px min-height, `aria-pressed`. Selected: `--brand-tint` fill, `--accent` border,
`inset 0 0 0 1px var(--accent)`, weight 600, plus a **check glyph** that only appears when pressed —
so selection is conveyed by fill, border, weight *and* an icon, never by colour alone.

Each chip carries a 22 × 4 px swatch reproducing the route's dash pattern via
`swatchBackground()` (keep the existing helper unchanged).

Hint below: *"Up to three at a time. Each one gets its own colour and line pattern on the map."*

Keep the existing reducer rule: never allow zero selected; a fourth drops the first.

### 4.6 `RouteRail` and `RouteRow` — **the core change**

Replaces `RouteList` + `RouteCard`. A `<ul>` of `<li><button class="route" aria-pressed>`.

Each row is **uniform height** regardless of content. Anatomy top to bottom:

```
▌  Scenic                      [Showing]        26 min
   ▬ ▬  dashed  ·  2.1 km  ·  3 rest stops
   Green  79%   Air  71%   Shade  58%
   ▬▬▬▬▬▬▬▬     ▬▬▬▬▬▬▬     ▬▬▬▬▬
   ■■■□  Mostly verified · 72% of the route checked
```

| Part | Spec |
|---|---|
| `.route__edge` | 4 px full-height left bar. Solid for `fastest`; for patterned routes a vertical `repeating-linear-gradient` mirroring the dash array |
| `.route__name` | `--font-display` `--t-h3`, `--ink` |
| Badge | Optional. `Showing` (`--brand-tint`/`--ok-ink`/`--accent` border) when selected; `N barriers` (`--warn-ground`/`--warn-ink`/`--warn-rule`) when blocked |
| `.route__dur` | `--font-display` `--t-metric`, tabular. The unit "min" trails in `--font-body` 0.9375rem `--ink-2`. Blocked routes render the duration in `--ink-2` |
| `.route__sub` | `--t-small` `--ink-2`: 26 × 3 px pattern line + pattern word · distance · rest-stop count. Blocked routes end with "cannot be completed" |
| `.route__scores` | 3-column grid. Each: label + value on one `--t-micro` row (`justify-content:space-between`), 5 px track below. Fill is `--accent`. **Unmeasured** (`null`, not `0`) renders a 45° hatch and the label reads "not measured" |
| `.verify` | Four 12 × 6 px segments + sentence, `--t-micro`. See §4.7 |

States:

| State | Treatment |
|---|---|
| Default | `--raised`, 1 px `--rule` |
| Hover | border `--rule-strong`, `--shadow-1` |
| Focus-visible | 3 px `--accent` outline, 2 px offset |
| Selected (`aria-pressed="true"`) | border `--accent`, `box-shadow: 0 0 0 1px var(--accent), var(--shadow-1)`, `Showing` badge |
| Blocked | `N barriers` badge, muted duration, "cannot be completed" in the sub-row. **Still selectable** — the user must be able to see where it fails |
| Loading (streaming) | Skeleton row of the same height, `--sunken` blocks, no shimmer if `prefers-reduced-motion` |

**Ordering.** Preserve the existing rule: routes sort by the order of `state.objectives`, and the
initially selected route is the first with `status === 'ok'`. Blocked routes are never hidden.

The whole row is one `<button>` containing only phrasing content (`<span>`). Do **not** nest `<p>`,
`<dl>` or `<ul>` inside it — that is invalid HTML and screen readers flatten it into one unreadable
label. This is the same constraint the current `RouteCard` documents; honour it.

### 4.7 `VerificationMeter`

Four segments, filled proportionally, plus a sentence. Derived from `route.confidence` and
`route.scoring_method`.

| Condition | Filled | Word | Colour |
|---|---|---|---|
| `scoring_method === 'placeholder'` | 0 | **Not measured** | `--warn-ink` |
| `confidence < 0.30` | 1 | **Barely verified** | `--warn-ink` |
| `0.30 ≤ c < 0.60` | 2 | **Partly verified** | `--warn-ink` |
| `0.60 ≤ c < 0.80` | 3 | **Mostly verified** | `--ok-ink` |
| `c ≥ 0.80` | 4 | **Well verified** | `--ok-ink` |

Rail sentence: `{Word} · {pct}% of the route checked`. Warning tiers render weight 600 in
`--warn-ink` and get an `⚠` glyph — colour is not the only signal.

**In the detail panel the full server sentence still renders verbatim** in a `.note` block. The
existing `confidenceSentence()` helper is the source of truth and must not be replaced by the
meter — the meter is a *summary*, the sentence is the *statement*. Where the backend supplies
`confidence_note`, that text wins.

### 4.8 `RouteDetail`

Renders for the selected route only, below the rail. `--raised`, `--r-lg`, `--s5` padding,
`--shadow-1`, `--s4` gap between sections.

Order:

1. **Head** — pattern line + route name (`--t-h2`) + `duration · distance` right-aligned in `--ink-2`.
2. **Narration** — `--font-display` 1.0625rem. While pending: *"Description still being written…"*
   in `--ink-2` italic. Narration arrives in a second stream pass; merge by `id` as today.
3. **Blocked notice** — if `status !== 'ok'`: a `.note--warn` block with `role="alert"`, the
   `status_note`, and the barrier list (`<strong>{type}:</strong> {description}`). Placed **above**
   Along the way, because it changes whether the rest matters.
4. **Along the way** — rest stops as pill chips: icon + readable name + distance
   (`Bench · 340 m`). Reuse `restStopName()`. If none: *"No rest stops found along this route."*
5. **What this route scores** — full-width meters, `5.5rem 1fr 2.5rem` grid. Unmeasured rows show
   "not measured" in italic `--ink-2`, never an empty bar.
6. **Verification note** — `.note` with the server's confidence sentence in bold, then the scoring
   method (`SCORING_METHOD_LABEL`) as supporting text. `.note--warn` when severity is warning.
7. **Actions** — `Start this route` (primary) · `Share` · `Save`.

### 4.9 `About` disclosure

A `<details>` pinned to the bottom of the panel (`margin-top:auto`), replacing the entire current
footer. Summary: *"Where these numbers come from · privacy · credits"*, 44 px min-height.

Body keeps **all** existing footer copy, in this order: the OSM-tagging caveat, the
nothing-is-stored statement, then cache stats and attributions. Nothing is deleted — it is
collapsed.

### 4.10 `MapView`

Preserve the existing single-instance lifecycle, the hidden-tab `jump` instead of `fly`, and the
collapsed-canvas guard. Additions:

- **Selected route emphasis**: casing (`--raised`, width + 6) under a 7 px coloured dashed line.
  Unselected routes render at 5 px, `opacity 0.45`.
- **Rest stops**: 9 px circles, `--raised` fill, 3 px route-coloured stroke, on the selected route only.
- **Barrier markers**: 14 px `--warn-ink` circle, 3 px `--raised` stroke, white ✕. Clickable → §6.6.
- **Legend**: bottom-left card, `--raised`, `--r-md`, `--shadow-1`. One row per drawn route: 28 × 3 px
  pattern line + name + pattern word. Selected route in bold. Hidden < 900px.
- **Controls**: top-right column of 44 × 44 buttons — zoom in, zoom out, recentre. Each needs an
  `aria-label`; they are not in the tab order before the route rail (see §9).
- Container has `role="img"` and an `aria-label` summarising what is drawn and which route is selected.

---

## 5. States and interactions

| Element | State | Behaviour |
|---|---|---|
| `.seg` | hover | `--rule-strong` border, `--sunken` fill |
| `.seg` | expanded | `--accent` border + 1 px ring; drawer visible; `aria-expanded="true"` |
| `.route` | hover | `--rule-strong` border, `--shadow-1` |
| `.route` | selected | `--accent` border + ring, `Showing` badge, map emphasises the line, `aria-pressed="true"` |
| `.route` | streaming in | Skeleton → content; row slides up 8 px and fades in over 240 ms |
| `.chip` / `.preset` | pressed | `--brand-tint`, `--accent` border, weight 600, check glyph |
| `.btn--primary` | hover | `--brand-hover` fill and border |
| Any focusable | focus-visible | 3 px `--accent` outline, 2 px offset, 4 px radius |
| Refetch in flight | — | **Previous routes and map stay rendered and interactive.** Only the progress affordance changes. This is existing behaviour and is deliberate — do not replace a good answer with a spinner |

### Global loading / error / empty

| Phase | Treatment |
|---|---|
| `idle` (no origin) | Full-panel first-run card (§7) |
| `locating` | Trip bar segment 1 value → "Finding you…", button disabled |
| `loading`, no prior routes | 3 skeleton rows + a 2 px `--accent` progress bar under the trip bar, `role="progressbar"` with `aria-valuenow` |
| `loading`, prior routes exist | Progress bar only; rail stays live |
| `error` | `.note--warn` `role="alert"` above the rail with the message and a `Try again` button |
| All routes blocked | `.note--warn` `role="alert"`: *"None of these routes can be completed…"* + `Add 30 minutes` button (existing copy and behaviour) |
| Geolocation denied | Hint under the From drawer: *"Your browser did not share your location. Search for a starting point instead."* |

---

## 6. New features

**Four are in scope**, chosen by the product owner. Build in this order — it is a dependency
chain, not a preference:

| Order | Feature | Section | Effort | Depends on |
|---|---|---|---|---|
| 1 | Best departure window | §6.2 | M | — |
| 2 | Daylight window — sunrise **and** sunset | §6.3 | S | §6.2 (shares the strip) |
| 3 | Turn-by-turn step list | §6.4 | M | — |
| 4 | Live follow mode | §6.7 | L | **§6.4** |

The theme is **when to go, and what happens once you're walking.** §6.2 and §6.3 both answer
"when"; they share the departure strip, so build them together. §6.4 produces the step data that
§6.7 consumes — follow mode's sheet shows the current step, so the step list is a hard
prerequisite, not a nice-to-have.

Backend work is confined to `routing.py`: pass the GraphHopper instruction array through to the
route payload (§6.4). `models.py` and `accessibility.py` are untouched. The only new client-side
storage is the theme preference. **The live position in follow mode is never transmitted.**

**Four more are specified below but deferred** — §6.1 streaming choreography, §6.5 accessibility
profile, §6.6 barrier detail, §6.8 saved places. Do not build them without asking. They are
written up because the specs are cheap to keep and these are the most likely next additions;
leaving them here also means the in-scope work doesn't accidentally design them out.

> §6.1 streaming choreography is the cheapest thing on the deferred list and touches nothing else.
> If you want the app to feel alive while it works, it is a one-line promotion.

### 6.1 Streaming choreography *(feature 23)* — *deferred; cheapest item on the deferred list*

The backend already streams routes one at a time over SSE; the UI currently just pops them in.

- Before the first route lands, render **N skeleton rows** where N = `objectives.length`.
- Each arriving route replaces its skeleton: `translateY(8px) → 0`, `opacity 0 → 1`, **240 ms**,
  `cubic-bezier(.2,.7,.3,1)`.
- The map draws each line progressively over **600 ms** by animating `line-dasharray` from
  `[0, len]` to the route's real pattern. Reuse the existing per-route dash array as the end state.
- The progress bar under the trip bar reflects `progress.pct` from the SSE `progress` events.
- **`prefers-reduced-motion: reduce` disables all of it** — routes and lines appear instantly.
- The existing polite live region announces the full result once, debounced at 350 ms. Do not add
  a second live region and do not announce per-route arrivals; that would flood a screen reader
  during a dial drag.

### 6.2 Best departure window *(feature 6)* — **IN SCOPE**

`payload.best_departure` already exists in the API response and is currently unused by the UI.

- A **departure strip** between the trip bar and the results head. `--raised`, `--r-md`.
- Headline: *"Leave at 17:40 — coolest air and lowest AQI in the next three hours."* The reason
  clause is derived from whichever factor drove the choice; if the backend does not supply one,
  render only the time and the word "best".
- Below it, a horizontal row of up to **6 hour chips**. The recommended hour is `aria-pressed`,
  `--brand-tint`, `--accent` border. Selecting another hour dispatches a `departAt` change, which
  flows into the existing `buildRouteRequest({ departAt })` (already supported).
- If `best_departure` is absent or the conditions data is missing, **the strip does not render at
  all.** Never render a placeholder time.
- New debounce entry: `departure: 200`.

### 6.3 Daylight window — sunrise and sunset *(feature 8)* — **IN SCOPE**

Both ends of the day, not just sunset. A 6 a.m. walker needs the sunrise boundary exactly as much
as a 6 p.m. walker needs the sunset one.

**Computation.** `lib/sun.js` — NOAA solar-position, roughly 40 lines, computed client-side from
the origin coordinates and the date. **No new network call.** Return sunrise, sunset, civil dawn
and civil dusk.

**Display.** One line in the departure strip: *"Daylight today: 05:58 – 18:24."*

**Guards**, rendered as a `.note--warn` in the detail panel. Only one fires — the more severe wins:

| Condition | Copy |
|---|---|
| Finishes after sunset | *"This route finishes about 25 minutes after sunset (18:24 today)."* |
| Finishes after civil dusk | *"This route finishes well after dark."* |
| Starts before sunrise | *"This route starts about 20 minutes before sunrise (05:58 today) — the first stretch will be in the dark."* |
| Starts before civil dawn | *"This route starts well before first light."* |

**Actions.** At most one, matched to the guard: `Shorten to finish before sunset` sets `minutes` to
the largest 5-minute step that fits; `Start at sunrise instead` sets `departAt` to sunrise.

**In the departure strip**, hour chips outside the daylight window get a darker tint **and a moon
glyph** — the tint alone would make daylight a colour-only signal, which §0.2 forbids.

**Edge cases that must be handled, not crashed through:**

- **Polar day / polar night.** Above the Arctic and below the Antarctic circles there are dates
  with no sunrise or no sunset at all. Render *"The sun does not set here today."* or *"The sun
  does not rise here today."* **Never** render a fabricated time, and never fall back to a default.
- **Calculation fails or coordinates are missing** → render nothing at all. An unknown daylight
  window is not a warning; it is silence.
- **Route crosses midnight** → compute against the correct calendar day for the *end* of the route,
  not the start.

### 6.4 Turn-by-turn step list *(feature 1)* — **IN SCOPE**

- New collapsed section in `RouteDetail`, below Along the way: `<details>` — *"Directions · 14 steps"*.
- Each step is an `<li>`: instruction sentence, then `--t-small` `--ink-2` distance and street name.
  Write instructions as sentences ("Turn left onto Green Path and follow it for 400 m"), matching
  the narration voice — not "TURN_LEFT · 400m".
- **A barrier that falls on a step renders inside that step**, as a `.note--warn` with the barrier
  type and description. This is the whole point: the user meets the barrier where they would meet it.
- Hovering or focusing a step highlights that segment on the map (add a `highlight` source layer;
  `prefers-reduced-motion` still allows this — it is not motion, it is a state change).
- Steps come from the GraphHopper instruction array. If the routing backend returns no
  instructions, render *"Step-by-step directions are not available for this route."* — never
  synthesise them.

### 6.5 Accessibility profile *(feature 11)* — *deferred*. Highest value, largest job

A sheet opened from the topbar profile button. Modal on mobile, popover on desktop; focus trapped,
`Escape` closes, focus returns to the trigger.

Fields:

| Field | Control | Maps to |
|---|---|---|
| Mobility | Radio group: None stated · Wheelchair · Walking frame / stick · Pram or buggy · Low stamina | Preset bundle of the constraints below |
| Avoid steps | Switch | Hard constraint |
| Max gradient | Slider 3–12 % | Hard constraint |
| Minimum path width | Slider 0.8–1.5 m | Hard constraint |
| Avoid unpaved surfaces | Switch | Hard constraint |
| Rest stop at least every | Slider 200–1000 m, or Off | Soft preference |

Behaviour:

- The profile applies to **every objective**, not only `accessible`. A profile that blocks steps
  must block them on the Scenic route too.
- Stored in `localStorage['meander:profile']`. The sheet carries a visible line: *"Stored on this
  device only. Never sent anywhere but the routing request itself."* plus a **Clear profile** button.
- When a profile is active: the topbar button shows an `--accent` dot, and the results head reads
  *"Three ways back · your accessibility profile is on"*.
- Send the profile in the route request body. **Backend work required** — extend the request model
  and pass the constraints into `accessibility.py`'s hard-constraint pass. Do not fake this in the
  client by filtering results.
- If the profile makes every route impossible, that is a correct answer. Show the all-blocked
  banner with an added action: `Relax my profile for this search` — which runs once without the
  profile and labels the result *"Found without your accessibility profile."*

### 6.6 Barrier detail with evidence *(feature 12)* — *deferred*

- Barrier markers on the map and barrier entries in the detail panel both open the same popover.
- Contents: barrier type as a heading; the description; **the raw OSM tag** (`kerb=raised`) in a
  monospace chip; the OSM element type and id linked to openstreetmap.org; *"Last edited 4 March
  2024"* if the backend supplies it; a Mapillary thumbnail if one exists (lazy-loaded, with
  `CC BY-SA` credit); and a plain-English confidence line for the classification.
- If a field is unavailable, **omit the row entirely**. Do not print "unknown" repeatedly, and never
  print a placeholder date.
- Requires the backend to include tag provenance in the `blockers[]` entries.

### 6.7 Live follow mode *(feature 4)* — **IN SCOPE**. Build last; requires §6.4

Entered from `Start this route` in the detail panel. The largest item in this scope.

**Privacy, first, because it is the thing most likely to get quietly broken.**
`navigator.geolocation.watchPosition` with `enableHighAccuracy: true`. **No request is ever made
carrying the live position** — every calculation (progress along the line, distance to the next
turn, off-route detection, barrier proximity) happens in the browser against geometry already
downloaded. Say this in the UI at the moment follow mode starts, not only in a privacy page.

**Layout.** The map fills the viewport. A bottom sheet, ~30vh, `--raised`, rounded top corners,
shows:

| Row | Content |
|---|---|
| 1 | The **current step**, in `--font-display` `--t-h3`, from §6.4's instruction array |
| 2 | Distance to the next turn, `--t-metric` tabular |
| 3 | Next rest stop, if any: *"Bench in 240 m"* |
| 4 | Progress: *"1.2 of 2.1 km · about 14 min left"* |

**Barrier proximity warning.** At 200 m from a known barrier: a `role="alert"` banner above the
sheet naming the barrier type and what it is, plus one `navigator.vibrate([200,100,200])` if the
API exists and the user has not disabled motion. Because this is the app's whole reason to exist,
this warning fires **even for barriers on a route the user chose to follow anyway**.

**Off-route detection.** More than 40 m from the line for more than 15 continuous seconds →
*"You've left the route."* with a `Recalculate` action. Use the sustained-time threshold, not a
single reading; GPS noise in a city will otherwise fire it constantly.

**Screen wake lock** via `navigator.wakeLock.request('screen')`, re-acquired on
`visibilitychange`, released on exit. Wrap in try/catch — it is unsupported on several browsers
and must never throw.

**Exit is always one tap and always visible** — a persistent button in the top-left of the map,
44 × 44 minimum, first in the tab order within follow mode. Exiting stops the watch, releases the
wake lock, and returns to the results view with the same route still selected.

**Degradation, all of which must be graceful:**

- Permission denied or unavailable → explain in one sentence and drop the user back to the detail
  panel with the step list open. **Follow mode must never be the only way to read a route.**
- No instructions from the router → follow mode is not offered at all; `Start this route` is
  hidden rather than broken.
- Route is `status !== 'ok'` → `Start this route` is disabled with the reason on the button's
  `aria-describedby`. Do not let someone start following a route the app has said is blocked.
- Tab backgrounded → keep the watch, skip the map camera animation (reuse the existing
  `document.hidden` → `jump` guard).

**Accessibility.** The current step is announced on change through the existing polite live region
— do **not** add a second one. Proximity and off-route warnings use `role="alert"`. The sheet is
not a modal: the map stays reachable.

### 6.8 Saved places *(feature 20)* — *deferred*

- In the From and To drawers, above the search input: a row of saved-place chips (Home, Work, plus
  any custom), each 44 px min-height with an icon.
- `Save this place` appears in the drawer once a place is picked. Saving asks for a short label
  (default: the place name), max 24 characters, truncated with an ellipsis in the chip.
- Stored in `localStorage['meander:places']` as `[{id, label, name, lat, lon}]`. Cap at 12.
- The About disclosure gains a line: *"N places saved on this device."* + `Clear saved places`.
- Never send a saved place anywhere except as coordinates in a route request, exactly as a typed
  place is sent today.

---

## 7. First-run / empty state

When `phase === 'idle'` and no origin is set, the panel and stage are replaced by one centred card
(max-width 460 px, `--raised`, `--r-lg`, `--s8`/`--s6` padding, `--shadow-2`).

Contents in order:

1. Headline, `--t-display`: **"Where are you, and how long have you got?"**
2. Lede, `--ink-2`: *"Meander works out three ways back: the fastest, the greenest, and one that
   holds to real accessibility constraints."*
3. **`Use my location`** — primary, full width, 52 px tall.
4. `or` divider.
5. `Search for a starting point` input, placeholder *"A park, a station, a street name…"*
6. `How long have you got?` — the four preset pills plus `Other` (which reveals the slider).
7. Hint: *"Leave the destination empty and you get a loop that brings you back."*
8. Privacy line with a shield icon: *"Nothing is stored. Your coordinates answer this one request
   and are then discarded."*

**Three decisions, not nine.** Destination, travel mode and objectives all take working defaults
and are only reachable from the trip bar once results exist. This is the "any user can use it"
requirement: the fastest path to a first answer is one tap and one pill.

---

## 8. Edge cases

| Case | Behaviour |
|---|---|
| Place name longer than the segment | `text-overflow: ellipsis` on `.seg__v`; full name in the drawer input and as the `title` attribute |
| Score is `null` vs `0` | `null` → hatched track + "not measured". `0` → an empty but real bar. These are different statements and must never render alike |
| Route has no geometry | Rail row still renders with all figures; sub-row reads "not drawn on the map"; no map line |
| All routes blocked | Existing banner + `Add 30 minutes`. With a profile active, also offer `Relax my profile for this search` |
| Basemap fails to load | Keep the existing hung-basemap surface. The rail and detail panel are a complete substitute; do not block the UI on the map |
| Long narration (> 400 chars) | No truncation. The detail panel scrolls with the panel |
| Zero rest stops | *"No rest stops found along this route."* — never an empty section |
| 20+ barriers | List the first 8 in the detail panel, then *"and 14 more"* as a disclosure. Every barrier still gets a map marker |
| `localStorage` unavailable (private mode) | Saved places and profile silently degrade to session-only. Never throw; never show a scary error |
| Slow connection | Skeletons hold the row height so the layout never jumps. Progress bar reflects real SSE progress, never a fake timer |
| RTL / long translations | Use logical properties (`padding-inline`, `margin-block`) throughout. `.seg__v` must tolerate ~1.4× English length |
| `prefers-reduced-motion` | All transitions → 0.001 ms. Map lines appear complete; no dash animation, no slide-in |

---

## 9. Accessibility

| Requirement | Spec |
|---|---|
| Focus order | skip link → topbar → trip bar segments (→ open drawer contents) → departure strip → rail rows → detail panel → about → map controls. **The map controls come last** — a keyboard user reaching the routes should not first traverse zoom buttons |
| Skip link | Keep `Skip to the routes` → `#results`, visible on focus |
| Live region | Exactly one, `role="status" aria-live="polite"`, debounced 350 ms. Announces the settled result summary and selection changes. Keep `announceRoutes()` / `announceSelection()` |
| Route rows | `<button aria-pressed>`; accessible name = route name + duration + distance + verification word |
| Trip bar | `aria-expanded` + `aria-controls` on each segment; drawer has an `aria-labelledby` pointing at the segment's key |
| Slider | Native `range` + `aria-valuetext="35 minutes, walking"`. Arrow / Home / End / PageUp / PageDown work for free |
| Combobox | Keep the existing `role="combobox"` + `aria-activedescendant` listbox. It is correct — do not rewrite it |
| Chips | `aria-pressed`; selection also carries a check glyph and a weight change |
| Barriers | Barrier popovers are dialogs: focus trapped, `Escape` closes, focus returns |
| Follow mode | Off-route and barrier-proximity warnings use `role="alert"`. Exit is the first focusable element |
| Contrast | Every pairing in §2 is pre-verified. Route colours are graphics-only |
| Targets | 44 × 44 minimum everywhere, including map controls and hour chips |
| Motion | Honour `prefers-reduced-motion` on every animation added in §6.1 |

**Verification gate:** run axe-core (`wcag2a, wcag2aa, wcag21a, wcag21aa`) on light desktop, dark
desktop and 390 px mobile. The mockup returns **0 violations** on all three; the implementation
must too.

---

## 10. Motion

| Element | Trigger | Animation | Duration | Easing |
|---|---|---|---|---|
| Route row | Arrives via SSE | `translateY(8px)→0`, `opacity 0→1` | 240 ms | `cubic-bezier(.2,.7,.3,1)` |
| Map line | Route arrives | `line-dasharray` `[0,len]` → pattern | 600 ms | `ease-out` |
| Drawer | Segment opened | Height auto-expand + fade | 180 ms | `ease-out` |
| Selection ring | Row selected | `box-shadow` colour | 120 ms | `ease` |
| Map camera | Selection change | `fitBounds` of the selected route, 60 px padding | 500 ms | MapLibre default — **`jump` not `fly` when `document.hidden`** (existing guard) |
| Theme switch | Toggle | No transition. Cross-fading two full palettes looks broken | — | — |

Everything above collapses to 0.001 ms under `prefers-reduced-motion: reduce`.

---

## 11. Files touched

| Path | Change |
|---|---|
| `frontend/src/styles.css` | Rewritten around the new token set. Keep `.visually-hidden`, `.skip-link` |
| `frontend/src/lib/dash.js` | New colours; **dash arrays unchanged**; `swatchBackground()` unchanged |
| `frontend/src/lib/format.js` | Add `verificationTier()`; keep `confidenceSentence()` as the source of truth |
| `frontend/src/components/Header.jsx` | → `Topbar.jsx` (+ theme toggle, profile button) |
| `frontend/src/components/Controls.jsx` | → `TripBar.jsx` + `TripDrawer.jsx` |
| `frontend/src/components/RouteList.jsx` | → `RouteRail.jsx` |
| `frontend/src/components/RouteCard.jsx` | → `RouteRow.jsx` + `RouteDetail.jsx` |
| `frontend/src/components/StatusBanner.jsx` | Slimmed — progress bar + alert blocks only |
| `frontend/src/components/MapView.jsx` | Theme-aware paint, casing, legend, rest stops, barrier markers |
| **New** | In scope: `DepartureStrip.jsx`, `VerificationMeter.jsx`, `StepList.jsx`, `FollowMode.jsx`, `lib/sun.js`. Deferred: `AccessibilityProfile.jsx`, `BarrierPopover.jsx`, `SavedPlaces.jsx`, `lib/storage.js` |
| `frontend/src/App.jsx` | New layout; reducer gains `departAt`, `theme` and `follow`. **Keep the single nonce-keyed fetch effect exactly as it is** — follow mode must not run through it |
| `backend/models.py`, `backend/accessibility.py` | **Untouched in this scope.** Only needed if §6.5 is promoted later |
| `backend/routing.py` | Return the GraphHopper turn-instruction array (§6.4). The only backend work in this scope |

---

## 12. Definition of done

- [ ] Every token in §2 declared once; **no hard-coded hex outside the `:root` blocks**
- [ ] Light and dark both ship; theme persists; defaults to `prefers-color-scheme`
- [ ] axe-core: 0 violations at light desktop, dark desktop, 390 px mobile
- [ ] Full keyboard pass: reach and operate every control, in the §9 order, with a visible focus ring
- [ ] No horizontal overflow at 320, 390, 768, 1024, 1440, 1920
- [ ] The app is fully usable with the map element removed from the DOM
- [ ] Greyscale screenshot: all three routes still distinguishable
- [ ] A `null` score and a `0` score render differently
- [ ] Existing 367 backend tests pass; new tests cover instruction pass-through and the solar maths, including polar day and polar night
- [ ] `prefers-reduced-motion` removes every animation added in §6.1
- [ ] No new runtime third-party requests
- [ ] **Nothing new is sent to the server at all** — the live position in follow mode never leaves the browser, and the UI says so
- [ ] Sunrise/sunset renders nothing rather than guessing when the calculation cannot be made
