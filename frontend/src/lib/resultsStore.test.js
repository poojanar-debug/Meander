import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { RESULTS_PREFIX, SHELL_PREFIX, forgetResults, setSaveResults } from './offlineStore.js'
import { ENTRY_URL, readRoutes, resultsCacheName, saveRoutes } from './resultsStore.js'

// These are the invariants that used to be asserted by grepping sw.js as text,
// in sw-contract.test.js — "stores only a completed stream", "deletes what is
// already there before putting the new one", "keys on the request body, not the
// URL alone". They were greps because a service worker cannot be imported into
// a node runner. The store is a module now, so they are behaviour instead, and
// each one is exercised through the real function rather than matched against
// its source.

const SHELL = `${SHELL_PREFIX}deadbeef1234`

/**
 * A CacheStorage stand-in, one step richer than offlineStore.test.js's: entries
 * carry headers, and buckets answer keys(). Both are load-bearing here — the
 * age is a header, and "exactly one entry" is a claim about keys().
 */
function fakeCaches() {
  const buckets = new Map()
  const bucket = (name) => {
    if (!buckets.has(name)) buckets.set(name, new Map())
    const store = buckets.get(name)
    return {
      async match(url) {
        return store.get(url)
      },
      async put(url, response) {
        store.set(url, response)
      },
      async delete(url) {
        return store.delete(url)
      },
      async keys() {
        return [...store.keys()]
      },
    }
  }
  return {
    buckets,
    entries: (name) => [...(buckets.get(name)?.keys() ?? [])],
    api: {
      async open(name) {
        return bucket(name)
      },
      async keys() {
        return [...buckets.keys()]
      },
      async delete(name) {
        return buckets.delete(name)
      },
    },
  }
}

const payloadOf = (n = 3) => ({
  routes: Array.from({ length: n }, (_, i) => ({ id: `r${i}`, geometry: [[0, 0]] })),
  cache: { segments_scored: 1, hit_rate: 1 },
})

const REQ = { origin: { lat: 51.5074, lon: -0.1278 }, minutes: 30, mode: 'foot', objectives: [] }
const OTHER = { ...REQ, minutes: 45 }

let fake

beforeEach(async () => {
  fake = fakeCaches()
  globalThis.caches = fake.api
  globalThis.Response = class {
    constructor(body, init = {}) {
      this.body = body
      const headers = new Map(
        Object.entries(init.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]),
      )
      this.headers = { get: (name) => headers.get(name.toLowerCase()) ?? null }
    }
    async text() {
      return this.body
    }
  }
  await fake.api.open(SHELL)
})

afterEach(() => {
  delete globalThis.caches
  delete globalThis.Response
})

describe('the bucket it writes to', () => {
  it('is versioned against the installed shell, so a deploy still replaces it', async () => {
    expect(await resultsCacheName()).toBe(`${RESULTS_PREFIX}deadbeef1234`)
  })

  it('is a name forgetResults() already deletes', async () => {
    expect(await resultsCacheName()).toMatch(new RegExp(`^${RESULTS_PREFIX}`))
  })

  it('does not exist when no shell is installed, and nothing is stored', async () => {
    // A Capacitor shell registers no worker, so there is no version to bind to.
    // Inventing one would start storing routes on a platform where DEPLOY.md
    // records the affordance as inert.
    await fake.api.delete(SHELL)
    await setSaveResults(true)
    expect(await resultsCacheName()).toBeNull()
    expect(await saveRoutes(REQ, payloadOf())).toBe(false)
  })
})

describe('nothing is stored without consent', () => {
  it('stores nothing when the user has never been asked', async () => {
    expect(await saveRoutes(REQ, payloadOf())).toBe(false)
    expect(fake.entries(`${RESULTS_PREFIX}deadbeef1234`)).toEqual([])
  })

  it('stores nothing when the user said no', async () => {
    await setSaveResults(false)
    expect(await saveRoutes(REQ, payloadOf())).toBe(false)
  })

  it('stores when the user said yes', async () => {
    await setSaveResults(true)
    expect(await saveRoutes(REQ, payloadOf())).toBe(true)
    expect(fake.entries(`${RESULTS_PREFIX}deadbeef1234`)).toEqual([ENTRY_URL])
  })

  it('reads the flag from storage, not from the React snapshot', async () => {
    // The snapshot is a render behind, and a tab behind. A save must see the
    // "No" that was pressed while the stream was still arriving.
    await setSaveResults(true)
    const flight = saveRoutes(REQ, payloadOf())
    await setSaveResults(false)
    await flight
    expect(fake.buckets.has(`${RESULTS_PREFIX}deadbeef1234`)).toBe(false)
  })

  it('never writes at all without consent, not even briefly', async () => {
    // The two consent checks — before the put and after it — mask each other if
    // you only look at the end state. Deleting the first one leaves a store
    // that writes a person's coordinates to disk and then removes them, and
    // every assertion about buckets still passes. "Nothing is stored without
    // consent" is a claim about the write, so the write is what is counted.
    // Found by mutation: dropping the pre-write check kept 22/22 green.
    const puts = []
    const inner = fake.api.open
    globalThis.caches = {
      ...fake.api,
      open: async (name) => {
        const bucket = await inner(name)
        return {
          ...bucket,
          put: async (url, response) => {
            puts.push(name)
            return bucket.put(url, response)
          },
        }
      },
    }

    await saveRoutes(REQ, payloadOf())
    await setSaveResults(false)
    await saveRoutes(REQ, payloadOf())

    expect(puts.filter((name) => name.startsWith(RESULTS_PREFIX))).toEqual([])
  })

  it('answers no when the flag cannot be read at all', async () => {
    // Moved from sw-contract.test.js — "answers no when the flag cannot be
    // read", which used to be a regex over mayStoreResults().
    await setSaveResults(true)
    globalThis.caches = {
      open: async () => {
        throw new Error('storage disabled')
      },
      keys: async () => {
        throw new Error('storage disabled')
      },
      delete: async () => false,
    }
    expect(await saveRoutes(REQ, payloadOf())).toBe(false)
    expect(await readRoutes(REQ)).toBeNull()
  })

  it('stores nothing on an origin with no CacheStorage', async () => {
    delete globalThis.caches
    expect(await saveRoutes(REQ, payloadOf())).toBe(false)
    expect(await readRoutes(REQ)).toBeNull()
  })
})

describe('a saved route cannot become a history', () => {
  it('keeps exactly one entry across many searches', async () => {
    await setSaveResults(true)
    for (const minutes of [30, 45, 60, 90]) {
      await saveRoutes({ ...REQ, minutes }, payloadOf())
    }
    expect(fake.entries(`${RESULTS_PREFIX}deadbeef1234`)).toEqual([ENTRY_URL])
  })

  it('keeps the most recent one, not the first', async () => {
    await setSaveResults(true)
    await saveRoutes(REQ, payloadOf(1))
    await saveRoutes(OTHER, payloadOf(2))
    expect(await readRoutes(REQ)).toBeNull()
    expect((await readRoutes(OTHER)).payload.routes).toHaveLength(2)
  })

  it('stores only a completed answer', async () => {
    // Moved from sw-contract.test.js — the worker refused any stream without a
    // "done" event. The page's equivalent is that client.js never offers a null
    // final; this is the store's own half of it.
    await setSaveResults(true)
    expect(await saveRoutes(REQ, null)).toBe(false)
    expect(await saveRoutes(REQ, { routes: [] })).toBe(false)
    expect(await saveRoutes(REQ, {})).toBe(false)
    expect(fake.entries(`${RESULTS_PREFIX}deadbeef1234`)).toEqual([])
  })

  it('answers the same search and refuses a different one', async () => {
    // Moved from "keys the cache on the request body, not on the URL alone".
    // Every route request is a POST to the same path, so a store that matched
    // on the URL would replay one walk as the answer to another.
    await setSaveResults(true)
    await saveRoutes(REQ, payloadOf())
    expect(await readRoutes(REQ)).not.toBeNull()
    expect(await readRoutes(OTHER)).toBeNull()
  })

  it('keeps one set across two shell caches, not one per shell', async () => {
    // sw.js prunes every shell but the current one on activate — but two can
    // coexist between a new worker's install and that activate, or when an
    // install fails. resultsCacheName() derives the bucket from whichever shell
    // it finds, so without a sweep before the put, two saves land in two
    // buckets and there are two sets of routes on disk at once.
    await setSaveResults(true)
    await saveRoutes(REQ, payloadOf())
    await fake.api.open(`${SHELL_PREFIX}0000newshell`) // sorts before 'deadbeef…'
    await saveRoutes(OTHER, payloadOf())

    const resultBuckets = [...fake.buckets.keys()].filter((n) => n.startsWith(RESULTS_PREFIX))
    expect(resultBuckets).toHaveLength(1)
    const total = resultBuckets.reduce((n, b) => n + fake.entries(b).length, 0)
    expect(total).toBe(1)
  })

  it('clears a bucket left by a previous build rather than adding to it', async () => {
    await setSaveResults(true)
    await fake.api.open(`${RESULTS_PREFIX}oldbuildhash`)
    await saveRoutes(REQ, payloadOf())
    expect([...fake.buckets.keys()].filter((n) => n.startsWith(RESULTS_PREFIX))).toEqual([
      `${RESULTS_PREFIX}deadbeef1234`,
    ])
  })

  it('writes no coordinate into a key anything can enumerate', async () => {
    await setSaveResults(true)
    await saveRoutes(REQ, payloadOf())
    const keys = fake.entries(`${RESULTS_PREFIX}deadbeef1234`)
    expect(keys).toEqual([ENTRY_URL])
    expect(keys.join()).not.toContain('51.5074')
    const stored = await (await fake.api.open(`${RESULTS_PREFIX}deadbeef1234`)).match(ENTRY_URL)
    const envelope = JSON.parse(await stored.text())
    expect(envelope.fingerprint).toMatch(/^[0-9a-f]{64}$/)
    expect(JSON.stringify(envelope.fingerprint)).not.toContain('51.5074')
  })
})

describe('the age it is labelled with', () => {
  it('is written as the header client.js reads', async () => {
    await setSaveResults(true)
    const before = Date.now()
    await saveRoutes(REQ, payloadOf())
    const { response } = await readRoutes(REQ)
    const cachedAt = response.headers.get('X-Meander-Cached')
    expect(cachedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    expect(new Date(cachedAt).valueOf()).toBeGreaterThanOrEqual(before - 1000)
  })

  it('is the moment it was written, and moves when it is rewritten', async () => {
    await setSaveResults(true)
    await saveRoutes(REQ, payloadOf())
    const first = (await readRoutes(REQ)).response.headers.get('X-Meander-Cached')
    await new Promise((r) => setTimeout(r, 5))
    await saveRoutes(REQ, payloadOf())
    const second = (await readRoutes(REQ)).response.headers.get('X-Meander-Cached')
    expect(new Date(second).valueOf()).toBeGreaterThanOrEqual(new Date(first).valueOf())
  })
})

describe('withdrawing consent', () => {
  it('deletes the saved set immediately', async () => {
    await setSaveResults(true)
    await saveRoutes(REQ, payloadOf())
    expect(fake.buckets.has(`${RESULTS_PREFIX}deadbeef1234`)).toBe(true)
    await setSaveResults(false)
    expect(fake.buckets.has(`${RESULTS_PREFIX}deadbeef1234`)).toBe(false)
    expect(await readRoutes(REQ)).toBeNull()
  })

  it('leaves the shell and the prefs alone', async () => {
    await setSaveResults(true)
    await saveRoutes(REQ, payloadOf())
    await forgetResults()
    const names = [...fake.buckets.keys()]
    expect(names).toContain(SHELL)
    expect(names).toContain('meander-prefs')
    expect(names.filter((n) => n.startsWith(RESULTS_PREFIX))).toEqual([])
  })

  it('deletes through the handle it holds, which is what reaches an unlinked bucket', async () => {
    // A Cache handle outlives caches.delete(name): the bucket leaves the
    // registry, the handle keeps working, and anything written through it lands
    // where caches.keys() cannot see it — so forgetResults(), which deletes by
    // name, can never reach it. That is a saved route nothing in the app can
    // delete. The fake models exactly that: the bucket is unregistered but the
    // handle still writes into the same Map.
    await setSaveResults(true)
    const name = `${RESULTS_PREFIX}deadbeef1234`

    const realOpen = fake.api.open
    let unlinkOnce = true
    let orphaned = null
    let puts = 0
    globalThis.caches = {
      ...fake.api,
      open: async (n) => {
        const handle = await realOpen(n)
        if (n === name && unlinkOnce) {
          unlinkOnce = false
          // The Map this handle is backed by. Whatever happens to the registry
          // afterwards, writes through the handle land here.
          orphaned = fake.buckets.get(n)
          return {
            ...handle,
            put: async (url, res) => {
              // Consent withdrawn and the bucket unlinked between open() and
              // the write landing — the interleaving saveRoutes describes.
              await setSaveResults(false)
              fake.buckets.delete(n)
              puts += 1
              return handle.put(url, res)
            },
          }
        }
        return handle
      },
    }

    await saveRoutes(REQ, payloadOf())

    // The write has to have happened, or this proves nothing about reaching it.
    expect(puts).toBe(1)
    expect(orphaned).not.toBeNull()
    expect(fake.buckets.has(name)).toBe(false) // unlinked: deletion by name cannot reach it
    expect([...orphaned.keys()]).toEqual([])
  })

  it('refuses to replay after a withdrawal, even if a bucket survived', async () => {
    await setSaveResults(true)
    await saveRoutes(REQ, payloadOf())
    // Simulate the deletion failing while the flag write succeeded.
    const bucket = fake.buckets.get(`${RESULTS_PREFIX}deadbeef1234`)
    await setSaveResults(false)
    fake.buckets.set(`${RESULTS_PREFIX}deadbeef1234`, bucket)
    expect(await readRoutes(REQ)).toBeNull()
  })
})

describe('when storage refuses', () => {
  it('never throws, whatever the browser does', async () => {
    await setSaveResults(true)
    globalThis.caches = {
      open: async () => ({
        match: async () => undefined,
        put: async () => {
          throw new Error('QuotaExceededError')
        },
        delete: async () => false,
        keys: async () => [],
      }),
      keys: async () => [SHELL],
      delete: async () => false,
    }
    await expect(saveRoutes(REQ, payloadOf())).resolves.toBe(false)
    await expect(readRoutes(REQ)).resolves.toBeNull()
  })

  it('ignores an envelope it does not recognise rather than guessing', async () => {
    await setSaveResults(true)
    const bucket = await fake.api.open(`${RESULTS_PREFIX}deadbeef1234`)
    await bucket.put(ENTRY_URL, new globalThis.Response('{"v":999,"payload":{"routes":[]}}', {}))
    expect(await readRoutes(REQ)).toBeNull()
  })

  it('ignores a corrupt entry rather than throwing into the error banner', async () => {
    await setSaveResults(true)
    const bucket = await fake.api.open(`${RESULTS_PREFIX}deadbeef1234`)
    await bucket.put(ENTRY_URL, new globalThis.Response('not json at all', {}))
    expect(await readRoutes(REQ)).toBeNull()
  })
})
