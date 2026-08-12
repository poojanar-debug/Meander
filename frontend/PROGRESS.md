
---

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
