import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

import { markPathD, markPoints } from './mark.js'

// The mark is drawn twice by two renderers that cannot share one: the icon set
// is written pixel by pixel in scripts/make-icons.mjs, and the in-page logo is
// an inline SVG. Two copies of the same curve is how a favicon and a wordmark
// come to disagree, with nothing to catch it.

const SRC = new URL('..', import.meta.url)
const read = (rel) => readFileSync(new URL(rel, SRC), 'utf8')

/**
 * Source with `/* *\/` and `//` comments blanked, in the same spirit as
 * `styles.safe-area.test.js`: every structural assertion below runs against
 * this rather than the raw file, so prose can never satisfy — or break — a
 * check about code. Both of the checks below tripped on their own explanatory
 * comment before this existed, which is the point exactly.
 */
const code = (rel) =>
  read(rel)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')

describe('one shape, two renderers', () => {
  it('is the only place the curve is defined', () => {
    // If either renderer grows its own copy of the sine, this fails. The
    // constant 2.15 is the number that would drift first.
    const icons = readFileSync(new URL('../scripts/make-icons.mjs', SRC), 'utf8')
    expect(icons).toMatch(/import \{ markPoints \} from '\.\.\/src\/lib\/mark\.js'/)
    expect(icons).not.toMatch(/Math\.sin/)
    expect(read('components/Topbar.jsx')).toMatch(/markPathD/)
    expect(read('components/Topbar.jsx')).not.toMatch(/Math\.sin/)
  })

  it('carries no colour, so it can be imported from a build script', () => {
    // scripts/tokens.mjs reads the palette at build time and says in its own
    // header that nothing under src/ may import it, because it must never enter
    // the bundle. This module is the other direction, and it is only safe
    // because there is nothing in it but numbers.
    const src = code('lib/mark.js')
    expect(src).not.toMatch(/#[0-9a-fA-F]{3,8}\b/)
    expect(src).not.toMatch(/tokens\.mjs|var\(--/)
  })

  it('produces a path that starts and ends inside the frame', () => {
    // A point outside [0,1] would be clipped by the icon's rounded square and
    // cropped by the SVG viewBox, differently in each.
    for (const [x, y] of markPoints()) {
      expect(x).toBeGreaterThanOrEqual(0)
      expect(x).toBeLessThanOrEqual(1)
      expect(y).toBeGreaterThanOrEqual(0)
      expect(y).toBeLessThanOrEqual(1)
    }
  })

  it('emits a polyline, not a hand-fitted curve', () => {
    // Emitted as the same points the icon generator walks, so the two are
    // provably one shape rather than two that look alike.
    const d = markPathD(24)
    expect(d.startsWith('M')).toBe(true)
    expect(d.match(/L/g)).toHaveLength(48)
    expect(d).not.toMatch(/[CQSTA]/)
  })
})

describe('the wordmark resets the app', () => {
  const app = read('App.jsx')

  it('does not route the reset through withRefetch', () => {
    // withRefetch bumps `nonce`, and the fetch effect keys on `nonce` alone —
    // so a reset would immediately re-request the search it just cleared.
    const body = /case 'reset':\s*\n\s*return ([^\n]*)/.exec(app)?.[1] ?? ''
    expect(body).toContain('initialState')
    expect(body).not.toContain('withRefetch')
  })

  it('keeps the two things that are display preferences and nothing else', () => {
    const body = /case 'reset':\s*\n\s*return ([^\n]*)/.exec(app)?.[1] ?? ''
    expect(body).toContain('theme: state.theme')
    expect(body).toContain('units: state.units')
    // Anything else preserved would be a search surviving its own clearing.
    expect(body.match(/state\./g)).toHaveLength(2)
  })

  it('does the three things a reducer cannot', () => {
    const handler = /const onReset = useCallback\(\(\) => \{([\s\S]*?)\n  \}, \[/.exec(app)?.[1] ?? ''
    // A stream in flight would land after the reset and repopulate the rail.
    expect(handler).toMatch(/abortRef\.current\?\.abort\(\)/)
    // A debounced announcement would read the previous sentence out afterwards.
    expect(handler).toMatch(/clearTimeout\(announceTimer\.current\)/)
    // highlight is local state, outside the reducer entirely.
    expect(handler).toMatch(/setHighlight\(null\)/)
  })

  it('never reloads the page', () => {
    // It re-reads the current URL, so a permalinked page reloads straight back
    // into the search it was asked to clear; it discards an offline-saved
    // route; and it costs a network round trip in exactly the situation the app
    // is built to survive without one.
    expect(code('App.jsx')).not.toMatch(/location\.reload/)
  })
})
