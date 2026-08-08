import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  PREFS_CACHE,
  PREF_URL,
  RESULTS_PREFIX,
  clearOfflineSetting,
  forgetResults,
  getOfflineSetting,
  refreshOfflineSetting,
  setSaveResults,
} from './offlineStore.js'

// A CacheStorage stand-in. Enough of the shape to exercise every branch: open,
// match, put, delete, keys. No jsdom, no new dependency.
function fakeCaches() {
  const buckets = new Map()
  const bucket = (name) => {
    if (!buckets.has(name)) buckets.set(name, new Map())
    const store = buckets.get(name)
    return {
      async match(url) {
        return store.has(url) ? { text: async () => store.get(url) } : undefined
      },
      async put(url, response) {
        store.set(url, await response.text())
      },
      async delete(url) {
        return store.delete(url)
      },
    }
  }
  return {
    buckets,
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

let fake

beforeEach(() => {
  fake = fakeCaches()
  globalThis.caches = fake.api
  globalThis.Response = class {
    constructor(body) {
      this.body = body
    }
    async text() {
      return this.body
    }
  }
})

afterEach(() => {
  delete globalThis.caches
  delete globalThis.Response
})

describe('the consent flag', () => {
  it('reads as off, and unasked, before anything is stored', async () => {
    await refreshOfflineSetting()
    expect(getOfflineSetting()).toEqual({ saveResults: false, chosen: false, ready: true })
  })

  it('round-trips a yes', async () => {
    await setSaveResults(true)
    await refreshOfflineSetting()
    expect(getOfflineSetting()).toMatchObject({ saveResults: true, chosen: true })
  })

  it('round-trips a no, and records that it was asked', async () => {
    await setSaveResults(false)
    await refreshOfflineSetting()
    expect(getOfflineSetting()).toMatchObject({ saveResults: false, chosen: true })
  })

  it('lives in the cache store, not in localStorage', async () => {
    // The whole reason this module was rewritten rather than ported: a third
    // localStorage key is not permitted here.
    await setSaveResults(true)
    expect([...fake.buckets.keys()]).toContain(PREFS_CACHE)
    const stored = await (await fake.api.open(PREFS_CACHE)).match(PREF_URL)
    expect(await stored.text()).toBe('true')
  })

  it('holds one word and nothing else', async () => {
    await setSaveResults(true)
    const stored = await (await fake.api.open(PREFS_CACHE)).match(PREF_URL)
    expect(await stored.text()).toMatch(/^(true|false)$/)
  })
})

describe('revoking consent', () => {
  it('deletes every saved route in the same breath', async () => {
    await fake.api.open(`${RESULTS_PREFIX}abc`)
    await fake.api.open(`${RESULTS_PREFIX}def`)
    await setSaveResults(false)
    expect([...fake.buckets.keys()].filter((k) => k.startsWith(RESULTS_PREFIX))).toEqual([])
  })

  it('never touches the shell or the prefs', async () => {
    await fake.api.open('meander-shell-deadbeef')
    await fake.api.open(`${RESULTS_PREFIX}abc`)
    await setSaveResults(true)
    await forgetResults()
    const names = [...fake.buckets.keys()]
    expect(names).toContain('meander-shell-deadbeef')
    expect(names).toContain(PREFS_CACHE)
    expect(names.filter((k) => k.startsWith(RESULTS_PREFIX))).toEqual([])
  })

  it('clearing the setting removes the record of the decision too', async () => {
    await setSaveResults(true)
    await clearOfflineSetting()
    await refreshOfflineSetting()
    expect(getOfflineSetting()).toEqual({ saveResults: false, chosen: false, ready: true })
  })
})

describe('when storage is unavailable', () => {
  it('reads as off on an origin with no CacheStorage', async () => {
    // window.caches is undefined on an insecure origin. Failing closed is the
    // only correct direction for a flag guarding a write of someone's location.
    delete globalThis.caches
    await refreshOfflineSetting()
    expect(getOfflineSetting()).toEqual({ saveResults: false, chosen: false, ready: true })
  })

  it('does not throw when every call rejects', async () => {
    globalThis.caches = {
      open: async () => {
        throw new Error('storage disabled')
      },
      keys: async () => {
        throw new Error('storage disabled')
      },
      delete: async () => {
        throw new Error('storage disabled')
      },
    }
    await expect(refreshOfflineSetting()).resolves.toBeDefined()
    await expect(setSaveResults(true)).resolves.toBeUndefined()
    await expect(forgetResults()).resolves.toBeUndefined()
    await expect(clearOfflineSetting()).resolves.toBeUndefined()
    expect(getOfflineSetting()).toMatchObject({ saveResults: false, ready: true })
  })

  it('does not claim consent was recorded when the write failed', async () => {
    // The worker reads the same absent flag and will save nothing. A control
    // still showing "Yes, keep them" would be promising something no part of
    // the system is doing.
    globalThis.caches = {
      open: async () => ({
        match: async () => undefined,
        put: async () => {
          throw new Error('quota')
        },
        delete: async () => false,
      }),
      keys: async () => [],
      delete: async () => false,
    }
    await setSaveResults(true)
    expect(getOfflineSetting().saveResults).toBe(false)
  })
})
