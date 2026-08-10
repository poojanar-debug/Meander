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
let lastRouteBody = null
let lastRouteStatus = null
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
    // Kept so §6b can prove its two searches are actually two searches. The
    // store is keyed on this body, so two links that decode to the same body
    // would make "only the most recent one is kept" true by never having had a
    // second one — which is precisely how the first version of that check
    // passed.
    lastRouteBody = params.request.postData ?? null
  }
  if (method === 'Network.responseReceived' && params.requestId === routeRequestId) {
    responseAt = params.timestamp
    lastRouteStatus = params.response.status
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
  const bytes = chunks.reduce((a, c) => a + c.n, 0)
  if (routeWasCached) {
    // Both checks, not just the timing one. A warm replay is written to the
    // socket as fast as it can be serialised, and 51 kB of it can land in a
    // *single* Network.dataReceived — so the chunk count is exactly as
    // uninformative as the spread, and grading it fails a healthy deployment
    // for having answered too quickly. Measured here: 1 chunk, 51,517 bytes,
    // on a deployment whose streaming was fine.
    skip(
      'SSE arrived in more than one chunk',
      `the server replayed a cached route (${chunks.length} chunk(s), ${bytes} bytes) — ` +
        'chunk count cannot distinguish a fast replay from buffering.',
    )
    skip(
      'the chunks are spread over time, not one blob at the end',
      `the server replayed a cached route (${chunks.length} chunks in ${spread.toFixed(2)}s) — ` +
        'too fast to distinguish from buffering. Re-run against an uncached origin to grade this.',
    )
  } else {
    check('SSE arrived in more than one chunk', chunks.length > 1, `${chunks.length} chunks, ${bytes} bytes`)
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

// The consent control promises three separate things: "Only the most recent one
// is kept, it is always labelled with its age, and choosing 'No' deletes it
// immediately." Each gets its own check below, and each is driven through the
// control a person would actually press rather than by writing the prefs cache
// directly — because the bug this replaced was a control that *looked* like it
// worked. Consent granted, tick shown, nothing stored: sw.js declines every
// cross-origin request and this deployment puts the API on another origin, so
// the worker's route branch never ran. BLOCKED.md §8 has the measurement.
//
// One "something was saved" check would have passed on the day that shipped —
// it did not, only because the store wrote nothing at all. It would also pass
// for two saved sets, and for a set that is never labelled with anything. Three
// promises, three checks.

// Two permalinks rather than two clicks of "use my location": the request body
// is then deterministic and reproducible across a reload, which is what makes
// the offline replay below testable at all.
// `min`, not `minutes`: permalink.js:80 writes `min`, and an unrecognised key
// is ignored rather than rejected — so `minutes=45` decoded to the default and
// P1 and P2 were the same search. The check below proves they differ now.
const P1 = `${SITE}/?from=${LAT},${LON}&min=30&mode=foot`
const P2 = `${SITE}/?from=${LAT},${LON}&min=45&mode=foot`

/** Every saved entry, across every results bucket, with its age stamp. */
const savedState = () =>
  cdp.evaluate(`
    caches.keys().then(async (names) => {
      const buckets = names.filter((n) => n.startsWith('meander-results-'))
      const entries = []
      for (const b of buckets) {
        const c = await caches.open(b)
        for (const req of await c.keys()) {
          const hit = await c.match(req)
          entries.push({
            bucket: b,
            key: new URL(req.url).pathname,
            cachedAt: hit ? hit.headers.get('X-Meander-Cached') : null,
          })
        }
      }
      return { buckets, entries }
    })`)

/** Wipe saved routes and the recorded answer, leaving the shell in place. */
const resetStore = () =>
  cdp.evaluate(`
    caches.keys()
      .then((names) => Promise.all(
        names.filter((n) => n.startsWith('meander-results-')).map((n) => caches.delete(n))))
      .then(() => caches.open('meander-prefs'))
      .then((c) => c.delete('/__meander__/save-results'))
      .then(() => 'ok')`)

/**
 * Press one of the two real consent chips, found through its own legend.
 *
 * Returns what happened rather than a bare boolean, so a chip that was never
 * there reads as 'no-button' in the gate output instead of silently grading as
 * "the user did not consent". `.chips` alone would also match the units and
 * objective fieldsets, which is how a selector starts matching the wrong thing.
 */
const pressConsent = (label) =>
  cdp.evaluate(`
    (() => {
      const fs = [...document.querySelectorAll('fieldset')].find((f) =>
        /keep the last routes/i.test((f.querySelector('legend') || {}).textContent || ''))
      if (!fs) return 'no-fieldset'
      const b = [...fs.querySelectorAll('button')].find((x) =>
        x.textContent.replace(/\\s+/g, ' ').trim().startsWith(${JSON.stringify(label)}))
      if (!b) return 'no-button'
      b.click()
      return 'clicked'
    })()`)

const routesOnScreen = (ms = 60000) =>
  waitFor(cdp, `document.querySelectorAll('.route__sub').length > 0`, ms)

/** Load a search link, let it settle, and report what the API actually said. */
const searchAndSettle = async (url, settleMs = 3000) => {
  lastRouteStatus = null
  lastRouteBody = null
  await load(url)
  const rendered = await routesOnScreen()
  await sleep(settleMs)
  return { rendered, status: lastRouteStatus, body: lastRouteBody }
}

/**
 * Grade a check, unless the search it depends on was rate-limited.
 *
 * `per_ip_refill_per_min` is 1.0 against a bucket of 12, and this section
 * spends three tokens. Two runs inside a few minutes exhaust it, and a 429
 * makes every store assertion below report "nothing stored" — which reads as
 * the exact bug this section was written to catch. A gate that says "broken"
 * when it means "you ran me twice" is as useless as one that cannot fail.
 */
const gradeOrSkip = (name, runs, ok, detail) => {
  if (runs.some((r) => r.status === 429)) {
    skip(name, 'the deployment rate-limited this search (HTTP 429) — not graded. Re-run in a few minutes.')
    return false
  }
  return check(name, ok, detail)
}

await load(`${SITE}/`)
await waitFor(cdp, `navigator.serviceWorker.getRegistration().then(r => !!(r && r.active))`, 30000)
await resetStore()

// ⚠ The control is not on the first-run screen. App.jsx:460 replaces the whole
// panel with <FirstRun> while there is no origin and no routes, and About — and
// therefore the consent chips — live at the foot of that panel. A search has to
// have happened before the chips are in the DOM at all.
//
// This cost the first version of these checks: pressing a chip on the bare site
// returned 'no-fieldset', and because a failed press leaves consent ungranted,
// "nothing is saved without consent" passed — for the wrong reason, with the
// control never found. Every check below that depends on a press now states
// that dependency, so a control that has moved fails the check instead of
// quietly satisfying it.

// --- nothing is stored before the user has been asked -----------------------

// resetStore() removed the recorded answer, so this search runs in the state a
// first-time visitor is in. It also puts the panel — and About — on screen.
const unasked = await searchAndSettle(P1)
check('a search renders before the consent control is looked for', unasked.rendered, `HTTP ${unasked.status}`)

const withoutConsent = await savedState()
gradeOrSkip(
  'nothing is saved before the user has been asked',
  [unasked],
  withoutConsent.entries.length === 0,
  `${withoutConsent.entries.length} entr${withoutConsent.entries.length === 1 ? 'y' : 'ies'} in ` +
    `${withoutConsent.buckets.length} bucket(s)`,
)

// --- a route is saved when the user consents --------------------------------

const pressedYes = await pressConsent('Yes, keep them')
check('the consent control is on the page and records a yes', pressedYes === 'clicked', pressedYes)

const consented = await searchAndSettle(P1)
const bodyP1 = consented.body
const afterFirst = await savedState()
gradeOrSkip(
  'a route is actually saved when the user consents',
  [consented],
  pressedYes === 'clicked' && afterFirst.entries.length === 1,
  pressedYes !== 'clicked'
    ? `not graded: the "Yes" chip was ${pressedYes}, so nothing was ever consented to`
    : afterFirst.entries.length
      ? `${afterFirst.entries.length} entry at ${afterFirst.entries[0].key} in ${afterFirst.entries[0].bucket}`
      : `consent granted, search completed, ${afterFirst.buckets.length} results bucket(s), nothing stored`,
)

// --- only the most recent set is kept ---------------------------------------

const second = await searchAndSettle(P2)
const bodyP2 = second.body
const afterSecond = await savedState()

// Before grading "only the most recent", prove there were two. The store keys
// on the request body, so if these two links decode to the same body then a
// single stored entry means nothing was ever replaced. That is not theoretical:
// the first version used `minutes=30` and `minutes=45`, permalink.js:80 writes
// `min`, an unrecognised key is ignored rather than rejected, and both links
// decoded to the same default. One entry, two "searches", nothing proved.
const twoSearches = !!bodyP1 && !!bodyP2 && bodyP1 !== bodyP2
gradeOrSkip(
  'the two searches are actually different requests',
  [consented, second],
  twoSearches,
  twoSearches ? `${bodyP1.length}B vs ${bodyP2.length}B, differing` : `identical bodies: ${bodyP1 ?? 'none'}`,
)

gradeOrSkip(
  'only the most recent set is kept, after a second search',
  [consented, second],
  twoSearches && afterSecond.entries.length === 1 && afterSecond.buckets.length === 1,
  !twoSearches
    ? 'not graded: the two searches sent the same body'
    : `${afterSecond.entries.length} entr${afterSecond.entries.length === 1 ? 'y' : 'ies'} across ` +
      `${afterSecond.buckets.length} bucket(s): ${afterSecond.buckets.join(', ')}`,
)

// --- it is labelled with its age --------------------------------------------

const stamp = afterSecond.entries[0]?.cachedAt
const stampAge = stamp ? Date.now() - new Date(stamp).valueOf() : null
gradeOrSkip(
  'the saved set is stamped with the time it was written',
  [consented, second],
  stampAge !== null && Number.isFinite(stampAge) && stampAge >= 0 && stampAge < 15 * 60_000,
  stamp ? `X-Meander-Cached ${stamp} (${Math.round((stampAge ?? 0) / 1000)}s ago)` : 'no stamp',
)

// --- the reload with no network, which is what the feature is for -----------

await cdp.send('Network.emulateNetworkConditions', {
  offline: true,
  latency: 0,
  downloadThroughput: -1,
  uploadThroughput: -1,
})
await cdp.send('Page.navigate', { url: P2 })
await waitFor(cdp, `document.readyState === 'complete'`, 20000)
const replayed = await routesOnScreen(30000)
gradeOrSkip('the saved set comes back on a reload with no network', [consented, second], replayed, '')

// The age has to be on the screen, not only in a header. Two renderers claim to
// show it — the pill under the top bar and the badge on the row — and the label
// has to carry an actual age rather than an empty element.
const label = await cdp.evaluate(`
  (() => {
    const bar = document.querySelector('.offline')
    const badge = document.querySelector('.badge--cached')
    return {
      bar: bar ? bar.textContent.replace(/\\s+/g, ' ').trim() : null,
      badge: badge ? badge.textContent.replace(/\\s+/g, ' ').trim() : null,
    }
  })()`)
gradeOrSkip(
  'the replayed set is labelled as saved, with its age, on screen',
  [consented, second],
  !!(label.bar && label.badge && /\d|just now|moment/i.test(`${label.bar} ${label.badge}`)),
  `pill: ${label.bar ?? 'absent'} · badge: ${label.badge ?? 'absent'}`,
)

// The older search must be gone rather than merely not shown. Still offline, so
// this costs no rate-limit token. Graded only if something was stored at all —
// "nothing replayed" out of an empty store is not evidence of anything, and is
// exactly how the previous version of this section passed while broken.
await cdp.send('Page.navigate', { url: P1 })
await waitFor(cdp, `document.readyState === 'complete'`, 20000)
const olderCameBack = await routesOnScreen(12000)
gradeOrSkip(
  'the search before it is gone, not merely hidden',
  [consented, second],
  twoSearches && afterSecond.entries.length === 1 && !olderCameBack,
  !twoSearches || afterSecond.entries.length !== 1
    ? `not graded: ${afterSecond.entries.length} entries stored from ` +
      `${twoSearches ? 'two' : 'one'} distinct search(es), so a miss proves nothing`
    : olderCameBack
      ? 'the previous search still replays — two sets are reachable'
      : 'no replay, as promised',
)

// --- choosing "No" deletes it immediately -----------------------------------

// Still offline, deliberately: deletion is local, and doing it here needs no
// further route request. Back on P2 so the panel — and therefore About — is on
// screen. No reload between the press and the count: "immediately" is the claim.
await cdp.send('Page.navigate', { url: P2 })
await waitFor(cdp, `document.readyState === 'complete'`, 20000)
await routesOnScreen(30000)
const beforeRevoke = await savedState()
const revoked = await pressConsent('No')
await sleep(1500)
const afterRevoke = await savedState()
gradeOrSkip(
  'choosing “No” deletes the saved set immediately, without a reload',
  [consented, second],
  revoked === 'clicked' && beforeRevoke.entries.length === 1 && afterRevoke.entries.length === 0,
  revoked !== 'clicked'
    ? `not graded: the "No" chip was ${revoked}`
    : `${beforeRevoke.entries.length} entry before, ${afterRevoke.entries.length} after, ` +
      `${afterRevoke.buckets.length} bucket(s) left`,
)

await cdp.send('Network.emulateNetworkConditions', {
  offline: false,
  latency: 0,
  downloadThroughput: -1,
  uploadThroughput: -1,
})

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
