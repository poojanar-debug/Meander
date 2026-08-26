/**
 * The Meander mark, as geometry and nothing else.
 *
 * A single line wandering across the frame: the long way round, which is the
 * whole idea of the application.
 *
 * ## Why this file exists
 *
 * The mark is drawn by three things that cannot share a renderer. The launcher
 * icons are written pixel by pixel in `scripts/make-icons.mjs` — Node's zlib
 * and a distance-to-segment test, because adding an image library to draw one
 * shape would be absurd. The favicon is an SVG file emitted by that same
 * script. The in-page lockup is an inline SVG in a React component. Three
 * copies of one curve is how a favicon and a wordmark come to disagree by half
 * a turn, with nothing to catch it.
 *
 * So the curve is stated once, here, as control points — and every consumer
 * takes either `MARK_PATH_D` (the SVG renderers) or `markPoints()` (the pixel
 * renderer) from this module. The two are the same four points evaluated two
 * ways, not two drawings that happen to look alike.
 *
 * **Geometry only, no tokens.** `scripts/tokens.mjs` reads colours out of the
 * stylesheet at build time and says in its own header that nothing under `src/`
 * may import it, because it must never enter the bundle. This module is the
 * other direction — a script importing from `src/` — and it stays safe only
 * because there is nothing in here but numbers. Do not add a colour to it.
 *
 * Colour is applied by each renderer from its own side: `make-icons.mjs` reads
 * `--sky-deep` and `--sky-wash` through `tokens.mjs`, and the in-page SVG uses
 * `currentColor` so it inherits the colour the stylesheet sets on the lockup.
 */

/**
 * The approved mark: two cubic Béziers, control points in the 48-unit box.
 *
 * These four points per curve are the whole design. `MARK_PATH_D` below is
 * emitted from them and `mark.test.js` pins that emission to the approved
 * string character for character, so the array and the published `d` attribute
 * cannot come apart.
 */
const CURVES = [
  [
    [8, 32],
    [14, 14],
    [20, 14],
    [24, 24],
  ],
  [
    [24, 24],
    [28, 34],
    [34, 34],
    [40, 16],
  ],
]

/** The side of the square the geometry is stated in: `viewBox="0 0 48 48"`. */
export const MARK_BOX = 48

/** Stroke width in box units, as approved. */
export const MARK_STROKE = 5.5

/**
 * The heavier weight for a small render.
 *
 * The design permits 6–7 at or below a 24px box, where 5.5 units resolves to
 * under three device pixels and the line reads as grey rather than as a line.
 * 6.5 is the middle of that range: enough to survive a 16px browser tab, not
 * so much that the two inner bends close up into a blob.
 */
export const MARK_STROKE_SMALL = 6.5

/** At or below this rendered box size, in CSS pixels, the line wants the bump. */
export const SMALL_BOX_PX = 24

/** The stroke width for a mark rendered into a `boxPx`-pixel square. */
export function markStroke(boxPx) {
  return boxPx <= SMALL_BOX_PX ? MARK_STROKE_SMALL : MARK_STROKE
}

/** One coordinate of a cubic Bézier at `t`. */
function cubic(p0, p1, p2, p3, t) {
  const u = 1 - t
  return u * u * u * p0 + 3 * u * u * t * p1 + 3 * u * t * t * p2 + t * t * t * p3
}

/** Trim a computed coordinate to two places without leaving `1.00` behind. */
const round = (v) => Number(v.toFixed(2))

/**
 * The approved path data, in box units.
 *
 * Emitted from `CURVES` rather than written out, so that the string the SVG
 * renderers publish and the points the pixel renderer walks cannot be edited
 * apart from one another. The result is the approved geometry verbatim:
 *
 *     M8 32 C14 14 20 14 24 24 C28 34 34 34 40 16
 *
 * The second curve's first point is the first curve's last, so it is implied by
 * the `C` rather than restated — which is what the approved string does too.
 */
export const MARK_PATH_D = CURVES.reduce(
  (d, [, c1, c2, p3]) =>
    `${d} C${round(c1[0])} ${round(c1[1])} ${round(c2[0])} ${round(c2[1])} ${round(p3[0])} ${round(p3[1])}`,
  `M${round(CURVES[0][0][0])} ${round(CURVES[0][0][1])}`,
)

/**
 * The same curve as a polyline, in box units, for a renderer with no Béziers.
 *
 * 24 segments per curve — 48 in all, the same count the sine polyline this
 * replaced used. Measured against the true curve, that is a maximum deviation
 * of 0.017 box units, which is 0.10 of a device pixel in the largest icon this
 * project ships (a 512px tile with the mark box at 55% of it). Doubling it buys
 * 0.05px and costs the icon generator, which tests every segment against every
 * pixel, twice the work.
 */
export function markPoints(perCurve = 24) {
  const points = [[...CURVES[0][0]]]
  for (const [p0, c1, c2, p3] of CURVES) {
    for (let i = 1; i <= perCurve; i += 1) {
      const t = i / perCurve
      points.push([
        cubic(p0[0], c1[0], c2[0], p3[0], t),
        cubic(p0[1], c1[1], c2[1], p3[1], t),
      ])
    }
  }
  return points
}
