import { useEffect, useRef } from 'react'

import { BASEMAPS } from '../lib/basemap.js'
import { CheckIcon, LayersIcon } from './Icons.jsx'

/**
 * Which basemap the routes are drawn on.
 *
 * ## The hint is not a subtitle
 *
 * Every option carries a sentence, and one of those sentences is a warning:
 * satellite fetches tiles as you move, including while following, and the
 * moment of choosing is the only moment that sentence can change anyone's
 * mind. Putting it on a settings page instead would be a way of having written
 * it without having said it.
 *
 * The warning is marked in text as well as in colour. `.layers__warn` is amber,
 * and the word "Fetches" carries the meaning on its own for anyone who does not
 * see the amber.
 *
 * ## Why a radiogroup rather than a listbox or a `<select>`
 *
 * Three mutually exclusive choices, all visible, each with a description that
 * has to be readable before the choice is made. A native `<select>` hides the
 * descriptions behind the closed state and reads only the label. `role="radio"`
 * on real buttons keeps arrow-key semantics, keeps `aria-checked`, and keeps
 * the hint in the accessible name via `aria-describedby`.
 *
 * ## Closing
 *
 * Escape and an outside pointer both close it, and Escape returns focus to the
 * toggle. That last part is the one people leave out: without it, dismissing
 * the menu from the keyboard drops focus to `<body>` and the next Tab starts
 * from the top of the document, which on this screen is the skip link.
 */
export default function LayerPicker({ layer, onLayer, open, onOpen }) {
  const rootRef = useRef(null)
  const toggleRef = useRef(null)
  const firstOptionRef = useRef(null)

  // Focus moves into the menu when it opens, onto the option that is already
  // chosen if there is one. Opening a menu and leaving focus on the button
  // behind it means the arrow keys do nothing and the screen reader announces
  // the toggle again rather than the choices.
  useEffect(() => {
    if (!open) return
    firstOptionRef.current?.focus()
  }, [open])

  useEffect(() => {
    if (!open) return undefined

    const onKey = (event) => {
      if (event.key !== 'Escape') return
      event.stopPropagation()
      onOpen(false)
      toggleRef.current?.focus()
    }
    const onPointer = (event) => {
      if (!rootRef.current?.contains(event.target)) onOpen(false)
    }

    // `keydown` on the document rather than on the menu: Escape has to work
    // from the toggle too, which is outside the menu but inside the widget.
    document.addEventListener('keydown', onKey)
    document.addEventListener('pointerdown', onPointer)
    return () => {
      document.removeEventListener('keydown', onKey)
      document.removeEventListener('pointerdown', onPointer)
    }
  }, [open, onOpen])

  // Arrow keys move between the options and choose as they go, which is what
  // a radiogroup does everywhere else. Home and End are the cheap extras that
  // make a three-item group behave like a long one.
  const onMenuKey = (event) => {
    const keys = ['ArrowDown', 'ArrowRight', 'ArrowUp', 'ArrowLeft', 'Home', 'End']
    if (!keys.includes(event.key)) return
    event.preventDefault()
    const index = BASEMAPS.findIndex((b) => b.id === layer)
    const at = index === -1 ? 0 : index
    let next = at
    if (event.key === 'ArrowDown' || event.key === 'ArrowRight') next = (at + 1) % BASEMAPS.length
    if (event.key === 'ArrowUp' || event.key === 'ArrowLeft') {
      next = (at - 1 + BASEMAPS.length) % BASEMAPS.length
    }
    if (event.key === 'Home') next = 0
    if (event.key === 'End') next = BASEMAPS.length - 1
    onLayer(BASEMAPS[next].id)
    rootRef.current?.querySelectorAll('.layers__option')[next]?.focus()
  }

  const current = BASEMAPS.find((b) => b.id === layer) ?? BASEMAPS[0]

  return (
    <div className="layers" ref={rootRef}>
      <button
        type="button"
        className="layers__toggle"
        ref={toggleRef}
        aria-expanded={open}
        aria-haspopup="true"
        // The current layer belongs in the name, not only in the menu. A
        // button that says "Map layer" tells a screen-reader user nothing
        // about what the map is currently showing them.
        aria-label={`Map layer: ${current.label}. Change`}
        onClick={() => onOpen(!open)}
      >
        <LayersIcon size={20} />
      </button>

      {open && (
        <div
          className="layers__menu"
          role="radiogroup"
          aria-label="Map layer"
          onKeyDown={onMenuKey}
        >
          {BASEMAPS.map((basemap, i) => {
            const chosen = basemap.id === layer
            return (
              <button
                type="button"
                key={basemap.id}
                role="radio"
                aria-checked={chosen}
                aria-describedby={`layer-hint-${basemap.id}`}
                className={chosen ? 'layers__option layers__option--on' : 'layers__option'}
                // Roving tabindex: one stop for the whole group, then arrows.
                tabIndex={chosen || (!BASEMAPS.some((b) => b.id === layer) && i === 0) ? 0 : -1}
                ref={chosen ? firstOptionRef : null}
                // Choosing closes it, and focus goes back to the toggle.
                //
                // Leaving it open was the first version and it is wrong on a
                // phone: the menu is a 236px card over the map, so picking
                // satellite left the imagery you just asked for hidden behind
                // the control you asked with. Seen on a screenshot.
                //
                // Note this is the pointer path only. Arrow keys go through
                // `onMenuKey`, which changes the layer and deliberately does
                // NOT close, because a radiogroup you are arrowing through has
                // to stay open to be arrowed through. Escape is the way out of
                // that one, and it restores focus the same way.
                onClick={() => {
                  onLayer(basemap.id)
                  onOpen(false)
                  toggleRef.current?.focus()
                }}
              >
                <span className="layers__option-head">
                  <span className="layers__option-label">{basemap.label}</span>
                  {chosen && (
                    <span className="layers__option-tick" aria-hidden="true">
                      <CheckIcon size={14} />
                    </span>
                  )}
                </span>
                <span
                  className={
                    basemap.streamsTiles ? 'layers__hint layers__hint--warn' : 'layers__hint'
                  }
                  id={`layer-hint-${basemap.id}`}
                >
                  {basemap.hint}
                </span>
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}
