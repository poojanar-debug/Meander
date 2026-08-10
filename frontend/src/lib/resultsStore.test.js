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

describe('the same spot, measured', () => {
  // Everything here is in metres on the ground, not in decimal places, because
  // the claim being tested is about a person standing still — not about a
  // constant. The threshold is never asserted; it is searched for and reported,
  // and the only assertions are the two claims the change was made on: a few
  // metres replays, two hundred metres does not.

  const METRES_PER_DEG_LAT = 111320
  const rad = (deg) => (deg * Math.PI) / 180

  /** Move a point `metres` along `bearing` (0 = north, 90 = east). */
  const offsetBy = ({ lat, lon }, metres, bearing) => ({
    lat: lat + (metres * Math.cos(rad(bearing))) / METRES_PER_DEG_LAT,
    lon: lon + (metres * Math.sin(rad(bearing))) / (METRES_PER_DEG_LAT * Math.cos(rad(lat))),
  })

  /** What the offset actually came out as, computed back from the coordinates. */
  const metresBetween = (a, b) => {
    const dy = (b.lat - a.lat) * METRES_PER_DEG_LAT
    const dx = (b.lon - a.lon) * METRES_PER_DEG_LAT * Math.cos(rad((a.lat + b.lat) / 2))
    return Math.hypot(dx, dy)
  }

  const BEARINGS = Array.from({ length: 36 }, (_, i) => i * 10)
  const at = (origin) => ({ ...REQ, origin })

  /**
   * Saved fixes spread across one grid square, corners included.
   *
   * REQ.origin is 51.5074, -0.1278 — both of which land exactly on a grid line,
   * so it sits dead centre of its square. That is the *most* favourable place a
   * saved fix can be, and measuring only from there would report a boundary
   * nobody standing anywhere else would get. These nine cover the square: centre,
   * edges and corners.
   */
  const CELL = 1e-4
  const WITHIN_CELL = [-0.49, 0, 0.49].flatMap((fy) =>
    [-0.49, 0, 0.49].map((fx) => ({
      lat: REQ.origin.lat + fy * CELL,
      lon: REQ.origin.lon + fx * CELL,
      where: `${fy > 0 ? 'N' : fy < 0 ? 'S' : '-'}${fx > 0 ? 'E' : fx < 0 ? 'W' : '-'}`,
    })),
  )

  it('moves a point the distance it says it does', () => {
    // The guard against the whole block being vacuous. If offsetBy were wrong —
    // a missing cos(lat), a degrees/radians slip — every "5 metres" below would
    // really be some other distance and the measurements would be fiction.
    for (const bearing of BEARINGS) {
      for (const metres of [0.5, 5, 25, 200]) {
        const moved = offsetBy(REQ.origin, metres, bearing)
        expect(metresBetween(REQ.origin, moved), `${metres}m @ ${bearing}°`).toBeCloseTo(metres, 2)
      }
    }
  })

  it('replays a fix five metres away, from every direction and anywhere in the square', async () => {
    await setSaveResults(true)
    for (const saved of WITHIN_CELL) {
      await saveRoutes(at(saved), payloadOf())
      for (const bearing of BEARINGS) {
        const moved = offsetBy(saved, 5, bearing)
        expect(await readRoutes(at(moved)), `5m @ ${bearing}° from ${saved.where}`).not.toBeNull()
      }
    }
  })

  it('refuses a fix two hundred metres away, from every direction and anywhere in the square', async () => {
    await setSaveResults(true)
    for (const saved of WITHIN_CELL) {
      await saveRoutes(at(saved), payloadOf())
      for (const bearing of BEARINGS) {
        const moved = offsetBy(saved, 200, bearing)
        expect(await readRoutes(at(moved)), `200m @ ${bearing}° from ${saved.where}`).toBeNull()
      }
    }
  })

  it('replays across a grid line, which rounding on its own would not', async () => {
    // The case that makes plain rounding a coin flip. These two fixes are a
    // fraction of a millimetre apart and fall either side of a cell boundary,
    // so their rounded coordinates differ. Two people could not stand this
    // close together; if this misses, "the same spot" means "the same spot
    // unless a grid line happens to run through it".
    const line = (Math.round(REQ.origin.lat * 1e4) + 0.5) / 1e4
    const below = { lat: line - 1e-9, lon: REQ.origin.lon }
    const above = { lat: line + 1e-9, lon: REQ.origin.lon }
    // Both halves stated, so the test cannot pass by accident: the two really
    // are in different cells, and they really are that close together.
    expect(Math.round(below.lat * 1e4)).not.toBe(Math.round(above.lat * 1e4))
    expect(metresBetween(below, above)).toBeLessThan(0.001)

    await setSaveResults(true)
    await saveRoutes(at(below), payloadOf())
    expect(await readRoutes(at(above))).not.toBeNull()
  })

  it('measures where the replay actually stops', async () => {
    await setSaveResults(true)

    // Along one bearing the cell distance only grows, so the flip is a single
    // point and a bisection finds it. Reported rather than pinned: the exact
    // number depends on latitude and on where in the square the saved fix sat,
    // and hard-coding it here would turn a measurement back into the assertion
    // this block exists to avoid.
    const flipFor = async (saved, bearing) => {
      let hit = 0
      let miss = 400
      for (let i = 0; i < 24; i += 1) {
        const mid = (hit + miss) / 2
        if (await readRoutes(at(offsetBy(saved, mid, bearing)))) hit = mid
        else miss = mid
      }
      return miss
    }

    const flips = []
    for (const saved of WITHIN_CELL) {
      await saveRoutes(at(saved), payloadOf())
      for (const bearing of BEARINGS) flips.push(await flipFor(saved, bearing))
    }
    const nearest = Math.min(...flips)
    const furthest = Math.max(...flips)

    // eslint-disable-next-line no-console
    console.log(
      `replay stops between ${nearest.toFixed(2)} m and ${furthest.toFixed(2)} m of the saved ` +
        `fix (lat ${REQ.origin.lat}, ${WITHIN_CELL.length} positions across one square × ` +
        `${BEARINGS.length} bearings); 5 m and 200 m sit either side`,
    )

    // The two claims, and nothing about 4 decimal places.
    expect(nearest).toBeGreaterThan(5)
    expect(furthest).toBeLessThan(200)
  })

  it('does not round the request it was handed', async () => {
    // The grid lives in the key. The body api/client.js posts to the router is
    // the caller's object, and it must come back untouched — a store that
    // rounded in place would quietly degrade routing accuracy to 11 m.
    const precise = at({ lat: 51.50749123, lon: -0.16220987 })
    const before = JSON.stringify(precise)
    await setSaveResults(true)
    await saveRoutes(precise, payloadOf())
    await readRoutes(precise)
    expect(JSON.stringify(precise)).toBe(before)
    expect(precise.origin.lat).toBe(51.50749123)
    expect(precise.origin.lon).toBe(-0.16220987)
  })

  it('writes neither the coordinate nor the cell it was snapped to', async () => {
    // Rounding a coordinate is still recording one if the rounded value is
    // written down. Only the digest may be.
    await setSaveResults(true)
    await saveRoutes(REQ, payloadOf())
    const stored = await (await fake.api.open(`${RESULTS_PREFIX}deadbeef1234`)).match(ENTRY_URL)
    const raw = await stored.text()
    const envelope = JSON.parse(raw)
    expect(Object.keys(envelope).sort()).toEqual(['fingerprint', 'payload', 'v'])
    expect(envelope.fingerprint).toMatch(/^[0-9a-f]{64}$/)
    for (const trace of ['51.5074', '515074', '-0.1278', '-1278', '1278']) {
      expect(envelope.fingerprint, trace).not.toContain(trace)
    }
  })

  it('keeps one set when two fixes a few metres apart search in a row', async () => {
    // The ordinary case for someone walking: two searches, two fixes, same
    // pavement. Still one entry — and it is the second walk, which is also what
    // the first fix now gets back. Four metres apart, so it is the same walk;
    // stated because it is a real consequence of the widening, not a surprise.
    await setSaveResults(true)
    const first = REQ
    const second = at(offsetBy(REQ.origin, 4, 45))
    await saveRoutes(first, payloadOf(1))
    await saveRoutes(second, payloadOf(2))

    expect(fake.entries(`${RESULTS_PREFIX}deadbeef1234`)).toEqual([ENTRY_URL])
    expect(
      [...fake.buckets.keys()].filter((n) => n.startsWith(RESULTS_PREFIX)),
    ).toHaveLength(1)
    expect((await readRoutes(second)).payload.routes).toHaveLength(2)
    expect((await readRoutes(first)).payload.routes).toHaveLength(2)
  })

  it('still refuses a different search from the identical spot', async () => {
    // The widening is only ever about the origin. Everything else stays exact,
    // or "the same search" would stop meaning the same search.
    await setSaveResults(true)
    await saveRoutes(REQ, payloadOf())
    for (const other of [
      { ...REQ, minutes: 45 },
      { ...REQ, mode: 'bike' },
      { ...REQ, objectives: ['nature'] },
      { ...REQ, destination: { lat: 51.5079, lon: -0.1283 } },
    ]) {
      expect(await readRoutes(other), JSON.stringify(other)).toBeNull()
    }
  })

  it('will not treat two destinations a metre apart as the same search', async () => {
    // A destination is picked from search and comes back byte-identical every
    // time, so there is no jitter to absorb — and two different places must not
    // answer for each other, however close.
    //
    // One metre, deliberately, and the assertion below proves why: it is well
    // inside a single grid square, so this can only miss because the
    // destination is hashed exactly. The first version of this test used eleven
    // metres, which crosses a square all by itself — it passed whether the
    // destination was rounded or not, and a mutant that rounded it survived.
    await setSaveResults(true)
    const dest = { lat: 51.5079, lon: -0.1283 }
    const withDest = { ...REQ, destination: dest }
    await saveRoutes(withDest, payloadOf())

    const nudged = { ...withDest, destination: offsetBy(dest, 1, 90) }
    expect(Math.round(nudged.destination.lat * 1e4)).toBe(Math.round(dest.lat * 1e4))
    expect(Math.round(nudged.destination.lon * 1e4)).toBe(Math.round(dest.lon * 1e4))
    expect(metresBetween(dest, nudged.destination)).toBeCloseTo(1, 2)

    expect(await readRoutes(nudged)).toBeNull()
    // …while the origin of that same search still tolerates a step.
    expect(await readRoutes({ ...withDest, origin: offsetBy(REQ.origin, 5, 90) })).not.toBeNull()
  })

  it('stores nothing and replays nothing without a usable origin', async () => {
    await setSaveResults(true)
    for (const broken of [
      { ...REQ, origin: undefined },
      { ...REQ, origin: {} },
      { ...REQ, origin: { lat: Number.NaN, lon: 0 } },
      { ...REQ, origin: { lat: 0, lon: Number.POSITIVE_INFINITY } },
    ]) {
      expect(await saveRoutes(broken, payloadOf()), JSON.stringify(broken)).toBe(false)
      expect(await readRoutes(broken), JSON.stringify(broken)).toBeNull()
    }
    expect(fake.entries(`${RESULTS_PREFIX}deadbeef1234`)).toEqual([])
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
