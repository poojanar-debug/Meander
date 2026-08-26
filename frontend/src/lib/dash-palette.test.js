import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

/**
 * The route palette is declared twice — once in styles.css, where the map lines
 * and swatches read it, and once in dash.js, where the MapLibre layers do,
 * because a WebGL paint property cannot read a CSS custom property.
 *
 * Duplication is unavoidable. Silent divergence is not, and until now nothing
 * checked it: scripts/check_palette.sh reads only styles.css, so fourteen
 * hard-coded hexes in dash.js could drift from the stylesheet indefinitely and
 * the only symptom would be a legend swatch that does not match the line it
 * describes.
 */

const src = (rel) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8')
const css = src('../styles.css')
const dash = src('./dash.js')

const block = (opener) => {
  const start = css.indexOf(opener)
  return css.slice(start, css.indexOf('\n}', start))
}
const light = block(':root {')
const dark = block("[data-theme='dark'] {")

const token = (name, source) => {
  const match = source.match(new RegExp(`--${name}\\s*:\\s*(#[0-9a-fA-F]{3,8})\\s*;`))
  return match ? match[1].toLowerCase() : null
}

// id in dash.js -> token name in styles.css
const ROUTES = ['fastest', 'scenic', 'accessible', 'quiet', 'shade', 'air']

/** Every `color`/`colorDark` pair in dash.js, in source order. */
const pairs = [...dash.matchAll(/color:\s*'(#[0-9a-fA-F]{6})',\s*\n\s*colorDark:\s*'(#[0-9a-fA-F]{6})'/g)].map(
  (m) => [m[1].toLowerCase(), m[2].toLowerCase()],
)

describe('the route palette does not drift between CSS and JS', () => {
  it('finds a light/dark pair for every route, plus the fallback', () => {
    expect(pairs).toHaveLength(ROUTES.length + 1)
  })

  it.each(ROUTES.map((id, i) => [id, i]))('%s matches --route-%s in both themes', (id, index) => {
    const [jsLight, jsDark] = pairs[index]
    expect(jsLight, `${id} light`).toBe(token(`route-${id}`, light))
    expect(jsDark, `${id} dark`).toBe(token(`route-${id}`, dark))
  })

  it('uses --ink-2 for the fallback, not a colour of its own', () => {
    // The last pair is not a route colour at all — it is the muted ink, spelled
    // out. If it ever stops matching, the fallback line drifts from every other
    // secondary mark in the app.
    const [jsLight, jsDark] = pairs[ROUTES.length]
    expect(jsLight).toBe(token('ink-2', light))
    expect(jsDark).toBe(token('ink-2', dark))
  })

  it('has no hex in dash.js that is not accounted for above', () => {
    const all = [...dash.matchAll(/#[0-9a-fA-F]{6}/g)].map((m) => m[0].toLowerCase())
    expect(all).toHaveLength(pairs.length * 2)
  })
})

/**
 * Relative luminance and contrast, WCAG 2.1 §1.4.3, from a six-digit hex.
 *
 * Fifteen lines rather than a dependency, and worth having in the suite even
 * though the axe gate measures the rendered result: the gate needs a headless
 * Chrome and prints a skip line without one, so on a machine with no browser
 * this is the only thing standing between a new wash family and a chip nobody
 * can read.
 */
const channel = (v) => {
  const c = v / 255
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
}
const luminance = (hex) => {
  const [r, g, b] = [1, 3, 5].map((i) => channel(Number.parseInt(hex.slice(i, i + 2), 16)))
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}
const contrast = (a, b) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x)
  return (hi + 0.05) / (lo + 0.05)
}

describe('a pressed chip is legible in the objective it names', () => {
  // Three of these families arrived with quiet, shade and air. Until they did,
  // those three chips had no pressed rule at all: pressing one changed
  // aria-pressed and nothing else, which is the failure this describe block
  // would have caught and the stylesheet could not.
  const rules = [...css.matchAll(/\.chip--([a-z]+)\.is-pressed \{([^}]*)\}/g)]

  it('gives every objective in the table a pressed skin', () => {
    expect(rules.map((m) => m[1]).sort()).toEqual([...ROUTES].sort())
  })

  it.each(ROUTES.map((id, i) => [id, i]))('draws %s from declared tokens', (id) => {
    const rule = rules.find((m) => m[1] === id)[2]
    const names = [...rule.matchAll(/var\(--([a-z-]+)\)/g)].map((m) => m[1])
    // background, border-color, color. A rule short of one of them inherits
    // the unpressed chip's, which is how a pressed chip loses its border.
    expect(names, id).toHaveLength(3)
    for (const name of names) {
      expect(token(name, light), `--${name} declared in :root`).not.toBeNull()
    }
  })

  it.each(ROUTES.map((id, i) => [id, i]))('clears AA for the text on %s', (id) => {
    const rule = rules.find((m) => m[1] === id)[2]
    const family = /var\(--([a-z]+)-wash\)/.exec(rule)[1]
    const wash = token(`${family}-wash`, light)
    const ink = token(`${family}-on-wash`, light)
    expect(contrast(wash, ink), `${id}: --${family}-on-wash on --${family}-wash`).toBeGreaterThanOrEqual(4.5)
  })
})

describe('every interactive target clears the floor in the stylesheet', () => {
  it('declares no min-height below 44px on a control', () => {
    // The rule is 44x44 and it had two standing exceptions. The gate measures
    // the rendered result; this catches the declaration, which is cheaper and
    // names the culprit.
    const offenders = [...css.matchAll(/min-height:\s*(\d+)px/g)]
      .map((m) => Number(m[1]))
      .filter((px) => px < 44)
    expect(offenders).toEqual([])
  })
})
