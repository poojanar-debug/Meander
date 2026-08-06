import { describe, expect, it } from 'vitest'

import {
  barriersWithin,
  cumulativeDistances,
  haversineM,
  locateOnRoute,
  metresToNextTurn,
  nextRestStop,
  stepAt,
  trackOffRoute,
} from './follow.js'

// A straight east-west line at the equator, where 1e-5 degrees of longitude is
// almost exactly 1.113 m — convenient for reasoning about the numbers.
const LINE = [
  [0, 0],
  [0.001, 0],
  [0.002, 0],
  [0.003, 0],
]

describe('haversineM', () => {
  it('measures a known short distance', () => {
    // 0.001 degrees of longitude at the equator is ~111.32 m.
    expect(haversineM([0, 0], [0.001, 0])).toBeCloseTo(111.32, 0)
  })

  it('is symmetric and zero for a point against itself', () => {
    expect(haversineM([1, 2], [1, 2])).toBe(0)
    expect(haversineM([1, 2], [3, 4])).toBeCloseTo(haversineM([3, 4], [1, 2]), 6)
  })
})

describe('locateOnRoute', () => {
  const cum = cumulativeDistances(LINE)

  it('reports zero off-route for a position exactly on the line', () => {
    const at = locateOnRoute([0.0015, 0], LINE, cum)
    expect(at.offRouteM).toBeLessThan(0.5)
    expect(at.alongM).toBeCloseTo(cum[1] + 55.66, 0)
  })

  it('projects onto the segment rather than snapping to the nearest vertex', () => {
    // Standing exactly on the line, midway between two vertices 111 m apart.
    // A nearest-vertex implementation would report ~55 m off-route and declare
    // a walker lost while they stand on the path.
    const at = locateOnRoute([0.0005, 0], LINE, cum)
    expect(at.offRouteM).toBeLessThan(0.5)
    expect(at.index).toBe(0)
  })

  it('measures perpendicular distance for a position beside the line', () => {
    // 0.0005 degrees of latitude is ~55.6 m north of the line.
    const at = locateOnRoute([0.0015, 0.0005], LINE, cum)
    expect(at.offRouteM).toBeCloseTo(55.6, 0)
  })

  it('returns null rather than throwing on a route with no shape', () => {
    expect(locateOnRoute([0, 0], [], undefined)).toBeNull()
    expect(locateOnRoute([0, 0], [[0, 0]], undefined)).toBeNull()
  })

  it('survives a duplicated vertex, which is a zero-length segment', () => {
    const withDupe = [
      [0, 0],
      [0, 0],
      [0.001, 0],
    ]
    const at = locateOnRoute([0.0005, 0], withDupe)
    expect(Number.isFinite(at.offRouteM)).toBe(true)
    expect(at.offRouteM).toBeLessThan(0.5)
  })
})

describe('stepAt and metresToNextTurn', () => {
  const steps = [
    { text: 'Continue', interval: [0, 1] },
    { text: 'Turn left', interval: [1, 2] },
    { text: 'Arrive', interval: [3, 3] },
  ]

  it('finds the step whose interval contains the vertex', () => {
    expect(stepAt(steps, 0)).toBe(0)
    expect(stepAt(steps, 2)).toBe(1)
  })

  it('falls back to the last step rather than returning nothing', () => {
    expect(stepAt(steps, 99)).toBe(2)
  })

  it('returns -1 when there are no steps at all', () => {
    expect(stepAt([], 0)).toBe(-1)
    expect(stepAt(undefined, 0)).toBe(-1)
  })

  it('measures to the end of the current step', () => {
    const cum = cumulativeDistances(LINE)
    // Standing at the first vertex, the turn is at the end of step 0 = vertex 1.
    expect(metresToNextTurn(steps, 0, 0, cum)).toBeCloseTo(cum[1], 0)
  })

  it('clamps at zero rather than reporting a negative distance', () => {
    const cum = cumulativeDistances(LINE)
    expect(metresToNextTurn(steps, 0, cum[1] + 30, cum)).toBe(0)
  })
})

describe('nextRestStop', () => {
  const stops = [
    { type: 'bench', at_m: 100 },
    { type: 'drinking water', at_m: 400 },
  ]

  it('returns the next one ahead and how far it is', () => {
    const next = nextRestStop(stops, 150)
    expect(next.stop.type).toBe('drinking water')
    expect(next.inM).toBe(250)
  })

  it('returns null once they are all behind', () => {
    expect(nextRestStop(stops, 500)).toBeNull()
  })

  it('returns null for a route with none, and for one never checked', () => {
    expect(nextRestStop([], 0)).toBeNull()
    expect(nextRestStop(null, 0)).toBeNull()
  })
})

describe('barriersWithin', () => {
  const blockers = [
    { type: 'steps', lat: 0, lon: 0.001, description: 'Three steps' },
    { type: 'kerb', lat: 0, lon: 0.02, description: 'High kerb' },
  ]

  it('finds only the barriers inside the radius, nearest first', () => {
    const found = barriersWithin(blockers, [0, 0], 200)
    expect(found).toHaveLength(1)
    expect(found[0].blocker.type).toBe('steps')
    expect(found[0].distanceM).toBeCloseTo(111.32, 0)
  })

  it('finds nothing when everything is far away', () => {
    expect(barriersWithin(blockers, [1, 1], 200)).toEqual([])
  })

  it('handles a route with no barriers', () => {
    expect(barriersWithin([], [0, 0])).toEqual([])
    expect(barriersWithin(undefined, [0, 0])).toEqual([])
  })
})

describe('trackOffRoute', () => {
  const t0 = 1_000_000

  it('does not fire on a single distant reading', () => {
    // The whole point of the sustained threshold: city GPS bounces off
    // buildings by tens of metres, and a one-sample test fires constantly on a
    // perfectly good walk.
    const state = trackOffRoute(null, 80, t0)
    expect(state.offRoute).toBe(false)
  })

  it('fires only after the distance has been exceeded continuously', () => {
    let state = trackOffRoute(null, 80, t0)
    state = trackOffRoute(state, 80, t0 + 14_000)
    expect(state.offRoute).toBe(false)
    state = trackOffRoute(state, 80, t0 + 15_000)
    expect(state.offRoute).toBe(true)
  })

  it('resets the moment one reading comes back on route', () => {
    let state = trackOffRoute(null, 80, t0)
    state = trackOffRoute(state, 80, t0 + 14_000)
    state = trackOffRoute(state, 10, t0 + 14_500) // back on the line
    expect(state.since).toBeNull()
    state = trackOffRoute(state, 80, t0 + 15_000)
    expect(state.offRoute).toBe(false)
  })

  it('treats exactly the threshold distance as on-route', () => {
    expect(trackOffRoute(null, 40, t0).since).toBeNull()
  })
})
