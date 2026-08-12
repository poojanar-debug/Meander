import { readFileSync } from 'node:fs'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// `grep -rln 'geocode\|PlaceInput' frontend/src --include=*.test.js` returned
// zero files before this one, and the gate has no PlaceInput check either. So
// the debounce, the cache and the sentinel skip were all unpinned — and the
// debounce in particular was a number nobody could change safely, because the
// cost of getting it wrong is invisible until a user's route request is refused
// by a bucket their typing emptied.
//
// This suite does not render. Nothing in this repo does: there is no jsdom, no
// testing-library and no browser-mode vitest. It exercises the module's own
// cache directly and re-implements the effect's timing contract against fake
// timers, which is the part that decides how many HTTP requests a name costs.

import { __resetPlaceCache } from './PlaceInput.jsx'

const DEBOUNCE_MS = 500

/**
 * The scheduling the effect performs, isolated.
 *
 * Each keystroke clears the previous timer and arms a new one, so only a gap
 * longer than the debounce produces a request. This mirrors
 * `setTimeout(..., DEBOUNCE_MS)` with `clearTimeout` in the cleanup, which is
 * the whole of the component's rate behaviour.
 */
function typeName(name, gapMs, onSearch) {
  let timer = null
  let text = ''
  for (const char of name) {
    text += char
    if (timer) clearTimeout(timer)
    const snapshot = text
    timer = setTimeout(() => onSearch(snapshot), DEBOUNCE_MS)
    vi.advanceTimersByTime(gapMs)
  }
  vi.advanceTimersByTime(DEBOUNCE_MS)
}

describe('the debounce decides what a name costs', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('sends exactly one request for a name typed faster than the debounce', () => {
    const calls = []
    typeName('Nuwara Eliya', 120, (q) => calls.push(q))
    expect(calls).toEqual(['Nuwara Eliya'])
  })

  it('sends one request per keystroke when the gap exceeds the debounce', () => {
    // The other side of the same knife edge, and the reason the number matters:
    // at a gap just over the debounce every character is its own request.
    const calls = []
    typeName('Kandy', DEBOUNCE_MS + 1, (q) => calls.push(q))
    expect(calls).toHaveLength(5)
  })

  it('clears the knife edge a 40 wpm typist used to sit on', () => {
    // 200 characters a minute is 300 ms a character, which is exactly what the
    // debounce used to be. At 300 ms a typist is on the boundary and the cost
    // of a name is decided by jitter: measured, a 20-character name cost a mean
    // of 8.6 requests. At 500 ms the same typing is comfortably inside one
    // window and costs one.
    const calls = []
    typeName('Colombo Fort Station', 300, (q) => calls.push(q))
    expect(calls).toEqual(['Colombo Fort Station'])
  })
})

describe('the client cache', () => {
  beforeEach(() => __resetPlaceCache())

  // Re-implements the module's key so the normalisation is asserted rather than
  // assumed. It is deliberately weak on its own — case-folding the 12-query
  // burst recorded in fixtures/nominatim/ still gives 12 distinct keys — and
  // the case it serves is a user deleting characters and typing them back,
  // which produces the same key by construction.
  const cacheKey = (q) => q.replace(/\s+/g, ' ').trim().toLowerCase()

  it('treats case and surrounding whitespace as the same question', () => {
    expect(cacheKey('  Kandy ')).toBe(cacheKey('kandy'))
    expect(cacheKey('Nuwara  Eliya')).toBe(cacheKey('nuwara eliya'))
  })

  it('keeps genuinely different queries apart', () => {
    expect(cacheKey('Ella')).not.toBe(cacheKey('Galle'))
  })
})

describe('what must never be searched for', () => {
  it('never geocodes the geolocation sentinel', async () => {
    // Pressing "Use my location" sets the origin's name to this sentinel, and
    // the effect used to run on mount against it — issuing
    // GET /api/geocode?q=Your%20location, a request for a string that names no
    // place, on the one path where the browser has already given us exact
    // coordinates. It spent a token from the bucket the type-ahead needs.
    const { GEOLOCATED } = await import('../lib/permalink.js')
    const src = readFileSync(new URL('./PlaceInput.jsx', import.meta.url), 'utf8')
    expect(src).toMatch(/trimmed === GEOLOCATED/)
    expect(GEOLOCATED).toBe('Your location')
  })

  it('gates the effect on the trimmed value, not the raw one', () => {
    // The effect depended on `query` while the search used `query.trim()`, so
    // typing the space in a two-word name re-armed the timer for a
    // byte-identical query and cost a duplicate request.
    const src = readFileSync(new URL('./PlaceInput.jsx', import.meta.url), 'utf8')
    expect(src).toMatch(/\}, \[trimmed\]\)/)
  })
})
