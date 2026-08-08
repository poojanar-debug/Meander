import { describe, expect, it } from 'vitest'

import {
  barriersWithin,
  cumulativeDistances,
  haversineM,
  locateOnRoute,
  metresToNextTurn,
  nextRestStop,
  pointAtDistance,
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

describe('pointAtDistance', () => {
  // The inverse of locateOnRoute. It exists so a barrier report can say "about
  // 400 m along this route" and turn that into a coordinate a mapper can visit.

  it('returns the axes the API expects, not the ones the geometry uses', () => {
    // ⚠ The failure this pins is not a crash. Geometry is [lon, lat]; the
    // BarrierReport model takes named lat/lon. Swapping them files a note in the
    // wrong hemisphere of a public database and nothing downstream notices.
    // A point 22 m north of the equator on the prime meridian, so lat and lon
    // are unmistakably different numbers.
    const north = [
      [0, 0],
      [0, 0.0002],
    ]
    const at = pointAtDistance(north, 11.1)

    expect(at.lat).toBeGreaterThan(0)
    expect(at.lon).toBeCloseTo(0, 9)
  })

  it('interpolates inside a segment rather than snapping to a vertex', () => {
    // LINE's vertices are ~111 m apart. Asking for 55 m must land between the
    // first two, not on either of them.
    const at = pointAtDistance(LINE, 55)
    expect(at.lon).toBeGreaterThan(0)
    expect(at.lon).toBeLessThan(0.001)
  })

  it('clamps rather than extrapolating past either end', () => {
    const total = cumulativeDistances(LINE).at(-1)
    const past = pointAtDistance(LINE, total + 5000)
    const before = pointAtDistance(LINE, -5000)

    expect(past.lon).toBeCloseTo(LINE.at(-1)[0], 9)
    expect(before.lon).toBeCloseTo(LINE[0][0], 9)
  })

  it('agrees with locateOnRoute — a round trip returns the distance it was given', () => {
    const cum = cumulativeDistances(LINE)
    const at = pointAtDistance(LINE, 200, cum)
    const back = locateOnRoute([at.lon, at.lat], LINE, cum)

    expect(back.alongM).toBeCloseTo(200, 0)
    expect(back.offRouteM).toBeCloseTo(0, 3)
  })

  it('returns null for a degenerate geometry instead of a point off Africa', () => {
    // [0, 0] is the Gulf of Guinea, and a barrier filed there is worse than no
    // barrier filed at all.
    expect(pointAtDistance([], 10)).toBeNull()
    expect(pointAtDistance([[0, 0]], 10)).toBeNull()
    expect(pointAtDistance([[5, 5], [5, 5]], 10)).toBeNull()
  })
})
