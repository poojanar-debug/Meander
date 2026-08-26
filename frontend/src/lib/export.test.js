import { describe, expect, it } from 'vitest'

import { confidenceSentence } from './format.js'
import {
  appleMapsUrl,
  exportStamp,
  googleMapsUrl,
  provenanceNote,
  sampleWaypoints,
  toGeoJson,
  toGpx,
} from './export.js'

// Node environment — no document, no DOMParser, no URL.createObjectURL. Every
// function here is pure by design; `download` and its two wrappers are the
// exception and are deliberately untested rather than dragging jsdom into a
// four-devDependency project.

const NOW = new Date('2026-08-08T09:30:00Z')

const fastest = {
  id: 'fastest',
  label: 'Fastest',
  status: 'ok',
  mode: 'foot',
  duration_min: 18,
  distance_m: 2600,
  confidence: 0.88,
  scoring_method: 'clip',
  geometry: [
    [79.85008, 6.933727],
    [79.851, 6.9345],
    [79.852, 6.9351],
    [79.8531, 6.9362],
  ],
  blockers: [],
  rest_stops: [{ type: 'bench', at_m: 900 }],
  scores: { scenic: 0.31, air: 0.62, shade: 0.2, quiet: 0.44 },
  steps: [{ text: 'Head north', distance_m: 120 }],
}

const scenic = {
  ...fastest,
  id: 'scenic',
  label: 'Scenic',
  mode: 'bike',
  confidence: 0.72,
  blockers: [
    { type: 'steps', lat: 6.9345, lon: 79.851, description: 'Six steps, no ramp' },
  ],
  rest_stops: [
    { type: 'bench', at_m: 340 },
    { type: 'toilets', at_m: 900 },
    { type: 'water', at_m: 1500 },
  ],
}

const blocked = {
  ...fastest,
  id: 'accessible',
  label: 'Accessible',
  status: 'blocked',
  status_note: 'A kerb over the limit blocks this route.',
  scoring_method: 'geometry_only',
  scores: { scenic: 0.4, air: 0.5, shade: null, quiet: null },
  confidence: 0.44,
}

const placeholder = { ...fastest, scoring_method: 'placeholder', confidence: 0.9 }
const unknown = { ...fastest, confidence: null, rest_stops: null, scoring_method: null }
const elevated = {
  ...fastest,
  elevation: {
    ascent_m: 66.2,
    descent_m: 68.7,
    max_gradient_pct: 8.4,
    steep_spans: [[42, 48]],
    limit_pct: 8,
  },
}

/** A ~15-line stack scanner. Enough to prove balance without a parser. */
function wellFormed(xml) {
  const stack = []
  const tag = /<\/?([a-zA-Z][\w:-]*)[^>]*?(\/?)>/g
  let match
  while ((match = tag.exec(xml)) !== null) {
    const [whole, name, selfClose] = match
    if (whole.startsWith('<?') || whole.startsWith('<!')) continue
    if (selfClose === '/') continue
    if (whole.startsWith('</')) {
      if (stack.pop() !== name) return `unbalanced at </${name}>`
    } else {
      stack.push(name)
    }
  }
  return stack.length === 0 ? true : `unclosed: ${stack.join(', ')}`
}

describe('provenanceNote', () => {
  it.each([
    ['fastest', fastest],
    ['scenic', scenic],
    ['blocked', blocked],
  ])('carries the same confidence sentence the screen shows (%s)', (_name, route) => {
    // By construction, not by coincidence: both call confidenceSentence.
    expect(provenanceNote(route)).toContain(
      confidenceSentence(route.confidence, route.scoring_method, route.confidence_note).text,
    )
  })

  it('never states a percentage for a placeholder-scored route', () => {
    // The regression that matters. The source computed its own coverage clause
    // and exported "covers 90%" for exactly this route, while the screen said
    // it had not been evaluated.
    const note = provenanceNote(placeholder)
    expect(note).toContain('has not been evaluated')
    expect(note).not.toMatch(/\d+%/)
  })

  it("prefers the server's own wording when it sends one", () => {
    const note = provenanceNote({ ...fastest, confidence_note: 'Checked on foot last Tuesday.' })
    expect(note).toContain('Checked on foot last Tuesday.')
    expect(note).not.toContain('Accessibility data covers')
  })

  it('does not turn unknown coverage into 0%', () => {
    // Carried as a known deviation for exactly one commit. Special-casing it
    // here would have broken the property the delegation exists for, so it was
    // fixed in format.js instead — which corrects the sentence on screen at the
    // same time. The file and the screen still cannot drift apart, and neither
    // of them now reports a measurement of nought for a route nobody measured.
    const note = provenanceNote(unknown)
    expect(note).toContain(confidenceSentence(unknown.confidence, unknown.scoring_method).text)
    expect(note).not.toMatch(/\d+%/)
    expect(note).toContain('unknown')
  })

  it('still reports GeoJSON coverage as null rather than zero', () => {
    // The machine-readable field always carried the distinction; now the prose
    // does too.
    expect(JSON.parse(toGeoJson(unknown)).features[0].properties.accessibility_coverage).toBeNull()
  })

  it('answers rest stops three different ways', () => {
    const notChecked = provenanceNote(unknown)
    expect(notChecked).toContain('not checked')
    expect(notChecked).not.toContain('No rest stops found')

    const none = provenanceNote({ ...fastest, rest_stops: [] })
    expect(none).toContain('No rest stops found')
    expect(none).not.toContain('not checked')

    const some = provenanceNote(scenic)
    expect(some).toContain('3 rest stops')
    expect(some).not.toContain('not checked')
    expect(some).not.toContain('No rest stops found')
  })

  it('says so when enrichment was still running', () => {
    // Otherwise a mid-stream export bakes "No rest stops found" into a file
    // that outlives the session, which is the one claim this must not make.
    const note = provenanceNote({ ...fastest, enrichment_pending: true, rest_stops: [] })
    expect(note).toContain('still being checked')
    expect(note).not.toContain('No rest stops found')
  })

  it('names every score that was not measured', () => {
    const note = provenanceNote(blocked)
    expect(note).toContain('Shade, Quiet: not measured.')
  })

  it('lists the quiet score and says nothing about it when it was measured', () => {
    // `quiet` is the fourth field on `Scores` and the newest way for this note
    // to go quietly out of date: a key missing from SCORE_LABEL is a null the
    // file never mentions, and a consumer who sees no mention assumes.
    expect(provenanceNote({ ...fastest, scores: { ...fastest.scores, quiet: null } })).toContain(
      'Quiet: not measured.',
    )
    expect(provenanceNote(fastest)).not.toContain('not measured')
  })

  it('shouts about demonstration data', () => {
    expect(provenanceNote({ ...fastest, synthetic_upstream: true })).toContain(
      'BUILT FROM DEMONSTRATION DATA',
    )
  })

  it('says a blocked route was rejected', () => {
    expect(provenanceNote(blocked)).toContain('rejected by the accessibility constraints')
  })

  it('quotes the gradient limit from the payload, never a literal', () => {
    const note = provenanceNote(elevated)
    expect(note).toContain('8.4%')
    expect(note).toContain('8% limit')

    // With no limit on the wire, none is invented.
    const { limit_pct, ...withoutLimit } = elevated.elevation
    const bare = provenanceNote({ ...elevated, elevation: withoutLimit })
    expect(bare).toContain('8.4%')
    expect(bare).not.toContain('limit')
  })

  it.each([
    ['fastest', fastest],
    ['scenic', scenic],
    ['blocked', blocked],
    ['unknown', unknown],
  ])('ends with the ODbL attribution (%s)', (_name, route) => {
    expect(provenanceNote(route).endsWith('Route data © OpenStreetMap contributors, ODbL.')).toBe(
      true,
    )
  })
})

describe('toGpx', () => {
  const places = { origin: { lat: 6.933727, lon: 79.85008 }, dest: { lat: 6.9362, lon: 79.8531 } }

  it('is a track, not a route', () => {
    const gpx = toGpx(scenic, places, NOW)
    expect(gpx).toContain('<trk>')
    expect(gpx).not.toContain('<rte')
  })

  it('carries the note twice — in the metadata and on the track', () => {
    // Counting <desc> elements would be wrong: a barrier waypoint carries one
    // too. Count the note itself.
    const gpx = toGpx(scenic, places, NOW)
    const note = provenanceNote(scenic)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&apos;')
    expect(gpx.split(`<desc>${note}</desc>`)).toHaveLength(3) // two occurrences
  })

  it('escapes every XML metacharacter in a barrier description', () => {
    const hostile = {
      ...scenic,
      blockers: [
        {
          type: 'steps',
          lat: 6.9345,
          lon: 79.851,
          description: `A & B < C > D " E ' F`,
        },
      ],
    }
    const gpx = toGpx(hostile, places, NOW)
    const body = gpx.slice(gpx.indexOf('<wpt'), gpx.indexOf('</wpt>'))
    expect(body).not.toMatch(/ & /)
    expect(body).not.toMatch(/ < /)
    expect(gpx).toContain('&amp;')
    expect(gpx).toContain('&lt;')
    expect(gpx).toContain('&gt;')
    expect(gpx).toContain('&quot;')
    expect(gpx).toContain('&apos;')
  })

  it('emits no elevation, even when the route has a profile', () => {
    // The geometry has no third ordinate and the profile is thinned and capped,
    // so a per-vertex height would be invented rather than measured.
    expect(toGpx(elevated, places, NOW)).not.toContain('<ele')
  })

  it('puts latitude and longitude the right way round', () => {
    const gpx = toGpx(scenic, places, NOW)
    const points = [...gpx.matchAll(/<trkpt lat="([^"]+)" lon="([^"]+)"/g)]
    expect(points).toHaveLength(scenic.geometry.length)
    points.forEach(([, lat, lon], i) => {
      expect(Number(lat)).toBeCloseTo(scenic.geometry[i][1], 6)
      expect(Number(lon)).toBeCloseTo(scenic.geometry[i][0], 6)
    })
  })

  it('emits one waypoint per barrier, plus start and destination', () => {
    const gpx = toGpx(scenic, places, NOW)
    expect(gpx.match(/<wpt /g)).toHaveLength(scenic.blockers.length + 2)
    expect(gpx).toContain('Six steps, no ramp')
    expect(gpx).toContain('<name>steps</name>')
  })

  it('is well-formed, declared 1.1, and orders waypoints before the track', () => {
    const gpx = toGpx(scenic, places, NOW)
    expect(wellFormed(gpx)).toBe(true)
    expect(gpx).toContain('version="1.1"')
    expect(gpx).toContain('xmlns="http://www.topografix.com/GPX/1/1"')
    expect(gpx.lastIndexOf('<wpt ')).toBeLessThan(gpx.indexOf('<trk>'))
  })

  it('reads the clock once', () => {
    const gpx = toGpx(scenic, places, NOW)
    expect(gpx).toContain('<time>2026-08-08T09:30:00.000Z</time>')
  })
})

describe('toGeoJson', () => {
  it('parses, with the line as the first feature', () => {
    const parsed = JSON.parse(toGeoJson(scenic))
    expect(parsed.type).toBe('FeatureCollection')
    expect(parsed.features[0].geometry.type).toBe('LineString')
    expect(parsed.features[0].geometry.coordinates).toEqual(scenic.geometry)
  })

  it('gives each barrier its own Point feature', () => {
    const parsed = JSON.parse(toGeoJson(scenic))
    expect(parsed.features).toHaveLength(scenic.blockers.length + 1)
    for (const feature of parsed.features.slice(1)) {
      expect(feature.geometry.type).toBe('Point')
      expect(feature.properties.kind).toBe('barrier')
    }
  })

  it('puts the note on every feature, barriers included', () => {
    const parsed = JSON.parse(toGeoJson(scenic))
    const note = provenanceNote(scenic)
    for (const feature of parsed.features) {
      expect(feature.properties.note).toBe(note)
    }
  })

  it('reports unknown coverage as null, never as zero', () => {
    const parsed = JSON.parse(toGeoJson(unknown))
    expect(parsed.features[0].properties.accessibility_coverage).toBeNull()
    expect(parsed.features[0].properties.accessibility_coverage).not.toBe(0)
  })
})

describe('the maps handoff', () => {
  it('caps Google at ten points and sets the travel mode', () => {
    const long = { ...scenic, geometry: Array.from({ length: 60 }, (_, i) => [79.85 + i / 1000, 6.93]) }
    const url = new URL(googleMapsUrl(long))
    const via = url.searchParams.get('waypoints')?.split('|') ?? []
    expect(via.length + 2).toBeLessThanOrEqual(10)
    expect(url.searchParams.get('travelmode')).toBe('bicycling')
    expect(new URL(googleMapsUrl({ ...scenic, mode: 'hovercraft' })).searchParams.get('travelmode')).toBe(
      'walking',
    )
  })

  it('returns nothing below two points', () => {
    expect(googleMapsUrl({ ...scenic, geometry: [[0, 0]] })).toBeNull()
    expect(appleMapsUrl({ ...scenic, geometry: [[0, 0]] })).toBeNull()
  })

  it('gives Apple the endpoints only, because its scheme has no via points', () => {
    const url = new URL(appleMapsUrl(scenic))
    expect([...url.searchParams.keys()].sort()).toEqual(['daddr', 'dirflg', 'saddr'])
    expect(url.searchParams.get('waypoints')).toBeNull()
    expect(url.searchParams.get('dirflg')).toBe('w')
    expect(url.searchParams.get('saddr')).toBe('6.933727,79.85008')
  })
})

describe('sampleWaypoints', () => {
  it('keeps both ends', () => {
    const geometry = Array.from({ length: 50 }, (_, i) => [i, i])
    const sampled = sampleWaypoints(geometry, 8)
    expect(sampled).toHaveLength(8)
    expect(sampled.at(0)).toEqual(geometry.at(0))
    expect(sampled.at(-1)).toEqual(geometry.at(-1))
  })

  it('returns a short geometry untouched', () => {
    const geometry = [
      [0, 0],
      [1, 1],
    ]
    expect(sampleWaypoints(geometry, 8)).toBe(geometry)
  })
})

describe('exportStamp', () => {
  it('reads the clock once, so the name and the contents cannot disagree', () => {
    const { filename, isoTime } = exportStamp(scenic, NOW)
    expect(filename).toMatch(/^meander-[a-z0-9-]+-\d{4}-\d{2}-\d{2}$/)
    expect(filename.endsWith(isoTime.slice(0, 10))).toBe(true)
  })
})
