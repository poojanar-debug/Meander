/**
 * Route identity table.
 *
 * Colour is never the only differentiator: each objective also has a distinct
 * dash pattern on the map and a matching CSS gradient for the swatch in the
 * list, so the routes stay distinguishable in greyscale and to anyone who does
 * not perceive the hue difference.
 *
 * **The colours live in styles.css, not here.** They used to be hardcoded in
 * this file *and* declared as custom properties, and the two disagreed four
 * ways: the Shade chip was teal while --score-shade was brown, the Clean-air
 * chip was crimson while --score-air was blue, the Fastest line was
 * byte-identical to --score-air, and the Quiet chip was byte-identical to
 * --score-shade. So one word meant two colours and one colour meant two words.
 *
 * Reading them from the cascade also means dark mode works for free: the
 * lightened dark-theme route colours are a media query away, and nothing here
 * needs to know that happened.
 */

export const OBJECTIVES = [
  { id: 'fastest', label: 'Fastest', dash: [1, 0], pattern: 'solid' },
  { id: 'nature', label: 'Nature', dash: [3, 2], pattern: 'dashed' },
  { id: 'accessible', label: 'Accessible', dash: [1, 2], pattern: 'dotted' },
  { id: 'quiet', label: 'Quiet', dash: [6, 3], pattern: 'long dash' },
  { id: 'shade', label: 'Shade', dash: [5, 2, 1, 2], pattern: 'dash-dot' },
  { id: 'air', label: 'Clean air', dash: [2, 2], pattern: 'fine dash' },
]

/**
 * Objectives the backend can actually route. The other three are accepted by
 * the API and answered with "not implemented yet", so the UI renders them
 * visibly disabled rather than letting someone pick one and get a stub.
 */
export const IMPLEMENTED = new Set(['fastest', 'nature', 'accessible'])

export const DASH = Object.fromEntries(OBJECTIVES.map((o) => [o.id, o]))

const FALLBACK = { id: 'unknown', label: 'Route', dash: [1, 0], pattern: 'solid' }

/**
 * Last-resort literals, used only when there is no computed style to read —
 * jsdom, a server render, or a call before the stylesheet has applied. They
 * must stay in step with the light-theme values in styles.css.
 * `npm run check:palette` is what keeps them honest, and it runs on every build.
 */
const FALLBACK_COLORS = {
  fastest: '#2f6fd0',
  nature: '#2e8b57',
  accessible: '#7a4fc4',
  quiet: '#b06a1f',
  shade: '#12756c',
  air: '#b03050',
  unknown: '#545f71',
}

/** Read a custom property off :root, resolved for the current theme. */
export function cssVar(name, fallback = '') {
  if (typeof window === 'undefined' || !window.getComputedStyle) return fallback
  const value = window.getComputedStyle(document.documentElement).getPropertyValue(name)
  return value.trim() || fallback
}

export function routeColor(id) {
  const key = DASH[id] ? id : 'unknown'
  return cssVar(`--route-${key}`, FALLBACK_COLORS[key])
}

/** The dash pattern and label. Colour is deliberately not on this object —
 *  it depends on the theme, so it has to be read when it is used. */
export function styleFor(id) {
  return DASH[id] ?? FALLBACK
}

/** A CSS background that reproduces the map's dash pattern in a swatch. */
export function swatchBackground(id) {
  const { dash } = styleFor(id)
  const color = routeColor(id)
  if (dash.length === 2 && dash[1] === 0) return color
  const unit = 3
  const stops = []
  let position = 0
  let painted = true
  const cycle = dash.length % 2 === 0 ? dash : [...dash, ...dash]
  for (const segment of cycle) {
    const next = position + segment * unit
    stops.push(`${painted ? color : 'transparent'} ${position}px ${next}px`)
    position = next
    painted = !painted
  }
  return `repeating-linear-gradient(90deg, ${stops.join(', ')})`
}
