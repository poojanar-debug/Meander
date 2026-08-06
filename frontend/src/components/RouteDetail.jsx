import { useState } from 'react'

import { styleFor, swatchBackground } from '../lib/dash.js'
import {
  SCORING_METHOD_LABEL,
  confidenceSentence,
  fmtDist,
  fmtDur,
  fmtPct,
  restStopName,
} from '../lib/format.js'

const SCORE_ROWS = [
  { key: 'nature', label: 'Nature' },
  { key: 'air', label: 'Clean air' },
  { key: 'shade', label: 'Shade' },
]

/** §8: 20+ barriers would bury the panel, so the first eight show and the rest
 *  go behind a disclosure. Every one still gets a map marker. */
const BARRIERS_SHOWN = 8

function Barriers({ blockers }) {
  const [expanded, setExpanded] = useState(false)
  const shown = expanded ? blockers : blockers.slice(0, BARRIERS_SHOWN)
  const hidden = blockers.length - shown.length

  return (
    <>
      <ul className="blockers__list">
        {shown.map((b, i) => (
          <li key={`${b.type}-${b.lat}-${b.lon}-${i}`}>
            <strong>{b.type}:</strong> {b.description}
          </li>
        ))}
      </ul>
      {hidden > 0 && (
        <button type="button" className="link-button" onClick={() => setExpanded(true)}>
          and {hidden} more
        </button>
      )}
    </>
  )
}

/**
 * Everything about the selected route, and only the selected route.
 * Implements §4.8.
 *
 * The split with RouteRow is the whole redesign in one idea: the rail carries
 * what compares (uniform, aligned, four facts), the detail carries what
 * explains (variable length, prose, barrier lists). Putting both in every card
 * is what made the old build read as a data dump.
 *
 * The blocked notice is placed **above** Along the way rather than at the end,
 * because it changes whether any of the rest matters.
 */
export default function RouteDetail({ route, theme, stepList, onStart, children }) {
  if (!route) return null

  const style = styleFor(route.id)
  const blocked = route.status !== 'ok'
  const confidence = confidenceSentence(
    route.confidence,
    route.scoring_method,
    route.confidence_note,
  )

  return (
    <article className="detail" aria-labelledby="detail-title">
      <header className="detail__head">
        <span
          className="detail__pattern"
          aria-hidden="true"
          style={{ background: swatchBackground(route.id, theme) }}
        />
        <h3 className="detail__title" id="detail-title">
          {route.label}
        </h3>
        <p className="detail__figures tabular">
          {fmtDur(route.duration_min)} · {fmtDist(route.distance_m)}
        </p>
      </header>

      {/* The one piece of prose a human wrote for a human. It gets the serif
          and the breathing room (§2.5). */}
      {route.narration ? (
        <p className="detail__narration">{route.narration}</p>
      ) : (
        <p className="detail__narration detail__narration--pending">
          Description still being written…
        </p>
      )}

      {blocked && (
        <div className="note note--warn" role="alert">
          <p className="note__title">
            {route.status_note ?? 'This route cannot be completed.'}
          </p>
          {route.blockers?.length > 0 && <Barriers blockers={route.blockers} />}
        </div>
      )}

      <section className="detail__section">
        <h4 className="detail__h">Along the way</h4>
        {route.rest_stops == null ? (
          <p className="field__hint">
            Rest stops could not be checked for this route — that is not the same as there being
            none.
          </p>
        ) : route.rest_stops.length === 0 ? (
          <p className="field__hint">No rest stops found along this route.</p>
        ) : (
          <ul className="stops">
            {route.rest_stops.map((stop, i) => (
              <li className="stop" key={`${stop.type}-${stop.lat}-${stop.lon}-${i}`}>
                <span aria-hidden="true">◦</span>
                {restStopName(stop.type, 1)} · {fmtDist(stop.at_m)}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="detail__section">
        <h4 className="detail__h">Directions</h4>
        {stepList}
      </section>

      <section className="detail__section">
        <h4 className="detail__h">What this route scores</h4>
        <dl className="scores">
          {SCORE_ROWS.map((row) => {
            const value = route.scores?.[row.key]
            const measured = typeof value === 'number'
            return (
              <div className="scores__row" key={row.key}>
                <dt>{row.label}</dt>
                {measured ? (
                  <>
                    <dd className="scores__track" aria-hidden="true">
                      <span
                        className="scores__fill"
                        style={{ width: `${Math.round(value * 100)}%` }}
                      />
                    </dd>
                    <dd className="scores__value tabular">{fmtPct(value)}</dd>
                  </>
                ) : (
                  // Spans the bar and the number: "not measured" is a sentence,
                  // not a value, and must never look like an empty bar.
                  <dd className="scores__unmeasured">not measured</dd>
                )}
              </div>
            )
          })}
        </dl>
      </section>

      {/* The server's sentence, verbatim. The four-segment meter in the rail is
          a summary of this; it is not a substitute for it, and where the backend
          supplies confidence_note that text wins. */}
      <div className={confidence.severity === 'warning' ? 'note note--warn' : 'note'}>
        <p className="note__title">{confidence.text}</p>
        <p className="note__sub">
          {SCORING_METHOD_LABEL[route.scoring_method] ?? route.scoring_method}
          {route.synthetic_upstream &&
            ' · Built from demonstration data, not a live routing response. Do not follow it.'}
        </p>
      </div>

      {/* Phase-specific extras — the step list and the daylight guard — are
          injected by App rather than imported here, so this component stays
          about layout and the phases stay separable. */}
      {children}

      {/* No Share or Save. Save is §6.8, which is deferred; Share has no
          specification and the app holds no state in the URL, so a share link
          would point at the front door and say nothing about the route. A
          control that does nothing reads as broken rather than as unbuilt. */}
      {onStart && route.steps?.length > 0 && (
        <div className="detail__actions">
          <button
            type="button"
            className="button button--primary"
            disabled={blocked}
            aria-describedby={blocked ? 'start-blocked' : undefined}
            onClick={() => onStart(route.id)}
          >
            Start this route
          </button>
          {blocked && (
            <p className="field__hint" id="start-blocked">
              This route cannot be completed, so it cannot be followed.
            </p>
          )}
        </div>
      )}

      <p className="detail__pattern-note">
        Drawn as a {style.pattern} line{route.geometry?.length > 1 ? '' : ' — no geometry available'}.
      </p>
    </article>
  )
}
