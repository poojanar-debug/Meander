/** Formatting helpers. Every string here can end up in a screen reader, so they
 * read as sentences rather than as abbreviations. */

import { METRIC_24, formatDistance } from './units.js'

/** Must match `derive_mode` in backend/models.py exactly. */
export const deriveMode = (m) => (m <= 45 ? 'foot' : m <= 120 ? 'bike' : 'car')

export const MODE_VERB = { foot: 'walking', bike: 'cycling', car: 'driving' }
export const MODE_NOUN = { foot: 'on foot', bike: 'by bike', car: 'by car' }

export function effectiveMode(mode, minutes) {
  return mode === 'auto' ? deriveMode(minutes) : mode
}

/** "1 hr 25 min" — spoken form, not "1:25". */
export function fmtDur(minutes) {
  if (minutes == null || Number.isNaN(minutes)) return '—'
  const total = Math.round(minutes)
  if (total < 60) return `${total} min`
  const hours = Math.floor(total / 60)
  const rest = total % 60
  return rest === 0 ? `${hours} hr` : `${hours} hr ${rest} min`
}

/**
 * `fmtDur` split so the metric can take the display face and the unit can trail
 * in the body face at a smaller size (§4.6). Splitting the formatted string with
 * a regex instead loses the minutes from "1 hr 25 min", which is exactly the
 * kind of quiet wrongness a route duration must not have.
 */
export function durationParts(minutes) {
  if (minutes == null || Number.isNaN(minutes)) return { value: '—', unit: '' }
  const total = Math.round(minutes)
  if (total < 60) return { value: String(total), unit: 'min' }
  const hours = Math.floor(total / 60)
  const rest = total % 60
  if (rest === 0) return { value: String(hours), unit: 'hr' }
  return { value: `${hours} hr ${rest}`, unit: 'min' }
}

/** Spelled out for the live region, where "hr" is read as "hour" inconsistently. */
export function fmtDurSpoken(minutes) {
  if (minutes == null || Number.isNaN(minutes)) return 'unknown duration'
  const total = Math.round(minutes)
  if (total < 60) return `${total} minute${total === 1 ? '' : 's'}`
  const hours = Math.floor(total / 60)
  const rest = total % 60
  const h = `${hours} hour${hours === 1 ? '' : 's'}`
  return rest === 0 ? h : `${h} ${rest} minute${rest === 1 ? '' : 's'}`
}

/**
 * Distances are the one thing here that the user can change the shape of, so
 * this delegates. `units` is defaulted, which keeps every existing caller
 * compiling — and is exactly why units-callsites.test.js exists: with no ESLint
 * in this repo, a call site nobody threaded would keep rendering kilometres to
 * a user who asked for miles, and no other gate would notice.
 */
export function fmtDist(metres, units = METRIC_24) {
  return formatDistance(metres, units)
}

export function fmtPct(fraction) {
  if (fraction == null || Number.isNaN(fraction)) return '—'
  return `${Math.round(fraction * 100)}%`
}

/**
 * The confidence sentence. Always rendered — never a tooltip, never behind a
 * disclosure. Below 0.3 it becomes an explicit warning, because a low-coverage
 * accessibility answer that reads like a high-coverage one is the exact failure
 * this project exists to avoid.
 */
/**
 * A coverage figure we actually have, as opposed to one we can infer.
 *
 * `null < 0.3` is `true` in JavaScript, so an unknown coverage used to fall
 * through the numeric ladder below and render as "covers only 0%" — a
 * measurement claim about a route nobody measured. `models.py` declares
 * `confidence: float`, so a well-formed response never carries null; this is the
 * defensive path, and it is the one that has to be right, because the cases
 * that reach it are exactly the ones nothing else is watching.
 *
 * Deliberately not coercing a numeric string either: if something upstream
 * starts sending `"0.8"`, "unknown" is the honest answer and a silent parse is
 * not.
 */
const measured = (confidence) => typeof confidence === 'number' && Number.isFinite(confidence)

export function confidenceSentence(confidence, scoringMethod, serverNote) {
  const unknown = !measured(confidence)
  const severity =
    scoringMethod === 'placeholder' || unknown || confidence < 0.3
      ? 'warning'
      : confidence < 0.6
        ? 'caution'
        : 'ok'

  // The backend writes this sentence, so the wording cannot drift between the
  // two halves of the app. The client-side version below is the fallback.
  if (serverNote) return { text: serverNote, severity }

  if (scoringMethod === 'placeholder') {
    return {
      text: 'Accessibility data has not been evaluated for this route. Nothing here is a measurement.',
      severity: 'warning',
    }
  }

  // Unknown is not zero. "Covers only 0%" says a measurement was taken and came
  // back empty; this says no measurement is available. The instruction is the
  // same either way, which is why the difference is easy to lose and worth
  // keeping.
  if (unknown) {
    return {
      text: 'How much of this route was checked is unknown. Treat all of it as unverified.',
      severity: 'warning',
    }
  }

  const pct = Math.round(confidence * 100)
  if (confidence < 0.3) {
    return {
      text: `Accessibility data covers only ${pct}% of this route. Most of it is unverified — do not rely on it.`,
      severity: 'warning',
    }
  }
  if (confidence < 0.6) {
    return {
      text: `Accessibility data covers ${pct}% of this route; treat the remainder as unverified.`,
      severity: 'caution',
    }
  }
  return { text: `Accessibility data covers ${pct}% of this route.`, severity: 'ok' }
}

/**
 * The four-segment verification meter. Implements §4.7.
 *
 * This is a **summary**, not a statement. `confidenceSentence()` above remains
 * the source of truth and still renders verbatim in the detail panel; the meter
 * exists so three routes can be compared at a glance, which a paragraph of
 * prose per route cannot do.
 *
 * `tone: 'warn'` covers everything below 0.60, and the caller pairs it with a
 * ⚠ glyph and a weight change — the colour is never the only signal that a
 * route's accessibility data is thin.
 */
export function verificationTier(confidence, scoringMethod) {
  if (scoringMethod === 'placeholder') {
    return { filled: 0, word: 'Not measured', tone: 'warn' }
  }
  // Same answer as placeholder, for the same reason: an unknown coverage was
  // filling one segment and reading "Barely verified", which is a measurement
  // this route does not have. VerificationMeter already suppresses the
  // percentage for a non-number confidence — it knew the difference before this
  // function did.
  if (!measured(confidence)) {
    return { filled: 0, word: 'Not measured', tone: 'warn' }
  }
  const c = confidence
  if (c < 0.3) return { filled: 1, word: 'Barely verified', tone: 'warn' }
  if (c < 0.6) return { filled: 2, word: 'Partly verified', tone: 'warn' }
  if (c < 0.8) return { filled: 3, word: 'Mostly verified', tone: 'ok' }
  return { filled: 4, word: 'Well verified', tone: 'ok' }
}

/**
 * Rest stops for the rail sub-row.
 *
 * `null` and `[]` are different answers and must not render alike: `null` means
 * Overpass could not be reached, `[]` means it was reached and there is nothing
 * there. Saying "no rest stops" when the truth is "we could not look" is the
 * same class of mistake as calling an untagged path accessible.
 */
export function restStopSummary(restStops) {
  if (restStops == null) return 'rest stops not checked'
  if (restStops.length === 0) return 'no rest stops'
  return `${restStops.length} rest stop${restStops.length === 1 ? '' : 's'}`
}

const COUNT_WORDS = ['no', 'One', 'Two', 'Three', 'Four', 'Five', 'Six']

/** "Three ways back" — the results head (§3). */
export function waysBack(count) {
  const word = COUNT_WORDS[count] ?? String(count)
  return `${word} way${count === 1 ? '' : 's'} back`
}

export const SCORING_METHOD_LABEL = {
  clip: 'Scored from street-level imagery',
  geometry_only: 'Scored from route shape only — no imagery available here',
  placeholder: 'Placeholder values, not a measurement',
}

/** Readable names for the OSM amenity types rest stops come from. */
const REST_STOP_NAMES = {
  bench: ['bench', 'benches'],
  'drinking water': ['drinking water tap', 'drinking water taps'],
  drinking_water: ['drinking water tap', 'drinking water taps'],
  toilets: ['public toilet', 'public toilets'],
  shelter: ['shelter', 'shelters'],
  picnic_table: ['picnic table', 'picnic tables'],
  fountain: ['fountain', 'fountains'],
}

export function restStopName(type, count) {
  const known = REST_STOP_NAMES[type]
  if (known) return count === 1 ? known[0] : known[1]
  const readable = String(type).replace(/_/g, ' ')
  if (count === 1) return readable
  return /(s|x|z|ch|sh)$/.test(readable) ? `${readable}es` : `${readable}s`
}

/** Rest stops as a sentence, so the list is a complete substitute for the map. */
export function restStopSentence(restStops, units = METRIC_24) {
  if (!restStops || restStops.length === 0) {
    return 'No rest stops found along this route.'
  }
  const counts = restStops.reduce((acc, stop) => {
    acc[stop.type] = (acc[stop.type] ?? 0) + 1
    return acc
  }, {})
  const parts = Object.entries(counts).map(([type, n]) => `${n} ${restStopName(type, n)}`)
  const list =
    parts.length === 1 ? parts[0] : `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}`
  const first = Math.round(restStops[0].at_m)
  return `${restStops.length} rest stop${restStops.length === 1 ? '' : 's'} along the way: ${list}. The first is ${fmtDist(first, units)} in.`
}

export function announceRoutes(routes, units = METRIC_24) {
  if (!routes.length) return ''
  const routable = routes.filter((r) => r.status === 'ok')
  const head = `${routes.length} route${routes.length === 1 ? '' : 's'} ready, ${routable.length} routable.`
  const detail = routes
    .map((r) =>
      r.status === 'ok'
        ? `${r.label}, ${fmtDurSpoken(r.duration_min)}, ${fmtDist(r.distance_m, units)}.`
        : `${r.label} is blocked. ${r.status_note ?? ''}`.trim(),
    )
    .join(' ')
  return `${head} ${detail}`
}

export function announceSelection(route, units = METRIC_24) {
  if (!route) return ''
  if (route.status !== 'ok') {
    return `${route.label} selected. This route is blocked. ${route.status_note ?? ''}`.trim()
  }
  const { text } = confidenceSentence(route.confidence, route.scoring_method)
  return `${route.label} selected. ${fmtDurSpoken(route.duration_min)}, ${fmtDist(route.distance_m, units)}. ${text}`
}
