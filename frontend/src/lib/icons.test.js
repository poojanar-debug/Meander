import { execFileSync } from 'node:child_process'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { inflateSync } from 'node:zlib'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

// The icons carry colour, and colour in a PNG is invisible to every gate this
// project has: the stylesheet scanner does not read them, `git diff` does not
// show them, and review cannot see them. So the check is that the *pixels*
// match the tokens — which is also what makes "regenerate, never copy" a rule
// with teeth rather than a note in a commit message.

const here = dirname(fileURLToPath(import.meta.url))
const FRONTEND = join(here, '..', '..')
const PUBLIC = join(FRONTEND, 'public')
const css = readFileSync(join(FRONTEND, 'src', 'styles.css'), 'utf8')

const tokenValue = (name, source = css) =>
  source.match(new RegExp(`--${name}\\s*:\\s*([^;]+);`))[1].trim()

const darkBlock = css.slice(
  css.indexOf("[data-theme='dark']"),
  css.indexOf('}', css.indexOf("[data-theme='dark']")),
)

const hexToRgb = (hex) => {
  const value = Number.parseInt(hex.slice(1), 16)
  return [(value >> 16) & 255, (value >> 8) & 255, value & 255]
}

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

const EXPECTED = [
  ['favicon-32.png', 32],
  ['apple-touch-icon.png', 180],
  ['icon-192.png', 192],
  ['icon-512.png', 512],
  ['icon-maskable-512.png', 512],
]

describe('the icon set', () => {
  it.each(EXPECTED)('%s is a %ipx square PNG', (file, size) => {
    const png = decodePng(readFileSync(join(PUBLIC, file)))
    expect(png.width).toBe(size)
    expect(png.height).toBe(size)
  })

  it.each(EXPECTED)('%s uses only the tokens from the stylesheet', (file) => {
    // The reason this capability regenerates rather than copies: the committed
    // set on the source branch has the old palette baked into its pixels.
    const png = decodePng(readFileSync(join(PUBLIC, file)))
    const ground = hexToRgb(tokenValue('brand'))
    const path = hexToRgb(tokenValue('accent', darkBlock))

    const seen = new Set()
    for (let i = 0; i < png.pixels.length; i += 4) {
      if (png.pixels[i + 3] === 0) continue
      seen.add(`${png.pixels[i]},${png.pixels[i + 1]},${png.pixels[i + 2]}`)
    }

    // Antialiasing blends the two, so every opaque pixel must lie on the line
    // between them — no third colour anywhere.
    for (const key of seen) {
      const [r, g, b] = key.split(',').map(Number)
      const t = (r - ground[0]) / (path[0] - ground[0] || 1)
      expect(t, `${file}: ${key} is not on the ramp`).toBeGreaterThanOrEqual(-0.02)
      expect(t).toBeLessThanOrEqual(1.02)
      expect(Math.abs(ground[1] + t * (path[1] - ground[1]) - g), `${key} green`).toBeLessThan(3)
      expect(Math.abs(ground[2] + t * (path[2] - ground[2]) - b), `${key} blue`).toBeLessThan(3)
    }
  })

  it('carries no colour from the branch this came from', () => {
    // The two constants that were baked into the old blobs.
    const forbidden = [
      [27, 36, 48], // #1b2430
      [63, 174, 112], // #3fae70
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
      const png = decodePng(readFileSync(join(PUBLIC, file)))
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
    const png = decodePng(readFileSync(join(PUBLIC, 'icon-maskable-512.png')))
    // Full bleed: the corners are painted, so no launcher mask reveals a gap.
    for (const [x, y] of [
      [0, 0],
      [511, 0],
      [0, 511],
      [511, 511],
    ]) {
      expect(pixelAt(png, x, y)[3], `corner ${x},${y}`).toBe(255)
    }

    // Every path pixel within r = 0.307 * size of centre.
    const path = hexToRgb(tokenValue('accent', darkBlock))
    const centre = 256
    const safe = 0.307 * 512
    for (let y = 0; y < 512; y += 1) {
      for (let x = 0; x < 512; x += 1) {
        const [r, g, b] = pixelAt(png, x, y)
        const nearPath = Math.abs(r - path[0]) < 30 && Math.abs(g - path[1]) < 30 && Math.abs(b - path[2]) < 30
        if (nearPath) {
          expect(Math.hypot(x - centre, y - centre), `mark pixel at ${x},${y}`).toBeLessThanOrEqual(
            safe,
          )
        }
      }
    }
  })

  it('keeps the non-maskable icons opaque to the edge of the rounded square', () => {
    const png = decodePng(readFileSync(join(PUBLIC, 'icon-512.png')))
    expect(pixelAt(png, 256, 2)[3]).toBe(255) // top edge, mid-width
    expect(pixelAt(png, 2, 256)[3]).toBe(255) // left edge, mid-height
    expect(pixelAt(png, 1, 1)[3]).toBe(0) // corner is rounded away
  })

  // 30 s, not the 5 s default. This test shells out to the generator and draws
  // five PNGs; it measured 5018 ms on the deployment VM, which against a 5000 ms
  // default is a coin toss rather than a gate. The number is patience, not
  // tolerance — nothing about what it accepts has changed.
  it('regenerates identically — the files in git are the files the script draws', () => {
    // If this fails, someone hand-edited an icon or changed a token without
    // re-running the generator.
    const before = Object.fromEntries(
      readdirSync(PUBLIC)
        .filter((f) => f.endsWith('.png'))
        .map((f) => [f, readFileSync(join(PUBLIC, f))]),
    )
    execFileSync('node', [join(FRONTEND, 'scripts', 'make-icons.mjs')], { stdio: 'ignore' })
    for (const [file, bytes] of Object.entries(before)) {
      // Pixel equality, not byte equality: another zlib build may compress
      // differently and that is not a defect.
      const now = decodePng(readFileSync(join(PUBLIC, file)))
      expect(decodePng(bytes).pixels.equals(now.pixels), `${file} changed`).toBe(true)
    }
  }, 30000)
})

describe('the manifest', () => {
  const manifest = JSON.parse(readFileSync(join(PUBLIC, 'manifest.webmanifest'), 'utf8'))
  const html = readFileSync(join(FRONTEND, 'index.html'), 'utf8')

  it('agrees with the title in index.html', () => {
    expect(html).toContain(`<title>${manifest.name}</title>`)
  })

  it('declares the brand colour, and the meta tag agrees with it', () => {
    const brand = tokenValue('brand')
    expect(manifest.theme_color).toBe(brand)
    expect(manifest.background_color).toBe(brand)
    // Two different consumers read these, and they must not drift.
    expect(html).toContain(`<meta name="theme-color" content="${brand}" />`)
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

  it('starts at the root the deploy actually serves', () => {
    expect(manifest.start_url).toBe('/')
    expect(manifest.scope).toBe('/')
  })
})
