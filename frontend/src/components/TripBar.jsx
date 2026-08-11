import { useState } from 'react'

import { MODE_VERB } from '../lib/format.js'
import ObjectiveChips from './ObjectiveChips.jsx'
import PlaceInput from './PlaceInput.jsx'
import TimeDial from './TimeDial.jsx'
import TripDrawer from './TripDrawer.jsx'
import UnitsControl from './UnitsControl.jsx'

const MODES = [
  { value: 'auto', label: 'Choose for me' },
  { value: 'foot', label: 'On foot' },
  { value: 'bike', label: 'By bike' },
  { value: 'car', label: 'By car' },
]

/* 22x22, --brand, decorative. Inline rather than an icon font: a font would be
   a third-party request, and this app promises it makes none. */
function Icon({ name }) {
  const common = {
    width: 22,
    height: 22,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.8,
    strokeLinecap: 'round',
    strokeLinejoin: 'round',
    'aria-hidden': true,
    className: 'seg__dot',
  }
  if (name === 'from') {
    return (
      <svg {...common}>
        <circle cx="12" cy="10" r="3" />
        <path d="M12 21s7-6.2 7-11a7 7 0 1 0-14 0c0 4.8 7 11 7 11Z" />
      </svg>
    )
  }
  if (name === 'to') {
    return (
      <svg {...common}>
        <path d="M5 21V4M5 4h11l-2 3.5L16 11H5" />
      </svg>
    )
  }
  if (name === 'time') {
    return (
      <svg {...common}>
        <circle cx="12" cy="12" r="8.5" />
        <path d="M12 7v5l3.5 2" />
      </svg>
    )
  }
  return (
    <svg {...common}>
      <path d="M4 7h16M4 12h10M4 17h6" />
    </svg>
  )
}

/**
 * Four labelled segments in place of nine stacked form fields. Implements §4.3.
 *
 * Each segment shows its current value and opens exactly one drawer; opening
 * one closes the others. That is the whole point of the component — the old
 * control panel put nine decisions on screen before the user had an answer to
 * any of them, and this puts four summaries on screen and the decisions one
 * layer down.
 *
 * **The fetch model is untouched.** Closing a drawer does not fetch; changing a
 * value inside one does, through exactly the same actions the old form
 * dispatched, with exactly the same per-trigger debounce. This component owns
 * which drawer is open and nothing else.
 */
export default function TripBar({
  minutes,
  mode,
  effectiveMode,
  objectives,
  theme,
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
  units,
  onUnits,
  onClearUnits,
}) {
  const [open, setOpen] = useState(null)
  const toggle = (key) => setOpen((current) => (current === key ? null : key))

  const verb = MODE_VERB[effectiveMode] ?? effectiveMode
  const segments = [
    {
      key: 'from',
      label: 'From',
      value: locating ? 'Finding you…' : (origin?.name ?? 'Not set'),
      placeholder: !origin && !locating,
    },
    {
      key: 'to',
      label: 'To',
      value: dest?.name ?? 'Round trip',
      placeholder: !dest,
    },
    // A destination fixes the length of the trip, so there is no budget to
    // show and the dial below is not rendered. Naming the segment "Time &
    // travel" and printing a minute count there would advertise a control that
    // cannot change the answer.
    {
      key: 'time',
      label: dest ? 'Travel' : 'Time & travel',
      value: dest ? verb : `${minutes} min · ${verb}`,
      placeholder: false,
    },
    {
      key: 'compare',
      label: 'Compare',
      value: `${objectives.length} type${objectives.length === 1 ? '' : 's'}`,
      placeholder: false,
    },
  ]

  return (
    <div className="tripbar">
      <div className="tripbar__grid">
        {segments.map((segment) => (
          <button
            key={segment.key}
            type="button"
            className="seg"
            aria-expanded={open === segment.key}
            aria-controls={`drawer-${segment.key}`}
            onClick={() => toggle(segment.key)}
          >
            <Icon name={segment.key} />
            <span className="seg__text">
              <span className="seg__k" id={`seg-key-${segment.key}`}>
                {segment.label}
              </span>
              {/* title carries the full text when the value is ellipsised. */}
              <span
                className={segment.placeholder ? 'seg__v seg__v--placeholder' : 'seg__v'}
                title={segment.value}
              >
                {segment.value}
              </span>
            </span>
          </button>
        ))}
      </div>

      <TripDrawer id="drawer-from" labelledBy="seg-key-from" open={open === 'from'}>
        <PlaceInput
          label="Starting point"
          placeholder="A park, a station, a street name…"
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
      </TripDrawer>

      <TripDrawer id="drawer-to" labelledBy="seg-key-to" open={open === 'to'}>
        <PlaceInput
          label="Destination"
          placeholder="Leave empty for a round trip"
          value={dest}
          onPick={onDest}
          onClear={() => onDest(null)}
        />
        <p className="field__hint">
          Empty means a round trip — Meander brings you back to where you started.
        </p>
      </TripDrawer>

      <TripDrawer id="drawer-time" labelledBy="seg-key-time" open={open === 'time'}>
        {/* Loops only. For a trip with both ends fixed the dial changed nothing
            that reaches the router — not the wire, the cache key, the mode —
            so leaving it on screen offered a control whose every position
            produced the same answer. The mode select stays: that one is still
            the user's to make. */}
        {!dest && (
          <TimeDial
            minutes={minutes}
            mode={mode}
            effectiveMode={effectiveMode}
            onChange={onMinutes}
          />
        )}
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
        {/* The drawer that already owns "how long" and "how are you
            travelling" is the honest home for "in what units". It also renders
            whether or not any routes exist, which the results-head slot does
            not — and with the locale defaulting a bare `en` to miles, this
            control has to be findable before the first search. */}
        <UnitsControl units={units} onUnits={onUnits} onClearUnits={onClearUnits} />
      </TripDrawer>

      <TripDrawer id="drawer-compare" labelledBy="seg-key-compare" open={open === 'compare'}>
        <ObjectiveChips objectives={objectives} theme={theme} onToggle={onToggleObjective} />
      </TripDrawer>
    </div>
  )
}
