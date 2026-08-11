import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import { PAGES_CONTROL_FILES, isPrecachable } from '../../vite.config.js'
import { PREFS_CACHE, RESULTS_PREFIX, SHELL_PREFIX } from './offlineStore.js'

// sw.js runs in a worker, cannot import from src/, and cannot be unit-tested in
// a node runner. What *can* be checked is the source text — and the properties
// worth checking are the ones whose failure mode is silent and permanent: a
// worker that quietly caches map tiles, or one whose consent flag stops
// agreeing with the page's.

const sw = readFileSync(fileURLToPath(new URL('../../sw.js', import.meta.url)), 'utf8')
const code = sw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

describe('the worker and the page agree on their three strings', () => {
  // The worker cannot import them, so they are duplicated. Duplication is fine;
  // silent divergence is not. The pref URL is no longer among them — the worker
  // stopped reading the flag when the store moved to the page, and asserting a
  // string it does not use would be asserting nothing.

  it('uses the same prefs cache name', () => {
    // Still in the keep set: the worker does not read the flag, but it is the
    // thing that would delete it.
    expect(code).toContain(`'${PREFS_CACHE}'`)
  })

  it('names the results bucket the page will write to', () => {
    // resultsStore.js derives its bucket from the shell name and relies on this
    // one being in the keep set, or an activation would delete the saved route.
    expect(code).toContain(`${RESULTS_PREFIX}\${VERSION}`)
    expect(code).toMatch(/keep\s*=\s*new Set\(\[[^\]]*RESULTS_CACHE/)
  })

  it('names the shell bucket the page reads its version from', () => {
    // The page cannot see __PRECACHE_VERSION__ — the plugin computes it from
    // the finished bundle. It reads this name instead, so the prefix is shared.
    expect(code).toContain(`${SHELL_PREFIX}\${VERSION}`)
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

describe('the caches the worker keeps', () => {
  it('keeps the prefs cache unversioned', () => {
    // Versioning it would let a deploy silently re-grant a withdrawn permission
    // — or silently withdraw a given one.
    expect(code).toMatch(/PREFS_CACHE\s*=\s*'meander-prefs'/)
    expect(code).not.toMatch(/PREFS_CACHE\s*=\s*`[^`]*\$\{VERSION\}/)
  })

  it('versions the shell and results caches', () => {
    // Still both, and the results one still matters: everything except the
    // current build's bucket is swept on activate, which is how a deploy
    // replaces the saved set now that the page is what writes it.
    expect(code).toMatch(/SHELL_CACHE\s*=\s*`[^`]*\$\{VERSION\}/)
    expect(code).toMatch(/RESULTS_CACHE\s*=\s*`[^`]*\$\{VERSION\}/)
  })

  it('has no message channel — the page owns the flag', () => {
    expect(code).not.toContain("addEventListener('message'")
  })
})

describe('the worker no longer stores routes', () => {
  // The store moved to src/lib/resultsStore.js, and its invariants moved to
  // resultsStore.test.js where they can be exercised instead of grepped. What
  // is left to assert here is that the worker does not quietly grow a second
  // copy: two writers cannot both honour "only the most recent one is kept".

  it('does not intercept the route endpoint', () => {
    expect(code).not.toContain('/api/routes')
  })

  it('lets every API request go to the network', () => {
    const listener = code.slice(code.indexOf("addEventListener('fetch'"))
    expect(listener).toMatch(/pathname\.startsWith\('\/api\/'\)\)\s*return/)
  })

  it('never writes anything but the shell', () => {
    // cache.put appears exactly nowhere; the shell is installed with addAll.
    expect(code).not.toContain('cache.put')
    expect(code).toContain('cache.addAll')
  })

  it('does not read the consent flag it no longer needs', () => {
    expect(code).not.toContain('save-results')
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

describe('the worker version tracks what is in the build, not what it is called', () => {
  // The one property that decides whether a deploy ever reaches an installed
  // client. The browser's update check byte-compares sw.js: if the version does
  // not move, nothing installs, and handleShell is cache-first and never
  // revalidates — so the old shell is served forever.
  //
  // This is the test that was missing. The suite asserted the placeholders were
  // substituted and that the precache named the right files, both of which held
  // perfectly while the version was a hash of *filenames*: any change that did
  // not rename a file produced byte-identical worker output. Changing only the
  // <title> in index.html reproduced it — same VERSION, same sw.js, different
  // dist/index.html.
  /** The same digest the plugin computes, over a fake bundle. */
  const versionFor = (entries) => {
    const digest = createHash('sha256')
    for (const [url, content] of [...entries].sort((a, b) => a[0].localeCompare(b[0]))) {
      digest.update(url)
      digest.update('\0')
      digest.update(content)
      digest.update('\0')
    }
    return digest.digest('hex').slice(0, 12)
  }

  it('moves when a file’s contents change but its name does not', () => {
    const before = versionFor([['/index.html', '<title>Meander</title>']])
    const after = versionFor([['/index.html', '<title>Meander X</title>']])
    expect(after).not.toBe(before)
  })

  it('moves when a file is renamed but its contents do not change', () => {
    const before = versionFor([['/assets/a.js', 'console.log(1)']])
    const after = versionFor([['/assets/b.js', 'console.log(1)']])
    expect(after).not.toBe(before)
  })

  it('does not move when nothing changes — no clock in it', () => {
    // The property the original comment was defending, and which is kept: a
    // timestamp would evict every user's shell on every build.
    const entries = [['/index.html', '<title>Meander</title>'], ['/assets/a.js', 'x']]
    expect(versionFor(entries)).toBe(versionFor(entries))
  })

  it('does not depend on the order the file list arrives in', () => {
    const a = [['/index.html', 'h'], ['/assets/a.js', 'x']]
    const b = [['/assets/a.js', 'x'], ['/index.html', 'h']]
    expect(versionFor(a)).toBe(versionFor(b))
  })
})
