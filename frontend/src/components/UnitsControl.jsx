/**
 * Distance and clock preference.
 *
 * Two fieldsets rather than one, because these are two independent questions.
 * Under a single `<legend>Units</legend>` a screen reader announces four
 * toggles in a row with nothing saying where the first choice ends and the
 * second begins.
 *
 * Selection is carried by fill, border, font weight and a check glyph, matching
 * ObjectiveChips — never by colour alone.
 *
 * The "forget it" control is a sibling of the hint, not nested inside it:
 * .link-button is `align-self: flex-start` and expects to be a flex child. It
 * uses .link-button rather than the .linkish this was ported from, because
 * .linkish carries no min-height and every target here has to clear 44px.
 */
export default function UnitsControl({ units, onUnits, onClearUnits }) {
  const chip = (group, value, label, current) => (
    <button
      type="button"
      className="chip"
      aria-pressed={current === value}
      onClick={() => onUnits({ [group]: value })}
    >
      {label}
      {current === value && (
        <span className="chip__check" aria-hidden="true">
          ✓
        </span>
      )}
    </button>
  )

  return (
    <div className="units">
      <fieldset className="chips">
        <legend>Distance</legend>
        <div className="chips__row">
          {chip('distance', 'metric', 'Kilometres', units.distance)}
          {chip('distance', 'imperial', 'Miles', units.distance)}
        </div>
      </fieldset>

      <fieldset className="chips">
        <legend>Clock</legend>
        <div className="chips__row">
          {chip('clock', '24', '24-hour', units.clock)}
          {chip('clock', '12', '12-hour', units.clock)}
        </div>
      </fieldset>

      <p className="field__hint">
        Saved in this browser, alongside your light/dark choice. Those two words are the only
        things Meander keeps on its own. One set of routes is kept as well, but only if you ask
        for it in the privacy note, and only ever the last one.
      </p>

      {units.chosen && (
        <button type="button" className="link-button" onClick={onClearUnits}>
          Forget it and follow this device
        </button>
      )}
    </div>
  )
}
