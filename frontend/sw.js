/**
 * Meander's service worker.
 *
 * Built by the `meander-service-worker` plugin in vite.config.js, which fills
 * in the two placeholders below from the real bundle. It is not in `public/`,
 * because a file copied verbatim cannot know the hashed asset names.
 *
 * The placeholders are named only where they are used. Naming them in prose
 * here is what broke the first build: a non-global `String.replace` substituted
 * the mention in this comment and left the actual constants untouched, so the
 * worker shipped with a literal `__PRECACHE__` in it and threw on install.
 *
 * Three caches, and the difference between them is the whole design:
 *
 *   shell    the program — HTML, JS, CSS, icons. Cached unconditionally.
 *            It says nothing about anybody; it is the same bytes for every
 *            visitor, and it is what makes the app open at all without a
 *            network.
 *
 *   results  one route response. **Only ever written with the user's explicit
 *            permission**, because a route is a line through the streets around
 *            wherever they are, and that is the single most revealing thing this
 *            app touches. Off until the page says otherwise. See
 *            src/lib/offlineStore.js.
 *
 *   prefs    that permission. Deliberately not versioned, so a deploy cannot
 *            silently re-grant or revoke it.
 *
 * **What is never cached, and why:**
 *
 *   * map tiles — third party, and a tile cache is a record of where you have
 *     been. Offline therefore shows the route list without the map. The app was
 *     built so the map is not load-bearing: every duration, score, blocker and
 *     rest stop is in the list, which is verified in PROGRESS.md, Phase D.
 *   * `/api/geocode` — the query string is what the user typed into a search
 *     box.
 *   * any non-2xx response, or any route stream that did not finish. Replaying
 *     a truncated answer forever would look exactly like a routing bug, which
 *     is the same reason backend/fixtures.py refuses to record one.
 */

const VERSION = '__VERSION__'
const SHELL_CACHE = `meander-shell-${VERSION}`
const RESULTS_CACHE = `meander-results-${VERSION}`
const PREFS_CACHE = 'meander-prefs'

/** Emitted by the build: every file needed to open the app with no network. */
const PRECACHE = __PRECACHE__

const PREF_URL = '/__meander__/save-results'
const ROUTE_KEY_PREFIX = '/__meander__/route/'

// --- install / activate -----------------------------------------------------

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(SHELL_CACHE)
      // `reload` so a shell is never precached from the HTTP cache, which is
      // how a worker ends up serving the previous deploy's index.html for ever.
      await cache.addAll(PRECACHE.map((path) => new Request(path, { cache: 'reload' })))
      // The new shell is complete and self-consistent, so there is nothing to
      // gain by making the user close every tab before it takes effect.
      await self.skipWaiting()
    })(),
  )
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keep = new Set([SHELL_CACHE, RESULTS_CACHE, PREFS_CACHE])
      await Promise.all(
        (await caches.keys()).filter((k) => !keep.has(k)).map((k) => caches.delete(k)),
      )
      await self.clients.claim()
    })(),
  )
})

// --- the permission ---------------------------------------------------------

async function mayStoreResults() {
  try {
    const cache = await caches.open(PREFS_CACHE)
    const hit = await cache.match(PREF_URL)
    if (!hit) return false
    return (await hit.text()) === 'true'
  } catch {
    // If the permission cannot be read it has not been granted. Failing closed
    // is the only safe direction for a flag that guards writing someone's
    // location to disk.
    return false
  }
}

async function forgetResults() {
  await caches.delete(RESULTS_CACHE)
}

self.addEventListener('message', (event) => {
  const data = event.data
  if (!data || typeof data !== 'object') return

  if (data.type === 'meander.offline-pref') {
    event.waitUntil(
      (async () => {
        const cache = await caches.open(PREFS_CACHE)
        await cache.put(PREF_URL, new Response(data.saveResults === true ? 'true' : 'false'))
        if (data.saveResults !== true) await forgetResults()
      })(),
    )
  }

  if (data.type === 'meander.forget-results') {
    event.waitUntil(forgetResults())
  }
})

// --- route results ----------------------------------------------------------

async function routeCacheKey(request) {
  const body = await request.clone().text()
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(body))
  const hex = Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
  return new Request(new URL(`${ROUTE_KEY_PREFIX}${hex}`, self.location.origin).toString())
}

/**
 * Keep exactly one result, never a history.
 *
 * The brief asks for "the last result", and one entry is also the honest amount
 * to hold: a cache keyed by request that grew without bound would become a log
 * of everywhere the user had asked about, on disk, which is the thing this app
 * promises not to build.
 *
 * The old entry is dropped only once the new one is ready to write. Deleting
 * first is the obvious order and it means any failure in between leaves the
 * device with neither.
 */
async function storeResult(key, response) {
  if (!response.ok) return
  const text = await response.text()
  // A stream that never reached `done` is a partial answer. An `error` frame is
  // a failure. Neither is a result, and replaying either offline would present
  // a broken run as a saved route.
  if (!text.includes('"type":"done"')) return
  if (text.includes('"type":"error"')) return

  const fresh = new Response(text, {
    headers: {
      'Content-Type': 'text/event-stream',
      'X-Meander-Cached-At': new Date().toISOString(),
    },
  })

  const cache = await caches.open(RESULTS_CACHE)
  for (const old of await cache.keys()) await cache.delete(old)
  await cache.put(key, fresh)
}

/**
 * **The copy is drained in the background, never before the response is
 * returned.** `/api/routes` is a live SSE stream that stays open for as long as
 * the server keeps producing — so awaiting `clone().text()` before returning
 * meant waiting for the stream to *end* before the page saw its first byte.
 * With the two readers deadlocked against the tee's backpressure it did not
 * merely delay: the request never resolved at all, and the symptom was an empty
 * cache rather than anything pointing at streaming. `waitUntil` keeps the
 * worker alive to finish the write while the page reads the original, which is
 * what the hook is for.
 */
async function handleRoutes(event) {
  const request = event.request

  // **Before the fetch, not after.** `fetch(request)` consumes the request
  // body, and a consumed Request cannot be cloned — so hashing it afterwards
  // throws `Request body is already used`. Inside `waitUntil` that rejection
  // goes nowhere: the page got its routes, the worker logged nothing, and the
  // only evidence was a results cache that existed and was empty.
  const key = await routeCacheKey(request)

  try {
    const response = await fetch(request)
    const copy = response.clone()
    event.waitUntil(
      (async () => {
        if (await mayStoreResults()) {
          await storeResult(key, copy)
        } else {
          // The permission can be withdrawn while a copy is already on disk.
          // Acting on that here as well as on the message means a revocation
          // still lands even if the page was closed before the message could
          // be delivered.
          await forgetResults()
        }
      })(),
    )
    return response
  } catch (err) {
    const cache = await caches.open(RESULTS_CACHE)
    const hit = await cache.match(key)
    // No saved copy, or one saved for a *different* request. Handing back a
    // route to somewhere else because it was the only thing in the cache would
    // be far worse than an error, so this rethrows and the app says it could
    // not reach the server.
    if (!hit) throw err

    return new Response(await hit.text(), {
      status: 200,
      headers: {
        'Content-Type': 'text/event-stream',
        'X-Meander-Cached': '1',
        'X-Meander-Cached-At': hit.headers.get('X-Meander-Cached-At') ?? '',
      },
    })
  }
}

// --- everything else --------------------------------------------------------

/**
 * `ignoreVary` is load-bearing, and it took a real offline load to find out.
 *
 * The dev and preview servers answer with `Vary: Origin`, and Vite writes
 * `crossorigin` on exactly two tags in index.html — the module script and the
 * stylesheet. Those two requests therefore carry an `Origin` header; the
 * precache fetches, made from the worker with a plain same-origin Request, do
 * not. Cache API matching honours `Vary` by default, so the stored entries were
 * rejected for the app's own JavaScript and CSS while the manifest and the
 * icons — no `crossorigin`, no `Origin` — matched perfectly.
 *
 * The failure was almost invisible: the document came back from cache, the tab
 * title was right, `#root` was in the DOM, and the page was blank. Every check
 * short of "did the app actually boot" passed.
 *
 * Ignoring Vary is correct here rather than merely convenient: every URL in the
 * shell is one immutable, content-hashed representation, so there is no second
 * variant that could be served by mistake.
 */
const SHELL_MATCH = { cacheName: SHELL_CACHE, ignoreVary: true }

async function handleNavigate(request) {
  try {
    return await fetch(request)
  } catch (err) {
    const cached = await caches.match('/index.html', SHELL_MATCH)
    if (cached) return cached
    throw err
  }
}

async function handleAsset(request) {
  const cached = await caches.match(request, SHELL_MATCH)
  if (cached) return cached
  const response = await fetch(request)
  // Only same-origin build output is added on the fly, and only when it
  // succeeded. Everything else stays out of the shell cache.
  if (response.ok && new URL(request.url).pathname.startsWith('/assets/')) {
    const cache = await caches.open(SHELL_CACHE)
    await cache.put(request, response.clone())
  }
  return response
}

self.addEventListener('fetch', (event) => {
  const { request } = event
  const url = new URL(request.url)

  if (request.method === 'POST' && url.pathname === '/api/routes') {
    event.respondWith(handleRoutes(event))
    return
  }

  // Everything below is a plain read of something we might have. A POST we do
  // not recognise, a cross-origin request (tiles, and nothing else in this app)
  // and every other /api path go straight to the network untouched.
  if (request.method !== 'GET') return
  if (url.origin !== self.location.origin) return
  if (url.pathname.startsWith('/api/')) return

  if (request.mode === 'navigate') {
    event.respondWith(handleNavigate(request))
    return
  }

  event.respondWith(handleAsset(request))
})
