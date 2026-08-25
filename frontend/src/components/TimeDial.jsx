import { MODE_VERB } from '../lib/format.js'

const MIN = 20
const MAX = 360
const STEP = 5

/** The redesign's presets. A preset sets the slider value and fires the same
 *  `minutes` action, so it debounces identically — there is no separate code
 *  path to keep in step. */
export const PRESETS = [20, 45, 90, 180]

/**
 * The time budget: `HOW LONG DO YOU HAVE?`, the big mono readout, a native
 * slider, and the preset chips.
 *
 * A native `<input type="range">`, deliberately. Arrow keys, Home, End, Page
 * Up and Page Down all work for free and match what a screen-reader user
 * already expects. A custom control would have to reimplement every one of
 * those and would still not match the platform. The one thing added on top is
 * `aria-valuetext`, so the value is announced as "35 minutes, walking" rather
 * than as the bare number "35".
 */
export default function TimeDial({ minutes, effectiveMode, onChange }) {
  const verb = MODE_VERB[effectiveMode] ?? effectiveMode
  const valueText = `${minutes} minutes, ${verb}`

  return (
    <div className="dial">
      <p className="microlabel" id="time-dial-label">
        How long do you have?
      </p>

      <p className="dial__readout mono" aria-hidden="true">
        {minutes} min
      </p>

      <input
        id="time-dial"
        className="dial__slider"
        type="range"
        min={MIN}
        max={MAX}
        step={STEP}
        value={minutes}
        // WebKit draws the sky fill from this; Firefox uses ::-moz-range-progress.
        style={{ '--dial-fill': `${((minutes - MIN) / (MAX - MIN)) * 100}%` }}
        aria-labelledby="time-dial-label"
        aria-valuetext={valueText}
        onChange={(e) => onChange(Number(e.target.value))}
      />

      <div className="dial__presets">
        {PRESETS.map((preset) => (
          <button
            key={preset}
            type="button"
            className="dial__preset mono"
            aria-pressed={minutes === preset}
            onClick={() => onChange(preset)}
          >
            {preset}
          </button>
        ))}
        <span className="dial__preset-unit mono" aria-hidden="true">
          minutes
        </span>
      </div>
    </div>
  )
}
