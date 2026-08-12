import { afterEach, describe, expect, it, vi } from 'vitest'

import { buildRouteRequest } from '../api/client.js'
import { GEOLOCATED, decodeState, encodeState, shareUrl, writeUrl } from './permalink.js'

// This is the ported contract check. It lives in vitest rather than in a
// standalone script so that it runs in `npm test`, in `make check` and in CI's
// frontend job — the same run, not a fourth one wired into the build. It also
// means buildRouteRequest can simply be imported instead of reconstructed by
// slicing client.js as text and passing it to new Function, which is what the
// script had to do and which breaks the moment that file is reordered.

const FULL = {
  origin: { lat: 6.933727, lon: 79.85008, name: 'Colombo Fort' },
  dest: { lat: 51.507489, lon: -0.162207, name: 'Hyde Park' },
  minutes: 65,
  mode: 'bike',
  objectives: ['scenic', 'accessible'],
  departAt: null,
}

const roundTrip = (state) => ({ ...state, ...decodeState(encodeState(state)) })

describe('encode / decode round trip', () => {
  it('preserves every field', () => {
    // **Changed:** `minutes` is no longer among them for a trip with a
    // destination. client.js stopped putting it in that request body, and this
    // module's contract is that a link reproduces the body — so carrying it
    // here would now break that sentence rather than uphold it. The loop case
    // below is where the dial still round-trips.
    const back = decodeState(encodeState(FULL))
    expect(back.origin).toEqual(FULL.origin)
    expect(back.dest).toEqual(FULL.dest)
    expect(back.minutes).toBeUndefined()
    expect(back.mode).toBe('bike')
    expect(back.objectives).toEqual(['scenic', 'accessible'])
  })

  it('carries the dial for a loop, where it is the whole request', () => {
    const loop = { ...FULL, dest: null }
    const back = decodeState(encodeState(loop))
    expect(back.minutes).toBe(65)
    expect(buildRouteRequest(roundTrip(loop)).minutes).toBe(65)
  })

  it('puts no time budget in a shared point-to-point link', () => {
    // A `min=` in one of these URLs reads as though it constrained the journey.
    // It never did — the destination sets the length — and after this it is not
    // in the request body either, so it would be a number that survives sharing
    // and changes nothing.
    expect(encodeState(FULL)).not.toContain('min=')
  })

  it('produces the same request body on the other side — the contract', () => {
    // The one that matters. If this fails, a shared link answers a different
    // question than the one the sender was looking at.
    expect(buildRouteRequest(roundTrip(FULL))).toEqual(buildRouteRequest(FULL))
  })

  it('carries coordinates to routing precision', () => {
    const back = decodeState(encodeState(FULL))
    expect(Math.abs(back.origin.lat - FULL.origin.lat)).toBeLessThan(1e-5)
    expect(Math.abs(back.origin.lon - FULL.origin.lon)).toBeLessThan(1e-5)
    expect(Math.abs(back.dest.lat - FULL.dest.lat)).toBeLessThan(1e-5)
  })

  it('gives a loop no destination rather than a null one', () => {
    const loop = { ...FULL, dest: null }
    const back = decodeState(encodeState(loop))
    expect(back.dest).toBeUndefined()
    expect('destination' in buildRouteRequest(roundTrip(loop))).toBe(false)
  })

  it('makes no link at all without an origin', () => {
    expect(encodeState({ ...FULL, origin: null })).toBe('')
    expect(shareUrl({ ...FULL, origin: null })).toBe('')
  })

  it('leaves an unset key absent rather than undefined', () => {
    // This is what makes the spread in App's init() safe. A key present with
    // value undefined would overwrite the default and then be dropped by
    // JSON.stringify, changing the request without changing the UI.
    const sparse = decodeState('?from=6.933727,79.850080')
    for (const key of ['dest', 'minutes', 'mode', 'objectives', 'departAt']) {
      expect(key in sparse, `${key} should be absent`).toBe(false)
    }
  })
})

describe('departure time', () => {
  // All new. The branch this was ported from has no concept of departAt, so a
  // faithful port would have broken its own headline contract for every user
  // who touched the departure strip.
  const hoursFromNow = (h) => new Date(Date.now() + h * 3600_000).toISOString()

  it('round-trips a future departure into the request body', () => {
    const state = { ...FULL, departAt: hoursFromNow(1) }
    // Assert on the *decoded* object, not only on the merged one. roundTrip
    // spreads the original state first, so a field the encoder drops entirely
    // is masked by the original value and the body still looks right. That
    // masking hid a dropped `at` until a deliberate mutation exposed it.
    const decoded = decodeState(encodeState(state))
    expect(decoded.departAt, 'the encoder dropped departAt').toBe(state.departAt)

    const body = buildRouteRequest(roundTrip(state))
    expect(body.depart_at).toBeDefined()
    expect(body).toEqual(buildRouteRequest(state))
  })

  it('carries every optional field through the encoder itself', () => {
    // The same masking applies to all of them, so each is checked on the
    // decoded object rather than on the merge.
    // `minutes` is deliberately absent: this state carries a destination, and
    // the encoder no longer writes a budget for one. See the round-trip block.
    const state = { ...FULL, departAt: hoursFromNow(1) }
    const decoded = decodeState(encodeState(state))
    expect(decoded.dest).toEqual(state.dest)
    expect(decoded.minutes).toBeUndefined()
    expect(decoded.mode).toBe(state.mode)
    expect(decoded.objectives).toEqual(state.objectives)
    expect(decoded.departAt).toBe(state.departAt)
  })

  it('drops a departure that has already passed, and says so', () => {
    const back = decodeState(`?from=6.933727,79.850080&at=${hoursFromNow(-2)}`)
    expect(back.departAt).toBeUndefined()
    expect(back.expiredDeparture).toBe(true)
  })

  it('keeps a departure inside the current hour', () => {
    const topOfHour = new Date()
    topOfHour.setMinutes(0, 0, 0)
    const back = decodeState(`?from=6.933727,79.850080&at=${topOfHour.toISOString()}`)
    expect(back.departAt).toBe(topOfHour.toISOString())
  })

  it('drops a garbage timestamp without claiming it expired', () => {
    const back = decodeState('?from=6.933727,79.850080&at=yesterday')
    expect(back.departAt).toBeUndefined()
    expect(back.expiredDeparture).toBeUndefined()
  })

  it('normalises an offset timestamp to one representation', () => {
    // +05:30 and Z forms must produce the same body, or two links that mean the
    // same thing compare unequal.
    const future = new Date(Date.now() + 7200_000)
    const back = decodeState(`?from=6.933727,79.850080&at=${future.toISOString()}`)
    expect(back.departAt).toBe(future.toISOString())
  })
})

describe('hostile input: somebody else wrote this link', () => {
  it.each(['?from=notacoord', '?from=999,999', '?from=51.5', '?from=', '?'])(
    'rejects %s outright',
    (query) => {
      expect(decodeState(query)).toBeNull()
    },
  )

  it('drops minutes the dial could never have shown', () => {
    expect(decodeState('?from=6.9,79.8&min=99999').minutes).toBeUndefined()
    expect(decodeState('?from=6.9,79.8&min=-5').minutes).toBeUndefined()
    expect(decodeState('?from=6.9,79.8&min=63').minutes).toBe(65)
  })

  it('drops an unknown mode or objective instead of passing it through', () => {
    expect(decodeState('?from=6.9,79.8&mode=teleport').mode).toBeUndefined()
    expect(decodeState('?from=6.9,79.8&obj=scenic,rm -rf,air').objectives).toEqual([
      'scenic',
      'air',
    ])
  })

  it('deduplicates objectives and caps them at three', () => {
    const objectives = decodeState('?from=6.9,79.8&obj=scenic,scenic,air,shade,quiet,fastest')
      .objectives
    expect(objectives).toHaveLength(3)
    expect(new Set(objectives).size).toBe(3)
  })

  it('leaves the defaults alone when every objective is unrecognised', () => {
    // An empty array would render a rail with nothing in it and no way back.
    expect('objectives' in decodeState('?from=6.9,79.8&obj=nonsense,more')).toBe(false)
  })

  it('bounds a hostile name', () => {
    const long = 'x'.repeat(5000)
    expect(decodeState(`?from=6.9,79.8&fromName=${long}`).origin.name.length).toBeLessThanOrEqual(
      120,
    )
  })

  it('degrades a missing name to the coordinates', () => {
    expect(decodeState('?from=51.50749,-0.16221').origin.name).toMatch(/51\.5/)
  })
})

describe('writeUrl and shareUrl', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  /**
   * A window whose `replaceState` actually moves the address bar.
   *
   * The stub this replaces recorded calls and left `location.search` at ''
   * forever, which is precisely why BLOCKED.md §9 survived a full suite: every
   * assertion about "what is in the bar" was really an assertion about the
   * first write, and a *stale* bar is only visible on the second. Any test that
   * cares what a reload would see has to read `location.search` back.
   */
  const liveWindow = (search = '') => {
    const location = { origin: 'https://meander.example', pathname: '/', search }
    const replaceState = vi.fn((_state, _title, url) => {
      const q = String(url).indexOf('?')
      location.search = q === -1 ? '' : String(url).slice(q)
    })
    const pushState = vi.fn()
    vi.stubGlobal('window', { location, history: { replaceState, pushState } })
    return { location, replaceState, pushState }
  }

  const stubWindow = () => {
    const { replaceState, pushState } = liveWindow()
    return { replaceState, pushState }
  }

  const geolocated = (state = FULL) => ({
    ...state,
    origin: { lat: 6.9, lon: 79.8, name: GEOLOCATED },
  })

  it('writes a searched origin to the address bar', () => {
    const { replaceState } = stubWindow()
    writeUrl(FULL)
    expect(replaceState).toHaveBeenCalledTimes(1)
    expect(replaceState.mock.calls[0][2]).toContain('from=')
  })

  it('never writes a device fix to the address bar', () => {
    // The address bar persists into browser history. This is "no location
    // history" as an executable assertion rather than a promise in a comment.
    //
    // Asserted on the *content* of every write rather than on the call count.
    // The count was the weaker claim and it is now the wrong one: the fix for
    // §9 clears the bar, which is itself a replaceState.
    const { location, replaceState } = liveWindow()
    writeUrl(geolocated())
    for (const call of replaceState.mock.calls) {
      expect(String(call[2])).not.toContain('6.9')
      expect(String(call[2])).not.toContain('79.8')
      expect(String(call[2])).not.toContain('from=')
    }
    expect(location.search).toBe('')
  })

  it('clears the search before it, instead of leaving it standing — BLOCKED.md §9', () => {
    // The defect, as a test. Search for a place, then press "Use my location".
    // The old guard returned before replaceState, so the bar kept the abandoned
    // place and a reload booted *that* search: App.jsx's init seeds nonce 1 off
    // whatever decodeState finds.
    const { location } = liveWindow()

    writeUrl(FULL)
    expect(location.search).toContain('from=')

    writeUrl(geolocated())

    expect(location.search).toBe('')
    // The thing that actually hurt: what a reload would ask for.
    expect(decodeState(location.search)).toBeNull()
  })

  it('does not resurrect the abandoned search when a control moves afterwards', () => {
    // Step 3 of the §9 reproduction. The guard keys on the origin, so every
    // later write was suppressed too — changing the minutes could not repair
    // the bar, it just left the stale query there.
    const { location } = liveWindow()

    writeUrl(FULL)
    writeUrl(geolocated())
    writeUrl(geolocated({ ...FULL, minutes: 90, mode: 'bike' }))

    expect(location.search).toBe('')
    expect(decodeState(location.search)).toBeNull()
  })

  it('puts a searched place back in the bar after a geolocated one', () => {
    // The other direction: clearing must not be sticky.
    const { location } = liveWindow()

    writeUrl(geolocated())
    expect(location.search).toBe('')

    writeUrl(FULL)
    expect(decodeState(location.search).origin.name).toBe('Colombo Fort')
  })

  it('writes nothing twice when the bar is already bare', () => {
    // Clearing an already-clear bar must not spend a history entry.
    const { replaceState } = liveWindow()
    writeUrl(geolocated())
    const after = replaceState.mock.calls.length
    writeUrl(geolocated({ ...FULL, minutes: 90 }))
    expect(replaceState.mock.calls.length).toBe(after)
  })

  it('still shares a device fix when the user asks it to', () => {
    stubWindow()
    const url = shareUrl({ ...FULL, origin: { lat: 6.9, lon: 79.8, name: GEOLOCATED } })
    expect(url).toContain('from=6.900000%2C79.800000')
    expect(url).toContain('https://meander.example/')
  })

  it('never calls pushState', () => {
    const { pushState } = stubWindow()
    writeUrl(FULL)
    writeUrl({ ...FULL, minutes: 90 })
    expect(pushState).toHaveBeenCalledTimes(0)
  })

  it('does nothing when the address bar is already right', () => {
    const replaceState = vi.fn()
    vi.stubGlobal('window', {
      location: { origin: 'https://meander.example', pathname: '/', search: encodeState(FULL) },
      history: { replaceState, pushState: vi.fn() },
    })
    writeUrl(FULL)
    expect(replaceState).toHaveBeenCalledTimes(0)
  })

  it('never puts the geolocation sentinel in a link', () => {
    expect(encodeState({ ...FULL, origin: { lat: 6.9, lon: 79.8, name: GEOLOCATED } })).not.toContain(
      'fromName',
    )
  })
})

describe('the request body a link reproduces', () => {
  it('omits the time budget for a trip with a destination', () => {
    // The dial cannot change the length of a journey whose ends are both
    // fixed. Sending it made it part of the backend's cache key, so the same
    // two places at 30 and at 35 minutes were two rows holding one answer and
    // every nudge of the dial re-spent a full set of routing credits.
    const body = buildRouteRequest(FULL)
    expect('minutes' in body).toBe(false)
    expect(body.destination).toEqual({ lat: FULL.dest.lat, lon: FULL.dest.lon })
  })

  it('sends the time budget for a loop, where it sets the loop length', () => {
    const body = buildRouteRequest({ ...FULL, dest: null })
    expect(body.minutes).toBe(65)
    expect('destination' in body).toBe(false)
  })

  it('still round-trips identically through a link, both shapes', () => {
    // The headline contract, checked on the shape that changed.
    for (const state of [FULL, { ...FULL, dest: null }]) {
      expect(buildRouteRequest(roundTrip(state))).toEqual(buildRouteRequest(state))
    }
  })
})
