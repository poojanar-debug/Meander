import { formatTime } from '../lib/units.js'

/**
 * "Better later" — the departure suggestion, with the thing it explains.
 *
 * `state.reason` used to render as an unlabelled paragraph while
 * `state.bestDeparture` — the *what* that the reason is the *because* of — was
 * held in state and never rendered anywhere at all. So the user got a
 * justification for a recommendation they were never shown.
 *
 * Two different sentences arrive on `reason` and they are not
 * interchangeable: a departure rationale from the enrichment pass, and a
 * warning that every route overran the time budget. The second has no
 * departure attached, so it renders on its own.
 */
export default function BetterLater({ when, reason }) {
  if (!when && !reason) return null

  if (!when) {
    return <p className="better-later better-later--bare">{reason}</p>
  }

  const at = new Date(when)
  const valid = !Number.isNaN(at.getTime())

  return (
    <aside className="better-later" aria-label="Departure suggestion">
      <p className="better-later__head">
        Better if you leave at{' '}
        <strong>
          <time dateTime={valid ? at.toISOString() : undefined}>
            {valid ? formatTime(at) : 'a later time'}
          </time>
        </strong>
      </p>
      {reason && <p className="better-later__why">{reason}</p>}
    </aside>
  )
}
