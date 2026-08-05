import { MODE_VERB } from '../lib/format.js'

const MIN = 20
const MAX = 360
const STEP = 5

/** The budgets people actually ask for, one tap each. */
const PRESETS = [30, 45, 60, 90]

/**
 * Ticks positioned where their value actually is.
 *
 * They used to be three spans in a `justify-content: space-between` row over a
 * linear 20–360 range, so "2 hr" sat at the visual midpoint when 120 minutes is
 * at 29% of the track. Someone dragging to the middle of the slider expecting
 * two hours landed near 190 minutes — which silently crosses the bike→car
 * threshold at 120, so the answer changed mode as well as length.
 */
const TICKS = [
  { at: 20, label: '20 min' },
  { at: 60, label: '1 hr' },
  { at: 120, label: '2 hr' },
  { at: 240, label: '4 hr' },
  { at: 360, label: '6 hr' },
]

const pct = (value) => ((value - MIN) / (MAX - MIN)) * 100

/**
 * A native `<input type="range">`, deliberately.
 *
 * Arrow keys, Home, End, Page Up and Page Down all work for free and match what
 * a screen-reader user already expects. A custom radial control would have to
 * reimplement every one of those and would still not match the platform. The
 * one thing added on top is `aria-valuetext`, so the value is announced as
 * "35 minutes, walking" rather than as the bare number "35".
 *
 * The slider alone is not enough on a phone, though: at 390 px the whole 20–360
 * range is about 4.8 px per step, so a precise value is unreachable by thumb.
 * The presets and the number input are the way to actually land on one.
 */
export default function TimeDial({ minutes, mode, effectiveMode, onChange }) {
  const verb = MODE_VERB[effectiveMode] ?? effectiveMode
  const valueText = `${minutes} minutes, ${verb}`

  const clamp = (value) => Math.min(MAX, Math.max(MIN, value))

  return (
    <div className="field dial">
      <label className="field__label" htmlFor="time-dial">
        How long have you got?
      </label>

      <p aria-hidden="true" className="dial__readout">
        <span className="dial__value">{minutes}</span>
        <span className="dial__unit">minutes</span>
      </p>
      <p className="dial__mode" id="time-dial-hint">
        {mode === 'auto' ? (
          <>
            {verb.charAt(0).toUpperCase() + verb.slice(1)} — chosen automatically from your time
            budget.
          </>
        ) : (
          <>{verb.charAt(0).toUpperCase() + verb.slice(1)} — chosen by you.</>
        )}
      </p>

      <input
        id="time-dial"
        type="range"
        min={MIN}
        max={MAX}
        step={STEP}
        value={minutes}
        aria-valuetext={valueText}
        aria-describedby="time-dial-hint"
        onChange={(e) => onChange(Number(e.target.value))}
      />

      <div className="dial__ticks" aria-hidden="true">
        {TICKS.map((tick) => (
          <span key={tick.at} className="dial__tick" style={{ left: `${pct(tick.at)}%` }}>
            {tick.label}
          </span>
        ))}
      </div>

      <div className="dial__presets" role="group" aria-label="Common time budgets">
        {PRESETS.map((value) => (
          <button
            key={value}
            type="button"
            className="chip chip--preset"
            aria-pressed={minutes === value}
            onClick={() => onChange(value)}
          >
            {value} min
          </button>
        ))}
        <label className="dial__exact">
          <span className="visually-hidden">Exact number of minutes</span>
          <input
            type="number"
            className="dial__exact-input"
            min={MIN}
            max={MAX}
            step={STEP}
            value={minutes}
            onChange={(e) => {
              const next = Number(e.target.value)
              if (Number.isFinite(next)) onChange(clamp(next))
            }}
          />
        </label>
      </div>
    </div>
  )
}
