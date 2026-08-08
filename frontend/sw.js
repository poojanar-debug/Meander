/**
 * Meander's service worker.
 *
 * It does two things and refuses to do a third.
 *
 * 1. It precaches the application shell, so the app opens without a network.
 *    The shell is the program: the same bytes for every visitor, derived from
 *    the build. It says nothing about anybody.
 *
 * 2. It keeps **one** route response, and only when the user has explicitly
 *    asked it to. That response contains coordinates, so it is the one thing
 *    here that is about a person, and it is treated accordingly: written only
 *    behind the consent flag, replaced rather than accumulated, and deleted
 *    from two independent paths the moment consent is withdrawn.
 *
 * What is never cached, under any circumstances:
 *
 *   - **Map tiles. A tile cache is a record of where you have been.** This is
 *     enforced by one line — the cross-origin early return in the fetch
 *     listener — and that line is covered by a test rather than trusted.
 *   - Geocoding results: the same objection, in text form.
 *   - Anything from another origin at all.
 *   - Any response to a request the user did not make.
 *
 * The prefs cache is deliberately **not** versioned. A deploy must not silently
 * re-grant a permission the user withdrew, nor silently withdraw one they gave.
 * The shell and results caches are versioned, so a deploy replaces them.
 *
 * The page owns the consent flag and writes it directly into the prefs cache.
 * There is no message channel and no mirror in localStorage: one source of
 * truth, in the bucket this worker already reads.
 */

const VERSION = '__PRECACHE_VERSION__'
const SHELL_CACHE = `meander-shell-${VERSION}`
const RESULTS_CACHE = `meander-results-${VERSION}`
const PREFS_CACHE = 'meander-prefs'
const PREF_URL = '/__meander__/save-results'
const RESULTS_PREFIX = 'meander-results-'

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

/**
 * May we keep a route response?
 *
 * Reads the prefs cache, which the page is the only writer of. Any failure —
 * including CacheStorage being unavailable — answers no. Failing closed is the
 * only correct direction for a flag guarding a write of someone's location.
 */
async function mayStoreResults() {
  try {
    const cache = await caches.open(PREFS_CACHE)
    const hit = await cache.match(PREF_URL)
    if (!hit) return false
    return (await hit.text()) === 'true'
  } catch {
    return false
  }
}

/** Delete every saved route. Never the shell, never the prefs. */
async function forgetResults() {
  const keys = await caches.keys()
  await Promise.all(
    keys.filter((key) => key.startsWith(RESULTS_PREFIX)).map((key) => caches.delete(key)),
  )
}

/**
 * The cache key for a route request.
 *
 * Method and body, not the URL: every route request is a POST to the same path,
 * so keying on the URL alone would make every search look like the same one.
 */
function routeCacheKey(url, body) {
  return new Request(`${url}#${body}`, { method: 'GET' })
}

/**
 * Store a route response — but only a complete, successful one.
 *
 * A stream that ended in an error is not an answer, and replaying one later as
 * though it were would be worse than having nothing to replay.
 */
async function storeResult(key, text) {
  if (!text.includes('"type":"done"')) return
  if (text.includes('"type":"error"')) return
  const cache = await caches.open(RESULTS_CACHE)
  // Exactly one entry. Delete everything already there before putting the new
  // one, so this can never accumulate into a history.
  const existing = await cache.keys()
  await Promise.all(existing.map((request) => cache.delete(request)))
  await cache.put(
    key,
    new Response(text, {
      headers: {
        'Content-Type': 'text/event-stream',
        // camelCase on the client side of the boundary; see client.js. This is
        // "we replayed this", which is NOT the server's X-Meander-Cache.
        'X-Meander-Cached': new Date().toISOString(),
      },
    }),
  )
}

async function handleRoutes(event) {
  const request = event.request
  // The key has to be computed BEFORE the fetch: request.text() consumes the
  // body, and after the fetch there is nothing left to read.
  const body = await request.clone().text()
  const key = routeCacheKey(request.url, body)

  try {
    const response = await fetch(request)
    if (await mayStoreResults()) {
      // Drain the copy inside waitUntil, not in the response path. Reading the
      // clone to completion before returning would hold the whole stream in
      // memory and delay first paint by the length of the request.
      const copy = response.clone()
      event.waitUntil(
        (async () => {
          try {
            await storeResult(key, await copy.text())
          } catch {
            // A failed save is not a failed request.
          }
        })(),
      )
    } else {
      event.waitUntil(forgetResults())
    }
    return response
  } catch (err) {
    const cache = await caches.open(RESULTS_CACHE)
    const hit = await cache.match(key)
    if (hit) return hit
    throw err
  }
}

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

  if (url.pathname === '/api/routes' && event.request.method === 'POST') {
    event.respondWith(handleRoutes(event))
    return
  }

  if (event.request.method !== 'GET') return
  // Every other API call is live or it does not happen.
  if (url.pathname.startsWith('/api/')) return

  event.respondWith(handleShell(event))
})
