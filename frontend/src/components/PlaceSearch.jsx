import { useEffect, useRef } from 'react'

import PlaceInput from './PlaceInput.jsx'

/**
 * The full-surface place search, keyboard up. A screen rather than a popover:
 * on a phone the keyboard owns half the viewport, and a floating list under a
 * sheet-bound field would be fighting it for the remainder.
 *
 * Escape and Cancel both leave without choosing. Picking a place chooses and
 * leaves in one tap. The footer sentence is the privacy position of the
 * feature, stated where the typing happens.
 */
export default function PlaceSearch({ value, onPick, onCancel }) {
  const surfaceRef = useRef(null)

  useEffect(() => {
    const onKeyDown = (event) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        onCancel()
      }
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [onCancel])

  return (
    <div className="search" ref={surfaceRef} role="dialog" aria-label="Search for a starting point">
      <div className="search__bar">
        <div className="search__field">
          <PlaceInput
            label="Starting point"
            placeholder="Where from?"
            value={value}
            inline
            autoFocus
            onPick={(place) => {
              onPick(place)
            }}
          />
        </div>
        <button type="button" className="search__cancel" onClick={onCancel}>
          Cancel
        </button>
      </div>

      <p className="search__footer mono">
        searches are your own words — never stored, never sent to analytics
      </p>
    </div>
  )
}
