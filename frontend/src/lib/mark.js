/**
 * The Meander mark, as geometry and nothing else.
 *
 * A path meandering across the frame: the long way round, which is the whole
 * idea of the application.
 *
 * ## Why this file exists
 *
 * The mark is drawn twice, by two things that cannot share a renderer. The icon
 * set is written pixel by pixel in `scripts/make-icons.mjs` — Node's zlib and a
 * distance-to-segment test, because adding an image library to draw one shape
 * would be absurd — and the in-page logo is an inline SVG in a React component.
 * Two copies of the same curve is how the favicon and the wordmark come to
 * disagree by a turn and a half, with nothing to catch it.
 *
 * **Geometry only, no tokens.** `scripts/tokens.mjs` reads colours out of the
 * stylesheet at build time and says in its own header that nothing under `src/`
 * may import it, because it must never enter the bundle. This module is the
 * other direction — a script importing from `src/` — and it stays safe only
 * because there is nothing in here but numbers. Do not add a colour to it.
 *
 * Colour is applied by each renderer from its own side: `make-icons.mjs` reads
 * `--brand` and `--accent` through `tokens.mjs`, and the in-page SVG uses
 * `currentColor` so it inherits whatever the wordmark beside it is.
 */

/** How many times the path crosses the centre line. */
const TURNS = 2.15

/** Horizontal inset, span, and vertical amplitude, all in unit coordinates. */
const START_X = 0.16
const SPAN_X = 0.68
const AMPLITUDE = 0.245

/**
 * The meander as a polyline in unit coordinates, [0,1] on both axes.
 *
 * 48 segments: enough that the icon generator's 3x3 supersampling has a smooth
 * curve to sample, and few enough that testing every segment against every
 * pixel of a 512px icon stays the cheap part of that script.
 */
export function markPoints(segments = 48) {
  const points = []
  for (let i = 0; i <= segments; i += 1) {
    const t = i / segments
    points.push([START_X + t * SPAN_X, 0.5 + Math.sin(t * Math.PI * TURNS) * AMPLITUDE])
  }
  return points
}

/**
 * The same curve as an SVG path, scaled into a `size`-unit viewBox.
 *
 * Emitted as a polyline rather than as Béziers so that it is provably the same
 * points the icon generator walks. A hand-fitted curve that merely looks the
 * same is the drift this module exists to prevent.
 */
export function markPathD(size = 24, segments = 48) {
  const round = (v) => Math.round(v * 100) / 100
  return markPoints(segments)
    .map(([x, y], i) => `${i === 0 ? 'M' : 'L'}${round(x * size)} ${round(y * size)}`)
    .join(' ')
}
