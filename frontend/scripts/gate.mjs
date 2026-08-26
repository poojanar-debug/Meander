import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'

/**
 * Layout and accessibility gate, in a real headless Chrome.
 *
 * **Rewritten with the 2026 redesign, not ported** — the same decision the
 * previous version records in its own header, taken for the same reason. The
 * selectors this gate depends on are the redesign's: the full-viewport map,
 * the plan capsule and its popovers at 1024 and up, the bottom sheet below
 * it, the result cards, the centered detail modal, and follow mode's banner
 * and dock. A gate that selects on a layout the app no longer has cannot
 * fail, and a gate that cannot fail is worse than no gate, because it reads
 * as coverage.
 *
 * So the first thing this gate does is prove its own selectors match
 * something. The manifests below are checked before any assertion that
 * depends on them, and a selector matching zero elements is a FAILURE, not a
 * silent skip.
 *
 * What it drives, per viewport: the plan surface → Use my location → Find
 * routes → the streamed cards → the route detail → (on a phone) follow mode.
 * At each stop: every interactive target clears 44x44 in both themes, axe
 * reports no wcag2a/2aa violations in both themes, nothing scrolls
 * horizontally at 320 or 390, and there is exactly one polite live region.
 *
 * Usage:  node scripts/gate.mjs [url]        (default http://localhost:4173)
 */

const URL_ = process.argv[2] ?? 'http://localhost:4173/'
const CHROME =
  process.env.CHROME_PATH ??
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'

// Every selector the PLAN state depends on, and what renders it. The results
// and follow manifests are separate because their subjects render later — the
// rule that a zero-match is a failure would otherwise fail every fresh load.
const PLAN_MANIFEST = [
  ['.app', 'App.jsx — the layout root'],
  ['.stage', 'App.jsx — the map layer'],
  ['.map', 'MapView.jsx'],
  ['.sheet', 'Sheet.jsx — the mobile bottom sheet'],
  ['.plan', 'PlanSheet.jsx'],
  ['.plan__search-field', 'PlanSheet.jsx — the doorway to place search'],
  ['.plan__search--dest', 'PlanSheet.jsx — the destination field'],
  ['[aria-label="Use my location"]', 'PlanSheet.jsx — the location arrow'],
  ['.dial__slider', 'TimeDial.jsx — the native range input'],
  ['.mode__seg', 'ModeControl.jsx'],
  ['.chip', 'ObjectiveChips.jsx'],
  ['[role="status"][aria-live="polite"]', 'App.jsx — the one live region'],
]

const DEST_MANIFEST = [
  ['.plan__search-clear', 'PlanSheet.jsx — clearing the destination'],
  ['.plan__budget-note', 'PlanSheet.jsx — what stands where the dial stood'],
]

const RESULTS_MANIFEST = [
  ['button.route', 'RouteRow.jsx — a real card hit area, not a skeleton'],
  ['.route__sub', 'RouteRow.jsx — the meta line'],
  ['.card', 'RouteRow.jsx'],
  ['.rail', 'RouteRail.jsx'],
]

const GEO = `Object.defineProperty(navigator,'geolocation',{configurable:true,value:{
  getCurrentPosition:(ok)=>setTimeout(()=>ok({coords:{latitude:51.5074,longitude:-0.1278,accuracy:20},timestamp:Date.now()}),10),
  watchPosition:(ok)=>{setTimeout(()=>ok({coords:{latitude:51.5074,longitude:-0.1278,accuracy:20},timestamp:Date.now()}),10);return 1},
  clearWatch:()=>{}}})`

const results = []
const check = (name, ok, detail) => {
  results.push([name, ok, detail])
  return ok
}

// ------------------------------------------------------------------ CDP glue

async function launch(port = 9444) {
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
      '--user-data-dir=/tmp/meander-gate-profile',
      '--hide-scrollbars',
      'about:blank',
    ],
    { stdio: 'ignore' },
  )
  for (let i = 0; i < 100; i += 1) {
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
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data)
    if (msg.id && pending.has(msg.id)) {
      const { res, rej } = pending.get(msg.id)
      pending.delete(msg.id)
      msg.error ? rej(new Error(JSON.stringify(msg.error))) : res(msg.result)
    }
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
  return { send, evaluate, close: () => ws.close() }
}

// -------------------------------------------------------------------- checks

const { proc, port } = await launch()
const cdp = await connect(port)
await cdp.send('Page.enable')
await cdp.send('Runtime.enable')
await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: GEO })

async function waitFor(expression, tries = 120, gapMs = 250) {
  for (let i = 0; i < tries; i += 1) {
    if (await cdp.evaluate(expression).catch(() => false)) return true
    await new Promise((r) => setTimeout(r, gapMs))
  }
  return false
}

/** Fresh page at a viewport, sitting on the plan surface. */
async function load(width, height, mobile) {
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width,
    height,
    deviceScaleFactor: mobile ? 2 : 1,
    mobile,
  })
  await cdp.send('Page.navigate', { url: URL_ })
  await waitFor(`document.readyState === 'complete'`, 120, 100)
  await new Promise((r) => setTimeout(r, 500))
}

/** Plan → origin → Find routes → streamed cards. The capsule keeps its
 *  locate control behind the origin popover, so the desktop path opens it. */
async function driveToResults(mobile) {
  if (!mobile) {
    await cdp.evaluate(
      `(()=>{document.querySelector('.capsule__seg--origin')?.click()})()`,
    )
    await new Promise((r) => setTimeout(r, 300))
    await cdp.evaluate(
      `(()=>{const b=[...document.querySelectorAll('button')].find(x=>/use my location/i.test(x.textContent||''));if(b)b.click()})()`,
    )
  } else {
    await cdp.evaluate(
      `(()=>{document.querySelector('[aria-label="Use my location"]')?.click()})()`,
    )
  }
  // The origin lands asynchronously; Find routes is disabled until it does.
  await waitFor(
    `!![...document.querySelectorAll('button')].find(x=>/find routes/i.test(x.textContent||'')&&!x.disabled)`,
    60,
  )
  await cdp.evaluate(
    `(()=>{const b=[...document.querySelectorAll('button')].find(x=>/find routes/i.test(x.textContent||'')&&!x.disabled);if(b)b.click()})()`,
  )
  // Wait for the full streamed set, not the first frame: grading one card of
  // three would call two-thirds of the answer covered when it was absent.
  const first = await waitFor(`!!document.querySelector('.route__sub')`)
  if (!first) return false
  await waitFor(`document.querySelectorAll('button.route').length >= 3`, 60)
  return true
}

/**
 * Block until the bottom sheet has stopped moving.
 *
 * Not a nicety. Picking a place unmounts the search screen and remounts the
 * sheet, whose height is an inline style with a transition on it, and a sweep
 * that lands mid-transition measures the sticky grabber at 43.999996 px
 * against a 44 px minimum. That is not a target-size defect — the resting
 * height is exactly 44 in every state — but it fails the sweep about half the
 * time, and a gate that fails at random teaches people to re-run it until it
 * is green, which is the same as not having it.
 *
 * Two equal readings rather than a fixed sleep, so it is the sheet that says
 * when it is done.
 */
async function sheetSettled() {
  let last = null
  for (let i = 0; i < 25; i += 1) {
    const h = await cdp.evaluate(
      `(() => { const el = document.querySelector('.sheet'); return el ? el.getBoundingClientRect().height : -1 })()`,
    )
    if (last !== null && h === last) return true
    last = h
    await new Promise((r) => setTimeout(r, 100))
  }
  return false
}

/**
 * Pick a destination on the phone plan sheet, through the screen a user goes
 * through: the field opens the full-surface place search, a name is typed into
 * the real combobox, and the first result is chosen.
 *
 * `input.value = x` is deliberately not what happens here. React installs its
 * own value setter on the element, so assigning through the instance property
 * updates the DOM and never tells React, and the combobox would search for an
 * empty string. The prototype setter plus a bubbling `input` event is the one
 * way to type into a React-controlled field from outside React.
 *
 * The result rows commit on `mousedown`, not `click` — the input's blur would
 * close the list before a click ever landed — so that is what is dispatched.
 */
async function pickDestination(query = 'Vondelpark') {
  await cdp.evaluate(
    `(()=>{document.querySelector('.plan__search--dest .plan__search-field')?.click()})()`,
  )
  if (!(await waitFor(`!!document.querySelector('.search .place__input')`, 40, 100))) return false
  await cdp.evaluate(`(() => {
    const input = document.querySelector('.search .place__input')
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
    setter.call(input, ${JSON.stringify(query)})
    input.dispatchEvent(new Event('input', { bubbles: true }))
    return true })()`)
  // 500 ms debounce, then the mock geocoder's own 220 ms.
  if (!(await waitFor(`!!document.querySelector('.place__row')`, 40, 100))) return false
  await cdp.evaluate(`(() => {
    const row = document.querySelector('.place__row')
    row.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }))
    return true })()`)
  if (!(await waitFor(`!!document.querySelector('.plan__search-clear')`, 40, 100))) return false
  return sheetSettled()
}

async function setTheme(theme) {
  await cdp.evaluate(`document.documentElement.dataset.theme = '${theme}'`)
  await new Promise((r) => setTimeout(r, 200))
}

async function countSelectors(manifest) {
  return cdp.evaluate(
    `(${JSON.stringify(manifest.map((m) => m[0]))}).map(s => document.querySelectorAll(s).length)`,
  )
}

function checkManifest(label, manifest, counts) {
  let ok = true
  manifest.forEach(([selector, owner], i) => {
    if (!check(`[${label}] ${selector} matches something (${owner})`, counts[i] > 0, `${counts[i]} found`)) {
      ok = false
    }
  })
  return ok
}

// Clear any service worker and cache left by a previous run, before grading
// anything. `--user-data-dir` above is a fixed path, so the profile survives
// between runs, and sw.js serves the shell cache-first without revalidating —
// an uncleared profile grades whatever build was current last time.
await cdp.send('Page.navigate', { url: URL_ })
await new Promise((r) => setTimeout(r, 600))
await cdp.evaluate(`(async () => {
  const regs = (await navigator.serviceWorker?.getRegistrations?.()) ?? []
  await Promise.all(regs.map(r => r.unregister()))
  const keys = (await caches?.keys?.()) ?? []
  await Promise.all(keys.map(k => caches.delete(k)))
  return regs.length })()`).catch(() => null)

// 1. THE PLAN MANIFEST — before anything that depends on it.
await load(390, 844, true)
const planCounts = await countSelectors(PLAN_MANIFEST)
if (!checkManifest('plan', PLAN_MANIFEST, planCounts)) {
  console.log('\nThe plan manifest failed. Every check below would be grading nothing,')
  console.log('so they are not run.\n')
  for (const [name, ok, detail] of results) {
    console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${name}${detail ? `   [${detail}]` : ''}`)
  }
  cdp.close()
  proc.kill()
  process.exit(1)
}

// 2. No horizontal scroll at the narrowest supported widths, on the plan.
const overflowCheck = `(() => {
  const doc = document.documentElement
  const wide = [...document.querySelectorAll('*')]
    .filter(el => el.getBoundingClientRect().right > doc.clientWidth + 1)
    .slice(0, 5)
    .map(el => el.className?.baseVal ?? el.className ?? el.tagName)
  return { scrollW: doc.scrollWidth, clientW: doc.clientWidth, wide } })()`

for (const width of [320, 390]) {
  await load(width, 844, true)
  const overflow = await cdp.evaluate(overflowCheck)
  check(
    `[plan] no horizontal scroll at ${width}px`,
    overflow.scrollW <= overflow.clientW + 1,
    `${overflow.scrollW} vs ${overflow.clientW}${overflow.wide.length ? ` — ${overflow.wide.join(', ')}` : ''}`,
  )
}

// 3. Every interactive target clears 44x44.
//
// The WCAG 2.5.8 inline exemption is implemented by its definition rather
// than by an ancestor class: a link is exempt when the element containing it
// also holds text of its own — the map attribution's sentence — and not when
// its container holds nothing but links.
async function sweep() {
  return cdp.evaluate(`(() => {
    const sel = 'button:not([disabled]), a[href], input, select, [role="option"]'
    const inlineInProse = (el) => {
      if (el.tagName !== 'A') return false
      const parent = el.parentElement
      if (!parent) return false
      const own = (parent.textContent || '').replace(el.textContent || '', '').trim()
      return own.length > 0
    }
    return [...document.querySelectorAll(sel)]
      .filter(el => {
        const r = el.getBoundingClientRect()
        if (r.width === 0 && r.height === 0) return false        // not rendered
        if (inlineInProse(el)) return false
        return r.width < 44 || r.height < 44
      })
      .map(el => \`\${el.tagName.toLowerCase()}.\${(el.className||'').split(' ')[0]} \${Math.round(el.getBoundingClientRect().width)}x\${Math.round(el.getBoundingClientRect().height)}\`)
      .slice(0, 8) })()`)
}

/** Open everything openable on the current screen, then sweep: <details>
 *  unfold, and every collapsed [aria-expanded] disclosure is clicked in turn
 *  so a control only reachable behind one is still measured. */
async function sweepWithDisclosures() {
  await cdp.evaluate(`(() => { for (const d of document.querySelectorAll('details')) d.open = true; return true })()`)
  const passes = await cdp.evaluate(`[...document.querySelectorAll('[aria-expanded]')].length`)
  const small = []
  for (let pass = 0; pass <= passes; pass += 1) {
    if (pass > 0) {
      await cdp.evaluate(`(() => {
        const all = [...document.querySelectorAll('[aria-expanded]')]
        const target = all[${pass - 1}]
        if (target && target.getAttribute('aria-expanded') === 'false') target.click()
        for (const d of document.querySelectorAll('details')) d.open = true
        return true })()`)
      await new Promise((r) => setTimeout(r, 250))
    }
    const found = await sweep()
    for (const offender of found) if (!small.includes(offender)) small.push(offender)
  }
  return small
}

const axeSource = await import('node:fs').then((fs) =>
  fs.readFileSync(new URL('../node_modules/axe-core/axe.min.js', import.meta.url), 'utf8'),
)

async function axeViolations() {
  await cdp.evaluate(axeSource)
  return cdp.evaluate(`(async () => {
    const r = await axe.run(document, { runOnly: { type: 'tag', values: ['wcag2a','wcag2aa'] } })
    return r.violations.map(v => \`\${v.id} (\${v.nodes.length})\`) })()`)
}

/** The full accessibility pass for whatever screen is up: target sizes and
 *  axe, in both themes — the dark block restates the light palette by design,
 *  and this is what proves that stays true. */
async function a11yPass(label) {
  for (const theme of ['light', 'dark']) {
    await setTheme(theme)
    const small = await sweepWithDisclosures()
    check(`[${label}][${theme}] every target clears 44x44`, small.length === 0, small.slice(0, 6).join('; '))
    const violations = await axeViolations()
    check(`[${label}][${theme}] axe reports no wcag2a/2aa violations`, violations.length === 0, violations.join('; '))
  }
  await setTheme('light')
  const live = await cdp.evaluate(
    `document.querySelectorAll('[role="status"][aria-live="polite"]').length`,
  )
  check(`[${label}] exactly one polite live region`, live === 1, `${live}`)
}

// The plan, graded where it loads.
await load(390, 844, true)
await a11yPass('plan')

// 3b. THE PLAN WITH A DESTINATION — a distinct screen, so it is graded as one.
//
// It was reachable before this only through a shared link, which the gate has
// no way to open, so the whole point-to-point half of the app was ungraded:
// the clear control, the sentence that stands where the dial stands for a
// loop, and the fact that the dial is *gone* rather than disabled.
await load(390, 844, true)
// The origin first, because the screen this grades is the one with both ends
// filled in and because Find routes is disabled without one — a destination
// pass that skipped it would click a disabled button and report the miss as a
// routing failure.
await cdp.evaluate(`(()=>{document.querySelector('[aria-label="Use my location"]')?.click()})()`)
await waitFor(
  `!![...document.querySelectorAll('button')].find(x=>/find routes/i.test(x.textContent||'')&&!x.disabled)`,
  60,
)
const destPicked = await pickDestination()
check('[destination] picking one on the plan sheet sets it', destPicked)

if (destPicked) {
  const destCounts = await countSelectors(DEST_MANIFEST)
  const destOk = checkManifest('destination', DEST_MANIFEST, destCounts)

  // The dial is not disabled here, it is absent. `buildRouteRequest` omits
  // `minutes` from a point-to-point body, so a slider on this screen would be
  // a control that moves and changes nothing.
  const dial = await cdp.evaluate(`document.querySelectorAll('.dial__slider').length`)
  check('[destination] the time dial is gone, not disabled', dial === 0, `${dial} found`)

  const overflow = await cdp.evaluate(overflowCheck)
  check(
    '[destination] no horizontal scroll at 390px',
    overflow.scrollW <= overflow.clientW + 1,
    `${overflow.scrollW} vs ${overflow.clientW}${overflow.wide.length ? ` — ${overflow.wide.join(', ')}` : ''}`,
  )

  if (destOk) await a11yPass('destination')

  // And it still routes. A destination that sets state and never reaches the
  // request is the failure this whole screen exists to avoid.
  await cdp.evaluate(
    `(()=>{const b=[...document.querySelectorAll('button')].find(x=>/find routes/i.test(x.textContent||'')&&!x.disabled);if(b)b.click()})()`,
  )
  const routed = await waitFor(`document.querySelectorAll('button.route').length >= 1`, 80)
  check('[destination] Find routes still streams cards for a trip with one', routed)
}

// 4. THE RESULTS — driven, then graded.
await load(390, 844, true)
const arrived = await driveToResults(true)
check('[results] the stream delivers cards', arrived)
const resultCounts = await countSelectors(RESULTS_MANIFEST)
const resultsOk = checkManifest('results', RESULTS_MANIFEST, resultCounts)

if (resultsOk) {
  const substitute = await cdp.evaluate(`(() => {
    const rows = [...document.querySelectorAll('button.route')]
    return { rows: rows.length,
             allNamed: rows.every(r => (r.textContent || '').trim().length > 20) } })()`)
  check('[results] every card carries its own text', substitute.rows > 0 && substitute.allNamed, `${substitute.rows} cards`)

  const overflow = await cdp.evaluate(overflowCheck)
  check(
    '[results] no horizontal scroll at 390px',
    overflow.scrollW <= overflow.clientW + 1,
    `${overflow.scrollW} vs ${overflow.clientW}${overflow.wide.length ? ` — ${overflow.wide.join(', ')}` : ''}`,
  )

  // The sheet is the results' home below 1024 and must behave like one:
  // inside the viewport, scrolling internally rather than growing the page.
  const sheet = await cdp.evaluate(`(() => {
    const el = document.querySelector('.sheet')
    if (!el) return null
    const r = el.getBoundingClientRect()
    return { bottom: +(r.bottom - innerHeight).toFixed(2),
             overflowY: getComputedStyle(el).overflowY } })()`)
  check('[results] the sheet stays inside the viewport', sheet && sheet.bottom <= 1, `overhang ${sheet?.bottom}px`)
  check('[results] the sheet scrolls internally', sheet?.overflowY === 'auto', sheet?.overflowY)

  await a11yPass('results')
}

// 5. THE DETAIL, mobile: one tap on a card selects and opens it.
await load(390, 844, true)
await driveToResults(true)
await cdp.evaluate(`(()=>{document.querySelector('button.route')?.click()})()`)
const detailUp = await waitFor(`!!document.querySelector('.detail--sheet')`, 40, 100)
check('[detail] tapping a card opens the detail sheet', detailUp)
if (detailUp) {
  await a11yPass('detail')
}

// 6. THE DESKTOP LAYOUT at 1200: capsule, card row, modal.
await load(1200, 900, false)
const capsule = await cdp.evaluate(`!!document.querySelector('.capsule')`)
check('[desktop] the plan capsule renders at 1200px', capsule)
const capsuleDest = await cdp.evaluate(`!!document.querySelector('.capsule__seg--dest')`)
check('[desktop] the capsule carries a destination segment', capsuleDest)
if (capsule) {
  const arrived = await driveToResults(false)
  check('[desktop] the stream delivers cards', arrived)
  if (arrived) {
    const row = await cdp.evaluate(`(() => {
      const cards = [...document.querySelectorAll('.rail--row .card')]
      if (cards.length < 2) return { cards: cards.length, sideBySide: false }
      const [a, b] = cards.map(c => c.getBoundingClientRect())
      return { cards: cards.length, sideBySide: b.left >= a.right - 2 } })()`)
    check('[desktop] the cards sit in a row', row.sideBySide, `${row.cards} cards`)

    // First click selects; a second on the selected card opens the modal.
    await cdp.evaluate(`(()=>{document.querySelector('button.route')?.click()})()`)
    await new Promise((r) => setTimeout(r, 300))
    await cdp.evaluate(`(()=>{document.querySelector('button.route')?.click()})()`)
    const modal = await waitFor(`!!document.querySelector('.detail--modal')`, 40, 100)
    check('[desktop] the selected card opens the centered modal', modal)
    if (modal) {
      const scrimmed = await cdp.evaluate(`!!document.querySelector('.detail-scrim')`)
      check('[desktop] the modal sits over a scrim', scrimmed)
      const violations = await axeViolations()
      check('[desktop][modal] axe reports no wcag2a/2aa violations', violations.length === 0, violations.join('; '))
    }
  }
}

// 7. FOLLOW MODE — entered from the mobile detail, graded like every screen.
//
// `.follow` is deliberately NOT in the top-level manifests: it matches zero
// elements on every load that has not entered follow mode, and the rule here
// is that a zero-match is a failure rather than a skip.
const FOLLOW_MANIFEST = [
  ['.follow', 'FollowMode.jsx — the overlay'],
  ['.follow__dock', 'FollowMode.jsx — the dock'],
  ['.follow__provenance', 'FollowMode.jsx — the privacy line'],
]

await load(390, 844, true)
await driveToResults(true)
await cdp.evaluate(`(()=>{document.querySelector('button.route')?.click()})()`)
await waitFor(`!!document.querySelector('.detail--sheet')`, 40, 100)
await cdp.evaluate(
  `(()=>{const b=[...document.querySelectorAll('button')].find(x=>/start follow mode/i.test(x.textContent||''));if(b){b.scrollIntoView({block:'center'});b.click()}})()`,
)
const followUp = await waitFor(`!!document.querySelector('.follow')`, 40, 100)
const followCounts = await countSelectors(FOLLOW_MANIFEST)
const followOk = checkManifest('follow', FOLLOW_MANIFEST, followCounts)
check('[follow] entered from the detail', followUp)

if (followOk) {
  const geom = await cdp.evaluate(`(() => {
    const follow = document.querySelector('.follow')
    const dock = document.querySelector('.follow__dock')
    const fb = follow.getBoundingClientRect(), db = dock.getBoundingClientRect()
    return {
      belowViewport: +(fb.bottom - innerHeight).toFixed(2),
      dockInside: db.bottom <= fb.bottom + 1 && db.top >= fb.top - 1 } })()`)
  check('[follow] the layer fits the viewport', geom.belowViewport <= 1, `past viewport by ${geom.belowViewport}px`)
  check('[follow] the dock sits inside the layer', geom.dockInside)

  const overflow = await cdp.evaluate(overflowCheck)
  check(
    '[follow] no horizontal scroll at 390px',
    overflow.scrollW <= overflow.clientW + 1,
    `${overflow.scrollW} vs ${overflow.clientW}${overflow.wide.length ? ` — ${overflow.wide.join(', ')}` : ''}`,
  )

  await a11yPass('follow')
}

// ------------------------------------------------------------------- report

console.log('')
let failed = 0
for (const [name, ok, detail] of results) {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${name}${detail ? `   [${detail}]` : ''}`)
  if (!ok) failed += 1
}
cdp.close()
proc.kill()
console.log(
  failed === 0
    ? `\n${results.length} checks, all green.`
    : `\n${failed} of ${results.length} FAILED`,
)
process.exit(failed === 0 ? 0 : 1)
