# 5 · The app shell is cached always; a route only after opt-in

**Accepted.** Phase 6.5.

## Context

The brief asks the PWA to cache "the app shell and the last result". The
project's own rule is that browser storage is opt-in and labelled. Those pull
in opposite directions — until you notice the cache is two different things.

## Decision

Split it.

- **The shell** — HTML, JS, CSS, icons — is cached unconditionally. It is the
  program: identical bytes for every visitor, it reveals nothing about anybody,
  and it is the entire reason the app opens on a train.
- **A result** is cached **only after an explicit opt-in, off by default**. A
  route is a polyline through the streets around wherever the user is standing,
  which is the most revealing object this app touches.
- Exactly one result is kept, never a history. A cache keyed by request that
  grew without bound would be a log on disk of everywhere the user had asked
  about.
- Turning it off **deletes** what is stored rather than merely ceasing to add.
- **Map tiles are cached under neither.** A tile cache is a record of where you
  have been, and they are third-party.
- A route served from the cache is labelled with its age on the row, on the
  card, and on a pill under the top bar that no panel position can hide. Past
  15 minutes it also names what has stopped being true — air quality, rest
  stops and the best departure time are measurements of a moment, while the
  shape of the route is not.

## Consequences

- Offline shows the route list with no map behind it. Affordable only because
  Phase D verified the map is not load-bearing: with `MapView` hidden the list
  still carries every duration, score, blocker and rest stop.
- A user who never opts in gets an app that opens offline and has nothing to
  show, which is stated in the settings sheet before they choose.
- **The permalink turned out to be load-bearing for this.** Geocoding is never
  cached — a search box's contents are the user's own words — so an offline
  reload cannot look a place up. It does not need to: the controls are already
  in the URL, and `check:permalink` guarantees the decoded state rebuilds a
  byte-identical request body, which is exactly the key the worker stored the
  result under. Two features built for unrelated reasons.

  > **Amended 2026-08-10.** The decision stands; the mechanism in that last
  > bullet has moved twice and the paragraph is left as written so the movement
  > is visible. The worker no longer stores anything — BLOCKED.md §8 found it
  > had never run in production, and `src/lib/resultsStore.js` on the page does
  > it now. And the key is no longer the byte-identical body: it is a SHA-256
  > over the request with the **origin snapped to a 4 dp grid**, because a
  > device fix is a fresh measurement every time and byte-identity meant a
  > geolocated search could never replay at all. So the permalink is still
  > load-bearing for a search that came from a link, and it is deliberately not
  > load-bearing for one that came from the device: BLOCKED.md §9 made
  > `writeUrl` clear the address bar for a geolocated origin rather than leave
  > the previous search standing, so there is no link to reload, and the grid is
  > what carries that case instead.

## Alternatives rejected

**Cache results unconditionally.** The straightforward reading of the brief.
Rejected: it writes someone's location to disk without asking.

**Cache nothing.** Rejected: it makes the PWA pointless, and the shell cache is
not the part that raises the question.

**Ask on first use with a prompt.** Rejected: a modal that appears while
somebody is reading their route is a worse experience than a control in the
settings sheet they can find when they want it.
