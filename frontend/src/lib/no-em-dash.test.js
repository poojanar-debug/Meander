import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

// Every em dash a user reads is one the design put there.
//
// This suite used to ban the em dash from user-visible text outright. The
// 2026 redesign reversed the premise: its approved copy carries em dashes as
// prose ("kept in its slot — tap a blocker to see it on the map") and its
// stated rule makes the em dash the unknown placeholder ("unknown renders as
// —"). What survives the reversal is the gate's actual job: a dash that
// *drifts into* a screen string uninvited is still invisible to every other
// check in the build — a passing build, a green suite and a green gate.
//
// So the scan stays, and the judgment moves into APPROVED_COPY below: every
// dash-carrying line must match a sentence the design wrote. Adding new copy
// with a dash means adding it there, which is a deliberate act with a diff a
// reviewer sees — exactly what the old blanket ban bought, without lying
// about the copy the app actually ships.
//
// The scan blanks comments before looking, so prose *about* dashes can neither
// satisfy nor break it. That is not a nicety: this file's own header would
// otherwise fail it, and so would `units.js`'s explanation of the placeholder.

const SRC = fileURLToPath(new URL('..', import.meta.url))
const FRONTEND = fileURLToPath(new URL('../..', import.meta.url))
const DASHES = /[—–―]/

/**
 * Comment characters replaced with spaces, newlines preserved so a reported
 * line number is a real one.
 *
 * It tracks string and template literals as it goes, so a `//` inside a URL is
 * not mistaken for the start of a comment — `https://tiles.openfreemap.org` is
 * in this codebase and would otherwise blank the rest of its line.
 *
 * ⚠ It also has to recognise **regex literals**, and that is not decoration.
 * Without it, `export.js`'s `.replace(/"/g, '&quot;')` opens a double-quoted
 * string on the `"` inside the pattern, the scanner stays in that state for the
 * rest of the file, and every block comment after it is reported as live code.
 * That happened, on four lines, before this branch existed.
 *
 * A `/` is a regex rather than a division when the last non-space character
 * before it cannot end an expression. That is the standard heuristic and it is
 * sufficient here; it does not have to be a JavaScript parser, it has to not
 * lose its place.
 */
const BEFORE_REGEX = new Set([...'(,=:[!&|?{};+-*%<>~^', ''])

function blankComments(src) {
  const out = [...src]
  let i = 0
  let state = null
  let lastMeaningful = ''
  while (i < src.length) {
    const c = src[i]
    const next = src[i + 1] ?? ''
    if (state === null) {
      if (c === '/' && (next === '/' || next === '*')) {
        state = next === '/' ? 'line' : 'block'
        out[i] = out[i + 1] = ' '
        i += 2
        continue
      }
      if (c === '/' && BEFORE_REGEX.has(lastMeaningful)) {
        // Skip to the closing unescaped slash, ignoring anything inside a
        // character class so that /[^/]/ does not end early.
        let j = i + 1
        let inClass = false
        while (j < src.length) {
          if (src[j] === '\\') j += 2
          else if (src[j] === '[') { inClass = true; j += 1 }
          else if (src[j] === ']') { inClass = false; j += 1 }
          else if (src[j] === '/' && !inClass) break
          else if (src[j] === '\n') break
          else j += 1
        }
        i = j + 1
        lastMeaningful = '/'
        continue
      }
      if (c === '"' || c === "'" || c === '`') state = c
      if (!/\s/.test(c)) lastMeaningful = c
      i += 1
      continue
    }
    if (state === 'line') {
      if (c === '\n') state = null
      else out[i] = ' '
      i += 1
      continue
    }
    if (state === 'block') {
      if (c === '*' && next === '/') {
        out[i] = out[i + 1] = ' '
        state = null
        i += 2
        continue
      }
      if (c !== '\n') out[i] = ' '
      i += 1
      continue
    }
    if (c === '\\') {
      i += 2
      continue
    }
    if (c === state) state = null
    i += 1
  }
  return out.join('')
}

/**
 * Lines that carry a dash and are NOT read by a user.
 *
 * Listed rather than pattern-matched, so adding one is a deliberate act with a
 * reason beside it. Each is a string that goes to a developer.
 */
const NOT_USER_VISIBLE = [
  // Console only. The sentence a user sees for this failure is the
  // `.map__fallback` paragraph, which is checked like everything else.
  "console.warn('Meander: map could not start",
]

/**
 * The dashes the design wrote. A dash-carrying line passes only when it
 * contains one of these substrings — each one a sentence (or the placeholder
 * declaration) from the approved 2026 copy quoted verbatim, or from copy
 * approved since: the reroute-era provenance sentences replaced the spec's
 * "never leaves this phone" pair when recalculation shipped, because the old
 * sentences stopped being true. A new dash anywhere else is still a failure.
 */
const APPROVED_COPY = [
  // The unknown placeholder, by stated rule: unknown renders as the em dash.
  "UNKNOWN = '—'",
  // Plan and search surfaces.
  'Optimise for — up to 3',
  'searches are your own words — never stored, never sent to analytics',
  // The destination drawer's hint, from DESIGN-HANDOFF §4.3's segment table.
  'Empty means a round trip — Meander brings you back to where you started.',
  // Result cards.
  'Step-free as far as the data goes — it covers',
  'kept in its slot — tap a blocker to see it on the map',
  '{typeLabel(blocker.type)} — {blocker.description}',
  // Detail.
  ' — limit ',
  ' — {reason}',
  // Follow mode.
  'position leaves this phone only to reroute you — nothing else is sent in follow mode',
  'rerouting sends your position to the routing server — nothing else leaves this phone',
  'the routing server could not be reached — position stays on this phone until it can',
  ' — it is about ',
  'Nothing was uploaded — this walk exists only',
]

/** `<!-- -->`, newlines kept, for the two shipped HTML files. */
function blankHtmlComments(src) {
  return src.replace(/<!--[\s\S]*?-->/g, (m) => m.replace(/[^\n]/g, ' '))
}

function userVisibleDashes(rel) {
  const src = readFileSync(`${FRONTEND}/${rel}`, 'utf8')
  const scan = /\.(js|jsx)$/.test(rel)
    ? blankComments(src)
    : /\.html$/.test(rel)
      ? blankHtmlComments(src)
      : src
  const raw = src.split('\n')
  return scan
    .split('\n')
    .map((line, i) => [i + 1, line, raw[i]])
    .filter(([, line]) => DASHES.test(line))
    .filter(([, , original]) => !NOT_USER_VISIBLE.some((allowed) => original.includes(allowed)))
    .filter(([, , original]) => !APPROVED_COPY.some((allowed) => original.includes(allowed)))
    .map(([n, , original]) => `${rel}:${n}  ${original.trim().slice(0, 100)}`)
}

const componentFiles = readdirSync(`${SRC}components`)
  .filter((f) => /\.jsx?$/.test(f) && !f.includes('.test.'))
  .map((f) => `src/components/${f}`)
const libFiles = readdirSync(`${SRC}lib`)
  .filter((f) => /\.jsx?$/.test(f) && !f.includes('.test.'))
  .map((f) => `src/lib/${f}`)

const SURFACES = [
  'index.html',
  'a11y.html',
  'public/manifest.webmanifest',
  'src/App.jsx',
  'src/api/mock.js',
  'src/api/client.js',
  ...componentFiles,
  ...libFiles,
]

describe('no unapproved em dash reaches a screen', () => {
  it.each(SURFACES)('%s', (rel) => {
    expect(userVisibleDashes(rel)).toEqual([])
  })

  it('the placeholder is the em dash, declared once', () => {
    // The formatters share one constant for "value unknown". The rule it
    // enforces is load-bearing and has never moved — an unknown distance must
    // never render as `0 m` — and the glyph is the em dash by the design's
    // stated rule: unknown renders as —.
    const units = blankComments(readFileSync(`${SRC}lib/units.js`, 'utf8'))
    const format = blankComments(readFileSync(`${SRC}lib/format.js`, 'utf8'))
    expect(units).toMatch(/export const UNKNOWN = '—'/)
    // Numeric slots share the constant — distance, elevation, and the GPS
    // accuracy figure; the percentage is prose and says the word, which is
    // better to hear.
    expect(units.match(/return UNKNOWN/g)).toHaveLength(3)
    expect(format.match(/UNKNOWN/g)).toHaveLength(3)
    expect(format).toMatch(/return 'Unknown'/)
  })

  it('keeps the title and the manifest name byte-identical', () => {
    // `icons.test.js` asserts `html` contains `<title>${manifest.name}</title>`,
    // so changing the dash in one and not the other fails there rather than
    // here. Asserted in both places on purpose: this one names the reason.
    const html = readFileSync(`${FRONTEND}/index.html`, 'utf8')
    const manifest = JSON.parse(readFileSync(`${FRONTEND}/public/manifest.webmanifest`, 'utf8'))
    expect(html).toContain(`<title>${manifest.name}</title>`)
    expect(manifest.name).not.toMatch(DASHES)
  })
})
