import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { RESULTS_PREFIX, SHELL_PREFIX, setSaveResults } from '../lib/offlineStore.js'
import { ENTRY_URL, readRoutes } from '../lib/resultsStore.js'
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

const REQ = { origin: { lat: 1, lon: 2 }, minutes: 30, mode: 'foot', objectives: ['fastest'] }

const call = async (response, { signal } = {}) => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => {
      if (typeof response === 'function') return response()
      return response
    }),
  )
  const seen = []
  const payload = await fetchRoutes(REQ, {
    signal,
    onProgress: () => {},
    onRoute: (route) => seen.push(route),
  })
  return { payload, seen }
}

// A CacheStorage stand-in, so the save path in client.js runs for real rather
// than being mocked out. Without this every "is it stored?" assertion below
// would be grading a stub.
const SHELL = `${SHELL_PREFIX}abc123abc123`
const RESULTS = `${RESULTS_PREFIX}abc123abc123`

function installFakeCaches() {
  const buckets = new Map()
  const bucket = (name) => {
    if (!buckets.has(name)) buckets.set(name, new Map())
    const store = buckets.get(name)
    return {
      // Real Cache Storage clones on both sides. Storing the Response itself
      // would let the first reader consume the body and leave every later read
      // seeing an empty one — which looks exactly like "nothing was saved".
      match: async (url) => store.get(url)?.clone(),
      put: async (url, response) => store.set(url, response.clone()),
      delete: async (url) => store.delete(url),
      keys: async () => [...store.keys()],
    }
  }
  const api = {
    open: async (name) => bucket(name),
    keys: async () => [...buckets.keys()],
    delete: async (name) => buckets.delete(name),
  }
  vi.stubGlobal('caches', api)
  bucket(SHELL)
  return { buckets, api }
}

let fake

beforeEach(() => {
  fake = installFakeCaches()
})

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

// The store moved out of the service worker, so client.js is what decides
// whether an answer is worth keeping. Each refusal below is a way this could
// store something the old worker structurally could not.

describe('what reaches the store', () => {
  it('keeps a completed answer when the user has consented', async () => {
    await setSaveResults(true)
    await call(sseResponse({}))
    expect(fake.buckets.get(RESULTS)?.has(ENTRY_URL)).toBe(true)
    const hit = await readRoutes(REQ)
    expect(hit.payload.routes[0]).toMatchObject({ id: 'fastest' })
  })

  it('keeps nothing when the user has not consented', async () => {
    await call(sseResponse({}))
    expect(fake.buckets.has(RESULTS)).toBe(false)
  })

  it('keeps nothing from a stream that never said done', async () => {
    // A stream that stopped part-way is not an answer, and replaying one later
    // as though it were would be worse than having nothing to replay.
    await setSaveResults(true)
    const bytes = new TextEncoder().encode(
      `data: ${JSON.stringify({ type: 'route', route: ROUTE })}\n\n`,
    )
    let sent = false
    await call({
      ok: true,
      headers: new Headers({ 'content-type': 'text/event-stream' }),
      body: {
        getReader: () => ({
          read: async () => (sent ? { done: true } : ((sent = true), { done: false, value: bytes })),
        }),
      },
    })
    expect(fake.buckets.get(RESULTS)?.has(ENTRY_URL) ?? false).toBe(false)
  })

  it('keeps nothing from a request the user has already moved on from', async () => {
    // App.jsx aborts on every dial drag and chip toggle. The request that lost
    // the race is not the one on screen.
    await setSaveResults(true)
    const controller = new AbortController()
    controller.abort()
    await call(sseResponse({}), { signal: controller.signal })
    expect(fake.buckets.get(RESULTS)?.has(ENTRY_URL) ?? false).toBe(false)
  })

  it('does not re-save a replay, which would relabel it as fresh', async () => {
    await setSaveResults(true)
    await call(sseResponse({ 'X-Meander-Cached': STAMP }))
    expect(fake.buckets.get(RESULTS)?.has(ENTRY_URL) ?? false).toBe(false)
  })
})

describe('when the network is gone', () => {
  const offline = () => {
    throw new TypeError('Failed to fetch')
  }

  it('answers from the saved set, stamped with its age', async () => {
    await setSaveResults(true)
    await call(sseResponse({}))

    const { payload, seen } = await call(offline)
    expect(payload.routes[0]).toMatchObject({ id: 'fastest', servedFromCache: true })
    expect(payload.routes[0].cachedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    // Replayed through onRoute in stream order, so nothing downstream has to
    // know it is looking at a replay except by the stamp.
    expect(seen[0]).toMatchObject({ servedFromCache: true })
  })

  it('raises the network error when nothing was saved', async () => {
    await expect(call(offline)).rejects.toThrow(/Could not reach the Meander server/)
  })

  it('raises the network error rather than answering a different search', async () => {
    await setSaveResults(true)
    await call(sseResponse({}))
    vi.stubGlobal('fetch', vi.fn(offline))
    await expect(
      fetchRoutes(
        { ...REQ, minutes: 90 },
        { onProgress: () => {}, onRoute: () => {} },
      ),
    ).rejects.toThrow(/Could not reach the Meander server/)
  })

  /** Headers arrive, then the link dies inside the body. */
  const diesMidStream = () => {
    let sent = false
    return {
      ok: true,
      headers: new Headers({ 'content-type': 'text/event-stream' }),
      body: {
        getReader: () => ({
          read: async () => {
            if (sent) throw new TypeError('network error')
            sent = true
            return {
              done: false,
              value: new TextEncoder().encode(
                `data: ${JSON.stringify({ type: 'progress', done: 1 })}\n\n`,
              ),
            }
          },
        }),
      },
    }
  }

  it('answers from the saved set when the link dies mid-stream', async () => {
    await setSaveResults(true)
    await call(sseResponse({}))
    const { payload } = await call(diesMidStream)
    expect(payload.routes[0]).toMatchObject({ id: 'fastest', servedFromCache: true })
  })

  it('raises written copy, not the browser’s string, when it dies mid-stream', async () => {
    await expect(call(diesMidStream)).rejects.toThrow(/connection dropped part-way through/)
    await expect(call(diesMidStream)).rejects.not.toThrow(/network error/)
  })

  it('does not replay over routes it has already delivered', async () => {
    // Replaying after some routes have been dispatched would deliver them a
    // second time and the list would grow duplicates rather than recover.
    await setSaveResults(true)
    await call(sseResponse({}))
    let sent = 0
    const halfThenDie = () => ({
      ok: true,
      headers: new Headers({ 'content-type': 'text/event-stream' }),
      body: {
        getReader: () => ({
          read: async () => {
            if (sent >= 1) throw new TypeError('network error')
            sent += 1
            return {
              done: false,
              value: new TextEncoder().encode(
                `data: ${JSON.stringify({ type: 'route', route: ROUTE })}\n\n`,
              ),
            }
          },
        }),
      },
    })
    const seen = []
    vi.stubGlobal('fetch', vi.fn(async () => halfThenDie()))
    await expect(
      fetchRoutes(REQ, { onProgress: () => {}, onRoute: (r) => seen.push(r) }),
    ).rejects.toThrow(/connection dropped part-way through/)
    expect(seen).toHaveLength(1)
  })

  it('keeps the server’s own message when the stream reports an error event', async () => {
    const bytes = new TextEncoder().encode(
      `data: ${JSON.stringify({ type: 'error', message: 'The router ran out of time.' })}\n\n`,
    )
    let sent = false
    await expect(
      call({
        ok: true,
        headers: new Headers({ 'content-type': 'text/event-stream' }),
        body: {
          getReader: () => ({
            read: async () =>
              sent ? { done: true } : ((sent = true), { done: false, value: bytes }),
          }),
        },
      }),
    ).rejects.toThrow(/The router ran out of time/)
  })

  it('raises the network error after consent is withdrawn', async () => {
    await setSaveResults(true)
    await call(sseResponse({}))
    await setSaveResults(false)
    await expect(call(offline)).rejects.toThrow(/Could not reach the Meander server/)
  })
})
