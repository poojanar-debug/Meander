import { execFileSync } from 'node:child_process'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { inflateSync } from 'node:zlib'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import { MARK_BOX, MARK_PATH_D, MARK_STROKE, MARK_STROKE_SMALL, markPoints } from './mark.js'

// The icons carry colour, and colour in a PNG is invisible to every gate this
// project has: the stylesheet scanner does not read them, `git diff` does not
// show them, and review cannot see them. So the check is that the *pixels*
// match the tokens — which is also what makes "regenerate, never copy" a rule
// with teeth rather than a note in a commit message.
//
// Colour is only half of it, and for a while it was the only half. Every
// assertion here used to be satisfiable by a tile with no mark on it at all:
// the ramp check passes on one flat colour because that colour sits at t=0,
// and the safe-radius check was a bare `if` over stroke pixels that never
// required any to exist. Measured, not supposed — five blank tiles passed the
// whole file. So the geometry is now asserted positively, by comparing where
// the ink actually lands against where src/lib/mark.js says the curve is.

const here = dirname(fileURLToPath(import.meta.url))
const FRONTEND = join(here, '..', '..')
const PUBLIC = join(FRONTEND, 'public')
const css = readFileSync(join(FRONTEND, 'src', 'styles.css'), 'utf8')

const tokenValue = (name) => css.match(new RegExp(`--${name}\\s*:\\s*([^;]+);`))[1].trim()

const hexToRgb = (hex) => {
  const value = Number.parseInt(hex.slice(1), 16)
  return [(value >> 16) & 255, (value >> 8) & 255, value & 255]
}

const GROUND = hexToRgb(tokenValue('sky-wash'))
const STROKE = hexToRgb(tokenValue('sky-deep'))

/** Minimal PNG reader: IHDR plus the inflated, unfiltered RGBA scanlines. */
function decodePng(buffer) {
  let offset = 8
  let width = 0
  let height = 0
  const idat = []
  while (offset < buffer.length) {
    const length = buffer.readUInt32BE(offset)
    const type = buffer.toString('latin1', offset + 4, offset + 8)
    const data = buffer.subarray(offset + 8, offset + 8 + length)
    if (type === 'IHDR') {
      width = data.readUInt32BE(0)
      height = data.readUInt32BE(4)
      expect(data[8], 'bit depth').toBe(8)
      expect(data[9], 'colour type RGBA').toBe(6)
    }
    if (type === 'IDAT') idat.push(data)
    offset += 12 + length
  }
  const raw = inflateSync(Buffer.concat(idat))
  const pixels = Buffer.alloc(width * height * 4)
  const stride = width * 4
  for (let y = 0; y < height; y += 1) {
    // The generator writes filter 0 on every scanline; anything else means it
    // changed and this reader would silently mis-decode.
    expect(raw[y * (stride + 1)], `scanline ${y} filter`).toBe(0)
    raw.copy(pixels, y * stride, y * (stride + 1) + 1, (y + 1) * (stride + 1))
  }
  return { width, height, pixels }
}

const pixelAt = ({ width, pixels }, x, y) => {
  const i = (y * width + x) * 4
  return [pixels[i], pixels[i + 1], pixels[i + 2], pixels[i + 3]]
}

const read = (file) => decodePng(readFileSync(join(PUBLIC, file)))

/**
 * The set, and the contract each file is held to.
 *
 *   share    the mark's 48-unit box as a fraction of the tile's width. 0.704
 *            is what puts the LINE on 55% of the tile, which is what the
 *            design's "~55% of tile width" turned out to mean
 *   tile     'rounded' cuts the corners at 22.5%; 'square' is full bleed for
 *            the two grounds a platform masks itself; 'none' is the favicon,
 *            which is the line on nothing at all
 *   stroke   the weight in box units. Only the favicon takes the design's
 *            small-size bump, and it takes it because it is displayed at 16px
 *            in a tab whatever size the file declares
 *
 * Stated here rather than imported from scripts/make-icons.mjs on purpose: a
 * test that reads the generator's own constants asserts only that the
 * generator agrees with itself. Carrying the weight per row rather than
 * assuming MARK_STROKE for all five is what makes the extent check below say
 * anything about the favicon, whose stroke is the one that differs.
 */
const EXPECTED = [
  ['favicon-32.png', 32, 1, 'none', MARK_STROKE_SMALL],
  ['apple-touch-icon.png', 180, 0.704, 'square', MARK_STROKE],
  ['icon-192.png', 192, 0.704, 'rounded', MARK_STROKE],
  ['icon-512.png', 512, 0.704, 'rounded', MARK_STROKE],
  ['icon-maskable-512.png', 512, 0.704, 'square', MARK_STROKE],
]

/** Is this pixel on the line rather than on the ground behind it? */
function isInk(png, x, y, tile) {
  const [r, , , a] = pixelAt(png, x, y)
  if (tile === 'none') return a > 128
  // The ramp between the two tokens, read off the channel that separates them
  // furthest. Half way is the edge of the stroke.
  return (r - GROUND[0]) / (STROKE[0] - GROUND[0]) > 0.5
}

/** Where the ink actually is, and how much of it there is. */
function inkExtent(png, tile) {
  let minX = Infinity
  let maxX = -Infinity
  let minY = Infinity
  let maxY = -Infinity
  let count = 0
  for (let y = 0; y < png.height; y += 1) {
    for (let x = 0; x < png.width; x += 1) {
      if (!isInk(png, x, y, tile)) continue
      count += 1
      if (x < minX) minX = x
      if (x > maxX) maxX = x
      if (y < minY) minY = y
      if (y > maxY) maxY = y
    }
  }
  return { minX, maxX, minY, maxY, count }
}

/**
 * How much ink a correctly drawn mark puts on the tile, in pixels.
 *
 * A stroked polyline is its length times its width, plus one full circle for
 * the two round half-caps at the ends. Measured against the shipped files that
 * model is accurate to 0.6%, and it is the only thing in this suite with an
 * opinion about the STROKE WEIGHT — the extent check cannot have one, because
 * a weight change moves each edge by half the difference, which at 32px is a
 * third of a pixel and disappears inside its tolerance.
 */
function expectedInk(size, share, stroke) {
  const box = share * size
  const device = markPoints().map(([x, y]) => [(x / MARK_BOX) * box, (y / MARK_BOX) * box])
  let length = 0
  for (let i = 1; i < device.length; i += 1) {
    length += Math.hypot(device[i][0] - device[i - 1][0], device[i][1] - device[i - 1][1])
  }
  const width = (stroke / MARK_BOX) * box
  return length * width + Math.PI * (width / 2) ** 2
}

/** Where src/lib/mark.js says the ink should be, in device pixels. */
function expectedExtent(size, share, stroke) {
  const box = share * size
  const origin = (size - box) / 2
  const half = stroke / 2
  const xs = markPoints().map(([x]) => x)
  const ys = markPoints().map(([, y]) => y)
  const place = (v) => origin + (v / MARK_BOX) * box
  return {
    minX: place(Math.min(...xs) - half),
    maxX: place(Math.max(...xs) + half),
    minY: place(Math.min(...ys) - half),
    maxY: place(Math.max(...ys) + half),
  }
}

/**
 * Points that must be ink, and points that must not be.
 *
 * The extent check above fixes the mark's scale and position, and cannot fix
 * its shape: the approved curve's stroked bounding box is symmetric about both
 * axes, so an icon set drawn upside down produces exactly the same extents and
 * ships green. That is not a hypothetical bug — confusing SVG's y-down with a
 * y-up pixel buffer is the classic mistake for a hand-rolled rasteriser, and
 * this project has one.
 *
 * So: sample the curve itself, and sample its reflection. The mark is
 * 180-degree rotationally symmetric about the box centre, which means a
 * rotation is the same drawing and a *reflection* is a different one. Every
 * sampled point on the real curve must be ink; every reflected point that is
 * clear of the real curve by a full stroke width must be ground.
 */
function shapeProbes(size, share, stroke) {
  const box = share * size
  const origin = (size - box) / 2
  const place = ([x, y]) => [
    Math.round(origin + (x / MARK_BOX) * box),
    Math.round(origin + (y / MARK_BOX) * box),
  ]
  const curve = markPoints()
  const on = []
  const off = []
  for (let i = 2; i < curve.length - 2; i += 2) {
    const [x, y] = curve[i]
    on.push(place([x, y]))
    const mirror = [x, MARK_BOX - y]
    const clear = Math.min(...curve.map(([cx, cy]) => Math.hypot(mirror[0] - cx, mirror[1] - cy)))
    // Near the middle the curve and its reflection cross, so those probes say
    // nothing and are dropped rather than fudged.
    if (clear > stroke) off.push(place(mirror))
  }
  return { on, off }
}

describe('the icon set', () => {
  it.each(EXPECTED)('%s is a %ipx square PNG', (file, size) => {
    const png = read(file)
    expect(png.width).toBe(size)
    expect(png.height).toBe(size)
  })

  it.each(EXPECTED)('%s draws the mark, at the size and place mark.js states', (file, size, share, tile, stroke) => {
    // The assertion the rest of this file could not make. A blank tile has no
    // ink at all and fails on the count; a mark drawn at the wrong scale, off
    // centre, or in the unit coordinates the curve used before it moved to the
    // 48-unit box fails on the extent, by tens of pixels rather than by one.
    //
    // The comparison is between spans, not indices: pixel column i covers
    // [i, i+1), so the ink's right edge is maxX + 1. Measured against the
    // approved geometry the five files agree to within half a pixel, which is
    // where an antialiased edge crosses the halfway point; the tolerance is a
    // whole pixel so that a rounding change is not a failure.
    const png = read(file)
    const { count, ...ink } = inkExtent(png, tile)
    // A blank tile has no ink and lands at 0. A mark drawn at the wrong stroke
    // weight lands 17-20% out — measured, by drawing favicon-32 at the lockup's
    // 5.5 instead of its own 6.5 and watching this number move from 1.006 to
    // 1.204. 3% is the room antialiasing and the flattening need, and nothing
    // more.
    const ratio = count / expectedInk(size, share, stroke)
    expect(ratio, `${file} ink area is ${count}px`).toBeGreaterThan(0.97)
    expect(ratio, `${file} ink area is ${count}px`).toBeLessThan(1.03)

    const want = expectedExtent(size, share, stroke)
    const actual = { minX: ink.minX, maxX: ink.maxX + 1, minY: ink.minY, maxY: ink.maxY + 1 }
    const off = Object.fromEntries(
      Object.keys(want).map((edge) => [edge, Number((actual[edge] - want[edge]).toFixed(2))]),
    )
    const wrong = Object.entries(off).filter(([, d]) => Math.abs(d) > 1)
    expect(wrong, `${file} ink is not where mark.js puts it: ${JSON.stringify(off)}`).toEqual([])
  })

  it.each(EXPECTED)('%s draws the meander, not its reflection', (file, size, share, tile, stroke) => {
    // The shape check the bounding box cannot make. Collected and asserted
    // once rather than per probe, for the reason the forbidden-colour loop
    // below records.
    const png = read(file)
    const { on, off } = shapeProbes(size, share, stroke)
    expect(off.length, 'no usable reflected probes').toBeGreaterThan(4)
    const wrong = [
      ...on.filter(([x, y]) => !isInk(png, x, y, tile)).map((p) => `no ink on the curve at ${p}`),
      ...off.filter(([x, y]) => isInk(png, x, y, tile)).map((p) => `ink where the curve is not, at ${p}`),
    ]
    expect(wrong.slice(0, 6), file).toEqual([])
  })

  it.each(EXPECTED)('%s uses only the tokens from the stylesheet', (file, size, share, tile) => {
    // The reason this capability regenerates rather than copies: the committed
    // set on the source branch has the old palette baked into its pixels.
    const png = read(file)

    const seen = new Set()
    for (let i = 0; i < png.pixels.length; i += 4) {
      if (png.pixels[i + 3] === 0) continue
      seen.add(`${png.pixels[i]},${png.pixels[i + 1]},${png.pixels[i + 2]}`)
    }

    if (tile === 'none') {
      // No ground to blend with: the favicon is one colour and a coverage
      // channel, which is what lets a browser composite it against a tab strip
      // of any colour at all.
      expect([...seen]).toEqual([STROKE.join(',')])
      return
    }

    // Antialiasing blends the two, so every opaque pixel must lie on the line
    // between them — no third colour anywhere.
    for (const key of seen) {
      const [r, g, b] = key.split(',').map(Number)
      const t = (r - GROUND[0]) / (STROKE[0] - GROUND[0] || 1)
      expect(t, `${file}: ${key} is not on the ramp`).toBeGreaterThanOrEqual(-0.02)
      expect(t).toBeLessThanOrEqual(1.02)
      expect(Math.abs(GROUND[1] + t * (STROKE[1] - GROUND[1]) - g), `${key} green`).toBeLessThan(3)
      expect(Math.abs(GROUND[2] + t * (STROKE[2] - GROUND[2]) - b), `${key} blue`).toBeLessThan(3)
    }
    // Both ends of the ramp are actually present. Without this the check above
    // is satisfied by a tile of one flat colour, which is how five blank icons
    // once passed it.
    expect(seen, `${file} has no ground`).toContain(GROUND.join(','))
    expect(seen, `${file} has no stroke`).toContain(STROKE.join(','))
  })

  it('carries no colour from a palette this project has left', () => {
    // The constants baked into blobs this repository has shipped before: the
    // pre-2026 pair, and the launcher green the sky mark replaced. Each was
    // invisible to `git diff` and to review, because it was binary.
    const forbidden = [
      [27, 36, 48], // #1b2430
      [63, 174, 112], // #3fae70
      [28, 70, 51], // #1c4633, the old icon ground
      [143, 211, 169], // #8fd3a9, the old icon stroke
    ]
    // One expect() per run, not one per pixel. The assertion is unchanged —
    // any pixel matching either constant still fails, still names the file and
    // the colour — but the loop below used to call expect() 1.3 million times
    // (5 icons x up to 512x512 px x 2 colours) and each call builds matcher
    // state whether or not it fails. That cost 14.6 s against vitest's 5 s
    // default on the 2-OCPU ARM VM this deploys to, so the gate failed on
    // hardware rather than on colour. Collect the hits, assert once.
    const hits = []
    for (const [file] of EXPECTED) {
      const png = read(file)
      for (let i = 0; i < png.pixels.length; i += 4) {
        for (const [r, g, b] of forbidden) {
          if (png.pixels[i] === r && png.pixels[i + 1] === g && png.pixels[i + 2] === b) {
            hits.push(`${file} contains ${r},${g},${b}`)
          }
        }
      }
    }
    expect([...new Set(hits)]).toEqual([])
  })

  it('makes the maskable variant full-bleed and keeps the mark inside the safe radius', () => {
    const png = read('icon-maskable-512.png')
    // Full bleed: the corners are painted, so no launcher mask reveals a gap.
    for (const [x, y] of [
      [0, 0],
      [511, 0],
      [0, 511],
      [511, 511],
    ]) {
      expect(pixelAt(png, x, y)[3], `corner ${x},${y}`).toBe(255)
    }

    // Every ink pixel within r = 0.307 * size of centre. Collected and
    // asserted once, for the reason the forbidden-colour loop above records.
    const centre = 256
    const safe = 0.307 * 512
    let worst = 0
    let at = null
    for (let y = 0; y < 512; y += 1) {
      for (let x = 0; x < 512; x += 1) {
        if (!isInk(png, x, y, 'square')) continue
        const r = Math.hypot(x - centre, y - centre)
        if (r > worst) {
          worst = r
          at = `${x},${y}`
        }
      }
    }
    expect(at, 'no mark to measure').not.toBeNull()
    expect(worst, `furthest mark pixel at ${at}`).toBeLessThanOrEqual(safe)
  })

  it('leaves the apple-touch icon square, because iOS rounds it itself', () => {
    // Pre-rounding it puts the app's own corner inside the one the system
    // draws, and the seam between them is visible on a home screen.
    const png = read('apple-touch-icon.png')
    for (const [x, y] of [
      [0, 0],
      [179, 0],
      [0, 179],
      [179, 179],
    ]) {
      const [r, g, b, a] = pixelAt(png, x, y)
      expect(a, `corner ${x},${y} alpha`).toBe(255)
      expect([r, g, b], `corner ${x},${y} colour`).toEqual(GROUND)
    }
  })

  it('keeps the manifest icons opaque to the edge of the rounded tile', () => {
    const png = read('icon-512.png')
    expect(pixelAt(png, 256, 2)[3]).toBe(255) // top edge, mid-width
    expect(pixelAt(png, 2, 256)[3]).toBe(255) // left edge, mid-height
    expect(pixelAt(png, 1, 1)[3]).toBe(0) // corner is rounded away
  })

  it('gives the favicon a transparent ground, so a dark tab strip shows through', () => {
    const png = read('favicon-32.png')
    for (const [x, y] of [
      [0, 0],
      [31, 0],
      [0, 31],
      [31, 31],
      [16, 1],
    ]) {
      expect(pixelAt(png, x, y)[3], `${x},${y} should be clear`).toBe(0)
    }
  })

  // 30 s, not the 5 s default. This test shells out to the generator and draws
  // five PNGs; it measured 5018 ms on the deployment VM, which against a 5000 ms
  // default is a coin toss rather than a gate. The number is patience, not
  // tolerance — nothing about what it accepts has changed.
  it('regenerates identically — the files in git are the files the script draws', () => {
    // If this fails, someone hand-edited an icon or changed a token without
    // re-running the generator.
    const generated = readdirSync(PUBLIC).filter((f) => /\.(png|svg)$/.test(f))
    const before = Object.fromEntries(generated.map((f) => [f, readFileSync(join(PUBLIC, f))]))
    expect(generated, 'the generator writes an SVG too').toContain('favicon.svg')
    execFileSync('node', [join(FRONTEND, 'scripts', 'make-icons.mjs')], { stdio: 'ignore' })
    for (const [file, bytes] of Object.entries(before)) {
      const now = readFileSync(join(PUBLIC, file))
      if (file.endsWith('.svg')) {
        // Text, so bytes are the honest comparison and a diff is readable.
        expect(now.toString('utf8'), `${file} changed`).toBe(bytes.toString('utf8'))
        continue
      }
      // Pixel equality, not byte equality: another zlib build may compress
      // differently and that is not a defect.
      expect(decodePng(bytes).pixels.equals(decodePng(now).pixels), `${file} changed`).toBe(true)
    }
  }, 30000)
})

describe('the SVG favicon', () => {
  const svg = readFileSync(join(PUBLIC, 'favicon.svg'), 'utf8')

  it('draws the one curve, not a copy of it', () => {
    expect(svg).toContain(`d="${MARK_PATH_D}"`)
    expect(svg).toContain(`viewBox="0 0 ${MARK_BOX} ${MARK_BOX}"`)
  })

  it('takes its colour from the token rather than from a hand-typed hex', () => {
    // scripts/check_palette.sh reads styles.css and nothing else, so a colour
    // in this file is beyond its reach. What holds it honest is that the file
    // is generated: make-icons.mjs resolves the token through tokens.mjs, and
    // the regenerate check above fails the moment the two disagree.
    expect(svg).toContain(`stroke="${tokenValue('sky-deep')}"`)
  })

  it('is the line alone: round-capped, no fill, no tile, nothing else', () => {
    expect(svg).toContain('fill="none"')
    expect(svg).toContain('stroke-linecap="round"')
    expect(svg.match(/<path/g)).toHaveLength(1)
    expect(svg).not.toMatch(/<rect|<circle|<ellipse|<linearGradient|<radialGradient|<filter|<style|<script/)
    const width = Number(/stroke-width="([\d.]+)"/.exec(svg)[1])
    // It renders at 16px in a tab, so it takes the design's small-size weight
    // rather than the 5.5 a 26px lockup gets.
    expect(width).toBeGreaterThan(MARK_STROKE)
    expect(width).toBeLessThanOrEqual(7)
  })
})

describe('the manifest', () => {
  const manifest = JSON.parse(readFileSync(join(PUBLIC, 'manifest.webmanifest'), 'utf8'))
  const html = readFileSync(join(FRONTEND, 'index.html'), 'utf8')

  it('agrees with the title in index.html', () => {
    expect(html).toContain(`<title>${manifest.name}</title>`)
  })

  it('declares the brand colour for chrome, and the meta tag agrees with it', () => {
    // theme_color is the browser and status bar. It stays --brand: recolouring
    // the chrome is a change to the app rather than to its logo, and the meta
    // tag and the manifest are read by different things and must not drift.
    const brand = tokenValue('brand')
    expect(manifest.theme_color).toBe(brand)
    expect(html).toContain(`<meta name="theme-color" content="${brand}" />`)
  })

  it('launches the installed app on the canvas the mark is drawn for', () => {
    // background_color is not chrome — it is the splash, and it is the one
    // surface where an installed app shows the icon on a ground this file
    // chooses. It was --brand, which put a sky-wash tile on forest green on
    // every cold launch: the only screen in the product presenting the new
    // mark against the palette it replaced. The design states this surface
    // outright ("mark centred on canvas, nothing else"), so it is --canvas.
    expect(manifest.background_color).toBe(tokenValue('canvas'))
    // And it is a different field from theme_color, deliberately.
    expect(manifest.background_color).not.toBe(manifest.theme_color)
  })

  it('points every icon at a file that exists, with the size it claims', () => {
    for (const icon of manifest.icons) {
      const file = join(PUBLIC, icon.src.replace(/^\//, ''))
      expect(statSync(file).isFile(), `${icon.src} missing`).toBe(true)
      const png = decodePng(readFileSync(file))
      expect(`${png.width}x${png.height}`).toBe(icon.sizes)
    }
  })

  it('declares exactly one maskable icon', () => {
    expect(manifest.icons.filter((i) => i.purpose === 'maskable')).toHaveLength(1)
  })

  it('links only to icons that exist from the head', () => {
    // A <link rel="manifest"> or an icon pointing at a 404 is worse than none:
    // the browser reports an installable app it then cannot install.
    for (const [, href] of html.matchAll(/<link[^>]+href="(\/[^"]+)"/g)) {
      expect(statSync(join(PUBLIC, href.replace(/^\//, ''))).isFile(), `${href} missing`).toBe(true)
    }
  })

  it('offers the vector favicon first and the raster behind it', () => {
    // A browser that cannot decode image/svg+xml skips the type it does not
    // know and falls to the PNG. Both have to be declared for that to work,
    // and the SVG has to carry its type or it is not skippable.
    expect(html).toContain('<link rel="icon" type="image/svg+xml" href="/favicon.svg" />')
    expect(html).toContain('<link rel="icon" type="image/png" sizes="32x32" href="/favicon-32.png" />')
    expect(html.indexOf('/favicon.svg')).toBeLessThan(html.indexOf('/favicon-32.png'))
  })

  it('starts at the root the deploy actually serves', () => {
    expect(manifest.start_url).toBe('/')
    expect(manifest.scope).toBe('/')
  })
})
