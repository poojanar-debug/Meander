import { useState } from 'react'

import PlaceInput from './PlaceInput.jsx'
import { PRESETS } from './TimeDial.jsx'

/**
 * The empty state. Implements §7.
 *
 * **Three decisions, not nine.** Destination, travel mode and the six
 * objectives all take working defaults and are only reachable from the trip bar
 * once results exist. The fastest path to a first answer is one tap and one
 * pill, which is what "any user can use it" has to mean in practice.
 *
 * The slider is behind `Other` rather than on screen. Someone who wants exactly
 * 47 minutes can have it, but making everyone drag a 20–360 range before seeing
 * anything is what the redesign is trying to undo.
 */
export default function FirstRun({ minutes, origin, locating, geoDenied, onMinutes, onOrigin, onLocate }) {
  const [showSlider, setShowSlider] = useState(!PRESETS.some((p) => p.minutes === minutes))

  return (
    <div className="firstrun">
      <div className="firstrun__card">
        <h2 className="firstrun__headline">Where are you, and how long have you got?</h2>
        <p className="firstrun__lede">
          Meander works out three ways back: the fastest, the most scenic, and one that holds to real
          accessibility constraints.
        </p>

        <button
          type="button"
          className="button button--primary firstrun__locate"
          onClick={onLocate}
          disabled={locating}
        >
          {locating ? 'Finding you…' : 'Use my location'}
        </button>

        <p className="firstrun__or" aria-hidden="true">
          or
        </p>

        <PlaceInput
          label="Search for a starting point"
          placeholder="A park, a station, a street name…"
          value={origin}
          onPick={onOrigin}
          onClear={() => onOrigin(null)}
        />
        {geoDenied && (
          <p className="field__hint">
            Your browser did not share your location. Search for a starting point instead.
          </p>
        )}

        <fieldset className="chips firstrun__time">
          <legend>How long have you got?</legend>
          <div className="presets">
            {PRESETS.map((preset) => (
              <button
                key={preset.minutes}
                type="button"
                className="preset"
                aria-pressed={!showSlider && minutes === preset.minutes}
                onClick={() => {
                  setShowSlider(false)
                  onMinutes(preset.minutes)
                }}
              >
                {preset.label}
                {!showSlider && minutes === preset.minutes && (
                  <span className="chip__check" aria-hidden="true">
                    ✓
                  </span>
                )}
              </button>
            ))}
            <button
              type="button"
              className="preset"
              aria-pressed={showSlider}
              aria-controls="firstrun-slider"
              onClick={() => setShowSlider((v) => !v)}
            >
              Other
            </button>
          </div>
          {showSlider && (
            <div className="firstrun__slider" id="firstrun-slider">
              <label className="field__label" htmlFor="firstrun-range">
                Minutes
              </label>
              <input
                id="firstrun-range"
                type="range"
                min={20}
                max={360}
                step={5}
                value={minutes}
                aria-valuetext={`${minutes} minutes`}
                onChange={(e) => onMinutes(Number(e.target.value))}
              />
              <p className="dial__mode tabular">{minutes} minutes</p>
            </div>
          )}
        </fieldset>

        <p className="field__hint">
          Leave the destination empty and you get a loop that brings you back.
        </p>

        {/* Two sentences, because this is the entry screen and not the terms.
            The second exists because the first is no longer true on its own:
            reporting a barrier publishes. About.jsx carries the full version. */}
        <p className="firstrun__privacy">
          <span aria-hidden="true">⛉</span> No location is stored. Your coordinates answer this one
          request and are then discarded. The only thing Meander ever publishes is a barrier
          report, and only when you ask it to.
        </p>
      </div>
    </div>
  )
}
