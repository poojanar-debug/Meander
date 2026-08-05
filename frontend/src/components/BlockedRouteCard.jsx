import { routeColor } from '../lib/dash.js'
import { Blockers } from './RouteCard.jsx'

/**
 * A route that cannot be completed. **A different component, not a variant.**
 *
 * An accessibility-blocked route has geometry, so it used to render as an
 * ordinary card: a large duration, full score bars, and the word "blocked" in
 * 12 px grey at the end of a sentence about line styles. That made the one
 * route a user most needs to understand look like an equal peer of two usable
 * ones — and for the person this app exists for, it is the opposite of that.
 *
 * So the hierarchy is inverted. The headline is what happened. Duration and
 * distance are suppressed entirely, because "40.8 minutes" is not true of a
 * route you cannot take, and neither are the score bars. The barriers are
 * promoted from a footnote to the content.
 *
 * Two different reasons land here and they say different things: a preset that
 * could not be routed at all (no geometry), and one that was routed and then
 * rejected by the hard constraints (geometry, and blockers to show).
 */
export default function BlockedRouteCard({ route, selected, onSelect }) {
  const hasShape = route.geometry?.length > 1

  return (
    <li className={`card card--blocked${selected ? ' card--selected' : ''}`}>
      <span
        className="card__bar"
        aria-hidden="true"
        style={{ background: routeColor(route.id) }}
      />

      <h3 className="card__head">
        {hasShape ? (
          <button
            type="button"
            className="card__select"
            aria-pressed={selected}
            onClick={() => onSelect(route.id)}
          >
            <span className="card__blocked-mark" aria-hidden="true">
              !
            </span>
            <span className="card__label">Can’t complete this route</span>
            <span className="visually-hidden">
              , the {route.label.toLowerCase()} route. Show it on the map.
            </span>
          </button>
        ) : (
          /* Nothing to select: there is no line to show. A button that
             selects nothing is worse than no button. */
          <span className="card__select card__select--inert">
            <span className="card__blocked-mark" aria-hidden="true">
              !
            </span>
            <span className="card__label">No {route.label.toLowerCase()} route</span>
          </span>
        )}
      </h3>

      <p className="card__blocked-why">
        {route.status_note ?? 'No route of this kind exists from here.'}
      </p>

      {route.blockers?.length > 0 && <Blockers blockers={route.blockers} prominent />}

      {hasShape && (
        <p className="card__blocked-hint">
          It is still drawn on the map, so you can see where the problem is.
        </p>
      )}
    </li>
  )
}
