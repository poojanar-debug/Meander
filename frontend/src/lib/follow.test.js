import { describe, expect, it } from 'vitest'

import {
  barriersAheadOnRoute,
  cumulativeDistances,
  haversineM,
  locateOnRoute,
  metresToNextTurn,
  nextRestStop,
  pointAtDistance,
  projectPointOnRoute,
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

  describe('on a round trip, where two legs share a street', () => {
    // Out along the equator to 0.01 deg (~1.11 km), then back along a line 7.8 m
    // to the north — a ~2.2 km loop. That is the shape this app produces by
    // default, and 7.8 m is well inside the error of a city GPS fix, so which
    // leg is "nearest" at any instant is decided by noise rather than by where
    // the walker is.
    const OUT_AND_BACK = [
      [0, 0],
      [0.005, 0],
      [0.01, 0],
      [0.01, 0.00007],
      [0.005, 0.00007],
      [0, 0.00007],
    ]
    const loopCum = cumulativeDistances(OUT_AND_BACK)
    const total = loopCum[loopCum.length - 1]

    // Standing on the outbound leg at ~557 m, but a hair north — so the return
    // leg is marginally the closer of the two.
    const AMBIGUOUS = [0.005, 0.00004]

    it('takes the earliest acceptable match on the first fix, not the nearest', () => {
      // With no anchor there is no history to window against, and a loop's
      // start and end are the same place — a fix taken before the walker has
      // moved is a few metres from both 0 m and the full route length, and
      // noise decides which is nearer. Taking the nearest reported someone who
      // had not yet set off as having finished.
      const start = locateOnRoute([0, 0.00004], OUT_AND_BACK, loopCum)
      expect(start.alongM).toBeLessThan(50)

      // And it is not simply "always the start": a fix that is only acceptably
      // close further along still matches there.
      expect(locateOnRoute(AMBIGUOUS, OUT_AND_BACK, loopCum).alongM).toBeCloseTo(556, 0)
    })

    it('stays on the outbound leg when anchored to where the walker was', () => {
      // 540 m in, which is where someone at 557 m was a moment ago.
      const at = locateOnRoute(AMBIGUOUS, OUT_AND_BACK, loopCum, 540)
      expect(at.alongM).toBeCloseTo(556, 0)
      expect(at.alongM).toBeLessThan(total * 0.4)
    })

    it('advances monotonically along a whole loop rather than jumping legs', () => {
      // Walk the loop at 20 m steps, feeding each match back as the next
      // anchor, exactly as FollowMode does.
      //
      // Each fix is nudged 4.45 m north — a constant bias well inside city GPS
      // error, and the thing that makes this test bite. Sampling points exactly
      // on the line proves nothing: the leg you are on is then 0 m away and the
      // other is 7.8 m away, so even the unanchored projection gets it right.
      // The bug only appears once a reading is closer to the *other* leg than
      // to the one the walker is actually on, which is the ordinary condition,
      // not the exotic one.
      const NOISE_DEG = 0.00004
      const walk = (anchored) => {
        const seen = []
        let anchor = null
        for (let d = 0; d <= total; d += 20) {
          const p = pointAtDistance(OUT_AND_BACK, d, loopCum)
          const at = locateOnRoute(
            [p.lon, p.lat + NOISE_DEG], OUT_AND_BACK, loopCum, anchored ? anchor : null,
          )
          anchor = at.alongM
          seen.push(at.alongM)
        }
        return seen
      }

      const seen = walk(true)
      for (let i = 1; i < seen.length; i += 1) {
        expect(seen[i], `went backwards at step ${i}`).toBeGreaterThanOrEqual(seen[i - 1] - 1)
      }
      // The walk stops at the last whole 20 m step, not exactly at the end.
      expect(seen[seen.length - 1]).toBeGreaterThan(total - 25)

      // And the same walk unanchored does go backwards — so this test is
      // measuring the anchor rather than the geometry being easy.
      const unanchored = walk(false)
      const jumped = unanchored.some((v, i) => i > 0 && v < unanchored[i - 1] - 1)
      expect(jumped, 'the unanchored walk should read backwards').toBe(true)
    })

    it('relocks when the position is genuinely nowhere near the anchor', () => {
      // Someone who left the route and rejoined it further on must not be held
      // to a stale anchor — that would be the mirror of the bug being fixed.
      const far = pointAtDistance(OUT_AND_BACK, total * 0.75, loopCum)
      const at = locateOnRoute([far.lon, far.lat], OUT_AND_BACK, loopCum, 0)
      expect(at.alongM).toBeCloseTo(total * 0.75, 0)
    })
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

describe('projectPointOnRoute', () => {
  it('projects perpendicularly rather than snapping to the nearest vertex', () => {
    // Standing exactly on the line, halfway along a segment whose endpoints are
    // 111 m apart. The nearest VERTEX is 55.6 m away; the nearest point on the
    // LINE is zero away, and only one of those two answers is the distance from
    // the line.
    const at = projectPointOnRoute([0.0005, 0], LINE)
    expect(at.offRouteM).toBeCloseTo(0, 5)
    expect(at.alongM).toBeCloseTo(55.60, 1)
    expect(at.index).toBe(0)
  })

  it('measures perpendicular offset for a point beside the line', () => {
    const at = projectPointOnRoute([0.0005, 0.0001], LINE)
    expect(at.offRouteM).toBeCloseTo(11.13, 1)
  })

  it('returns null for geometry with no shape', () => {
    expect(projectPointOnRoute([0, 0], [])).toBeNull()
    expect(projectPointOnRoute([0, 0], [[0, 0]])).toBeNull()
  })
})

describe('barriersAheadOnRoute', () => {
  // Replaces the suite for `barriersWithin`, which this change deleted. That
  // function took a plain haversine radius with no projection and no direction
  // test, so a barrier the walker had already passed stayed inside the circle
  // for another 200 m and the sheet went on calling it "ahead". The old suite
  // could not have caught that: it only ever asked the question from a standing
  // start, where behind and ahead are the same thing.
  const cum = cumulativeDistances(LINE)
  const blockers = [
    { type: 'steps', lat: 0, lon: 0.0005, description: 'Three steps' }, // 55.6 m along
    { type: 'kerb', lat: 0, lon: 0.0025, description: 'High kerb' }, // 278.0 m along
  ]

  it('reports distance along the route, not the straight line', () => {
    const found = barriersAheadOnRoute(blockers, LINE, cum, 0, 200)
    expect(found).toHaveLength(1)
    expect(found[0].blocker.type).toBe('steps')
    expect(found[0].aheadM).toBeCloseTo(55.60, 1)
  })

  it('drops a barrier once it is behind the walker', () => {
    // Standing at 120 m, so the steps at 55.6 m are 64 m BEHIND. A radius test
    // still has them well inside 200 m; this one does not.
    const found = barriersAheadOnRoute(blockers, LINE, cum, 120, 200)
    expect(found.map((f) => f.blocker.type)).toEqual(['kerb'])
    expect(found[0].aheadM).toBeCloseTo(158.0, 0)
  })

  it('keeps a barrier a few metres behind, so the warning does not flicker', () => {
    // A barrier you are standing at projects either side of your own match
    // depending on GPS noise. Losing it at that exact moment is the one moment
    // it matters.
    const found = barriersAheadOnRoute(blockers, LINE, cum, 60, 200)
    expect(found.map((f) => f.blocker.type)).toContain('steps')
    expect(barriersAheadOnRoute(blockers, LINE, cum, 80, 200).map((f) => f.blocker.type)).not.toContain(
      'steps',
    )
  })

  it('drops a barrier still further ahead than the radius', () => {
    expect(barriersAheadOnRoute(blockers, LINE, cum, 0, 100).map((f) => f.blocker.type)).toEqual([
      'steps',
    ])
  })

  it('handles a route with no barriers and geometry with no shape', () => {
    expect(barriersAheadOnRoute([], LINE, cum, 0)).toEqual([])
    expect(barriersAheadOnRoute(undefined, LINE, cum, 0)).toEqual([])
    expect(barriersAheadOnRoute(blockers, [], undefined, 0)).toEqual([])
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
