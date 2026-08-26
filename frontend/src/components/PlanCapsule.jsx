import { useEffect, useRef, useState } from 'react'

import { DASH } from '../lib/dash.js'
import ModeControl from './ModeControl.jsx'
import ObjectiveChips from './ObjectiveChips.jsx'
import PlaceInput from './PlaceInput.jsx'
import TimeDial from './TimeDial.jsx'
import { CaretDownIcon, LocationArrowIcon } from './Icons.jsx'

const MODE_LABEL = { auto: 'Auto', foot: 'Walk', bike: 'Bike', car: 'Drive' }

/**
 * The desktop plan capsule: one floating pill, its segments split by
 * hairlines — origin, destination, minutes, mode, objectives — and the primary
 * action on the end. Each segment opens the same editor the mobile plan sheet
 * uses, dropped as a popover under the capsule.
 *
 * One editor at a time; Escape and clicking anywhere else close it. The
 * segments are real buttons with `aria-expanded`, so the popover is a
 * disclosure rather than a mystery.
 *
 * **The minutes segment is not rendered once there is a destination**, and
 * that is not tidying. `buildRouteRequest` omits `minutes` from a
 * point-to-point body and `encodeState` omits it from the link, so the dial
 * changes nothing about that request: not its length, not its mode, not even
 * its cache row. A control that moves and changes nothing is the one thing
 * this UI is not allowed to be, and the precedent is `BestWindow`, which does
 * not render at all rather than show a time it cannot stand behind. The
 * destination popover says where the length comes from instead.
 */
export default function PlanCapsule({
  origin,
  dest,
  minutes,
  mode,
  effectiveMode,
  objectives,
  locating,
  geoDenied,
  onOrigin,
  onDest,
  onLocate,
  onMinutes,
  onMode,
  onToggleObjective,
  onFind,
}) {
  const [editor, setEditor] = useState(null)
  const rootRef = useRef(null)

  useEffect(() => {
    if (!editor) return undefined
    const onDown = (event) => {
      if (!rootRef.current?.contains(event.target)) setEditor(null)
    }
    const onKey = (event) => {
      if (event.key === 'Escape') setEditor(null)
    }
    document.addEventListener('pointerdown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('pointerdown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [editor])

  const toggle = (name) => setEditor((was) => (was === name ? null : name))

  const objectiveLabel = objectives.map((id) => DASH[id]?.label ?? id).join(' · ')

  return (
    <div className="capsule-wrap" ref={rootRef}>
      <div className="capsule">
        <button
          type="button"
          className="capsule__seg capsule__seg--origin"
          aria-expanded={editor === 'origin'}
          onClick={() => toggle('origin')}
        >
          <span className="dot dot--sky" aria-hidden="true" />
          <span className="visually-hidden">Starting point: </span>
          <span className="capsule__place-name">{origin ? origin.name : 'Where from?'}</span>
        </button>

        <span className="capsule__rule" aria-hidden="true" />

        <button
          type="button"
          className="capsule__seg capsule__seg--dest"
          aria-expanded={editor === 'dest'}
          onClick={() => toggle('dest')}
        >
          <span className="dot dot--ink" aria-hidden="true" />
          <span className="visually-hidden">Destination: </span>
          {/* "Round trip" is the default value, not a prompt, so it wears the
              placeholder weight the trip bar has always given one. */}
          <span className={dest ? 'capsule__place-name' : 'capsule__place-name is-placeholder'}>
            {dest ? dest.name : 'Round trip'}
          </span>
        </button>

        {!dest && (
          <>
            <span className="capsule__rule" aria-hidden="true" />

            <button
              type="button"
              className="capsule__seg capsule__seg--minutes mono"
              aria-expanded={editor === 'minutes'}
              onClick={() => toggle('minutes')}
            >
              {minutes} min
            </button>
          </>
        )}

        <span className="capsule__rule" aria-hidden="true" />

        <button
          type="button"
          className="capsule__seg capsule__seg--mode"
          aria-expanded={editor === 'mode'}
          onClick={() => toggle('mode')}
        >
          {MODE_LABEL[mode] ?? mode}
          <CaretDownIcon size={11} />
        </button>

        <span className="capsule__rule" aria-hidden="true" />

        <button
          type="button"
          className="capsule__seg capsule__seg--objectives"
          aria-expanded={editor === 'objectives'}
          onClick={() => toggle('objectives')}
        >
          {objectiveLabel}
        </button>

        <button type="button" className="button-sky capsule__find" disabled={!origin} onClick={onFind}>
          Find routes
        </button>
      </div>

      {editor === 'origin' && (
        <div className="capsule__popover">
          <PlaceInput
            label="Starting point"
            placeholder="Where from?"
            value={origin}
            autoFocus
            onPick={(place) => {
              onOrigin(place)
              setEditor(null)
            }}
            onClear={() => onOrigin(null)}
          />
          <button
            type="button"
            className="pill capsule__locate"
            disabled={locating}
            onClick={() => {
              // The editor closes on the press, not on the fix: the segment
              // itself shows the name when the position lands, and a popover
              // left open would sit over the results the next press asks for.
              onLocate()
              setEditor(null)
            }}
          >
            <LocationArrowIcon size={14} />
            {locating ? 'Finding you…' : 'Use my location'}
          </button>
          {geoDenied && (
            <p className="capsule__hint mono">
              Your browser did not share your location. Search for a starting point instead.
            </p>
          )}
        </div>
      )}

      {/* No "use my location" here, deliberately. A destination is always a
          place picked from search, which is what lets resultsStore.js hash it
          byte-exact while the origin has to be snapped to a grid. */}
      {editor === 'dest' && (
        <div className="capsule__popover">
          <PlaceInput
            label="Destination"
            placeholder="Where to?"
            value={dest}
            autoFocus
            onPick={(place) => {
              onDest(place)
              setEditor(null)
            }}
            onClear={() => onDest(null)}
          />
          <p className="capsule__hint mono">
            Empty means a round trip — Meander brings you back to where you started.
          </p>
        </div>
      )}

      {editor === 'minutes' && !dest && (
        <div className="capsule__popover">
          <TimeDial minutes={minutes} effectiveMode={effectiveMode} onChange={onMinutes} />
        </div>
      )}

      {editor === 'mode' && (
        <div className="capsule__popover">
          <ModeControl mode={mode} effectiveMode={effectiveMode} onMode={onMode} />
        </div>
      )}

      {editor === 'objectives' && (
        <div className="capsule__popover">
          <ObjectiveChips objectives={objectives} onToggle={onToggleObjective} />
        </div>
      )}
    </div>
  )
}
