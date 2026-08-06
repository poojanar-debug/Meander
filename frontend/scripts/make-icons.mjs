/**
 * The PWA icon set, generated rather than pasted in.
 *
 *     node scripts/make-icons.mjs
 *
 * A PWA needs 192 and 512 px PNGs, a maskable variant, and an Apple touch
 * icon. Adding a rasteriser dependency for four flat-colour images is a poor
 * trade — `sharp` alone is 30 MB — so this draws them directly: a rounded
 * rectangle and a stroked spline, supersampled 4x4 for the edges, encoded as
 * PNG with nothing but `node:zlib`.
 *
 * The output is committed, so a normal build never runs this. It exists so the
 * icons can be regenerated from a description instead of being a binary nobody
 * can edit — change ROUTE or the colours below and re-run.
 *
 * **Maskable is a different drawing, not the same one flagged.** Android crops
 * a maskable icon to whatever shape the launcher uses, keeping only the inner
 * 80% circle. Emitting the standard artwork with `purpose: maskable` is the
 * usual mistake and it clips the corners off the mark; the maskable variant
 * here is drawn smaller against a full-bleed background so nothing that
 * carries meaning is inside the crop zone.
 */

import { deflateSync } from 'node:zlib'
import { mkdirSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const outDir = join(here, '..', 'public')

// Ink from the dark theme, path in the nature green that the app already uses
// for the greenest route. One concept, one colour — the same rule check-palette
// enforces between styles.css and dash.js.
const INK = [27, 36, 48, 255]
const PATH = [63, 174, 112, 255]

/**
 * The mark: a route that meanders from bottom-left to top-right.
 *
 * There was a dot at the far end, meant to read as a destination. At icon sizes
 * it touched the stroke and the whole thing read as a snake with a head, so it
 * is gone — round caps on a clean curve say "path" without it.
 *
 * Generated as a sine offset along a diagonal rather than drawn through control
 * points. Hand-placed points and a Catmull-Rom through them was the first
 * attempt and it produced an angular "S" — a stroke this thick turns any bend
 * tighter than its own width into a corner. A sine has no such bend anywhere,
 * so the curvature is bounded by construction and the mark stays a meander at
 * every size.
 */
const FROM = [0.17, 0.79]
const TO = [0.83, 0.29]
const AMPLITUDE = 0.145
const WAVES = 1 // one full S: out, back through, and out the other side
const STROKE = 0.115

// --- geometry ---------------------------------------------------------------

function meander(samples = 240) {
  const dx = TO[0] - FROM[0]
  const dy = TO[1] - FROM[1]
  const len = Math.hypot(dx, dy)
  // Unit normal to the run, so the wave is perpendicular at every point.
  const nx = -dy / len
  const ny = dx / len
  const out = []
  for (let i = 0; i <= samples; i += 1) {
    const t = i / samples
    const offset = AMPLITUDE * Math.sin(2 * Math.PI * WAVES * t)
    out.push([FROM[0] + dx * t + nx * offset, FROM[1] + dy * t + ny * offset])
  }
  return out
}

/** Distance from a point to a segment — the stroke is the sub-width band. */
function distToSegment(px, py, ax, ay, bx, by) {
  const dx = bx - ax
  const dy = by - ay
  const len2 = dx * dx + dy * dy
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2))
  const cx = ax + t * dx
  const cy = ay + t * dy
  return Math.hypot(px - cx, py - cy)
}

function distToPath(px, py, poly) {
  let best = Infinity
  for (let i = 0; i < poly.length - 1; i += 1) {
    const d = distToSegment(px, py, poly[i][0], poly[i][1], poly[i + 1][0], poly[i + 1][1])
    if (d < best) best = d
  }
  return best
}

/** Signed-ish test for a rounded rectangle covering the whole unit square. */
function insideRoundedSquare(x, y, radius) {
  const cx = Math.min(Math.max(x, radius), 1 - radius)
  const cy = Math.min(Math.max(y, radius), 1 - radius)
  return Math.hypot(x - cx, y - cy) <= radius
}

// --- raster -----------------------------------------------------------------

const SAMPLES = 4 // 4x4 supersampling; enough for flat colour at these sizes

function render(size, { scale = 1, cornerRadius = 0.22, fullBleed = false }) {
  const poly = meander().map(([x, y]) => [
    0.5 + (x - 0.5) * scale,
    0.5 + (y - 0.5) * scale,
  ])
  const stroke = (STROKE * scale) / 2

  const px = Buffer.alloc(size * size * 4)

  for (let py = 0; py < size; py += 1) {
    for (let pxi = 0; pxi < size; pxi += 1) {
      let bg = 0
      let fg = 0
      for (let sy = 0; sy < SAMPLES; sy += 1) {
        for (let sx = 0; sx < SAMPLES; sx += 1) {
          const x = (pxi + (sx + 0.5) / SAMPLES) / size
          const y = (py + (sy + 0.5) / SAMPLES) / size
          if (fullBleed || insideRoundedSquare(x, y, cornerRadius)) bg += 1
          if (distToPath(x, y, poly) <= stroke) fg += 1
        }
      }
      const total = SAMPLES * SAMPLES
      const bgA = bg / total
      // The mark is only ever drawn on the plate, never outside it.
      const fgA = Math.min(fg / total, bgA)

      // Composite: path over ink over transparent.
      const a = bgA
      const mix = (i) => (INK[i] * (bgA - fgA) + PATH[i] * fgA) / (a || 1)
      const o = (py * size + pxi) * 4
      px[o] = Math.round(mix(0))
      px[o + 1] = Math.round(mix(1))
      px[o + 2] = Math.round(mix(2))
      px[o + 3] = Math.round(a * 255)
    }
  }
  return px
}

// --- PNG --------------------------------------------------------------------

const CRC_TABLE = (() => {
  const table = new Int32Array(256)
  for (let n = 0; n < 256; n += 1) {
    let c = n
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c
  }
  return table
})()

function crc32(buf) {
  let c = -1
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8)
  return (c ^ -1) >>> 0
}

function chunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([len, body, crc])
}

function encodePng(size, rgba) {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0)
  ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // truecolour with alpha
  // 10..12: compression, filter and interlace methods, all 0

  // Filter type 0 (None) on every scanline. These are flat-colour images, so
  // the more elaborate filters buy nothing that zlib does not already get.
  const raw = Buffer.alloc(size * (size * 4 + 1))
  for (let y = 0; y < size; y += 1) {
    raw[y * (size * 4 + 1)] = 0
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4)
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

// --- output -----------------------------------------------------------------

const ICONS = [
  { file: 'icon-192.png', size: 192, opts: {} },
  { file: 'icon-512.png', size: 512, opts: {} },
  // Full-bleed and drawn at 62%, so the whole mark survives a circular crop.
  { file: 'icon-maskable-512.png', size: 512, opts: { scale: 0.62, fullBleed: true } },
  // iOS composites onto its own rounded rect and does not honour transparency.
  { file: 'apple-touch-icon.png', size: 180, opts: { cornerRadius: 0, scale: 0.86 } },
  { file: 'favicon-32.png', size: 32, opts: { cornerRadius: 0.16 } },
]

mkdirSync(outDir, { recursive: true })
for (const { file, size, opts } of ICONS) {
  const png = encodePng(size, render(size, opts))
  writeFileSync(join(outDir, file), png)
  console.log(`  ${file.padEnd(24)} ${size}x${size}  ${(png.length / 1024).toFixed(1)} kB`)
}
console.log(`\n${ICONS.length} icons written to public/`)
