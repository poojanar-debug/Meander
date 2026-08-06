/**
 * The vocabulary for a route that came out of the cache instead of the network.
 *
 * This module is the one place that decides how a saved route is described, and
 * it is deliberately pure — no React, no storage, no DOM — so
 * `npm run check:offline` can execute every branch of it directly.
 *
 * **The rule it exists to enforce:** a route served from the cache is never
 * presented as current. Not "quietly a bit older", not "current unless you
 * expand the detail" — labelled, with its age, wherever it appears. That is the
 * same rule `TrustSignal` applies to accessibility coverage, for the same
 * reason, and this follows its shape: the *volume* scales with how bad the
 * situation is, but the *presence* never varies.
 *
 * **An unknown age is the worst case, not the best one.** A missing or
 * unparseable timestamp, or one in the future because the device clock moved,
 * all produce the loudest tier — never a quiet one and never nothing at all. A
 * cache entry that cannot say how old it is is exactly the entry least worth
 * trusting.
 */

/**
 * What actually goes stale, and how fast, is not one number.
 *
 * The shape of a route, its duration and the accessibility assessment come from
 * OSM tagging and a routing graph; those move on a scale of weeks. Air quality,
 * the rest-stop query and the best-departure calculation are measurements of a
 * moment, and they are wrong within hours. So the thresholds are set by the
 * enrichment, which is the part that rots first, rather than by the geometry.
 */
const AGEING_MS = 15 * 60 * 1000 // 15 minutes — air quality is still roughly right
const STALE_MS = 6 * 60 * 60 * 1000 // 6 hours — nothing measured is trustworthy

const MINUTE = 60 * 1000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

/**
 * Age of a cache entry in milliseconds, or `null` when that cannot be
 * established. `null` is not zero and callers must not treat it as fresh.
 */
export function cacheAgeMs(cachedAt, now = Date.now()) {
  if (cachedAt == null) return null
  const then = cachedAt instanceof Date ? cachedAt.getTime() : Date.parse(cachedAt)
  if (Number.isNaN(then)) return null
  const age = now - then
  // A negative age means the clock moved between writing and reading. We cannot
  // say how old the entry is, so we say that rather than rounding it to "now".
  if (age < 0) return null
  return age
}

/** How loudly to say it. Mirrors `trustTier` in format.js on purpose. */
export function cacheTier(ageMs) {
  if (ageMs == null) return 'loud'
  if (ageMs >= STALE_MS) return 'loud'
  if (ageMs >= AGEING_MS) return 'amber'
  return 'quiet'
}

/**
 * The age, in the words a person would use.
 *
 * Rounded, because "47 minutes ago" implies a precision the timestamp does not
 * have once it has been through a service worker and a device clock.
 */
export function formatCacheAge(ageMs) {
  if (ageMs == null) return 'an unknown time ago'
  if (ageMs < MINUTE) return 'less than a minute ago'
  if (ageMs < 90 * MINUTE) {
    const minutes = Math.round(ageMs / MINUTE)
    return minutes <= 1 ? 'a minute ago' : `${minutes} minutes ago`
  }
  if (ageMs < DAY) {
    const hours = Math.round(ageMs / HOUR)
    return hours <= 1 ? 'an hour ago' : `${hours} hours ago`
  }
  const days = Math.round(ageMs / DAY)
  return days <= 1 ? 'a day ago' : `${days} days ago`
}

/** The short form, for the compact row where three routes share one screen. */
export function cacheChipText(ageMs) {
  if (ageMs == null) return 'saved · age unknown'
  if (ageMs < MINUTE) return 'saved just now'
  if (ageMs < HOUR) return `saved ${Math.round(ageMs / MINUTE)}m ago`
  if (ageMs < DAY) return `saved ${Math.round(ageMs / HOUR)}h ago`
  return `saved ${Math.round(ageMs / DAY)}d ago`
}

/**
 * The full statement, tiered.
 *
 * Always returns a headline — there is no input, including a missing timestamp,
 * for which this is allowed to say nothing. `check:offline` asserts that.
 */
export function cachedNotice(ageMs) {
  const tier = cacheTier(ageMs)
  const when = formatCacheAge(ageMs)

  if (ageMs == null) {
    return {
      tier,
      headline: 'Saved copy. Meander cannot tell how old it is.',
      detail:
        'Treat everything here as out of date: the times, the air quality and the best time to leave were all worked out at some point in the past and nothing has been checked since.',
    }
  }

  if (tier === 'loud') {
    return {
      tier,
      headline: `Saved copy from ${when}.`,
      detail:
        'Only the shape of the route still holds. Air quality, rest stops and the best time to leave are all out of date, and anything that has changed on the ground since is not in it.',
    }
  }

  if (tier === 'amber') {
    return {
      tier,
      headline: `Saved copy from ${when}.`,
      detail:
        'The route and its accessibility findings still stand. Air quality, rest stops and the best time to leave were measured then, not now.',
    }
  }

  return { tier, headline: `Saved copy from ${when}.`, detail: null }
}

/**
 * The one-line version for the bar across the top of the app.
 *
 * `online` is passed in rather than read from `navigator` so this stays pure:
 * a saved copy can also be served when the network is up but the server is not,
 * and the two cases need different words. Claiming the user is offline when the
 * server is simply down sends them to check their wifi for no reason.
 */
export function offlineBarText(ageMs, online) {
  const when = formatCacheAge(ageMs)
  return online
    ? `Meander could not reach the server. Showing a copy saved ${when}.`
    : `You are offline. Showing a copy saved ${when}.`
}

/**
 * Has a suggested departure time already gone by?
 *
 * This is not only a caching question. `best_departure` is an absolute time
 * computed when the request was made, so a tab left open across it, or a route
 * restored from the cache hours later, both end up recommending a moment in the
 * past — "better if you leave at 19:15" at nine in the evening. The suggestion
 * is withdrawn rather than re-derived, because re-deriving it would need the
 * air-quality and cloud-cover series that are exactly what we no longer have.
 */
export function departureHasPassed(when, now = Date.now()) {
  if (!when) return false
  const at = when instanceof Date ? when.getTime() : Date.parse(when)
  if (Number.isNaN(at)) return false
  return at < now
}
