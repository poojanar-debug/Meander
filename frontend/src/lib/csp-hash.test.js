import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

/**
 * The CSP in public/_headers names a SHA-256 of the inline theme script in
 * index.html. Nothing connects those two files, so the moment anyone edits the
 * script — a comment, a space, a rename — the hash stops matching and the
 * browser blocks it.
 *
 * The failure is quiet and looks like a design bug rather than a policy one: a
 * dark-mode visitor gets one frame of cream before src/lib/theme.js catches up.
 * It only says so in the console, and only to someone who opened the console.
 *
 * DEPLOY.md's iOS table asked for exactly this check, in those words: "add its
 * SHA-256 to script-src and a build check that the hash still matches, because
 * it will drift the first time anyone edits it."
 */

const read = (p) => readFileSync(fileURLToPath(new URL(p, import.meta.url)), 'utf8')

const html = read('../../index.html')
const headers = read('../../public/_headers')

/** Every inline <script> in the document — one with a `src` is not inline. */
function inlineScripts(source) {
  return [...source.matchAll(/<script(?![^>]*\ssrc=)[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1])
}

const sha256 = (text) => `sha256-${createHash('sha256').update(text, 'utf8').digest('base64')}`

const csp = /^\s*Content-Security-Policy:\s*(.+)$/m.exec(headers)?.[1] ?? ''

describe('the CSP hash still matches the script it was taken from', () => {
  it('finds exactly one inline script in index.html', () => {
    // The whole check assumes there is one. Two would mean the CSP needs a
    // second hash, and silently grading only the first is how this ends up
    // passing while the page is broken.
    expect(inlineScripts(html)).toHaveLength(1)
  })

  it('names a hash for it in the policy', () => {
    expect(csp).not.toBe('')
    expect(csp).toMatch(/script-src[^;]*'sha256-/)
  })

  it('has not drifted', () => {
    const expected = sha256(inlineScripts(html)[0])
    expect(csp).toContain(`'${expected}'`)
  })

  it('proves its own arithmetic — a changed script produces a different hash', () => {
    // Without this, sha256() could return a constant and the test above would
    // pass against any script at all.
    const script = inlineScripts(html)[0]
    expect(sha256(script)).not.toBe(sha256(`${script} `))
  })
})

describe('the policy covers what the app actually talks to', () => {
  // These are the two hosts the browser reaches at runtime. Everything else the
  // bundle mentions is an <a href> the user clicks, which no directive governs.

  it('allows the API in connect-src', () => {
    expect(csp).toMatch(/connect-src[^;]*https:\/\/meander-app\.duckdns\.org/)
  })

  it('allows the tile host in connect-src and img-src both', () => {
    // Tiles, style JSON, glyphs and sprite are fetched; the sprite sheet is
    // also drawn. Naming it in only one of the two is a blank map.
    expect(csp).toMatch(/connect-src[^;]*https:\/\/tiles\.openfreemap\.org/)
    expect(csp).toMatch(/img-src[^;]*https:\/\/tiles\.openfreemap\.org/)
  })

  it('carries no leftover placeholder host', () => {
    // docs/legacy/vercel.json still says REPLACE-WITH-YOUR-RENDER-HOST, and it
    // is right to. Here it would be a live hole.
    expect(csp).not.toMatch(/REPLACE-WITH-YOUR/)
    expect(csp).not.toMatch(/onrender\.com/)
  })

  it('still refuses to be framed and to submit a form anywhere', () => {
    expect(csp).toMatch(/frame-ancestors\s+'none'/)
    expect(csp).toMatch(/form-action\s+'none'/)
    expect(csp).toMatch(/base-uri\s+'self'/)
  })
})
