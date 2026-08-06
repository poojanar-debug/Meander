import { MODE_VERB } from '../lib/format.js'

const MIN = 20
const MAX = 360
const STEP = 5

/** §4.4. A preset sets the slider value and fires the same `minutes` action, so
 *  it debounces identically — there is no separate code path to keep in step. */
export const PRESETS = [
  { minutes: 20, label: '20 min' },
  { minutes: 35, label: '35 min' },
  { minutes: 60, label: '1 hr' },
  { minutes: 120, label: '2 hr' },
]

/**
 * A native `<input type="range">`, deliberately.
 *
 * Arrow keys, Home, End, Page Up and Page Down all work for free and match what
 * a screen-reader user already expects. A custom radial control would have to
 * reimplement every one of those and would still not match the platform. The
 * one thing added on top is `aria-valuetext`, so the value is announced as
 * "35 minutes, walking" rather than as the bare number "35".
 *
 * The handoff is explicit that this must not become a custom radial control,
 * and this is why.
 */
export default function TimeDial({ minutes, mode, effectiveMode, onChange }) {
  const verb = MODE_VERB[effectiveMode] ?? effectiveMode
  const valueText = `${minutes} minutes, ${verb}`

  return (
    <div className="field">
      <label className="field__label" htmlFor="time-dial">
        How long have you got?
      </label>

      <p className="dial__readout" aria-hidden="true">
        <span className="dial__value tabular">{minutes}</span>
        <span className="dial__unit">minutes · {verb}</span>
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

      <div className="presets">
        {PRESETS.map((preset) => (
          <button
            key={preset.minutes}
            type="button"
            className="preset"
            aria-pressed={minutes === preset.minutes}
            onClick={() => onChange(preset.minutes)}
          >
            {preset.label}
            {minutes === preset.minutes && (
              <span className="chip__check" aria-hidden="true">
                ✓
              </span>
            )}
          </button>
        ))}
      </div>
    </div>
  )
}
