import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'

/**
 * The deployment gate, in a real browser, against the real deployment.
 *
 * curl does not enforce CORS, does not run a service worker, does not apply a
 * Content-Security-Policy and does not care whether a stream arrived in one
 * piece or twelve. Every one of those is a way this deployment can be broken
 * while every curl in the runbook stays green, so none of them can be checked
 * with curl. That is the whole reason this file exists.
 *
 * It follows scripts/gate.mjs: raw CDP over the WebSocket Node already has, no
 * dependencies, and a manifest that has to match something before anything is
 * graded. The difference is that this one talks to production.
 *
 *   node scripts/live-gate.mjs [site] [api]
 *
 * Defaults to https://meander-eoc.pages.dev and https://meander-app.duckdns.org.
 *
 * Not run by `make check`, deliberately: it needs the internet and it spends a
 * real rate-limit token on a shared deployment.
 */

const SITE = (process.argv[2] ?? 'https://meander-eoc.pages.dev').replace(/\/$/, '')
const API = (process.argv[3] ?? 'https://meander-app.duckdns.org').replace(/\/$/, '')
const CHROME =
  process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'

// London, so the demo region has a pre-warmed cache behind it.
const LAT = 51.5074
const LON = -0.1278

const results = []
const check = (name, ok, detail) => {
  results.push([name, ok, detail])
  return ok
}
const skip = (name, why) => results.push([name, null, why])

// ------------------------------------------------------------------ CDP glue

async function launch(port = 9445) {
  if (!existsSync(CHROME)) {
    console.error(`No Chrome at ${CHROME}. Set CHROME_PATH.`)
    process.exit(2)
  }
  const proc = spawn(
    CHROME,
    [
      '--headless=new',
      `--remote-debugging-port=${port}`,
      '--no-first-run',
      '--no-default-browser-check',
      `--user-data-dir=/tmp/meander-live-gate-${port}`,
      '--hide-scrollbars',
      // MapLibre is WebGL. Headless Chrome has no GPU, so without a software
      // rasteriser it never creates a canvas — and the map check would be
      // grading this machine rather than the deployment.
      '--enable-unsafe-swiftshader',
      '--use-gl=angle',
      '--use-angle=swiftshader',
      'about:blank',
    ],
    { stdio: 'ignore' },
  )
  for (let i = 0; i < 150; i += 1) {
    try {
      if ((await fetch(`http://127.0.0.1:${port}/json/version`)).ok) break
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 100))
  }
  return { proc, port }
}

async function connect(port) {
  const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
  const page = targets.find((t) => t.type === 'page')
  const ws = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((res, rej) => {
    ws.onopen = res
    ws.onerror = rej
  })
  let id = 0
  const pending = new Map()
  const listeners = []
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data)
    if (msg.id && pending.has(msg.id)) {
      const { res, rej } = pending.get(msg.id)
      pending.delete(msg.id)
      msg.error ? rej(new Error(JSON.stringify(msg.error))) : res(msg.result)
      return
    }
    if (msg.method) for (const fn of listeners) fn(msg.method, msg.params)
  }
  const send = (method, params = {}) =>
    new Promise((res, rej) => {
      pending.set((id += 1), { res, rej })
      ws.send(JSON.stringify({ id, method, params }))
    })
  const evaluate = async (expression) => {
    const r = await send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    })
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? 'eval')
    return r.result.value
  }
  return { send, evaluate, on: (fn) => listeners.push(fn), close: () => ws.close() }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function waitFor(cdp, expression, ms = 30000) {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (await cdp.evaluate(expression).catch(() => false)) return true
    await sleep(250)
  }
  return false
}

// ---------------------------------------------------------------- the harness

const { proc, port } = await launch()
const cdp = await connect(port)
await cdp.send('Page.enable')
await cdp.send('Runtime.enable')
await cdp.send('Log.enable')
await cdp.send('Network.enable')

// CSP violations are collected from the DOM event rather than by scraping
// console text. securitypolicyviolation fires with structured fields, so a
// violation cannot be missed because Chrome reworded its console message.
const violations = []
const consoleErrors = []
await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
  source: `
    window.__cspViolations = []
    document.addEventListener('securitypolicyviolation', (e) => {
      window.__cspViolations.push({
        directive: e.effectiveDirective,
        blocked: e.blockedURI,
        line: e.lineNumber,
      })
    })
    Object.defineProperty(navigator, 'geolocation', { configurable: true, value: {
      getCurrentPosition: (ok) => setTimeout(() => ok({
        coords: { latitude: ${LAT}, longitude: ${LON}, accuracy: 20 }, timestamp: Date.now() }), 10),
      watchPosition: (ok) => { setTimeout(() => ok({
        coords: { latitude: ${LAT}, longitude: ${LON}, accuracy: 20 }, timestamp: Date.now() }), 10); return 1 },
      clearWatch: () => {},
    }})
  `,
})

// Collection is gated, because two checks below break things on purpose: the
// CORS negative control and the offline reload both log errors, and counting
// those would make this assertion permanently red for the wrong reason.
let collecting = false
cdp.on((method, params) => {
  if (!collecting) return
  if (method === 'Log.entryAdded') {
    const e = params.entry
    if (e.level === 'error') consoleErrors.push(`${e.source}: ${e.text}`)
  }
  if (method === 'Runtime.consoleAPICalled' && params.type === 'error') {
    consoleErrors.push(params.args.map((a) => a.value ?? a.description ?? '').join(' '))
  }
})

// Every SSE chunk, with the time it landed. This is the only way to tell a
// stream from a buffered blob: both end with the same bytes.
let routeRequestId = null
const chunks = []
let responseAt = null
let routeWasCached = false
cdp.on((method, params) => {
  // POST only. /api/routes is preflighted — Content-Type: application/json is
  // not a CORS-safelisted value — so the OPTIONS goes out first under its own
  // requestId and finishes with no body at all. Latching onto whichever came
  // first meant watching the preflight and concluding the stream had no chunks,
  // which is the first thing this gate got wrong about itself.
  if (
    method === 'Network.requestWillBeSent' &&
    params.request.url.endsWith('/api/routes') &&
    params.request.method === 'POST'
  ) {
    routeRequestId = params.requestId
    chunks.length = 0
    responseAt = null
  }
  if (method === 'Network.responseReceived' && params.requestId === routeRequestId) {
    responseAt = params.timestamp
    // X-Meander-Cache is the server saying "I had this warm". A replayed route
    // is written to the socket as fast as it can be serialised, so it arrives
    // in a couple of chunks milliseconds apart — indistinguishable, by timing
    // alone, from a proxy that buffered the whole thing. Measured: a warm
    // request came back in 2 reads spanning 27 ms, against 6 reads spanning
    // 2.9 s cold. Asserting a time spread without checking this first is a gate
    // that fails on a healthy deployment whenever someone ran it recently.
    const h = params.response.headers ?? {}
    routeWasCached = Object.entries(h).some(
      ([k, v]) => k.toLowerCase() === 'x-meander-cache' && String(v).toLowerCase() !== 'miss',
    )
  }
  if (method === 'Network.dataReceived' && params.requestId === routeRequestId) {
    chunks.push({ t: params.timestamp, n: params.dataLength })
  }
})

async function load(url, { width = 390, height = 844, mobile = true } = {}) {
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width,
    height,
    deviceScaleFactor: mobile ? 3 : 1,
    mobile,
  })
  await cdp.send('Page.navigate', { url })
  await waitFor(cdp, `document.readyState === 'complete'`, 30000)
  await sleep(600)
}

// A manifest, before anything that depends on it. Same reasoning as gate.mjs:
// a check that finds zero elements and passes reads as coverage.
const MANIFEST = [
  ['.app', 'App.jsx — the layout root'],
  ['.topbar', 'Topbar.jsx'],
  ['[role="status"][aria-live="polite"]', 'App.jsx — the one live region'],
]

console.log(`site ${SITE}\napi  ${API}\n`)

// ---------------------------------------------------------- 1. the site loads

await load(`${SITE}/`)

const counts = await cdp.evaluate(
  `(${JSON.stringify(MANIFEST.map((m) => m[0]))}).map(s => document.querySelectorAll(s).length)`,
)
let manifestOk = true
MANIFEST.forEach(([sel, owner], i) => {
  if (!check(`selector ${sel} matches something (${owner})`, counts[i] > 0, `${counts[i]} found`)) {
    manifestOk = false
  }
})

if (!manifestOk) {
  console.log('\nThe selector manifest failed. Everything below would grade nothing.\n')
  report()
  process.exit(1)
}

// ------------------------------------------------- 2. the CSP is real and clean

const cspHeader = await cdp.evaluate(`
  fetch(location.href, { method: 'GET', cache: 'no-store' })
    .then(r => r.headers.get('content-security-policy') || '')`)
check('a Content-Security-Policy is served', cspHeader.length > 0, `${cspHeader.length} chars`)
check(
  'the CSP names the API in connect-src',
  /connect-src[^;]*meander-app\.duckdns\.org/.test(cspHeader),
  '',
)

// -------------------------------------- 3. the route request, from this origin

await cdp.evaluate(
  `(()=>{const b=[...document.querySelectorAll('button')].find(x=>/use my location/i.test(x.textContent)); if(b) b.click()})()`,
)
const gotRoutes = await waitFor(cdp, `!!document.querySelector('.route__sub')`, 60000)
check('routes arrive in the browser from the Pages origin', gotRoutes, gotRoutes ? '' : 'timed out')

const routeCount = await cdp.evaluate(`document.querySelectorAll('button.route').length`)
check('three routes rendered', routeCount === 3, `${routeCount} rendered`)

// ------------------------------------------------------ 4. SSE actually streams

if (chunks.length && responseAt !== null) {
  const first = chunks[0].t
  const last = chunks[chunks.length - 1].t
  const spread = last - first
  const ttfb = first - responseAt
  check(
    'SSE arrived in more than one chunk',
    chunks.length > 1,
    `${chunks.length} chunks, ${chunks.reduce((a, c) => a + c.n, 0)} bytes`,
  )
  if (routeWasCached) {
    skip(
      'the chunks are spread over time, not one blob at the end',
      `the server replayed a cached route (${chunks.length} chunks in ${spread.toFixed(2)}s) — ` +
        'too fast to distinguish from buffering. Re-run against an uncached origin to grade this.',
    )
  } else {
    check(
      'the chunks are spread over time, not one blob at the end',
      chunks.length > 1 && spread > 0.25,
      `first→last ${spread.toFixed(2)}s, first chunk ${ttfb.toFixed(2)}s after headers`,
    )
  }
} else {
  check('SSE chunk timing was observable', false, 'no Network.dataReceived events captured')
}

// ------------------------------------------- 5. CORS is genuinely being enforced

// The negative control. Without this, "routes arrived" only proves the server
// answered — not that the browser would have refused a different origin, which
// is the thing the allowlist is for.
const otherOrigin = 'https://example.com'
await load(otherOrigin)
const crossOrigin = await cdp.evaluate(`
  fetch('${API}/api/health')
    .then(r => 'ALLOWED ' + r.status)
    .catch(e => 'BLOCKED ' + e.message)`)
check(
  'a non-allowlisted origin is refused by the browser',
  crossOrigin.startsWith('BLOCKED'),
  crossOrigin,
)

// ------------------------------------------- 6. permalink loads directly, no 404

const permalink = `${SITE}/?from=${LAT},${LON}&minutes=30&mode=foot`
const permaStatus = await new Promise((res) => {
  const off = (m, p) => {
    if (m === 'Network.responseReceived' && p.response.url.startsWith(`${SITE}/?`)) res(p.response.status)
  }
  cdp.on(off)
  load(permalink).then(() => setTimeout(() => res(-1), 500))
})
check('a permalink URL loads directly', permaStatus === 200, `HTTP ${permaStatus}`)
const permaRendered = await waitFor(cdp, `!!document.querySelector('.app')`, 20000)
check('the permalink renders the app, not a 404 page', permaRendered, '')

// ------------------------------- 6b. does the saved-route store actually work?

// The consent control in About.jsx promises: "The last set of routes is kept on
// this device, in the browser's cache store. Only the most recent one is kept,
// it is always labelled with its age, and choosing 'No' deletes it immediately."
//
// sw.js:186 returns early for any cross-origin request, and on this deployment
// VITE_API_BASE points the API at another host — so the /api/routes branch at
// sw.js:188 may never run at all. If it does not, that promise is false and the
// control is an affordance that does nothing, which this project treats as a
// bug rather than a rough edge. Either way it should be measured, not assumed.
await load(`${SITE}/`)
await waitFor(cdp, `navigator.serviceWorker.getRegistration().then(r => !!(r && r.active))`, 30000)
// Grant consent exactly the way the page does: the prefs cache is the only
// channel, and the page is its only writer.
await cdp.evaluate(`
  caches.open('meander-prefs')
    .then(c => c.put('/__meander__/save-results', new Response('true')))
    .then(() => 'ok')`)
await cdp.evaluate(
  `(()=>{const b=[...document.querySelectorAll('button')].find(x=>/use my location/i.test(x.textContent)); if(b) b.click()})()`,
)
await waitFor(cdp, `!!document.querySelector('.route__sub')`, 60000)
await sleep(3000)
const saved = await cdp.evaluate(`
  caches.keys().then(async (keys) => {
    const results = keys.filter(k => k.startsWith('meander-results-'))
    let entries = 0
    for (const k of results) entries += (await (await caches.open(k)).keys()).length
    return { results, entries }
  })`)
check(
  'a route is actually saved when the user consents',
  saved.entries > 0,
  saved.entries > 0
    ? `${saved.entries} entry in ${saved.results.join(', ')}`
    : `consent granted, search completed, ${saved.results.length} results cache(s), ` +
      'nothing stored — sw.js never saw the request because it is cross-origin',
)

// --------------------------------------------- 6c. an offline permalink

// SHELL_MATCH is { ignoreVary: true } and not ignoreSearch, so /?from=… may miss
// the precached `/` entry. permalink.js:150 makes that the shape of every shared
// link, so this is the offline case that matters most.
await cdp.send('Network.emulateNetworkConditions', {
  offline: true,
  latency: 0,
  downloadThroughput: -1,
  uploadThroughput: -1,
})
await cdp.send('Page.navigate', { url: `${SITE}/?from=${LAT},${LON}&minutes=30&mode=foot` })
await waitFor(cdp, `document.readyState === 'complete'`, 20000)
await sleep(1200)
const offlinePermalink = await cdp.evaluate(`!!document.querySelector('.app')`)
check('a permalink opens offline, not just the bare root', offlinePermalink, '')
await cdp.send('Network.emulateNetworkConditions', {
  offline: false,
  latency: 0,
  downloadThroughput: -1,
  uploadThroughput: -1,
})

// --------------------------------------------- 7. the service worker registers

await load(`${SITE}/`)
const swReady = await waitFor(
  cdp,
  `navigator.serviceWorker.getRegistration().then(r => !!(r && r.active))`,
  30000,
)
check('the service worker registers and activates', swReady, '')

const cached = await cdp.evaluate(`
  caches.keys().then(async (keys) => {
    const shell = keys.find(k => k.startsWith('meander-shell-'))
    if (!shell) return { keys, count: 0 }
    const c = await caches.open(shell)
    const reqs = await c.keys()
    return { keys, count: reqs.length, urls: reqs.map(r => new URL(r.url).pathname) }
  })`)
check(
  'the shell precache is populated',
  cached.count > 0,
  `${cached.count} entries in ${cached.keys.join(', ')}`,
)
check(
  'no Pages control file was precached',
  !(cached.urls ?? []).some((u) => u === '/_headers' || u === '/_redirects'),
  (cached.urls ?? []).join(' '),
)

// ------------------------------------------------------- 8. the app goes offline

await cdp.send('Network.emulateNetworkConditions', {
  offline: true,
  latency: 0,
  downloadThroughput: -1,
  uploadThroughput: -1,
})
await cdp.send('Page.navigate', { url: `${SITE}/` })
await waitFor(cdp, `document.readyState === 'complete'`, 30000)
await sleep(1200)
const offlineRendered = await cdp.evaluate(
  `!!document.querySelector('.app') && document.body.innerText.length > 40`,
)
check('the app opens with the network off', offlineRendered, '')
await cdp.send('Network.emulateNetworkConditions', {
  offline: false,
  latency: 0,
  downloadThroughput: -1,
  uploadThroughput: -1,
})

// ------------------------------------------------- 9. nothing violated the CSP

collecting = true
await load(`${SITE}/`)
await cdp.evaluate(
  `(()=>{const b=[...document.querySelectorAll('button')].find(x=>/use my location/i.test(x.textContent)); if(b) b.click()})()`,
)
await waitFor(cdp, `!!document.querySelector('.route__sub')`, 60000)
await sleep(2500)
const found = await cdp.evaluate(`window.__cspViolations`)
check(
  'no CSP violation anywhere in a full session',
  found.length === 0,
  found.map((v) => `${v.directive} blocked ${v.blocked}`).join('; '),
)

// The inline theme script is the one the hash exists for. If the hash were
// wrong the app would still work — theme.js re-applies — so this asserts the
// thing that would otherwise be invisible.
const themeApplied = await cdp.evaluate(`document.documentElement.dataset.theme || ''`)
check('the inline theme script ran', themeApplied === 'light' || themeApplied === 'dark', themeApplied)

const webgl = await cdp.evaluate(`(() => {
  try { const c = document.createElement('canvas')
    return !!(c.getContext('webgl2') || c.getContext('webgl')) } catch { return false } })()`)
const mapPainted = await cdp.evaluate(`
  !!document.querySelector('canvas.maplibregl-canvas, .maplibregl-canvas')`)
if (webgl) {
  check('the map canvas exists (tiles were not CSP-blocked)', mapPainted, '')
  const tileRequests = await cdp.evaluate(`
    performance.getEntriesByType('resource')
      .filter(e => e.name.includes('tiles.openfreemap.org')).length`)
  check('tile requests to openfreemap were allowed', tileRequests > 0, `${tileRequests} requests`)
} else {
  // Saying "no WebGL here" is the honest answer. Reporting FAIL would blame the
  // deployment for this machine, and reporting ok would be worse.
  skip('the map canvas exists', 'no WebGL in this browser — the map cannot be graded here')
  skip('tile requests to openfreemap were allowed', 'depends on the map initialising')
}

check(
  'no console errors during the session',
  consoleErrors.length === 0,
  consoleErrors.slice(0, 3).join(' | '),
)

// ------------------------------------------------------------- what it cannot do

skip(
  'the feature list on a real phone',
  'device emulation is not a phone: no real touch, no Safari/WebKit, no install-to-homescreen, no real GPS',
)

// -------------------------------------------------------------------- reporting

function report() {
  console.log('')
  let failed = 0
  for (const [name, ok, detail] of results) {
    const tag = ok === null ? 'SKIP' : ok ? 'ok  ' : 'FAIL'
    if (ok === false) failed += 1
    console.log(`  ${tag}  ${name}${detail ? `   [${detail}]` : ''}`)
  }
  console.log(`\n  ${results.filter((r) => r[1] === true).length} passed, ${failed} failed, ${results.filter((r) => r[1] === null).length} not checkable here`)
  return failed
}

const failed = report()
cdp.close()
proc.kill()
process.exit(failed ? 1 : 0)
