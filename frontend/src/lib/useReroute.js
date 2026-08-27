import { useEffect, useRef, useState } from 'react'

import { buildRouteRequest, fetchRoutes } from '../api/client.js'

/**
 * Recalculation after a wrong turn: the one request follow mode makes.
 *
 * ## What this changes about the privacy story, and why it is here
 *
 * Everything else in follow mode runs against geometry the app downloaded
 * before the walk began — `lib/follow.js` and `lib/followTracking.js` still
 * make no request of any kind, and are pinned to that by test. But a follow
 * mode that can only say "head back" after a wrong turn is a map, not a guide:
 * the route has to be redrawn from where the walker actually stands, and there
 * is no way to ask a routing server for a route without telling it the origin.
 *
 * So this hook is the single, deliberate exception, kept in its own module so
 * the exception has edges: one position fix per attempt, sent to the same
 * `/api/routes` the plan was made with, only after the off-route state has
 * been sustained for fifteen seconds, and never more often than the cooldown.
 * The UI discloses it at both ends — the provenance line under the dock names
 * the exception before it happens, the recalculating card names it while it
 * happens, and the arrival card counts what was sent once it has.
 *
 * ## Why the walked route is replaced outside the reducer
 *
 * The planned set in `App`'s reducer is the answer to the question the user
 * asked on the plan screen, and the cards, the permalink and the offline store
 * all hang off it. A reroute answers a different question — "from here, now" —
 * so it lives beside the follow session and dies with it: `onReroute` hands
 * the new line to a piece of state that `App` clears the moment follow mode
 * closes, and the original plan is intact behind it.
 */

/**
 * How long after an attempt — successful or not — before another may start.
 *
 * A reroute costs real routing credits and carries a real position, so it must
 * not fire once per GPS fix. Fifteen seconds of sustained off-route gate the
 * first attempt (that is `trackOffRoute`'s clock, unchanged); this spaces the
 * retries when the server is unreachable or the walker ignores the new line
 * too. Twelve seconds is about seventeen metres at walking pace: far enough
 * that the next attempt is a genuinely different request, close enough that
 * nobody walks a block on a stale map.
 */
export const REROUTE_COOLDOWN_MS = 12000

/**
 * The request body for a reroute, or null when there is nothing to ask.
 *
 * From where the walker stands to where the followed route was always going —
 * the last vertex of the line, which for a loop is the place the walk started.
 * One objective, the one being walked: asking for three would spend three
 * routes' credits to throw two away.
 *
 * ⚠ `position` is `[lon, lat]`, wire order, and the request wants named
 * fields. The same axis swap `pointAtDistance` warns about, in the other
 * direction; getting it backwards asks for a route in the wrong hemisphere.
 */
export function rerouteRequestFor(position, route, mode) {
  const end = route?.geometry?.[route.geometry.length - 1]
  if (!position || !end) return null
  return buildRouteRequest({
    origin: { lat: position[1], lon: position[0] },
    dest: { lat: end[1], lon: end[0] },
    mode,
    objectives: [route.id],
  })
}

/**
 * The route to keep from a reroute answer.
 *
 * The same objective if it came back drawable, otherwise whatever did — a
 * changed id is survivable, an empty map is not. `blocked` is deliberately NOT
 * filtered out: the accessible preset can return a blocked route that still
 * carries geometry, steps and its barriers, and the person mid-walk on it is
 * exactly the person `barriersAheadOnRoute` argues must keep being guided.
 */
export function pickRerouted(payload, routeId) {
  const drawable = (r) => (r?.geometry?.length ?? 0) > 1
  const routes = payload?.routes ?? []
  return routes.find((r) => r.id === routeId && drawable(r)) ?? routes.find(drawable) ?? null
}

/**
 * Watch the tracking's sustained off-route state and recalculate the route
 * from the live position when it fires.
 *
 * Returns `{ rerouting, failed, count }` for the sheet: `rerouting` while a
 * request is in flight, `failed` once one has not come back (cleared by the
 * next attempt), `count` across the whole follow session for the arrival
 * card's honest sentence about what was sent.
 */
export function useReroute({ route, mode, tracking, onReroute, onAnnounce }) {
  const [state, setState] = useState({ rerouting: false, failed: false, count: 0 })

  // Read by the attempt at fire time rather than depended on: the position
  // changes with every fix and the route with every reroute, and an effect
  // keyed on either would tear down the retry timer it is trying to run.
  const routeRef = useRef(route)
  const modeRef = useRef(mode)
  const positionRef = useRef(null)
  const onRerouteRef = useRef(onReroute)
  const onAnnounceRef = useRef(onAnnounce)
  const lastAttemptAt = useRef(0)
  // One spoken failure per run of failures, not one per retry: a walker with
  // no signal does not need the same bad news every twelve seconds. A ref
  // rather than reading `state.failed`, so the announcement cannot double
  // under StrictMode's twice-run updaters.
  const announcedFailure = useRef(false)

  useEffect(() => {
    routeRef.current = route
  }, [route])
  useEffect(() => {
    modeRef.current = mode
  }, [mode])
  useEffect(() => {
    positionRef.current = tracking?.position ?? null
  }, [tracking?.position])
  useEffect(() => {
    onRerouteRef.current = onReroute
  }, [onReroute])
  useEffect(() => {
    onAnnounceRef.current = onAnnounce
  }, [onAnnounce])

  const following = Boolean(route)

  // A new follow session starts with a clean slate: no failure held over from
  // the last walk, and a count that belongs to this one.
  useEffect(() => {
    if (following) return
    setState({ rerouting: false, failed: false, count: 0 })
    lastAttemptAt.current = 0
    announcedFailure.current = false
  }, [following])

  // `offRoute` is already the sustained signal — fifteen continuous seconds
  // past forty metres, per trackOffRoute — so no further debounce is needed
  // before the first attempt. Arrival wins over rerouting: someone standing at
  // the destination is not lost, whatever the perpendicular distance says.
  const wanted = following && tracking?.offRoute === true && tracking?.arrived !== true

  useEffect(() => {
    if (!wanted) return undefined

    let cancelled = false
    let timer
    const controller = new AbortController()

    const attempt = async () => {
      const req = rerouteRequestFor(positionRef.current, routeRef.current, modeRef.current)
      if (!req) {
        schedule()
        return
      }
      lastAttemptAt.current = Date.now()
      setState((s) => ({ ...s, rerouting: true }))
      try {
        // The stream's progress and per-route events are for the plan screen's
        // skeletons; a walker mid-turn needs the settled answer or nothing.
        const payload = await fetchRoutes(req, {
          signal: controller.signal,
          onProgress: () => {},
          onRoute: () => {},
        })
        if (cancelled) return
        const next = pickRerouted(payload, routeRef.current?.id)
        if (!next) throw new Error('the reroute answer held no drawable route')
        announcedFailure.current = false
        setState((s) => ({ rerouting: false, failed: false, count: s.count + 1 }))
        onRerouteRef.current?.(next)
        onAnnounceRef.current?.('Route recalculated from where you are.')
        // The new geometry re-anchors the match and clears `offRoute`, which
        // ends this effect. If it somehow does not — the fresh route is also
        // out of reach — the cooldown gives it another go rather than leaving
        // the walker with a card that says recalculating and a timer that
        // never fires.
        schedule()
      } catch (err) {
        if (cancelled || err?.name === 'AbortError') return
        if (!announcedFailure.current) {
          announcedFailure.current = true
          onAnnounceRef.current?.(
            'The route could not be recalculated. Head back toward the marked path.',
          )
        }
        setState((s) => ({ ...s, rerouting: false, failed: true }))
        schedule()
      }
    }

    const schedule = () => {
      if (cancelled) return
      const wait = Math.max(0, lastAttemptAt.current + REROUTE_COOLDOWN_MS - Date.now())
      timer = setTimeout(attempt, wait)
    }

    schedule()
    return () => {
      cancelled = true
      clearTimeout(timer)
      controller.abort()
    }
  }, [wanted])

  return state
}
