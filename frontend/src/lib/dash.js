/**
 * Route identity table.
 *
 * Colour is never the only differentiator: each objective also has a distinct
 * dash pattern on the map and a matching CSS gradient for the swatch in the
 * list, so the routes stay distinguishable in greyscale and to anyone who does
 * not perceive the hue difference.
 *
 * Every colour here is a **graphic**, never text on paper. `fastest` at 3.34:1
 * against --paper clears the 3:1 threshold WCAG sets for graphical objects but
 * not the 4.5:1 it sets for text, so a route's name is always drawn in --ink
 * and the colour appears only as a line, an edge bar, a swatch or a legend key.
 *
 * The dash arrays are unchanged from the original build — the patterns already
 * worked, and they are what makes the map survive greyscale. Only the hues
 * moved, to DESIGN-HANDOFF §2.3.
 */

/** Mirrors the --route-* custom properties in styles.css. Both are §2.3. */
export const OBJECTIVES = [
  {
    id: 'fastest',
    label: 'Fastest',
    color: '#C2703D',
    colorDark: '#E8A46F',
    dash: [1, 0],
    pattern: 'solid',
  },
  {
    id: 'nature',
    label: 'Nature',
    color: '#2F7D53',
    colorDark: '#6FC38E',
    dash: [3, 2],
    pattern: 'dashed',
  },
  {
    id: 'accessible',
    label: 'Accessible',
    color: '#5B6ECF',
    colorDark: '#95A4F0',
    dash: [1, 2],
    pattern: 'dotted',
  },
  {
    id: 'quiet',
    label: 'Quiet',
    color: '#8A5CB4',
    colorDark: '#C2A0E8',
    dash: [6, 3],
    pattern: 'long dash',
  },
  {
    id: 'shade',
    label: 'Shade',
    color: '#1E7A78',
    colorDark: '#63C4BE',
    dash: [5, 2, 1, 2],
    pattern: 'dash-dot',
  },
  {
    id: 'air',
    label: 'Clean air',
    color: '#B0455F',
    colorDark: '#EE8AA0',
    dash: [2, 2],
    pattern: 'fine dash',
  },
]

export const DASH = Object.fromEntries(OBJECTIVES.map((o) => [o.id, o]))

const FALLBACK = {
  id: 'unknown',
  label: 'Route',
  color: '#55645A',
  colorDark: '#9BAEA1',
  dash: [1, 0],
  pattern: 'solid',
}

export function styleFor(id) {
  return DASH[id] ?? FALLBACK
}

/**
 * The drawing colour for a route under a given theme.
 *
 * Kept as a lookup rather than a CSS variable read because the map needs a
 * literal colour string for `setPaintProperty` — MapLibre paints to a canvas
 * and cannot resolve `var(--route-nature)`.
 */
export function routeColor(id, theme = 'light') {
  const style = styleFor(id)
  return theme === 'dark' ? style.colorDark : style.color
}

/** A CSS background that reproduces the map's dash pattern in a swatch. */
export function swatchBackground(id, theme = 'light') {
  const { dash } = styleFor(id)
  const color = routeColor(id, theme)
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
