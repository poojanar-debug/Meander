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

const COLOMBO = { lat: 6.9271, lon: 79.8612 }

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

function pointAt(geometry, fraction) {
  const idx = Math.min(geometry.length - 1, Math.floor(geometry.length * fraction))
  const [lon, lat] = geometry[idx]
  return { lat, lon }
}

function buildRoutes(req) {
  const origin = req.origin ?? COLOMBO
  const isLoop = !req.destination
  const minutes = req.minutes ?? 35
  const mode = req.mode === 'auto' ? (minutes <= 45 ? 'foot' : minutes <= 120 ? 'bike' : 'car') : req.mode
  const scale = minutes / 35

  const fastestGeom = isLoop
    ? loop(origin, 420 * scale, 0)
    : polyline(origin, 22, 2100 * scale, 0.02)
  const natureGeom = isLoop
    ? loop(origin, 520 * scale, 3)
    : polyline(origin, 22, 2100 * scale, 0.22)
  const accessibleGeom = isLoop
    ? loop(origin, 380 * scale, 0)
    : polyline(origin, 22, 2100 * scale, -0.09)

  const fastest = {
    id: 'fastest',
    label: 'Fastest',
    status: 'ok',
    geometry: fastestGeom,
    duration_min: Math.round(18 * scale),
    distance_m: Math.round(1450 * scale),
    mode,
    scores: { nature: 0.31, air: 0.62, shade: 0.2 },
    scoring_method: 'clip',
    confidence: 0.88,
    rest_stops: [{ ...pointAt(fastestGeom, 0.12), type: 'bench', at_m: 180 }],
    blockers: [],
    narration: null,
    synthetic_upstream: false,
    confidence_note: 'Accessibility data covers 88% of this route.',
    status_note: null,
  }

  const nature = {
    id: 'nature',
    label: 'Nature',
    status: 'ok',
    geometry: natureGeom,
    duration_min: Math.round(26 * scale),
    distance_m: Math.round(2080 * scale),
    mode,
    scores: { nature: 0.79, air: 0.71, shade: 0.58 },
    scoring_method: 'clip',
    confidence: 0.72,
    rest_stops: [
      { ...pointAt(natureGeom, 0.18), type: 'bench', at_m: 340 },
      { ...pointAt(natureGeom, 0.46), type: 'drinking water', at_m: 910 },
      { ...pointAt(natureGeom, 0.78), type: 'bench', at_m: 1580 },
    ],
    blockers: [],
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
    distance_m: Math.round(1720 * scale),
    mode,
    scores: { nature: 0.44, air: 0.65, shade: 0.31 },
    scoring_method: 'geometry_only',
    confidence: 0.41,
    rest_stops: [{ ...pointAt(accessibleGeom, 0.3), type: 'bench', at_m: 520 }],
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

  const byId = { fastest, nature, accessible }
  const requested = req.objectives?.length ? req.objectives : ['fastest', 'nature', 'accessible']
  return requested.map(
    (id) =>
      byId[id] ?? {
        id,
        label: id[0].toUpperCase() + id.slice(1),
        status: 'blocked',
        geometry: [],
        duration_min: 0,
        distance_m: 0,
        mode,
        scores: { nature: 0, air: 0, shade: 0 },
        scoring_method: 'placeholder',
        confidence: 0,
        rest_stops: [],
        blockers: [],
        narration: null,
        synthetic_upstream: false,
        confidence_note: null,
        status_note: `The ${id} objective is not implemented yet.`,
      },
  )
}

const NARRATION = {
  fastest:
    'Straight up the main road. Loud and treeless, but it is the shortest way there and the pavement is wide the whole distance.',
  nature:
    'Cuts east into the park after four minutes and stays under trees almost to the end. Two benches on the way, and a water fountain roughly half way.',
  accessible:
    'Follows quiet residential streets with dropped kerbs — until the canal crossing, where three steps stop it. Nothing in the road data offers a way around.',
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
