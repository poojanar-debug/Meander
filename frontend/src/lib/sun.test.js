import { describe, expect, it } from 'vitest'

import {
  daylightGuard,
  daylightSentence,
  minutesToFinishBySunset,
  sunTimes,
} from './sun.js'

/** Minutes between two Dates, signed. */
const diffMin = (a, b) => (a - b) / 60000

describe('sunTimes', () => {
  it('lands within a few minutes of published times for London at the equinox', () => {
    // 2026-03-20, London (51.5074 N, 0.1278 W). Published: 06:01 / 18:12 UTC.
    // Five minutes is the honest tolerance for the short-form algorithm, and it
    // is the right precision for "will I finish after dark". Tightening this
    // test would mean claiming accuracy the maths does not have.
    const times = sunTimes(new Date('2026-03-20T12:00:00Z'), 51.5074, -0.1278)
    expect(times.polar).toBeNull()
    expect(Math.abs(diffMin(times.sunrise, new Date('2026-03-20T06:01:00Z')))).toBeLessThan(5)
    expect(Math.abs(diffMin(times.sunset, new Date('2026-03-20T18:12:00Z')))).toBeLessThan(5)
  })

  it('matches published sunrise and sunset near the equator, where the day barely varies', () => {
    // Colombo (6.9271 N, 79.8612 E) — one of the app's demo locations.
    const june = sunTimes(new Date('2026-06-21T06:00:00Z'), 6.9271, 79.8612)
    const december = sunTimes(new Date('2026-12-21T06:00:00Z'), 6.9271, 79.8612)
    const juneLength = diffMin(june.sunset, june.sunrise)
    const decemberLength = diffMin(december.sunset, december.sunrise)
    // Within a degree of the equator the year's longest and shortest days are
    // under an hour apart.
    expect(Math.abs(juneLength - decemberLength)).toBeLessThan(60)
    expect(juneLength).toBeGreaterThan(11 * 60)
    expect(juneLength).toBeLessThan(13 * 60)
  })

  it('puts civil dawn before sunrise and civil dusk after sunset', () => {
    const t = sunTimes(new Date('2026-03-20T12:00:00Z'), 51.5074, -0.1278)
    expect(t.dawn.valueOf()).toBeLessThan(t.sunrise.valueOf())
    expect(t.dusk.valueOf()).toBeGreaterThan(t.sunset.valueOf())
  })

  // The two cases the handoff says must be handled rather than crashed through.

  it('reports polar day above the Arctic circle at midsummer, and never a time', () => {
    // Tromsø, 69.65 N, at the summer solstice: the sun does not set.
    const t = sunTimes(new Date('2026-06-21T12:00:00Z'), 69.6496, 18.956)
    expect(t.polar).toBe('day')
    expect(t.sunrise).toBeNull()
    expect(t.sunset).toBeNull()
    expect(daylightSentence(t)).toBe('The sun does not set here today.')
  })

  it('reports polar night above the Arctic circle at midwinter, and never a time', () => {
    const t = sunTimes(new Date('2026-12-21T12:00:00Z'), 69.6496, 18.956)
    expect(t.polar).toBe('night')
    expect(t.sunrise).toBeNull()
    expect(t.sunset).toBeNull()
    expect(daylightSentence(t)).toBe('The sun does not rise here today.')
  })

  it('reports polar day in the southern hemisphere too, at the opposite solstice', () => {
    // McMurdo, 77.85 S. December is its midnight sun.
    const t = sunTimes(new Date('2026-12-21T12:00:00Z'), -77.8419, 166.6863)
    expect(t.polar).toBe('day')
  })

  it('returns null rather than guessing when the inputs cannot support a calculation', () => {
    expect(sunTimes(new Date('nonsense'), 51, 0)).toBeNull()
    expect(sunTimes(new Date(), null, 0)).toBeNull()
    expect(sunTimes(new Date(), 51, undefined)).toBeNull()
    expect(sunTimes(new Date(), 200, 0)).toBeNull()
    expect(sunTimes(new Date(), 51, 999)).toBeNull()
    expect(daylightSentence(null)).toBeNull()
  })
})

describe('daylightGuard', () => {
  const LAT = 51.5074
  const LON = -0.1278
  // London on 2026-03-20: sunrise 06:01, sunset 18:12 UTC.
  const at = (iso) => new Date(iso)

  it('says nothing about a route that runs entirely in daylight', () => {
    expect(
      daylightGuard({
        start: at('2026-03-20T10:00:00Z'),
        end: at('2026-03-20T11:00:00Z'),
        lat: LAT,
        lon: LON,
      }),
    ).toBeNull()
  })

  it('warns, with the real number of minutes, when a route finishes after sunset', () => {
    const guard = daylightGuard({
      start: at('2026-03-20T17:50:00Z'),
      end: at('2026-03-20T18:37:00Z'),
      lat: LAT,
      lon: LON,
    })
    expect(guard.text).toMatch(/finishes about 2[0-9] minutes after sunset/)
    expect(guard.action).toBe('shorten')
  })

  it('warns when a route starts before sunrise', () => {
    const guard = daylightGuard({
      start: at('2026-03-20T05:41:00Z'),
      end: at('2026-03-20T06:30:00Z'),
      lat: LAT,
      lon: LON,
    })
    expect(guard.text).toMatch(/before sunrise/)
    expect(guard.action).toBe('sunrise')
  })

  it('escalates past sunset to "well after dark" once civil dusk has gone', () => {
    const guard = daylightGuard({
      start: at('2026-03-20T18:00:00Z'),
      end: at('2026-03-20T19:30:00Z'),
      lat: LAT,
      lon: LON,
    })
    expect(guard.text).toBe('This route finishes well after dark.')
  })

  it('fires exactly one warning, the more severe, when both ends are dark', () => {
    const guard = daylightGuard({
      start: at('2026-03-20T05:00:00Z'),
      end: at('2026-03-20T20:00:00Z'),
      lat: LAT,
      lon: LON,
    })
    expect(guard.text).toBe('This route finishes well after dark.')
  })

  it('measures a route that crosses midnight against the day it ends in', () => {
    // Starts 23:30 on the 20th, ends 00:30 on the 21st — entirely in darkness.
    // The end falls on a calendar day whose sunset is eighteen hours in its
    // future, so a naive `end > sunset` comparison finds nothing wrong with it.
    // This test caught exactly that and is why lightAt() tests both boundaries
    // of the end moment's own day.
    const guard = daylightGuard({
      start: at('2026-03-20T23:30:00Z'),
      end: at('2026-03-21T00:30:00Z'),
      lat: LAT,
      lon: LON,
    })
    expect(guard).not.toBeNull()
    expect(guard.text).not.toMatch(/\d{3,} minutes/)
  })

  it('says nothing at all when the sun never sets — that is not a warning', () => {
    expect(
      daylightGuard({
        start: at('2026-06-21T22:00:00Z'),
        end: at('2026-06-21T23:00:00Z'),
        lat: 69.6496,
        lon: 18.956,
      }),
    ).toBeNull()
  })

  it('warns for the whole route during polar night', () => {
    const guard = daylightGuard({
      start: at('2026-12-21T10:00:00Z'),
      end: at('2026-12-21T11:00:00Z'),
      lat: 69.6496,
      lon: 18.956,
    })
    expect(guard.text).toMatch(/does not rise/)
  })

  it('returns null rather than guessing when coordinates are missing', () => {
    expect(
      daylightGuard({ start: at('2026-03-20T10:00:00Z'), end: at('2026-03-20T11:00:00Z') }),
    ).toBeNull()
  })
})

describe('minutesToFinishBySunset', () => {
  it('floors to the 5-minute step, so the answer really does finish before sunset', () => {
    const start = new Date('2026-03-20T17:00:00Z')
    const sunset = new Date('2026-03-20T18:12:00Z')
    // 72 minutes available -> 70, not 75.
    expect(minutesToFinishBySunset(start, sunset)).toBe(70)
  })

  it('offers nothing when there is not enough light left for the shortest walk', () => {
    const start = new Date('2026-03-20T18:00:00Z')
    const sunset = new Date('2026-03-20T18:12:00Z')
    expect(minutesToFinishBySunset(start, sunset)).toBeNull()
  })

  it('offers nothing when sunset has already passed', () => {
    expect(
      minutesToFinishBySunset(new Date('2026-03-20T19:00:00Z'), new Date('2026-03-20T18:12:00Z')),
    ).toBeNull()
  })
})
