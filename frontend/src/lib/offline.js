/**
 * How old is this answer, and how loudly should we say so.
 *
 * A saved route is a photograph, not a window. Everything here exists to keep
 * the difference visible, and to make the volume rise with the age — the same
 * escalate-with-severity shape `verificationTier` in format.js uses for
 * accessibility coverage, and for the same reason: a caveat nobody notices is
 * not a caveat.
 *
 * Pure functions only. No storage, no clock read that is not passed in, no DOM.
 */

/** Past this, a route stops being "just now" and starts carrying its age. */
export const AGEING_MS = 15 * 60 * 1000
/** Past this, it is a historical document and is labelled like one. */
export const STALE_MS = 6 * 60 * 60 * 1000

/**
 * Milliseconds since the answer was saved, or null.
 *
 * Null for missing, unparseable, **and future** timestamps. A clock that says
 * the answer arrives tomorrow is a clock that cannot be reasoned about, and
 * null is the honest answer — never zero, which would read as "just now".
 */
export function cacheAgeMs(cachedAt, now = Date.now()) {
  if (!cachedAt) return null
  const then = new Date(cachedAt).valueOf()
  if (Number.isNaN(then)) return null
  const age = now - then
  return age < 0 ? null : age
}

/**
 * 'quiet' | 'amber' | 'loud'.
 *
 * An unknown age is 'loud', not 'quiet'. An entry that cannot say how old it is
 * is the least trustworthy thing on the screen, not the most.
 */
export function cacheTier(ageMs) {
  if (ageMs == null) return 'loud'
  if (ageMs < AGEING_MS) return 'quiet'
  if (ageMs < STALE_MS) return 'amber'
  return 'loud'
}

const MINUTE = 60 * 1000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

/** "just now", "12 minutes ago", "3 hours ago", "2 days ago", "an unknown time ago". */
export function formatCacheAge(ageMs) {
  if (ageMs == null) return 'an unknown time ago'
  if (ageMs < MINUTE) return 'just now'
  if (ageMs < HOUR) {
    const minutes = Math.round(ageMs / MINUTE)
    return `${minutes} minute${minutes === 1 ? '' : 's'} ago`
  }
  if (ageMs < DAY) {
    const hours = Math.round(ageMs / HOUR)
    return `${hours} hour${hours === 1 ? '' : 's'} ago`
  }
  const days = Math.round(ageMs / DAY)
  return `${days} day${days === 1 ? '' : 's'} ago`
}

/**
 * The row chip. Never longer than 20 characters, which is what keeps the rail
 * rows a uniform height — the entire point of that component.
 */
export function cacheChipText(ageMs) {
  if (ageMs == null) return 'Saved · age unknown'
  if (ageMs < MINUTE) return 'Saved · just now'
  if (ageMs < HOUR) return `Saved · ${Math.round(ageMs / MINUTE)} min`
  if (ageMs < DAY) return `Saved · ${Math.round(ageMs / HOUR)} hr`
  return `Saved · ${Math.round(ageMs / DAY)} d`
}

/**
 * The per-route notice in the detail panel.
 *
 * Always returns a non-empty headline, for every input including null. There is
 * no age at which the right thing to do is say nothing.
 */
export function cachedNotice(ageMs) {
  const tier = cacheTier(ageMs)
  const when = formatCacheAge(ageMs)

  if (tier === 'quiet') {
    return {
      tier,
      headline: `This is a saved copy, from ${when}.`,
      detail: 'Conditions will have moved on a little. Reconnect to check.',
    }
  }
  if (tier === 'amber') {
    return {
      tier,
      headline: `This is a saved copy, from ${when}.`,
      detail:
        'Air quality, shade and daylight have all moved on since it was saved. Treat the numbers as a record of that moment, not as advice for now.',
    }
  }
  return {
    tier,
    headline:
      ageMs == null
        ? 'This is a saved copy and it cannot say how old it is.'
        : `This is an old saved copy, from ${when}.`,
    detail:
      'Do not set off on it without checking. Barriers, closures and daylight will all have changed.',
  }
}

/** The bar above the whole list. Same tiers, wider wording. */
export function offlineBarText(ageMs, online) {
  const tier = cacheTier(ageMs)
  const when = formatCacheAge(ageMs)

  const headline = online
    ? `Showing a saved copy from ${when}.`
    : `You are offline. Showing a saved copy from ${when}.`

  if (tier === 'quiet') {
    return {
      tier,
      headline,
      detail: online
        ? 'Nothing new has arrived yet.'
        : 'These are the last routes this device received.',
      mapDetail: 'The map cannot load without a connection. The list below is the whole answer.',
    }
  }
  if (tier === 'amber') {
    return {
      tier,
      headline,
      detail:
        'Enough time has passed that air quality, shade and daylight will have changed. The route shapes have not.',
      mapDetail: 'The map cannot load without a connection. The list below is the whole answer.',
    }
  }
  return {
    tier,
    headline:
      ageMs == null
        ? 'Showing a saved copy. It cannot say how old it is.'
        : `Showing an old saved copy, from ${when}.`,
    detail:
      'Do not rely on it. Barriers, closures and daylight will all have changed since it was saved.',
    mapDetail: 'The map cannot load without a connection. The list below is the whole answer.',
  }
}

/**
 * Has the suggested departure already gone by?
 *
 * `best_departure` is an absolute instant computed when the request was made,
 * and nothing expires it. A tab left open past it renders "Leave at 19:15" at
 * nine in the evening; a replayed saved copy makes that hours worse.
 *
 * The answer is to withdraw the suggestion, never to recompute it: choosing a
 * new time needs the air-quality and cloud-cover series for the hours ahead,
 * which is exactly what a stale or saved response no longer has.
 */
export function departureHasPassed(when, now = Date.now()) {
  if (!when) return false
  const at = new Date(when).valueOf()
  if (Number.isNaN(at)) return false
  return at < now
}
