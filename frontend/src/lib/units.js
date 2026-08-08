/**
 * Distance and clock preference.
 *
 * The second — and, by rule, the last — thing Meander keeps in the browser. It
 * holds two words and is structurally incapable of holding anything else:
 * `storeUnits` writes only the two validated enum fields, and `readStoredUnits`
 * rejects the whole object if either is unrecognised. `units.test.js` asserts
 * that against the raw stored string rather than trusting this paragraph.
 *
 * Deliberately a pure module: no mutable singleton, no listener set, no
 * `useSyncExternalStore`, no React import. Units live in the App reducer next to
 * `theme` and are threaded as a prop.
 *
 * That is a departure from the branch this is ported from, and it fixes a bug
 * rather than expressing a preference. There, `useUnits()` was subscribed by the
 * control and by nothing else, while every route distance went through a
 * `fmtDist` that read the module singleton without subscribing — so choosing
 * miles re-rendered the four chips and left every distance on screen in
 * kilometres until something unrelated forced a render. Threading a prop makes a
 * missed call site a visible missing argument instead of silently stale output.
 *
 * Every localStorage access is wrapped, for the reason theme.js gives: Safari in
 * private mode throws on setItem, and a unit toggle is not worth taking the app
 * down for.
 */

export const UNITS_KEY = 'meander:units'

/** The fallback, and the default parameter for every formatter here. */
export const METRIC_24 = Object.freeze({ distance: 'metric', clock: '24', chosen: false })

const VALID_DISTANCE = new Set(['metric', 'imperial'])
const VALID_CLOCK = new Set(['12', '24'])

/**
 * The four regions that read road distances in miles. Liberia and Myanmar
 * belong here as much as the US and the UK do.
 */
const IMPERIAL_REGIONS = new Set(['US', 'GB', 'MM', 'LR'])

const M_PER_FOOT = 0.3048
const M_PER_MILE = 1609.344

/** Below this we speak feet; above it, miles. 160 m is a shade under 0.1 mi. */
const FEET_BELOW_M = 160
/** Above ten miles the decimal is noise, exactly as it is above ten kilometres. */
const MILE_DECIMAL_BELOW_M = 10 * M_PER_MILE

/**
 * What the locale implies, for a user who has expressed no preference.
 *
 * The locale is an argument rather than a read of `navigator.language` inside
 * the function, because that is the difference between a function this repo can
 * test in a bare node runner and one it cannot — there is no jsdom here.
 *
 * Clock detection asks ICU rather than inferring from the region. That matters:
 * `en-GB` resolves to a 24-hour clock, so a UK browser gets miles *and* 24-hour.
 * The branch this is ported from carries a comment claiming the UK reads
 * "time in 12 hours"; its own code disagrees, and the code is right.
 *
 * Note `'en'` with no region maximises to `'US'` and therefore to miles. That is
 * a real consequence, not an accident, and it is the reason the control has to
 * be somewhere a user can find it rather than tucked behind an empty state.
 */
export function detectUnits(locale = globalThis.navigator?.language || 'en') {
  let distance = 'metric'
  let clock = '24'
  try {
    const region = new Intl.Locale(locale).maximize().region
    if (IMPERIAL_REGIONS.has(region)) distance = 'imperial'
  } catch {
    // An unparseable tag is not worth a broken app; metric is the safe answer.
  }
  try {
    if (new Intl.DateTimeFormat(locale, { hour: 'numeric' }).resolvedOptions().hour12) clock = '12'
  } catch {
    // As above.
  }
  return { distance, clock, chosen: false }
}

/**
 * The stored choice, or null.
 *
 * Null on *any* invalid field, rather than merging the locale's answer in
 * field-by-field. A half-valid object would otherwise report `chosen: true`
 * while carrying a value the user never picked.
 */
export function readStoredUnits() {
  try {
    const raw = window.localStorage.getItem(UNITS_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
    if (!VALID_DISTANCE.has(parsed.distance) || !VALID_CLOCK.has(parsed.clock)) return null
    return { distance: parsed.distance, clock: parsed.clock, chosen: true }
  } catch {
    return null
  }
}

/** Writes the two words and nothing else. Extra fields are dropped by construction. */
export function storeUnits(units) {
  try {
    const distance = VALID_DISTANCE.has(units?.distance) ? units.distance : METRIC_24.distance
    const clock = VALID_CLOCK.has(units?.clock) ? units.clock : METRIC_24.clock
    window.localStorage.setItem(UNITS_KEY, JSON.stringify({ distance, clock }))
  } catch {
    // Private mode, or storage disabled. The choice lasts as long as the tab.
  }
}

export function clearStoredUnits() {
  try {
    window.localStorage.removeItem(UNITS_KEY)
  } catch {
    // Nothing depends on the removal having been written.
  }
}

/**
 * A stored choice wins over the locale; the locale is only the default.
 *
 * Resolved at mount rather than at module load, so reading storage is not a side
 * effect of importing this file.
 */
export function initialUnits() {
  return readStoredUnits() ?? detectUnits()
}

/**
 * "480 m", "2.4 km", "520 ft", "1.6 mi" — or "—" when the distance is unknown.
 *
 * The metric branch is the pre-existing `fmtDist` expression, kept verbatim
 * rather than rewritten. It agrees with the old one on every integer metre from
 * 0 to 200 000, and a test pins that, because "nothing changes for a metric
 * user" is a property worth being able to prove.
 *
 * (999 m renders as "1000 m" rather than "1.0 km". That is pre-existing, shared
 * by both branches, and deliberately not fixed here — fixing it would break the
 * byte-identity property above. It belongs in its own change.)
 */
export function formatDistance(metres, units = METRIC_24) {
  if (metres == null || Number.isNaN(metres)) return '—'
  if (units.distance !== 'imperial') {
    if (metres < 1000) return `${Math.round(metres / 10) * 10} m`
    return `${(metres / 1000).toFixed(metres < 10000 ? 1 : 0)} km`
  }
  if (metres < FEET_BELOW_M) {
    // Ten-foot granularity, not one. The router does not know a step's length to
    // the foot, and the metric branch beside it rounds to 10 m for the same
    // reason; "522 ft" would be a precision claim nothing supports.
    return `${Math.round(metres / M_PER_FOOT / 10) * 10} ft`
  }
  const miles = metres / M_PER_MILE
  return `${miles.toFixed(metres < MILE_DECIMAL_BELOW_M ? 1 : 0)} mi`
}

/**
 * A clock time in the user's chosen form.
 *
 * The 12-hour branch always carries a meridiem, and `hour: 'numeric'` is what
 * keeps it "6:05 PM" rather than "06:05 PM". That is not cosmetic: the standing
 * objection to a 12-hour clock here is that a walker reading "6:24" cannot tell
 * dawn from dusk, and the am/pm marker is the entire answer to it. A test
 * asserts the marker across all 24 hours.
 */
export function fmtClockIn(date, units = METRIC_24) {
  if (!(date instanceof Date) || Number.isNaN(date.valueOf())) return null
  const twelve = units.clock === '12'
  return new Intl.DateTimeFormat(undefined, {
    hour: twelve ? 'numeric' : '2-digit',
    minute: '2-digit',
    hour12: twelve,
  }).format(date)
}

/**
 * Metres of climb, in the chosen system. "—" when unknown, never "0 m": a route
 * whose elevation profile is missing has not been measured as flat.
 */
export function formatElevation(metres, units = METRIC_24) {
  if (metres == null || Number.isNaN(metres)) return '—'
  if (units.distance !== 'imperial') return `${Math.round(metres)} m`
  return `${Math.round(metres / M_PER_FOOT)} ft`
}
