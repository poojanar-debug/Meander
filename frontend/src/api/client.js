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

/** Build the request body. `destination` is omitted entirely for a loop, not sent as null. */
export function buildRouteRequest({ origin, dest, minutes, mode, objectives, departAt }) {
  const body = {
    origin: { lat: origin.lat, lon: origin.lon },
    minutes,
    mode,
    objectives,
  }
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
 * Answer from the saved set, if there is one and it answers *this* request.
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
    // answers for the identical search.
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
    const json = await res.json()
    json.routes.forEach((route) => onRoute(mark(route)))
    const payload = markPayload(json)
    await keep(req, payload, { stamp, signal })
    return payload
  }

  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let final = null

  for (;;) {
    const { value, done } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    const parts = buffer.split('\n\n')
    buffer = parts.pop() ?? ''
    for (const part of parts) {
      const line = part.split('\n').find((l) => l.startsWith('data:'))
      if (!line) continue
      let evt
      try {
        evt = JSON.parse(line.slice(5))
      } catch {
        // A truncated frame is not fatal; the next read completes it.
        continue
      }
      if (evt.type === 'progress') onProgress(evt)
      else if (evt.type === 'route') onRoute(mark(evt.route))
      else if (evt.type === 'done') final = markPayload(evt.payload)
      else if (evt.type === 'error') {
        throw new ApiError(evt.message ?? 'The server stopped part-way through.', {
          kind: evt.kind ?? 'stream',
        })
      }
    }
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
 * About.jsx and FirstRun.jsx both say so, because a privacy promise that has an
 * exception must name it.
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
