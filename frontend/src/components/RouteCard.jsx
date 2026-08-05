import { useId, useState } from 'react'

import { routeColor, styleFor } from '../lib/dash.js'
import {
  SCORE_META,
  SCORING_METHOD_LABEL,
  blockerTypeName,
  fmtDist,
  fmtDur,
  fmtPct,
  restStopSentence,
} from '../lib/format.js'
import TakeItWithYou from './TakeItWithYou.jsx'
import TrustSignal from './TrustSignal.jsx'

const MODE_NOUN = { foot: 'on foot', bike: 'by bike', car: 'by car' }

const WHY = {
  fastest: 'The most direct way there.',
  nature: 'Steered towards parks, water and quiet ways.',
  accessible: 'Avoids steps and surfaces recorded as impassable.',
  quiet: 'Steered away from traffic noise.',
  shade: 'Steered towards shade at your departure time.',
  air: 'Steered away from the worst air.',
}

/**
 * A usable route, in three tiers.
 *
 *   1  the answer            name, duration, distance, why this route
 *   2  the trust signal      always visible, volume scaled to how bad it is
 *   3  everything else       one expander, not five
 *
 * There used to be eighteen distinct elements here, five of them unconditional
 * methodology, all at 12–13 px and ungrouped, so the sentence that matters most
 * looked exactly like the sentence about line styles.
 *
 * A route the accessibility engine rejects is **not a variant of this** — see
 * BlockedRouteCard. It has geometry, so it used to keep its big duration and
 * full score bars while the word "blocked" appeared in 12 px grey at the end of
 * a sentence about dash patterns, which made the route a user most needs to
 * understand look like an equal peer of two usable ones.
 *
 * The selector is a single button holding only phrasing content, rather than a
 * button wrapped around the whole card: a `<button>` containing `<p>`, `<dl>`
 * and `<ul>` is invalid HTML and screen readers flatten it into one unreadable
 * label.
 */
export default function RouteCard({ route, selected, onSelect, origin, dest }) {
  const style = styleFor(route.id)
  const detailsId = useId()
  const [open, setOpen] = useState(false)

  return (
    /* No onClick on the <li>. It used to select the route, which meant that
       trying to read — or select the text of — a barrier description toggled
       the selection and re-animated the map under you. The header button and
       the map line are the two ways to select. */
    <li className={`card${selected ? ' card--selected' : ''}`}>
      <span
        className="card__bar"
        aria-hidden="true"
        style={{ background: routeColor(route.id) }}
      />

      {/* ---- tier 1: the answer ---- */}
      <h3 className="card__head">
        <button
          type="button"
          className="card__select"
          aria-pressed={selected}
          onClick={() => onSelect(route.id)}
        >
          <span
            className="card__swatch"
            aria-hidden="true"
            style={{ background: routeColor(route.id) }}
          />
          <span className="card__label">{route.label}</span>
          {/* The dash pattern was prose — "solid line on the map". It is a
              swatch now, with the pattern name kept as text for anyone who
              cannot use the colour. */}
          <span className="visually-hidden">, drawn as a {style.pattern} line on the map</span>
        </button>
      </h3>

      <p className="card__figures">
        <span className="card__duration">{fmtDur(route.duration_min)}</span>
        <span className="card__distance">
          {fmtDist(route.distance_m)} · {MODE_NOUN[route.mode] ?? route.mode}
        </span>
      </p>

      {WHY[route.id] && <p className="card__why">{WHY[route.id]}</p>}

      {/* ---- tier 2: the trust signal ---- */}
      <TrustSignal route={route} />

      {/* ---- tier 3: everything else, one expander ---- */}
      <button
        type="button"
        className="card__more"
        aria-expanded={open}
        aria-controls={detailsId}
        onClick={() => setOpen((v) => !v)}
      >
        {open ? 'Hide the detail' : 'Scores, rest stops and how this was worked out'}
      </button>

      <div id={detailsId} className="card__detail" hidden={!open}>
        <dl className="scores">
          {['nature', 'air', 'shade'].map((key) => {
            const meta = SCORE_META[key]
            // null is "we did not measure this", which is a different
            // statement from zero. It never renders as an empty bar.
            const value = route.scores?.[key]
            const measured = typeof value === 'number'
            // enrichment_pending means the first of two passes: air and shade
            // have not been fetched yet, so "not measured" would be wrong.
            const pending = route.enrichment_pending && key !== 'nature'
            return (
              <div className="scores__row" key={key}>
                <dt>{meta.label}</dt>
                {measured ? (
                  <>
                    <dd className="scores__track" aria-hidden="true">
                      <span
                        className="scores__fill"
                        style={{
                          width: `${Math.round(value * 100)}%`,
                          background: `var(--score-${key})`,
                        }}
                      />
                    </dd>
                    <dd className="scores__value tabular">{fmtPct(value)}</dd>
                  </>
                ) : (
                  <dd className="scores__unmeasured">
                    {pending ? 'still checking…' : 'not measured'}
                  </dd>
                )}
                {/* What the number is a percentage *of*. Three bare
                    percentages invite the reader to supply their own meaning,
                    and the one they supply is usually wrong. */}
                <dd className="scores__explain">{meta.explanation}</dd>
              </div>
            )
          })}
        </dl>

        <p className="card__method">
          {SCORING_METHOD_LABEL[route.scoring_method] ?? route.scoring_method}
        </p>

        {route.blockers?.length > 0 && <Blockers blockers={route.blockers} />}

        <p className="card__rest">
          {route.enrichment_pending
            ? 'Still looking for benches, water and shelter along this route…'
            : restStopSentence(route.rest_stops)}
        </p>

        {route.narration ? (
          <p className="card__narration">{route.narration}</p>
        ) : (
          <p className="card__narration card__narration--pending">
            Description still being written…
          </p>
        )}

        <TakeItWithYou route={route} origin={origin} dest={dest} />
      </div>
    </li>
  )
}

export function Blockers({ blockers, prominent = false }) {
  return (
    <div className={`blockers${prominent ? ' blockers--prominent' : ''}`}>
      <p className="blockers__title">
        {blockers.length} barrier{blockers.length === 1 ? '' : 's'} on this route
      </p>
      <ul className="blockers__list">
        {blockers.map((b, i) => (
          <li key={`${b.type}-${b.lat}-${b.lon}-${i}`}>
            {/* Was `{b.type}` — a raw OSM tag key, so this read
                "surface: Surface recorded as sett, which is not passable." */}
            <strong>{blockerTypeName(b.type)}:</strong> {b.description}
          </li>
        ))}
      </ul>
    </div>
  )
}
