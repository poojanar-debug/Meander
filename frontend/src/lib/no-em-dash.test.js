import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

// No em dash in text a user reads.
//
// The repo has thousands of them and they stay: comments explain *why* at the
// point of the trade-off, and that is the house voice. This suite is about the
// 1.5% of them that reach a screen — 53 source lines at the time it was
// written — and it exists because that subset is invisible to every other check
// in the build. A dash added to a JSX string is a passing build, a green suite
// and a green gate.
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

describe('no em dash reaches a screen', () => {
  it.each(SURFACES)('%s', (rel) => {
    expect(userVisibleDashes(rel)).toEqual([])
  })

  it('the placeholder is not a dash either', () => {
    // Five formatters returned a bare em dash for "value unknown". The rule they
    // enforce is load-bearing and unchanged — an unknown distance must never
    // render as `0 m` — but the glyph was the very character being removed.
    const units = blankComments(readFileSync(`${SRC}lib/units.js`, 'utf8'))
    const format = blankComments(readFileSync(`${SRC}lib/format.js`, 'utf8'))
    expect(units).toMatch(/export const UNKNOWN = '-'/)
    // Four numeric slots share one constant; the fifth is prose and says the
    // word, which is better to hear and safe outside a `.tabular` column.
    expect(units.match(/return UNKNOWN/g)).toHaveLength(2)
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
