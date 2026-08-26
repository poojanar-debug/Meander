import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import { BASEMAPS, DEFAULT_BASEMAP, ESRI_ORIGIN, STYLE_URL, basemapFor, streamsWhileFollowing } from './basemap.js'

/**
 * `lib/basemap.js` is a table precisely so that adding a row is the only thing
 * anyone has to do — no branch in MapView, no second flag in FollowMode. That
 * only holds if the table's own invariants are checked somewhere, because
 * nothing about "add an object to an array" makes a reviewer re-derive them by
 * eye. This is that check, in the same spirit as dash-palette.test.js and
 * sw-contract.test.js: a source scan over files that cannot import each other
 * (CSS cannot import JS, and `public/_headers` is not JavaScript at all), so
 * the only way to hold them together is to read both and compare.
 */

const src = (rel) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8')
const css = src('../styles.css')
const headers = src('../../public/_headers')

/**
 * Parse a Cloudflare Pages _headers file into [pattern, {header: value}]
 * pairs. Lifted from csp-hash.test.js rather than imported from it, because
 * importing a test module would run its own describe/it blocks a second time
 * inside this file's report.
 */
function parseHeaders(source) {
  const blocks = []
  let current = null
  for (const raw of source.split('\n')) {
    if (raw.trim() === '' || raw.trimStart().startsWith('#')) continue
    if (!/^\s/.test(raw)) {
      current = { pattern: raw.trim(), headers: {} }
      blocks.push(current)
      continue
    }
    const m = /^\s+([^:]+):\s*(.*)$/.exec(raw)
    if (m && current) current.headers[m[1].trim().toLowerCase()] = m[2].trim()
  }
  return blocks
}

function directive(policy, name) {
  const m = new RegExp(`(?:^|;)\\s*${name}\\s+([^;]*)`).exec(policy)
  return m ? m[1].trim() : null
}

const documentBlock = parseHeaders(headers).find((b) => b.pattern === '/*' || b.pattern === '/')
const csp = documentBlock?.headers['content-security-policy'] ?? ''
const imgSrc = directive(csp, 'img-src') ?? ''
const connectSrc = directive(csp, 'connect-src') ?? ''

/** The palette block, the same way dash-palette.test.js finds it: the first
 *  `:root {}` in the file, which is the one holding colour tokens. The second
 *  `:root {}` further down holds theme-invariant geometry and never a colour a
 *  basemap palette could point at. */
const block = (opener) => {
  const start = css.indexOf(opener)
  return css.slice(start, css.indexOf('\n}', start))
}
const paletteBlock = block(':root {')

const tokenExists = (name) => new RegExp(`--${name}\\s*:`).test(paletteBlock)

describe('every basemap origin is in the CSP, in both directives that matter', () => {
  // MapLibre v5 fetches raster tiles rather than <img>-loading them, so
  // img-src alone is not enough — basemap.js says so at ESRI_ORIGIN's
  // definition, and MapView.jsx's 20-second timeout is what a visitor sees
  // when connect-src is missing: a map that never arrives, with no error
  // anywhere a user could find it. This is the test that would have caught it
  // before a person did, by walking the actual table rather than trusting that
  // whoever added a row remembered the header file exists.

  /** Every host any basemap in the table can cause a request to. */
  function hostsInUse() {
    const hosts = new Set()
    hosts.add(new URL(STYLE_URL).origin)
    for (const basemap of BASEMAPS) {
      if (basemap.raster) {
        for (const template of basemap.raster.tiles) {
          // Tile URL templates carry {z}/{x}/{y} placeholders, not a query
          // string with a host in it, so the origin can be read with URL()
          // directly off the template.
          hosts.add(new URL(template).origin)
        }
      }
    }
    return hosts
  }

  it('finds at least the vector style host and the satellite tile host', () => {
    // A change to this table that silently dropped a raster source would make
    // this assertion vacuous rather than red, so the count is pinned as well
    // as the membership.
    const hosts = hostsInUse()
    expect(hosts).toContain(new URL(STYLE_URL).origin)
    expect(hosts).toContain(ESRI_ORIGIN)
    expect(hosts.size).toBe(2)
  })

  it.each([...hostsInUse()])('%s is allowed in img-src', (host) => {
    expect(imgSrc, host).toContain(host)
  })

  it.each([...hostsInUse()])('%s is allowed in connect-src', (host) => {
    expect(connectSrc, host).toContain(host)
  })

  it('names ESRI_ORIGIN as exactly the origin the raster tiles are served from', () => {
    // If someone edited the tile template's host without moving ESRI_ORIGIN
    // in step, the two assertions above would both still find *a* string in
    // the CSP — just not necessarily the one the export claims. This pins the
    // export to the table's own data rather than to the constant beside it.
    const satellite = BASEMAPS.find((b) => b.id === 'satellite')
    expect(satellite.raster).not.toBeNull()
    expect(new URL(satellite.raster.tiles[0]).origin).toBe(ESRI_ORIGIN)
  })
})

describe('no palette entry is a literal colour', () => {
  // scripts/check_palette.sh reads styles.css for hex literals outside the two
  // :root blocks; a hex sitting in this JS table is invisible to it. The rule
  // that catches a stray colour in every other file has nothing to check here
  // unless this test does it instead.

  it('is a --token-name string for every role of every basemap', () => {
    for (const basemap of BASEMAPS) {
      for (const [role, value] of Object.entries(basemap.palette)) {
        expect(value, `${basemap.id}.palette.${role}`).toMatch(/^--[a-z0-9-]+$/)
      }
    }
  })

  it('names a token that actually exists in styles.css', () => {
    // A typo'd token name is not a parse error — getComputedStyle() on an
    // undeclared custom property resolves to the empty string, which MapLibre
    // then paints as nothing. This is the failure with no console line at all.
    for (const basemap of BASEMAPS) {
      for (const [role, value] of Object.entries(basemap.palette)) {
        const name = value.replace(/^--/, '')
        expect(tokenExists(name), `${basemap.id}.palette.${role} = ${value}`).toBe(true)
      }
    }
  })
})

describe('attribution is owed and present on every row', () => {
  it('declares a non-empty credits array for every basemap', () => {
    for (const basemap of BASEMAPS) {
      expect(Array.isArray(basemap.credits), basemap.id).toBe(true)
      expect(basemap.credits.length, basemap.id).toBeGreaterThan(0)
    }
  })

  it('gives every credit fragment actual text', () => {
    for (const basemap of BASEMAPS) {
      for (const credit of basemap.credits) {
        expect(typeof credit.text, `${basemap.id} credit`).toBe('string')
        expect(credit.text.trim().length, `${basemap.id} credit`).toBeGreaterThan(0)
      }
    }
  })

  it('keeps the OpenStreetMap credit on satellite, not only the Esri one', () => {
    // The raster sits under the first symbol layer, so every label drawn over
    // the imagery is still OpenStreetMap's. Dropping that credit because the
    // picture is Esri's would be the specific mistake this pins against.
    const satellite = BASEMAPS.find((b) => b.id === 'satellite')
    expect(satellite.credits.some((c) => /openstreetmap/i.test(c.text))).toBe(true)
    expect(satellite.credits.some((c) => /esri/i.test(c.text))).toBe(true)
  })
})

describe('streamsTiles agrees with whether there is a raster to stream', () => {
  // FollowMode reads streamsWhileFollowing(id), not basemap.raster directly,
  // to decide which of two privacy sentences to print. A row where the flag
  // and the raster field disagree makes the app assert something false on the
  // one screen where the claim is the point — either "no network in follow
  // mode" while tiles are in fact being fetched, or an unwarranted warning on
  // a layer that costs nothing.

  it.each(BASEMAPS.map((b) => [b.id, b]))('%s: streamsTiles is true iff raster is non-null', (id, basemap) => {
    expect(basemap.streamsTiles, id).toBe(basemap.raster !== null)
  })

  it.each(BASEMAPS.map((b) => b.id))('%s: streamsWhileFollowing agrees with the row', (id) => {
    const basemap = basemapFor(id)
    expect(streamsWhileFollowing(id)).toBe(basemap.streamsTiles === true)
  })
})

describe('basemapFor never hands back nothing', () => {
  it('returns a real row for every declared id', () => {
    for (const basemap of BASEMAPS) {
      expect(basemapFor(basemap.id)).toBe(basemap)
    }
  })

  it.each(['', 'nonsense', undefined, null, 42, 'MAP', ' map', 'map '])(
    'falls back to a real row rather than undefined for %s',
    (input) => {
      const basemap = basemapFor(input)
      expect(basemap).toBeDefined()
      expect(BASEMAPS).toContain(basemap)
    },
  )

  it('falls back to DEFAULT_BASEMAP specifically, not merely to some row', () => {
    expect(basemapFor('nonsense').id).toBe(DEFAULT_BASEMAP)
  })
})

describe('DEFAULT_BASEMAP names a row that exists', () => {
  it('is one of the declared ids', () => {
    expect(BASEMAPS.map((b) => b.id)).toContain(DEFAULT_BASEMAP)
  })

  it('is the first row — what basemapFor falls back to when the id is unknown', () => {
    // basemapFor's fallback is BASEMAPS[0], not a lookup by DEFAULT_BASEMAP.
    // Those two only agree because the first row happens to be the default
    // one; if a reorder ever separated them, an unknown id would silently
    // start a satellite basemap for a first-time visitor.
    expect(BASEMAPS[0].id).toBe(DEFAULT_BASEMAP)
  })
})

describe('every row has the shape the rest of the app assumes', () => {
  // MapView and LayerPicker read these fields without a fallback for a
  // missing one (basemap.label.toLowerCase(), basemap.credits.map(...)), so a
  // basemap short a field is not a type error caught early — it is a crash
  // the first time that code path runs, on whichever row is missing it.
  it.each(BASEMAPS.map((b) => b.id))('%s declares id, label and hint as non-empty strings', (id) => {
    const basemap = basemapFor(id)
    for (const field of ['id', 'label', 'hint']) {
      expect(typeof basemap[field], field).toBe('string')
      expect(basemap[field].length, field).toBeGreaterThan(0)
    }
  })

  it('gives every id its own row — no duplicate that would shadow another', () => {
    const ids = BASEMAPS.map((b) => b.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('sets raster to exactly null when there is none, not undefined or false', () => {
    // basemapFor consumers write `basemap.raster !== null` and `if
    // (basemap.raster)`; either is fine for null, but a row that left the
    // field undefined instead would still pass `if (basemap.raster)` while
    // failing a strict-equality check anywhere one crept in.
    for (const basemap of BASEMAPS) {
      if (!basemap.streamsTiles) expect(basemap.raster, basemap.id).toBeNull()
    }
  })

  it('gives every raster source a tile template, a tile size and a maxzoom', () => {
    for (const basemap of BASEMAPS) {
      if (!basemap.raster) continue
      expect(Array.isArray(basemap.raster.tiles), basemap.id).toBe(true)
      expect(basemap.raster.tiles.length, basemap.id).toBeGreaterThan(0)
      expect(typeof basemap.raster.tileSize, basemap.id).toBe('number')
      expect(typeof basemap.raster.maxzoom, basemap.id).toBe('number')
    }
  })
})
