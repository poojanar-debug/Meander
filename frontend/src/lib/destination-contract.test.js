import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import { buildRoutes } from '../api/mock.js'
import { BIKE_MAX_STRAIGHT_M, FOOT_MAX_STRAIGHT_M, effectiveMode } from './format.js'
import { haversineM } from './follow.js'

// The destination end of a trip, which the backend has always accepted and the
// frontend could only reach through a shared link.
//
// Two halves. The first is real behaviour: the demo build is the one build that
// ships with no backend, and its routes have to actually go where the user
// said. The second is a source scan, in the same spirit as
// `follow-contract.test.js` — nothing in this repo renders a component, so the
// invariants that would otherwise rot silently are asserted against the source
// that has to hold them.

const SRC = fileURLToPath(new URL('..', import.meta.url))
const read = (rel) => readFileSync(`${SRC}${rel}`, 'utf8')

const COLOMBO = { lat: 6.9271, lon: 79.8612 }
const GALLE_FACE = { lat: 6.9271, lon: 79.8438 }
const KANDY = { lat: 7.2906, lon: 80.6337 }

const endOf = (route) => route.geometry[route.geometry.length - 1]

describe('a demo route with a destination ends at the destination', () => {
  it('lands every route on the point the user picked', () => {
    // The mock used to draw every point-to-point route on a fixed bearing of
    // 22 degrees at a fixed 2100 m, whatever was asked for. With no UI able to
    // set a destination that was invisible; with one it is the first thing a
    // demo shows, and it would show a line going somewhere else entirely.
    const routes = buildRoutes({
      origin: COLOMBO,
      destination: GALLE_FACE,
      mode: 'auto',
      objectives: ['fastest', 'scenic', 'accessible'],
    })
    expect(routes).toHaveLength(3)
    for (const route of routes) {
      const gap = haversineM(endOf(route), [GALLE_FACE.lon, GALLE_FACE.lat])
      expect(gap, `${route.id} ends ${Math.round(gap)} m from the destination`).toBeLessThan(5)
    }
  })

  it('gives the three routes different lengths between the same two points', () => {
    // The bow is what separates them, and it must not have flattened when the
    // bearing stopped being a constant.
    const [fastest, scenic] = buildRoutes({
      origin: COLOMBO,
      destination: GALLE_FACE,
      objectives: ['fastest', 'scenic'],
    })
    expect(scenic.distance_m).toBeGreaterThan(fastest.distance_m)
  })

  it('returns to the origin when there is no destination', () => {
    const [loop] = buildRoutes({ origin: COLOMBO, minutes: 35, objectives: ['fastest'] })
    const gap = haversineM(endOf(loop), [COLOMBO.lon, COLOMBO.lat])
    expect(gap).toBeLessThan(5)
  })

  it('reads the straight line rather than the dial for auto mode', () => {
    // The dial's default of 35 minutes says "on foot". Colombo to Kandy is
    // about 95 km, and `buildRouteRequest` does not even send the number, so a
    // mock that consulted it would walk the user there and disagree with the
    // mode the capsule is showing at the same moment.
    const straight = haversineM([COLOMBO.lon, COLOMBO.lat], [KANDY.lon, KANDY.lat])
    expect(straight).toBeGreaterThan(BIKE_MAX_STRAIGHT_M)

    const [far] = buildRoutes({
      origin: COLOMBO,
      destination: KANDY,
      mode: 'auto',
      objectives: ['fastest'],
    })
    expect(far.mode).toBe('car')
    expect(far.mode).toBe(effectiveMode('auto', 35, straight))

    const [near] = buildRoutes({
      origin: COLOMBO,
      destination: GALLE_FACE,
      mode: 'auto',
      objectives: ['fastest'],
    })
    const short = haversineM([COLOMBO.lon, COLOMBO.lat], [GALLE_FACE.lon, GALLE_FACE.lat])
    expect(short).toBeLessThan(FOOT_MAX_STRAIGHT_M)
    expect(near.mode).toBe('foot')
  })

  it('draws a line rather than 48 identical points when the two ends coincide', () => {
    const [same] = buildRoutes({
      origin: COLOMBO,
      destination: { ...COLOMBO },
      objectives: ['fastest'],
    })
    expect(same.geometry.length).toBeGreaterThan(2)
    expect(same.duration_min).toBeGreaterThan(0)
  })
})

describe('both plan surfaces can set a destination', () => {
  it('the capsule has a destination segment beside the origin', () => {
    const src = read('components/PlanCapsule.jsx')
    expect(src).toMatch(/capsule__seg--dest/)
    expect(src).toMatch(/placeholder="Where to\?"/)
  })

  it('the sheet has a destination field beside the origin', () => {
    const src = read('components/PlanSheet.jsx')
    expect(src).toMatch(/plan__search--dest/)
    expect(src).toMatch(/onOpenDestSearch/)
  })

  it('the place screen knows which end of the trip it is editing', () => {
    const src = read('components/PlaceSearch.jsx')
    expect(src).toMatch(/dest:\s*\{/)
    expect(src).toMatch(/Search for a destination/)
  })

  it('App threads a destination handler into both', () => {
    // `planProps` is what the capsule and the sheet are both spread from, so a
    // handler that misses it misses whichever surface the user is on.
    const src = read('App.jsx')
    expect(src).toMatch(/const planProps = \{[\s\S]*?dest: state\.dest,[\s\S]*?onDest,[\s\S]*?\n  \}/)
  })
})

describe('the time budget is absent, not disabled, once there is a destination', () => {
  // `buildRouteRequest` omits `minutes` from a point-to-point body and
  // `encodeState` omits it from the link, so the dial cannot change that
  // request: not its length, not its mode, not its cache row. Showing one
  // anyway is the single thing this UI is not allowed to do, and the precedent
  // is `BestWindow`, which does not render at all rather than name a time it
  // cannot stand behind.
  it('the capsule drops the minutes segment and its editor', () => {
    const src = read('components/PlanCapsule.jsx')
    expect(src).toMatch(/\{!dest && \([\s\S]{0,400}capsule__seg--minutes/)
    expect(src).toMatch(/editor === 'minutes' && !dest/)
  })

  it('the sheet puts one sentence where the dial was', () => {
    const src = read('components/PlanSheet.jsx')
    expect(src).toMatch(/\{dest \? \([\s\S]{0,400}plan__budget-note[\s\S]{0,200}\) : \([\s\S]{0,200}<TimeDial/)
  })

  it('the mobile results row names the destination rather than the dial', () => {
    expect(read('App.jsx')).toMatch(/isLoop \? `\$\{state\.minutes\} min` : `to \$\{state\.dest\.name\}`/)
  })
})

describe('a destination is only ever a place picked from search', () => {
  it('the locate button writes to the origin and nothing else', () => {
    // Not a style point. `resultsStore.js` hashes the destination byte-exact
    // and snaps only the origin to a grid, and the reason it is allowed to is
    // that a device fix cannot reach this field. A `type: 'dest'` dispatch in
    // here would make two genuinely different destinations answer for each
    // other, silently, on the offline replay path.
    const src = read('App.jsx')
    const locate = src.slice(src.indexOf('const onLocate'), src.indexOf('const onSelect'))
    expect(locate).toMatch(/type: 'origin'/)
    expect(locate).not.toMatch(/'dest'/)
  })

  it('neither destination control offers geolocation', () => {
    const capsule = read('components/PlanCapsule.jsx')
    const destPopover = capsule.slice(capsule.indexOf("editor === 'dest'"), capsule.indexOf("editor === 'minutes'"))
    expect(destPopover).not.toMatch(/onLocate/)

    const sheet = read('components/PlanSheet.jsx')
    const destRow = sheet.slice(sheet.indexOf('plan__search--dest'), sheet.indexOf('plan__hint'))
    expect(destRow).not.toMatch(/LocationArrowIcon/)
  })
})
