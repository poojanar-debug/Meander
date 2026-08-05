import { useEffect, useState } from 'react'

/**
 * A media query, as state.
 *
 * Used for the one thing CSS cannot do here: RouteList has to know whether the
 * sheet is a sheet or a desktop panel, because that decides whether a route
 * renders as a compact row or a full card. Doing it in CSS alone would leave
 * the DOM saying "peek" while the layout said otherwise, which is exactly the
 * kind of disagreement that makes a screen reader describe a different page
 * from the one on screen.
 */
export function useMediaQuery(query) {
  const [matches, setMatches] = useState(() =>
    typeof window !== 'undefined' && window.matchMedia
      ? window.matchMedia(query).matches
      : false,
  )

  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return undefined
    const media = window.matchMedia(query)
    const update = (event) => setMatches(event.matches)
    setMatches(media.matches)
    media.addEventListener('change', update)
    return () => media.removeEventListener('change', update)
  }, [query])

  return matches
}
