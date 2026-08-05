/**
 * The route palette must have exactly one source.
 *
 * styles.css owns the colours; lib/dash.js reads them from the cascade at call
 * time. But dash.js also carries literal fallbacks for the case where there is
 * no computed style to read — jsdom, a server render, a call before the
 * stylesheet applies — and a fallback that drifts is the same bug the custom
 * properties were introduced to fix, just quieter.
 *
 * This is what stops it drifting. No test runner needed:
 *
 *     npm run check:palette
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const css = readFileSync(join(here, '..', 'src', 'styles.css'), 'utf8')
const js = readFileSync(join(here, '..', 'src', 'lib', 'dash.js'), 'utf8')

/** The light-theme block is everything before the first dark-mode override. */
const lightBlock = css.split('@media (prefers-color-scheme: dark)')[0]

const cssColors = {}
for (const [, id, value] of lightBlock.matchAll(/--route-([a-z]+):\s*(#[0-9a-f]{6})/gi)) {
  cssColors[id] = value.toLowerCase()
}

const fallbackBlock = js.split('const FALLBACK_COLORS = {')[1]?.split('}')[0] ?? ''
const jsColors = {}
for (const [, id, value] of fallbackBlock.matchAll(/(\w+):\s*'(#[0-9a-f]{6})'/gi)) {
  jsColors[id] = value.toLowerCase()
}

const problems = []

for (const [id, value] of Object.entries(cssColors)) {
  if (!(id in jsColors)) {
    problems.push(`--route-${id} is in styles.css but has no fallback in dash.js`)
  } else if (jsColors[id] !== value) {
    problems.push(`--route-${id}: styles.css says ${value}, dash.js fallback says ${jsColors[id]}`)
  }
}
for (const id of Object.keys(jsColors)) {
  if (id === 'unknown') continue
  if (!(id in cssColors)) {
    problems.push(`dash.js has a fallback for '${id}' with no --route-${id} in styles.css`)
  }
}

// The dark theme must define every route colour too, or a route silently keeps
// its light-theme hue against a dark map casing — 2.5:1, which is unreadable.
const darkBlock = css.slice(css.indexOf('@media (prefers-color-scheme: dark)'))
for (const id of Object.keys(cssColors)) {
  if (!darkBlock.includes(`--route-${id}:`)) {
    problems.push(`--route-${id} has no dark-theme value`)
  }
}

if (problems.length) {
  console.error('Route palette is out of step:\n')
  for (const p of problems) console.error(`  - ${p}`)
  console.error('\nstyles.css is the source of truth; update dash.js to match.')
  process.exit(1)
}

console.log(
  `Route palette consistent: ${Object.keys(cssColors).length} colours, ` +
    `light and dark, CSS and JS fallbacks agree.`,
)
