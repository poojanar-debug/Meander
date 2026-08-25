import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { THEME_KEY } from './theme.js'
import {
  METRIC_24,
  UNITS_KEY,
  UNKNOWN,
  clearStoredUnits,
  detectUnits,
  fmtClockIn,
  formatDistance,
  formatElevation,
  initialUnits,
  readStoredUnits,
  storeUnits,
} from './units.js'

const IMPERIAL = { distance: 'imperial', clock: '12' }

// TZ is forced to UTC by vite.config.js, so clock assertions are deterministic.
// The *locale* is not pinned — it resolves to en-US here and on CI runners — so
// anything locale-sensitive is asserted as a pattern rather than a literal.

describe('formatDistance — metric', () => {
  // The pre-port fmtDist, frozen. If this and formatDistance ever disagree, a
  // metric user's output changed, which this port promised would not happen.
  const reference = (metres) => {
    // Moved with the implementation. ⚠ This branch is never executed — the loop
    // below runs `for (let m = 0; m <= 200000; m += 1)` and never passes null —
    // so leaving it stale would not have turned the suite red. It is updated
    // deliberately rather than left for the runner to catch, because a frozen
    // oracle that disagrees with the thing it freezes is worse than no oracle.
    if (metres == null || Number.isNaN(metres)) return UNKNOWN
    if (metres < 1000) return `${Math.round(metres / 10) * 10} m`
    return `${(metres / 1000).toFixed(metres < 10000 ? 1 : 0)} km`
  }

  it('is byte-identical to the pre-port formatter on every metre to 200 km', () => {
    const mismatches = []
    for (let m = 0; m <= 200000; m += 1) {
      if (formatDistance(m, METRIC_24) !== reference(m)) mismatches.push(m)
      if (mismatches.length > 4) break
    }
    expect(mismatches).toEqual([])
  })

  it.each([
    [0, '0 m'],
    [4, '0 m'],
    [5, '10 m'], // Math.round(0.5) rounds up, so the 10 m band starts here
    [9, '10 m'],
    [12, '10 m'],
    [95, '100 m'],
    [999, '1000 m'], // pre-existing, shared by both branches, deliberately not fixed
    [1000, '1.0 km'],
    [9994, '10.0 km'],
    [9999, '10.0 km'],
    [10000, '10 km'],
    [10500, '11 km'],
    [15500, '16 km'],
    [42195, '42 km'],
  ])('renders %i m as %s so a failure names itself', (metres, expected) => {
    expect(formatDistance(metres, METRIC_24)).toBe(expected)
  })
})

describe('formatDistance — imperial', () => {
  it.each([
    [0, '0 ft'],
    [30.48, '100 ft'],
    [159, '520 ft'], // 10-ft granularity: the router does not know this to the foot
    [160, '0.1 mi'],
    [1609.344, '1.0 mi'],
    [16093.44, '10 mi'],
    [42195, '26 mi'],
  ])('renders %f m as %s', (metres, expected) => {
    expect(formatDistance(metres, IMPERIAL)).toBe(expected)
  })

  it('never goes backwards as the distance grows', () => {
    // Compared in a common base, so the ft -> mi crossover is included. A
    // mis-signed threshold shows up here and nowhere else.
    const M_PER_FOOT = 0.3048
    const M_PER_MILE = 1609.344
    const inFeet = (s) => {
      const n = Number.parseFloat(s)
      return s.endsWith('mi') ? (n * M_PER_MILE) / M_PER_FOOT : n
    }
    let previous = -1
    for (let m = 0; m <= 50000; m += 7) {
      const feet = inFeet(formatDistance(m, IMPERIAL))
      expect(feet, `at ${m} m`).toBeGreaterThanOrEqual(previous - 1e-9)
      previous = feet
    }
  })
})

describe('an unknown distance is never zero', () => {
  // Rule 1. A route with no elevation profile has not been measured as flat,
  // and a missing distance is not a distance of nought.
  it.each([
    ['metric', METRIC_24],
    ['imperial', IMPERIAL],
    // **Changed glyph, unchanged rule — twice now.** The placeholder was an em
    // dash, then briefly an ASCII hyphen while the app was removing em dashes
    // from its prose, and the 2026 redesign put the em dash back by stated
    // rule: "unknown renders as —". Asserting against `UNKNOWN` rather than a
    // literal means this test follows the constant; the glyph decision lives
    // at its declaration in units.js.
    //
    // What is asserted below is the part that matters and never moved: an
    // unknown distance is never rendered as a zero.
  ])('renders null, undefined and NaN as the unknown placeholder in %s', (_name, units) => {
    for (const value of [null, undefined, Number.NaN]) {
      expect(formatDistance(value, units)).toBe(UNKNOWN)
      expect(formatElevation(value, units)).toBe(UNKNOWN)
      expect(formatDistance(value, units)).not.toBe('0 m')
      expect(formatDistance(value, units)).not.toBe('0 ft')
      expect(formatElevation(value, units)).not.toBe('0 m')
      expect(formatElevation(value, units)).not.toBe('0 ft')
    }
  })

  it('still renders a real zero as zero', () => {
    expect(formatDistance(0, METRIC_24)).toBe('0 m')
    expect(formatElevation(0, METRIC_24)).toBe('0 m')
  })
})

describe('formatElevation', () => {
  it('converts a climb to feet when the user reads miles', () => {
    expect(formatElevation(100, METRIC_24)).toBe('100 m')
    expect(formatElevation(100, IMPERIAL)).toBe('328 ft')
  })
})

describe('fmtClockIn', () => {
  const at = (iso) => new Date(iso)

  it('renders a 24-hour time as two digits', () => {
    expect(fmtClockIn(at('2026-08-08T18:05:00Z'), METRIC_24)).toBe('18:05')
  })

  it('renders a 12-hour time with a meridiem and no leading zero', () => {
    const got = fmtClockIn(at('2026-08-08T18:05:00Z'), IMPERIAL)
    expect(got).toMatch(/^6:05\s?(AM|PM|am|pm|a\.m\.|p\.m\.)$/i)
    expect(got).not.toMatch(/^18/)
  })

  it('renders midnight as 00:00, never 24:00', () => {
    // Some ICU builds emit "24:00" for hour12: false. That is a real hazard and
    // this is the assertion that would catch it.
    expect(fmtClockIn(at('2026-08-08T00:00:00Z'), METRIC_24)).toBe('00:00')
    const twelve = fmtClockIn(at('2026-08-08T00:00:00Z'), IMPERIAL)
    expect(twelve).toContain('12:00')
    expect(twelve).toMatch(/(AM|am|a\.m\.)/i)
  })

  it('renders noon with a meridiem', () => {
    const got = fmtClockIn(at('2026-08-08T12:00:00Z'), IMPERIAL)
    expect(got).toContain('12:00')
    expect(got).toMatch(/(PM|pm|p\.m\.)/i)
  })

  it('never emits a 12-hour time without a meridiem, at any hour', () => {
    // This is the test that keeps the standing objection answered: a walker
    // reading "6:24" cannot tell dawn from dusk. The marker is the answer.
    for (let hour = 0; hour < 24; hour += 1) {
      const iso = `2026-08-08T${String(hour).padStart(2, '0')}:24:00Z`
      expect(fmtClockIn(at(iso), IMPERIAL), `hour ${hour}`).toMatch(
        /(AM|PM|am|pm|a\.m\.|p\.m\.)/i,
      )
    }
  })

  it('returns null for anything that is not a usable Date', () => {
    expect(fmtClockIn(new Date('nope'), METRIC_24)).toBeNull()
    expect(fmtClockIn('2026-01-01', METRIC_24)).toBeNull()
    expect(fmtClockIn(null, METRIC_24)).toBeNull()
  })
})

describe('detectUnits', () => {
  it.each([
    ['en-US', 'imperial'],
    ['en-GB', 'imperial'],
    ['en', 'imperial'], // maximises to US. Documented deliberately: it is a surprise.
    ['my', 'imperial'],
    ['si-LK', 'metric'],
    ['ta-LK', 'metric'],
    ['de-DE', 'metric'],
    ['xx-YY', 'metric'],
  ])('reads %s as %s', (locale, distance) => {
    expect(detectUnits(locale).distance).toBe(distance)
  })

  it('gives the UK miles and a 24-hour clock', () => {
    // The branch this was ported from carries a comment claiming the UK reads
    // "time in 12 hours". ICU disagrees, and ICU is right.
    expect(detectUnits('en-GB')).toMatchObject({ distance: 'imperial', clock: '24' })
  })

  it.each([['en-US', '12'], ['de-DE', '24'], ['si-LK', '24']])(
    'reads the clock for %s as %s hours',
    (locale, clock) => {
      expect(detectUnits(locale).clock).toBe(clock)
    },
  )

  it.each(['!!', '', 'en_US'])('falls back to metric rather than throwing on %s', (locale) => {
    expect(() => detectUnits(locale)).not.toThrow()
    expect(detectUnits(locale).distance).toBe('metric')
  })

  it('never reports a detected default as chosen', () => {
    for (const locale of ['en-US', 'de-DE', '!!', 'my']) {
      expect(detectUnits(locale).chosen).toBe(false)
    }
  })
})

describe('storage', () => {
  let store

  beforeEach(() => {
    store = new Map()
    globalThis.window = {
      localStorage: {
        getItem: (k) => (store.has(k) ? store.get(k) : null),
        setItem: (k, v) => store.set(k, String(v)),
        removeItem: (k) => store.delete(k),
      },
    }
  })
  afterEach(() => {
    delete globalThis.window
  })

  it('reads back nothing when nothing was written', () => {
    expect(readStoredUnits()).toBeNull()
  })

  it.each([
    ['metric', '24'],
    ['metric', '12'],
    ['imperial', '24'],
    ['imperial', '12'],
  ])('round-trips %s / %s and marks it chosen', (distance, clock) => {
    storeUnits({ distance, clock })
    expect(readStoredUnits()).toEqual({ distance, clock, chosen: true })
  })

  it.each([
    ['an unrecognised distance', '{"distance":"furlongs","clock":"12"}'],
    ['a missing distance', '{"clock":"12"}'],
    ['a missing clock', '{"distance":"metric"}'],
    ['not json at all', 'not json'],
    ['a json null', 'null'],
    ['an array', '[]'],
  ])('rejects %s outright rather than half-honouring it', (_name, raw) => {
    store.set(UNITS_KEY, raw)
    expect(readStoredUnits()).toBeNull()
  })

  it('falls back to the locale once the choice is cleared', () => {
    storeUnits({ distance: 'imperial', clock: '12' })
    expect(initialUnits().chosen).toBe(true)
    clearStoredUnits()
    expect(store.has(UNITS_KEY)).toBe(false)
    expect(initialUnits().chosen).toBe(false)
  })

  it('cannot be made to hold a coordinate', () => {
    // Rule 5, asserted against the raw stored string rather than claimed in a
    // comment. Extra fields are dropped by construction, not by convention.
    const shape = /^\{"distance":"(metric|imperial)","clock":"(12|24)"\}$/
    for (const distance of ['metric', 'imperial']) {
      for (const clock of ['12', '24']) {
        storeUnits({ distance, clock })
        expect(store.get(UNITS_KEY)).toMatch(shape)
      }
    }
    storeUnits({ distance: 'metric', clock: '24', lat: 6.9271, lon: 79.8612, chosen: true })
    expect(store.get(UNITS_KEY)).toMatch(shape)
    expect(store.get(UNITS_KEY)).not.toContain('6.9271')
    expect(store.get(UNITS_KEY)).not.toContain('lat')
  })
})

describe('storage that throws — Safari in private mode', () => {
  beforeEach(() => {
    const boom = () => {
      throw new Error('storage disabled')
    }
    globalThis.window = { localStorage: { getItem: boom, setItem: boom, removeItem: boom } }
  })
  afterEach(() => {
    delete globalThis.window
  })

  it('degrades to a tab-lifetime preference instead of taking the app down', () => {
    expect(readStoredUnits()).toBeNull()
    expect(() => storeUnits({ distance: 'imperial', clock: '12' })).not.toThrow()
    expect(() => clearStoredUnits()).not.toThrow()
    const units = initialUnits()
    expect(units.distance).toMatch(/^(metric|imperial)$/)
    expect(units.clock).toMatch(/^(12|24)$/)
  })
})

describe('key discipline', () => {
  it('uses a colon, like the theme key, and does not collide with it', () => {
    // The branch this came from used a dot: 'meander.units'.
    expect(UNITS_KEY).toBe('meander:units')
    expect(THEME_KEY).toBe('meander:theme')
    expect(UNITS_KEY).not.toBe(THEME_KEY)
  })
})
