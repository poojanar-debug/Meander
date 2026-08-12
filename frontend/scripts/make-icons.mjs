import { deflateSync } from 'node:zlib'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { markPoints } from '../src/lib/mark.js'
import { rgb, token } from './tokens.mjs'

/**
 * Draw the icon set. No dependencies — Node's zlib is the only thing needed to
 * write a PNG, and adding an image library to draw one shape would be absurd.
 *
 * **These are generated, never copied.** The set on the branch this came from
 * has the old palette baked into its pixels — a colour that is invisible to the
 * stylesheet gate, invisible to `git diff`, and invisible to review, because it
 * is binary. Regenerating from the tokens is the only way the icons can be held
 * to the same rule as everything else.
 *
 * The mark is a path meandering through a rounded square: the long way round,
 * which is the whole idea of the application.
 */

const here = dirname(fileURLToPath(import.meta.url))
const OUT = join(here, '..', 'public')

/** The dark block only — its accent is the one that reads on the brand ground. */
function darkBlock() {
  const css = readFileSync(join(here, '..', 'src', 'styles.css'), 'utf8')
  const start = css.indexOf("[data-theme='dark']")
  return css.slice(start, css.indexOf('}', start))
}

// Read from the stylesheet so an icon cannot drift from the palette.
export const GROUND = rgb(token('brand')) // the colour the manifest also declares
export const PATH = rgb(token('accent', darkBlock()))

const SIZES = [
  { file: 'favicon-32.png', size: 32, maskable: false, opaque: true },
  { file: 'apple-touch-icon.png', size: 180, maskable: false, opaque: true },
  { file: 'icon-192.png', size: 192, maskable: false, opaque: true },
  { file: 'icon-512.png', size: 512, maskable: false, opaque: true },
  // Full bleed, with the whole mark inside r=0.307 of centre so no launcher
  // mask can clip it.
  { file: 'icon-maskable-512.png', size: 512, maskable: true, opaque: true },
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
 * Signed distance from a point to a line segment. The mark is drawn as a
 * thick polyline, which is exactly "within `w` of the path".
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

// The curve now lives in src/lib/mark.js, so the icon set and the in-page logo
// draw the same shape rather than two hand-matched copies of it. That module is
// geometry and nothing else — no colours — because `tokens.mjs` must never
// enter the bundle and this import goes the other way.

function draw({ size, maskable, opaque }) {
  const pixels = Buffer.alloc(size * size * 4)
  const points = markPoints()

  // The mark occupies a smaller share of a maskable icon so that a circular or
  // squircle launcher mask cannot cut it.
  const inset = maskable ? 0.5 - 0.307 : 0.0
  const scale = maskable ? 0.614 : 1
  const stroke = (maskable ? 0.052 : 0.085) * size
  const radius = maskable ? 0 : size * 0.22

  // 3x3 supersampling. Cheap, and the difference between a clean curve and a
  // staircase at 32px.
  const S = 3

  // The polyline in device coordinates, plus a bounding box. Most of the canvas
  // is nowhere near the path, and testing 48 segments against every pixel of a
  // 512px icon is most of this script's cost.
  const device = points.map(([x, y]) => [(inset + x * scale) * size, (inset + y * scale) * size])
  const pad = stroke / 2 + 2
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

          // Rounded-square ground, or full bleed when maskable.
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
            for (let i = 1; i < device.length && nearest > stroke / 2; i += 1) {
              nearest = Math.min(
                nearest,
                distanceToSegment(px, py, device[i - 1][0], device[i - 1][1], device[i][0], device[i][1]),
              )
            }
            if (nearest <= stroke / 2) inPath += 1
          }
        }
      }

      const total = S * S
      const groundA = inGround / total
      const pathA = inPath / total
      const i = (y * size + x) * 4

      // Path over ground, ground over nothing.
      const r = Math.round(GROUND[0] * (1 - pathA) + PATH[0] * pathA)
      const g = Math.round(GROUND[1] * (1 - pathA) + PATH[1] * pathA)
      const b = Math.round(GROUND[2] * (1 - pathA) + PATH[2] * pathA)
      pixels[i] = r
      pixels[i + 1] = g
      pixels[i + 2] = b
      pixels[i + 3] = opaque && radius === 0 ? 255 : Math.round(255 * groundA)
    }
  }

  return encodePng(size, size, pixels)
}

mkdirSync(OUT, { recursive: true })
for (const spec of SIZES) {
  const png = draw(spec)
  writeFileSync(join(OUT, spec.file), png)
  console.log(`${spec.file.padEnd(24)} ${spec.size}x${spec.size}  ${png.length} bytes`)
}
