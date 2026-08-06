import { departureHasPassed } from '../lib/offline.js'
import { useNow } from '../lib/offlineStore.js'
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
 *
 * **A departure time that has gone by is withdrawn, not shown.** `best_departure`
 * is an absolute instant computed when the request was made, and this component
 * had no notion that it could expire — so a tab left open past it, or a route
 * replayed from the offline cache hours later, would keep advising "better if
 * you leave at 19:15" at ten in the evening. The clock ticks here (`useNow`)
 * rather than being read once at render, because the ordinary way to hit this is
 * a phone left on a table, where nothing re-renders on its own.
 *
 * It is withdrawn rather than recomputed: choosing a new time needs the
 * air-quality and cloud-cover series for the hours ahead, which is exactly what
 * an expired or cached response no longer has.
 */
export default function BetterLater({ when, reason }) {
  const now = useNow()

  if (!when && !reason) return null

  if (!when) {
    return <p className="better-later better-later--bare">{reason}</p>
  }

  if (departureHasPassed(when, now)) {
    return (
      <p className="better-later better-later--expired">
        Meander suggested a better time to set off, but it has already passed.
      </p>
    )
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
