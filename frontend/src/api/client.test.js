import { afterEach, describe, expect, it, vi } from 'vitest'

import { fetchRoutes } from './client.js'

// The stamp is applied once, at the boundary. A route that travels any further
// without it can be rendered as current by anything downstream — which is the
// whole failure this capability exists to prevent.

const ROUTE = { id: 'fastest', label: 'Fastest', status: 'ok', distance_m: 2600 }
const STAMP = '2026-08-08T11:30:00.000Z'

const jsonResponse = (headers) => ({
  ok: true,
  headers: new Headers({ 'content-type': 'application/json', ...headers }),
  json: async () => ({ routes: [ROUTE], cache: {} }),
})

const sseResponse = (headers) => {
  const frames = [
    `data: ${JSON.stringify({ type: 'route', route: ROUTE })}\n\n`,
    `data: ${JSON.stringify({ type: 'done', payload: { routes: [ROUTE], cache: {} } })}\n\n`,
  ].join('')
  const bytes = new TextEncoder().encode(frames)
  let sent = false
  return {
    ok: true,
    headers: new Headers({ 'content-type': 'text/event-stream', ...headers }),
    body: {
      getReader: () => ({
        read: async () => (sent ? { done: true } : ((sent = true), { done: false, value: bytes })),
      }),
    },
  }
}

const call = async (response) => {
  vi.stubGlobal('fetch', vi.fn(async () => response))
  const seen = []
  const payload = await fetchRoutes(
    { origin: { lat: 1, lon: 2 }, minutes: 30, mode: 'foot', objectives: ['fastest'] },
    { onProgress: () => {}, onRoute: (route) => seen.push(route) },
  )
  return { payload, seen }
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('a replayed response is stamped', () => {
  it('marks every route from a JSON body', async () => {
    const { payload, seen } = await call(jsonResponse({ 'X-Meander-Cached': STAMP }))
    expect(seen[0]).toMatchObject({ servedFromCache: true, cachedAt: STAMP })
    expect(payload.routes[0]).toMatchObject({ servedFromCache: true, cachedAt: STAMP })
  })

  it('marks every route from a stream', async () => {
    const { payload, seen } = await call(sseResponse({ 'X-Meander-Cached': STAMP }))
    expect(seen[0]).toMatchObject({ servedFromCache: true, cachedAt: STAMP })
    expect(payload.routes[0]).toMatchObject({ servedFromCache: true, cachedAt: STAMP })
  })
})

describe('a live response is not stamped', () => {
  it('leaves routes alone when the header is absent', async () => {
    const { payload, seen } = await call(jsonResponse({}))
    expect(seen[0].servedFromCache).toBeUndefined()
    expect(payload.routes[0].servedFromCache).toBeUndefined()
  })

  it('ignores the server’s own cache header', async () => {
    // X-Meander-Cache (server: "I had a warm cache, this answer is current") is
    // one letter from X-Meander-Cached (worker: "this is a replay"). They mean
    // opposite things, and conflating them would label every fast answer stale.
    const { payload, seen } = await call(jsonResponse({ 'X-Meander-Cache': 'hit' }))
    expect(seen[0].servedFromCache).toBeUndefined()
    expect(payload.routes[0].servedFromCache).toBeUndefined()
  })
})
