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
      // A fresh profile per run, not a fixed path.
      //
      // ⚠ This gate registers a service worker and then grades what the browser
      // is served, and `sw.js` serves the shell **cache-first without
      // revalidating** — so a fixed profile means a run can grade whatever build
      // it last saw. Observed on the deploy this line was added in: the first
      // run after a Cloudflare Pages build reported `.panel__scroll` matching
      // zero elements while the class was present in the served bundle and in
      // the DOM a minute later. `gate.mjs` had the identical trap and clears
      // workers and caches instead; this one cannot, because registering and
      // precaching that worker is a thing it is here to check.
      `--user-data-dir=/tmp/meander-live-gate-${port}-${Date.now()}`,
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
  ['.sheet', 'Sheet.jsx — the mobile bottom sheet (this gate runs at 390px)'],
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

// The 2026 plan surface: the location arrow carries an aria-label rather than
// text, and nothing fetches until Find routes is pressed — the nonce is only
// bumped by the two buttons that actually ask.
await cdp.evaluate(
  `(()=>{document.querySelector('[aria-label="Use my location"]')?.click()})()`,
)
await waitFor(
  cdp,
  `!![...document.querySelectorAll('button')].find(x=>/find routes/i.test(x.textContent||'')&&!x.disabled)`,
  20000,
)
await cdp.evaluate(
  `(()=>{const b=[...document.querySelectorAll('button')].find(x=>/find routes/i.test(x.textContent||'')&&!x.disabled);if(b)b.click()})()`,
)
const gotRoutes = await waitFor(cdp, `!!document.querySelector('.route__sub')`, 60000)
check('routes arrive in the browser from the Pages origin', gotRoutes, gotRoutes ? '' : 'timed out')

const routeCount = await cdp.evaluate(`document.querySelectorAll('button.route').length`)
check('three routes rendered', routeCount === 3, `${routeCount} rendered`)

// ---------------------------- 3b. the sheet's scroll arrangement, deployed
//
// The redesign's mobile layout is a full-viewport map with a bottom sheet that
// scrolls internally — the page itself never scrolls. A stale CSS asset or a
// half-deployed build shows up as exactly this shape breaking, and nothing
// else would notice: the offline gate covers the built output, this covers
// what is actually served.
const structure = await cdp.evaluate(`(() => {
  const sheet = document.querySelector('.sheet')
  if (!sheet) return { present: false }
  const cs = getComputedStyle(sheet)
  const r = sheet.getBoundingClientRect()
  return {
    present: true,
    overflowY: cs.overflowY,
    inViewport: r.bottom <= innerHeight + 1,
    appOverflow: getComputedStyle(document.querySelector('.app')).overflow,
  } })()`)
check('the sheet is served', structure.present, structure.present ? '' : '.sheet matched nothing')
if (structure.present) {
  check('the deployed sheet scrolls internally', structure.overflowY === 'auto', structure.overflowY)
  check('the deployed sheet stays inside the viewport', structure.inViewport)
  check('the deployed app layer does not scroll', structure.appOverflow === 'hidden', structure.appOverflow)
}

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
  } else if (chunks.length === 1 && ttfb < 0.25) {
    // **The same reasoning as the cached branch, keyed on the condition rather
    // than on one of its causes.** That branch says chunk count "cannot
    // distinguish a fast replay from buffering", and it is right — but a cache
    // hit is not the only way to answer fast. A cold, uncached request against
    // a warm self-hosted graph does it too: measured here at 74,727 bytes in a
    // single `Network.dataReceived`, on a deployment whose streaming was
    // demonstrably fine.
    //
    // Demonstrably, because it was checked another way rather than assumed.
    // `curl -sN --no-buffer` against the same public origin, with the route
    // cache emptied first, received **eight frames over 0.58 s** — three
    // progress events, two routes, then the enriched pass — so the server and
    // Caddy both stream. Chrome coalesced them because they all arrived inside
    // one paint.
    //
    // Grading it anyway fails a healthy deployment for having got faster, which
    // is how a gate teaches people to ignore it. The first-byte time is the
    // part that stays meaningful: a buffered response cannot deliver its first
    // byte before the work is done.
    skip(
      'SSE arrived in more than one chunk',
      `the whole answer arrived ${ttfb.toFixed(2)}s after the headers ` +
        `(${chunks.length} chunk, ${bytes} bytes) — too fast for chunk count to ` +
        'distinguish streaming from buffering. See the note in this file.',
    )
    skip(
      'the chunks are spread over time, not one blob at the end',
      `first byte ${ttfb.toFixed(2)}s after the headers, which a buffered ` +
        'response could not manage: it must finish the work first.',
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

// A permalink rather than a click of "use my location": the request body is
// then deterministic and reproducible across a reload. `min`, not `minutes`:
// permalink.js writes `min`, and an unrecognised key is ignored rather than
// rejected, which once made two "different" searches the same one.
const P1 = `${SITE}/?from=${LAT},${LON}&min=30&mode=foot`

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

// --- the consent flow has no control in the 2026 design ---------------------
//
// The redesign ships no settings surface, so the "keep the last routes" chips
// are not in the DOM anywhere and consent can never be granted from the
// screen. The store, its grid-keyed fingerprint and its unit tests all remain
// below the presentation layer — client.js still replays a saved set when the
// network fails — but with nothing able to write one, every promise past
// "nothing is stored unasked" is ungradable against a deployment. Skipped by
// name rather than deleted, so the day a consent control returns these say so
// instead of silently not existing. pressConsent above is kept for that day.
void pressConsent
for (const name of [
  'a route is actually saved when the user consents',
  'the two searches are actually different requests',
  'only the most recent set is kept, after a second search',
  'the saved set is stamped with the time it was written',
  'the saved set comes back on a reload with no network',
  'the replayed set is labelled as saved, with its age, on screen',
  'the search before it is gone, not merely hidden',
  'choosing \u201cNo\u201d deletes the saved set immediately, without a reload',
]) {
  skip(name, 'no consent control exists in the 2026 design, so nothing can be stored to grade')
}

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

// ------------------------------- 6d. the search that starts from the device

/**
 * The two things a geolocated search does that a permalink search cannot, and
 * that nothing above this line touches.
 *
 * Everything graded before now starts from a link — `?from=…` — which is a
 * coordinate that is byte-identical on every reload. That is the easy case, and
 * it is the only case the gate had. A device fix is the hard one: it is a fresh
 * measurement every time, so the two behaviours below are the ones that were
 * broken, and they were broken in production while every check above was green.
 *
 * Only one online search is spent here. The replay checks run offline, where a
 * request costs no rate-limit token because it never reaches the deployment.
 */
/**
 * Put a chosen fix behind `navigator.geolocation`, for the next document.
 *
 * ⚠ Not `Emulation.setGeolocationOverride`, and the reason is a defect this
 * section had on its first run. **This gate already replaces
 * `navigator.geolocation` wholesale**, in the boot script at the top of the
 * file, with a stub hard-coded to LAT/LON. Nothing the CDP override says can
 * reach a page whose geolocation object was redefined before any of its code
 * ran — so the first version of this section moved the override to 200 m, the
 * app kept answering from the original coordinate, and the gate reported
 * "a fix two hundred metres away does not replay it — FAILED · the match is too
 * wide". The store was correct; the gate was grading its own stub.
 *
 * That is worth spelling out because it is the exact failure mode this file was
 * written to catch, arriving from the inside: a check that appears to measure
 * the deployment and actually measures the harness. It failed loudly rather than
 * passing, which is the only reason it was caught.
 *
 * So the fix is supplied by replacing that stub — added later, and later wins,
 * because scripts run in the order they were registered — and the coordinate the
 * page will actually report is read back and asserted before anything is graded.
 * `movedBy` is not decoration; without it a stub that failed to install would
 * make the 200 m check pass for the best-looking wrong reason.
 */
let geoScriptId = null
const geo = async (lat, lon) => {
  if (geoScriptId) {
    await cdp
      .send('Page.removeScriptToEvaluateOnNewDocument', { identifier: geoScriptId })
      .catch(() => {})
    geoScriptId = null
  }
  const source = `
    (() => {
      const pos = {
        coords: { latitude: ${lat}, longitude: ${lon}, accuracy: 8,
                  altitude: null, altitudeAccuracy: null, heading: null, speed: null },
        timestamp: Date.now(),
      }
      const geolocation = {
        getCurrentPosition: (ok) => setTimeout(() => ok(pos), 0),
        watchPosition: (ok) => { setTimeout(() => ok(pos), 0); return 1 },
        clearWatch: () => {},
      }
      try {
        Object.defineProperty(navigator, 'geolocation', {
          value: geolocation, configurable: true,
        })
      } catch (e) {
        window.__meanderGeoStubFailed = String(e)
      }
    })()`
  const { identifier } = await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source })
  geoScriptId = identifier
}

/** What the page would actually report, so a dead stub cannot pass as a miss. */
const fixOnPage = () =>
  cdp.evaluate(`
    new Promise((res) => {
      if (!navigator.geolocation) return res(null)
      navigator.geolocation.getCurrentPosition(
        (p) => res({ lat: p.coords.latitude, lon: p.coords.longitude }),
        () => res(null),
        { maximumAge: 0, timeout: 5000 },
      )
    })`)

const metresApart = (a, b) =>
  Math.hypot(
    (b.lat - a.lat) * 111320,
    (b.lon - a.lon) * 111320 * Math.cos((a.lat * Math.PI) / 180),
  )

/** Press whichever "Use my location" button the current layout is showing. */
const pressLocate = () =>
  cdp.evaluate(`
    (() => {
      const find = () =>
        document.querySelector('[aria-label="Use my location"]') ||
        [...document.querySelectorAll('button')].find((b) =>
          /use my location/i.test(b.textContent || ''))
      let b = find()
      if (!b) {
        // On the desktop capsule it lives inside the origin popover. Opening
        // it is a click on the origin segment; a closed popover still renders
        // the segment.
        document.querySelector('.capsule__seg--origin')?.click()
        b = find()
      }
      if (!b) return 'no-button'
      if (b.disabled) return 'disabled'
      b.click()
      return 'clicked'
    })()`)

/** Press the primary action. In this design nothing fetches until it is
 *  pressed — the nonce is bumped only by Find routes, Try again, and an
 *  arriving permalink. */
const pressFind = () =>
  cdp.evaluate(`
    (() => {
      const b = [...document.querySelectorAll('button')].find(
        (x) => /find routes/i.test(x.textContent || '') && !x.disabled)
      if (!b) return 'no-button'
      b.click()
      return 'clicked'
    })()`)

const searchNow = () => cdp.evaluate(`location.search`)

// No Browser.grantPermissions: the page never reaches the real geolocation
// API, so there is no permission to grant.

// (i) BLOCKED.md §9 — the address bar must not keep the search before it.
// Done offline and on P1, so it costs nothing: the URL is what is under test,
// not the routes.
await cdp.send('Network.emulateNetworkConditions', {
  offline: true,
  latency: 0,
  downloadThroughput: -1,
  uploadThroughput: -1,
})
await geo(LAT, LON)
// Installed before the navigate: addScriptToEvaluateOnNewDocument applies to
// the next document, not the current one.
await cdp.send('Page.navigate', { url: P1 })
await waitFor(cdp, `document.readyState === 'complete'`, 20000)
await sleep(1500)
const barBefore = await searchNow()
const locatedFromLink = await pressLocate()
await sleep(2000)
const barAfter = await searchNow()

check(
  'a geolocated search clears the search before it out of the address bar',
  locatedFromLink === 'clicked' && barBefore.includes('from=') && barAfter === '',
  locatedFromLink !== 'clicked'
    ? `not graded: the locate button was ${locatedFromLink}`
    : `"${barBefore}" → "${barAfter || '(empty)'}"`,
)

// And the consequence that actually hurt: a reload must not boot the abandoned
// search. Still offline, so a request would fail loudly rather than silently.
await cdp.send('Page.navigate', { url: `${SITE}${barAfter}` })
await waitFor(cdp, `document.readyState === 'complete'`, 20000)
await sleep(2000)
const bootedSomething = await cdp.evaluate(
  `document.querySelectorAll('.route__sub').length > 0`,
)
check(
  'a reload after a geolocated search does not boot the abandoned one',
  locatedFromLink === 'clicked' && barAfter === '' && !bootedSomething,
  locatedFromLink !== 'clicked'
    ? `not graded: the locate button was ${locatedFromLink}`
    : bootedSomething
      ? 'routes rendered from a URL that should hold no search'
      : 'nothing was asked for, as promised',
)

await cdp.send('Network.emulateNetworkConditions', {
  offline: false,
  latency: 0,
  downloadThroughput: -1,
  uploadThroughput: -1,
})

// (ii) The rounded key: saving a geolocated search and replaying it from a
// fix a few metres away needs a stored set, which needs consent — see the 6b
// note. Ungradable until a consent control exists again.
for (const name of [
  'a geolocated search is saved under the rounded key',
  'a fix five metres from the saved one replays it, with no network',
  'a fix two hundred metres away does not replay it',
]) {
  skip(name, 'no consent control exists in the 2026 design, so nothing can be stored to grade')
}

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
  `(()=>{document.querySelector('[aria-label="Use my location"]')?.click()})()`,
)
await waitFor(
  cdp,
  `!![...document.querySelectorAll('button')].find(x=>/find routes/i.test(x.textContent||'')&&!x.disabled)`,
  20000,
)
await pressFind()
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
