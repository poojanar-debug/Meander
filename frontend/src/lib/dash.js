/**
 * Route identity table.
 *
 * Colour is never the only differentiator: each objective also has a distinct
 * dash pattern on the map and a matching CSS gradient for the swatch in the
 * list, so the routes stay distinguishable in greyscale and to anyone who does
 * not perceive the hue difference.
 */

export const OBJECTIVES = [
  { id: 'fastest', label: 'Fastest', color: '#2f6fd0', dash: [1, 0], pattern: 'solid' },
  { id: 'nature', label: 'Nature', color: '#2e8b57', dash: [3, 2], pattern: 'dashed' },
  { id: 'accessible', label: 'Accessible', color: '#7a4fc4', dash: [1, 2], pattern: 'dotted' },
  { id: 'quiet', label: 'Quiet', color: '#b06a1f', dash: [6, 3], pattern: 'long dash' },
  { id: 'shade', label: 'Shade', color: '#12756c', dash: [5, 2, 1, 2], pattern: 'dash-dot' },
  { id: 'air', label: 'Clean air', color: '#b03050', dash: [2, 2], pattern: 'fine dash' },
]

export const DASH = Object.fromEntries(OBJECTIVES.map((o) => [o.id, o]))

const FALLBACK = { id: 'unknown', label: 'Route', color: '#5f6b80', dash: [1, 0], pattern: 'solid' }

export function styleFor(id) {
  return DASH[id] ?? FALLBACK
}

/** A CSS background that reproduces the map's dash pattern in a swatch. */
export function swatchBackground(id) {
  const { color, dash } = styleFor(id)
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
