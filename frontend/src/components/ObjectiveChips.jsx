import { OBJECTIVES, swatchBackground } from '../lib/dash.js'

/**
 * The six objective chips. Implements §4.5.
 *
 * Selection is carried four ways — fill, border, font weight and a check glyph
 * — so it survives greyscale and does not depend on anyone perceiving the tint.
 * The glyph exists only when pressed; a permanently visible check that merely
 * changes colour would be the colour-only signal this rule forbids.
 *
 * The swatch reproduces the route's actual dash pattern via swatchBackground(),
 * so the chip and the map line are recognisably the same thing.
 */
export default function ObjectiveChips({ objectives, theme, onToggle }) {
  return (
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
              onClick={() => onToggle(objective.id)}
            >
              <span
                className="chip__swatch"
                aria-hidden="true"
                style={{ background: swatchBackground(objective.id, theme) }}
              />
              {objective.label}
              {pressed && (
                <span className="chip__check" aria-hidden="true">
                  ✓
                </span>
              )}
              <span className="visually-hidden">, shown as a {objective.pattern} line</span>
            </button>
          )
        })}
      </div>
      <p className="field__hint">
        Up to three at a time. Each one gets its own colour and line pattern on the map.
      </p>
    </fieldset>
  )
}
