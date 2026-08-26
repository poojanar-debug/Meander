import { useEffect, useRef } from 'react'

import { MODE_NOUN, confidenceSentence, fmtDist, fmtDur } from '../lib/format.js'
import { UNKNOWN, formatElevation } from '../lib/units.js'
import { bestWindowStat, BestWindow } from './DepartureStrip.jsx'
import ElevationProfile from './ElevationProfile.jsx'
import ExportPills from './ExportPills.jsx'
import StepList from './StepList.jsx'
import { ChevronRightIcon, CloseIcon } from './Icons.jsx'

/** The design's method line, always visible near the scores. Lowercase mono,
 *  matching how the wire value reads; an unrecognised method renders as
 *  itself rather than as a guess. */
const METHOD_LINE = {
  clip: 'scored from street-level imagery · cached, never live',
  geometry_only: 'scored from route shape only · no imagery available here',
  placeholder: 'placeholder values · not a measurement',
}

/** Which score, what it is called, and the accent its bar is filled with.
 *  The accent is a family from the palette rather than the objective's own
 *  route hue: three of these four rows have never matched the route of the
 *  same name, and making them match now would tell a user that the bar and
 *  the line on the map are the same measurement. */
const SCORE_ROWS = [
  ['scenic', 'scenic', 'mint'],
  ['air', 'air', 'sky'],
  ['shade', 'shade', 'lilac'],
  ['quiet', 'quiet', 'indigo'],
]

/** `bench` → Bench, `drinking water` → Water, `toilets` → Toilets: the short
 *  pill vocabulary. An unknown amenity keeps its own name, made readable. */
function restPillLabel(type) {
  const t = String(type ?? '').toLowerCase()
  if (t === 'bench') return 'Bench'
  if (t === 'drinking water' || t === 'drinking_water' || t === 'fountain') return 'Water'
  if (t === 'toilets') return 'Toilets'
  const readable = t.replace(/_/g, ' ')
  return readable.charAt(0).toUpperCase() + readable.slice(1)
}

/** The score bars: 58px label, 6px track, accent fill, mono value. A null
 *  score renders no bar at all — an empty track would claim a measurement of
 *  zero, and "not measured" is a different statement. While the enrichment
 *  pass is still running the rows are skeletons instead: "being checked" and
 *  "not measured" are different statements too. */
function ScoreBars({ scores, scoringMethod, pending = false }) {
  return (
    <div className="scores">
      {SCORE_ROWS.map(([key, label, accent]) => {
        const value = scores?.[key]
        const known = !pending && typeof value === 'number'
        return (
          <p className="scores__row" key={key}>
            <span className="scores__label">{label}</span>
            {pending ? (
              <span className="scores__track card__skeleton-bar" aria-hidden="true" />
            ) : known ? (
              <span className="scores__track" aria-hidden="true">
                <span
                  className={`scores__fill scores__fill--${accent}`}
                  style={{ width: `${Math.round(value * 100)}%` }}
                />
              </span>
            ) : (
              <span className="scores__unmeasured mono">not measured</span>
            )}
            <span className="scores__value mono">
              {known ? Math.round(value * 100) : UNKNOWN}
            </span>
          </p>
        )
      })}
      {pending ? (
        <p className="scores__method mono">Checking surfaces, air and rest stops</p>
      ) : (
        scoringMethod && (
          <p className="scores__method mono">{METHOD_LINE[scoringMethod] ?? scoringMethod}</p>
        )
      )}
    </div>
  )
}

/** The lilac coverage card: the server's sentence verbatim, and the one-line
 *  reminder of what unknown does not mean. */
function CoverageCard({ route }) {
  const { text } = confidenceSentence(route.confidence, route.scoring_method, route.confidence_note)
  return (
    <div className="coverage">
      <p className="coverage__text">{text}</p>
      <p className="coverage__sub mono">unknown never counts as safe</p>
    </div>
  )
}

/** Rest stops as mint pills — or the honest sentence when the data is null
 *  (could not look) or empty (looked, found none). The two are different
 *  answers and never render alike; "still being checked" is a third. */
function RestPills({ restStops, units, pending = false }) {
  if (pending) {
    return <p className="rests__absent">Rest stops are still being checked.</p>
  }
  if (restStops == null) {
    return (
      <p className="rests__absent">
        Rest stops were not checked for this route. That is not the same as there being none.
      </p>
    )
  }
  if (restStops.length === 0) {
    return <p className="rests__absent">No rest stops found along this route.</p>
  }
  return (
    <ul className="rests">
      {restStops.map((stop, i) => (
        <li className="rests__pill" key={`${stop.type}-${i}`}>
          {restPillLabel(stop.type)}
          {typeof stop.at_m === 'number' && (
            <span className="mono"> · {fmtDist(stop.at_m, units)}</span>
          )}
        </li>
      ))}
    </ul>
  )
}

function StatusChip({ route, isLoop }) {
  const shape = `${isLoop ? 'loop' : 'one way'} ${MODE_NOUN[route.mode] ?? route.mode}`
  const ok = route.status === 'ok'
  return (
    <span className={`detail__chip mono ${ok ? 'detail__chip--mint' : 'detail__chip--rose'}`}>
      {route.status} · {shape}
    </span>
  )
}

/**
 * One route, in full. Two skins over the same content: the desktop modal —
 * scrimmed map behind, 880px, two columns — and the mobile expanded sheet,
 * one column with the follow button on top.
 *
 * Everything here renders what the wire said or says that it cannot: the
 * narration block vanishes when narration is null (with its credit line, so
 * the credit never outlives the thing it credits), the coverage sentence is
 * the server's, and status_note renders verbatim whether the route was
 * refused or not.
 */
export default function RouteDetail({
  route,
  origin,
  dest,
  units,
  isLoop,
  mobile,
  bestDeparture,
  reason,
  onClose,
  onStart,
  onHighlight,
  onAnnounce,
}) {
  const closeRef = useRef(null)
  const surfaceRef = useRef(null)

  // The desktop modal contract: focus lands on the close control, Escape
  // closes, Tab cycles inside. The mobile sheet is not a modal — the map
  // sliver above it stays live — so none of this runs there.
  useEffect(() => {
    if (mobile) return undefined
    closeRef.current?.focus()
    const onKeyDown = (event) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        onClose()
        return
      }
      if (event.key !== 'Tab') return
      const layer = surfaceRef.current
      if (!layer) return
      const focusable = [
        ...layer.querySelectorAll(
          'button:not([disabled]), a[href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
        ),
      ].filter((el) => el.offsetWidth > 0 || el.offsetHeight > 0)
      if (!focusable.length) return
      const first = focusable[0]
      const last = focusable[focusable.length - 1]
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first.focus()
      } else if (!layer.contains(document.activeElement)) {
        event.preventDefault()
        first.focus()
      }
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [mobile, onClose])

  if (!route) return null

  // "Scenic loop", "Fastest loop" — the label plus the shape, which is how
  // the mockups title a round trip. A point-to-point keeps the bare label.
  const title = isLoop ? `${route.label} loop` : route.label

  const stats = [
    fmtDur(route.duration_min),
    fmtDist(route.distance_m, units),
    `${formatElevation(route.elevation?.ascent_m, units)} ${mobile ? 'climb' : 'up'}`,
  ]
  const windowStat = bestWindowStat(bestDeparture, units)
  if (!mobile && windowStat) stats.push(windowStat)

  const stepCount = route.steps?.length ?? 0
  const barrierCount = route.blockers?.length ?? 0
  const tbtMeta =
    `${stepCount} step${stepCount === 1 ? '' : 's'}` +
    (barrierCount > 0 ? ` · ${barrierCount} barrier${barrierCount === 1 ? '' : 's'}` : '')

  const body = (
    <>
      {/* An ok route's note says what its objective steered on, which for the
          tag-derived presets is the difference between a proxy and a
          measurement. It is not a rejection and must not be dressed as one,
          so the two cases share the slot and nothing else. */}
      {route.status_note && (
        <p className={route.status === 'ok' ? 'detail__basis-note' : 'detail__blocked-note'}>
          {route.status_note}
        </p>
      )}

      {route.narration && (
        <div className="detail__narration-block">
          <p className="detail__narration">{route.narration}</p>
          <p className="detail__credit mono">written only from the numbers on this card</p>
        </div>
      )}
    </>
  )

  if (mobile) {
    return (
      <div className="detail detail--sheet">
        <p className="detail__head">
          <span className={`dot dot--${route.id}`} aria-hidden="true" />
          <span className="detail__title detail__title--sheet">{title}</span>
        </p>
        <p className="detail__stats mono">{stats.join(' · ')}</p>

        <button
          type="button"
          className="button-sky detail__start"
          onClick={(event) => onStart(route.id, event.currentTarget)}
        >
          Start follow mode
        </button>

        {body}

        <ScoreBars scores={route.scores} scoringMethod={route.scoring_method} pending={Boolean(route.enrichment_pending)} />
        <CoverageCard route={route} />
        <ElevationProfile profile={route.elevation} units={units} />
        <RestPills restStops={route.rest_stops} units={units} pending={Boolean(route.enrichment_pending)} />

        <BestWindow bestDeparture={bestDeparture} reason={reason} units={units} />

        <details className="tbt">
          <summary className="tbt__summary">
            <span>Turn-by-turn</span>
            <span className="tbt__meta mono">{tbtMeta}</span>
            <ChevronRightIcon size={13} />
          </summary>
          <StepList route={route} units={units} onHighlight={onHighlight} />
        </details>

        <ExportPills route={route} origin={origin} dest={dest} units={units} onAnnounce={onAnnounce} />
      </div>
    )
  }

  return (
    <div className="detail-scrim">
      <div
        className="detail detail--modal"
        role="dialog"
        aria-modal="true"
        aria-label={`${route.label} route detail`}
        ref={surfaceRef}
      >
        <div className="detail__header">
          <span className={`dot dot--${route.id}`} aria-hidden="true" />
          <h2 className="detail__title">{title}</h2>
          <StatusChip route={route} isLoop={isLoop} />
          <button
            type="button"
            className="detail__close"
            aria-label="Close route detail"
            onClick={onClose}
            ref={closeRef}
          >
            <CloseIcon size={14} />
          </button>
        </div>

        <p className="detail__stats mono">{stats.join(' · ')}</p>

        {body}

        <div className="detail__columns">
          <div className="detail__col">
            <p className="microlabel">
              Turn-by-turn · {stepCount} step{stepCount === 1 ? '' : 's'}
            </p>
            <StepList route={route} units={units} onHighlight={onHighlight} />
          </div>
          <div className="detail__col">
            <ScoreBars scores={route.scores} scoringMethod={route.scoring_method} pending={Boolean(route.enrichment_pending)} />
            <CoverageCard route={route} />
            <ElevationProfile profile={route.elevation} units={units} />
            <RestPills restStops={route.rest_stops} units={units} pending={Boolean(route.enrichment_pending)} />
            <ExportPills
              route={route}
              origin={origin}
              dest={dest}
              units={units}
              onAnnounce={onAnnounce}
            />
          </div>
        </div>
      </div>
    </div>
  )
}
