import { clearUnits, setUnits, useUnits } from '../lib/units.js'

/**
 * Distance units and clock format.
 *
 * The browser's locale is the default and not the decision — a detected locale
 * is a good guess about a person and a bad substitute for asking them. Somebody
 * in a metric country who thinks in miles exists.
 *
 * The storage note is not boilerplate. This is the first thing the app has ever
 * kept in a browser, on a page that otherwise promises to keep nothing, so it
 * says what is kept and offers a way to undo it.
 */
export default function UnitsControl() {
  const units = useUnits()

  return (
    <fieldset className="chips">
      <legend>Units</legend>

      <div className="chips__row">
        {[
          ['metric', 'Kilometres'],
          ['imperial', 'Miles'],
        ].map(([value, label]) => (
          <button
            key={value}
            type="button"
            className="chip"
            aria-pressed={units.distance === value}
            onClick={() => setUnits({ distance: value })}
          >
            {label}
          </button>
        ))}
      </div>

      <div className="chips__row">
        {[
          ['24', '24-hour'],
          ['12', '12-hour'],
        ].map(([value, label]) => (
          <button
            key={value}
            type="button"
            className="chip"
            aria-pressed={units.clock === value}
            onClick={() => setUnits({ clock: value })}
          >
            {label}
          </button>
        ))}
      </div>

      {units.chosen ? (
        <p className="field__hint">
          Saved in this browser — the only thing Meander stores, and it is just these two
          words. No location is ever kept.{' '}
          <button type="button" className="linkish" onClick={clearUnits}>
            Forget it and follow my browser’s language
          </button>
        </p>
      ) : (
        <p className="field__hint">
          Following your browser’s language. Choosing above saves the preference in this
          browser; nothing else is stored.
        </p>
      )}
    </fieldset>
  )
}
