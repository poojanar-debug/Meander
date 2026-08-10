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
 * the digest is written — the coordinate is not sitting in the key.
 * `permalink.js` refuses to write a device fix to the address bar; writing one
 * to a cache key was the same disclosure by another route.
 *
 * A replay requires the *same search*, which since KEY_DP below means the same
 * request with the origin snapped to an ~11 m grid, not a byte-identical one.
 * That is a deliberate widening and it is the narrowest one that makes the
 * store work at all for a device fix — see KEY_DP for why byte-identical was
 * the same as never. It changes when a replay happens. It does not change what
 * is written: still one digest, still one entry, still no coordinate.
 *
 * **Nothing here enumerates.** There is one entry, at one fixed URL. No "recent
 * searches", no restore-on-open, no listing. A store you can ask "what did this
 * person do?" is a location history however few rows it has.
 *
 * ⚠ This sentence used to end "readable only by presenting a request that
 * hashes to the stored digest", and that was never true — not before the grid
 * below and not after it. The digest is a field *inside* the value, not the key:
 * `readRoutes` matches ENTRY_URL, parses the whole envelope, and only then
 * compares. Any script on the origin can stop after the parse, and both
 * ENTRY_URL and RESULTS_PREFIX ship as literals in the bundle. What the digest
 * actually buys is the two things claimed above it — no coordinate in a cache
 * key, and no replaying one search into another — and neither is confidentiality
 * of the geometry against same-origin script. Corrected rather than deleted,
 * because the widening below would otherwise look like it cost a defence that
 * was never there.
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
 * How coarse the origin is before it is hashed. Four decimal places.
 *
 * **The request body is not rounded.** This grid exists only inside the key, and
 * `api/client.js` sends `buildRouteRequest`'s full-precision coordinates to the
 * router exactly as before — routing accuracy is untouched. What changes is only
 * the question "is this the same search?".
 *
 * It has to change, because at full precision the answer was *no* for the one
 * journey the store exists for. A device fix is a fresh measurement every time,
 * so two requests from one doorstep are two different JSON bodies, two different
 * SHA-256s and a miss — a geolocated search could never replay, and the
 * walk-out-of-signal case only ever recovered for a search that arrived from a
 * link. BLOCKED.md §9 recorded that, and the fix for it removed the other half:
 * a geolocated search no longer leaves a link behind to reload.
 *
 * Four places is ~11 m of latitude, and the neighbourhood below takes the
 * guaranteed match to 7 m and the far edge to ~26 m at London.
 *
 * ⚠ **How often that is enough depends on the fix, and this app asks for the
 * coarse one.** An earlier version of this comment said two fixes from one spot
 * "differ in the sixth decimal" — 0.11 m — and that was wrong about the app it
 * is in. App.jsx:429 passes `enableHighAccuracy: false`, which is an explicit
 * request for the wifi/cell provider rather than GPS, and that provider returns
 * access-point centroids that step by tens of metres. Measured by an agent that
 * did not write this, 200k trials per cell, two independent fixes of one
 * standing person:
 *
 *       σ of one fix   1 m    3 m    5 m     8 m     10 m    20 m
 *       London         100%   96.6%  81.0%   52.7%   39.1%   12.6%
 *
 * So this is not the coin flip the grid-line problem was — it is a different
 * one, and it is not fixed here. At σ = 8 m the store replays about half the
 * time. Three things would change that and none is this session's to take:
 * `enableHighAccuracy: true`, a coarser KEY_DP, or reading
 * `position.coords.accuracy` — which App.jsx:414 currently discards — and
 * choosing the grid from it. Recorded in BLOCKED.md rather than guessed at,
 * because widening the match is a privacy decision and not a bug fix.
 */
const KEY_DP = 4
const KEY_SCALE = 10 ** KEY_DP

/**
 * Which grid square a degree value falls in. An integer, so no float is
 * re-derived.
 *
 * Exported for the suite, and that is not a convenience. The boundary test used
 * to compute the cell edge with its own copy of `Math.round(x * 1e4)` and assert
 * against that — an assertion about the test's arithmetic, not the store's,
 * which stayed green against a store mutated to `Math.floor`. A test that asks
 * "are these two in different squares?" has to ask the thing that decides.
 */
export const gridCell = (deg) => Math.round(deg * KEY_SCALE)

/**
 * The request as it is hashed: everything byte-exact except the origin, which
 * becomes a pair of grid indices.
 *
 * **Only the origin.** A destination is always a place picked from search, and
 * `backend/routing.py` rounds geocode results to six places before they are ever
 * shown, so the same pick yields the same bytes on every reload — there is no
 * jitter there to absorb. Widening it would buy nothing and would let two
 * genuinely different destinations eleven metres apart answer for each other.
 * `onLocate` in App.jsx dispatches `type: 'origin'` and nothing else, so a
 * device fix cannot reach the destination field in the first place.
 *
 * Null when there is no usable origin, which fails closed: no digest, so no
 * save and no read.
 */
function keyedRequest(request, dLat = 0, dLon = 0) {
  const origin = request?.origin
  if (!origin || !Number.isFinite(origin.lat) || !Number.isFinite(origin.lon)) return null
  return {
    ...request,
    origin: { lat: gridCell(origin.lat) + dLat, lon: gridCell(origin.lon) + dLon },
  }
}

/**
 * The request, reduced to a digest.
 *
 * Only used to answer "is this the same search?". A miss is a miss — the app
 * asks the network — so the cost of a hash that cannot be computed is one
 * unsaved route, never a route replayed into the wrong search. `crypto.subtle`
 * needs a secure context; without one, this returns null and nothing is stored.
 *
 * `dLat`/`dLon` step the origin by whole grid squares. `readRoutes` uses them to
 * ask about the neighbours of the square it is standing in; a save always uses
 * the square itself.
 */
export async function fingerprint(request, dLat = 0, dLon = 0) {
  try {
    const subtle = globalThis.crypto?.subtle
    if (!subtle) return null
    const keyed = keyedRequest(request, dLat, dLon)
    if (!keyed) return null
    const bytes = new TextEncoder().encode(JSON.stringify(keyed))
    const digest = await subtle.digest('SHA-256', bytes)
    return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('')
  } catch {
    return null
  }
}

/**
 * The nine squares a saved origin may be sitting in for this request to be "the
 * same search": the one the caller is standing in, and its eight neighbours.
 *
 * Rounding alone does not survive its own boundary, and that is not a corner
 * case — it is most of the map. Two fixes five metres apart fall in the same
 * square only if no grid line runs between them, which for a 6.9 m-wide square
 * (longitude, at London's latitude) happens well under half the time. A store
 * that replayed on a coin flip would be worse than one that never replayed,
 * because it would look intermittent rather than absent.
 *
 * Asking about the neighbours makes it deterministic in the direction that
 * matters: if every coordinate moved by less than one square — 11.1 m of
 * latitude, 6.9 m of longitude at London — the saved square is at worst one step
 * away in each axis, so it is always found. The cost is that the far edge widens
 * to two squares along a diagonal.
 *
 * Measured, not predicted. resultsStore.test.js bisects for the flip point from
 * nine positions across one square × 36 bearings, and reports **7.00 m to
 * 25.58 m** at 51.5074 — the near figure is a fix in the corner of its square
 * stepping west, the far one a fix in the opposite corner going diagonally. So
 * 5 m always replays and 200 m never does, which are the two claims, and the
 * margin on the near one is 2 m rather than the 6 m a cell-centre measurement
 * would have flattered it into reporting.
 *
 * ⚠ The east-west figures scale with cos(latitude), so the guarantee is not
 * global. The longitude square is 6.93 m at London, 5.57 m at 60° and 1.93 m at
 * 80°, and the 5 m guarantee breaks above **63.28°**, where a 5 m step east can
 * cross two squares. Tromsø and Fairbanks are past it. That figure is bisected
 * against the real module — every 5 m move replays up to 63.2776° and first
 * fails at 63.2782° — not derived; the derivation this comment used to show,
 * arccos(5 / 11.132), gives 63.31° because 11.132 is the *equatorial* degree.
 *
 * Above ~85° it is not a degradation but an absence: 3 m due east at 89° is 15
 * squares, at 89.999° it is 15,454. Nothing breaks — a miss is a network
 * request, which is what the app did before any of this — but "the promise
 * weakens" would be too kind, so it says this instead.
 *
 * ⚠ The antimeridian is a dead zone. Two points 2 m apart either side of ±180°
 * longitude are 3,600,000 squares apart, so nothing on the far side of the line
 * ever replays for anything on the near side, at any separation. Same at the
 * pole for two longitudes 180° apart. A `lon ± 360` probe would close it and is
 * deliberately not written: the cost of the gap is one network request, and the
 * cost of the code is a second wrap-around rule in the one function that decides
 * whether two searches are the same. Documented because this module documents
 * the cos(latitude) limit at length, and leaving its neighbour unmentioned would
 * be the file failing its own standard.
 */
const NEIGHBOURHOOD = [-1, 0, 1]

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

    // Sweep first, then write. "Only the most recent one is kept" has to hold
    // across *buckets*, not just within one, and the bucket name is derived
    // from whichever shell is installed. Two shells can coexist — between a new
    // worker's install and its activate, or when an install fails — and then
    // two saves land in two different buckets, each holding one set, which is
    // two sets on disk. Deleting every results bucket before the put makes
    // "exactly one, ever" structural rather than dependent on the worker
    // lifecycle. It also clears a bucket left by a previous build without
    // waiting for an activation that may never come.
    await forgetResults()

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
    // written *after* the "No". Re-read and undo.
    //
    // ⚠ `cache.delete(ENTRY_URL)` first, and it is not belt-and-braces. A
    // `Cache` handle outlives `caches.delete(name)`: the bucket leaves the
    // registry, the handle keeps working, and a put through it lands in storage
    // that `caches.keys()` no longer lists — so `forgetResults()`, which
    // deletes by name, can never reach it. That is a route on disk that nothing
    // in the app can delete. Deleting through the handle we already hold is the
    // only thing that reaches an unlinked bucket. Same shape as the Caddyfile
    // bind mount in §7 of BLOCKED.md: the name was rebound, the handle was not.
    if (!(await readSaveResults()).saveResults) {
      try {
        await cache.delete(ENTRY_URL)
      } catch {
        // Fall through to the sweep; one of the two has to reach it.
      }
      await forgetResults()
      return false
    }
    return true
  } catch {
    return false
  }
}

/**
 * The saved routes, if the stored one answers this request — same everything,
 * and an origin within a square or so of the saved one. See KEY_DP.
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

    if (typeof envelope.fingerprint !== 'string' || !envelope.fingerprint) return null

    // Nine digests, one comparison each. There is still exactly one entry at one
    // fixed URL — the neighbourhood is a question asked about the digest already
    // stored, not extra keys to look under, so nothing here reads or writes more
    // than the single-digest version did.
    for (const dLat of NEIGHBOURHOOD) {
      for (const dLon of NEIGHBOURHOOD) {
        const digest = await fingerprint(request, dLat, dLon)
        if (!digest) return null
        if (digest === envelope.fingerprint) {
          // Re-read the flag before handing anything back, exactly as saveRoutes
          // does after its put. The check at the top of this function is up to
          // nine awaits ago, and every one of them is a point at which another
          // tab — or this one, with a stream still finishing — can press "No".
          //
          // That window was one await wide before the neighbourhood existed, so
          // the top-of-function check was very nearly enough. Widening the match
          // widened the window with it, and an agent that did not write the
          // change found it: consent withdrawn during the first digest, payload
          // still returned on the fifth probe, drawn on the map and announced as
          // "Showing a saved copy from N minutes ago" — and then held in React
          // state, exportable to GPX, for the rest of the session.
          //
          // A withdrawal a read can outrun is not a withdrawal.
          if (!(await readSaveResults()).saveResults) return null
          return { response: hit, payload: envelope.payload }
        }
      }
    }
    return null
  } catch {
    return null
  }
}

// Re-exported so a caller needs one import to store and to stop storing, and so
// the deletion path is the same function the consent control already calls.
export { forgetResults, PREFS_CACHE, RESULTS_PREFIX }
