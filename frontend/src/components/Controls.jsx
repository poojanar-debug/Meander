import { OBJECTIVES, swatchBackground } from '../lib/dash.js'
import PlaceInput from './PlaceInput.jsx'
import TimeDial from './TimeDial.jsx'

const MODES = [
  { value: 'auto', label: 'Choose for me' },
  { value: 'foot', label: 'On foot' },
  { value: 'bike', label: 'By bike' },
  { value: 'car', label: 'By car' },
]

export default function Controls({
  minutes,
  mode,
  effectiveMode,
  objectives,
  origin,
  dest,
  locating,
  geoDenied,
  onMinutes,
  onMode,
  onToggleObjective,
  onOrigin,
  onDest,
  onLocate,
}) {
  return (
    <form
      className="controls"
      aria-labelledby="controls-heading"
      onSubmit={(e) => e.preventDefault()}
    >
      <h2 className="visually-hidden" id="controls-heading">
        Route options
      </h2>

      <div className="field">
        <PlaceInput
          label="Starting point"
          placeholder="Search for a place"
          value={origin}
          onPick={onOrigin}
          onClear={() => onOrigin(null)}
        />
        <button type="button" className="button" onClick={onLocate} disabled={locating}>
          {locating ? 'Finding you…' : 'Use my location'}
        </button>
        {geoDenied && (
          <p className="field__hint">
            Your browser did not share your location. Search for a starting point instead.
          </p>
        )}
      </div>

      <PlaceInput
        label="Destination (optional)"
        placeholder="Leave empty for a round trip"
        value={dest}
        onPick={onDest}
        onClear={() => onDest(null)}
      />

      <TimeDial
        minutes={minutes}
        mode={mode}
        effectiveMode={effectiveMode}
        onChange={onMinutes}
      />

      <div className="field">
        <label className="field__label" htmlFor="mode-select">
          How are you travelling?
        </label>
        <select id="mode-select" value={mode} onChange={(e) => onMode(e.target.value)}>
          {MODES.map((m) => (
            <option key={m.value} value={m.value}>
              {m.label}
            </option>
          ))}
        </select>
      </div>

      <fieldset className="chips">
        <legend>What should the routes optimise for?</legend>
        <div className="chips__row">
          {OBJECTIVES.map((objective) => {
            const pressed = objectives.includes(objective.id)
            return (
              <button
                key={objective.id}
                type="button"
                className="chip"
                aria-pressed={pressed}
                onClick={() => onToggleObjective(objective.id)}
              >
                <span
                  className="chip__swatch"
                  aria-hidden="true"
                  style={{ background: swatchBackground(objective.id) }}
                />
                {objective.label}
                <span className="visually-hidden">
                  , shown as a {objective.pattern} line
                </span>
              </button>
            )
          })}
        </div>
        <p className="field__hint" style={{ marginTop: 8 }}>
          Pick up to three. Choosing a fourth drops the one you chose first.
        </p>
      </fieldset>
    </form>
  )
}
