/**
 * The search, encoded in the URL.
 *
 * The contract is one sentence: a link reproduces the same request body. That
 * is what the test asserts against buildRouteRequest, and it is why the
 * coordinate precision here is not a preference — see COORD_DP below.
 *
 * Two things this module will not do:
 *
 *   1. It never calls pushState. Dragging the time dial would otherwise put
 *      fifty entries behind the back button.
 *   2. It never writes a device GPS fix into the address bar. The address bar
 *      persists into browser history, and "no location history" is a promise
 *      this application makes in About. A place the user searched for is a
 *      place they chose to name; a satellite fix is not. Sharing one is still
 *      possible, but only by pressing the button.
 *
 * Every window access is guarded rather than assumed. The suite runs in a bare
 * node environment — there is no jsdom in this repo — and a module that reads
 * window at import time cannot be tested there without faking a global, which
 * is exactly the hack this replaces.
 */

import { OBJECTIVES as ROUTE_OBJECTIVES } from './dash.js'
import { MODE_VERB } from './format.js'

/**
 * Six decimals, because that is what the backend rounds geocode results to —
 * `GEOCODE_COORD_DECIMALS` in backend/routing.py, asserted by
 * backend/tests/test_geocode.py. At six this is lossless for any place picked
 * from search, so the request body survives a round trip byte for byte. Five
 * would shorten the URL and quietly break that.
 */
const COORD_DP = 6

/** Must equal the label App.jsx gives a geolocated origin. */
export const GEOLOCATED = 'Your location'

// Derived, not restated. The branch this came from hard-coded both sets, which
// is one rename away from silently dropping a valid objective from every link.
const OBJECTIVES = new Set(ROUTE_OBJECTIVES.map((o) => o.id))
const MODES = new Set(['auto', ...Object.keys(MODE_VERB)])

// Mirrors App.jsx's MIN_MINUTES/MAX_MINUTES and TimeDial's STEP. A link may
// only ask for something the dial could have produced.
const MIN_MINUTES = 20
const MAX_MINUTES = 360
const STEP = 5
const MAX_NAME = 120
const MAX_OBJECTIVES = 3

/**
 * Objective ids that used to be written into links, mapped to what they are
 * called now.
 *
 * `scenic` was `nature` until 2026-08-12. Read on the way in and never written:
 * `encodeState` only ever emits current ids, so a link opened and re-shared
 * quietly upgrades itself. Without this, every link anyone had shared would
 * come back with its objectives silently dropped — `OBJECTIVES.has('nature')`
 * is false, the filter removes it, and the user gets the default three with no
 * indication that the link asked for something else. The backend accepts the
 * same alias, for the same reason and in one direction only.
 */
const DEPRECATED_OBJECTIVES = { nature: 'scenic' }

const loc = () => (typeof window === 'undefined' ? null : window.location)

const encodePlace = (place) => `${place.lat.toFixed(COORD_DP)},${place.lon.toFixed(COORD_DP)}`

function decodePlace(raw, name) {
  if (!raw) return null
  const parts = raw.split(',')
  if (parts.length !== 2) return null
  const lat = Number.parseFloat(parts[0])
  const lon = Number.parseFloat(parts[1])
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null
  if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return null
  const label = typeof name === 'string' && name.trim() ? name.trim().slice(0, MAX_NAME) : null
  return { lat, lon, name: label ?? `${lat.toFixed(5)}, ${lon.toFixed(5)}` }
}

/** The query string for a search, or '' when there is nothing to link to. */
export function encodeState({ origin, dest, minutes, mode, objectives, departAt }) {
  if (!origin) return ''
  const params = new URLSearchParams()
  params.set('from', encodePlace(origin))
  // A device fix has no name worth carrying, and carrying it would put the
  // sentinel into a stranger's URL bar as though it were a place.
  if (origin.name && origin.name !== GEOLOCATED) params.set('fromName', origin.name)
  if (dest) {
    params.set('to', encodePlace(dest))
    if (dest.name) params.set('toName', dest.name)
  }
  // Loops only. The headline contract of this module is that a link reproduces
  // the same request body, and client.js stopped putting `minutes` in the body
  // of a trip that has a destination — so carrying `min` here would break that
  // sentence rather than uphold it, and would put a number in a shared URL that
  // reads as though it constrained the journey.
  if (minutes && !dest) params.set('min', String(minutes))
  if (mode && mode !== 'auto') params.set('mode', mode)
  if (objectives?.length) params.set('obj', objectives.join(','))
  // Absent on the branch this came from, because the departure strip postdates
  // it. Omitting it here would make the headline contract false for anyone who
  // has touched that strip: client.js puts depart_at in the body.
  if (departAt) params.set('at', departAt)
  return `?${params.toString()}`
}

/**
 * A partial state from a link, or null.
 *
 * Every key is set **conditionally**. An unrecognised value leaves the key
 * absent rather than present-and-undefined, which is what makes
 * `{ ...initialState, ...decoded }` safe: `mode: undefined` would overwrite
 * 'auto' and then vanish from the JSON body, silently changing the request.
 */
export function decodeState(search) {
  const query = search ?? loc()?.search ?? ''
  if (!query || query === '?') return null
  const params = new URLSearchParams(query)

  const origin = decodePlace(params.get('from'), params.get('fromName'))
  if (!origin) return null

  const state = { origin }

  const dest = decodePlace(params.get('to'), params.get('toName'))
  if (dest) state.dest = dest

  const min = Number.parseInt(params.get('min') ?? '', 10)
  if (Number.isFinite(min) && min >= MIN_MINUTES && min <= MAX_MINUTES) {
    state.minutes = Math.round(min / STEP) * STEP
  }

  const mode = params.get('mode')
  if (mode && MODES.has(mode)) state.mode = mode

  const obj = params.get('obj')
  if (obj) {
    const wanted = [
      ...new Set(
        obj
          .split(',')
          .map((id) => DEPRECATED_OBJECTIVES[id] ?? id)
          .filter((id) => OBJECTIVES.has(id)),
      ),
    ]
    if (wanted.length) state.objectives = wanted.slice(0, MAX_OBJECTIVES)
  }

  const at = params.get('at')
  if (at) {
    const when = new Date(at)
    if (!Number.isNaN(when.valueOf())) {
      // The departure strip builds its chips from the top of the current hour,
      // so an earlier instant is one the UI cannot offer and must not silently
      // send. Drop it, and let the caller say so.
      const floor = new Date()
      floor.setMinutes(0, 0, 0)
      if (when >= floor) state.departAt = when.toISOString()
      else state.expiredDeparture = true
    }
  }

  return state
}

/** Keep the address bar in step with the controls. */
export function writeUrl(state) {
  const l = loc()
  if (!l || typeof window.history?.replaceState !== 'function') return
  // See the header: a searched place goes in, a satellite fix does not.
  //
  // The refusal **clears** rather than returns, and that distinction is the
  // whole of BLOCKED.md §9. Returning here left standing whatever was already
  // in the bar, and the guard keys on the origin, so nothing else could
  // overwrite it either: search for a place, press "Use my location", and the
  // URL kept the abandoned place for the rest of the session. A reload then
  // booted that search — App.jsx's init seeds nonce 1 off the query, so the app
  // silently asked for a walk the user had moved on from.
  //
  // Writing '' is therefore not a tidier way of writing nothing. It is the only
  // way the address bar can say "there is no search here to reload", which is
  // the true statement once the origin is one we refuse to record.
  const query = state.origin?.name === GEOLOCATED ? '' : encodeState(state)
  const next = `${l.pathname}${query}`
  if (next === `${l.pathname}${l.search}`) return
  window.history.replaceState(null, '', next)
}

/** The absolute link, for the share sheet or the clipboard. */
export function shareUrl(state) {
  const l = loc()
  if (!l) return ''
  const query = encodeState(state)
  if (!query) return ''
  return `${l.origin}${l.pathname}${query}`
}
