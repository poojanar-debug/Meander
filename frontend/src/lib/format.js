import { formatDistance } from './units.js'

/** Formatting helpers. Every string here can end up in a screen reader, so they
 * read as sentences rather than as abbreviations. */

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

export function fmtDist(metres) {
  // Delegates, so the ~15 existing call sites follow the unit preference
  // without any of them needing to know it exists.
  return formatDistance(metres)
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
export function confidenceSentence(confidence, scoringMethod, serverNote) {
  const severity =
    scoringMethod === 'placeholder' || confidence < 0.3
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
  const pct = Math.round((confidence ?? 0) * 100)
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
export function restStopSentence(restStops) {
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
  return `${restStops.length} rest stop${restStops.length === 1 ? '' : 's'} along the way: ${list}. The first is ${fmtDist(first)} in.`
}

export function announceRoutes(routes) {
  if (!routes.length) return ''
  const routable = routes.filter((r) => r.status === 'ok')
  const head = `${routes.length} route${routes.length === 1 ? '' : 's'} ready, ${routable.length} routable.`
  const detail = routes
    .map((r) =>
      r.status === 'ok'
        ? `${r.label}, ${fmtDurSpoken(r.duration_min)}, ${fmtDist(r.distance_m)}.`
        : `${r.label} is blocked. ${r.status_note ?? ''}`.trim(),
    )
    .join(' ')
  return `${head} ${detail}`
}

export function announceSelection(route) {
  if (!route) return ''
  if (route.status !== 'ok') {
    return `${route.label} selected. This route is blocked. ${route.status_note ?? ''}`.trim()
  }
  const { text } = confidenceSentence(route.confidence, route.scoring_method)
  return `${route.label} selected. ${fmtDurSpoken(route.duration_min)}, ${fmtDist(route.distance_m)}. ${text}`
}

/**
 * Human names for the blocker types.
 *
 * The card rendered `{b.type}` straight through, which produced lines like
 * "surface: Surface recorded as sett, which is not passable." — a raw OSM tag
 * key, followed by a sentence that already said the same word.
 *
 * These five are the complete vocabulary, taken from backend/accessibility.py:
 * `_span_verdicts` is called with exactly "steps", "surface", "smoothness" and
 * "barrier", and `incline_findings` emits "incline". Nothing else is invented
 * here — a name for a type the backend cannot emit would be a promise about
 * data that does not exist.
 */
export const BLOCKER_TYPE_NAMES = {
  steps: 'Steps',
  surface: 'Surface',
  smoothness: 'Surface condition',
  barrier: 'Barrier',
  incline: 'Gradient',
}

export function blockerTypeName(type) {
  return BLOCKER_TYPE_NAMES[type] ?? 'Obstruction'
}

/**
 * How loudly to say how much of a route was checked.
 *
 * The governing rule for the whole card: **when the data is good, say so
 * briefly; when it is bad, say so loudly.** Never delete the statement — vary
 * its volume with how much it matters. Uniformly loud honesty is honesty
 * nobody reads.
 *
 *   quiet    >= 60%   a chip
 *   amber    30-60%   a chip, coloured
 *   loud     < 30%    a full-width block, expanded, not a chip
 *
 * `placeholder` scoring and `synthetic_upstream` are loud regardless of
 * coverage, because their numbers are not measurements at all — a synthetic
 * route with 90% "coverage" is 90% of nothing.
 */
export function trustTier(route) {
  const coverage = route?.confidence ?? 0
  const notMeasured =
    route?.synthetic_upstream === true || route?.scoring_method === 'placeholder'

  if (notMeasured) return 'loud'
  if (coverage < 0.3) return 'loud'
  if (coverage < 0.6) return 'amber'
  return 'quiet'
}

/** The short form, for the chip. The long form is the backend's own sentence. */
export function coverageChipText(route) {
  const pct = Math.round((route?.confidence ?? 0) * 100)
  return trustTier(route) === 'amber'
    ? `${pct}% checked — treat the rest as unverified`
    : `Accessibility data: ${pct}% of route checked`
}

/**
 * What the three percentages on a card are percentages *of*.
 *
 * They were rendered as bare numbers — "Nature 31%", "Clean air 62%",
 * "Shade 20%" — which invites the reader to supply their own meaning, and the
 * meaning they supply is usually "31% of the maximum possible", which is not
 * what any of these are.
 */
export const SCORE_META = {
  nature: {
    label: 'Greenery',
    comparative: 'greener than',
    explanation:
      'How much of this route runs alongside parks, water, tree cover and quiet ' +
      'ways rather than arterial roads. A relative score, not a measured area.',
  },
  air: {
    label: 'Air quality',
    comparative: 'cleaner air than',
    explanation:
      'The regional air-quality index for the area, modulated by how much of ' +
      'this particular route runs beside heavy traffic. The regional part is a ' +
      'measurement; the traffic part is inferred from OSM road classes.',
  },
  shade: {
    label: 'Shade',
    comparative: 'more shaded than',
    explanation:
      'How much shade you are likely to get relative to how much you need, from ' +
      'the sun position at your departure time and the forecast cloud cover. ' +
      'It does not know where individual trees or buildings are.',
  },
}

/**
 * The coordinate a given distance along a polyline.
 *
 * Used by barrier reporting, where "about 400 m along this route" is how people
 * actually describe where something is — and, unlike a map tap, it is precision
 * genuinely derived from the route rather than from a fingertip on a small
 * screen.
 */
export function pointAtDistance(geometry, targetM) {
  if (!geometry?.length) return null
  if (geometry.length === 1) return { lon: geometry[0][0], lat: geometry[0][1] }

  const R = 6371008.8
  const rad = (d) => (d * Math.PI) / 180
  const between = (a, b) => {
    const [lon1, lat1] = a
    const [lon2, lat2] = b
    const dLat = rad(lat2 - lat1)
    const dLon = rad(lon2 - lon1)
    const h =
      Math.sin(dLat / 2) ** 2 +
      Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLon / 2) ** 2
    return 2 * R * Math.asin(Math.sqrt(Math.min(1, h)))
  }

  let travelled = 0
  for (let i = 1; i < geometry.length; i += 1) {
    const seg = between(geometry[i - 1], geometry[i])
    if (travelled + seg >= targetM || i === geometry.length - 1) {
      const t = seg > 0 ? Math.min(1, Math.max(0, (targetM - travelled) / seg)) : 0
      const [lon1, lat1] = geometry[i - 1]
      const [lon2, lat2] = geometry[i]
      return { lon: lon1 + (lon2 - lon1) * t, lat: lat1 + (lat2 - lat1) * t }
    }
    travelled += seg
  }
  const last = geometry[geometry.length - 1]
  return { lon: last[0], lat: last[1] }
}

/** Total length of a polyline, in metres. */
export function polylineLength(geometry) {
  if (!geometry || geometry.length < 2) return 0
  const R = 6371008.8
  const rad = (d) => (d * Math.PI) / 180
  let total = 0
  for (let i = 1; i < geometry.length; i += 1) {
    const [lon1, lat1] = geometry[i - 1]
    const [lon2, lat2] = geometry[i]
    const dLat = rad(lat2 - lat1)
    const dLon = rad(lon2 - lon1)
    const h =
      Math.sin(dLat / 2) ** 2 +
      Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLon / 2) ** 2
    total += 2 * R * Math.asin(Math.sqrt(Math.min(1, h)))
  }
  return total
}
