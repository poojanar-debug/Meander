import DepartureStrip from './DepartureStrip.jsx'
import ModeControl from './ModeControl.jsx'
import ObjectiveChips from './ObjectiveChips.jsx'
import TimeDial from './TimeDial.jsx'
import Wordmark from './Wordmark.jsx'
import { LocationArrowIcon, MagnifierIcon } from './Icons.jsx'

/**
 * The mobile plan sheet: search field, the time budget, the mode segments,
 * the objective chips, the departure row, and the one primary action.
 *
 * The search field here is a doorway, not the search itself — tapping it
 * opens the full-surface place screen with the keyboard up, which is where
 * the real combobox lives. The location arrow beside it is the only other way
 * to set the one required input.
 *
 * The lockup leads because this sheet is the app's first screen and its only
 * header. `App.jsx` opens at the `full` snap with `showPlan` true, so the
 * wordmark is the first thing on a cold start, and it is gone once there are
 * routes to read — the results sheet is data, not identity. `.plan` is
 * already a centred column with a 15px gap, so the lockup needs no position
 * of its own.
 */
export default function PlanSheet({
  origin,
  minutes,
  mode,
  effectiveMode,
  objectives,
  departAt,
  locating,
  geoDenied,
  units,
  onOpenSearch,
  onLocate,
  onMinutes,
  onMode,
  onToggleObjective,
  onDepartAt,
  onFind,
}) {
  return (
    <div className="plan">
      <Wordmark />

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

      <TimeDial minutes={minutes} effectiveMode={effectiveMode} onChange={onMinutes} />

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
