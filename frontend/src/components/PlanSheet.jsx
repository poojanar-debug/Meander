import DepartureStrip from './DepartureStrip.jsx'
import ModeControl from './ModeControl.jsx'
import ObjectiveChips from './ObjectiveChips.jsx'
import TimeDial from './TimeDial.jsx'
import { CloseIcon, LocationArrowIcon, MagnifierIcon } from './Icons.jsx'

/**
 * The mobile plan sheet: two search fields, the time budget, the mode
 * segments, the objective chips, the departure row, and the one primary
 * action.
 *
 * The search fields here are doorways, not the search itself — tapping one
 * opens the full-surface place screen with the keyboard up, which is where the
 * real combobox lives. The location arrow beside the first is the only other
 * way to set the one required input, and it is deliberately not repeated on
 * the second: a destination is always a place picked from search, which is
 * what lets `resultsStore.js` hash it byte-exact while an origin has to be
 * snapped to a grid.
 *
 * **The dial gives way to one sentence once there is a destination.**
 * `buildRouteRequest` omits `minutes` from a point-to-point body, so the dial
 * would be a control that moves and changes nothing: not the length, not the
 * mode, not the cache row. `BestWindow` sets the precedent — it does not
 * render at all rather than show a figure it cannot stand behind.
 */
export default function PlanSheet({
  origin,
  dest,
  minutes,
  mode,
  effectiveMode,
  objectives,
  departAt,
  locating,
  geoDenied,
  units,
  onOpenSearch,
  onOpenDestSearch,
  onClearDest,
  onLocate,
  onMinutes,
  onMode,
  onToggleObjective,
  onDepartAt,
  onFind,
}) {
  return (
    <div className="plan">
      <div className="plan__search">
        <button type="button" className="plan__search-field" onClick={onOpenSearch}>
          <MagnifierIcon size={16} />
          <span className={origin ? 'plan__search-text' : 'plan__search-text is-empty'}>
            {origin ? origin.name : 'Where from?'}
          </span>
        </button>
        <button
          type="button"
          className="plan__search-locate"
          onClick={onLocate}
          disabled={locating}
          aria-label="Use my location"
        >
          <LocationArrowIcon size={16} />
        </button>
      </div>

      {locating && <p className="plan__hint mono">Finding you…</p>}
      {geoDenied && (
        <p className="plan__hint mono">
          Your browser did not share your location. Search for a starting point instead.
        </p>
      )}

      <div className={`plan__search plan__search--dest${dest ? ' has-clear' : ''}`}>
        <button type="button" className="plan__search-field" onClick={onOpenDestSearch}>
          <MagnifierIcon size={16} />
          <span className={dest ? 'plan__search-text' : 'plan__search-text is-empty'}>
            {dest ? dest.name : 'Where to?'}
          </span>
        </button>
        {dest && (
          <button
            type="button"
            className="plan__search-clear"
            onClick={onClearDest}
            aria-label="Clear destination"
          >
            <CloseIcon size={14} />
          </button>
        )}
      </div>

      {/* The capsule can hang this off a popover; a sheet has nowhere to put it
          but under the field, and it is the sentence that makes an empty field
          a choice rather than an omission. */}
      {!dest && (
        <p className="plan__hint mono">empty means a loop back to where you started</p>
      )}

      {dest ? (
        <p className="plan__budget-note mono">the destination sets how long this takes</p>
      ) : (
        <TimeDial minutes={minutes} effectiveMode={effectiveMode} onChange={onMinutes} />
      )}

      <ModeControl mode={mode} effectiveMode={effectiveMode} onMode={onMode} />

      <ObjectiveChips objectives={objectives} onToggle={onToggleObjective} />

      <DepartureStrip origin={origin} departAt={departAt} units={units} onDepartAt={onDepartAt} />

      <button
        type="button"
        className="button-sky plan__find"
        disabled={!origin}
        onClick={onFind}
      >
        Find routes
      </button>

      <p className="plan__footer mono">
        no account · no history · your location stays on this phone
      </p>
    </div>
  )
}
