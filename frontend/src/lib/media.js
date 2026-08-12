import { useEffect, useState } from 'react'

/**
 * The one place the 900px breakpoint is written in JavaScript.
 *
 * `styles.css` decides the layout at this width — one column, the stage as a
 * band above the panel, the trip bar static — and follow mode's *behaviour*
 * changes at the same width: below it the overlay is full-screen and modal, and
 * above it the stage is a column beside a panel that stays legitimately usable.
 * Those two decisions have to be the same decision. A literal `899` typed a
 * second time in a component is how a layer becomes modal on one side of a
 * breakpoint and the layout stays two-column on the other, which is a state
 * with no way out.
 */
export const MOBILE_LAYOUT = '(max-width: 899px)'

/**
 * Subscribe to a media query.
 *
 * Initialised from a live read rather than from `false`, so the first paint is
 * already right: seeding false would render follow mode non-modal for one frame
 * on a phone and move focus into a layer that was about to become a trap.
 *
 * Guarded for the absence of `matchMedia` because this file is imported by
 * modules that a node test may load without a DOM.
 */
export function useMatchMedia(query) {
  const [matches, setMatches] = useState(
    () => window.matchMedia?.(query).matches === true,
  )
  useEffect(() => {
    const list = window.matchMedia?.(query)
    if (!list) return undefined
    const onChange = (event) => setMatches(event.matches)
    setMatches(list.matches)
    list.addEventListener('change', onChange)
    return () => list.removeEventListener('change', onChange)
  }, [query])
  return matches
}
