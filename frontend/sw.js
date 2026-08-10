/**
 * Meander's service worker.
 *
 * **It does one thing.** It precaches the application shell, so the app opens
 * without a network. The shell is the program: the same bytes for every
 * visitor, derived from the build. It says nothing about anybody.
 *
 * It used to do a second thing — keep one route response, behind the consent
 * flag. It no longer does, and the reason is the line marked THE line below.
 * This worker declines every cross-origin request, and in the deployed
 * configuration the site is served from one origin and the API answers on
 * another, so `/api/routes` never reached this file at all. The store was
 * unreachable in production while About.jsx went on promising it: measured, not
 * inferred, in BLOCKED.md §8. The cross-origin line is right and is staying;
 * the store moved to where it can see the request, in
 * `src/lib/resultsStore.js`, written by the page after a completed stream.
 *
 * What this worker still never caches, under any circumstances:
 *
 *   - **Map tiles. A tile cache is a record of where you have been.** This is
 *     enforced by one line — the cross-origin early return in the fetch
 *     listener — and that line is covered by a test rather than trusted.
 *   - Geocoding results: the same objection, in text form.
 *   - Anything from another origin at all.
 *   - Any response to a request the user did not make.
 *
 * Two names outlive the store, and both are load-bearing rather than leftovers:
 *
 *   - `PREFS_CACHE` is in the keep set. The worker no longer reads the consent
 *     flag, but it is still the thing that would delete it, and a deploy that
 *     dropped the flag would re-ask a question the user has already answered.
 *     It stays deliberately **unversioned** for the same reason: a deploy must
 *     not silently re-grant a permission the user withdrew, nor silently
 *     withdraw one they gave.
 *   - `RESULTS_CACHE` is in the keep set so the page's saved route survives an
 *     activation, and versioned so that everything *except* the current build's
 *     bucket is swept — which is how a deploy still replaces the saved set, as
 *     it did when the store lived here. `resultsStore.js` derives its bucket
 *     name from `SHELL_CACHE` for exactly this reason.
 *
 * There is still no message channel and no mirror in localStorage.
 */

const VERSION = '__PRECACHE_VERSION__'
const SHELL_CACHE = `meander-shell-${VERSION}`
const RESULTS_CACHE = `meander-results-${VERSION}`
const PREFS_CACHE = 'meander-prefs'

const PRECACHE = __PRECACHE_MANIFEST__

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(SHELL_CACHE)
      // `reload` so an install never picks the old shell out of the HTTP cache
      // and precaches the thing it was meant to replace.
      await cache.addAll(PRECACHE.map((url) => new Request(url, { cache: 'reload' })))
      await self.skipWaiting()
    })(),
  )
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keep = new Set([SHELL_CACHE, RESULTS_CACHE, PREFS_CACHE])
      const keys = await caches.keys()
      await Promise.all(keys.filter((key) => !keep.has(key)).map((key) => caches.delete(key)))
      await self.clients.claim()
    })(),
  )
})

// ignoreVary because the shell is precached under a plain URL and a navigation
// request carries headers the precached entry never saw.
const SHELL_MATCH = { ignoreVary: true }

async function handleShell(event) {
  const cached = await caches.match(event.request, SHELL_MATCH)
  if (cached) return cached
  try {
    return await fetch(event.request)
  } catch (err) {
    const shell = await caches.match('/index.html', SHELL_MATCH)
    if (shell) return shell
    throw err
  }
}

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url)

  // THE line. Map tiles, geocoding, fonts, anything at all from anywhere else:
  // not our business and never stored. A tile cache is a record of where you
  // have been.
  if (url.origin !== self.location.origin) return

  if (event.request.method !== 'GET') return
  // Every API call is live or it does not happen. `/api/routes` included: the
  // saved set is the page's, and a worker that answered here would be a second
  // writer racing the first for "only the most recent one is kept".
  if (url.pathname.startsWith('/api/')) return

  event.respondWith(handleShell(event))
})
