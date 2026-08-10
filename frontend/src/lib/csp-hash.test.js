import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
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
 *
 * ── the first version of this file did not work ──────────────────────────────
 *
 * A reviewer who had not written it broke it three ways in one pass, each
 * verified by mutation, each leaving all eight assertions green:
 *
 *   1. It found the policy with a global regex over the whole file, so moving
 *      the header out of `/*` and under `/index.html` — a pattern this project's
 *      own _headers documents as a 308 nobody consumes — passed, while every
 *      document shipped with no CSP at all. The exact state the file exists to
 *      fix.
 *   2. "names a hash" and "the hash matches" were two independent substring
 *      checks, so a bogus hash in script-src and the real one in style-src
 *      passed, with the inline script blocked in production.
 *   3. It hashed index.html; the browser runs dist/index.html. Vite substitutes
 *      %VITE_*% tokens inside the HTML, including inside the inline script, so
 *      those two files are not the same bytes by rule — only by luck today.
 *
 * So this version parses _headers into real blocks, checks the directive rather
 * than the line, and makes source-equals-dist a property instead of a hope.
 */

const read = (p) => readFileSync(fileURLToPath(new URL(p, import.meta.url)), 'utf8')
const path = (p) => fileURLToPath(new URL(p, import.meta.url))

const html = read('../../index.html')
const headers = read('../../public/_headers')

/**
 * Parse a Cloudflare Pages _headers file into [pattern, {header: value}] pairs.
 *
 * Comments are whole lines beginning with `#`. A non-indented, non-comment line
 * opens a rule; indented `Name: value` lines belong to the rule above it.
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

/** Would this _headers pattern match a request for the document at `/`? */
function coversDocuments(pattern) {
  return pattern === '/*' || pattern === '/'
}

/**
 * Every inline <script> in the document — one with a `src` is not inline.
 *
 * The attributes are stripped of quoted values before `src` is looked for.
 * A lookahead over the raw tag reads `<script data-note="not really src=x">` as
 * external and skips it, which is an unhashed executable script the gate cannot
 * see. Found by mutation, not by thinking about it.
 */
function inlineScripts(source) {
  return [...source.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)]
    .filter((m) => !/\bsrc\s*=/.test(m[1].replace(/"[^"]*"|'[^']*'/g, '')))
    .map((m) => m[2])
}

const sha256 = (text) => `sha256-${createHash('sha256').update(text, 'utf8').digest('base64')}`

/** Pull one directive's value out of a policy string. */
function directive(policy, name) {
  const m = new RegExp(`(?:^|;)\\s*${name}\\s+([^;]*)`).exec(policy)
  return m ? m[1].trim() : null
}

const blocks = parseHeaders(headers)
const documentBlocks = blocks.filter((b) => coversDocuments(b.pattern))
const documentCsp = documentBlocks
  .map((b) => b.headers['content-security-policy'])
  .filter(Boolean)

describe('the policy is attached to the rule that serves documents', () => {
  it('parses the file into blocks at all', () => {
    // If the parser found nothing, everything below grades nothing.
    expect(blocks.length).toBeGreaterThan(0)
    expect(blocks.map((b) => b.pattern)).toContain('/*')
  })

  it('sets a CSP under a pattern that actually covers `/`', () => {
    // Not "somewhere in the file". Under /* or /, or the document has no policy
    // however good the string is.
    expect(documentCsp).toHaveLength(1)
    expect(documentCsp[0].length).toBeGreaterThan(0)
  })

  it('sets the other document headers there too', () => {
    const h = documentBlocks.find((b) => b.headers['content-security-policy']).headers
    expect(h['x-frame-options']).toBe('DENY')
    expect(h['referrer-policy']).toBe('no-referrer')
    expect(h['x-content-type-options']).toBe('nosniff')
    expect(h['permissions-policy']).toMatch(/geolocation=\(self\)/)
  })

  it('keeps Cache-Control off /*, because Pages comma-joins duplicates', () => {
    const star = blocks.find((b) => b.pattern === '/*')
    expect(star.headers['cache-control']).toBeUndefined()
  })
})

const csp = documentCsp[0] ?? ''

describe('the CSP hash still matches the script it was taken from', () => {
  it('finds exactly one inline script in index.html', () => {
    // The whole check assumes there is one. Two would mean the CSP needs a
    // second hash, and silently grading only the first is how this ends up
    // passing while the page is broken.
    expect(inlineScripts(html)).toHaveLength(1)
  })

  it('carries the hash inside script-src specifically', () => {
    // Not "somewhere in the policy". A hash sitting in style-src governs
    // nothing about a <script>.
    const scriptSrc = directive(csp, 'script-src')
    expect(scriptSrc).not.toBeNull()
    expect(scriptSrc).toContain(`'${sha256(inlineScripts(html)[0])}'`)
  })

  it('carries no OTHER script hash that no longer corresponds to anything', () => {
    const scriptSrc = directive(csp, 'script-src') ?? ''
    const hashes = [...scriptSrc.matchAll(/'sha256-[^']+'/g)].map((m) => m[0])
    expect(hashes).toEqual([`'${sha256(inlineScripts(html)[0])}'`])
  })

  it('proves its own arithmetic — a changed script produces a different hash', () => {
    // Without this, sha256() could return a constant and everything above would
    // pass against any script at all.
    const script = inlineScripts(html)[0]
    expect(sha256(script)).not.toBe(sha256(`${script} `))
  })

  it('leaves nothing in the script for Vite to substitute at build time', () => {
    // This is what makes hashing the source legitimate. Vite replaces %VITE_*%,
    // %MODE% and %BASE_URL% inside index.html — including inside this script —
    // so a token here would make dist differ from source, and the shipped page
    // would carry a hash of bytes that were never served.
    expect(inlineScripts(html)[0]).not.toMatch(/%[A-Z_][A-Z0-9_]*%/)
  })

  it('agrees with the built file, when there is one to compare against', () => {
    // Belt as well as braces. `make check` runs the suite before the build, so
    // dist may be absent or stale — its absence is not a failure, but a
    // disagreement is.
    const dist = path('../../dist/index.html')
    if (!existsSync(dist)) return
    const built = inlineScripts(readFileSync(dist, 'utf8'))
    expect(built).toHaveLength(1)
    expect(directive(csp, 'script-src')).toContain(`'${sha256(built[0])}'`)
  })
})

describe('the policy covers what the app actually talks to', () => {
  // These are the two hosts the browser reaches at runtime. Everything else the
  // bundle mentions is an <a href> the user clicks, which no directive governs.

  it('allows the API in connect-src', () => {
    expect(directive(csp, 'connect-src')).toContain('https://meander-app.duckdns.org')
  })

  it('allows the tile host in connect-src and img-src both', () => {
    // Tiles, style JSON, glyphs and sprite are fetched; the sprite sheet is
    // also drawn. Naming it in only one of the two is a blank map.
    expect(directive(csp, 'connect-src')).toContain('https://tiles.openfreemap.org')
    expect(directive(csp, 'img-src')).toContain('https://tiles.openfreemap.org')
  })

  it('allows MapLibre its blob worker, on old Safari as well as Chrome', () => {
    expect(directive(csp, 'worker-src')).toContain('blob:')
    // Safari before 15.4 has no worker-src and falls back through child-src.
    expect(directive(csp, 'child-src')).toContain('blob:')
  })

  it('carries no leftover placeholder host', () => {
    // docs/legacy/vercel.json still says REPLACE-WITH-YOUR-RENDER-HOST, and it
    // is right to. Here it would be a live hole.
    expect(csp).not.toMatch(/REPLACE-WITH-YOUR/)
    expect(csp).not.toMatch(/onrender\.com/)
  })

  it('still refuses to be framed and to submit a form anywhere', () => {
    expect(directive(csp, 'frame-ancestors')).toBe("'none'")
    expect(directive(csp, 'form-action')).toBe("'none'")
    expect(directive(csp, 'base-uri')).toBe("'self'")
    expect(directive(csp, 'default-src')).toBe("'self'")
  })
})
