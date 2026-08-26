/**
 * Fixture API, used only when VITE_MOCK_API=1.
 *
 * Gated on that flag on purpose so a demo can never silently run on fixtures:
 * when it is on, the header says so in visible text.
 *
 * It exercises the streaming path exactly as the real backend does — four
 * progress events over ~2.2 s, one route every ~420 ms, then a narration pass
 * at +700 ms — and it includes the required blocked-accessible fixture with
 * confidence 0.41 and two blockers.
 */

import { deriveMode, deriveModeForDistance } from '../lib/format.js'

const COLOMBO = { lat: 6.9271, lon: 79.8612 }

/** The length the point-to-point fixtures were drawn at, before a real
 *  destination started setting it. Durations are still expressed as a
 *  multiple of it so the six routes keep their relative shape. */
const BASE_TRIP_M = 2100

const sleep = (ms, signal) =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException('Aborted', 'AbortError'))
      return
    }
    const timer = setTimeout(resolve, ms)
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer)
        reject(new DOMException('Aborted', 'AbortError'))
      },
      { once: true },
    )
  })

/**
 * Crow-flight bearing and length from one point to another, in the same flat
 * approximation `polyline` below undoes.
 *
 * This is what makes a demo destination a destination. Before it, the mock
 * drew every point-to-point route on a fixed bearing of 22° at a fixed
 * length, so the line went nowhere near the place the user had picked and the
 * feature looked broken on the one build that ships without a backend.
 */
function aimAt(origin, dest) {
  const dNorth = (dest.lat - origin.lat) * 111320
  const dEast = (dest.lon - origin.lon) * 111320 * Math.cos((origin.lat * Math.PI) / 180)
  return {
    bearingDeg: (Math.atan2(dEast, dNorth) * 180) / Math.PI,
    lengthM: Math.hypot(dNorth, dEast),
  }
}

/** Deterministic wiggly polyline, so a given route id always looks the same. */
function polyline(origin, bearingDeg, lengthM, bow, points = 48) {
  const rad = (bearingDeg * Math.PI) / 180
  const north = Math.cos(rad)
  const east = Math.sin(rad)
  const out = []
  for (let i = 0; i < points; i += 1) {
    const t = i / (points - 1)
    const along = lengthM * t
    const across = bow * Math.sin(Math.PI * t) * lengthM
    const dNorth = north * along - east * across
    const dEast = east * along + north * across
    const lat = origin.lat + dNorth / 111320
    const lon = origin.lon + dEast / (111320 * Math.cos((origin.lat * Math.PI) / 180))
    out.push([Number(lon.toFixed(6)), Number(lat.toFixed(6))])
  }
  return out
}

function loop(origin, radiusM, lobes, points = 60) {
  const out = []
  for (let i = 0; i <= points; i += 1) {
    const theta = (2 * Math.PI * i) / points
    const r = radiusM * (1 + 0.18 * Math.sin(lobes * theta))
    const dNorth = r * Math.cos(theta) - radiusM
    const dEast = r * Math.sin(theta)
    const lat = origin.lat + dNorth / 111320
    const lon = origin.lon + dEast / (111320 * Math.cos((origin.lat * Math.PI) / 180))
    out.push([Number(lon.toFixed(6)), Number(lat.toFixed(6))])
  }
  out[out.length - 1] = out[0]
  return out
}

/** Great-circle length of a [lon, lat] polyline, in metres. */
function lengthOf(geometry) {
  const R = 6371000
  const rad = Math.PI / 180
  let total = 0
  for (let i = 1; i < geometry.length; i += 1) {
    const [lon1, lat1] = geometry[i - 1]
    const [lon2, lat2] = geometry[i]
    const dLat = (lat2 - lat1) * rad
    const dLon = (lon2 - lon1) * rad
    const h =
      Math.sin(dLat / 2) ** 2 +
      Math.sin(dLon / 2) ** 2 * Math.cos(lat1 * rad) * Math.cos(lat2 * rad)
    total += 2 * R * Math.asin(Math.min(1, Math.sqrt(h)))
  }
  return total
}

function pointAt(geometry, fraction) {
  const idx = Math.min(geometry.length - 1, Math.floor(geometry.length * fraction))
  const [lon, lat] = geometry[idx]
  return { lat, lon }
}

/**
 * A plausible turn list spanning the whole geometry.
 *
 * The real backend passes GraphHopper's instruction array straight through;
 * this mirrors its shape so the step list, the map highlight and the in-step
 * barrier placement can all be exercised with no backend at all. The intervals
 * tile the point array end to end with no gaps and no overlaps, which is the
 * property the frontend relies on to map a step back onto a stretch of line.
 */
function steps(geometry, distanceM, durationMin, streets) {
  const n = geometry.length
  if (n < 2) return []
  const count = Math.max(2, Math.min(streets.length, Math.floor(n / 5)))
  const out = []
  for (let i = 0; i < count; i += 1) {
    const start = Math.floor((i * (n - 1)) / count)
    const end = Math.floor(((i + 1) * (n - 1)) / count)
    const share = (end - start) / (n - 1)
    const turn = i === 0 ? 'Continue' : ['Turn left', 'Turn right', 'Keep left', 'Bear right'][i % 4]
    const street = streets[i % streets.length]
    out.push({
      text: `${turn} onto ${street}`,
      distance_m: Math.round(distanceM * share),
      duration_min: Number((durationMin * share).toFixed(2)),
      street_name: street,
      sign: i === 0 ? 0 : 2,
      interval: [start, end],
    })
  }
  out.push({
    text: 'Arrive at your destination',
    distance_m: 0,
    duration_min: 0,
    street_name: null,
    sign: 4,
    interval: [n - 1, n - 1],
  })
  return out
}

/**
 * The six fixture routes for one request, one per objective.
 *
 * Exported for the test suite only — nothing but `mockFetchRoutes` below calls
 * it in the app. The suite needs it directly because the streaming path it
 * normally arrives through takes about four seconds of real timers to deliver
 * a route, and what is worth asserting here is the geometry, not the cadence.
 */
export function buildRoutes(req) {
  const origin = req.origin ?? COLOMBO
  const dest = req.destination ?? null
  const isLoop = !dest
  const minutes = req.minutes ?? 35
  // `polyline` puts its bow at zero at t=1, so every one of these ends on the
  // destination however far they wander on the way. That is the property the
  // map, the arrival latch and the last step all read.
  const aim = dest ? aimAt(origin, dest) : null
  // The dial does not describe a trip with a destination and does not scale
  // one: `buildRouteRequest` does not even send it. The trip is as long as
  // the distance makes it. Floored so a destination on top of the origin
  // still yields a drawable line rather than 48 identical points.
  const scale = isLoop ? minutes / 35 : Math.max(0.1, aim.lengthM / BASE_TRIP_M)
  // Must agree with `effectiveMode` in lib/format.js, which reads the straight
  // line once there is a destination and the budget when there is not. The
  // constants are imported rather than restated for exactly that reason.
  const mode =
    req.mode === 'auto'
      ? isLoop
        ? deriveMode(minutes)
        : deriveModeForDistance(aim.lengthM)
      : req.mode

  const fastestGeom = isLoop
    ? loop(origin, 420 * scale, 0)
    : polyline(origin, aim.bearingDeg, aim.lengthM, 0.02)
  const scenicGeom = isLoop
    ? loop(origin, 520 * scale, 3)
    : polyline(origin, aim.bearingDeg, aim.lengthM, 0.22)
  const accessibleGeom = isLoop
    ? loop(origin, 380 * scale, 0)
    : polyline(origin, aim.bearingDeg, aim.lengthM, -0.09)
  // Six distinct shapes, not three drawn twice. The rail, the map legend and
  // the screenshot demo all read six lines at once, and two objectives sharing
  // a polyline would look like the picker doing nothing.
  const quietGeom = isLoop
    ? loop(origin, 470 * scale, 2)
    : polyline(origin, aim.bearingDeg, aim.lengthM, 0.14)
  const shadeGeom = isLoop
    ? loop(origin, 560 * scale, 4)
    : polyline(origin, aim.bearingDeg, aim.lengthM, -0.28)
  const airGeom = isLoop
    ? loop(origin, 610 * scale, 5)
    : polyline(origin, aim.bearingDeg, aim.lengthM, 0.34)

  // Distances are measured from the drawn geometry rather than declared
  // separately. When they disagreed, the rail said 1.4 km and follow mode's
  // progress said 2.6 km for the same walk — real routing data never does that,
  // so the mock should not either.
  const fastestM = Math.round(lengthOf(fastestGeom))
  const scenicM = Math.round(lengthOf(scenicGeom))
  const accessibleM = Math.round(lengthOf(accessibleGeom))
  const quietM = Math.round(lengthOf(quietGeom))
  const shadeM = Math.round(lengthOf(shadeGeom))
  const airM = Math.round(lengthOf(airGeom))

  // Route.elevation, in the shape backend/models.py:99-116 defines. The first
  // three routes deliberately cover the three states the profile has to keep
  // apart, the same way the nulls below cover them for scores:
  //
  //   fastest      measured, nothing over the limit
  //   scenic       measured, two stretches over it — the hatched case
  //   accessible   null, meaning the router returned no elevation, which is
  //                NOT the same statement as "this route is level"
  //
  // Without a null anywhere in the mock, the honest-absence branch would never
  // render and the sentence that distinguishes it could rot unnoticed.
  const profile = (totalM, relief, steepSpans) => {
    const n = 60
    const distances_m = Array.from({ length: n }, (_, i) => Math.round((totalM * i) / (n - 1)))
    const elevations_m = distances_m.map(
      (_, i) => Math.round((8 + relief * Math.sin((i / (n - 1)) * Math.PI * 1.7)) * 10) / 10,
    )
    let ascent = 0
    let descent = 0
    for (let i = 1; i < elevations_m.length; i += 1) {
      const d = elevations_m[i] - elevations_m[i - 1]
      if (d > 0) ascent += d
      else descent -= d
    }
    return {
      distances_m,
      elevations_m,
      ascent_m: Math.round(ascent * 10) / 10,
      descent_m: Math.round(descent * 10) / 10,
      max_gradient_pct: steepSpans.length ? 11.4 : 4.2,
      steep_spans: steepSpans,
      limit_pct: 8,
    }
  }

  const fastest = {
    id: 'fastest',
    label: 'Fastest',
    status: 'ok',
    geometry: fastestGeom,
    duration_min: Math.round(18 * scale),
    distance_m: fastestM,
    mode,
    scores: { scenic: 0.31, air: 0.62, shade: 0.2, quiet: 0.18 },
    elevation: profile(fastestM, 6, []),
    scoring_method: 'clip',
    confidence: 0.88,
    rest_stops: [{ ...pointAt(fastestGeom, 0.12), type: 'bench', at_m: 180 }],
    steps: steps(fastestGeom, fastestM, 18 * scale, [
      'Galle Road',
      'Chatham Street',
      'York Street',
      'Main Street',
    ]),
    blockers: [],
    narration: null,
    synthetic_upstream: false,
    confidence_note: 'Accessibility data covers 88% of this route.',
    status_note: null,
  }

  const scenic = {
    id: 'scenic',
    label: 'Scenic',
    status: 'ok',
    geometry: scenicGeom,
    duration_min: Math.round(26 * scale),
    distance_m: scenicM,
    mode,
    scores: { scenic: 0.79, air: 0.71, shade: 0.58, quiet: 0.52 },
    elevation: profile(scenicM, 24, [[12, 19], [38, 44]]),
    scoring_method: 'clip',
    confidence: 0.72,
    rest_stops: [
      { ...pointAt(scenicGeom, 0.18), type: 'bench', at_m: 340 },
      { ...pointAt(scenicGeom, 0.46), type: 'drinking water', at_m: 910 },
      { ...pointAt(scenicGeom, 0.78), type: 'bench', at_m: 1580 },
    ],
    steps: steps(scenicGeom, scenicM, 26 * scale, [
      'Green Path',
      'Lake Walk',
      'Park Lane',
      'Cinnamon Gardens',
    ]),
    // A barrier on a route that is still walkable. The backend reports
    // accessibility findings on every preset, not only `accessible` — someone
    // on foot may well take a route with a kerb on it and should still be told
    // it is there. This is what follow mode's 200 m proximity alert is for.
    blockers: [
      {
        type: 'kerb',
        ...pointAt(scenicGeom, 0.55),
        description: 'Dropped kerb missing where the path crosses the service road.',
      },
    ],
    narration: null,
    synthetic_upstream: false,
    confidence_note: 'Accessibility data covers 72% of this route.',
    status_note: null,
  }

  // The required blocked fixture: a real route that a wheelchair user cannot
  // take. It keeps its geometry and its scores; only `status` differs.
  const accessible = {
    id: 'accessible',
    label: 'Accessible',
    status: 'blocked',
    geometry: accessibleGeom,
    duration_min: Math.round(22 * scale),
    distance_m: accessibleM,
    mode,
    // The two nulls are deliberate and this is the only fixture carrying any.
    // A null score means "we did not measure this"; a 0 means "we measured it
    // and it is zero". They are different statements and the UI must never
    // render them alike — null gets the words "not measured", 0 gets a real,
    // empty bar. Without a null anywhere in the mock that branch was never
    // seen, and the quiet row is the newest place it can go unseen.
    scores: { scenic: 0.44, air: 0.65, shade: null, quiet: null },
    // null, not a flat profile — see the note beside `profile` above.
    elevation: null,
    scoring_method: 'geometry_only',
    confidence: 0.41,
    rest_stops: [{ ...pointAt(accessibleGeom, 0.3), type: 'bench', at_m: 520 }],
    // Both blockers below fall inside one of these steps, which is what
    // exercises the in-step barrier placement — the point of the feature.
    steps: steps(accessibleGeom, accessibleM, 22 * scale, [
      'Canal Walk',
      'Green Path',
      'Station Road',
      'Beach Drive',
    ]),
    blockers: [
      {
        type: 'steps',
        ...pointAt(accessibleGeom, 0.38),
        description: 'Three steps at the canal crossing, no ramp and no alternative nearby.',
      },
      {
        type: 'surface',
        ...pointAt(accessibleGeom, 0.66),
        description: 'About 40 m of loose gravel where the path leaves the park.',
      },
    ],
    narration: null,
    synthetic_upstream: false,
    confidence_note:
      'Accessibility data covers 41% of this route; treat the remainder as unverified.',
    status_note: 'Two barriers on this route cannot be avoided with the current road data.',
  }

  // The three objectives that spent a release as disabled chips. Each carries
  // a note in the shape the backend sends with its preset: these steer on
  // OpenStreetMap way tags, which is a proxy for quiet, shade and clean air
  // rather than a measurement of any of them, and the detail panel is the only
  // place a user is told so.
  //
  // ⚠ The wording tracks `routing.PRESET_NOTES` rather than paraphrasing it.
  // The first draft of the shade note here said shade was inferred "from tree
  // and land use tags", which names a source the backend explicitly says it
  // does not have — a demo that invents a data source is the same false claim
  // as a score that invents a measurement, and harder to catch because nothing
  // downstream reads the string.
  const quiet = {
    id: 'quiet',
    label: 'Quiet',
    status: 'ok',
    geometry: quietGeom,
    duration_min: Math.round(24 * scale),
    distance_m: quietM,
    mode,
    scores: { scenic: 0.55, air: 0.6, shade: 0.41, quiet: 0.86 },
    elevation: profile(quietM, 12, []),
    scoring_method: 'geometry_only',
    confidence: 0.66,
    rest_stops: [
      { ...pointAt(quietGeom, 0.24), type: 'bench', at_m: 460 },
      { ...pointAt(quietGeom, 0.71), type: 'drinking water', at_m: 1420 },
    ],
    steps: steps(quietGeom, quietM, 24 * scale, [
      'Barnes Place',
      'Guildford Crescent',
      'Rosmead Place',
      'Horton Place',
    ]),
    blockers: [],
    narration: null,
    synthetic_upstream: false,
    confidence_note: 'Accessibility data covers 66% of this route.',
    status_note:
      'Quiet is inferred from the kind of way this route follows, mostly how much motor traffic its streets carry. Nobody has measured the noise on it.',
  }

  const shade = {
    id: 'shade',
    label: 'Shade',
    status: 'ok',
    geometry: shadeGeom,
    duration_min: Math.round(28 * scale),
    distance_m: shadeM,
    mode,
    scores: { scenic: 0.68, air: 0.64, shade: 0.9, quiet: 0.47 },
    elevation: profile(shadeM, 18, [[22, 27]]),
    scoring_method: 'clip',
    confidence: 0.81,
    // Looked, found none. The empty list and the null on `air` below are the
    // two halves of a distinction the UI states in words, and neither had a
    // fixture behind it until these three arrived.
    rest_stops: [],
    steps: steps(shadeGeom, shadeM, 28 * scale, [
      'Ward Place',
      'Cinnamon Gardens',
      'Independence Avenue',
      'Reid Avenue',
    ]),
    blockers: [],
    narration: null,
    synthetic_upstream: false,
    confidence_note: 'Accessibility data covers 81% of this route.',
    status_note:
      'Tree cover is not something a route can be planned from. This route prefers the kinds of way that tend to be shaded, and avoids bridges, which never are.',
  }

  const air = {
    id: 'air',
    label: 'Clean air',
    status: 'ok',
    geometry: airGeom,
    duration_min: Math.round(31 * scale),
    distance_m: airM,
    mode,
    scores: { scenic: 0.5, air: 0.88, shade: 0.33, quiet: 0.61 },
    elevation: profile(airM, 9, []),
    scoring_method: 'geometry_only',
    confidence: 0.58,
    // Could not look. Not the same answer as the empty list above.
    rest_stops: null,
    steps: steps(airGeom, airM, 31 * scale, [
      'Marine Drive',
      'Bambalapitiya Flats',
      'Station Passage',
      'Sea Avenue',
    ]),
    blockers: [],
    narration: null,
    synthetic_upstream: false,
    confidence_note: 'Accessibility data covers 58% of this route.',
    status_note:
      'Clean air here means keeping away from motor traffic and out of tunnels. The air quality reading on the card covers the whole area, not this pavement.',
  }

  const byId = { fastest, scenic, accessible, quiet, shade, air }
  const requested = req.objectives?.length ? req.objectives : ['fastest', 'scenic', 'accessible']
  return requested.map(
    (id) =>
      // Every objective in the table above has a fixture, so reaching this
      // means the id is not one of them — a hand-edited permalink, or a stale
      // client. Nulls rather than zeros throughout: nothing routed this and
      // nothing scored it, and a zero is a measurement.
      byId[id] ?? {
        id,
        label: id[0].toUpperCase() + id.slice(1),
        status: 'blocked',
        geometry: [],
        duration_min: 0,
        distance_m: 0,
        mode,
        scores: { scenic: null, air: null, shade: null, quiet: null },
        scoring_method: 'placeholder',
        confidence: null,
        rest_stops: null,
        blockers: [],
        narration: null,
        synthetic_upstream: false,
        confidence_note: null,
        status_note: `Meander has no objective called ${id}, so there is nothing here to route for it.`,
      },
  )
}

const NARRATION = {
  fastest:
    'Straight up the main road. Loud and treeless, but it is the shortest way there and the pavement is wide the whole distance.',
  scenic:
    'Cuts east into the park after four minutes and stays under trees almost to the end. Two benches on the way, and a water fountain roughly half way.',
  accessible:
    'Follows quiet residential streets with dropped kerbs until the canal crossing, where three steps stop it. Nothing in the road data offers a way around.',
  quiet:
    'Leaves the main road at the first junction and stays on residential streets the whole way. Two crossings, both signalled, and a water fountain about two thirds along.',
  shade:
    'Hugs the tree line through the gardens rather than taking the direct way, which is what makes it longer. No benches anywhere on it, so plan a stop before you set off.',
  air:
    'Keeps a block back from the arterial road for most of its length and finishes along the sea front. Rest stops were not checked here.',
}

export async function mockFetchRoutes(req, { signal, onProgress, onRoute } = {}) {
  const routes = buildRoutes(req)

  const stages = [
    { pct: 10, text: 'Finding routable roads near you', segments_scored: 0 },
    { pct: 35, text: 'Routing three ways through', segments_scored: 1840 },
    { pct: 65, text: 'Scoring scenery from street imagery', segments_scored: 9120 },
    { pct: 90, text: 'Checking surfaces and kerbs', segments_scored: 14203 },
  ]
  for (const stage of stages) {
    await sleep(550, signal)
    onProgress?.({ type: 'progress', ...stage })
  }

  for (const route of routes) {
    await sleep(420, signal)
    onRoute?.(route)
  }

  await sleep(700, signal)
  const narrated = routes.map((r) => ({ ...r, narration: NARRATION[r.id] ?? null }))
  narrated.forEach((r) => onRoute?.(r))

  return {
    routes: narrated,
    best_departure: new Date(Date.now() + 45 * 60 * 1000).toISOString(),
    reason: 'Air quality is better and the light is lower in about three quarters of an hour.',
    cache: { segments_scored: 14203, hit_rate: 0.87 },
  }
}

const PLACES = [
  { name: 'Colombo Fort, Colombo, Sri Lanka', lat: 6.9344, lon: 79.8428 },
  { name: 'Viharamahadevi Park, Colombo, Sri Lanka', lat: 6.9147, lon: 79.8612 },
  { name: 'Galle Face Green, Colombo, Sri Lanka', lat: 6.9271, lon: 79.8412 },
  { name: 'Independence Square, Colombo, Sri Lanka', lat: 6.9061, lon: 79.8683 },
  { name: 'Mount Lavinia Beach, Colombo, Sri Lanka', lat: 6.8389, lon: 79.8653 },
  { name: 'Hyde Park, London, United Kingdom', lat: 51.5073, lon: -0.1657 },
  { name: 'Vondelpark, Amsterdam, Netherlands', lat: 52.358, lon: 4.8686 },
]

export async function mockGeocode(q, { signal } = {}) {
  await sleep(220, signal)
  const needle = q.trim().toLowerCase()
  if (!needle) return []
  return PLACES.filter((p) => p.name.toLowerCase().includes(needle)).slice(0, 6)
}

/**
 * The mock counterpart of POST /api/report-barrier.
 *
 * It does not send anything anywhere — that is the point of the mock — but it
 * has to exercise both outcomes, because the failure path is the one carrying
 * the honest message and an unexercised error branch is how that message rots.
 *
 * A description containing "fail" returns the error shape, which is also how
 * the branch gets checked by hand without editing this file.
 */
export async function mockReportBarrier(report, { signal } = {}) {
  await sleep(600, signal)
  if (/fail/i.test(report?.description ?? '')) {
    const err = new Error(
      'The OpenStreetMap development server did not accept that. Nothing was filed.',
    )
    err.kind = 'upstream_unavailable'
    throw err
  }
  return { note_id: 4471 }
}

/**
 * Photos, mocked.
 *
 * Returns no photos, and that is the right mock rather than a lazy one.
 *
 * The alternative is inventing image URLs, and every one of them would either
 * be a real remote image — which makes the offline suite and the offline gate
 * open a socket, the one thing this project checks with `unshare -n` — or a
 * data URI of a fake photograph, which would put a fabricated picture of a
 * place on a screen that is otherwise scrupulous about never showing invented
 * data. `Ribbon` exists precisely because synthetic route geometry has to
 * announce itself; a synthetic photograph could not.
 *
 * So the mock exercises the empty path, which is also the commonest real one:
 * most of the world has no Commons photo within the search radius, and the UI
 * has to be correct when there is nothing to show. The shape matches the real
 * response so the caller cannot tell the difference.
 */
export async function mockFetchPhotos(_body, { signal } = {}) {
  await sleep(180, signal)
  return {
    hero: null,
    strip: [],
    hero_basis: null,
    hero_reason: null,
    objective_measured: false,
    sources_used: [],
    mapillary_enabled: false,
    note: null,
  }
}
