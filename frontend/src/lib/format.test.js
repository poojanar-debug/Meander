import { describe, expect, it } from 'vitest'

import {
  announceRoutes,
  announceSelection,
  BIKE_MAX_STRAIGHT_M,
  confidenceSentence,
  deriveModeForDistance,
  FOOT_MAX_STRAIGHT_M,
  durationParts,
  effectiveMode,
  fmtDur,
  fmtDurSpoken,
  restStopSentence,
  verificationTier,
} from './format.js'
import { METRIC_24 } from './units.js'

const IMPERIAL = { distance: 'imperial', clock: '12' }

const route = {
  id: 'scenic',
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

describe('unknown coverage is not zero coverage', () => {
  // Rule 1, at the one place it is easiest to lose: `null < 0.3` is true in
  // JavaScript, so an unknown coverage used to fall straight through the
  // numeric ladder and render as "covers only 0%" — a measurement claim about a
  // route nobody measured. models.py declares `confidence: float`, so this is
  // the defensive path, which is exactly why nothing else was watching it.
  const UNKNOWN = [
    ['null', null],
    ['undefined', undefined],
    ['NaN', Number.NaN],
    ['a numeric string', '0.8'],
  ]

  it.each(UNKNOWN)('says so, rather than 0%%, for %s', (_name, value) => {
    const { text, severity } = confidenceSentence(value, 'clip')
    expect(text).not.toMatch(/\d+%/)
    expect(text).toMatch(/unknown/i)
    expect(severity).toBe('warning')
  })

  it.each(UNKNOWN)('fills no segment and says "Not measured" for %s', (_name, value) => {
    expect(verificationTier(value, 'clip')).toEqual({
      filled: 0,
      word: 'Not measured',
      tone: 'warn',
    })
  })

  it('still reports a real, measured zero as zero', () => {
    // The other half of the distinction, and the one a fix like this can
    // quietly break: 0 is a measurement. It has to keep reading as one.
    const { text, severity } = confidenceSentence(0, 'clip')
    expect(text).toContain('0%')
    expect(severity).toBe('warning')
    expect(verificationTier(0, 'clip')).toMatchObject({ filled: 1, word: 'Barely verified' })
  })

  it('leaves every measured tier exactly as it was', () => {
    expect(confidenceSentence(0.2, 'clip').text).toContain('20%')
    expect(confidenceSentence(0.44, 'clip').severity).toBe('caution')
    expect(confidenceSentence(0.88, 'clip').severity).toBe('ok')
    expect(verificationTier(0.44, 'clip')).toMatchObject({ filled: 2 })
    expect(verificationTier(0.88, 'clip')).toMatchObject({ filled: 4 })
  })

  it.each(UNKNOWN)('keeps the server’s wording but not its severity, for %s', (_name, value) => {
    // serverNote wins on the text — that is the whole point of it — but a
    // missing coverage figure must not read as 'ok' underneath it.
    //
    // All four forms, not just null, and that is not thoroughness for its own
    // sake: the unknown branch below hard-codes its own severity, so the guard
    // in the ternary is load-bearing *only* on this path. With null it is a
    // no-op, because `null < 0.3` is true by coercion. With undefined, NaN or a
    // string, every comparison is false and the severity falls through to 'ok'
    // — a confident-looking sentence about a route with no coverage figure.
    const { text, severity } = confidenceSentence(value, 'clip', 'Checked on foot last Tuesday.')
    expect(text).toBe('Checked on foot last Tuesday.')
    expect(severity).toBe('warning')
  })

  it('carries the distinction into the live region', () => {
    const route = {
      id: 'scenic',
      label: 'The green way',
      status: 'ok',
      duration_min: 26,
      distance_m: 2400,
      confidence: null,
      scoring_method: 'clip',
    }
    const spoken = announceSelection(route, METRIC_24)
    expect(spoken).not.toMatch(/\d+%/)
    expect(spoken).toMatch(/unknown/i)
  })
})

describe('the auto-mode ladder', () => {
  it('reads the time budget for a loop', () => {
    expect(effectiveMode('auto', 30, null)).toBe('foot')
    expect(effectiveMode('auto', 60, null)).toBe('bike')
    expect(effectiveMode('auto', 300, null)).toBe('car')
  })

  it('reads the straight-line distance once there is a destination', () => {
    // The defect the distance ladder exists for: the dial used to pick the mode
    // for a journey whose length it cannot change, so leaving it at its
    // 35-minute default called a 40 km drive a walk, and nudging it to 46
    // turned the same trip into a bike ride without the destination moving.
    expect(effectiveMode('auto', 35, 1_000)).toBe('foot')
    expect(effectiveMode('auto', 35, 40_000)).toBe('car')
    expect(effectiveMode('auto', 360, 1_000)).toBe('foot')
  })

  it('lets an explicit mode win over either ladder', () => {
    expect(effectiveMode('foot', 300, 40_000)).toBe('foot')
    expect(effectiveMode('car', 20, 100)).toBe('car')
  })

  it('agrees with the backend on where the rungs fall', () => {
    // backend/models.py derives these from the loop speeds over the minute
    // rungs. If the two drift, the UI names one mode and the router uses
    // another — which is why both sides carry the derivation, not the number.
    expect(FOOT_MAX_STRAIGHT_M).toBeCloseTo((75 * 45) / 1.3, 6)
    expect(BIKE_MAX_STRAIGHT_M).toBeCloseTo((220 * 120) / 1.3, 6)
    expect(deriveModeForDistance(FOOT_MAX_STRAIGHT_M)).toBe('foot')
    expect(deriveModeForDistance(FOOT_MAX_STRAIGHT_M + 1)).toBe('bike')
    expect(deriveModeForDistance(BIKE_MAX_STRAIGHT_M)).toBe('bike')
    expect(deriveModeForDistance(BIKE_MAX_STRAIGHT_M + 1)).toBe('car')
  })
})
