import { useId, useState } from 'react'

import { departureHasPassed } from '../lib/offline.js'
import { useNow } from '../lib/offlineStore.js'
import { canStateLocalTime, fmtClock, isDaylight } from '../lib/sun.js'
import { lowerClock } from '../lib/units.js'
import { CaretDownIcon } from './Icons.jsx'

/** The hour-chip row caps at six. */
const CHIP_COUNT = 6

/**
 * When to go — two surfaces over one wire field.
 *
 * The default export is the plan screen's `Leaving now` disclosure: a row
 * with a caret that opens the hour chips. `BestWindow` is the detail's
 * departure row — amber dot, `Best window today 17:30`, and the server's
 * reason sentence verbatim after it.
 *
 * **If there is no recommendation, BestWindow does not render at all.** Not a
 * greyed-out row, not a placeholder time. An invented "best time to leave" is
 * worse than none, and the backend already returns null rather than guessing
 * when it has nothing to measure. A recommendation whose moment has passed is
 * withdrawn the same way: choosing a new one needs the air and cloud series
 * for the hours ahead, which a stale response no longer has.
 */
export default function DepartureStrip({ origin, departAt, units, onDepartAt }) {
  const id = useId()
  const [open, setOpen] = useState(false)
  // First statement, before anything conditional — and what keeps the chips
  // self-updating: they are built from `new Date()`, re-evaluated per tick.
  useNow()

  const chosen = departAt ? new Date(departAt) : null

  // Whole hours from the top of the current hour.
  const firstHour = new Date()
  firstHour.setMinutes(0, 0, 0)
  const hours = Array.from({ length: CHIP_COUNT }, (_, i) => {
    const at = new Date(firstHour)
    at.setHours(firstHour.getHours() + i)
    return at
  })

  const sameHour = (a, b) => a && b && a.getHours() === b.getHours() && a.getDate() === b.getDate()
  const localClock = origin ? canStateLocalTime(origin.lon) : false

  return (
    <div className="departure">
      <button
        type="button"
        className="departure__row"
        aria-expanded={open}
        aria-controls={`${id}-editor`}
        onClick={() => setOpen((was) => !was)}
      >
        <span className="departure__label">
          {chosen ? `Leaving at ${lowerClock(fmtClock(chosen, units))}` : 'Leaving now'}
        </span>
        <CaretDownIcon size={12} />
      </button>

      {open && (
        <div
          className="departure__hours"
          id={`${id}-editor`}
          role="group"
          aria-label="Choose a departure hour"
        >
          <button
            type="button"
            className="departure__hour"
            aria-pressed={!chosen}
            onClick={() => onDepartAt(null)}
          >
            Now
          </button>
          {hours.map((hour) => {
            const pressed = sameHour(hour, chosen)
            // Out-of-daylight hours get a moon as well as the dimmer ink, so
            // daylight is never a colour-only signal.
            const dark = localClock && origin ? !isDaylight(hour, origin.lat, origin.lon) : false
            return (
              <button
                key={hour.toISOString()}
                type="button"
                className={dark ? 'departure__hour departure__hour--dark' : 'departure__hour'}
                aria-pressed={pressed}
                onClick={() => onDepartAt(hour.toISOString())}
              >
                {dark && (
                  <span className="departure__moon" aria-hidden="true">
                    ☾
                  </span>
                )}
                <span className="mono">{lowerClock(fmtClock(hour, units))}</span>
                {dark && <span className="visually-hidden">, after dark</span>}
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}

/**
 * "Best window today 17:30 — {the server's reason, verbatim}."
 *
 * With no reason from the backend, the time stands alone; the clause is not
 * ours to invent. Returns null — nothing, not a placeholder — when there is
 * no live recommendation.
 */
export function BestWindow({ bestDeparture, reason, units }) {
  const nowMs = useNow()
  const recommended = bestDeparture ? new Date(bestDeparture) : null
  if (!recommended || Number.isNaN(recommended.valueOf())) return null
  if (departureHasPassed(recommended, nowMs)) return null

  return (
    <p className="bestwindow">
      <span className="dot dot--amber" aria-hidden="true" />
      <span>
        <strong>Best window today {lowerClock(fmtClock(recommended, units))}</strong>
        {reason ? <span className="bestwindow__reason"> — {reason}</span> : null}
      </span>
    </p>
  )
}

/** The stats-line fragment for the desktop modal: "best window today 17:30",
 *  or null when there is nothing honest to say. */
export function bestWindowStat(bestDeparture, units, nowMs = Date.now()) {
  const recommended = bestDeparture ? new Date(bestDeparture) : null
  if (!recommended || Number.isNaN(recommended.valueOf())) return null
  if (departureHasPassed(recommended, nowMs)) return null
  const clock = lowerClock(fmtClock(recommended, units))
  return clock ? `best window today ${clock}` : null
}
