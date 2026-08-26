import { useEffect, useRef } from 'react'

import PlaceInput from './PlaceInput.jsx'

/**
 * The two fields this screen can be editing. Keyed rather than passed as four
 * strings so the two surfaces cannot drift apart, and so a caller cannot
 * invent a third field by typo: an unknown key falls back to the origin,
 * which is the one input the app cannot run without.
 */
const FIELDS = {
  origin: {
    label: 'Starting point',
    placeholder: 'Where from?',
    title: 'Search for a starting point',
  },
  dest: {
    label: 'Destination',
    placeholder: 'Where to?',
    title: 'Search for a destination',
  },
}

/**
 * The full-surface place search, keyboard up. A screen rather than a popover:
 * on a phone the keyboard owns half the viewport, and a floating list under a
 * sheet-bound field would be fighting it for the remainder.
 *
 * Escape and Cancel both leave without choosing. Picking a place chooses and
 * leaves in one tap. The footer sentence is the privacy position of the
 * feature, stated where the typing happens.
 *
 * One screen serves both ends of the trip. The combobox, its debounce and its
 * cache are `PlaceInput`'s and are identical either way; all that changes is
 * what the screen is called and what the pick is written back to.
 */
export default function PlaceSearch({ field = 'origin', value, onPick, onCancel }) {
  const surfaceRef = useRef(null)
  const { label, placeholder, title } = FIELDS[field] ?? FIELDS.origin

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
    <div className="search" ref={surfaceRef} role="dialog" aria-label={title}>
      <div className="search__bar">
        <div className="search__field">
          <PlaceInput
            label={label}
            placeholder={placeholder}
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
