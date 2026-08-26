import { deflateSync } from 'node:zlib'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { MARK_BOX, MARK_PATH_D, MARK_STROKE, MARK_STROKE_SMALL, markPoints } from '../src/lib/mark.js'
import { rgb, token } from './tokens.mjs'

/**
 * Draw the icon set and the SVG favicon. No dependencies — Node's zlib is the
 * only thing needed to write a PNG, and adding an image library to draw one
 * shape would be absurd.
 *
 * **These are generated, never copied.** The set on the branch this came from
 * has the old palette baked into its pixels — a colour that is invisible to the
 * stylesheet gate, invisible to `git diff`, and invisible to review, because it
 * is binary. Regenerating from the tokens is the only way the icons can be held
 * to the same rule as everything else.
 *
 * That rule is also why `favicon.svg` is emitted here rather than written by
 * hand. A standalone file under `public/` cannot read a custom property out of
 * the stylesheet — nothing resolves `var(--sky-deep)` for a document the
 * browser loads as an icon — so the only two options are a hex someone typed
 * and a hex a script read from the token. This is the second one, which is what
 * "never hard-code, reference the token" has to mean for a file that ships as
 * its own document.
 *
 * The mark is the meander line: a single wandering path, round-capped, no fill.
 * Its geometry lives in src/lib/mark.js and is stated once there; this script
 * takes the polyline, and the favicon takes the same curve's `d` attribute.
 */

const here = dirname(fileURLToPath(import.meta.url))
const OUT = join(here, '..', 'public')

// Read from the stylesheet so an icon cannot drift from the palette.
export const GROUND = rgb(token('sky-wash')) // the tile
export const STROKE = rgb(token('sky-deep')) // the line

/**
 * The mark's share of a tile's width, and the tile's corner radius.
 *
 * The design says "the centered mark at ~55% of tile width". That has two
 * readings and they differ visibly, so it was put back to design and settled:
 * 55% is the width of the LINE, not of the box the line is drawn in. The
 * design's own sentence — "the mark is always the line alone" — says which
 * one the word "mark" means.
 *
 * The line occupies the middle 78.125% of its 48-unit box (x from 5.25 to
 * 42.75 with the stroke on), so the box has to be 0.55 / 0.78125 = 0.704 of
 * the tile for the ink to land on 0.55 of it. That is where this number comes
 * from; it is not a taste.
 *
 * It is close to a real ceiling, which is worth knowing before anyone raises
 * it again. The furthest ink sits at 0.4300 of the mark box from its centre,
 * so a 0.704 box carries it to 0.3027 of the tile against the 0.307
 * launcher-mask safe radius icons.test.js enforces — 2.2px of margin on a
 * 512px tile. Only the maskable file is bound by it, but the set is drawn at
 * one scale on purpose.
 *
 * 22.5% radius is stated outright: a 120px tile takes 27px, which is the
 * usual approximation of the iOS squircle.
 */
const MARK_SHARE = 0.704
const TILE_RADIUS = 0.225

/**
 * What ground each file gets.
 *
 *   rounded  a sky-wash tile with the corners cut away, for the manifest icons
 *   square   full bleed, for the two grounds a platform masks itself: iOS
 *            rounds the apple-touch-icon, and an Android launcher applies its
 *            own mask to the maskable one. Pre-rounding either means a visible
 *            seam inside the platform's own corner.
 *   none     no tile at all: the line, transparent behind it, for the favicon
 *
 * The favicon is the one file drawn at the small-size stroke weight. It is
 * declared 32px and displayed at 16 in every browser tab there is.
 */
const SIZES = [
  { file: 'favicon-32.png', size: 32, ground: 'none', share: 1, stroke: MARK_STROKE_SMALL },
  { file: 'apple-touch-icon.png', size: 180, ground: 'square', share: MARK_SHARE, stroke: MARK_STROKE },
  { file: 'icon-192.png', size: 192, ground: 'rounded', share: MARK_SHARE, stroke: MARK_STROKE },
  { file: 'icon-512.png', size: 512, ground: 'rounded', share: MARK_SHARE, stroke: MARK_STROKE },
  { file: 'icon-maskable-512.png', size: 512, ground: 'square', share: MARK_SHARE, stroke: MARK_STROKE },
]

// ---------------------------------------------------------------- PNG writing

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  return c >>> 0
})

function crc32(buf) {
  let c = 0xffffffff
  for (const byte of buf) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function chunk(type, data) {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([length, body, crc])
}

/** RGBA pixel buffer → a PNG file. */
function encodePng(width, height, pixels) {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // colour type: RGBA
  // 10, 11, 12 stay zero: deflate, adaptive filtering, no interlace.

  // One filter byte per scanline. Filter 0 (None) throughout: the shapes here
  // are flat colour, so nothing more elaborate earns its complexity.
  const raw = Buffer.alloc(height * (width * 4 + 1))
  for (let y = 0; y < height; y += 1) {
    raw[y * (width * 4 + 1)] = 0
    pixels.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4)
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

// ------------------------------------------------------------------- drawing

/**
 * Distance from a point to a line segment. The mark is drawn as a thick
 * polyline, which is exactly "within `w` of the path" — and testing the
 * distance to the *segment* rather than to the infinite line is what gives the
 * two endpoints their round caps and every joint its round join, for free and
 * without a special case. That is the same shape the SVG asks for with
 * stroke-linecap="round".
 */
function distanceToSegment(px, py, ax, ay, bx, by) {
  const dx = bx - ax
  const dy = by - ay
  const lengthSq = dx * dx + dy * dy
  const t = lengthSq === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / lengthSq))
  const cx = ax + t * dx
  const cy = ay + t * dy
  return Math.hypot(px - cx, py - cy)
}

// The curve lives in src/lib/mark.js, so the icon set, the favicon and the
// in-page lockup draw the same shape rather than three hand-matched copies of
// it. That module is geometry and nothing else — no colours — because
// `tokens.mjs` must never enter the bundle and this import goes the other way.

function draw({ size, ground, share, stroke }) {
  const pixels = Buffer.alloc(size * size * 4)
  const points = markPoints()

  // The mark's own 48-unit box, placed in the centre of the tile at its
  // stated share of the width. Everything about the mark scales with the box,
  // stroke included, so the line keeps its weight relative to the curve.
  const box = share * size
  const origin = (size - box) / 2
  const strokePx = (stroke / MARK_BOX) * box
  const radius = ground === 'rounded' ? size * TILE_RADIUS : 0

  // 3x3 supersampling. Cheap, and the difference between a clean curve and a
  // staircase at 32px.
  const S = 3

  // The polyline in device coordinates, plus a bounding box. Most of the canvas
  // is nowhere near the path, and testing 48 segments against every pixel of a
  // 512px icon is most of this script's cost.
  const device = points.map(([x, y]) => [origin + (x / MARK_BOX) * box, origin + (y / MARK_BOX) * box])
  const pad = strokePx / 2 + 2
  const minX = Math.min(...device.map((p) => p[0])) - pad
  const maxX = Math.max(...device.map((p) => p[0])) + pad
  const minY = Math.min(...device.map((p) => p[1])) - pad
  const maxY = Math.max(...device.map((p) => p[1])) + pad
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      let inGround = 0
      let inPath = 0
      const nearPath = x + 1 >= minX && x <= maxX && y + 1 >= minY && y <= maxY
      for (let sy = 0; sy < S; sy += 1) {
        for (let sx = 0; sx < S; sx += 1) {
          const px = x + (sx + 0.5) / S
          const py = y + (sy + 0.5) / S

          // Rounded-square ground, or full bleed when the platform masks it.
          if (radius === 0) inGround += 1
          else {
            const qx = Math.abs(px - size / 2) - (size / 2 - radius)
            const qy = Math.abs(py - size / 2) - (size / 2 - radius)
            const d =
              Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - radius
            if (d <= 0) inGround += 1
          }

          if (nearPath) {
            let nearest = Infinity
            for (let i = 1; i < device.length && nearest > strokePx / 2; i += 1) {
              nearest = Math.min(
                nearest,
                distanceToSegment(px, py, device[i - 1][0], device[i - 1][1], device[i][0], device[i][1]),
              )
            }
            if (nearest <= strokePx / 2) inPath += 1
          }
        }
      }

      const total = S * S
      const groundA = inGround / total
      const pathA = inPath / total
      const i = (y * size + x) * 4

      if (ground === 'none') {
        // No tile: the line and nothing behind it. PNG alpha is not
        // premultiplied, so every pixel carries the stroke colour and the
        // coverage goes in the alpha channel — which is what lets a browser
        // composite the edge cleanly against a tab strip of any colour.
        pixels[i] = STROKE[0]
        pixels[i + 1] = STROKE[1]
        pixels[i + 2] = STROKE[2]
        pixels[i + 3] = Math.round(255 * pathA)
        continue
      }

      // Path over ground, ground over nothing.
      pixels[i] = Math.round(GROUND[0] * (1 - pathA) + STROKE[0] * pathA)
      pixels[i + 1] = Math.round(GROUND[1] * (1 - pathA) + STROKE[1] * pathA)
      pixels[i + 2] = Math.round(GROUND[2] * (1 - pathA) + STROKE[2] * pathA)
      pixels[i + 3] = ground === 'square' ? 255 : Math.round(255 * groundA)
    }
  }

  return encodePng(size, size, pixels)
}

/**
 * The favicon, as the curve itself rather than a sampling of it.
 *
 * Same `d` the in-page lockup renders, same small-size stroke weight as
 * favicon-32.png, and the colour read from the token above rather than typed.
 * `stroke-linejoin` is stated even though the two curves meet with a shared
 * tangent and no join is visible: it is what the rasteriser produces, and the
 * three renderers are meant to be describing one shape, not agreeing by
 * accident.
 */
function faviconSvg() {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${MARK_BOX} ${MARK_BOX}" width="${MARK_BOX}" height="${MARK_BOX}" fill="none">
  <path d="${MARK_PATH_D}" stroke="${token('sky-deep')}" stroke-width="${MARK_STROKE_SMALL}" stroke-linecap="round" stroke-linejoin="round"/>
</svg>
`
}

mkdirSync(OUT, { recursive: true })
for (const spec of SIZES) {
  const png = draw(spec)
  writeFileSync(join(OUT, spec.file), png)
  console.log(`${spec.file.padEnd(24)} ${spec.size}x${spec.size}  ${png.length} bytes`)
}
const svg = faviconSvg()
writeFileSync(join(OUT, 'favicon.svg'), svg)
console.log(`${'favicon.svg'.padEnd(24)} ${MARK_BOX}x${MARK_BOX}  ${Buffer.byteLength(svg)} bytes`)
