import { MODE_VERB } from '../lib/format.js'

const MIN = 20
const MAX = 360
const STEP = 5

/**
 * A native `<input type="range">`, deliberately.
 *
 * Arrow keys, Home, End, Page Up and Page Down all work for free and match what
 * a screen-reader user already expects. A custom radial control would have to
 * reimplement every one of those and would still not match the platform. The
 * one thing added on top is `aria-valuetext`, so the value is announced as
 * "35 minutes, walking" rather than as the bare number "35".
 */
export default function TimeDial({ minutes, mode, effectiveMode, onChange }) {
  const verb = MODE_VERB[effectiveMode] ?? effectiveMode
  const valueText = `${minutes} minutes, ${verb}`

  return (
    <div className="field">
      <label className="field__label" htmlFor="time-dial">
        How long have you got?
      </label>

      <p aria-hidden="true" style={{ margin: 0 }}>
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
        <span>20 min</span>
        <span>2 hr</span>
        <span>6 hr</span>
      </div>
    </div>
  )
}
