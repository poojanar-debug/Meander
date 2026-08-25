import { useEffect, useState } from 'react'

/**
 * The one place the 1024px breakpoint is written in JavaScript.
 *
 * `styles.css` decides the presentation at this width — below it the plan, the
 * results and the route detail live in a draggable bottom sheet over the map;
 * at 1024 and up they become the floating plan capsule, the results row and
 * the centered modal — and behaviour changes at the same width: the sheet and
 * the follow overlay are modal below it and not above. Those two decisions
 * have to be the same decision. A literal `1023` typed a second time in a
 * component is how a layer becomes modal on one side of a breakpoint while
 * the layout stays desktop on the other, which is a state with no way out.
 */
export const MOBILE_LAYOUT = '(max-width: 1023px)'

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
