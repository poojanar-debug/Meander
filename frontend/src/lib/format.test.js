import { describe, expect, it } from 'vitest'

import {
  announceRoutes,
  announceSelection,
  durationParts,
  fmtDur,
  fmtDurSpoken,
  restStopSentence,
} from './format.js'
import { METRIC_24 } from './units.js'

const IMPERIAL = { distance: 'imperial', clock: '12' }

const route = {
  id: 'nature',
  label: 'The green way',
  status: 'ok',
  duration_min: 26,
  distance_m: 2400,
  confidence: 0.8,
  scoring_method: 'clip',
}

describe('the live region carries the chosen unit', () => {
  // Rule 4: the route list is a complete text substitute for the map. That has
  // to hold for someone listening to it, not just someone looking at it — so a
  // screen-reader user who chose miles must hear miles.
  // "mi" is a substring of "minutes", which this sentence also contains, so
  // every assertion here is anchored on a word boundary.
  const MILES = /\d\s?mi\b/
  const KM = /\d\s?km\b/

  it('announces routes in miles when miles were chosen', () => {
    const spoken = announceRoutes([route], IMPERIAL)
    expect(spoken).toMatch(MILES)
    expect(spoken).not.toMatch(KM)
  })

  it('announces routes in kilometres by default', () => {
    const spoken = announceRoutes([route], METRIC_24)
    expect(spoken).toContain('2.4 km')
    expect(spoken).not.toMatch(MILES)
  })

  it('announces a selection in the chosen unit', () => {
    expect(announceSelection(route, IMPERIAL)).toMatch(MILES)
    expect(announceSelection(route, METRIC_24)).toContain('2.4 km')
  })
})

describe('rest stops are described in the chosen unit', () => {
  it('threads units into the sentence', () => {
    const stops = [{ type: 'bench', at_m: 340 }]
    expect(restStopSentence(stops, METRIC_24)).toContain('340 m')
    expect(restStopSentence(stops, IMPERIAL)).toMatch(/0\.2 mi\b/)
  })

  it('speaks feet for a stop inside the first 160 m', () => {
    const stops = [{ type: 'bench', at_m: 100 }]
    expect(restStopSentence(stops, IMPERIAL)).toContain('330 ft')
  })

  it('still says so plainly when there are none', () => {
    expect(restStopSentence([], IMPERIAL)).toBe('No rest stops found along this route.')
  })
})

describe('durations are identical in both systems', () => {
  // An hour is an hour. The risk here is not that this breaks — it is that
  // someone threading units through 24 call sites threads it through three
  // more that should never have had it.
  const minutes = [0, 1, 19, 20, 59, 60, 61, 90, 120, 359, 360]

  it.each(minutes)('renders %i minutes the same however it is called', (m) => {
    expect(fmtDur(m)).toBe(fmtDur(m, IMPERIAL))
    expect(fmtDurSpoken(m)).toBe(fmtDurSpoken(m, IMPERIAL))
    expect(durationParts(m)).toEqual(durationParts(m, IMPERIAL))
  })

  it('has not grown a second parameter', () => {
    expect(fmtDur.length).toBe(1)
    expect(fmtDurSpoken.length).toBe(1)
    expect(durationParts.length).toBe(1)
  })
})
