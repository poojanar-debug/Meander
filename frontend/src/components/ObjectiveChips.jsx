import { OBJECTIVES } from '../lib/dash.js'

/**
 * `OPTIMISE FOR — UP TO 3`.
 *
 * Every objective in the identity table is a chip that can be pressed, wearing
 * its own route accent. Three of them were disabled and read `· soon` until
 * the backend could route them; nothing here special-cases an objective any
 * more, so the table is the only thing deciding what this offers.
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
          const pressed = objectives.includes(objective.id)
          return (
            <button
              key={objective.id}
              type="button"
              className={`chip chip--${objective.id}${pressed ? ' is-pressed' : ''}`}
              aria-pressed={pressed}
              onClick={() => onToggle(objective.id)}
            >
              <span className={`dot dot--${objective.id}`} aria-hidden="true" />
              {objective.label}
            </button>
          )
        })}
      </div>
    </div>
  )
}
