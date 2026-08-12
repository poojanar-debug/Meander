
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

## §13.10 — The deploy, and the window it closed

**The VM half went first, and that was the mistake.** The API container was
rebuilt during Part 4's verification so that Ella could be tested through the
deployed stack. That shipped the `scenic` rename to the server while Cloudflare
Pages was still serving a bundle that had only ever heard of `nature`, and Part
6's own warning is that those two have to move together.

Measured on the live site in that state, rather than reasoned about:

```
routeRows   3
rowText     Fastest    ... solid line on the map
            Scenic     ... solid line on the map     <- should be dashed
            Accessible ... dotted line on the map
scoreRows   Nature       not measured                <- server sent scores.scenic
            Clean air    37%
            Shade        45%
chips       Nature, shown as a dashed line           <- and it was solid
```

Degraded rather than down, which is worth being exact about: `styleFor('scenic')`
and `routeColor('scenic')` fall back rather than throw, so the page rendered.
What it rendered was **"not measured" against a route the server had measured** —
the silent key-drift `RouteRow` and `RouteDetail` are warned about in their own
comments, and the one class of wrongness this project exists not to have.

`phone-pass` merged to `main`, Pages rebuilt, and the same probe now reads
`Scenic 48%`, `dashed line on the map`, and a chip that agrees with the route.

**One regression was caught by reading the merge's file list before pushing.**
`scripts/publish_graph.sh --local` clears and repopulates
`graphhopper/graph-dist/`, which is gitignored — so the tracked `.gitkeep` inside
it looked deleted and a `git add -A` recorded that. Its own contents say why it
exists: the router Dockerfile has an unconditional
`COPY graphhopper/graph-dist/ /data/`, and a COPY of a missing path fails the
build outright. Nothing in CI builds the router image, so nothing would have
caught it. Restored in its own commit.

### Two false failures in `live-gate.mjs`, and neither was the deployment

The first run reported **4 failures**. All four were the gate.

`.panel__scroll` matching zero elements, on a bundle that contained the class and
a DOM that had it a minute later. `live-gate.mjs` launches with a **fixed**
`--user-data-dir` and registers a service worker that serves the shell
cache-first without revalidating — so a run can grade whatever build that profile
last saw. This is the identical trap found in `gate.mjs` in §13.3, in a file
that had not been looked at for it. `gate.mjs` clears workers and caches; this
one cannot, because registering and precaching that worker is a thing it exists
to check, so it takes a fresh profile per run instead.

The two SSE checks — one chunk, 74,727 bytes, 0.00 s spread — with the route
cache **emptied first**, so not the cached-replay case the file already guards.
Checked another way rather than assumed: `curl -sN --no-buffer` against the same
public origin received **eight frames over 0.58 s** (three progress events, two
routes, then the enriched pass), and direct to uvicorn, eight over 0.78 s. The
server streams and Caddy streams; Chrome coalesced them because the whole answer
arrived inside one paint.

The file already knew this — its cached branch says chunk count "cannot
distinguish a fast replay from buffering" and that grading it "fails a healthy
deployment for having answered too quickly". That guard was keyed on one *cause*
rather than on the condition, so a cold request against a warm self-hosted graph
walked straight past it. Widened, with the first-byte time kept as the part that
stays meaningful: a buffered response cannot deliver its first byte before the
work is done.

The fourth, "choosing No deletes the saved set", was a knock-on of the stale
shell and passes on a clean profile.

**`43 passed, 0 failed, 1 not checkable here`** against the live deployment. The
one is the real-phone list, which device emulation cannot stand in for and which
the gate says so about rather than claiming.
