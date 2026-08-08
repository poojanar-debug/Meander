/**
 * The geometry behind follow mode.
 *
 * **Every function here runs in the browser against geometry the app already
 * downloaded.** Nothing in this file makes a request, and nothing that calls it
 * may either. That is the whole privacy position of the feature: the live
 * position is used to answer "where am I on this line" and is never sent
 * anywhere, so there is no server that could log it even by accident.
 *
 * Coordinates are `[lon, lat]` pairs, matching the route geometry on the wire.
 */

const R = 6371000
const RAD = Math.PI / 180

/** Great-circle metres between two [lon, lat] points. */
export function haversineM(a, b) {
  const dLat = (b[1] - a[1]) * RAD
  const dLon = (b[0] - a[0]) * RAD
  const lat1 = a[1] * RAD
  const lat2 = b[1] * RAD
  const h =
    Math.sin(dLat / 2) ** 2 + Math.sin(dLon / 2) ** 2 * Math.cos(lat1) * Math.cos(lat2)
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)))
}

/**
 * Local flat-earth projection, in metres, about a reference latitude.
 *
 * Over the few hundred metres a segment spans this is indistinguishable from
 * the spherical answer and far cheaper — and perpendicular distance to a
 * segment has no closed form on a sphere anyway.
 */
function toMetres(point, refLat) {
  return [point[0] * RAD * R * Math.cos(refLat * RAD), point[1] * RAD * R]
}

/** Cumulative distance to each vertex, so progress is a lookup rather than a walk. */
export function cumulativeDistances(geometry) {
  const out = [0]
  for (let i = 1; i < geometry.length; i += 1) {
    out.push(out[i - 1] + haversineM(geometry[i - 1], geometry[i]))
  }
  return out
}

/**
 * The inverse of `locateOnRoute`: a distance along the line to a point on it.
 *
 * Interpolates inside the segment rather than snapping to the nearest vertex.
 * Consecutive vertices on a long straight stretch can be hundreds of metres
 * apart, and snapping would move a reported barrier that far from where the
 * person actually stood.
 *
 * ⚠ Geometry is `[lon, lat]` — GeoJSON order — and this returns named
 * `{ lat, lon }`, because the API's BarrierReport takes named fields. Getting
 * that backwards files a report in the wrong hemisphere of a public database,
 * and nothing downstream would catch it. The axis order is pinned by test.
 *
 * Returns null for a degenerate geometry rather than a point at [0, 0], which
 * is a real place in the Gulf of Guinea.
 */
export function pointAtDistance(geometry, metres, cumulative) {
  if (!Array.isArray(geometry) || geometry.length < 2) return null

  const cum = cumulative ?? cumulativeDistances(geometry)
  const total = cum[cum.length - 1]
  if (!(total > 0)) return null

  const target = Math.min(Math.max(metres, 0), total)

  let i = 1
  while (i < cum.length - 1 && cum[i] < target) i += 1

  const segStart = cum[i - 1]
  const segLength = cum[i] - segStart
  const t = segLength > 0 ? (target - segStart) / segLength : 0

  const [lon1, lat1] = geometry[i - 1]
  const [lon2, lat2] = geometry[i]

  return {
    lat: lat1 + (lat2 - lat1) * t,
    lon: lon1 + (lon2 - lon1) * t,
  }
}

/**
 * Where a position falls on the line.
 *
 * Returns the perpendicular distance to the nearest segment (`offRouteM`), how
 * far along the line the projected point is (`alongM`), and the index of the
 * vertex at the start of that segment (`index`) — which is what maps a position
 * back onto a step, since steps carry vertex intervals.
 *
 * Projecting onto the segment rather than snapping to the nearest *vertex*
 * matters: on a long straight stretch the nearest vertex can be 200 m away
 * while the walker is standing exactly on the line, and snapping would report
 * them off-route.
 */
export function locateOnRoute(position, geometry, cumulative) {
  if (!geometry || geometry.length < 2) return null
  const cum = cumulative ?? cumulativeDistances(geometry)
  const refLat = position[1]
  const p = toMetres(position, refLat)

  let best = { offRouteM: Infinity, alongM: 0, index: 0 }
  for (let i = 0; i < geometry.length - 1; i += 1) {
    const a = toMetres(geometry[i], refLat)
    const b = toMetres(geometry[i + 1], refLat)
    const abx = b[0] - a[0]
    const aby = b[1] - a[1]
    const lenSq = abx * abx + aby * aby
    // A zero-length segment (duplicated vertex) would divide by zero.
    const t = lenSq === 0 ? 0 : Math.max(0, Math.min(1, ((p[0] - a[0]) * abx + (p[1] - a[1]) * aby) / lenSq))
    const projX = a[0] + t * abx
    const projY = a[1] + t * aby
    const dist = Math.hypot(p[0] - projX, p[1] - projY)
    if (dist < best.offRouteM) {
      best = {
        offRouteM: dist,
        alongM: cum[i] + t * (cum[i + 1] - cum[i]),
        index: i,
      }
    }
  }
  return best
}

/** The step whose vertex interval contains `index`, or the last one. */
export function stepAt(steps, index) {
  if (!steps?.length) return -1
  const found = steps.findIndex(
    (s) => s.interval?.length === 2 && index >= s.interval[0] && index <= s.interval[1],
  )
  return found === -1 ? steps.length - 1 : found
}

/**
 * Metres to the end of the current step — which is where the next turn is.
 *
 * Clamped at zero rather than going negative: a GPS reading slightly past the
 * turn should read "0 m", not "-8 m".
 */
export function metresToNextTurn(steps, stepIndex, alongM, cumulative) {
  const step = steps?.[stepIndex]
  if (!step || step.interval?.length !== 2) return null
  const end = cumulative[Math.min(step.interval[1], cumulative.length - 1)]
  return Math.max(0, end - alongM)
}

/** The next rest stop ahead, by distance along the route. */
export function nextRestStop(restStops, alongM) {
  if (!restStops?.length) return null
  const ahead = restStops
    .filter((s) => typeof s.at_m === 'number' && s.at_m > alongM)
    .sort((a, b) => a.at_m - b.at_m)
  if (!ahead.length) return null
  return { stop: ahead[0], inM: ahead[0].at_m - alongM }
}

/**
 * Barriers within `radiusM` of the position.
 *
 * **This runs for every route, including one the user chose to follow after
 * being told it was blocked.** Someone who decided to try anyway is exactly the
 * person who most needs telling that the steps are 200 m ahead. Suppressing the
 * warning because they had already been warned once would be the app deciding
 * it had discharged its duty.
 */
export function barriersWithin(blockers, position, radiusM = 200) {
  if (!blockers?.length) return []
  return blockers
    .map((b) => ({ blocker: b, distanceM: haversineM(position, [b.lon, b.lat]) }))
    .filter((x) => x.distanceM <= radiusM)
    .sort((a, b) => a.distanceM - b.distanceM)
}

/**
 * Sustained off-route detection.
 *
 * **A single reading is never enough.** City GPS bounces off buildings by tens
 * of metres, so a threshold tested against one sample fires constantly on a
 * perfectly good walk and trains the user to ignore it. The clock starts when
 * the first reading exceeds the distance and resets the moment one comes back
 * inside it; only a *continuous* run past both thresholds counts.
 *
 * `state` is carried by the caller between readings; pass `null` to start.
 */
export function trackOffRoute(state, offRouteM, now, { distanceM = 40, seconds = 15 } = {}) {
  if (offRouteM <= distanceM) return { since: null, offRoute: false }
  const since = state?.since ?? now
  return { since, offRoute: now - since >= seconds * 1000 }
}
