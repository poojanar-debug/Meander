/**
 * Real API client.
 *
 * Streaming is the primary path: routes are pushed into state the moment each
 * one lands, so the first result renders without waiting for the slowest. A
 * server that answers with plain JSON is handled transparently.
 */

import { readRoutes, saveRoutes } from '../lib/resultsStore.js'

const isMock = import.meta.env.VITE_MOCK_API === '1'

/**
 * Where the API lives.
 *
 * Empty by default, which means same-origin `/api` — correct for local dev
 * (Vite proxies it) and for any deployment that puts both halves behind one
 * host. Split deployments set `VITE_API_BASE` to the backend's origin at build
 * time, and that origin must appear in the backend's `MEANDER_ALLOWED_ORIGINS`.
 */
const API_BASE = (import.meta.env.VITE_API_BASE ?? '').replace(/\/$/, '')

const url = (path) => `${API_BASE}${path}`

export function usingMockApi() {
  return isMock
}

/**
 * Build the request body. `destination` is omitted entirely for a loop, not sent as null.
 *
 * `minutes` is omitted the other way round — for a trip *with* a destination,
 * where the time dial describes nothing. Sending it made the dial's position
 * part of a request whose answer it cannot change, and the backend keys its
 * route cache on the body: the same two places at 30 and at 35 minutes were two
 * cache rows holding identical payloads, so every nudge of the dial re-spent a
 * full set of routing credits on an answer already in the database.
 */
export function buildRouteRequest({ origin, dest, minutes, mode, objectives, departAt }) {
  const body = {
    origin: { lat: origin.lat, lon: origin.lon },
    mode,
    objectives,
  }
  if (!dest) body.minutes = minutes
  if (dest) body.destination = { lat: dest.lat, lon: dest.lon }
  if (departAt) body.depart_at = departAt
  return body
}

export class ApiError extends Error {
  constructor(message, { status = 0, kind = 'network', retryAfter = 0 } = {}) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.kind = kind
    this.retryAfter = retryAfter
  }
}

async function toApiError(res) {
  let kind = 'http'
  let message = `The server returned ${res.status}.`
  try {
    const body = await res.json()
    if (body?.error?.message) {
      message = body.error.message
      kind = body.error.kind ?? kind
    } else if (Array.isArray(body?.detail) && body.detail[0]?.msg) {
      message = `That request was not valid: ${body.detail[0].msg}`
      kind = 'validation'
    }
  } catch {
    // A non-JSON error body is not itself an error; the status line is enough.
  }
  return new ApiError(message, {
    status: res.status,
    kind,
    retryAfter: Number(res.headers.get('Retry-After') ?? 0),
  })
}

/**
 * Did this response come out of the service worker's cache, and when.
 *
 * camelCase deliberately: every field that came off the wire is snake_case, so
 * the casing is itself the signal that these two were added on this side of the
 * boundary and are not the server's opinion.
 *
 * ⚠ `X-Meander-Cached` (lib/resultsStore.js: "you are looking at a replay") is
 * one letter from `X-Meander-Cache` (the server: "I had a warm cache and this
 * answer is completely current"). They mean opposite things. Do not read the
 * server's header here.
 *
 * The header used to be written by the service worker. It is now written by the
 * page-side store, on the entry it saves, and read back off that same entry —
 * so the age a route is labelled with has exactly one source, and it is the
 * moment the thing on disk was written.
 */
function cacheStampFrom(res) {
  const cachedAt = res.headers.get('X-Meander-Cached')
  return cachedAt ? { servedFromCache: true, cachedAt } : null
}

/**
 * Answer from the saved set, if there is one and it answers this request.
 *
 * Only reached when the network failed. Routes are pushed through `onRoute` in
 * the same order a live stream would deliver them, so nothing downstream has to
 * know it is looking at a replay — except by the stamp, which is the point.
 */
async function replayFromStore(req, onRoute) {
  const hit = await readRoutes(req)
  if (!hit) return null
  const stamp = cacheStampFrom(hit.response)
  if (!stamp) return null
  const routes = (hit.payload.routes ?? []).map((route) => ({ ...route, ...stamp }))
  routes.forEach((route) => onRoute(route))
  return { ...hit.payload, routes }
}

async function realFetchRoutes(req, { signal, onProgress, onRoute }) {
  let res
  try {
    res = await fetch(url('/api/routes'), {
      method: 'POST',
      signal,
      headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
      body: JSON.stringify(req),
    })
  } catch (err) {
    if (err?.name === 'AbortError') throw err
    // No network. This is the walk-out-of-signal case the consent control
    // exists for, so it is asked before the error is raised — and only ever
    // answers for the same search: same minutes, mode, objectives and
    // destination, and a starting point within about a square of the saved one.
    // It stopped being "the identical search" when resultsStore.js started
    // hashing the origin on a grid, because a device fix is never identical
    // twice and the identical-only version could not answer a geolocated
    // search at all.
    const replay = await replayFromStore(req, onRoute)
    if (replay) return replay
    throw new ApiError('Could not reach the Meander server. Check your connection and try again.')
  }

  if (!res.ok) throw await toApiError(res)

  const stamp = cacheStampFrom(res)
  const mark = (route) => (stamp && route ? { ...route, ...stamp } : route)
  const markPayload = (payload) =>
    stamp && payload ? { ...payload, routes: (payload.routes ?? []).map(mark) } : payload

  const contentType = res.headers.get('content-type') ?? ''
  if (!contentType.includes('text/event-stream') || !res.body) {
    // Guarded, which it was not. `res.json()` on a truncated or non-JSON body
    // and `json.routes.forEach` on a payload without a `routes` array both
    // threw raw — a SyntaxError or a TypeError, neither an ApiError — so they
    // reached the banner as the browser's untranslated string. The streaming
    // branch below has had this treatment since it was written; two transports
    // for one endpoint have to fail the same way.
    let json
    try {
      json = await res.json()
      if (!Array.isArray(json?.routes)) throw new TypeError('no routes array')
    } catch (err) {
      if (err?.name === 'AbortError') throw err
      const replay = await replayFromStore(req, onRoute)
      if (replay) return replay
      throw new ApiError('The server sent a reply this app could not read.')
    }
    json.routes.forEach((route) => onRoute(mark(route)))
    const payload = markPayload(json)
    await keep(req, payload, { stamp, signal })
    return payload
  }

  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let final = null
  let delivered = 0

  /** One SSE frame. Extracted so the tail flush below runs the same code. */
  const parse = (part) => {
    const line = part.split('\n').find((l) => l.startsWith('data:'))
    if (!line) return
    let evt
    try {
      evt = JSON.parse(line.slice(5))
    } catch {
      // A truncated frame is not fatal; the next read completes it.
      return
    }
    if (evt.type === 'progress') onProgress(evt)
    else if (evt.type === 'route') {
      delivered += 1
      onRoute(mark(evt.route))
    } else if (evt.type === 'done') final = markPayload(evt.payload)
    else if (evt.type === 'error') {
      throw new ApiError(evt.message ?? 'The server stopped part-way through.', {
        kind: evt.kind ?? 'stream',
      })
    }
  }

  // The loop is guarded, and the guard is not decoration. The `fetch` above
  // covers being offline when the request is *issued*; this covers the link
  // dying after the headers arrived and before the body finished — a walk into
  // a dead zone mid-search, which is the same situation from the user's side
  // and used to behave completely differently. Unguarded, `reader.read()`
  // rejects with a raw TypeError that is not an ApiError, so it reached the
  // banner as the browser's untranslated string while the store sat there
  // holding an answer nobody asked it for.
  try {
    for (;;) {
      const { value, done } = await reader.read()
      if (done) {
        // Flush the tail before leaving. The loop used to break the moment
        // `read()` reported done, discarding whatever was still in `buffer` —
        // so a final frame that arrived without its trailing `\n\n` was
        // dropped, and a `done` event delivered that way became a stream with
        // no result at all.
        buffer += decoder.decode()
        if (buffer.trim()) parse(buffer)
        break
      }
      buffer += decoder.decode(value, { stream: true })
      const parts = buffer.split('\n\n')
      buffer = parts.pop() ?? ''
      for (const part of parts) parse(part)
    }
  } catch (err) {
    if (err?.name === 'AbortError') throw err
    // The server announcing its own failure is not a transport failure, and it
    // already carries written copy. Rewrapping it would replace a specific
    // message with a generic one.
    if (err instanceof ApiError) throw err
    // Only replay if nothing has been handed over yet. Replaying after some
    // routes have already been dispatched would deliver them a second time,
    // and the list would grow duplicates rather than recover.
    if (delivered === 0) {
      const replay = await replayFromStore(req, onRoute)
      if (replay) return replay
    }
    throw new ApiError('The connection dropped part-way through. Check your connection and try again.')
  }

  // ⚠ **A stream that ends without a `done` frame is a failure, not a result.**
  // This used to `return final` unconditionally, so a body that closed cleanly
  // with no `done` returned null — and `App.jsx` dispatches that as `settled`,
  // which sets `phase: 'success'`. With zero routes arrived the results region
  // is empty: no banner, no error, no announcement, while the trip bar, the
  // departure strip and About all still render. The page looks like it is
  // working and simply has nothing in it.
  //
  // This is the client half of the failure `main.py` describes and fixed only
  // on the server. The tail is flushed above before this is decided, so a
  // final frame without its delimiter is not mistaken for a missing one.
  if (final == null) {
    const replay = await replayFromStore(req, onRoute)
    if (replay) return replay
    throw new ApiError('The server stopped before it finished. Please try again.')
  }

  await keep(req, final, { stamp, signal })
  return final
}

/**
 * Offer the answer to the store, once it is an answer.
 *
 * Three refusals, and each one is a way the old worker could not go wrong and
 * this could:
 *
 * - **`final` is null** — the stream ended without a `done`. A stream that
 *   stopped part-way is not an answer, and replaying one later as though it
 *   were would be worse than having nothing to replay. An `error` event throws
 *   before reaching here, and so does an abort, so neither can be stored.
 * - **`signal.aborted`** — App.jsx aborts on every dial drag and chip toggle,
 *   and the request that lost the race is not the one the person is looking at.
 * - **`stamp`** — this payload is itself a replay. Re-saving it would move the
 *   age forward and relabel yesterday's routes as fresh.
 *
 * Awaited rather than fired and forgotten: the routes are already on screen by
 * now — `onRoute` ran during the stream — so nothing is waiting on this except
 * the caller's promise, and a save that has definitely finished is a save that
 * can be tested.
 *
 * But awaited *with a deadline*. `fetchRoutes` resolving is what moves App.jsx
 * out of `loading`, so an await here puts CacheStorage on the critical path of
 * the interface settling. `saveRoutes` cannot reject — every path is caught —
 * but it can hang, because a `cache.put` under storage pressure is allowed to
 * take as long as it likes, and a promise that never settles would leave the
 * spinner up over three routes that are already rendered behind it. The save
 * continues either way; only the waiting stops.
 */
const SAVE_DEADLINE_MS = 3000

async function keep(req, final, { stamp, signal }) {
  if (!final || stamp || signal?.aborted) return
  let timer
  try {
    await Promise.race([
      saveRoutes(req, final),
      new Promise((resolve) => {
        timer = setTimeout(resolve, SAVE_DEADLINE_MS)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

async function realGeocode(q, { signal }) {
  let res
  try {
    res = await fetch(url(`/api/geocode?q=${encodeURIComponent(q)}`), { signal })
  } catch (err) {
    if (err?.name === 'AbortError') throw err
    throw new ApiError('Could not reach the place search.')
  }
  if (!res.ok) throw await toApiError(res)
  const body = await res.json()
  return body.results ?? []
}

/**
 * Route search. Calls `onProgress` and `onRoute` as results arrive and resolves
 * with the final payload (cache stats, reason, best departure).
 */
export async function fetchRoutes(req, handlers) {
  if (isMock) {
    const { mockFetchRoutes } = await import('./mock.js')
    return mockFetchRoutes(req, handlers)
  }
  return realFetchRoutes(req, handlers)
}

export async function geocode(q, options = {}) {
  if (isMock) {
    const { mockGeocode } = await import('./mock.js')
    return mockGeocode(q, options)
  }
  return realGeocode(q, options)
}

/**
 * File an obstruction as an OpenStreetMap note.
 *
 * ⚠ **The only write this application makes, and it is to a public database.**
 * Everything else here is a read that leaves no trace; this leaves a permanent,
 * publicly visible note carrying a coordinate and whatever the person typed.
 * ReportBarrier.jsx says so before its submit button, because a privacy
 * promise that has an exception must name it where the exception happens.
 *
 * The target is api06.dev.openstreetmap.org — the OSM *development* server,
 * whose data is disposable — and backend/main.py asserts that host at call time
 * rather than only configuring it, because a copy-paste that repointed it at
 * production would put junk into the map everyone else relies on.
 *
 * OSM_DEV_TOKEN is optional: backend/osm_report.py:60 notes that anonymous
 * notes are permitted, so a missing token means an unattributed note, not a
 * broken feature. Callers must therefore key their failure handling on the
 * response, never on whether a token is configured.
 */
export async function reportBarrier(report, { signal } = {}) {
  if (isMock) {
    const { mockReportBarrier } = await import('./mock.js')
    return mockReportBarrier(report, { signal })
  }
  const res = await fetch(url('/api/report-barrier'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(report),
    signal,
  })
  if (!res.ok) throw await toApiError(res)
  return res.json()
}

/**
 * Photos along a route.
 *
 * ## Why this goes through our own backend
 *
 * The images come from Wikimedia Commons and Mapillary, and neither is asked
 * for them by the browser. The backend queries both and streams the bytes back
 * from `/api/photo/{ref}`, so the route's coordinates and the user's IP never
 * reach either host. That was the deciding constraint rather than a nicety:
 * this app's whole position is that where you are is your business, and a
 * thumbnail request carrying a lat/lon to a third party would give that away
 * on the screen that shows you your walk.
 *
 * It has a second, purely practical payoff. Mapillary serves thumbnails from
 * rotating `scontent-*.xx.fbcdn.net` hostnames, which a strict CSP cannot name
 * without allowing the whole of Facebook's CDN. Streaming through the API means
 * `public/_headers` allows one stable origin instead.
 *
 * ## It must never break a route
 *
 * A photo is decoration on top of an answer that is already complete without
 * it. Every failure here — offline, 429, a backend that has not been redeployed
 * and answers 404 — resolves to `null`, and the caller renders nothing. It does
 * not surface an error, because there is no action the user could take and no
 * information they are missing.
 */
export async function fetchPhotos(body, { signal } = {}) {
  if (isMock) {
    const { mockFetchPhotos } = await import('./mock.js')
    return mockFetchPhotos(body, { signal })
  }
  try {
    const res = await fetch(url('/api/photos'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal,
    })
    if (!res.ok) return null
    return await res.json()
  } catch {
    // Includes the abort, which is the common case: opening one route detail
    // and closing it before the request lands. An aborted fetch is not a
    // failure to report, and the component that started it has unmounted.
    return null
  }
}

/** The full URL for a photo the API described. The backend returns a path on
 *  its own origin, so a split deployment has to put the API base back on. */
export function photoUrl(path) {
  return typeof path === 'string' && path.startsWith('/') ? url(path) : path
}
