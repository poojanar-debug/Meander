/**
 * Take the route with you.
 *
 * Everything here is generated in the browser from the route the user is
 * already looking at. No upload, no server round-trip, nothing leaves the page
 * unless the user chooses to save or send it.
 *
 * **The accessibility caveat travels with the file.** A GPX exported from
 * Meander and opened in a watch six months later has none of the card's
 * context, so the coverage figure and the "do not rely on it" wording go in the
 * file's own description. Stripping them would be the one thing this project
 * refuses to do — presenting an unverified route as a verified one.
 */

import { fmtDist, fmtDur } from './format.js'

const XML_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => XML_ESCAPES[c])

/** The sentence that must not be separable from the geometry. */
export function provenanceNote(route) {
  const pct = Math.round((route.confidence ?? 0) * 100)
  const parts = [
    `Meander ${route.label} route: ${fmtDur(route.duration_min)}, ${fmtDist(route.distance_m)}.`,
  ]
  if (route.synthetic_upstream) {
    parts.push(
      'BUILT FROM DEMONSTRATION DATA, NOT A LIVE ROUTING RESPONSE. Do not follow it.',
    )
  }
  parts.push(
    `Accessibility data covers ${pct}% of this route.` +
      (pct < 30 ? ' Most of it is unverified — do not rely on it.' : ''),
  )
  if (route.blockers?.length) {
    parts.push(`${route.blockers.length} recorded barrier(s) on this route.`)
  }
  if (route.steps?.length) {
    parts.push(`${route.steps.length} directions included.`)
  }
  if (route.status !== 'ok') {
    parts.push('This route was rejected by the accessibility constraints and cannot be completed.')
  }
  parts.push('Route data © OpenStreetMap contributors, ODbL.')
  return parts.join(' ')
}

const safeName = (route) =>
  `meander-${route.id}-${new Date().toISOString().slice(0, 10)}`.replace(/[^a-z0-9-]/gi, '')

/**
 * GPX 1.1. A track, not a route: `<rte>` means "navigate via these waypoints"
 * and every consumer re-derives its own path from them, which would silently
 * discard the thing that makes a Meander route a Meander route. `<trk>` is the
 * literal line.
 */
export function toGpx(route, { origin, dest } = {}) {
  const points = route.geometry ?? []
  const elevations = route.elevation ?? []

  const trkpts = points
    .map(([lon, lat], i) => {
      const ele = Number.isFinite(elevations[i]) ? `<ele>${elevations[i].toFixed(1)}</ele>` : ''
      return `      <trkpt lat="${lat.toFixed(6)}" lon="${lon.toFixed(6)}">${ele}</trkpt>`
    })
    .join('\n')

  const waypoints = [
    origin && { ...origin, label: 'Start' },
    dest && { ...dest, label: 'Destination' },
    // Barriers are waypoints on purpose: on a device with no screen for the
    // card, they are the only surviving warning.
    ...(route.blockers ?? []).map((b) => ({
      lat: b.lat,
      lon: b.lon,
      name: b.description,
      label: 'Barrier',
    })),
  ]
    .filter(Boolean)
    .map(
      (w) =>
        `  <wpt lat="${w.lat.toFixed(6)}" lon="${w.lon.toFixed(6)}">\n` +
        `    <name>${esc(w.label)}${w.name ? `: ${esc(w.name)}` : ''}</name>\n` +
        `  </wpt>`,
    )
    .join('\n')

  return `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="Meander" xmlns="http://www.topografix.com/GPX/1/1">
  <metadata>
    <name>${esc(`Meander — ${route.label}`)}</name>
    <desc>${esc(provenanceNote(route))}</desc>
    <time>${new Date().toISOString()}</time>
    <copyright author="OpenStreetMap contributors"><license>https://opendatacommons.org/licenses/odbl/</license></copyright>
  </metadata>
${waypoints}
  <trk>
    <name>${esc(route.label)}</name>
    <desc>${esc(provenanceNote(route))}</desc>
    <trkseg>
${trkpts}
    </trkseg>
  </trk>
</gpx>
`
}

/** GeoJSON: the line, plus each barrier as its own feature. */
export function toGeoJson(route) {
  return JSON.stringify(
    {
      type: 'FeatureCollection',
      features: [
        {
          type: 'Feature',
          geometry: { type: 'LineString', coordinates: route.geometry ?? [] },
          properties: {
            name: route.label,
            id: route.id,
            duration_min: route.duration_min,
            distance_m: route.distance_m,
            mode: route.mode,
            status: route.status,
            // The provenance fields travel too. A number without them is a
            // number this project does not want anybody quoting.
            scoring_method: route.scoring_method,
            synthetic_upstream: route.synthetic_upstream ?? false,
            accessibility_coverage: route.confidence,
            note: provenanceNote(route),
            attribution: 'Route data © OpenStreetMap contributors, ODbL',
          },
        },
        ...(route.blockers ?? []).map((b) => ({
          type: 'Feature',
          geometry: { type: 'Point', coordinates: [b.lon, b.lat] },
          properties: { kind: 'barrier', type: b.type, description: b.description },
        })),
      ],
    },
    null,
    2,
  )
}

export function download(filename, contents, mime) {
  const blob = new Blob([contents], { type: mime })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  document.body.appendChild(link)
  link.click()
  link.remove()
  // Revoked on the next tick rather than immediately: Safari has not finished
  // reading the blob when click() returns.
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

export const downloadGpx = (route, ctx) =>
  download(`${safeName(route)}.gpx`, toGpx(route, ctx), 'application/gpx+xml')

export const downloadGeoJson = (route) =>
  download(`${safeName(route)}.geojson`, toGeoJson(route), 'application/geo+json')

/**
 * Hand off to a maps app for turn-by-turn.
 *
 * ⚠ **This is a different route from the one on screen**, and the UI has to say
 * so. Google and Apple both re-plan from the waypoints with their own engine,
 * so none of Meander's steering survives: not the greenery, and — the part that
 * matters — not the accessibility constraints. Sending someone to Apple Maps
 * from a route Meander rejected for steps would hand them the steps back.
 *
 * Waypoints are sampled rather than sent whole because both services cap them
 * (Google at ~10, Apple lower), and an over-long URL is silently truncated,
 * which would quietly change the route again.
 */
export function sampleWaypoints(geometry, max = 8) {
  const points = geometry ?? []
  if (points.length <= max) return points
  const step = (points.length - 1) / (max - 1)
  return Array.from({ length: max }, (_, i) => points[Math.round(i * step)])
}

const MODE_PARAM = { foot: 'walking', bike: 'bicycling', car: 'driving' }

export function googleMapsUrl(route) {
  const points = sampleWaypoints(route.geometry, 10)
  if (points.length < 2) return null
  const [oLon, oLat] = points[0]
  const [dLon, dLat] = points[points.length - 1]
  const via = points.slice(1, -1).map(([lon, lat]) => `${lat},${lon}`)

  const params = new URLSearchParams({
    api: '1',
    origin: `${oLat},${oLon}`,
    destination: `${dLat},${dLon}`,
    travelmode: MODE_PARAM[route.mode] ?? 'walking',
  })
  if (via.length) params.set('waypoints', via.join('|'))
  return `https://www.google.com/maps/dir/?${params.toString()}`
}

const APPLE_MODE = { foot: 'w', bike: 'w', car: 'd' } // Apple has no cycling flag

export function appleMapsUrl(route) {
  const points = sampleWaypoints(route.geometry, 2)
  if (points.length < 2) return null
  const [oLon, oLat] = points[0]
  const [dLon, dLat] = points[points.length - 1]
  const params = new URLSearchParams({
    saddr: `${oLat},${oLon}`,
    daddr: `${dLat},${dLon}`,
    dirflg: APPLE_MODE[route.mode] ?? 'w',
  })
  return `https://maps.apple.com/?${params.toString()}`
}
