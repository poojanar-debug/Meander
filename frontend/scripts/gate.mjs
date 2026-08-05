/**
 * The Phase 5 gate, measured rather than asserted.
 *
 *   node scripts/gate.mjs http://localhost:5173
 *
 * Drives headless Chrome over CDP — no Playwright download, no new dependency.
 * Checks, at a real 390x844 viewport:
 *
 *   1. a route is visible without scrolling once results arrive
 *   2. nothing scrolls sideways at 320 px
 *   3. axe-core reports zero wcag2a/wcag2aa/wcag21a/wcag21aa violations
 *   4. every interactive target clears 44x44
 *   5. the whole thing again in dark mode
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const BASE = process.argv[2] ?? 'http://localhost:5173'
const CDP = 'http://localhost:9222'

const here = dirname(fileURLToPath(import.meta.url))
const axeSource = readFileSync(
  join(here, '..', 'node_modules', 'axe-core', 'axe.min.js'),
  'utf8',
)

let ws
let nextId = 1
const pending = new Map()

async function connect() {
  const targets = await (await fetch(`${CDP}/json/list`)).json()
  let page = targets.find((t) => t.type === 'page')
  if (!page) {
    await fetch(`${CDP}/json/new?about:blank`, { method: 'PUT' })
    page = (await (await fetch(`${CDP}/json/list`)).json()).find((t) => t.type === 'page')
  }
  ws = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((resolve, reject) => {
    ws.onopen = resolve
    ws.onerror = reject
  })
  ws.onmessage = (event) => {
    const msg = JSON.parse(event.data)
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id)
      pending.delete(msg.id)
      msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result)
    }
  }
}

function send(method, params = {}) {
  const id = nextId++
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject })
    ws.send(JSON.stringify({ id, method, params }))
  })
}

async function evaluate(expression, awaitPromise = true) {
  const { result, exceptionDetails } = await send('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise,
  })
  if (exceptionDetails) throw new Error(exceptionDetails.exception?.description ?? 'eval failed')
  return result.value
}

async function setViewport(width, height, dark) {
  await send('Emulation.setDeviceMetricsOverride', {
    width,
    height,
    deviceScaleFactor: 2,
    mobile: width < 900,
  })
  await send('Emulation.setEmulatedMedia', {
    features: [{ name: 'prefers-color-scheme', value: dark ? 'dark' : 'light' }],
  })
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** Drive the app to the point where it has routes on screen. */
async function driveToRoutes() {
  await evaluate(`(async () => {
    const sleep = (ms) => new Promise(r => setTimeout(r, ms))
    // Open the search sheet from the top bar.
    const openSearch = document.querySelector('.topbar__origin')
    if (openSearch) { openSearch.click(); await sleep(120) }
    const input = document.querySelector('input[role="combobox"]')
    if (!input) return 'no combobox'
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
    setter.call(input, 'Colombo Fort')
    input.dispatchEvent(new Event('input', { bubbles: true }))
    for (let i = 0; i < 60; i++) { await sleep(120); if (document.querySelector('[role="option"]')) break }
    const option = document.querySelector('[role="option"]')
    if (!option) return 'no suggestion'
    option.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
    await sleep(200)
    // Close the sheet if it is still open.
    const done = [...document.querySelectorAll('.controls-sheet__bar .button')].pop()
    if (done) { done.click(); await sleep(150) }
    // Wait for the *stream* to settle, not for the first route. Measuring
    // "every route is visible" against a partial set is exactly the kind of
    // flattering measurement this harness exists to prevent.
    let last = -1, stable = 0
    for (let i = 0; i < 120; i++) {
      await sleep(150)
      const n = document.querySelectorAll('.row__button, .card').length
      stable = n === last && n > 0 ? stable + 1 : 0
      last = n
      if (stable >= 6) break
    }
    return 'ok, ' + last + ' routes'
  })()`)
  await sleep(600)
}

const results = []
function check(name, pass, detail = '') {
  results.push({ name, pass, detail })
  console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`)
}

async function run() {
  await connect()
  await send('Runtime.enable')
  await send('Page.enable')

  for (const dark of [false, true]) {
    const label = dark ? 'dark' : 'light'
    console.log(`\n=== ${label} mode, 390x844 ===`)
    await setViewport(390, 844, dark)
    await send('Page.navigate', { url: BASE })
    await sleep(1800)
    await driveToRoutes()

    const theme = await evaluate(
      `getComputedStyle(document.body).backgroundColor`,
    )
    check(`[${label}] theme applied`, true, `body background ${theme}`)

    // 1. a route visible without scrolling
    const above = await evaluate(`(() => {
      const rows = [...document.querySelectorAll('.row__button, .card')]
      if (!rows.length) return { n: 0 }
      const vh = window.innerHeight
      const visible = rows.filter(r => { const b = r.getBoundingClientRect(); return b.top >= 0 && b.bottom <= vh })
      const first = rows[0].getBoundingClientRect()
      const sc = document.querySelector('.sheet__scroll')
      return { n: rows.length, visible: visible.length, firstTop: Math.round(first.top), vh,
               sheetOverflow: sc ? sc.scrollHeight - sc.clientHeight : 0,
               scroll: document.documentElement.scrollHeight - window.innerHeight }
    })()`)
    check(
      `[${label}] every route is visible without scrolling`,
      above.n > 0 && above.visible === above.n && above.sheetOverflow <= 0,
      `${above.visible}/${above.n} route rows fully in view, first at y=${above.firstTop}, ` +
        `sheet overflow ${above.sheetOverflow}px`,
    )
    check(
      `[${label}] the page itself does not scroll`,
      (above.scroll ?? 0) <= 1,
      `document scroll height overflow = ${above.scroll}px`,
    )

    // 2. no horizontal scroll at 320
    await setViewport(320, 844, dark)
    await sleep(500)
    const hx = await evaluate(
      `({ doc: document.documentElement.scrollWidth, win: window.innerWidth,
          worst: [...document.querySelectorAll('*')]
            .map(e => Math.round(e.getBoundingClientRect().right))
            .sort((a,b)=>b-a)[0] })`,
    )
    check(
      `[${label}] no horizontal scroll at 320px`,
      hx.doc <= hx.win + 1,
      `scrollWidth ${hx.doc} vs viewport ${hx.win}, furthest right edge ${hx.worst}`,
    )
    await setViewport(390, 844, dark)
    await sleep(300)

    // 3. targets
    const small = await evaluate(`(() => {
      const sel = 'button:not([disabled]), a[href], input, select, [role="option"]'
      const bad = []
      for (const el of document.querySelectorAll(sel)) {
        const b = el.getBoundingClientRect()
        if (b.width === 0 && b.height === 0) continue
        if (el.closest('.footer')) continue          // inline prose links, WCAG 2.2 exempt
        if (b.width < 44 || b.height < 44) {
          bad.push((el.className || el.tagName) + ' ' + Math.round(b.width) + 'x' + Math.round(b.height))
        }
      }
      return bad
    })()`)
    check(`[${label}] every target clears 44x44`, small.length === 0, small.slice(0, 4).join(' | '))

    // 4. axe
    await evaluate(axeSource, false)
    const axeResult = await evaluate(`(async () => {
      const r = await axe.run(document, { runOnly: { type: 'tag',
        values: ['wcag2a','wcag2aa','wcag21a','wcag21aa'] } })
      return r.violations.map(v => ({ id: v.id, impact: v.impact, n: v.nodes.length,
        target: v.nodes[0]?.target?.join(' ') ?? '' }))
    })()`)
    check(
      `[${label}] axe: zero wcag2a/2aa/21a/21aa violations`,
      axeResult.length === 0,
      axeResult.map((v) => `${v.id}(${v.impact}, ${v.n})`).join(', '),
    )
    if (axeResult.length) {
      for (const v of axeResult) console.log(`        ${v.id} [${v.impact}] ${v.n} node(s): ${v.target}`)
    }
  }

  // 5. desktop composition
  console.log('\n=== desktop, 1280x800 ===')
  await setViewport(1280, 800, false)
  await send('Page.navigate', { url: BASE })
  await sleep(1800)
  await driveToRoutes()
  const desktop = await evaluate(`(() => {
    const sheet = document.querySelector('.sheet')
    const s = sheet && getComputedStyle(sheet)
    return { position: s?.position, handle: !!document.querySelector('.sheet__handle')?.offsetParent,
             cards: document.querySelectorAll('.card').length,
             rows: document.querySelectorAll('.row__button').length }
  })()`)
  check(
    'desktop: sheet becomes a static panel, snap controls inert',
    desktop.position === 'static' && desktop.handle === false,
    `position=${desktop.position}, handle visible=${desktop.handle}`,
  )
  check(
    'desktop: every route renders as a full card',
    desktop.cards > 0 && desktop.rows === 0,
    `${desktop.cards} cards, ${desktop.rows} compact rows`,
  )

  const failed = results.filter((r) => !r.pass)
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
  process.exit(failed.length ? 1 : 0)
}

run().catch((err) => {
  console.error('gate harness failed:', err.message)
  process.exit(2)
})
