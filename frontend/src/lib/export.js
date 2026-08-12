/**
 * Take the route with you: GPX, GeoJSON, a maps handoff, and a printed sheet.
 *
 * The whole point of this module is `provenanceNote`. A file outlives the
 * session that produced it, so anything this app is careful to say on screen
 * has to travel with the file or the care is only skin deep. The note is
 * therefore embedded in all four outputs — including the two the branch this
 * was ported from could not reach.
 *
 * Nothing here touches the network, storage, the reducer or the map.
 */

import {
  SCORING_METHOD_LABEL,
  confidenceSentence,
  fmtDist,
  fmtDur,
  restStopSentence,
} from './format.js'
import { METRIC_24, formatElevation } from './units.js'

const SCORE_LABEL = { scenic: 'Scenic', air: 'Air', shade: 'Shade' }

const esc = (value) =>
  String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')

/**
 * The sentence that travels with every export.
 *
 * The coverage clause delegates to confidenceSentence rather than computing its
 * own, which is the substantive change from the source. That version wrote
 * `Math.round((confidence ?? 0) * 100)` directly, so a placeholder-scored route
 * exported "covers 90%" while the screen said "has not been evaluated" — and an
 * unknown coverage exported as "0%", which is a measurement claim about a route
 * nobody measured. Delegating also picks up the server's own wording when it
 * sends one, so the file and the screen now say the same thing by construction.
 */
export function provenanceNote(route, units = METRIC_24) {
  const parts = [
    `Meander ${route.label} route: ${fmtDur(route.duration_min)}, ${fmtDist(route.distance_m, units)}.`,
  ]

  if (route.synthetic_upstream) {
    parts.push('BUILT FROM DEMONSTRATION DATA, NOT A LIVE ROUTING RESPONSE. Do not follow it.')
  }

  parts.push(confidenceSentence(route.confidence, route.scoring_method, route.confidence_note).text)

  // A coverage figure with no statement of how it was measured is a number this
  // project does not want quoted on its own.
  if (route.scoring_method) {
    const how = SCORING_METHOD_LABEL[route.scoring_method] ?? route.scoring_method
    parts.push(`Measured by: ${how}.`)
  }

  // Three answers, not two. "Not checked" and "none found" are different facts,
  // and a file that conflates them is worse than one that says nothing.
  if (route.enrichment_pending) {
    parts.push('Rest stops were still being checked when this was exported. The list may be incomplete.')
  } else if (route.rest_stops == null) {
    parts.push('Rest stops were not checked for this route. That is not the same as there being none.')
  } else if (route.rest_stops.length === 0) {
    parts.push('No rest stops found along this route.')
  } else {
    parts.push(restStopSentence(route.rest_stops, units))
  }

  // A consumer who sees no mention of shade will assume something. A file that
  // says "not measured" cannot be misread that way.
  const unmeasured = Object.keys(SCORE_LABEL).filter((key) => route.scores?.[key] === null)
  if (unmeasured.length) {
    parts.push(`${unmeasured.map((k) => SCORE_LABEL[k]).join(', ')}: not measured.`)
  }

  if (route.blockers?.length) {
    parts.push(
      `${route.blockers.length} recorded barrier${route.blockers.length === 1 ? '' : 's'} on this route.`,
    )
  }
  if (route.steps?.length) {
    parts.push(`${route.steps.length} directions included.`)
  }

  if (route.elevation) {
    const { ascent_m: up, descent_m: down, max_gradient_pct: max, limit_pct: limit } = route.elevation
    // The limit arrives on the wire per route. It is never hard-coded here: the
    // constant lives in the accessibility engine and has no JS export, so a
    // literal would be a second source of truth that could drift from the
    // verdict it is supposed to explain.
    const against = limit == null ? '' : ` against a ${limit}% limit`
    // Through formatElevation, not `Math.round(up)` + " m". This line was the
    // last hard-coded metric unit in the file, so a user in miles got a GPX and
    // a printed sheet whose climb was in metres while every other number on
    // them was in feet.
    parts.push(
      `Climbs ${formatElevation(up, units)}, descends ${formatElevation(down, units)}, ` +
        `steepest ${max}%${against}.`,
    )
  }

  if (route.status !== 'ok') {
    parts.push(
      `This route was rejected by the accessibility constraints and is included for comparison only. ${route.status_note ?? ''}`.trim(),
    )
  }

  parts.push('Route data © OpenStreetMap contributors, ODbL.')
  return parts.join(' ')
}

/**
 * One clock read for the whole export.
 *
 * The source called `new Date()` separately for the filename and for the GPX
 * metadata, so a download at 23:59:59.9 UTC could produce a file whose name and
 * whose contents disagreed about the date.
 */
export function exportStamp(route, now = new Date()) {
  const isoTime = now.toISOString()
  const filename = `meander-${route.id}-${isoTime.slice(0, 10)}`.replace(/[^a-z0-9-]/gi, '')
  return { filename, isoTime }
}

/**
 * GPX 1.1.
 *
 * A `<trk>`, not a `<rte>`: this is a recorded shape to follow, not a sequence
 * of turn instructions for a device to re-derive.
 *
 * No `<ele>`. The geometry is [lon, lat] with no third ordinate — the router
 * drops it — and the elevation profile is a thinned, capped series that does not
 * correspond one-to-one with the track points. Interpolating would invent
 * per-vertex heights that nothing measured.
 */
export function toGpx(route, { origin, dest } = {}, now = new Date(), units = METRIC_24) {
  const { isoTime } = exportStamp(route, now)
  const note = esc(provenanceNote(route, units))
  const geometry = route.geometry ?? []

  const waypoints = []
  if (origin) {
    waypoints.push(
      `  <wpt lat="${origin.lat}" lon="${origin.lon}"><name>Start</name></wpt>`,
    )
  }
  for (const blocker of route.blockers ?? []) {
    waypoints.push(
      `  <wpt lat="${blocker.lat}" lon="${blocker.lon}">` +
        `<name>${esc(blocker.type)}</name>` +
        `<desc>${esc(blocker.description)}</desc>` +
        `<sym>Danger Area</sym></wpt>`,
    )
  }
  if (dest) {
    waypoints.push(`  <wpt lat="${dest.lat}" lon="${dest.lon}"><name>Destination</name></wpt>`)
  }

  const points = geometry
    .map(([lon, lat]) => `      <trkpt lat="${lat}" lon="${lon}"></trkpt>`)
    .join('\n')

  return `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="Meander" xmlns="http://www.topografix.com/GPX/1/1">
  <metadata>
    <name>${esc(route.label)}</name>
    <desc>${note}</desc>
    <time>${isoTime}</time>
    <copyright author="OpenStreetMap contributors"><license>https://opendatacommons.org/licenses/odbl/</license></copyright>
  </metadata>
${waypoints.join('\n')}
  <trk>
    <name>${esc(route.label)}</name>
    <desc>${note}</desc>
    <trkseg>
${points}
    </trkseg>
  </trk>
</gpx>
`
}

/**
 * GeoJSON: the line, then one Point per barrier.
 *
 * Every feature carries the note, barriers included. A consumer who clicks a
 * single barrier point in some other tool should still be told how well this
 * route was verified.
 */
export function toGeoJson(route, units = METRIC_24) {
  const note = provenanceNote(route, units)
  const shared = {
    route: route.id,
    label: route.label,
    note,
    // Null, never 0. An unmeasured route has not been measured as bad.
    accessibility_coverage: route.confidence ?? null,
    scoring_method: route.scoring_method ?? null,
    enrichment_pending: route.enrichment_pending ?? false,
  }

  const features = [
    {
      type: 'Feature',
      geometry: { type: 'LineString', coordinates: route.geometry ?? [] },
      properties: {
        ...shared,
        kind: 'route',
        duration_min: route.duration_min ?? null,
        distance_m: route.distance_m ?? null,
      },
    },
    ...(route.blockers ?? []).map((blocker) => ({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [blocker.lon, blocker.lat] },
      properties: {
        ...shared,
        kind: 'barrier',
        barrier_type: blocker.type,
        description: blocker.description ?? null,
      },
    })),
  ]

  return JSON.stringify({ type: 'FeatureCollection', features }, null, 2)
}

/** Evenly spaced points that always keep the two ends. */
export function sampleWaypoints(geometry, max = 8) {
  if (!geometry || geometry.length <= max) return geometry ?? []
  const step = (geometry.length - 1) / (max - 1)
  const out = []
  for (let i = 0; i < max; i += 1) out.push(geometry[Math.round(i * step)])
  return out
}

const GOOGLE_MODE = { foot: 'walking', bike: 'bicycling', car: 'driving' }
const APPLE_MODE = { foot: 'w', bike: 'w', car: 'd' }

/**
 * Google Maps will route this itself, from the endpoints and a few via points.
 * It will not be the same route — the disclosure in the UI says so before the
 * link is reachable.
 */
export function googleMapsUrl(route) {
  const geometry = route.geometry ?? []
  if (geometry.length < 2) return null
  // Ten is Google's practical limit for origin + destination + waypoints.
  const sampled = sampleWaypoints(geometry, 10)
  const [originPoint, ...rest] = sampled
  const destPoint = rest.pop()
  const params = new URLSearchParams({
    api: '1',
    origin: `${originPoint[1]},${originPoint[0]}`,
    destination: `${destPoint[1]},${destPoint[0]}`,
    travelmode: GOOGLE_MODE[route.mode] ?? 'walking',
  })
  if (rest.length) {
    params.set('waypoints', rest.map(([lon, lat]) => `${lat},${lon}`).join('|'))
  }
  return `https://www.google.com/maps/dir/?${params.toString()}`
}

/**
 * Apple Maps takes endpoints only.
 *
 * Not a sampling decision — the URL scheme has no via-point parameter at all,
 * so the shape of the route is discarded entirely. The source called
 * sampleWaypoints(geometry, 2) here, which reads as though something was
 * preserved. Nothing was.
 */
export function appleMapsUrl(route) {
  const geometry = route.geometry ?? []
  if (geometry.length < 2) return null
  const [startLon, startLat] = geometry[0]
  const [endLon, endLat] = geometry[geometry.length - 1]
  const params = new URLSearchParams({
    saddr: `${startLat},${startLon}`,
    daddr: `${endLat},${endLon}`,
    dirflg: APPLE_MODE[route.mode] ?? 'w',
  })
  return `https://maps.apple.com/?${params.toString()}`
}

/**
 * The only function here that touches the DOM, and the reason it is last.
 *
 * Deliberately not unit-tested: vitest runs in a bare node environment in this
 * repo — no document, no URL.createObjectURL — and adding jsdom for one
 * function would be a new devDependency in a four-devDependency project. Keep
 * this a function body; a module-level DOM statement would crash the suite on
 * import.
 */
export function download(filename, contents, mime) {
  const blob = new Blob([contents], { type: mime })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
  // Safari needs the object URL to outlive the click; revoking synchronously
  // cancels the download.
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

export function downloadGpx(route, places, units = METRIC_24) {
  const now = new Date()
  const { filename } = exportStamp(route, now)
  download(`${filename}.gpx`, toGpx(route, places, now, units), 'application/gpx+xml')
}

export function downloadGeoJson(route, units = METRIC_24) {
  const { filename } = exportStamp(route)
  download(`${filename}.geojson`, toGeoJson(route, units), 'application/geo+json')
}
