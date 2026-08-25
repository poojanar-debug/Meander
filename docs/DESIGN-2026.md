# Meander — the 2026 UI

**Status** Implemented, 2026-08-25 — `frontend/PROGRESS.md` ("The 2026 UI") records the
implementation and its deliberate deviations, each with its reason.
**Supersedes** `DESIGN-HANDOFF.md` for everything presentational. The non-negotiables in that
document's §0 — unknown never renders as a claim, colour is never the only differentiator, the
follow-mode privacy position — carry forward unchanged and are restated below.
**Provenance** This is the approved specification as delivered, reproduced verbatim: it arrived as
text, with no attached design files, describing approved high-fidelity mockups. Where a value is
stated here it is final; the implementation may deviate only where a value collides with a harder
constraint (in practice: WCAG 4.5:1, enforced by the a11y gate), and every such deviation is
logged in `frontend/PROGRESS.md`.

---

## Product context

Meander plans routes from a **time budget, not a destination**: origin + minutes in → up to three
routes out (fastest / scenic / accessible); no destination means a round trip. Two invariants shape
all UI: absence of data is never rendered as a finding (`null ≠ 0`, unknown renders as `—`,
`UNKNOWN ≠ PASS`), and accessibility claims are never fabricated. Server sentences
(`confidence_note`, `status_note`, blocker descriptions) render **verbatim**.

## Visual direction

Minimal, Apple-app feel. Clean pastels on warm neutrals. **Everything centered** (content blocks
centered; reading lists left-aligned inside centered blocks). No gradients, no emojis, no icon
fonts, no system/default fonts, no pure white or black.

### Type

- UI face: **Hanken Grotesk** 400/500/600/700/800. All labels, titles, body.
- Data face: **Space Mono** 400/700. Every numeral and machine-ish string: durations, distances,
  scores, meta captions, uppercase micro-labels.
- Self-host both (shell is precached by the service worker; no cross-origin font fetch at runtime).
- Scale (px/weight/tracking): sheet-modal titles 19–24/800/−0.2..−0.4 · card titles 15/700 · body
  12.5–15 · dock headline 17/800 · plan-time numeral mono 38/700 · nav distance mono 27/700 · stat
  lines mono 11–14 · footnotes mono 9–10.5 · micro-labels mono 10 uppercase tracking 1.8.
  Interactive targets ≥44×44.

### Color tokens (oklch; approx hex fallback)

Neutrals: ink `#232320` · secondary `#77756C` · tertiary `#A6A49B` · disabled `#B4B2A8` · surface
`#FDFCFA` · canvas `#ECEAE4` · on-dark `#F5F4EF` · hairlines `rgba(35,35,32,.08)` (lists) /
`.12–.16` (borders) · input fill `rgba(35,35,32,.055)` · tracks `rgba(35,35,32,.07)`.

Accents (deeps L .58–.72 C .10–.12; washes L .93–.95 C .035–.045):

- sky (primary actions, fastest, GPS puck): deep `oklch(0.58 0.11 245)` ≈ #4E7FBE · wash
  `oklch(0.93 0.035 245)` · on-wash `oklch(0.42 0.09 245)` · link `oklch(0.5 0.1 245)`
- mint (scenic, ok/success, rest stops): deep `oklch(0.6 0.1 165)` ≈ #3FA284 · wash
  `oklch(0.93 0.04 165)` · on-wash `oklch(0.42 0.08 165)`
- lilac (accessible, coverage notes): deep `oklch(0.58 0.1 305)` · wash `oklch(0.93 0.035 305)` ·
  on-wash `oklch(0.4 0.06 305)`
- amber (barriers, steep spans, departure): deep `oklch(0.72 0.11 80)` · wash
  `oklch(0.95 0.045 85)` · on-wash `oklch(0.45 0.1 70)`
- rose (blocked, steps, End): deep `oklch(0.58 0.12 20)` · wash `oklch(0.93 0.035 20)` · on-wash
  `oklch(0.45 0.11 20)`

Map (restyle MapLibre to this; tiles stay uncached): base `#ECF0E6` · parks `#DEEBD3` · water
`#D9E7EE` · roads `#FBFAF6` · attribution `rgba(35,35,32,.45)`. Route lines: selected 6–7 px full
opacity, others 4–5 px @ 75%; follow mode: ahead mint 11 px, behind `#B8B6AC` 9 px @ 55%.

### Shape & shadow tokens

Radii: pills/chips 999 · inputs/primary buttons 13–14 · cards 16 · docks/banners 18–20 · mobile
sheet top 22 · desktop modal 24. Grabber 40×4.5 `rgba(35,35,32,.14)`.

Shadows: card `0 10px 28px rgba(30,30,25,.10)` (or flat ring `0 0 0 1px rgba(35,35,32,.09)`) ·
selected card `0 0 0 2px <route deep>, 0 14px 34px rgba(30,30,25,.16)` · bottom sheet
`0 -14px 44px rgba(30,30,25,.14)` · floating banner `0 14px 40px rgba(30,30,25,.18)` · desktop
modal `0 30px 80px rgba(30,30,25,.28)` over scrim `rgba(35,35,32,.16)` · sky button glow
`0 8px 22px oklch(0.58 0.11 245 / .35)`.

### Icons

Tiny inline geometric SVGs in currentColor, 1.8–4 px round-capped strokes: magnifier, filled
location arrow, chevrons/carets, rounded-L turn arrows, gate (2 posts + 2 crossbars), steps
(45°-rotated square), check. Route/objective identity = 9–11 px filled dot in the deep accent.

## Screens

### Desktop ≥1024 — plan bar + streaming results

Full-viewport map; two centered floating layers.

- **Plan capsule** (top 22): surface pill radius 999, pad 8/8/8/22, segments split by 1×22
  hairlines: origin (sky dot + 14.5/600 name) · `35 min` mono 13.5/700 · `Auto` 14/600 + caret ·
  `Fastest · Scenic · Accessible` 13.5/500 secondary · **Find routes** sky button (white 14/700,
  pad 10×22, radius 999). Each segment opens a popover editor (search / slider / segmented / chips
  per the mobile plan sheet).
- **Results row** (bottom 30): three 292 px cards, gap 14, radius 16, pad 16×18. Rows: accent dot +
  label 15/700 + duration mono 14/700 right → mono 11.5 secondary `2.3 km · loop · on foot` → mono
  11 tertiary `scenic 41 · air 71 · shade 55` → one 12.5 sentence. Selected = 2 px accent ring.
  Pending = pulsing dot, two skeleton bars (72%/46%×10 radius 999), mono 11 `Checking surfaces,
  air and rest stops`.
- Bottom-center attribution mono 9.5 `map data © OpenStreetMap contributors`.

### Desktop — route detail modal

Scrimmed map, only selected route + amber barrier dot. Centered modal 880, radius 24, pad
28/34/24: header (mint dot · `Scenic loop` 21/800 · mint-wash chip mono 10.5 `ok · loop on foot` ·
32 px hairline close circle) → centered mono 13 stats `34 min · 2.6 km · 21 m up · best window
today 17:30` → centered narration 15/1.6 max-640 + mono 10 credit `written only from the numbers
on this card` (omit block when narration null) → two columns gap 30:

- Left `TURN-BY-TURN · 14 STEPS`: rows = 24 px sky-wash index circle (mono 11) + step 14 +
  distance mono 12 right, hairline separators. Barrier chip indented 36: amber wash radius 10 pad
  7×12, gate glyph + 12/600 `Kissing gate on this step — may block wheelchairs`. Footer link
  `9 more steps`.
- Right: score bars (label 58 px 13/600; 6 px track; fills scenic=mint, air=sky, shade=lilac;
  value mono 12/700; method line mono 10 `scored from street-level imagery · cached, never live`)
  · lilac coverage card (radius 14, verbatim `confidence_note`, sub mono 9.5 `unknown never counts
  as safe`) · elevation chart (2.5 px sky polyline, amber 4 px overlay on steep spans, hairline
  baseline, mono 8.5 `0 km`/`2.6 km`, stat mono 11 `21 m up · 21 m down · max 6.1% — limit 8%`;
  one decimal; threshold from wire `limit_pct`) · mint-wash rest pills `Bench · 400 m`
  `Water · 1.1 km` `Toilets · 1.9 km` · outline export pills GPX / GeoJSON / Print / Open in Maps
  · warning mono 10 `Google / Apple hand-off will not be the same route` (in DOM before the
  links).

### Mobile <1024 — plan sheet

Map above (ink origin pin 8 with surface ring + sky halo); bottom sheet (surface, top radius 22,
pad 9/22/44 + safe-area, centered column gap 15): grabber → search field (input fill, radius 14,
pad 13×15: magnifier + address 15/500 + sky location arrow) → `HOW LONG DO YOU HAVE?` micro-label
→ `35 min` mono 38/700 → slider (6 px track, sky fill, 26 px surface thumb) → preset chips
`20 45 90 180` (hairline pills mono 11) + `minutes` → segmented Auto/Walk/Bike/Drive (container
`rgba(35,35,32,.06)` radius 999 pad 3; active surface pill 700 + small shadow) → `OPTIMISE FOR —
UP TO 3` + chips (active: accent wash + on-wash text + 1 px `oklch(0.78 0.07 <hue>)` border;
Fastest=sky Scenic=mint Accessible=lilac; Quiet/Shade/Clean air outline, disabled color, `· soon`)
→ `Leaving now` + caret → full-width **Find routes** sky button (16/700, pad 15, radius 14, glow)
→ footer mono 9.5 `no account · no history · your location stays on this phone`. Minutes 20–360
step 5; origin is the only required input.

### Mobile — streaming results

Map with all route lines + blocker dots (rose steps, amber gate). Sheet: grabber → progress strip
(pulsing sky dot + mono 10.5 phase text + 200×3 progress bar) → cards gap 11 (anatomy as desktop;
scores fold into meta line `2.6 km · loop · scenic 82 · air 74 · shade 61`).

Blocked accessible card: lilac dot + `Accessible` + rose-wash chip `blocked`; blocker rows (20 px
wash circle + glyph + 13 text) `Steps — flight at the Vossiusstraat entrance` / `Gate — kissing
gate by the rose garden`; footer mono 10 `kept in its slot — tap a blocker to see it on the map`.
Clear variant: mint-wash chip `no blockers found` + `Step-free as far as the data goes — it covers
61% of this route.` Never claim "accessible" outright.

### Mobile — route detail

Expanded sheet over map sliver: grabber → mint dot + `Scenic loop` 19/800 → mono 12 `34 min ·
2.6 km · 21 m climb` → full-width **Start follow mode** sky button → score bars + method line →
lilac coverage card → elevation chart + stat line → rest pills → departure row (amber dot + `Best
window today 17:30` 700 + `— cleaner air, lower sun`) → `Turn-by-turn` disclosure row (hairlines
top/bottom; right mono 11 `14 steps · 1 barrier` + chevron) → export pills.

### Mobile — place search

Full surface screen, keyboard up: field (typed text + blinking 2×18 sky caret) + `Cancel` 15/600
sky → ≤6 result rows (30 px circle: top hit mint wash + mint dot, rest neutral; name 15/600 + sub
12 tertiary, hairline separators) → footer mono 9.5 `searches are your own words — never stored,
never sent to analytics`. Empty list is a quiet real answer, not an error. Debounce 500 ms,
abortable.

### Follow mode — active (the core mobile feature)

Full-screen map. Puck: sky 9.5 core + 13 surface ring + 34 halo breathing (opacity .22↔.07,
2.6 s; static under `prefers-reduced-motion`).

- **Next-turn banner** (top, inset 16, surface radius 20): 56 px sky-wash tile (radius 16) with
  32 px turn arrow → `120 m` mono 27/700 + `Turn left onto Vossiusstraat` 15/600; "then" row under
  hairline: mono 10 `then` + mini arrow + 12.5 secondary `bear right at the pond`. The banner
  names the **next** step, never the containing one.
- **Dock** (bottom, inset 16, surface radius 18): `18 min · 1.4 km left` 17/800 + mono 11 `arrive
  10:00 am · GPS ±9 m` (12-h clock always carries am/pm); right: **End** pill (rose wash/rose text
  14/700).
- Centered provenance line mono 9 @50%: `position never leaves this phone — no network in follow
  mode`.

### Follow — barrier ahead

Add amber card below banner (amber wash radius 18): 42 px surface circle + gate glyph → `Gate in
140 m` 15.5/800 + `Kissing gate on this path — one gentle vibration, then quiet.` 12.5. Map: amber
dot with surface ring at the barrier's own coordinates.

### Follow — off route

Banner becomes ink card (`#232320` radius 20): `Off route for 15 seconds` 17/800 on-dark → `Head
back toward the marked path — it is about 90 m to your left.` 13.5 @78% → hairline → mono 10 @55%
`no recalculation in follow mode — your position never leaves this phone`. Map: puck displaced,
dashed `#9A988E` connector (2.5 px, dash 4 6) back to the line. Dock sub-line: `paused off route ·
GPS ±11 m`.

### Follow — arrival

Centered card 330 (radius 22, pad 26×24): 52 px mint-wash circle + check → `Loop complete` 24/800
(`Arrived` for point-to-point) → mono 12.5 `34 min · 2.6 km · 21 m climbed` → hairline → 12.5
secondary `34 minutes outside. Nothing was uploaded — this walk exists only on your phone.` →
full-width **Done** sky button → `Report a barrier on this route` sky link.

## Behavior

Streaming (`POST /api/routes`, SSE): merge `route` events **by id, never append** (same id arrives
up to 3×). While `enrichment_pending`, geometry/duration are final — skeleton only scores/rest
stops; status can flip ok→blocked on pass two (swap the chip, never reorder). `progress` events
drive the strip; cache hits have none — skip the strip. A stream closing without `done` is a
failure, not an empty result. Previous results stay on screen and interactive until replaced.
Blocked routes keep their slot; if all are blocked, render the top-level `reason` above the cards.

Honest data: unknown → `—`, never 0 or an empty bar. `rest_stops` null = "could not look" (say
so); `[]` = "looked, found none". Gradients one decimal; steep threshold from wire `limit_pct`.
`scoring_method` always visible near scores. Distances: metric <1 km nearest 10 m; imperial
<160 m nearest 10 ft; <5 m omit distance. Durations as speech (`1 hr 25 min`).

Follow mode: zero outbound requests (keep the contract test green). One `watchPosition`
(`enableHighAccuracy: true, maximumAge: 2000, timeout: 15000`). Wake lock held, re-acquired on
`visibilitychange`, released on exit. Fix accuracy >75 m: reject **visibly** (dock sub-line shows
waiting + the ± figure), never move the puck. Off-route: only after 15 sustained seconds beyond
40 m, reset on one good fix; no recalculate anywhere. Barrier warning: 200 m ahead measured
**along the route** (15 m behind-tolerance); one vibration per barrier identity, none under
`prefers-reduced-motion`. Arrival latch: ≤25 m from final vertex AND ≥75% progress.

Motion (sparse): pulses (skeleton dot, caret, halo) as above; sheets/banners 200–250 ms ease-out
translate+fade; ring swap 150 ms; nothing else. All static under `prefers-reduced-motion`. Desktop
hover: outline pills fill `rgba(35,35,32,.04)`, buttons darken ~4% L, cards lift one shadow step.
Focus: 2 px sky ring, offset 2.

State: keep the single-reducer pattern — the only fetch trigger is the `nonce` counter. Selection,
theme, units, and all follow-mode state (watch id, anchor, off-route clock, passed-barrier ids,
wake lock) live outside the reducer. Deep links via `replaceState` only.

Responsive: ≥1024 capsule + card row + centered modal; <1024 bottom sheets (peek/half/full,
draggable). Must pass at 320 and 390 wide; consume all four `env(safe-area-inset-*)`.
