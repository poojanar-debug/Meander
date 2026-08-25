import { useEffect, useRef, useState } from 'react'

import ManoeuvreIcon from './ManoeuvreIcon.jsx'
import ReportBarrier from './ReportBarrier.jsx'
import { fmtDist, fmtDur, fmtDurSpoken } from '../lib/format.js'
import { fmtClockIn, formatAccuracy, formatElevation, lowerClock } from '../lib/units.js'
import { pointAtDistance } from '../lib/follow.js'
import { CheckIcon, BlockerIcon } from './Icons.jsx'

/**
 * Walking a route: the next-turn banner, the dock, and the three cards that
 * replace or join them — barrier ahead, off route, arrived.
 *
 * ## Privacy
 *
 * **No request made anywhere in this feature carries the live position.** The
 * watch, and everything derived from it, lives in `lib/followTracking.js` so
 * that the map and this layer read one value instead of two; the privacy
 * argument is stated there in full. Nothing in this component fetches, and
 * nothing it is given came from a request made after follow mode started. The
 * provenance line at the foot of the screen says so at the moment tracking
 * runs, not only on a privacy page nobody opens while walking.
 *
 * ## The banner
 *
 * The largest thing on the screen is the turn **ahead**, never the one you
 * are inside. GraphHopper names a manoeuvre at the *start* of the interval it
 * belongs to, so the step containing you is the turn already taken —
 * `steps[stepIndex + 1]` is the one to show, and the "then" row under the
 * hairline previews the step after that.
 *
 * ## Everything degrades
 *
 * Permission denied drops back to an explanation and the way out. Follow mode
 * is never the only way to read a route.
 */

/** Under five metres the honest treatment is no number at all: formatDistance
 *  rounds to 10 m below 1 km, so anything smaller renders "0 m" — an
 *  instruction to travel no distance. The banner simply omits the figure. */
const TURN_IS_NOW_M = 5

const typeLabel = (type) => {
  const readable = String(type ?? '').replace(/_/g, ' ')
  return readable.charAt(0).toUpperCase() + readable.slice(1)
}

/** Which side of you the route is on: bearing to the nearest on-route point
 *  against your travel heading. Null when there is no heading to compare
 *  with — standing still, most fixes carry none — and then the sentence
 *  simply says how far rather than which way. */
function sideOfRoute(position, target, headingDeg) {
  if (!position || !target || headingDeg == null) return null
  const toDeg = 180 / Math.PI
  const dLon = (target.lon - position[0]) * Math.cos((position[1] * Math.PI) / 180)
  const dLat = target.lat - position[1]
  const bearing = (Math.atan2(dLon, dLat) * toDeg + 360) % 360
  const relative = (bearing - headingDeg + 540) % 360 - 180
  return relative < 0 ? 'left' : 'right'
}

export default function FollowMode({ route, units, isLoop, tracking, onExit, onAnnounce }) {
  const {
    at,
    position,
    headingDeg,
    error,
    offRoute,
    offRouteSince,
    poorSignal,
    poorAccuracyM,
    arrived,
    startedAt,
    stepIndex,
    nextStep,
    toTurn,
    remainingM,
    remainingMin,
    totalM,
    cumulative,
    closest,
    alertKey,
    accuracyM,
  } = tracking

  const endRef = useRef(null)
  const announcedStep = useRef(-1)
  const announcedArrival = useRef(false)

  // Focus lands on End when follow mode opens, so the way out is the first
  // thing a keyboard or screen-reader user meets rather than something they
  // have to hunt for while walking. `preventScroll` because the layer is
  // fixed and full-screen — there is nothing to scroll to.
  useEffect(() => {
    endRef.current?.focus({ preventScroll: true })
  }, [])

  // The turn ahead is announced through the app's single polite live region.
  // A second live region here would be two voices talking over each other on
  // every position update.
  useEffect(() => {
    if (arrived || !nextStep || stepIndex === announcedStep.current) return
    announcedStep.current = stepIndex
    onAnnounce?.(nextStep.text)
  }, [nextStep, stepIndex, arrived, onAnnounce])

  useEffect(() => {
    if (!arrived || announcedArrival.current) return
    announcedArrival.current = true
    onAnnounce?.('You have arrived.')
  }, [arrived, onAnnounce])

  // The off-route headline counts up, so it needs a clock that ticks while it
  // shows and stops the moment it does not.
  const [, setTick] = useState(0)
  useEffect(() => {
    if (!offRoute) return undefined
    const timer = setInterval(() => setTick((t) => t + 1), 1000)
    return () => clearInterval(timer)
  }, [offRoute])

  const thenStep = stepIndex >= 0 ? (route?.steps?.[stepIndex + 2] ?? null) : null

  const arriveAt =
    remainingMin != null ? new Date(Date.now() + remainingMin * 60000) : null
  // The ± figure goes through formatAccuracy, not the route-distance
  // formatter: ±9 m must not be relabelled ±10 m.
  const gps = accuracyM != null ? `GPS ${formatAccuracy(accuracyM, units)}` : null

  const dockSub = poorSignal
    ? `waiting for signal · GPS ${formatAccuracy(poorAccuracyM, units)}`
    : offRoute
      ? ['paused off route', gps].filter(Boolean).join(' · ')
      : [arriveAt ? `arrive ${lowerClock(fmtClockIn(arriveAt, units))}` : null, gps]
          .filter(Boolean)
          .join(' · ')

  // Off route: where the marked path is from here, for the way-back sentence.
  const nearestOnRoute =
    offRoute && at && route?.geometry?.length > 1
      ? pointAtDistance(route.geometry, at.alongM, cumulative)
      : null
  const side = sideOfRoute(position, nearestOnRoute, headingDeg)
  const offDistance = at ? fmtDist(at.offRouteM, units) : null
  const offSeconds =
    offRouteSince != null ? Math.max(0, Math.round((Date.now() - offRouteSince) / 1000)) : null

  const elapsedMin = startedAt != null ? (Date.now() - startedAt) / 60000 : null

  if (arrived) {
    return (
      <div className="follow">
        <div className="follow__arrival-wrap">
          <div className="follow__arrival">
            <span className="follow__arrival-circle" aria-hidden="true">
              <CheckIcon size={24} />
            </span>
            <h2 className="follow__arrival-title">{isLoop ? 'Loop complete' : 'Arrived'}</h2>
            <p className="follow__arrival-stats mono">
              {fmtDur(elapsedMin)} · {fmtDist(totalM, units)} ·{' '}
              {formatElevation(route?.elevation?.ascent_m, units)} climbed
            </p>
            <hr className="follow__rule" />
            <p className="follow__arrival-note">
              {fmtDurSpoken(elapsedMin)} outside. Nothing was uploaded — this walk exists only
              on your phone.
            </p>
            <button type="button" className="button-sky follow__done" onClick={onExit}>
              Done
            </button>
            <ReportBarrier route={route} units={units} />
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="follow">
      {error ? (
        <div className="follow__off" role="alert">
          <p className="follow__off-title">Follow mode cannot see where you are.</p>
          <p className="follow__off-body">{error}</p>
        </div>
      ) : offRoute ? (
        <div className="follow__off" role="alert">
          <p className="follow__off-title">
            Off route for {offSeconds ?? 15} second{(offSeconds ?? 15) === 1 ? '' : 's'}
          </p>
          <p className="follow__off-body">
            Head back toward the marked path
            {offDistance
              ? side
                ? ` — it is about ${offDistance} to your ${side}.`
                : ` — it is about ${offDistance} away.`
              : '.'}
          </p>
          <hr className="follow__rule follow__rule--dark" />
          <p className="follow__off-foot mono">
            no recalculation in follow mode — your position never leaves this phone
          </p>
        </div>
      ) : (
        nextStep && (
          <div className="follow__banner">
            <div className="follow__banner-main">
              <span className="follow__tile" aria-hidden="true">
                <ManoeuvreIcon sign={nextStep.sign ?? 0} className="follow__arrow" />
              </span>
              <div className="follow__banner-body">
                {toTurn != null && toTurn >= TURN_IS_NOW_M && (
                  <p className="follow__distance mono">{fmtDist(toTurn, units)}</p>
                )}
                <p className="follow__instruction">{nextStep.text}</p>
              </div>
            </div>
            {thenStep && (
              <div className="follow__then">
                <span className="follow__then-word mono">then</span>
                <ManoeuvreIcon sign={thenStep.sign ?? 0} className="follow__then-arrow" />
                <span className="follow__then-text">{thenStep.text}</span>
              </div>
            )}
          </div>
        )
      )}

      {/* Barrier ahead: identity and copy in an alert keyed by the barrier, so
          a genuinely different barrier re-announces and a counted-down metre
          does not. One vibration per identity fires in the tracking hook. */}
      {closest && !offRoute && !error && (
        <div className="follow__barrier" role="alert" key={alertKey}>
          <span className="follow__barrier-circle" aria-hidden="true">
            <BlockerIcon type={closest.blocker.type} size={18} />
          </span>
          <span className="follow__barrier-body">
            <strong className="follow__barrier-title">
              {/* aheadM runs as low as -15: the behind-tolerance keeps the
                  warning up while someone stands at the thing it warns about,
                  and "in -10 m" is not a sentence. Under the 5 m floor the
                  distance is omitted, per the global rule. */}
              {closest.aheadM >= TURN_IS_NOW_M
                ? `${typeLabel(closest.blocker.type)} in ${fmtDist(closest.aheadM, units)}`
                : `${typeLabel(closest.blocker.type)} here`}
            </strong>
            <span className="follow__barrier-text">{closest.blocker.description}</span>
          </span>
        </div>
      )}

      <div className="follow__dock">
        <div className="follow__dock-main">
          <p className="follow__dock-headline">
            {fmtDur(remainingMin)} · {fmtDist(remainingM, units)} left
          </p>
          <p className="follow__dock-sub mono">{dockSub}</p>
        </div>
        <button type="button" className="follow__end" onClick={onExit} ref={endRef}>
          End
        </button>
      </div>

      <p className="follow__provenance mono">
        position never leaves this phone — no network in follow mode
      </p>
    </div>
  )
}
