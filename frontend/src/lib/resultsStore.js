import {
  PREFS_CACHE,
  RESULTS_PREFIX,
  SHELL_PREFIX,
  forgetResults,
  readSaveResults,
} from './offlineStore.js'

/**
 * The saved-route store, on the page.
 *
 * This used to live in the service worker, and in production it never ran once.
 * `sw.js` declines every cross-origin request — the one line that guarantees map
 * tiles are never cached — and this deployment serves the site from
 * `meander-eoc.pages.dev` while the API answers on `meander-app.duckdns.org`.
 * So every `/api/routes` call is cross-origin, the worker's route branch never
 * fired, and the consent control in About.jsx promised something no code was
 * doing. BLOCKED.md §8 has the measurement. The worker's line is right; the
 * store was in the wrong place.
 *
 * Moved here, it is the page that writes, and `api/client.js` calls it after a
 * completed stream. That means this module — not the worker — is now the thing
 * standing between a person's coordinates and their disk, so it is written to
 * fail closed at every step.
 *
 * **What is kept, exactly one of:** the final `RoutesResponse` of one search.
 * Not the stream. The worker stored the raw SSE text, which carries every
 * `progress` event and a second copy of each route from the two-pass
 * enrichment; the final payload is the same answer with none of that. Storing
 * less was free, so it is stored.
 *
 * **What is not kept: the request.** The worker keyed its entry on
 * `url#body`, which put an unrounded GPS fix in a cache key that any script on
 * the origin can enumerate. Here the request is reduced to a SHA-256 and only
 * the digest is written. A replay still requires a byte-identical request, and
 * the coordinate is no longer sitting in the key. `permalink.js` refuses to
 * write a device fix to the address bar; writing one to a cache key was the
 * same disclosure by another route.
 *
 * **Nothing here enumerates.** There is one entry, at one fixed URL, readable
 * only by presenting a request that hashes to the stored digest. No "recent
 * searches", no restore-on-open, no listing. A store you can ask "what did this
 * person do?" is a location history however few rows it has.
 *
 * **Versioned against the installed shell.** The bucket is named for the shell
 * cache that is present, so a deploy replaces it exactly as it did when the
 * worker owned it, and `forgetResults()` still finds it by prefix. With no
 * shell cache installed there is no version to bind to, and this module stores
 * nothing rather than inventing one — which also means it does not quietly
 * begin storing in a Capacitor shell, where no worker registers and where
 * DEPLOY.md still records the affordance as inert.
 */

/**
 * One entry, one URL. The single fixed key is what makes "only the most recent
 * one is kept" structural rather than a delete-then-put that two tabs can
 * interleave: a second `put` replaces the first, it cannot sit beside it.
 */
export const ENTRY_URL = '/__meander__/last-routes'

/** Bumped if the stored shape changes. An envelope from another version is ignored, never guessed at. */
export const ENVELOPE_VERSION = 1

/**
 * Which bucket, for this build.
 *
 * Derived from the installed shell rather than passed in, because the page
 * cannot see `__PRECACHE_VERSION__` — the plugin computes it from the finished
 * bundle, after the app's own code has been generated. Reading the name the
 * worker already wrote costs nothing and needs no message channel, which sw.js
 * does not have and is not getting one.
 *
 * Null means "do not store": no CacheStorage, or no shell installed yet.
 */
export async function resultsCacheName() {
  try {
    if (typeof caches === 'undefined') return null
    const names = await caches.keys()
    // sw.js's activate handler prunes every shell but the current one, so there
    // is normally exactly one. Sorted anyway, so two tabs mid-upgrade agree.
    const shell = names.filter((name) => name.startsWith(SHELL_PREFIX)).sort()[0]
    if (!shell) return null
    return `${RESULTS_PREFIX}${shell.slice(SHELL_PREFIX.length)}`
  } catch {
    return null
  }
}

/**
 * The request, reduced to a digest.
 *
 * Only used to answer "is this the same search?". A miss is a miss — the app
 * asks the network — so the cost of a hash that cannot be computed is one
 * unsaved route, never a wrong replay. `crypto.subtle` needs a secure context;
 * without one, this returns null and nothing is stored.
 */
export async function fingerprint(request) {
  try {
    const subtle = globalThis.crypto?.subtle
    if (!subtle) return null
    const bytes = new TextEncoder().encode(JSON.stringify(request))
    const digest = await subtle.digest('SHA-256', bytes)
    return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('')
  } catch {
    return null
  }
}

/**
 * Keep one set of routes, if the user has said we may.
 *
 * Resolves to true only if something was actually written. Never throws: a
 * failed save is not a failed request, and the route the person asked for has
 * already been rendered by the time this runs.
 */
export async function saveRoutes(request, payload) {
  try {
    if (typeof caches === 'undefined') return false
    if (!payload || !Array.isArray(payload.routes) || payload.routes.length === 0) return false

    // The flag as it is now, read from storage — not the React snapshot, which
    // is a render or a tab behind.
    if (!(await readSaveResults()).saveResults) return false

    const name = await resultsCacheName()
    if (!name) return false
    const digest = await fingerprint(request)
    if (!digest) return false

    const savedAt = new Date().toISOString()
    const cache = await caches.open(name)
    await cache.put(
      ENTRY_URL,
      new Response(JSON.stringify({ v: ENVELOPE_VERSION, fingerprint: digest, payload }), {
        headers: {
          'Content-Type': 'application/json',
          // The age, and its only source. camelCase-adjacent naming on this
          // side of the boundary; see api/client.js. This is "we replayed
          // this", which is NOT the server's X-Meander-Cache.
          'X-Meander-Cached': savedAt,
        },
      }),
    )

    // Consent can be withdrawn while a stream is finishing. Revoking deletes
    // the bucket, and a put that lands a moment later would resurrect exactly
    // the route the user just refused — the store would end up holding data
    // written *after* the "No". Re-read and undo. The window is small and this
    // closes it; without this, "deleted immediately" is true only if nothing
    // was in flight.
    if (!(await readSaveResults()).saveResults) {
      await forgetResults()
      return false
    }
    return true
  } catch {
    return false
  }
}

/**
 * The saved routes, if the stored one answers this exact request.
 *
 * Returns the raw `Response` alongside the payload so the caller reads the age
 * off the header it was written with, rather than being handed a second copy of
 * the timestamp to keep in step.
 */
export async function readRoutes(request) {
  try {
    if (typeof caches === 'undefined') return null
    // A withdrawal deletes the bucket, so this should be unreachable. It is
    // here because "should be" is not a guarantee, and reading is the cheaper
    // place to be wrong about consent than writing.
    if (!(await readSaveResults()).saveResults) return null

    const name = await resultsCacheName()
    if (!name) return null
    const cache = await caches.open(name)
    const hit = await cache.match(ENTRY_URL)
    if (!hit) return null

    const envelope = JSON.parse(await hit.text())
    if (envelope?.v !== ENVELOPE_VERSION) return null
    if (!envelope.payload || !Array.isArray(envelope.payload.routes)) return null

    const digest = await fingerprint(request)
    if (!digest || digest !== envelope.fingerprint) return null

    return { response: hit, payload: envelope.payload }
  } catch {
    return null
  }
}

// Re-exported so a caller needs one import to store and to stop storing, and so
// the deletion path is the same function the consent control already calls.
export { forgetResults, PREFS_CACHE, RESULTS_PREFIX }
