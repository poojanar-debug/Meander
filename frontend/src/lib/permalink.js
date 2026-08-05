/**
 * The whole request, in the URL.
 *
 * No backend, no storage, no accounts — which is the point. It makes the app
 * demoable, linkable and testable, and turns "look at this route" into
 * something you can actually send someone.
 *
 * **A shared link must reproduce the same routes.** That is the contract, it is
 * checked by scripts/check-permalink.mjs on every build, and it is why the
 * coordinate precision below is what it is: a link that produced a *different*
 * answer than the one the sender was looking at would be worse than no link.
 *
 * ⚠ Privacy. This puts coordinates in the address bar, and therefore in
 * browser history and in whatever the user pastes them into. That is inherent
 * to a shareable link rather than a leak — it is the feature — but it is a real
 * change in what leaves the page, so:
 *
 *   * it is written with replaceState, never pushState, so dragging the time
 *     slider does not put fifty entries in the back button;
 *   * nothing is written until the user has actually chosen an origin, so
 *     simply opening the app leaves a clean URL;
 *   * nothing is written to localStorage, sessionStorage or a cookie. The app
 *     is still stateless between visits.
 */

/**
 * Six, to match GEOCODE_COORD_DECIMALS in backend/routing.py.
 *
 * Not an arbitrary precision choice: the backend already rounds every geocode
 * result to six places, so six is *lossless* for any place a user picked from
 * search — the coordinate that comes back out of a link is bit-for-bit the one
 * that went in, and the request body is identical.
 *
 * Five looked tidier and shortened the URL by three characters. It also broke
 * the contract: `check:permalink` caught it immediately, because a 1.1 m shift
 * is a different coordinate even if GraphHopper would usually snap it to the
 * same way. "Usually" is not a contract.
 */
const COORD_DP = 6

const MODES = new Set(['auto', 'foot', 'bike', 'car'])
const OBJECTIVES = new Set(['fastest', 'nature', 'accessible', 'quiet', 'shade', 'air'])

const MIN_MINUTES = 20
const MAX_MINUTES = 360

function encodePlace(place) {
  if (!place || !Number.isFinite(place.lat) || !Number.isFinite(place.lon)) return null
  return `${place.lat.toFixed(COORD_DP)},${place.lon.toFixed(COORD_DP)}`
}

function decodePlace(value, name) {
  if (!value) return null
  const [lat, lon] = String(value).split(',').map(Number)
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null
  if (lat < -90 || lat > 90 || lon < -180 || lon > 180) return null
  // A name is a convenience, not a source of truth — the coordinates are what
  // route. An absent or hostile name degrades to the coordinates themselves.
  return { lat, lon, name: (name || '').slice(0, 120) || `${lat.toFixed(4)}, ${lon.toFixed(4)}` }
}

/** The query string for a given app state, or '' when there is nothing to share. */
export function encodeState({ origin, dest, minutes, mode, objectives }) {
  const from = encodePlace(origin)
  if (!from) return ''

  const params = new URLSearchParams()
  params.set('from', from)
  if (origin.name && origin.name !== 'Your location') params.set('fromName', origin.name)

  const to = encodePlace(dest)
  if (to) {
    params.set('to', to)
    if (dest.name) params.set('toName', dest.name)
  }

  if (Number.isFinite(minutes)) params.set('min', String(minutes))
  if (mode && mode !== 'auto') params.set('mode', mode)
  if (objectives?.length) params.set('obj', objectives.join(','))

  return `?${params.toString()}`
}

/**
 * Parse a URL back into a partial state.
 *
 * Every field is validated and anything unrecognised is dropped rather than
 * trusted: this is attacker-controlled input in the most literal sense, since
 * the whole point is that someone else wrote the link.
 */
export function decodeState(search = window.location.search) {
  const params = new URLSearchParams(search)
  const origin = decodePlace(params.get('from'), params.get('fromName'))
  if (!origin) return null

  const state = { origin }

  const dest = decodePlace(params.get('to'), params.get('toName'))
  if (dest) state.dest = dest

  const minutes = Number(params.get('min'))
  if (Number.isFinite(minutes) && minutes >= MIN_MINUTES && minutes <= MAX_MINUTES) {
    // Snap to the same 5-minute step the dial uses, so a hand-edited URL
    // cannot produce a value the UI can display but not reproduce.
    state.minutes = Math.round(minutes / 5) * 5
  }

  const mode = params.get('mode')
  if (mode && MODES.has(mode)) state.mode = mode

  const objectives = (params.get('obj') ?? '')
    .split(',')
    .map((o) => o.trim())
    .filter((o) => OBJECTIVES.has(o))
  // Deduplicated and capped at the same three the reducer enforces.
  const unique = [...new Set(objectives)].slice(0, 3)
  if (unique.length) state.objectives = unique

  return state
}

/** Write the state into the address bar without touching the history stack. */
export function writeUrl(state) {
  const query = encodeState(state)
  if (!query) return
  const next = `${window.location.pathname}${query}`
  if (next === `${window.location.pathname}${window.location.search}`) return
  window.history.replaceState(null, '', next)
}

/** The link to share, absolute. */
export function shareUrl(state) {
  const query = encodeState(state)
  return query ? `${window.location.origin}${window.location.pathname}${query}` : ''
}
