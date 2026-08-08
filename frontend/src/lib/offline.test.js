import { describe, expect, it } from 'vitest'

import {
  AGEING_MS,
  STALE_MS,
  cacheAgeMs,
  cacheChipText,
  cacheTier,
  cachedNotice,
  departureHasPassed,
  formatCacheAge,
  offlineBarText,
} from './offline.js'

// The labelling contract. A saved route that does not say it is saved, or says
// so quietly when it is six hours old, is worse than no saved route — the
// user acts on it believing it is current.

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const NOW = new Date('2026-08-08T12:00:00Z').valueOf()

describe('cacheAgeMs', () => {
  it('measures from the stamp', () => {
    expect(cacheAgeMs('2026-08-08T11:30:00Z', NOW)).toBe(30 * MINUTE)
  })

  it.each([
    ['missing', null],
    ['empty', ''],
    ['unparseable', 'yesterday'],
    ['undefined', undefined],
  ])('returns null, not zero, for a %s timestamp', (_name, value) => {
    expect(cacheAgeMs(value, NOW)).toBeNull()
    expect(cacheAgeMs(value, NOW)).not.toBe(0)
  })

  it('returns null for a stamp in the future', () => {
    // A clock claiming the answer arrives tomorrow cannot be reasoned about.
    // Zero would render as "just now", which is the most trusting reading of
    // the least trustworthy input.
    expect(cacheAgeMs('2026-08-08T12:30:00Z', NOW)).toBeNull()
  })
})

describe('cacheTier', () => {
  it('is loud when the age is unknown', () => {
    // The single most important line in this file. An entry that cannot say how
    // old it is is the least trustworthy thing on screen, not the most.
    expect(cacheTier(null)).toBe('loud')
  })

  it.each([
    [0, 'quiet'],
    [AGEING_MS - 1, 'quiet'],
    [AGEING_MS, 'amber'],
    [STALE_MS - 1, 'amber'],
    [STALE_MS, 'loud'],
    [48 * HOUR, 'loud'],
  ])('reads %i ms as %s', (age, tier) => {
    expect(cacheTier(age)).toBe(tier)
  })

  it('escalates and never de-escalates as the age grows', () => {
    const rank = { quiet: 0, amber: 1, loud: 2 }
    let previous = 0
    for (let age = 0; age <= 12 * HOUR; age += 5 * MINUTE) {
      const current = rank[cacheTier(age)]
      expect(current).toBeGreaterThanOrEqual(previous)
      previous = current
    }
  })
})

describe('formatCacheAge', () => {
  it.each([
    [null, 'an unknown time ago'],
    [30_000, 'just now'],
    [MINUTE, '1 minute ago'],
    [12 * MINUTE, '12 minutes ago'],
    [HOUR, '1 hour ago'],
    [3 * HOUR, '3 hours ago'],
    [48 * HOUR, '2 days ago'],
  ])('renders %s as "%s"', (age, expected) => {
    expect(formatCacheAge(age)).toBe(expected)
  })

  it('never says "0" of anything', () => {
    for (let age = 0; age <= 3 * HOUR; age += MINUTE) {
      expect(formatCacheAge(age)).not.toMatch(/\b0\b/)
    }
  })
})

describe('cacheChipText', () => {
  it('stays under 20 characters at every age', () => {
    // The rail rows are a uniform height and that is the whole point of the
    // component. A chip that wraps breaks the comparison the rail exists for.
    const ages = [null, 0, MINUTE, 59 * MINUTE, HOUR, 23 * HOUR, 400 * 24 * HOUR]
    for (const age of ages) {
      expect(cacheChipText(age).length, `age ${age}: "${cacheChipText(age)}"`).toBeLessThanOrEqual(
        20,
      )
    }
  })

  it('says so even when the age is unknown', () => {
    expect(cacheChipText(null)).toMatch(/saved/i)
  })
})

describe('cachedNotice', () => {
  it('always has something to say', () => {
    // There is no age at which the right thing to do is say nothing.
    for (const age of [null, 0, MINUTE, AGEING_MS, STALE_MS, 100 * HOUR]) {
      const notice = cachedNotice(age)
      expect(notice.headline, `age ${age}`).toBeTruthy()
      expect(notice.headline.length).toBeGreaterThan(10)
    }
  })

  it('tells an old copy not to be relied on', () => {
    expect(cachedNotice(STALE_MS + HOUR).detail).toMatch(/do not set off|check/i)
  })

  it('admits when it cannot date itself', () => {
    expect(cachedNotice(null).headline).toMatch(/cannot say how old/i)
  })

  it('matches the tier it reports', () => {
    for (const age of [null, MINUTE, AGEING_MS, STALE_MS]) {
      expect(cachedNotice(age).tier).toBe(cacheTier(age))
    }
  })
})

describe('offlineBarText', () => {
  it('says you are offline only when you are', () => {
    expect(offlineBarText(MINUTE, false).headline).toMatch(/offline/i)
    expect(offlineBarText(MINUTE, true).headline).not.toMatch(/offline/i)
  })

  it('always names the age in the headline', () => {
    for (const [age, online] of [
      [MINUTE, true],
      [3 * HOUR, false],
      [null, true],
    ]) {
      expect(offlineBarText(age, online).headline).toMatch(/saved copy/i)
    }
  })

  it('explains that the list is the whole answer without a map', () => {
    // Rule: the route list is a complete text substitute for the map. Offline
    // is the moment that stops being a design principle and starts being load
    // bearing.
    expect(offlineBarText(MINUTE, false).mapDetail).toMatch(/list below/i)
  })
})

describe('departureHasPassed', () => {
  it('is true once the moment has gone by', () => {
    expect(departureHasPassed('2026-08-08T11:59:00Z', NOW)).toBe(true)
  })

  it('is false for a moment still ahead', () => {
    expect(departureHasPassed('2026-08-08T12:01:00Z', NOW)).toBe(false)
  })

  it.each([null, undefined, '', 'nonsense'])('is false rather than throwing for %s', (value) => {
    expect(departureHasPassed(value, NOW)).toBe(false)
  })
})
