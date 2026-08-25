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
 * hairlines — origin, minutes, mode, objectives — and the primary action on
 * the end. Each segment opens the same editor the mobile plan sheet uses,
 * dropped as a popover under the capsule.
 *
 * One editor at a time; Escape and clicking anywhere else close it. The
 * segments are real buttons with `aria-expanded`, so the popover is a
 * disclosure rather than a mystery.
 */
export default function PlanCapsule({
  origin,
  minutes,
  mode,
  effectiveMode,
  objectives,
  locating,
  geoDenied,
  onOrigin,
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
          <span className="capsule__origin-name">{origin ? origin.name : 'Where from?'}</span>
        </button>

        <span className="capsule__rule" aria-hidden="true" />

        <button
          type="button"
          className="capsule__seg capsule__seg--minutes mono"
          aria-expanded={editor === 'minutes'}
          onClick={() => toggle('minutes')}
        >
          {minutes} min
        </button>

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

      {editor === 'minutes' && (
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
