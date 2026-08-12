import { useEffect, useRef } from 'react'

import ManoeuvreIcon from './ManoeuvreIcon.jsx'
import { fmtDist, fmtDur, restStopName } from '../lib/format.js'

/**
 * Walking a route. Implements §6.7.
 *
 * ## Privacy
 *
 * **No request made anywhere in this feature carries the live position.** The
 * watch, and everything derived from it, now lives in `lib/followTracking.js`
 * so that the map and this sheet read one value instead of two; the privacy
 * argument moved with it and is stated there in full. Nothing in this component
 * fetches, and nothing it is given came from a request made after follow mode
 * started.
 *
 * It is said in the UI at the moment tracking starts, not only on a privacy
 * page — the moment someone turns on continuous location tracking is the moment
 * they want to know where it goes.
 *
 * ## What this component is
 *
 * Presentation. It holds no position state of its own, which is the point: the
 * sheet and the camera cannot disagree about where the walker is if there is
 * only one place that knows.
 *
 * ## The banner
 *
 * The largest thing on the screen is the turn **ahead**, not the one you are
 * in. GraphHopper names a manoeuvre at the *start* of the interval it belongs
 * to, so the step containing you is the turn you have already taken — and that
 * is what used to be rendered at 17px above "{distance} to the next turn" at
 * 28px, with `steps[stepIndex + 1]` never rendered at all. The glyph comes from
 * `Step.sign`, which had been on the wire since the first day there were steps
 * and which nothing in the frontend had ever read.
 *
 * ## Everything degrades
 *
 * Permission denied drops back to the detail panel with the step list open.
 * Follow mode is never the only way to read a route.
 */
export default function FollowMode({ route, units, tracking, onExit, onAnnounce }) {
  const {
    at,
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
    totalM,
    progress,
    closest,
    alertKey,
    accuracyM,
  } = tracking

  const exitRef = useRef(null)
  const announcedStep = useRef(-1)
  const announcedArrival = useRef(false)

  // Focus lands on Stop when follow mode opens, so the way out is the first
  // thing a keyboard or screen-reader user meets rather than something they
  // have to hunt for while walking.
  //
  // `preventScroll` is the fix for a measured defect, not a precaution. Without
  // it, `focus()` scrolls the element into view — and the Start button that
  // opens this sheet sits deep inside `.panel`, so the document had to be
  // scrolled 1338px down at 390x844 to reach it. Focusing here then teleported
  // the page the whole way back to 0. The layer is fixed and full-screen on a
  // phone, so there is nothing to scroll to in the first place.
  useEffect(() => {
    exitRef.current?.focus({ preventScroll: true })
  }, [])

  // The turn ahead is announced through the app's single polite live region.
  // A second live region here would mean two voices talking over each other on
  // every position update, which §6.7 asks us not to do.
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

  // The street the next turn is onto, falling back to the router's own sentence
  // when it has no name for it — a footpath through a park frequently has none,
  // and "Turn right" with nothing after it is better than an empty line.
  const bannerLine = nextStep ? (nextStep.street_name ?? nextStep.text) : null

  // Under five metres the honest word is "Now", not a number.
  //
  // `formatDistance` rounds to the nearest 10 m below 1 km, so everything under
  // 5 m renders as "0 m" — and under 1.524 m as "0 ft". Measured walking the
  // mock's fastest route: at every step boundary the banner read "0 ft" above
  // the name of the street to turn into, which tells someone to travel no
  // distance at all. Fixed here at the call site rather than in
  // `formatDistance`, which `units.test.js` pins byte for byte over every
  // integer metre from 0 to 200,000 and which is right to keep saying 0.
  const TURN_IS_NOW_M = 5

  return (
    <div className="follow">
      {/* First in the DOM inside follow mode, so it is first in the tab order,
          and always visible rather than behind a gesture. */}
      <button type="button" className="follow__exit" onClick={onExit} ref={exitRef}>
        <span aria-hidden="true">←</span> Stop
      </button>

      {/* The rejection has to be visible. Fixes worse than 75 m never reach the
          anchor, the off-route clock or the vibration, and a silent no-op means
          follow mode stops working under a railway bridge with nothing on
          screen to say why. Not a live region: it can flicker on and off with
          the signal, and an assertive announcement per flicker is worse than
          the silence it replaces. */}
      {poorSignal && !error && (
        <p className="follow__signal">
          Poor signal. Holding the last good position until the fix improves.
        </p>
      )}

      {closest && !arrived && (
        <div className="follow__alert">
          {/* Two elements, deliberately. The alert carries the barrier's
              identity and no number; the number sits beside it in an ordinary
              element. When the distance was inside the assertive region it was
              re-read on every change, and `formatDistance` rounds to 10 m below
              1 km — so one 200 m approach interrupted 21 times in metric. In
              imperial it is worse: FEET_BELOW_M is 160, so everything under
              160 m changes every 10 feet, which is 54 interruptions.
              `key` is the barrier's identity, so React remounts the region for
              a genuinely different barrier and announces once per barrier. */}
          <p className="follow__alert-say" role="alert" key={alertKey}>
            <strong>{closest.blocker.type}</strong> ahead on this route.{' '}
            {closest.blocker.description}
          </p>
          <p className="follow__alert-dist tabular">{fmtDist(closest.aheadM, units)} away</p>
        </div>
      )}

      {offRoute && !closest && !arrived && (
        <div className="follow__alert follow__alert--soft" role="alert">
          You’ve left the route.
          {/* Was "Recalculate", which never recalculated: it is wired to
              `onExit`, and the `follow` reducer case sits outside `withRefetch`
              on purpose so that entering or leaving follow mode cannot cost a
              request. Making it genuinely recalculate would mean sending the
              live position to the router, which contradicts the sentence at the
              foot of this sheet verbatim. The label now says what the button
              does. */}
          <button type="button" className="link-button" onClick={onExit}>
            Back to the directions
          </button>
        </div>
      )}

      {/* tabIndex 0 because the sheet is `overflow-y: auto`: when the viewport
          is short enough that it scrolls, a keyboard user has to be able to
          reach it. `scrollable-region-focusable` is wcag2a and in the gate's
          rule set, and in the ordinary state every child here is a paragraph
          with nothing focusable in it. */}
      <section className="sheet" aria-label="Following this route" tabIndex={0}>
        {error ? (
          <>
            <p className="sheet__step">{error}</p>
            <button type="button" className="button button--primary" onClick={onExit}>
              Back to the directions
            </button>
          </>
        ) : arrived ? (
          <>
            {/* `steps[stepIndex + 1]` being undefined is the last step, and this
                is where that branch goes rather than into a crash. */}
            <p className="sheet__arrival">
              <ManoeuvreIcon sign={4} className="sheet__glyph" />
              You have arrived.
            </p>
            <p className="sheet__row tabular">
              {route.label}, {fmtDist(totalM, units)} walked.
            </p>
            <button type="button" className="button button--primary sheet__finish" onClick={onExit}>
              Finish
            </button>
          </>
        ) : (
          <>
            <div className="sheet__banner">
              <ManoeuvreIcon sign={nextStep?.sign ?? 4} className="sheet__glyph" />
              <div className="sheet__banner-body">
                {toTurn != null && (
                  <p className="sheet__metric tabular">
                    {toTurn < TURN_IS_NOW_M ? 'Now' : fmtDist(toTurn, units)}
                  </p>
                )}
                <p className="sheet__instruction">
                  {bannerLine ?? 'Continue to the end of the route.'}
                </p>
              </div>
            </div>

            {/* Demoted, not deleted. The step you are inside is still the one
                whose surface and barriers the detail panel described, and
                someone who looks up mid-street wants to confirm they are on the
                right one. */}
            <p className="sheet__now">
              {currentStep ? currentStep.text : 'Finding you on the route…'}
            </p>

            {/* The existing token-only meter from the score list, at the one
                place in the app where progress is a literal fraction of a
                literal distance. */}
            <div className="scorelist__track sheet__progress" aria-hidden="true">
              <span className="scorelist__fill" style={{ width: `${Math.round(progress * 100)}%` }} />
            </div>

            {rest && (
              <p className="sheet__row">
                {restStopName(rest.stop.type, 1)} in {fmtDist(rest.inM, units)}
              </p>
            )}
            <p className="sheet__row tabular">
              {fmtDist(totalM - remainingM, units)} of {fmtDist(totalM, units)}
              {remainingMin != null && ` · about ${fmtDur(remainingMin)} left`}
              {at && accuracyM != null && ` · to within ${fmtDist(accuracyM, units)}`}
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
