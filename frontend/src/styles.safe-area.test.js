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
  it('does not pin a fixed height on the topbar', () => {
    // The most likely regression by some distance. Restoring `height: 56px`
    // alongside `padding-top` clips the 44px .icon-button out of the content box
    // under the global border-box — a 44x44 violation introduced by the very fix
    // that was meant to be safe.
    const [topbar] = bodies('.topbar')
    expect(topbar).not.toMatch(/^\s*height:/m)
    expect(topbar).toMatch(/--safe-top/)
  })

  it('restates the safe sides in every rule that resets .panel padding', () => {
    // The trap at the 420px override: a four-side `padding:` shorthand landing
    // after the base rule deletes both longhands with no error and no visible
    // change on a desktop. This catches every future one too.
    const resets = bodies('.panel').filter((b) => /padding:/.test(b))
    expect(resets.length).toBeGreaterThan(0)
    for (const b of resets) expect(b).toMatch(/--safe-bottom/)
  })

  it('restates --safe-right in every rule that sets .map__controls trailing inset', () => {
    // Same trap, second instance, at the 899px override.
    const rules = bodies('.map__controls').filter((b) => /inset-inline-end:/.test(b))
    expect(rules.length).toBeGreaterThan(0)
    for (const b of rules) expect(b).toMatch(/--safe-right/)
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
