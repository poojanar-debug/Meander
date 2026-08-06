import { routeColor, styleFor } from '../lib/dash.js'
import {
  SCORING_METHOD_LABEL,
  confidenceSentence,
  fmtDist,
  fmtDur,
  fmtPct,
  restStopSentence,
} from '../lib/format.js'

const SCORE_ROWS = [
  { key: 'nature', label: 'Nature', color: 'var(--score-nature)' },
  { key: 'air', label: 'Clean air', color: 'var(--score-air)' },
  { key: 'shade', label: 'Shade', color: 'var(--score-shade)' },
]

const MODE_NOUN = { foot: 'on foot', bike: 'by bike', car: 'by car' }

/**
 * The card is the full text equivalent of what the map draws. Everything the
 * map conveys — which route, how long, how far, how green, how well verified,
 * where the barriers are — is here in words. The app is usable with the map
 * hidden entirely.
 *
 * The selector is a single button holding only phrasing content, rather than a
 * button wrapped around the whole card. A `<button>` containing `<p>`, `<dl>`
 * and `<ul>` is invalid HTML, and screen readers flatten its contents into one
 * unreadable label. Clicking anywhere on the card still works for pointer
 * users; the button is what makes it operable from the keyboard.
 */
export default function RouteCard({ route, selected, theme, onSelect }) {
  const style = styleFor(route.id)
  const blocked = route.status !== 'ok'
  const hasShape = route.geometry?.length > 1
  const confidence = confidenceSentence(
    route.confidence,
    route.scoring_method,
    route.confidence_note,
  )
  const select = () => onSelect(route.id)

  return (
    <li className={`card${selected ? ' card--selected' : ''}`} onClick={select}>
      <span className="card__bar" aria-hidden="true" style={{ background: routeColor(route.id, theme) }} />

      <h3 className="card__head">
        <button
          type="button"
          className="card__select"
          aria-pressed={selected}
          onClick={(event) => {
            event.stopPropagation()
            select()
          }}
        >
          <span className="card__label">{route.label}</span>
          <span className="card__pattern">
            {hasShape ? `${style.pattern} line on the map` : 'not drawn on the map'}
            {blocked && ' · blocked'}
          </span>
        </button>
      </h3>

      {blocked && !hasShape ? (
        <p className="card__status">{route.status_note ?? 'No route of this kind exists.'}</p>
      ) : (
        <>
          <p className="card__figures">
            <span className="card__duration">{fmtDur(route.duration_min)}</span>
            <span className="card__distance">
              {fmtDist(route.distance_m)} · {MODE_NOUN[route.mode] ?? route.mode}
            </span>
          </p>

          <dl className="scores">
            {SCORE_ROWS.map((row) => {
              // null is "we did not measure this", which is a different
              // statement from zero. It never renders as an empty bar.
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
                          style={{ width: `${Math.round(value * 100)}%`, background: row.color }}
                        />
                      </dd>
                      <dd className="scores__value tabular">{fmtPct(value)}</dd>
                    </>
                  ) : (
                    <dd className="scores__unmeasured">not measured</dd>
                  )}
                </div>
              )
            })}
          </dl>
        </>
      )}

      <p className="card__method">
        {SCORING_METHOD_LABEL[route.scoring_method] ?? route.scoring_method}
      </p>

      {route.synthetic_upstream && (
        <p className="card__synthetic">
          Built from demonstration data, not a live routing response. Do not follow it.
        </p>
      )}

      <p
        className={
          confidence.severity === 'ok'
            ? 'card__confidence'
            : `card__confidence card__confidence--${confidence.severity}`
        }
      >
        {confidence.text}
      </p>

      {blocked && hasShape && route.status_note && (
        <p className="card__status">{route.status_note}</p>
      )}

      {route.blockers?.length > 0 && (
        <div className="blockers">
          <p className="blockers__title">
            {route.blockers.length} barrier{route.blockers.length === 1 ? '' : 's'} on this route
          </p>
          <ul className="blockers__list">
            {route.blockers.map((b, i) => (
              <li key={`${b.type}-${b.lat}-${b.lon}-${i}`}>
                <strong>{b.type}:</strong> {b.description}
              </li>
            ))}
          </ul>
        </div>
      )}

      {!blocked && <p className="card__rest">{restStopSentence(route.rest_stops)}</p>}

      {route.narration ? (
        <p className="card__narration">{route.narration}</p>
      ) : (
        <p className="card__narration card__narration--pending">
          Description still being written…
        </p>
      )}
    </li>
  )
}
