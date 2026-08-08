/**
 * Sunrise, sunset, civil dawn and civil dusk — computed here, in the browser.
 *
 * NOAA's solar-position algorithm in its short form. It lands within a few
 * minutes of published almanac times — the right precision for "will I finish
 * this walk after dark", and not the right precision for anything astronomical.
 * The tests say five minutes because that is what it delivers; claiming better
 * would be claiming accuracy the maths does not have.
 *
 * **It makes no network request.** Adding one would mean sending the user's
 * coordinates somewhere to ask what time it gets dark, and this app promises
 * their coordinates answer one routing request and are then discarded.
 *
 * Two rules run through every function here:
 *
 *   1. **Never fabricate a time.** Above the Arctic circle and below the
 *      Antarctic there are dates with no sunrise or no sunset at all. Those
 *      return `polar: 'day' | 'night'` and null times, and the UI says the sun
 *      does not set here today. Falling back to a default would be a lie told
 *      to someone deciding whether to walk home in the dark.
 *   2. **A failed calculation renders nothing**, not a warning and not a guess.
 *      An unknown daylight window is silence, not a caution.
 */

import { METRIC_24, fmtClockIn } from './units.js'

const RAD = Math.PI / 180
const OBLIQUITY = 23.4397

/** Altitude of the sun's centre at sunrise/sunset, allowing for refraction and
 *  the solar disc's radius. */
const ALTITUDE_SUNRISE = -0.833
/** Civil twilight: enough light to read outside without artificial lighting. */
const ALTITUDE_CIVIL = -6

const J1970 = 2440588
const J2000 = 2451545

const toJulian = (date) => date.valueOf() / 86400000 - 0.5 + J1970
const fromJulian = (julian) => new Date((julian + 0.5 - J1970) * 86400000)

/**
 * Solve for the two moments the sun crosses `altitude` on the day containing
 * `date`, at `lat`/`lon`.
 *
 * Returns `{ rise, set }` as Dates, or a polar marker when the sun does not
 * cross that altitude at all on that date.
 */
function crossing(date, lat, lon, altitude) {
  // Mean solar time, in whole days since 2000, corrected for longitude. The
  // formulation counts longitude positive *west*, which is the opposite of the
  // east-positive coordinates the rest of the app uses.
  //
  // Both signs below were inverted in the first version of this file, and the
  // tests did not catch it: a longitude error shifts sunrise and sunset by the
  // same amount, so day *length* stays right and only the absolute clock times
  // are wrong. The equator test compared lengths and passed; London passed
  // because its longitude is 0.13°, where the error is fifteen seconds. It took
  // a Colombo route reporting "Daylight today: 16:44 – 05:08" to show it.
  // There is now a test that pins absolute times at a longitude far from
  // Greenwich.
  const west = -lon
  const n = Math.round(toJulian(date) - J2000 - 0.0009 - west / 360)
  const meanSolar = J2000 + 0.0009 + west / 360 + n

  // Solar mean anomaly, and the equation of the centre that corrects the
  // circular-orbit assumption to the real ellipse.
  const M = (357.5291 + 0.98560028 * (meanSolar - J2000)) % 360
  const C = 1.9148 * Math.sin(M * RAD) + 0.02 * Math.sin(2 * M * RAD) + 0.0003 * Math.sin(3 * M * RAD)
  const lambda = (M + C + 180 + 102.9372) % 360

  const transit = meanSolar + 0.0053 * Math.sin(M * RAD) - 0.0069 * Math.sin(2 * lambda * RAD)
  const declination = Math.asin(Math.sin(lambda * RAD) * Math.sin(OBLIQUITY * RAD))

  const cosHourAngle =
    (Math.sin(altitude * RAD) - Math.sin(lat * RAD) * Math.sin(declination)) /
    (Math.cos(lat * RAD) * Math.cos(declination))

  // No solution: the sun never reaches this altitude on this date. Which side
  // it failed on is the difference between midnight sun and polar night, and
  // the two need opposite sentences, so they are distinguished rather than
  // collapsed into "unknown".
  if (cosHourAngle > 1) return { polar: 'night' }
  if (cosHourAngle < -1) return { polar: 'day' }

  const hourAngle = Math.acos(cosHourAngle) / RAD
  return {
    rise: fromJulian(transit - hourAngle / 360),
    set: fromJulian(transit + hourAngle / 360),
  }
}

/**
 * The day's light for one place.
 *
 * `polar` is `'day'` when the sun does not set, `'night'` when it does not
 * rise, and `null` on an ordinary day. Returns `null` — not a partial object —
 * when the inputs cannot support a calculation at all, because the caller's
 * contract is "render nothing rather than guess".
 */
export function sunTimes(date, lat, lon) {
  if (
    !(date instanceof Date) ||
    Number.isNaN(date.valueOf()) ||
    typeof lat !== 'number' ||
    typeof lon !== 'number' ||
    Number.isNaN(lat) ||
    Number.isNaN(lon) ||
    Math.abs(lat) > 90 ||
    Math.abs(lon) > 180
  ) {
    return null
  }

  try {
    const day = crossing(date, lat, lon, ALTITUDE_SUNRISE)
    const civil = crossing(date, lat, lon, ALTITUDE_CIVIL)

    if (day.polar) {
      return { sunrise: null, sunset: null, dawn: null, dusk: null, polar: day.polar }
    }
    return {
      sunrise: day.rise,
      sunset: day.set,
      // Civil twilight can be absent while sunrise is not, at high latitudes
      // near the solstice. That is a real answer, not a failure.
      dawn: civil.polar ? null : civil.rise,
      dusk: civil.polar ? null : civil.set,
      polar: null,
    }
  } catch {
    return null
  }
}

/**
 * Whether a clock time for this longitude can honestly be printed on this
 * browser's clock.
 *
 * Everything above works in absolute instants and is correct anywhere. Turning
 * an instant into "18:24" is not: `Intl` formats in the *viewer's* timezone, and
 * a viewer looking at a route in Colombo from California is shown Californian
 * clock times for a Sri Lankan sunset. The demo made this obvious — the daylight
 * line read "16:44 – 05:08", which is not a day.
 *
 * A place's civil timezone cannot be derived from coordinates without a tz
 * database, which would be a large dependency for one line of copy. What *can*
 * be derived is solar offset — longitude / 15 — and comparing that against the
 * browser's own offset says whether the two are talking about the same clock.
 * Three hours of slack covers the genuinely wide zones (China, Spain, Argentina)
 * without admitting a viewer on the other side of the world.
 *
 * When they do not agree the caller renders nothing, which is this module's
 * standing rule: an unknown is silence, not a guess. In the case the app is
 * actually for — someone about to walk out of their own front door — the two
 * always agree.
 */
export function canStateLocalTime(lon, when = new Date()) {
  if (typeof lon !== 'number' || Number.isNaN(lon)) return false
  const solarOffsetHours = lon / 15
  const browserOffsetHours = -when.getTimezoneOffset() / 60
  return Math.abs(solarOffsetHours - browserOffsetHours) <= 3
}

/**
 * "05:58", or "5:58 AM".
 *
 * 24-hour remains the default wherever the locale implies it, which is most of
 * the world and includes en-GB. The objection this comment used to record — a
 * walker reading "6:24" cannot tell dawn from dusk — is answered not by refusing
 * the 12-hour clock but by never emitting it without a meridiem. fmtClockIn
 * guarantees that, and a test asserts it across all 24 hours.
 */
export function fmtClock(date, units = METRIC_24) {
  return fmtClockIn(date, units)
}

/** "Daylight today: 05:58 – 18:24", or the polar sentence, or null. */
export function daylightSentence(times, units = METRIC_24) {
  if (!times) return null
  if (times.polar === 'day') return 'The sun does not set here today.'
  if (times.polar === 'night') return 'The sun does not rise here today.'
  const from = fmtClock(times.sunrise, units)
  const to = fmtClock(times.sunset, units)
  if (!from || !to) return null
  return `Daylight today: ${from} – ${to}.`
}

const MINUTE = 60000
const roundMinutes = (ms) => Math.round(Math.abs(ms) / MINUTE)

/**
 * How light it is at one moment: `light`, `twilight`, or `dark`.
 *
 * Asking "is this moment dark" is not the same as asking "is it later than
 * today's sunset", and the difference is a real bug rather than a nicety. A
 * route from 23:30 to 00:30 ends on the *next* calendar day, whose sunset is
 * eighteen hours in its future — so a naive `end > sunset` comparison finds
 * nothing wrong with a walk that happens entirely in the dark. Testing both
 * boundaries of the end moment's own day handles midnight without special-casing
 * it.
 */
function lightAt(when, lat, lon) {
  const t = sunTimes(when, lat, lon)
  if (!t) return null
  if (t.polar === 'day') return { level: 'light', times: t }
  if (t.polar === 'night') return { level: 'dark', polarNight: true, times: t }

  const afterSunset = when > t.sunset
  const beforeSunrise = when < t.sunrise
  if (!afterSunset && !beforeSunrise) return { level: 'light', times: t }

  const beyondTwilight = afterSunset ? t.dusk && when > t.dusk : t.dawn && when < t.dawn
  return {
    level: beyondTwilight ? 'dark' : 'twilight',
    afterSunset,
    beforeSunrise,
    times: t,
  }
}

/**
 * The one warning a route earns about the light, or `null`.
 *
 * **At most one fires, and the more severe wins.** Ordering, worst first:
 * finishing in full darkness, starting in full darkness, finishing after
 * sunset, starting before sunrise. Full darkness outranks twilight because it
 * is a different kind of walk; and finishing in the dark outranks starting in
 * it, because at the end you are as far from where you began as the route ever
 * takes you.
 */
export function daylightGuard({ start, end, lat, lon, units = METRIC_24 }) {
  if (!(start instanceof Date) || !(end instanceof Date)) return null

  const from = lightAt(start, lat, lon)
  const to = lightAt(end, lat, lon)
  if (!from || !to) return null

  if (from.polarNight || to.polarNight) {
    return {
      severity: 5,
      text: 'The sun does not rise here today — the whole route will be in the dark.',
      action: null,
    }
  }

  // The sun never setting is not a warning. It is the opposite of one.
  if (from.level === 'light' && to.level === 'light') return null

  if (to.level === 'dark') {
    return { severity: 4, text: 'This route finishes well after dark.', action: 'shorten' }
  }
  if (from.level === 'dark') {
    return { severity: 3, text: 'This route starts well before first light.', action: 'sunrise' }
  }
  if (to.level === 'twilight' && to.afterSunset) {
    const mins = roundMinutes(end - to.times.sunset)
    return {
      severity: 2,
      text: `This route finishes about ${mins} minute${mins === 1 ? '' : 's'} after sunset (${fmtClock(to.times.sunset, units)} today).`,
      action: 'shorten',
    }
  }
  if (from.level === 'twilight' && from.beforeSunrise) {
    const mins = roundMinutes(from.times.sunrise - start)
    return {
      severity: 1,
      text: `This route starts about ${mins} minute${mins === 1 ? '' : 's'} before sunrise (${fmtClock(from.times.sunrise, units)} today) — the first stretch will be in the dark.`,
      action: 'sunrise',
    }
  }
  // Finishing during the dawn twilight means walking into the light, which is
  // not something to warn about.
  return null
}

/** Whether a moment falls inside the daylight window, for the hour chips. Any
 *  moment we cannot resolve is treated as daylight, so an unknown never renders
 *  as a warning. */
export function isDaylight(when, lat, lon) {
  const at = lightAt(when, lat, lon)
  return at ? at.level === 'light' : true
}

/**
 * The largest 5-minute duration that still finishes before sunset, or `null`
 * if no walk short enough is worth offering.
 *
 * Floors to the step rather than rounding: rounding up would hand back a
 * duration that finishes after sunset, which is the thing being fixed.
 */
export function minutesToFinishBySunset(start, sunset, { min = 20, step = 5 } = {}) {
  if (!(start instanceof Date) || !(sunset instanceof Date)) return null
  const available = Math.floor((sunset - start) / MINUTE / step) * step
  return available >= min ? available : null
}
