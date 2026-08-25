import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

// A source-text suite, not a rendering one. Nothing here can prove a device
// reports the right insets — only a device can do that. What it can prove is
// that the arithmetic is present, reaches every edge that touches the viewport,
// and is not silently deleted by a later shorthand. Those are the three ways
// this capability fails without any visible symptom on a desktop.

const css = readFileSync(fileURLToPath(new URL('./styles.css', import.meta.url)), 'utf8')
const html = readFileSync(fileURLToPath(new URL('../index.html', import.meta.url)), 'utf8')

// Comments explain the insets and therefore mention env() and the token names.
// Every structural assertion below runs against the stripped source so that
// prose can never satisfy — or break — a check about declarations.
const code = css.replace(/\/\*[\s\S]*?\*\//g, '')

/** Cut a balanced `@media <query> { … }` block out of the source. */
function withoutAtRule(source, query) {
  const start = source.indexOf(query)
  if (start === -1) return source
  let depth = 0
  for (let i = source.indexOf('{', start); i < source.length; i += 1) {
    if (source[i] === '{') depth += 1
    else if (source[i] === '}') {
      depth -= 1
      if (depth === 0) return source.slice(0, start) + source.slice(i + 1)
    }
  }
  return source
}

// Paper has no notch. `@media print` deliberately zeroes .panel's padding, and
// requiring it to restate an inset there would be requiring a nonsense. Every
// screen rule is still held to the rule below.
const screen = withoutAtRule(code, '@media print')

const SIDES = ['top', 'right', 'bottom', 'left']

/** Every body of `selector { … }` in source order, comments already stripped. */
const bodies = (sel) => [...screen.matchAll(new RegExp(`\\${sel}\\s*\\{([^}]*)\\}`, 'g'))].map((m) => m[1])

describe('safe-area tokens', () => {
  it('declares each inset exactly once, with an explicit 0px fallback', () => {
    // The fallback is the difference between "this device has no inset" and
    // "this declaration is invalid at computed-value time and vanishes, taking
    // the --s4 with it". Dropping `, 0px` is a four-character regression that no
    // rendering check on a desktop would ever catch.
    for (const side of SIDES) {
      const found = code.match(
        new RegExp(`--safe-${side}:\\s*env\\(safe-area-inset-${side},\\s*0px\\)`, 'g'),
      )
      expect(found, `--safe-${side}`).toHaveLength(1)
    }
  })

  it('never calls env() outside the token block', () => {
    // The probe at the end of styles.css, and any future gate, work by
    // overriding the four custom properties. A rule that calls env() inline is
    // invisible to that override — it would be the one site the substitution
    // silently cannot reach.
    expect(code.match(/env\(/g) ?? []).toHaveLength(4)
  })

  it('keeps the tokens in the theme-invariant block, not a palette block', () => {
    // Device geometry is not palette. A --safe-* in either colour block would
    // have to be duplicated in the other, and the two would drift.
    const dark = code.slice(code.indexOf("[data-theme='dark'] {"))
    expect(dark.slice(0, dark.indexOf('\n}'))).not.toMatch(/--safe-/)
    expect(code.indexOf('--safe-top')).toBeGreaterThan(code.indexOf('--target: 44px'))
  })
})

describe('safe-area consumption', () => {
  // The layers that touch each edge of the viewport in the 2026 layout, and
  // the inset each one must restate. A `padding:` or `top:`/`bottom:`
  // shorthand landing in a later rule deletes the arithmetic with no error
  // and no visible change on a desktop — the same trap at every one of these.
  const EDGES = [
    ['.capsule-wrap', '--safe-top'], // the floating plan capsule
    ['.rail--row', '--safe-bottom'], // the desktop results row
    ['.sheet', '--safe-bottom'], // the mobile sheet's padding
    ['.follow', '--safe-top'], // the follow layer's own padding…
    ['.follow', '--safe-bottom'], // …reaches every edge
    ['.follow', '--safe-left'],
    ['.follow', '--safe-right'],
    ['.map-attribution', '--safe-bottom'],
  ]

  it.each(EDGES)('%s consumes %s', (selector, token) => {
    const rules = bodies(selector)
    expect(rules.length).toBeGreaterThan(0)
    expect(rules.some((b) => b.includes(token))).toBe(true)
  })

  it('keeps the full-surface search inside all four insets', () => {
    // The one layer that owns the whole viewport at once. Checked against one
    // rule holding all four, not the union across rules — four rules with one
    // side each would leave three edges bare whenever only one applied. (The
    // demo strip's `.app--demo .search` override is also in `bodies`, which is
    // why this is `some` and not `[first]`.)
    const rules = bodies('.search')
    expect(rules.some((b) => SIDES.every((side) => b.includes(`--safe-${side}`)))).toBe(true)
  })

  it('still opts into the full viewport in index.html', () => {
    // The tokens are only ever non-zero because of one attribute in a different
    // file. Deleting it makes every rule above a no-op with no other symptom —
    // the same cross-file coupling index.html already documents for the theme key.
    expect(html).toMatch(/viewport-fit=cover/)
  })
})

describe('the launch token vocabulary stays out', () => {
  it('reintroduces no token from the feat/launch design system', () => {
    // Mechanises the standing prohibition, so the next of these ports cannot
    // smuggle the old vocabulary back in inside a copied rule. The two spacing
    // scales agree for steps 1-4 and diverge from step 5, so an index-for-index
    // port turns 24px into 20px at every site and looks plausible doing it.
    expect(code).not.toMatch(/--space-\d|--text-\d|--radius-(control|card|chip)|--ink-muted|--recessed\b/)
  })
})
