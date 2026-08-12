import { useEffect, useMemo, useRef, useState } from 'react'

import {
  barriersAheadOnRoute,
  cumulativeDistances,
  haversineM,
  locateOnRoute,
  metresToNextTurn,
  nextRestStop,
  stepAt,
  trackOffRoute,
} from './follow.js'

/**
 * The live follow session: one watch, one position, one answer.
 *
 * ## Privacy
 *
 * **No request made anywhere in this module carries the live position.**
 * Progress along the line, distance to the next turn, off-route detection and
 * barrier proximity are all computed in `lib/follow.js` against geometry the
 * app downloaded before follow mode started. There is no endpoint that could
 * log a coordinate even by accident, because there is no call. That claim is
 * the whole privacy position of the feature and it is said in the UI at the
 * moment tracking starts, not only on a privacy page nobody opens while
 * walking.
 *
 * It survives this file having moved out of `FollowMode`. The lift is why it
 * has to be restated here rather than left where it was: the coordinate now
 * passes through `App`, which is the component that owns every fetch in the
 * app, so the reader who needs this sentence is the one editing App.
 *
 * ## Why this is a hook in App rather than state in FollowMode
 *
 * The map and the sheet have to agree. When the position lived in
 * `FollowMode`'s local state the map could not see it at all — `MapView` took
 * no position prop and `App` passed none — so the camera stayed on a
 * whole-route `fitBounds` at 3.4 to 5.1 metres per pixel, at which a 1.4 m/s
 * walker moves 0.28 px per second and the 7px selected line is 35 m wide on the
 * ground. There was no position marker of any kind. Two components reading one
 * value is the fix; two components each watching geolocation would be two
 * watches, two batteries and two answers.
 *
 * Passing `route: null` starts nothing. That matters: this hook is called from
 * `App`, which is always mounted, and a geolocation watch that ran whenever the
 * app was open would be exactly the thing the privacy note promises does not
 * happen.
 */

/**
 * Fixes worse than this never touch the anchor, the off-route clock or the
 * vibration.
 *
 * 75 m is the figure this project's own review used. The failure it prevents is
 * specific: a cell-tower fix can be kilometres out, and every one of them used
 * to advance the position along the line, start the fifteen-second off-route
 * clock and fire the barrier vibration, with nothing able to reject it. One
 * such fix in an urban canyon moves the walker to a street they are not on.
 *
 * The rejection is deliberately *visible*. A silent no-op means follow mode
 * quietly stops working under a railway bridge with no explanation, which is
 * indistinguishable from the app being broken.
 */
export const ACCURACY_LIMIT_M = 75

/** Barriers are called out this far ahead, measured along the route. */
export const BARRIER_RADIUS_M = 200

/**
 * Close enough to the end to have arrived.
 *
 * Generous rather than tight: the endpoint is a router's snapped node, not the
 * door, and GPS at the end of a walk is no better than at the start.
 */
const ARRIVAL_M = 25

/**
 * How much of the route must be behind you before the end counts as the end.
 *
 * **A round trip starts and ends at the same coordinate**, which is the shape
 * this app produces by default, so proximity to the last vertex is on its own a
 * test that passes before anyone has set off. Gating on progress is what
 * separates "arrived" from "has not left".
 *
 * This deliberately does not touch `earliestAcceptable`'s start-of-route prior
 * in `lib/follow.js`, which exists for the same ambiguity and is pinned by
 * test. That prior places a first fix at the *start* of a loop; this gate then
 * refuses to call the start an arrival. They agree.
 */
const ARRIVAL_PROGRESS = 0.75

const VIBRATE_PATTERN = [200, 100, 200]

const prefersReducedMotion = () =>
  typeof window !== 'undefined' &&
  window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true

export function useFollowTracking(route) {
  const geometry = route?.geometry ?? null
  const active = Boolean(geometry && geometry.length > 1)

  const cumulative = useMemo(
    () => (active ? cumulativeDistances(geometry) : []),
    [geometry, active],
  )
  const totalM = cumulative[cumulative.length - 1] ?? route?.distance_m ?? 0

  const [fix, setFix] = useState(null)
  const [error, setError] = useState(null)
  const [offRoute, setOffRoute] = useState(false)
  const [poorSignal, setPoorSignal] = useState(false)
  const [arrived, setArrived] = useState(false)
  const [alerted, setAlerted] = useState(null)

  const offRouteState = useRef(null)
  const arrivedRef = useRef(false)

  // --- the watch -----------------------------------------------------------

  useEffect(() => {
    if (!active) return undefined
    if (!navigator.geolocation) {
      setError('This browser cannot share your location, so it cannot follow the route with you.')
      return undefined
    }
    const id = navigator.geolocation.watchPosition(
      (pos) => {
        setError(null)
        // `accuracy` was one of four fields the old callback threw away — it
        // kept longitude and latitude and discarded accuracy, heading, speed
        // and timestamp, which is why nothing could reject a bad fix.
        const accuracyM = typeof pos.coords?.accuracy === 'number' ? pos.coords.accuracy : null
        if (accuracyM != null && accuracyM > ACCURACY_LIMIT_M) {
          setPoorSignal(true)
          return
        }
        setPoorSignal(false)
        setFix({
          lon: pos.coords.longitude,
          lat: pos.coords.latitude,
          accuracyM,
          headingDeg: Number.isFinite(pos.coords?.heading) ? pos.coords.heading : null,
          speedMps: Number.isFinite(pos.coords?.speed) ? pos.coords.speed : null,
          timestamp: pos.timestamp ?? null,
        })
      },
      (err) => {
        setError(
          err?.code === err?.PERMISSION_DENIED
            ? 'Your browser did not share your location, so the route cannot be followed live. The directions below still work.'
            : 'Your location could not be read, so the route cannot be followed live. The directions below still work.',
        )
      },
      { enableHighAccuracy: true, maximumAge: 2000, timeout: 15000 },
    )
    return () => navigator.geolocation.clearWatch(id)
  }, [active])

  // Leaving follow mode has to leave nothing behind, or reopening it shows the
  // last walk's progress for one frame before the first fix lands.
  useEffect(() => {
    if (active) return
    setFix(null)
    setError(null)
    setOffRoute(false)
    setPoorSignal(false)
    setArrived(false)
    setAlerted(null)
    offRouteState.current = null
    arrivedRef.current = false
  }, [active])

  // --- screen wake lock ----------------------------------------------------

  useEffect(() => {
    if (!active) return undefined
    let lock = null
    let cancelled = false

    // Unsupported on several browsers and rejected outright in some contexts.
    // It must never throw: losing the wake lock is a dimmed screen, and losing
    // follow mode is being lost.
    //
    // `cancelled` is re-checked after the await, and that is the whole fix. A
    // sentinel whose promise resolves *after* Stop is pressed used to be
    // assigned to a closure variable that the already-run cleanup would never
    // see again — so the screen stayed awake for the rest of the session, on
    // the one screen whose entire purpose is that someone is out walking with
    // the phone in their hand.
    const acquire = async () => {
      try {
        const sentinel = await navigator.wakeLock?.request('screen')
        if (cancelled) {
          await sentinel?.release()
          return
        }
        lock = sentinel
      } catch {
        lock = null
      }
    }
    const onVisibility = () => {
      if (!cancelled && !document.hidden) acquire()
    }

    acquire()
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      cancelled = true
      document.removeEventListener('visibilitychange', onVisibility)
      try {
        lock?.release()
      } catch {
        // Already released, or the page is going away. Nothing to do.
      }
    }
  }, [active])

  // --- everything derived from the position, all of it local ---------------

  const position = useMemo(() => (fix ? [fix.lon, fix.lat] : null), [fix])

  // The previous match, carried so the projection can be anchored. A ref
  // rather than state: it is an input to the next match, not something the
  // render reads, and putting it in state would re-render on every fix for no
  // visible change. See locateOnRoute for why a loop cannot be matched without
  // it — the outbound and return legs are the same street, and whichever is
  // nearest at a given instant is decided by GPS noise.
  //
  // Written in an effect and never during render. Under StrictMode a render
  // runs twice, and advancing the anchor in the render body would feed the
  // second pass an anchor the first had already moved — the match would then
  // depend on how many times React chose to render, which is not a property a
  // position on a line may have.
  const anchorM = useRef(null)
  const at = useMemo(
    () => (position && active ? locateOnRoute(position, geometry, cumulative, anchorM.current) : null),
    [position, geometry, cumulative, active],
  )
  useEffect(() => {
    if (at) anchorM.current = at.alongM
  }, [at])

  // A different route is a different line, and an anchor measured along the old
  // one would window the search around a distance that means nothing here.
  useEffect(() => {
    anchorM.current = null
  }, [geometry])

  const stepIndex = at ? stepAt(route.steps, at.index) : -1
  const currentStep = stepIndex >= 0 ? route?.steps?.[stepIndex] : null
  // The banner names the turn you are *about to take*, which is the next step,
  // not the one you are inside. GraphHopper's convention — confirmed by
  // StepList and by the mock's generator — is that a step's `text` names the
  // manoeuvre at the START of its interval, so the step containing you names
  // the turn already behind you. The sheet used to show exactly that, in the
  // largest type on the screen.
  const nextStep = stepIndex >= 0 ? (route?.steps?.[stepIndex + 1] ?? null) : null
  const toTurn = at ? metresToNextTurn(route?.steps, stepIndex, at.alongM, cumulative) : null
  const rest = at ? nextRestStop(route?.rest_stops, at.alongM) : null
  const remainingM = at ? Math.max(0, totalM - at.alongM) : totalM
  const remainingMin =
    totalM > 0 && typeof route?.duration_min === 'number'
      ? (remainingM / totalM) * route.duration_min
      : null
  const progress = totalM > 0 && at ? Math.min(1, Math.max(0, at.alongM / totalM)) : 0

  // --- arrival -------------------------------------------------------------

  // Measured to the last coordinate of the line, not from `alongM`. They are
  // not the same claim: `projectOnto` clamps t to [0, 1], so every metre walked
  // *past* the endpoint turns into perpendicular distance instead. With
  // ON_ROUTE_M at 40 and a fifteen-second sustain, walking forty metres past
  // the end — to the door, into the park — used to make the app say "You've
  // left the route." at the exact moment someone arrived.
  //
  // Latched: once arrived, stay arrived. Without the latch the Finish button
  // appears and disappears under a thumb as the fix wanders either side of the
  // threshold.
  useEffect(() => {
    if (!active || arrivedRef.current) return
    if (!position || !at || !(totalM > 0)) return
    const end = geometry[geometry.length - 1]
    if (!end) return
    if (haversineM(position, end) <= ARRIVAL_M && at.alongM >= ARRIVAL_PROGRESS * totalM) {
      arrivedRef.current = true
      setArrived(true)
    }
  }, [active, position, at, totalM, geometry])

  // --- off route -----------------------------------------------------------

  // Sustained off-route, never a single reading — and never once arrived, or
  // standing at the destination reads as having abandoned the walk.
  useEffect(() => {
    if (!at || !active) return
    if (arrived) {
      offRouteState.current = null
      setOffRoute(false)
      return
    }
    const next = trackOffRoute(offRouteState.current, at.offRouteM, Date.now())
    offRouteState.current = next
    setOffRoute(next.offRoute)
  }, [at?.offRouteM, at, arrived, active])

  // --- barriers ------------------------------------------------------------

  const ahead = useMemo(
    () =>
      at && active
        ? barriersAheadOnRoute(route.blockers, geometry, cumulative, at.alongM, BARRIER_RADIUS_M)
        : [],
    [at, active, route?.blockers, geometry, cumulative],
  )
  const closest = ahead[0] ?? null

  // One vibration per barrier, not one per position update. The key is the
  // barrier's identity, so re-entering its radius after leaving does re-alert.
  useEffect(() => {
    if (!closest) {
      setAlerted(null)
      return
    }
    const key = `${closest.blocker.type}-${closest.blocker.lat}-${closest.blocker.lon}`
    if (alerted === key) return
    setAlerted(key)
    if (!prefersReducedMotion()) {
      try {
        navigator.vibrate?.(VIBRATE_PATTERN)
      } catch {
        // Unsupported, or blocked without a user gesture. Not worth a failure.
      }
    }
  }, [closest, alerted])

  return {
    active,
    position,
    accuracyM: fix?.accuracyM ?? null,
    headingDeg: fix?.headingDeg ?? null,
    at,
    cumulative,
    totalM,
    progress,
    error,
    offRoute,
    poorSignal,
    arrived,
    stepIndex,
    currentStep,
    nextStep,
    toTurn,
    rest,
    remainingM,
    remainingMin,
    closest,
    // The identity of the barrier currently being warned about, so the alert
    // can fire once per barrier instead of once per counted-down metre.
    alertKey: alerted,
  }
}
