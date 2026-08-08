import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Read design tokens straight out of the stylesheet, at build time.
 *
 * The build-time twin of lib/dash.js's cssVar(). It exists so the icon
 * generator and the manifest cannot drift from the palette: there is one place
 * a colour is declared, and this reads that place rather than restating it.
 *
 * Nothing under src/ may import this — it must never enter the bundle.
 */

const CSS = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'styles.css')

/** The value of a custom property from the first `:root` block that declares it. */
export function token(name, css = readFileSync(CSS, 'utf8')) {
  const match = css.match(new RegExp(`--${name}\\s*:\\s*([^;]+);`))
  if (!match) throw new Error(`no --${name} in styles.css`)
  return match[1].trim()
}

/** `#rrggbb` → `[r, g, b]`. Throws rather than guessing on anything else. */
export function rgb(hex) {
  const match = /^#([0-9a-f]{6})$/i.exec(hex)
  if (!match) throw new Error(`expected a six-digit hex, got ${hex}`)
  const value = Number.parseInt(match[1], 16)
  return [(value >> 16) & 255, (value >> 8) & 255, value & 255]
}
