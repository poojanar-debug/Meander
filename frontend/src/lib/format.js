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
  if (metres == null || Number.isNaN(metres)) return '—'
  if (metres < 1000) return `${Math.round(metres / 10) * 10} m`
  return `${(metres / 1000).toFixed(metres < 10000 ? 1 : 0)} km`
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
