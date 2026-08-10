import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import { PAGES_CONTROL_FILES, isPrecachable } from '../../vite.config.js'
import { PREFS_CACHE, PREF_URL, RESULTS_PREFIX } from './offlineStore.js'

// sw.js runs in a worker, cannot import from src/, and cannot be unit-tested in
// a node runner. What *can* be checked is the source text — and the properties
// worth checking are the ones whose failure mode is silent and permanent: a
// worker that quietly caches map tiles, or one whose consent flag stops
// agreeing with the page's.

const sw = readFileSync(fileURLToPath(new URL('../../sw.js', import.meta.url)), 'utf8')
const code = sw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

describe('the worker and the page agree on their three strings', () => {
  // The worker cannot import them, so they are duplicated. Duplication is fine;
  // silent divergence is not.
  it('uses the same prefs cache name', () => {
    expect(code).toContain(`'${PREFS_CACHE}'`)
  })
  it('uses the same pref URL', () => {
    expect(code).toContain(`'${PREF_URL}'`)
  })
  it('uses the same results prefix', () => {
    expect(code).toContain(`'${RESULTS_PREFIX}'`)
  })
})

describe('nothing cross-origin is ever cached', () => {
  it('returns early for any other origin in the fetch listener', () => {
    // This one line is the whole of "map tiles are never cached". A tile cache
    // is a record of where you have been. It is asserted rather than trusted.
    expect(code).toMatch(/url\.origin\s*!==\s*self\.location\.origin\)\s*return/)
  })

  it('names no third-party host anywhere', () => {
    expect(code).not.toMatch(/openfreemap|tile|nominatim|https?:\/\//)
  })

  it('does the origin check before anything is stored or responded to', () => {
    const listener = code.slice(code.indexOf("addEventListener('fetch'"))
    const originGuard = listener.indexOf('self.location.origin')
    const firstRespond = listener.indexOf('respondWith')
    expect(originGuard).toBeGreaterThan(-1)
    expect(originGuard).toBeLessThan(firstRespond)
  })
})

describe('the consent flag fails closed', () => {
  it('keeps the prefs cache unversioned', () => {
    // Versioning it would let a deploy silently re-grant a withdrawn permission
    // — or silently withdraw a given one.
    expect(code).toMatch(/PREFS_CACHE\s*=\s*'meander-prefs'/)
    expect(code).not.toMatch(/PREFS_CACHE\s*=\s*`[^`]*\$\{VERSION\}/)
  })

  it('versions the shell and results caches', () => {
    expect(code).toMatch(/SHELL_CACHE\s*=\s*`[^`]*\$\{VERSION\}/)
    expect(code).toMatch(/RESULTS_CACHE\s*=\s*`[^`]*\$\{VERSION\}/)
  })

  it('answers no when the flag cannot be read', () => {
    const fn = code.slice(code.indexOf('async function mayStoreResults'))
    const body = fn.slice(0, fn.indexOf('\n}'))
    expect(body).toMatch(/catch\s*{\s*return false/)
  })

  it('has no message channel — the page owns the flag', () => {
    expect(code).not.toContain("addEventListener('message'")
  })
})

describe('a saved route cannot become a history', () => {
  it('stores only a completed stream', () => {
    const fn = code.slice(code.indexOf('async function storeResult'))
    const body = fn.slice(0, fn.indexOf('\n}'))
    expect(body).toContain('"type":"done"')
    expect(body).toContain('"type":"error"')
  })

  it('deletes what is already there before putting the new one', () => {
    const fn = code.slice(code.indexOf('async function storeResult'))
    const body = fn.slice(0, fn.indexOf('\n}'))
    expect(body.indexOf('cache.delete')).toBeLessThan(body.indexOf('cache.put'))
  })

  it('forgets every saved route when consent is absent', () => {
    expect(code).toMatch(/else\s*{\s*event\.waitUntil\(forgetResults\(\)\)/)
  })

  it('never deletes the shell or the prefs when forgetting routes', () => {
    const fn = code.slice(code.indexOf('async function forgetResults'))
    const body = fn.slice(0, fn.indexOf('\n}'))
    expect(body).toContain('startsWith(RESULTS_PREFIX)')
    expect(body).not.toContain('meander-shell')
    expect(body).not.toContain('PREFS_CACHE')
  })

  it('keys the cache on the request body, not on the URL alone', () => {
    // Every route request is a POST to the same path. Keying on the URL would
    // make every search look like the same search.
    const fn = code.slice(code.indexOf('function routeCacheKey'))
    expect(fn.slice(0, fn.indexOf('\n}'))).toMatch(/body/)
  })

  it('computes the key before the fetch consumes the body', () => {
    const fn = code.slice(code.indexOf('async function handleRoutes'))
    const body = fn.slice(0, fn.indexOf('\n}\n'))
    expect(body.indexOf('routeCacheKey')).toBeLessThan(body.indexOf('await fetch('))
  })
})

describe('the precache never names a file Cloudflare Pages will not serve', () => {
  // cache.addAll() is atomic. One 404 in the manifest rejects the install and
  // the app has no service worker at all — so a Pages control file reaching
  // this list does not degrade offline, it deletes it.

  it('excludes any root-level file Cloudflare reserves, named or not', () => {
    // Literals that are NOT derived from PAGES_CONTROL_FILES. Asserting
    // `isPrecachable(x) === !PAGES_CONTROL_FILES.includes(x)` was X === X: a
    // reviewer put _routes.json in public/, took it out of the list, and the
    // whole suite stayed green while the built manifest shipped it. The last
    // name below is in no list anywhere, which is the point — it stands for the
    // control file Cloudflare adds next.
    for (const name of ['_headers', '_redirects', '_routes.json', '_worker.js', '_future.json']) {
      expect(isPrecachable(`/${name}`)).toBe(false)
    }
    expect(PAGES_CONTROL_FILES).toContain('_headers')
    expect(PAGES_CONTROL_FILES).toContain('_redirects')
  })

  it('grades every file that is actually in public/, whatever is in there', () => {
    const present = readdirSync(fileURLToPath(new URL('../../public', import.meta.url)))
    expect(present.length).toBeGreaterThan(0)
    for (const name of present) {
      expect(isPrecachable(`/${name}`)).toBe(!name.startsWith('_'))
    }
  })

  it('grades the manifest the build actually emitted, when there is one', () => {
    // The end of the chain: not the predicate, the shipped bytes.
    const dist = fileURLToPath(new URL('../../dist/sw.js', import.meta.url))
    if (!existsSync(dist)) return
    const m = /const PRECACHE = (\[[^\]]*\])/.exec(readFileSync(dist, 'utf8'))
    expect(m).not.toBeNull()
    const precache = JSON.parse(m[1])
    expect(precache.length).toBeGreaterThan(3)
    expect(precache.filter((u) => /^\/_/.test(u))).toEqual([])
    expect(precache).toContain('/index.html')
  })

  it('proves its own predicate — the things that should stay, stay', () => {
    // Without this, isPrecachable could `return false` for everything and the
    // tests above would still pass while the precache shipped empty.
    expect(isPrecachable('/assets/index-abc123.js')).toBe(true)
    expect(isPrecachable('/index.html')).toBe(true)
    expect(isPrecachable('/manifest.webmanifest')).toBe(true)
    expect(isPrecachable('/icon-512.png')).toBe(true)
    expect(isPrecachable('/')).toBe(true)
    expect(isPrecachable('/sw.js')).toBe(false)
    expect(isPrecachable('/assets/index-abc123.js.map')).toBe(false)
  })
})

describe('the build must substitute both placeholders', () => {
  it('leaves them in the source for the plugin to replace', () => {
    expect(sw).toContain('__PRECACHE_MANIFEST__')
    expect(sw).toContain('__PRECACHE_VERSION__')
  })
})

describe('the promise the header makes', () => {
  it('still says a tile cache is a record of where you have been', () => {
    // Load-bearing prose. If the line goes, the reasoning behind the origin
    // check goes with it and someone "optimises" tiles into the cache.
    expect(sw).toContain('a record of where you have been')
  })
})
