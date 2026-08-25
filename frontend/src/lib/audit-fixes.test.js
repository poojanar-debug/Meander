import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

// Source scans for the Part 9 frontend findings that have no rendering test to
// live in. Nothing in this repo renders a component, so a property that is only
// visible in JSX is otherwise guarded by nothing at all — which is how most of
// these shipped.
//
// Each one names the user-visible symptom rather than the mechanism, because
// the mechanism is what changes and the symptom is what has to keep not
// happening.

const SRC = fileURLToPath(new URL('..', import.meta.url))
const read = (rel) => readFileSync(`${SRC}${rel}`, 'utf8')
const code = (rel) =>
  read(rel)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')

describe('a stream that never finished is not a result', () => {
  const client = code('api/client.js')

  it('rejects rather than resolving null when no done frame arrives', () => {
    // `App.jsx` dispatches a null result as `settled`, which sets
    // `phase: 'success'`. With zero routes that is an empty results region with
    // no banner, no error and no announcement, while the trip bar, the
    // departure strip and About all still render: a page that looks like it is
    // working and has nothing in it.
    expect(client).toMatch(/if \(final == null\)/)
    expect(client).toMatch(/stopped before it finished/)
  })

  it('flushes the tail buffer before deciding', () => {
    // The loop broke the moment `read()` reported done, discarding anything
    // still in `buffer` — so a final frame that arrived without its trailing
    // delimiter was dropped, and a `done` delivered that way became a stream
    // with no result at all.
    expect(client).toMatch(/if \(done\) \{[\s\S]*?decoder\.decode\(\)[\s\S]*?break/)
  })

  it('guards the non-streaming JSON branch', () => {
    // `await res.json()` and `json.routes.forEach(...)` were both unguarded, so
    // a truncated or non-JSON body threw a raw SyntaxError or TypeError —
    // neither an ApiError — and reached the banner as the browser's
    // untranslated string. The streaming branch has been guarded since it was
    // written; two transports for one endpoint have to fail the same way.
    expect(client).toMatch(/Array\.isArray\(json\?\.routes\)/)
    expect(client).toMatch(/could not read/)
  })
})

describe('fresh data is never labelled as a saved copy', () => {
  it('merges a live route onto a stamp-free base', () => {
    // A replayed route carries `servedFromCache` and `cachedAt`; a live SSE
    // route carries neither, **so the spread cannot clear them**. The merge
    // yielded the new distance and the old timestamp, and the banner then said
    // "Saved copy from N minutes ago" over fresh data.
    const app = code('App.jsx')
    expect(app).toMatch(/function stampFree\(route\)/)
    expect(app).toMatch(/\{ \.\.\.stampFree\(r\), \.\.\.incoming \}/)
  })
})

describe('the live region speaks twice when it is told to', () => {
  it('carries a sequence number beside the text', () => {
    // React bails out when the new state is `Object.is`-equal to the old, so an
    // identical string never mutated the text node and no assistive technology
    // fired. It bites whenever the same sentence is announced twice with
    // nothing between: "GPX file saved." twice, "Link copied" twice.
    const app = code('App.jsx')
    expect(app).toMatch(/useState\(\{ text: '', seq: 0 \}\)/)
    expect(app).toMatch(/seq: prev\.seq \+ 1/)
    expect(app).toMatch(/\{announcement\.text\}/)
  })
})

describe('the consent sweep runs on every boot', () => {
  it('is called from main.jsx and not only from About', () => {
    // Its own docstring says "This runs on every boot, before anything is
    // rendered" — and all seven production call sites were reached only through
    // `OfflineControl` -> `About`, which App renders only in the non-first-run
    // branch. On a cold open with no origin, the common case, it never ran.
    expect(code('main.jsx')).toMatch(/refreshOfflineSetting\(\)/)
  })
})

describe('exports are in the units the user chose', () => {
  it('threads units from the detail to the file on disk', () => {
    // `fmtDist(route.distance_m)` with one argument falls back to METRIC_24,
    // and the prop never arrived — so a user in miles got GPX, GeoJSON and a
    // printed sheet in metres while every number on screen was in feet. The
    // export surface is ExportPills now (TakeItWithYou before the redesign);
    // the symptom guarded is the same.
    expect(code('components/RouteDetail.jsx')).toMatch(/<ExportPills[\s\S]{0,200}units=\{units\}/)
    expect(code('components/ExportPills.jsx')).toMatch(/downloadGpx\(route, \{ origin, dest \}, units\)/)
    expect(code('components/ExportPills.jsx')).toMatch(/downloadGeoJson\(route, units\)/)
    const exp = code('lib/export.js')
    expect(exp).toMatch(/provenanceNote\(route, units = METRIC_24\)/)
    expect(exp).toMatch(/fmtDist\(route\.distance_m, units\)/)
    // The climb line was the last hard-coded metric unit in the file.
    expect(exp).toMatch(/formatElevation\(up, units\)/)
    expect(exp).not.toMatch(/Math\.round\(up\)\} m/)
  })
})

describe('the rail shows what was asked for', () => {
  const app = code('App.jsx')

  it('does not sort stale objectives to the top', () => {
    // `indexOf` returns -1 for an id no longer in the list, and -1 sorts before
    // 0 — so a route for a chip the user had just un-pressed jumped to the head
    // of the rail.
    expect(app).toMatch(/Number\.MAX_SAFE_INTEGER/)
    expect(app).toMatch(/routes\.filter\(\(r\) => state\.objectives\.includes\(r\.id\)\)/)
  })

  it('refuses a fourth objective out loud', () => {
    // `[...objectives, value].slice(-3)` silently un-pressed the first, with no
    // disabled state and no announcement of what was dropped.
    expect(app).toMatch(/if \(!present && state\.objectives\.length >= 3\) return state/)
    expect(app).toMatch(/Three route types at a time/)
  })

  it('remounts the detail panel when the route changes', () => {
    // Select a 5 km route, drag the barrier reporter to 3000 m, select a 1 km
    // route: the label read a distance past the end of the route it would file
    // against.
    expect(app).toMatch(/key=\{selectedRoute\?\.id \?\? 'none'\}/)
  })
})

describe('a step never says to walk no distance', () => {
  it('does not ask the formatter about a distance that rounds to zero', () => {
    // `formatDistance` rounds to the nearest 10 m below 1 km, so anything under
    // 5 m renders "0 m" — and under 1.524 m "0 ft" — producing "follow it for
    // 0 m". The threshold was 1 m, which let 1 to 4 m straight through.
    const steps = code('components/StepList.jsx')
    expect(steps).toMatch(/const WORTH_SAYING_M = 5/)
    expect(steps).toMatch(/step\.distance_m >= WORTH_SAYING_M/)
  })
})

describe('the map cleans up after itself', () => {
  it('removes the delegated layer listeners it added', () => {
    // `map.off` appeared zero times, and MapLibre holds delegated handlers on
    // the map rather than on the layer — so removing a layer did not remove
    // them, and every re-run of the layer effect added another click,
    // mouseenter and mouseleave for an id that recurs across searches.
    const map = code('components/MapView.jsx')
    expect(map).toMatch(/map\.off\(type, layer, handler\)/)
    expect(map).toMatch(/layerHandlersRef/)
  })
})
