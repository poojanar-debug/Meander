import { useEffect, useMemo, useRef, useState } from 'react'

import {
  barriersWithin,
  cumulativeDistances,
  locateOnRoute,
  metresToNextTurn,
  nextRestStop,
  stepAt,
  trackOffRoute,
} from '../lib/follow.js'
import { fmtDist, fmtDur, restStopName } from '../lib/format.js'

const BARRIER_RADIUS_M = 200
const VIBRATE_PATTERN = [200, 100, 200]

const prefersReducedMotion = () =>
  window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true

/**
 * Walking a route. Implements §6.7.
 *
 * ## Privacy
 *
 * **No request made anywhere in this component carries the live position.**
 * Progress along the line, distance to the next turn, off-route detection and
 * barrier proximity are all computed in `lib/follow.js` against geometry the
 * app downloaded before follow mode started. There is no endpoint that could
 * log a coordinate even by accident, because there is no call.
 *
 * That is said in the UI at the moment follow mode starts, not only in a
 * privacy page — the moment someone turns on continuous location tracking is
 * the moment they want to know where it goes.
 *
 * ## The warning this feature exists for
 *
 * The barrier alert fires at 200 m **even on a route the app has already said
 * is blocked**. Someone who read "three steps at the canal crossing" and chose
 * to try anyway is precisely the person who most needs telling when those steps
 * are two hundred metres ahead. Suppressing it because they had been warned
 * once would be the app deciding it had discharged its duty.
 *
 * ## Everything degrades
 *
 * Permission denied drops back to the detail panel with the step list open.
 * Follow mode is never the only way to read a route.
 */
export default function FollowMode({ route, units, onExit, onAnnounce }) {
  const geometry = route.geometry ?? []
  const cumulative = useMemo(() => cumulativeDistances(geometry), [geometry])
  const totalM = cumulative[cumulative.length - 1] ?? route.distance_m ?? 0

  const [position, setPosition] = useState(null)
  const [error, setError] = useState(null)
  const [offRoute, setOffRoute] = useState(false)
  const [alerted, setAlerted] = useState(null)

  const offRouteState = useRef(null)
  const exitRef = useRef(null)
  const announcedStep = useRef(-1)

  // Focus lands on Exit when follow mode opens, so the way out is the first
  // thing a keyboard or screen-reader user meets rather than something they
  // have to hunt for while walking.
  useEffect(() => {
    exitRef.current?.focus()
  }, [])

  // --- the watch -----------------------------------------------------------

  useEffect(() => {
    if (!navigator.geolocation) {
      setError('This browser cannot share your location, so it cannot follow the route with you.')
      return undefined
    }
    const id = navigator.geolocation.watchPosition(
      (pos) => {
        setError(null)
        setPosition([pos.coords.longitude, pos.coords.latitude])
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
  }, [])

  // --- screen wake lock ----------------------------------------------------

  useEffect(() => {
    let lock = null
    let cancelled = false

    // Unsupported on several browsers and rejected outright in some contexts.
    // It must never throw: losing the wake lock is a dimmed screen, and losing
    // follow mode is being lost.
    const acquire = async () => {
      try {
        lock = await navigator.wakeLock?.request('screen')
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
  }, [])

  // --- everything derived from the position, all of it local ---------------

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
    () => (position ? locateOnRoute(position, geometry, cumulative, anchorM.current) : null),
    [position, geometry, cumulative],
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
  const currentStep = stepIndex >= 0 ? route.steps?.[stepIndex] : null
  const toTurn = at ? metresToNextTurn(route.steps, stepIndex, at.alongM, cumulative) : null
  const rest = at ? nextRestStop(route.rest_stops, at.alongM) : null
  const remainingM = at ? Math.max(0, totalM - at.alongM) : totalM
  const remainingMin =
    totalM > 0 && typeof route.duration_min === 'number'
      ? (remainingM / totalM) * route.duration_min
      : null

  const nearby = useMemo(
    () => (position ? barriersWithin(route.blockers, position, BARRIER_RADIUS_M) : []),
    [position, route.blockers],
  )
  const closest = nearby[0] ?? null

  // Sustained off-route, never a single reading.
  useEffect(() => {
    if (!at) return
    const next = trackOffRoute(offRouteState.current, at.offRouteM, Date.now())
    offRouteState.current = next
    setOffRoute(next.offRoute)
  }, [at?.offRouteM, at])

  // One vibration per barrier, not one per position update.
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

  // The current step is announced through the app's existing polite live
  // region. A second live region here would mean two voices talking over each
  // other on every update.
  useEffect(() => {
    if (!currentStep || stepIndex === announcedStep.current) return
    announcedStep.current = stepIndex
    onAnnounce?.(currentStep.text)
  }, [currentStep, stepIndex, onAnnounce])

  return (
    <div className="follow">
      {/* First in the DOM inside follow mode, so it is first in the tab order,
          and always visible rather than behind a gesture. */}
      <button type="button" className="follow__exit" onClick={onExit} ref={exitRef}>
        <span aria-hidden="true">←</span> Stop
      </button>

      {closest && (
        <div className="follow__alert" role="alert">
          <strong>{closest.blocker.type}</strong> {fmtDist(closest.distanceM, units)} ahead —{' '}
          {closest.blocker.description}
        </div>
      )}

      {offRoute && !closest && (
        <div className="follow__alert follow__alert--soft" role="alert">
          You’ve left the route.
          <button type="button" className="link-button" onClick={onExit}>
            Recalculate
          </button>
        </div>
      )}

      {/* A labelled region, so the sheet's contents belong to a landmark. Not a
          dialog and not a modal: the map underneath stays pannable and
          reachable, which is what §6.7 asks for. */}
      <section className="sheet" aria-label="Following this route">
        {error ? (
          <>
            <p className="sheet__step">{error}</p>
            <button type="button" className="button button--primary" onClick={onExit}>
              Back to the directions
            </button>
          </>
        ) : (
          <>
            <p className="sheet__step">
              {currentStep ? currentStep.text : 'Finding you on the route…'}
            </p>
            {toTurn != null && (
              <p className="sheet__metric tabular">
                {fmtDist(toTurn, units)} <span className="sheet__metric-unit">to the next turn</span>
              </p>
            )}
            {rest && (
              <p className="sheet__row">
                {restStopName(rest.stop.type, 1)} in {fmtDist(rest.inM, units)}
              </p>
            )}
            <p className="sheet__row tabular">
              {fmtDist(totalM - remainingM, units)} of {fmtDist(totalM, units)}
              {remainingMin != null && ` · about ${fmtDur(remainingMin)} left`}
            </p>
          </>
        )}

        {/* Said here, at the moment tracking starts — not only on a privacy
            page nobody opens while walking. */}
        <p className="sheet__privacy">
          Your position stays in this browser. Nothing about where you are is sent anywhere.
        </p>
      </section>
    </div>
  )
}
