import { routeColor, styleFor } from '../lib/dash.js'
import { fmtDur, trustTier } from '../lib/format.js'
import { cacheChipText, cacheTier, formatCacheAge } from '../lib/offline.js'

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
export default function RouteRow({ route, selected, onSelect, cacheAgeMs }) {
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
        <span className="row__name">
          <span className="row__label">{route.label}</span>
          {/* A saved route says so on the row itself, not only in the bar above
              the list. At peek this row is the entire route — there is nothing
              else to tap through to — so the qualifier has to travel with it.
              It takes a second line, and the sheet's peek height grows to
              match; three routes still fit without scrolling, which the PWA
              gate measures. */}
          {/* Tiered like everything else that qualifies a route: present in
              every case, coloured only once the age is worth colouring. A copy
              from thirty seconds ago in warning orange trains the eye to skip
              the same mark when it is two days old. */}
          {route.servedFromCache && (
            <span className={`row__cached row__cached--${cacheTier(cacheAgeMs)}`}>
              <span className="visually-hidden">Saved copy from {formatCacheAge(cacheAgeMs)}. </span>
              <span aria-hidden="true">{cacheChipText(cacheAgeMs)}</span>
            </span>
          )}
        </span>
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
