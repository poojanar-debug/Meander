import { canStateLocalTime, daylightSentence, fmtClock, isDaylight, sunTimes } from '../lib/sun.js'

/** §6.2 caps the row at six. */
const CHIP_COUNT = 6

/**
 * When to go. Implements §6.2 and §6.3's display.
 *
 * The backend has always returned `best_departure` and the UI has always
 * ignored it. It is the answer to a question people actually ask — not "which
 * way" but "should I go now" — and it was sitting in the payload unused.
 *
 * **If there is no recommendation, the strip does not render at all.** Not a
 * greyed-out row, not a placeholder time. An invented "best time to leave" is
 * worse than none, and the backend already returns null rather than guessing
 * when it has nothing to measure — throwing that restraint away in the client
 * would defeat it.
 */
export default function DepartureStrip({ bestDeparture, reason, origin, departAt, onDepartAt }) {
  const recommended = bestDeparture ? new Date(bestDeparture) : null
  if (!recommended || Number.isNaN(recommended.valueOf())) return null

  // Sun times are absolute instants and correct anywhere; printing them as
  // clock times is only honest when the viewer's timezone and the route's
  // longitude agree. When they do not, the whole daylight layer goes quiet —
  // sentence and moon glyphs together — rather than showing half of a signal.
  const localClock = origin ? canStateLocalTime(origin.lon) : false
  const times = localClock && origin ? sunTimes(recommended, origin.lat, origin.lon) : null
  const daylight = daylightSentence(times)

  // Whole hours from the current hour. The recommendation is rarely on the
  // hour, so its own chip is included where it falls.
  const now = new Date()
  const firstHour = new Date(now)
  firstHour.setMinutes(0, 0, 0)
  const hours = Array.from({ length: CHIP_COUNT }, (_, i) => {
    const at = new Date(firstHour)
    at.setHours(firstHour.getHours() + i)
    return at
  })

  const selected = departAt ? new Date(departAt) : recommended
  const sameHour = (a, b) => a.getHours() === b.getHours() && a.getDate() === b.getDate()

  return (
    <section className="departure" aria-labelledby="departure-head">
      <p className="departure__head" id="departure-head">
        Leave at <strong>{fmtClock(recommended)}</strong>
        {/* §6.2: with no reason from the backend, the time and the word "best"
            and nothing more. The reason clause is not ours to invent. */}
        {reason ? ` — ${reason}` : ' — the best time in the next few hours.'}
      </p>

      {daylight && <p className="departure__daylight">{daylight}</p>}

      <div className="departure__hours" role="group" aria-label="Choose a departure hour">
        {hours.map((hour) => {
          const pressed = sameHour(hour, selected)
          // Out-of-daylight hours get a moon as well as the darker tint. The
          // tint alone would make daylight a colour-only signal, which §0.2
          // forbids outright.
          const dark = localClock && origin ? !isDaylight(hour, origin.lat, origin.lon) : false
          return (
            <button
              key={hour.toISOString()}
              type="button"
              className={dark ? 'hour hour--dark' : 'hour'}
              aria-pressed={pressed}
              onClick={() => onDepartAt(hour.toISOString())}
            >
              {dark && (
                <span className="hour__moon" aria-hidden="true">
                  ☾
                </span>
              )}
              {fmtClock(hour)}
              {dark && <span className="visually-hidden"> — after dark</span>}
            </button>
          )
        })}
      </div>
    </section>
  )
}
