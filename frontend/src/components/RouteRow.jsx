import { routeColor, styleFor, swatchBackground } from '../lib/dash.js'
import { durationParts, fmtDist, fmtPct, restStopSummary } from '../lib/format.js'
import { cacheChipText, cacheTier, formatCacheAge } from '../lib/offline.js'
import VerificationMeter from './VerificationMeter.jsx'

const SCORE_ROWS = [
  { key: 'nature', label: 'Green' },
  { key: 'air', label: 'Air' },
  { key: 'shade', label: 'Shade' },
]

/**
 * One comparison row. Implements §4.6.
 *
 * **The whole row is a single `<button>` containing only phrasing content.**
 * Not a `<div>` with a button inside it, and not a button wrapped around
 * paragraphs and lists. A `<button>` containing `<p>`, `<dl>` or `<ul>` is
 * invalid HTML, and screen readers flatten its contents into one long
 * unreadable label — which is exactly what the old RouteCard's comment
 * documented and worked around by making only its header row interactive.
 * Every element below is a `<span>`. If you add something here, it must be one
 * too.
 *
 * The accessible name is the visible content, not an `aria-label`. An
 * aria-label would give the tidy four-fact name §9 asks for and silently throw
 * away the three score percentages — the numbers the rail exists to let people
 * compare. Instead the visible text is written so that reading it aloud in
 * order produces a sensible sentence, with a few visually-hidden connectives
 * ("line on the map") where the terse visual form would not.
 *
 * Rows are **uniform height regardless of content**, which is the point of the
 * component: three routes only compare if their figures line up. Everything
 * that varies in length — narration, barrier lists, the full confidence
 * sentence — lives in the detail panel for the selected route.
 */
export default function RouteRow({ route, selected, theme, units, cacheAgeMs, onSelect }) {
  const style = styleFor(route.id)
  const blocked = route.status !== 'ok'
  const hasShape = route.geometry?.length > 1
  const colour = routeColor(route.id, theme)
  const duration = durationParts(route.duration_min)

  // A vertical version of the map's dash pattern, so the edge bar is
  // recognisably the same line the map draws.
  const edge =
    style.dash.length === 2 && style.dash[1] === 0
      ? colour
      : swatchBackground(route.id, theme).replace('90deg', '180deg')

  return (
    <li>
      <button
        type="button"
        className={`route${blocked ? ' route--blocked' : ''}`}
        aria-pressed={selected}
        onClick={() => onSelect(route.id)}
      >
        <span className="route__edge" aria-hidden="true" style={{ background: edge }} />

        <span className="route__body">
          <span className="route__top">
            <span className="route__name">{route.label}</span>
            {selected && <span className="badge badge--showing">Showing</span>}
            {blocked && (
              <span className="badge badge--blocked">
                {route.blockers?.length
                  ? `${route.blockers.length} barrier${route.blockers.length === 1 ? '' : 's'}`
                  : 'blocked'}
              </span>
            )}
            {route.servedFromCache && (
              <span className={`badge badge--cached badge--cached-${cacheTier(cacheAgeMs)}`}>
                <span className="visually-hidden">
                  Saved copy from {formatCacheAge(cacheAgeMs)}.{' '}
                </span>
                <span aria-hidden="true">{cacheChipText(cacheAgeMs)}</span>
              </span>
            )}
            <span className="route__dur tabular">
              {duration.value}
              <span className="route__dur-unit"> {duration.unit}</span>
            </span>
          </span>

          <span className="route__sub">
            <span
              className="route__pattern"
              aria-hidden="true"
              style={{ background: swatchBackground(route.id, theme) }}
            />
            {hasShape ? (
              <>
                {style.pattern}
                <span className="visually-hidden"> line on the map</span>
              </>
            ) : (
              'not drawn on the map'
            )}
            {' · '}
            {fmtDist(route.distance_m, units)}
            {' · '}
            {restStopSummary(route.rest_stops)}
            {blocked && ' · cannot be completed'}
          </span>

          <span className="route__scores">
            {SCORE_ROWS.map((row) => {
              // null is "we did not measure this", which is a different
              // statement from zero and must never render as an empty bar. A
              // real 0 gets a real, empty track; a null gets a hatched one.
              const value = route.scores?.[row.key]
              const measured = typeof value === 'number'
              return (
                <span className="metric" key={row.key}>
                  <span className="metric__head">
                    <span>{row.label}</span>
                    <span className={measured ? 'tabular' : 'metric__none'}>
                      {measured ? fmtPct(value) : 'not measured'}
                    </span>
                  </span>
                  <span
                    className={measured ? 'metric__track' : 'metric__track metric__track--hatched'}
                    aria-hidden="true"
                  >
                    {measured && (
                      <span
                        className="metric__fill"
                        style={{ width: `${Math.round(value * 100)}%` }}
                      />
                    )}
                  </span>
                </span>
              )
            })}
          </span>

          <VerificationMeter
            confidence={route.confidence}
            scoringMethod={route.scoring_method}
          />
        </span>
      </button>
    </li>
  )
}
