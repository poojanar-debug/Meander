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
 * How far back and forward of the anchor a match is looked for.
 *
 * Backward is small because a walker does not usually reverse, but not zero:
 * a GPS fix lands a few metres behind the true position often enough that a
 * one-sided window would refuse to match at all and force a relock.
 *
 * Forward is bounded by how far anyone can actually get between two fixes.
 * FollowMode's watch uses `timeout: 15000`, so 15 s is the longest gap it will
 * accept a reading across, and 10 m/s is 36 km/h — comfortably above anything
 * this app routes, bike or car. 150 m is that product, rounded.
 *
 * It matters that this stays small relative to a route. An earlier draft used
 * 500 m, which is longer than the outbound leg of a short loop: the window then
 * spans both legs, the return leg is inside it, and the anchor stops
 * disambiguating anything. A window has to be narrower than the ambiguity it
 * exists to resolve.
 */
const ANCHOR_BACK_M = 40
const ANCHOR_FORWARD_M = 150

/**
 * Past this, the windowed match is not believable and the whole line is
 * searched again. Well clear of the 40 m off-route threshold, so ordinary
 * city GPS noise never causes a relock — only a position that is genuinely
 * nowhere near where we last saw this walker.
 */
const RELOCK_M = 120

/**
 * Close enough to the line to count as standing on it. The same 40 m
 * `trackOffRoute` treats as on-route, shared rather than repeated so the two
 * cannot come to disagree about what being on the route means.
 */
export const ON_ROUTE_M = 40

/**
 * The earliest place on the line the walker could acceptably be.
 *
 * Used for the very first fix, where there is no anchor. The globally nearest
 * match is the wrong answer there for the same reason it is wrong mid-walk, and
 * on a loop it is wrong at its worst: **a round trip starts and ends at the same
 * point**, so a fix taken at the start is a few metres from both 0 m and the
 * full route length, and noise decides which. Picking the nearest reported a
 * walker who had not yet moved as having finished.
 *
 * A walk starts at its start, so among the places that are acceptably close,
 * the earliest is the right one. Only when nothing is acceptably close — the
 * route is not where this person is — does the nearest match win, because then
 * there is nothing to prefer.
 *
 * **This is a prior, not a deduction, and it has a known cost.** Someone who
 * opens follow mode when they are already halfway round a loop, standing on the
 * return leg, is within the acceptance radius of the outbound leg too, and this
 * will place them on the outbound one. The anchor then keeps them there — the
 * error is a few metres perpendicular, so it never trips `RELOCK_M`. One fix
 * with no history genuinely cannot tell the two legs apart; the choice is which
 * way to be wrong, and being wrong at the start of a walk is rarer than being
 * wrong for everyone who has not started one.
 */
function earliestAcceptable(p, geometry, cum, refLat) {
  let nearest = null
  for (let i = 0; i < geometry.length - 1; i += 1) {
    const here = projectOnto(p, geometry, cum, i, refLat)
    if (here.offRouteM <= ON_ROUTE_M) return here
    if (nearest === null || here.offRouteM < nearest.offRouteM) nearest = here
  }
  return nearest
}

/**
 * Perpendicular distance from `p` to segment i, and where on it that falls.
 *
 * `from`/`to` bound the answer *along the line*, not merely which segments are
 * considered. That distinction is the whole of the window: route geometry
 * routinely carries vertices hundreds of metres apart, so a segment that
 * overlaps the window by a metre still spans most of the leg, and projecting
 * onto the whole of it puts the match right back where the anchor was meant to
 * keep it away from. Clamping `t` to the window instead makes the bound hold
 * whatever the vertex spacing happens to be.
 */
function projectOnto(p, geometry, cum, i, refLat, from = -Infinity, to = Infinity) {
  const a = toMetres(geometry[i], refLat)
  const b = toMetres(geometry[i + 1], refLat)
  const abx = b[0] - a[0]
  const aby = b[1] - a[1]
  const lenSq = abx * abx + aby * aby
  const segLen = cum[i + 1] - cum[i]
  // A zero-length segment (duplicated vertex) would divide by zero.
  let t = lenSq === 0 ? 0 : Math.max(0, Math.min(1, ((p[0] - a[0]) * abx + (p[1] - a[1]) * aby) / lenSq))
  if (segLen > 0) {
    const tMin = Math.max(0, Math.min(1, (from - cum[i]) / segLen))
    const tMax = Math.max(0, Math.min(1, (to - cum[i]) / segLen))
    t = Math.max(tMin, Math.min(tMax, t))
  }
  const projX = a[0] + t * abx
  const projY = a[1] + t * aby
  return {
    offRouteM: Math.hypot(p[0] - projX, p[1] - projY),
    alongM: cum[i] + t * segLen,
    index: i,
  }
}

/**
 * How much a metre of movement along the line costs against a metre of
 * perpendicular error, when choosing between candidate matches.
 *
 * Perpendicular distance alone is not enough even inside the window. Near a
 * loop's turnaround both legs are in the window at once, and a fix biased
 * toward the return leg — which is the ordinary case, since the legs are metres
 * apart and GPS error is tens of metres — matches the return leg while the
 * walker is still on the outbound one. Progress then runs *backwards* along the
 * return leg for the rest of the outbound half.
 *
 * At 0.1, ten metres of unexplained jump along the line costs as much as one
 * metre of being off it. Ordinary forward motion between fixes is tens of
 * metres and pays almost nothing; a leap to the far leg is hundreds and loses.
 */
const ALONG_PENALTY_PER_M = 0.1

function nearestIn(p, geometry, cum, refLat, from, to, anchorM = null) {
  let best = null
  let bestCost = Infinity
  for (let i = 0; i < geometry.length - 1; i += 1) {
    // Skip a segment only when it lies wholly outside the window.
    if (cum[i + 1] < from || cum[i] > to) continue
    const here = projectOnto(p, geometry, cum, i, refLat, from, to)
    const cost =
      anchorM == null
        ? here.offRouteM
        : here.offRouteM + ALONG_PENALTY_PER_M * Math.abs(here.alongM - anchorM)
    if (cost < bestCost) {
      best = here
      bestCost = cost
    }
  }
  return best
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
 *
 * ## Why this is anchored
 *
 * Taking the globally nearest segment is wrong on a round trip, which is the
 * shape this app produces by default. The outbound and return legs of a loop
 * frequently run along the same street, sometimes on the same line: a walker
 * 400 m into the outbound leg is a few metres from the return leg at 2,600 m,
 * and which of the two is *nearest* is then decided by GPS noise. The match
 * jumps to the far leg and the route reads backwards — progress leaps to near
 * complete, `stepAt` names a turn from the end of the walk, `metresToNextTurn`
 * measures to it, and `nextRestStop` reports that every stop has been passed.
 *
 * So the previous position along the line is carried as an `anchorM` and the
 * search is restricted to a window around it. The walker's own history is what
 * disambiguates two legs that geometry alone cannot: you reach 2,600 m by
 * having been at 2,500 m, not by teleporting from 400 m.
 *
 * `anchorM` is null on the first fix, which takes the earliest acceptable match
 * rather than the nearest — see `earliestAcceptable`, and note that a loop's
 * start and end are the same place, so this is the one point on the route where
 * the ambiguity is guaranteed rather than incidental.
 *
 * When the windowed match is worse than `RELOCK_M` the whole line is searched,
 * so someone who leaves the route and rejoins it elsewhere is not held to a
 * stale anchor. That search takes the nearest, which on a loop can pick the
 * wrong leg — but a walker who is 120 m from where we last saw them has told us
 * nothing better, and the next fix re-anchors from wherever this one landed.
 */
export function locateOnRoute(position, geometry, cumulative, anchorM = null) {
  if (!geometry || geometry.length < 2) return null
  const cum = cumulative ?? cumulativeDistances(geometry)
  const refLat = position[1]
  const p = toMetres(position, refLat)

  if (anchorM == null || !Number.isFinite(anchorM)) {
    return earliestAcceptable(p, geometry, cum, refLat) ?? {
      offRouteM: Infinity,
      alongM: 0,
      index: 0,
    }
  }

  const windowed = nearestIn(
    p, geometry, cum, refLat, anchorM - ANCHOR_BACK_M, anchorM + ANCHOR_FORWARD_M, anchorM,
  )
  if (windowed && windowed.offRouteM <= RELOCK_M) return windowed

  return nearestIn(p, geometry, cum, refLat, -Infinity, Infinity) ?? {
    offRouteM: Infinity,
    alongM: 0,
    index: 0,
  }
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
export function trackOffRoute(state, offRouteM, now, { distanceM = ON_ROUTE_M, seconds = 15 } = {}) {
  if (offRouteM <= distanceM) return { since: null, offRoute: false }
  const since = state?.since ?? now
  return { since, offRoute: now - since >= seconds * 1000 }
}
