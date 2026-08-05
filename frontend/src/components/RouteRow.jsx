import { routeColor, styleFor } from '../lib/dash.js'
import { fmtDur, trustTier } from '../lib/format.js'

const TRUST_WORD = {
  quiet: 'well checked',
  amber: 'partly checked',
  loud: 'barely checked',
}

/**
 * One route, compact enough that three of them fit in the sheet's peek snap.
 *
 * This is what a user sees the instant results arrive, with no scrolling at
 * all. Label, duration, and one trust indicator — no more, because a fourth
 * thing is what pushes the third route off the screen.
 *
 * The trust indicator is a word rather than a percentage. At this size a number
 * invites comparison between routes, which is not the question; "barely
 * checked" is the answer to the question actually being asked.
 */
export default function RouteRow({ route, selected, onSelect }) {
  const blocked = route.status !== 'ok'
  const tier = trustTier(route)
  const style = styleFor(route.id)

  return (
    <li className="row">
      <button
        type="button"
        className={`row__button${selected ? ' row__button--selected' : ''}`}
        aria-pressed={selected}
        onClick={() => onSelect(route.id)}
      >
        <span
          className="row__swatch"
          aria-hidden="true"
          style={{ background: routeColor(route.id) }}
        />
        <span className="row__label">{route.label}</span>
        <span className="visually-hidden">, {style.pattern} line. </span>

        {blocked ? (
          <span className="row__blocked">Can’t complete</span>
        ) : (
          <>
            <span className="row__duration tabular">{fmtDur(route.duration_min)}</span>
            <span className={`row__trust row__trust--${tier}`}>{TRUST_WORD[tier]}</span>
          </>
        )}
      </button>
    </li>
  )
}
