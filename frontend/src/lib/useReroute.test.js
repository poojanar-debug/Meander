import { describe, expect, it } from 'vitest'

import { REROUTE_COOLDOWN_MS, pickRerouted, rerouteRequestFor } from './useReroute.js'

// The hook itself needs a renderer this repo does not have; what can rot
// silently is the request it builds and the route it keeps, so those are pure
// functions and are pinned here.

const ROUTE = {
  id: 'scenic',
  geometry: [
    [79.86, 6.92],
    [79.87, 6.93],
    [79.88, 6.94],
  ],
}

describe('rerouteRequestFor', () => {
  it('asks from where the walker stands to where the route was going', () => {
    const req = rerouteRequestFor([79.865, 6.925], ROUTE, 'foot')
    // Position arrives [lon, lat] off the wire; the request wants named
    // fields. Swapped axes here would ask for a route in the wrong
    // hemisphere, so the order is pinned, not trusted.
    expect(req.origin).toEqual({ lat: 6.925, lon: 79.865 })
    expect(req.destination).toEqual({ lat: 6.94, lon: 79.88 })
    expect(req.mode).toBe('foot')
  })

  it('asks for the one objective being walked, not the whole set', () => {
    // Three objectives would spend three routes' credits to throw two away.
    expect(rerouteRequestFor([79.865, 6.925], ROUTE, 'foot').objectives).toEqual(['scenic'])
  })

  it('omits the time budget, exactly as any trip with a destination does', () => {
    // buildRouteRequest drops `minutes` for destination trips so the dial can
    // never key a cache row; a reroute must ride the same rule.
    expect('minutes' in rerouteRequestFor([79.865, 6.925], ROUTE, 'foot')).toBe(false)
  })

  it('returns null rather than a request when there is nothing to ask', () => {
    expect(rerouteRequestFor(null, ROUTE, 'foot')).toBeNull()
    expect(rerouteRequestFor([79.865, 6.925], null, 'foot')).toBeNull()
    expect(rerouteRequestFor([79.865, 6.925], { id: 'x', geometry: [] }, 'foot')).toBeNull()
  })

  it('spaces attempts far enough apart to never fire per fix', () => {
    // The watch delivers a fix roughly every second; a cooldown anywhere near
    // that would turn one wrong turn into a stream of positions.
    expect(REROUTE_COOLDOWN_MS).toBeGreaterThanOrEqual(10000)
  })
})

describe('pickRerouted', () => {
  const scenic = { id: 'scenic', geometry: [[0, 0], [1, 1]] }
  const fastest = { id: 'fastest', geometry: [[0, 0], [2, 2]] }
  const undrawable = { id: 'scenic', geometry: [] }

  it('prefers the objective being walked', () => {
    expect(pickRerouted({ routes: [fastest, scenic] }, 'scenic')).toBe(scenic)
  })

  it('falls back to whatever came back drawable', () => {
    // A changed objective is survivable mid-walk; an empty map is not.
    expect(pickRerouted({ routes: [undrawable, fastest] }, 'scenic')).toBe(fastest)
  })

  it('keeps a blocked route that still carries geometry', () => {
    // The accessible preset can answer `blocked` with a full line, steps and
    // barriers attached — and someone already walking it is exactly who must
    // keep being guided past those barriers.
    const blocked = { id: 'accessible', status: 'blocked', geometry: [[0, 0], [1, 1]] }
    expect(pickRerouted({ routes: [blocked] }, 'accessible')).toBe(blocked)
  })

  it('returns null when nothing can be drawn', () => {
    expect(pickRerouted({ routes: [undrawable] }, 'scenic')).toBeNull()
    expect(pickRerouted({ routes: [] }, 'scenic')).toBeNull()
    expect(pickRerouted(null, 'scenic')).toBeNull()
  })
})
