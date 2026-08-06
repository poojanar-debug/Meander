/**
 * Theme preference.
 *
 * This is the only thing Meander stores in the browser, and it is the only new
 * client-side state the redesign introduces. It is a display preference and
 * nothing else — no coordinates, no history, no identifier.
 *
 * Every localStorage access is wrapped. Safari in private mode throws on
 * setItem rather than returning, and a theme toggle is not worth taking the app
 * down for: without storage the choice simply lasts as long as the tab does
 * (§8, "localStorage unavailable").
 */

export const THEME_KEY = 'meander:theme'

const isTheme = (value) => value === 'light' || value === 'dark'

export function readStoredTheme() {
  try {
    const stored = window.localStorage.getItem(THEME_KEY)
    return isTheme(stored) ? stored : null
  } catch {
    return null
  }
}

export function storeTheme(theme) {
  try {
    window.localStorage.setItem(THEME_KEY, theme)
  } catch {
    // Private mode, or storage disabled. The preference lives in memory for
    // this tab instead; nothing else depends on it having been written.
  }
}

/** What the operating system asks for, when the user has expressed no view. */
export function systemTheme() {
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
}

/** A stored choice wins over the system preference; the system is the default. */
export function initialTheme() {
  return readStoredTheme() ?? systemTheme()
}

/**
 * Paint the theme onto the document.
 *
 * `data-theme` drives the CSS custom properties. `color-scheme` is set as well
 * so form controls, scrollbars and the canvas backdrop — none of which read our
 * variables — follow the app rather than staying light under a dark page.
 */
export function applyTheme(theme) {
  const root = document.documentElement
  root.dataset.theme = theme
  root.style.colorScheme = theme
}
