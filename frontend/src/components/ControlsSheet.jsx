import { useCallback, useEffect, useRef } from 'react'

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), ' +
  'textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

/**
 * The controls, in a modal sheet.
 *
 * This is the one that *is* modal, and therefore the one that traps focus. The
 * route sheet deliberately does not: the map behind it stays usable, and a trap
 * there would make the map unreachable.
 *
 * The 782 px control stack used to sit permanently between the user and the
 * answer. Now it opens on demand from the top bar, so adjusting the time
 * budget and seeing what it did are one gesture apart instead of two screens.
 */
export default function ControlsSheet({ open, title, onClose, children }) {
  const panelRef = useRef(null)
  const returnFocusTo = useRef(null)

  const close = useCallback(() => onClose(), [onClose])

  useEffect(() => {
    if (!open) return undefined

    returnFocusTo.current = document.activeElement
    const panel = panelRef.current
    // Focus the panel itself rather than the first field: a screen reader then
    // announces the dialog's name before its contents, and nothing is typed
    // into by accident.
    panel?.focus()

    const onKeyDown = (event) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        close()
        return
      }
      if (event.key !== 'Tab') return

      const items = [...(panel?.querySelectorAll(FOCUSABLE) ?? [])].filter(
        (el) => el.offsetParent !== null || el === document.activeElement,
      )
      if (items.length === 0) return
      const first = items[0]
      const last = items[items.length - 1]

      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first.focus()
      }
    }

    document.addEventListener('keydown', onKeyDown, true)
    return () => {
      document.removeEventListener('keydown', onKeyDown, true)
      // Returning focus to whatever opened it is the difference between a
      // dialog and a trapdoor.
      returnFocusTo.current?.focus?.()
    }
  }, [open, close])

  if (!open) return null

  return (
    <div className="scrim" onClick={close}>
      <div
        ref={panelRef}
        className="controls-sheet"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="controls-sheet__bar">
          <h2 className="controls-sheet__title">{title}</h2>
          <button type="button" className="button" onClick={close}>
            Done
          </button>
        </div>
        <div className="controls-sheet__scroll">{children}</div>
      </div>
    </div>
  )
}
