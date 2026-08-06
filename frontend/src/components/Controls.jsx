import { IMPLEMENTED, OBJECTIVES, swatchBackground } from '../lib/dash.js'
import PlaceInput from './PlaceInput.jsx'
import TimeDial from './TimeDial.jsx'
import UnitsControl from './UnitsControl.jsx'

const MODES = [
  { value: 'auto', label: 'Choose for me' },
  { value: 'foot', label: 'On foot' },
  { value: 'bike', label: 'By bike' },
  { value: 'car', label: 'By car' },
]

/**
 * The controls, in two sections, each opened from the top bar on demand.
 *
 * This was one 782 px stack sitting permanently between the user and the
 * answer, on a 390 px viewport. Splitting it is what lets the map be the page.
 */
export default function Controls({
  section = 'all',
  minutes,
  mode,
  effectiveMode,
  objectives,
  droppedObjective,
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
  const showPlaces = section === 'all' || section === 'places'
  const showOptions = section === 'all' || section === 'options'

  return (
    <form className="controls" onSubmit={(e) => e.preventDefault()}>
      {showPlaces && (
        <>
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
        </>
      )}

      {showOptions && (
        <>
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
                // Three of the six return "not implemented yet" from the API.
                // Rendered visibly disabled rather than hidden: a user who
                // wonders whether this app does quiet routes gets an answer.
                const available = IMPLEMENTED.has(objective.id)
                return (
                  <button
                    key={objective.id}
                    type="button"
                    className="chip"
                    aria-pressed={available ? pressed : undefined}
                    disabled={!available}
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
                      {available ? '' : '. Not available yet.'}
                    </span>
                    {!available && (
                      <span className="chip__soon" aria-hidden="true">
                        soon
                      </span>
                    )}
                  </button>
                )
              })}
            </div>

            {/* Choosing a fourth silently dropped the oldest, and on a phone the
                dropped chip was usually off screen — so a control changed state
                with no feedback anywhere the user was looking. */}
            {droppedObjective ? (
              <p className="field__notice" role="status">
                Three at a time, so <strong>{droppedObjective}</strong> was turned off.
              </p>
            ) : (
              <p className="field__hint">
                Pick up to three. Choosing a fourth drops the one you chose first.
              </p>
            )}
          </fieldset>

          <UnitsControl />
        </>
      )}
    </form>
  )
}
