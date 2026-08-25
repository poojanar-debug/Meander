import { MODE_VERB } from '../lib/format.js'

const MODES = [
  ['auto', 'Auto'],
  ['foot', 'Walk'],
  ['bike', 'Bike'],
  ['car', 'Drive'],
]

/**
 * The segmented Auto / Walk / Bike / Drive control. The active segment is a
 * surface pill inside the recessed container; `aria-pressed` carries the
 * choice for anyone not reading the pill.
 *
 * `effectiveMode` names what Auto currently resolves to, so choosing Auto is
 * never choosing a mystery: the label under the control says which of the
 * three it means right now.
 */
export default function ModeControl({ mode, effectiveMode, onMode }) {
  return (
    <div className="mode">
      <div className="mode__seg" role="group" aria-label="How you travel">
        {MODES.map(([value, label]) => (
          <button
            key={value}
            type="button"
            className={`mode__btn${mode === value ? ' is-active' : ''}`}
            aria-pressed={mode === value}
            onClick={() => onMode(value)}
          >
            {label}
          </button>
        ))}
      </div>
      {mode === 'auto' && (
        <p className="mode__hint mono">auto: {MODE_VERB[effectiveMode] ?? effectiveMode}</p>
      )}
    </div>
  )
}
