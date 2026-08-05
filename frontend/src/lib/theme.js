import { useEffect, useState } from 'react'

/**
 * Which theme the tokens have currently resolved to.
 *
 * Nothing here *sets* a theme — the cascade does that, from
 * `prefers-color-scheme` with a `[data-theme]` override. This only reports the
 * answer, for the two things CSS cannot reach: MapLibre's basemap style, which
 * is a URL rather than a colour, and the paint properties of the route layers.
 */

const QUERY = '(prefers-color-scheme: dark)'

export function currentTheme() {
  if (typeof document === 'undefined') return 'light'
  const forced = document.documentElement.getAttribute('data-theme')
  if (forced === 'dark' || forced === 'light') return forced
  return typeof window !== 'undefined' && window.matchMedia?.(QUERY).matches ? 'dark' : 'light'
}

export function useTheme() {
  const [theme, setTheme] = useState(currentTheme)

  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return undefined
    const media = window.matchMedia(QUERY)
    const update = () => setTheme(currentTheme())

    media.addEventListener('change', update)
    // A [data-theme] override is a DOM change, not a media change, so the
    // media listener alone would miss an in-app toggle.
    const observer = new MutationObserver(update)
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme'],
    })

    return () => {
      media.removeEventListener('change', update)
      observer.disconnect()
    }
  }, [])

  return theme
}
