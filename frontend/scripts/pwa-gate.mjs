/**
 * The Phase 6.5 gate: does the app actually work with the server taken away,
 * and is a route it serves from disk unmistakably labelled as one?
 *
 *     node scripts/pwa-gate.mjs
 *
 * Separate from gate.mjs on purpose. That harness measures the Phase 5 layout
 * and its score is quoted as 14/14; adding checks to it would move a number
 * other people are reading. This one owns the service worker.
 *
 * **It does not emulate being offline. It stops the server.**
 * `Network.emulateNetworkConditions` applies to the page's network stack, and
 * the requests that matter here are made by the service worker — so an
 * emulated-offline run can pass while a real one fails. Killing `vite preview`
 * makes the origin genuinely unreachable for every consumer at once, which is
 * the condition being claimed.
 *
 * Prerequisites, both of which it checks for:
 *   * a production build in dist/ — `npm run build`
 *   * the API on :8000 — `python -m uvicorn backend.main:app --port 8000`
 *     (a dev server is no use: sw.js is emitted by a build plugin)
 *   * headless Chrome with CDP on :9222, as for gate.mjs
 *
 * Note which wording is expected. The machine still has a network when the
 * server is gone, so `navigator.onLine` is true and the app must say "could not
 * reach the server", not "you are offline". Sending somebody to check their
 * wifi when their wifi is fine is a small lie with a real cost. The other
 * wording is covered by check-offline.mjs, which can set that flag directly.
 */

import { spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const PORT = 5200
const BASE = `http://localhost:${PORT}`
const API = 'http://localhost:8000'
const CDP = 'http://localhost:9222'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const axeSource = readFileSync(join(root, 'node_modules', 'axe-core', 'axe.min.js'), 'utf8')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// --- the preview server, which this harness turns off on purpose ------------

let preview = null

/**
 * Vite is spawned directly, not through `npx`, and in its own process group.
 *
 * `npx vite preview` is a parent that forks the real server: killing it leaves
 * the child holding the port, so the "server is gone" half of this harness
 * quietly never happened and every offline check would have been measuring a
 * perfectly reachable origin. Detached + `kill(-pid)` takes the group.
 */
async function startPreview() {
  preview = spawn(
    join(root, 'node_modules', '.bin', 'vite'),
    ['preview', '--port', String(PORT), '--strictPort'],
    { cwd: root, stdio: 'ignore', detached: true },
  )
  for (let i = 0; i < 80; i += 1) {
    await sleep(250)
    try {
      const res = await fetch(`${BASE}/sw.js`)
      if (res.ok) return
    } catch {
      // not up yet
    }
  }
  throw new Error('vite preview did not come up')
}

async function stopPreview() {
  if (!preview) return
  const { pid } = preview
  preview = null
  try {
    process.kill(-pid, 'SIGKILL')
  } catch {
    try {
      process.kill(pid, 'SIGKILL')
    } catch {
      /* already gone */
    }
  }
  for (let i = 0; i < 60; i += 1) {
    await sleep(150)
    try {
      await fetch(`${BASE}/sw.js`)
    } catch {
      return // connection refused, which is the point
    }
  }
  throw new Error('vite preview would not go away')
}

// --- CDP --------------------------------------------------------------------

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

async function go(url) {
  await send('Page.navigate', { url })
  await sleep(1500)
}

async function setViewport(width, height) {
  await send('Emulation.setDeviceMetricsOverride', {
    width,
    height,
    deviceScaleFactor: 2,
    mobile: width < 900,
  })
}

// --- app driving ------------------------------------------------------------

/** Wait until a service worker is actually controlling this page. */
const waitForController = () =>
  evaluate(`(async () => {
    for (let i = 0; i < 100; i++) {
      if (navigator.serviceWorker.controller) return 'controlled'
      await new Promise(r => setTimeout(r, 100))
    }
    return 'uncontrolled'
  })()`)

/** Search for a place and wait for the route stream to settle. */
const driveToRoutes = () =>
  evaluate(`(async () => {
    const sleep = (ms) => new Promise(r => setTimeout(r, ms))
    const openSearch = document.querySelector('.topbar__origin')
    if (openSearch) { openSearch.click(); await sleep(150) }
    const input = document.querySelector('input[role="combobox"]')
    if (!input) return 'no combobox'
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
    setter.call(input, 'Hyde Park, London')
    input.dispatchEvent(new Event('input', { bubbles: true }))
    for (let i = 0; i < 80; i++) { await sleep(150); if (document.querySelector('[role="option"]')) break }
    const option = document.querySelector('[role="option"]')
    if (!option) return 'no suggestion'
    option.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
    await sleep(300)
    const done = [...document.querySelectorAll('.controls-sheet__bar .button')].pop()
    if (done) { done.click(); await sleep(200) }
    let last = -1, stable = 0
    for (let i = 0; i < 200; i++) {
      await sleep(200)
      const n = document.querySelectorAll('.row__button, .card').length
      stable = n === last && n > 0 ? stable + 1 : 0
      last = n
      if (stable >= 6) break
    }
    return 'ok, ' + last + ' routes'
  })()`)

/** Wait for a reloaded page to replay its permalink request and settle. */
const waitForRoutes = (timeoutMs = 30000) =>
  evaluate(`(async () => {
    const sleep = (ms) => new Promise(r => setTimeout(r, ms))
    const deadline = Date.now() + ${timeoutMs}
    let last = -1, stable = 0
    while (Date.now() < deadline) {
      await sleep(200)
      const n = document.querySelectorAll('.row__button, .card').length
      if (document.querySelector('.banner--warn') && n === 0) return 'error banner'
      stable = n === last && n > 0 ? stable + 1 : 0
      last = n
      if (stable >= 5) break
    }
    return last > 0 ? 'ok, ' + last + ' routes' : 'no routes'
  })()`)

/** Click the opt-in control in the settings sheet, by its visible label. */
const setKeepResults = (keep) =>
  evaluate(`(async () => {
    const sleep = (ms) => new Promise(r => setTimeout(r, ms))
    document.querySelector('.topbar__time')?.click()
    await sleep(250)
    const legend = [...document.querySelectorAll('legend')]
      .find(l => /Keep my last route/i.test(l.textContent))
    if (!legend) return 'no control'
    const want = ${keep ? "'Keep it'" : "'Don’t keep it'"}
    const button = [...legend.parentElement.querySelectorAll('.chip')]
      .find(b => b.textContent.trim() === want)
    if (!button) return 'no button'
    button.click()
    await sleep(400)
    const closer = [...document.querySelectorAll('.controls-sheet__bar .button')].pop()
    if (closer) { closer.click(); await sleep(250) }
    return button.getAttribute('aria-pressed') === 'true' ? 'set' : 'not set'
  })()`)

// --- results ----------------------------------------------------------------

const results = []
function check(name, pass, detail = '') {
  results.push({ name, pass, detail })
  console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`)
}

async function run() {
  if (!existsSync(join(root, 'dist', 'sw.js'))) {
    throw new Error('no dist/sw.js — run `npm run build` first')
  }
  try {
    await fetch(`${API}/healthz`)
  } catch {
    throw new Error(`no API on ${API} — start uvicorn first`)
  }

  await connect()
  await send('Runtime.enable')
  await send('Page.enable')
  await setViewport(390, 844)
  await startPreview()

  // A previous run's worker would serve a previous run's cache.
  console.log('\n=== a clean device ===')
  await go(BASE)
  await evaluate(`(async () => {
    for (const r of await navigator.serviceWorker.getRegistrations()) await r.unregister()
    for (const k of await caches.keys()) await caches.delete(k)
    localStorage.clear()
    return 'cleared'
  })()`)
  await go(BASE)
  const controlled = await waitForController()
  check('the service worker registers and takes control', controlled === 'controlled', controlled)

  const manifest = await evaluate(`(async () => {
    const link = document.querySelector('link[rel="manifest"]')
    if (!link) return { linked: false }
    const res = await fetch(link.href)
    const body = await res.json()
    const sizes = []
    for (const icon of body.icons ?? []) {
      const r = await fetch(icon.src)
      sizes.push(icon.sizes + ':' + r.status + ':' + (icon.purpose ?? 'any'))
    }
    return { linked: true, name: body.name, display: body.display,
             start: body.start_url, icons: sizes }
  })()`)
  check(
    'the manifest is linked, parses, and every icon it names resolves',
    manifest.linked &&
      manifest.display === 'standalone' &&
      manifest.icons.length >= 3 &&
      manifest.icons.every((i) => i.includes(':200:')),
    `${manifest.display}, icons ${manifest.icons?.join(' ')}`,
  )
  check(
    'a maskable icon is a separate drawing, not the standard one relabelled',
    (manifest.icons ?? []).some((i) => i.includes('maskable')),
    manifest.icons?.join(' '),
  )

  // --- the default: nothing is kept -----------------------------------------

  console.log('\n=== opt-in is off by default ===')
  const pref = await evaluate(`localStorage.getItem('meander.offline')`)
  check('no storage preference is written until the user picks one', pref === null, String(pref))

  const drove = await driveToRoutes()
  check('routes stream from the live backend', drove.startsWith('ok'), drove)
  const permalink = await evaluate(`location.href`)
  check(
    'the controls are written to the URL, which is what makes an offline reload possible',
    permalink.includes('from='),
    permalink.replace(BASE, ''),
  )

  await sleep(800)
  const storedWhileOff = await evaluate(`(async () => {
    const keys = await caches.keys()
    const results = keys.filter(k => k.startsWith('meander-results'))
    let n = 0
    for (const k of results) n += (await (await caches.open(k)).keys()).length
    return { caches: keys, entries: n }
  })()`)
  check(
    'THE OPT-IN: no result is written to disk without permission',
    storedWhileOff.entries === 0,
    `${storedWhileOff.entries} entries in ${storedWhileOff.caches.join(', ')}`,
  )
  check(
    'the shell is cached anyway — it is the program, not a location',
    storedWhileOff.caches.some((k) => k.startsWith('meander-shell')),
    storedWhileOff.caches.join(', '),
  )

  console.log('\n=== the server goes away, with nothing kept ===')
  await stopPreview()
  await go(permalink)
  const shellOffline = await evaluate(
    `!!document.querySelector('.topbar__origin') && !!document.querySelector('.shell')`,
  )
  check('the app still opens with the origin unreachable', shellOffline === true, 'shell served from cache')
  const noCopy = await waitForRoutes(20000)
  const offlineState = await evaluate(`({
    banner: document.querySelector('.banner--warn')?.textContent ?? '',
    cachedMarks: document.querySelectorAll('.row__cached, .offline, .trust--cached').length,
  })`)
  check(
    'with nothing kept, it says it could not reach the server rather than inventing a route',
    noCopy === 'error banner' && offlineState.cachedMarks === 0,
    `${noCopy}; ${offlineState.cachedMarks} cached marks; "${offlineState.banner.slice(0, 60)}"`,
  )

  // --- opting in ------------------------------------------------------------

  console.log('\n=== opting in, then losing the server ===')
  await startPreview()
  await go(BASE)
  await waitForController()
  const set = await setKeepResults(true)
  check('the opt-in control turns it on', set === 'set', set)

  // Checked, not assumed. Caching the stream used to block the response on
  // draining a copy of it, which deadlocked the request — and the only symptom
  // was an empty cache two checks later, pointing nowhere near streaming.
  const droveWithCaching = await driveToRoutes()
  check(
    'routes still stream while the worker is also saving them',
    droveWithCaching.startsWith('ok'),
    droveWithCaching,
  )
  const permalink2 = await evaluate(`location.href`)
  await sleep(1500)
  const storedWhileOn = await evaluate(`(async () => {
    const keys = (await caches.keys()).filter(k => k.startsWith('meander-results'))
    let n = 0
    for (const k of keys) n += (await (await caches.open(k)).keys()).length
    return n
  })()`)
  check('with permission, exactly one result is kept — never a history', storedWhileOn === 1, `${storedWhileOn} entries`)

  await stopPreview()
  await go(permalink2)
  const replayed = await waitForRoutes(25000)
  check('the saved route is served with the origin unreachable', replayed.startsWith('ok'), replayed)

  // --- the requirement ------------------------------------------------------

  console.log('\n=== the requirement: labelled as cached, with its age ===')
  const labelled = await evaluate(`(() => {
    const rows = [...document.querySelectorAll('.row')]
    const pill = document.querySelector('.topbar__cached')
    return {
      rows: rows.length,
      rowsLabelled: rows.filter(r => r.querySelector('.row__cached')).length,
      rowText: rows[0]?.querySelector('.row__cached')?.textContent ?? '',
      pill: pill?.textContent ?? '',
      banner: document.querySelector('.banner--warn')?.textContent ?? '',
    }
  })()`)
  const AGE = /(just now|\\d+\\s*[mhd] ago|less than a minute|minutes? ago|hours? ago|days? ago|unknown)/i
  check(
    'every route row carries the saved-copy label',
    labelled.rows > 0 && labelled.rowsLabelled === labelled.rows,
    `${labelled.rowsLabelled}/${labelled.rows} rows, first reads "${labelled.rowText}"`,
  )
  check(
    'the row label states an age',
    AGE.test(labelled.rowText),
    `"${labelled.rowText}"`,
  )
  check(
    'a pill under the top bar states the age at every sheet snap',
    Boolean(labelled.pill) && AGE.test(labelled.pill),
    `"${labelled.pill}"`,
  )

  const peek = await evaluate(`(() => {
    const rows = [...document.querySelectorAll('.row__button')]
    const vh = window.innerHeight
    const visible = rows.filter(r => { const b = r.getBoundingClientRect(); return b.top >= 0 && b.bottom <= vh })
    const sc = document.querySelector('.sheet__scroll')
    return { n: rows.length, visible: visible.length,
             overflow: sc ? sc.scrollHeight - sc.clientHeight : 0,
             snap: document.querySelector('.sheet')?.dataset.snap }
  })()`)
  check(
    'a two-line row does not cost a route: three still fit at peek without scrolling',
    peek.n === 3 && peek.visible === 3 && peek.overflow <= 0,
    `snap=${peek.snap}, ${peek.visible}/${peek.n} visible, sheet overflow ${peek.overflow}px`,
  )

  await setViewport(320, 844)
  await sleep(400)
  const narrow = await evaluate(
    `({ doc: document.documentElement.scrollWidth, win: window.innerWidth })`,
  )
  check(
    'still nothing scrolls sideways at 320px with the labels on',
    narrow.doc <= narrow.win + 1,
    `scrollWidth ${narrow.doc} vs ${narrow.win}`,
  )
  await setViewport(390, 844)
  await sleep(300)

  // Expand the sheet: the long form, on the cards.
  const expanded = await evaluate(`(async () => {
    const sleep = (ms) => new Promise(r => setTimeout(r, ms))
    const full = [...document.querySelectorAll('.sheet__snap')].pop()
    if (full) { full.click(); await sleep(500) }
    const cards = [...document.querySelectorAll('.card')]
    return {
      cards: cards.length,
      cardsLabelled: cards.filter(c => c.querySelector('.trust--cached, .trust--loud')).length,
      block: document.querySelector('.offline')?.textContent ?? '',
      departure: document.querySelector('.better-later__head')?.textContent ?? '',
      expired: document.querySelector('.better-later--expired')?.textContent ?? '',
    }
  })()`)
  check(
    'every card carries the saved-copy statement',
    expanded.cards > 0 && expanded.cardsLabelled === expanded.cards,
    `${expanded.cardsLabelled}/${expanded.cards} cards`,
  )
  // The machine's network is fine here — only the origin is gone — so the app
  // must blame the server, not the wifi. Telling this user they are offline
  // sends them to restart a router that was never the problem.
  check(
    'the long form states the age and blames the server, not the wifi',
    /could not reach the server/i.test(expanded.block) &&
      /saved/i.test(expanded.block) &&
      !/you are offline/i.test(expanded.block),
    `"${expanded.block.slice(0, 120)}"`,
  )

  // --- revoking -------------------------------------------------------------

  console.log('\n=== withdrawing permission ===')
  const unset = await setKeepResults(false)
  check('the opt-in control turns it off again', unset === 'set', unset)
  await sleep(800)
  const afterRevoke = await evaluate(`(async () => {
    const keys = (await caches.keys()).filter(k => k.startsWith('meander-results'))
    let n = 0
    for (const k of keys) n += (await (await caches.open(k)).keys()).length
    return { caches: keys.length, entries: n }
  })()`)
  check(
    'THE REVOCATION: turning it off deletes what was stored, it does not merely stop adding',
    afterRevoke.entries === 0,
    `${afterRevoke.entries} entries, ${afterRevoke.caches} result cache(s)`,
  )

  // --- accessibility of the offline state -----------------------------------

  console.log('\n=== the offline state is still accessible ===')
  await startPreview()
  await go(BASE)
  await waitForController()
  await setKeepResults(true)
  await driveToRoutes()
  const permalink3 = await evaluate(`location.href`)
  await sleep(1000)
  await stopPreview()
  await go(permalink3)
  await waitForRoutes(25000)

  await evaluate(axeSource, false)
  const violations = await evaluate(`(async () => {
    const r = await axe.run(document, { runOnly: { type: 'tag',
      values: ['wcag2a','wcag2aa','wcag21a','wcag21aa'] } })
    return r.violations.map(v => v.id + '(' + v.impact + ',' + v.nodes.length + ')')
  })()`)
  check(
    'axe: zero wcag2a/2aa/21a/21aa violations while serving a saved copy',
    violations.length === 0,
    violations.join(', '),
  )

  const announced = await evaluate(
    `document.querySelector('[role="status"][aria-live="polite"]')?.textContent ?? ''`,
  )
  check(
    'the live region says it is a saved copy before it reads out the routes',
    /saved copy/i.test(announced) &&
      announced.toLowerCase().indexOf('saved copy') < announced.toLowerCase().indexOf('minute'),
    `"${announced.slice(0, 80)}"`,
  )

  const failed = results.filter((r) => !r.pass)
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
  return failed.length
}

let code = 2
try {
  code = (await run()) ? 1 : 0
} catch (err) {
  console.error('pwa gate harness failed:', err.message)
} finally {
  await stopPreview().catch(() => {})
}
process.exit(code)
