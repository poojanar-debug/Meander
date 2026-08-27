import { useEffect, useRef } from 'react'

/**
 * One card, once per visit, on screens that are clearly a computer: this app
 * is built to be walked with, and the person at a desk should know that
 * before they judge it by the half of it a desk can show.
 *
 * ## Who sees it
 *
 * `App` renders it only when the layout is the desktop one (the shared 1024px
 * breakpoint) AND the primary pointer is a mouse — `(hover: hover) and
 * (pointer: fine)`. Width alone is not enough: an iPad in landscape is over
 * 1024px and is exactly the device this card must not lecture. Pointer alone
 * is not enough either: the CI gate drives a desktop-class browser at phone
 * widths, and a scrim over every pass would have it grading the card instead
 * of the app.
 *
 * ## Deliberately not persisted
 *
 * RELEASE-SPECS R4: localStorage is theme and units ONLY. Remembering the
 * dismissal would be a third key, so the card returns on the next visit
 * instead. That is the same trade the basemap choice makes, for the same
 * stated reason.
 *
 * ## Focus
 *
 * It is a real dialog: focus lands on the one button, Tab stays on it,
 * Escape and the scrim both dismiss, and focus goes back where it was. The
 * trap is one line because there is exactly one focusable thing inside.
 */
export default function DesktopNotice({ onClose }) {
  const buttonRef = useRef(null)

  useEffect(() => {
    const previous = document.activeElement
    buttonRef.current?.focus({ preventScroll: true })
    return () => {
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus()
    }
  }, [])

  useEffect(() => {
    const onKeyDown = (event) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        onClose()
        return
      }
      if (event.key === 'Tab') {
        event.preventDefault()
        buttonRef.current?.focus()
      }
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [onClose])

  return (
    // The scrim is a click target for dismissal, not content; the card stops
    // the click so choosing to read it is not the same gesture as leaving.
    <div className="desknote" onClick={onClose}>
      <div
        className="desknote__card"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="desknote-title"
        aria-describedby="desknote-body"
        onClick={(event) => event.stopPropagation()}
      >
        <h2 className="desknote__title" id="desknote-title">
          Meander is best used on a smartphone
        </h2>
        <p className="desknote__body" id="desknote-body">
          This app is made to be walked with: the live map, the next-turn banner and
          follow mode are all sized for a phone in your hand. Planning a route works
          fine here, but the walk itself needs a device that comes along.
        </p>
        <button
          type="button"
          className="button-sky desknote__continue"
          onClick={onClose}
          ref={buttonRef}
        >
          Continue on this computer
        </button>
      </div>
    </div>
  )
}
