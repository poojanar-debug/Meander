import { OBJECTIVES } from '../lib/dash.js'

/** The three shipped objectives wear their route accents; the other three are
 *  real chips in a disabled state so the vocabulary is visible before it is
 *  available — `· soon` says which side of that line each one is on. */
const SOON = new Set(['quiet', 'shade', 'air'])

/**
 * `OPTIMISE FOR — UP TO 3`.
 *
 * The limit is enforced in the reducer and refused out loud in App's handler;
 * these chips only report state. `aria-pressed` carries the on/off, so the
 * wash is never the only signal.
 */
export default function ObjectiveChips({ objectives, onToggle }) {
  return (
    <div className="objectives">
      <p className="microlabel" id="objectives-label">
        Optimise for — up to 3
      </p>
      <div className="objectives__row" role="group" aria-labelledby="objectives-label">
        {OBJECTIVES.map((objective) => {
          const soon = SOON.has(objective.id)
          const pressed = objectives.includes(objective.id)
          return (
            <button
              key={objective.id}
              type="button"
              className={`chip chip--${objective.id}${pressed ? ' is-pressed' : ''}`}
              aria-pressed={pressed}
              disabled={soon}
              onClick={() => onToggle(objective.id)}
            >
              <span className={`dot dot--${objective.id}`} aria-hidden="true" />
              {objective.label}
              {soon && <span className="chip__soon mono"> · soon</span>}
            </button>
          )
        })}
      </div>
    </div>
  )
}
