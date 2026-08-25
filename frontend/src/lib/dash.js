/**
 * Route identity table.
 *
 * Colour is never the only differentiator: each objective also has a distinct
 * dash pattern on the map and a matching CSS gradient for the swatch in the
 * list, so the routes stay distinguishable in greyscale and to anyone who does
 * not perceive the hue difference.
 *
 * Every colour here is a **graphic**, never text on a surface: route colours
 * clear WCAG's 3:1 threshold for graphical objects but are not held to the
 * 4.5:1 it sets for text, so a route's name is always drawn in --ink and the
 * colour appears only as a line, a dot or a fill.
 *
 * The dash arrays are unchanged from the original build — the patterns already
 * worked, and they are what makes the map survive greyscale. The hues have
 * moved twice since: to DESIGN-HANDOFF §2.3, and then to the 2026 redesign's
 * accent families (docs/DESIGN-2026.md).
 */

/** Mirrors the --route-* custom properties in styles.css.
 *
 * The 2026 redesign commits to one look, so `colorDark` restates `color`
 * rather than carrying a second palette — the field stays because the shape
 * of this table is pinned by dash-palette.test.js, which holds both values
 * against both `:root` blocks in the stylesheet. */
export const OBJECTIVES = [
  {
    id: 'fastest',
    label: 'Fastest',
    color: '#4E7FBE',
    colorDark: '#4E7FBE',
    dash: [1, 0],
    pattern: 'solid',
  },
  {
    id: 'scenic',
    label: 'Scenic',
    color: '#3FA284',
    colorDark: '#3FA284',
    dash: [3, 2],
    pattern: 'dashed',
  },
  {
    id: 'accessible',
    label: 'Accessible',
    color: '#886AAA',
    colorDark: '#886AAA',
    dash: [1, 2],
    pattern: 'dotted',
  },
  {
    id: 'quiet',
    label: 'Quiet',
    color: '#6975B5',
    colorDark: '#6975B5',
    dash: [6, 3],
    pattern: 'long dash',
  },
  {
    id: 'shade',
    label: 'Shade',
    color: '#008C8D',
    colorDark: '#008C8D',
    dash: [5, 2, 1, 2],
    pattern: 'dash-dot',
  },
  {
    id: 'air',
    label: 'Clean air',
    color: '#B87252',
    colorDark: '#B87252',
    dash: [2, 2],
    pattern: 'fine dash',
  },
]

export const DASH = Object.fromEntries(OBJECTIVES.map((o) => [o.id, o]))

const FALLBACK = {
  id: 'unknown',
  label: 'Route',
  color: '#77756C',
  colorDark: '#77756C',
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
 * and cannot resolve `var(--route-scenic)`.
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
