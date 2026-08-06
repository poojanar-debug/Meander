import { useSyncExternalStore } from 'react'

/**
 * Distance units and clock format.
 *
 * Everything was hardcoded to metric and a 24-hour clock, which is a real
 * barrier for a whole class of users: "1.4 km" and "18:52" are not readable at
 * a glance to most people in the US, the UK reads distance in miles and time in
 * 12 hours, and the app's own audience is explicitly people planning a walk
 * they have to be able to trust.
 *
 * **The locale is the default, not the decision.** Detected from the browser
 * and then overridable, because a detected locale is a good guess about a
 * person and a bad substitute for asking them — somebody in a metric country
 * who thinks in miles exists and is not a rounding error.
 *
 * ⚠ Storage. The preference is written to localStorage, which is the first
 * thing this app has ever persisted in a browser. It is compliant with the
 * project's privacy rule by construction rather than by promise:
 *
 *   * **opt-in** — nothing is written until the user actively picks a unit;
 *     the detected default is computed on each load and never stored
 *   * **explicitly labelled** — the settings sheet says what is saved
 *   * **no coordinates, ever** — the only values this key can hold are
 *     "metric"/"imperial" and "12"/"24", and the reader validates that
 */

const KEY = 'meander.units'

const VALID_DISTANCE = new Set(['metric', 'imperial'])
const VALID_CLOCK = new Set(['12', '24'])

/** Countries that read distance in miles. Everywhere else is metric. */
const IMPERIAL_REGIONS = new Set(['US', 'GB', 'MM', 'LR'])

function detectDistance() {
  try {
    const locale = new Intl.Locale(navigator.language || 'en')
    const region = locale.maximize?.().region ?? locale.region
    return IMPERIAL_REGIONS.has(region) ? 'imperial' : 'metric'
  } catch {
    return 'metric'
  }
}

function detectClock() {
  try {
    // Ask the platform rather than infer from the region: hourCycle is exactly
    // this question and it already knows the answer for every locale.
    const parts = new Intl.DateTimeFormat(navigator.language || 'en', {
      hour: 'numeric',
    }).resolvedOptions()
    return parts.hour12 ? '12' : '24'
  } catch {
    return '24'
  }
}

function read() {
  // The detected values are recomputed every load and never written, so a
  // user who has expressed no preference leaves no trace.
  const detected = { distance: detectDistance(), clock: detectClock(), chosen: false }
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return detected
    const saved = JSON.parse(raw)
    return {
      distance: VALID_DISTANCE.has(saved.distance) ? saved.distance : detected.distance,
      clock: VALID_CLOCK.has(saved.clock) ? saved.clock : detected.clock,
      chosen: true,
    }
  } catch {
    return detected
  }
}

let current = typeof window === 'undefined'
  ? { distance: 'metric', clock: '24', chosen: false }
  : read()

const listeners = new Set()

function emit() {
  for (const listener of listeners) listener()
}

export function getUnits() {
  return current
}

export function setUnits(patch) {
  current = { ...current, ...patch, chosen: true }
  try {
    localStorage.setItem(
      KEY,
      JSON.stringify({ distance: current.distance, clock: current.clock }),
    )
  } catch {
    // Private browsing, or storage disabled. The choice still applies for this
    // session; it simply does not survive a reload, which is a smaller failure
    // than refusing to honour it at all.
  }
  emit()
}

/** Forget the preference and go back to what the browser implies. */
export function clearUnits() {
  try {
    localStorage.removeItem(KEY)
  } catch {
    /* nothing to clean up */
  }
  current = { ...read(), chosen: false }
  emit()
}

function subscribe(listener) {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function useUnits() {
  return useSyncExternalStore(subscribe, getUnits, getUnits)
}

// --- formatting -------------------------------------------------------------

const M_PER_MILE = 1609.344
const M_PER_FOOT = 0.3048

export function formatDistance(metres, units = current) {
  if (metres == null || Number.isNaN(metres)) return '—'
  if (units.distance === 'imperial') {
    if (metres < 160) return `${Math.round(metres / M_PER_FOOT)} ft`
    const miles = metres / M_PER_MILE
    return miles < 10 ? `${miles.toFixed(1)} mi` : `${Math.round(miles)} mi`
  }
  if (metres < 1000) return `${Math.round(metres / 10) * 10} m`
  const km = metres / 1000
  return km < 10 ? `${km.toFixed(1)} km` : `${Math.round(km)} km`
}

export function formatTime(date, units = current) {
  const when = date instanceof Date ? date : new Date(date)
  if (Number.isNaN(when.getTime())) return ''
  return when.toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
    hour12: units.clock === '12',
  })
}

/** Metres climbed, in whichever unit the rest of the app is using. */
export function formatElevation(metres, units = current) {
  if (metres == null || Number.isNaN(metres)) return '—'
  return units.distance === 'imperial'
    ? `${Math.round(metres / M_PER_FOOT)} ft`
    : `${Math.round(metres)} m`
}
