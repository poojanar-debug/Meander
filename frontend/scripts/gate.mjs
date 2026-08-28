import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'

// The objective table itself, so the picker is graded against what the app
// believes it offers rather than against a number written down twice. It is
// plain data with no imports of its own and never enters the browser here.
import { OBJECTIVES } from '../src/lib/dash.js'

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
 * What it drives, per viewport: the plan surface → the objective picker →
 * Use my location → Find routes → the streamed cards → the route detail →
 * (on a phone) follow mode.
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
  ['.wordmark', 'Wordmark.jsx — the lockup at the head of the plan'],
  ['.plan__search-field', 'PlanSheet.jsx — the doorway to place search'],
  ['.plan__search--dest', 'PlanSheet.jsx — the destination field'],
  ['[aria-label="Use my location"]', 'PlanSheet.jsx — the location arrow'],
  ['.dial__slider', 'TimeDial.jsx — the native range input'],
  ['.mode__seg', 'ModeControl.jsx'],
  ['.chip', 'ObjectiveChips.jsx'],
  ['.layers__toggle', 'LayerPicker.jsx — the basemap control'],
  ['[role="status"][aria-live="polite"]', 'App.jsx — the one live region'],
]

// The layer menu, which matches zero elements until the toggle is pressed —
// so it is separate for exactly the reason FOLLOW_MANIFEST is.
const LAYERS_MANIFEST = [
  ['.layers__menu', 'LayerPicker.jsx — the open menu'],
  ['.layers__option', 'LayerPicker.jsx — a basemap choice'],
  ['.layers__hint--warn', 'LayerPicker.jsx — the satellite tile-streaming warning'],
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

/**
 * How long Chrome gets to open its debugging port.
 *
 * **Thirty seconds, and it used to be ten.** Ten lost the race on a GitHub
 * runner on 2026-08-26 (run 32969563724), and the same commit had passed the
 * same gate half an hour earlier, so it is a cold-start race rather than
 * anything about the build being graded. A re-run went green and told nobody
 * anything, which is the failure mode this whole file exists to refuse.
 *
 * The number is patience, not tolerance: nothing about what the gate accepts
 * changes, only how long it is willing to wait for a browser to exist.
 */
const LAUNCH_TIMEOUT_MS = 30000
const LAUNCH_POLL_MS = 100

/** Chrome's own announcement of the port it actually opened. */
const DEVTOOLS_LINE = /DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)\//

/** Exit code for "this gate could not run at all", as distinct from 1, which
 *  means it ran and something failed. `No Chrome at ...` has always used it. */
const CANNOT_RUN = 2

function cannotRun(lines) {
  console.error('')
  for (const line of lines) console.error(line)
  console.error('')
  process.exit(CANNOT_RUN)
}

async function launch() {
  if (!existsSync(CHROME)) {
    console.error(`No Chrome at ${CHROME}. Set CHROME_PATH.`)
    process.exit(CANNOT_RUN)
  }
  // stderr is piped and kept rather than discarded, and it is now load-bearing
  // rather than only diagnostic: it carries the port. `stdio: 'ignore'` threw
  // away the one thing that explains a launch that fails for a real reason —
  // a missing shared library, a sandbox refusal, a profile another instance
  // holds — and left the run to die later on a bare ECONNREFUSED naming
  // nothing.
  const noise = []
  const proc = spawn(
    CHROME,
    [
      '--headless=new',
      // Port 0, not 9444, and this is the fix for something worse than a slow
      // start. On a fixed port `launch()` polled `/json/version` and accepted
      // ANY browser that answered — including one a previous run leaked, which
      // it had not started and whose page it knew nothing about. Demonstrated
      // on purpose: pointing CHROME_PATH at `/bin/false`, which cannot serve
      // anything, still produced a connected gate and twelve graded checks,
      // because a stale Chrome was still holding 9444. Where that stale
      // browser happens to sit on the right page, the same path reports a
      // PASS that means nothing.
      //
      // Asking for 0 makes the kernel pick a free port and makes Chrome
      // announce it on stderr, so the port the gate connects to is by
      // construction the port of the browser it just spawned.
      '--remote-debugging-port=0',
      '--no-first-run',
      '--no-default-browser-check',
      '--user-data-dir=/tmp/meander-gate-profile',
      '--hide-scrollbars',
      'about:blank',
    ],
    { stdio: ['ignore', 'ignore', 'pipe'] },
  )
  // Always consumed, only the first lines kept: an unread pipe fills its
  // buffer and blocks the process writing to it, which would turn a
  // diagnostic aid into a hang.
  let port = null
  proc.stderr.setEncoding('utf8')
  proc.stderr.on('data', (chunk) => {
    if (noise.length < 40) noise.push(chunk)
    const found = String(chunk).match(DEVTOOLS_LINE)
    if (found && port === null) port = Number(found[1])
  })
  // A browser that died is a different failure from a browser that is slow,
  // and it is knowable immediately rather than in thirty seconds.
  let died = null
  proc.on('exit', (code, signal) => {
    died = signal ? `killed by ${signal}` : `exited with code ${code}`
  })
  proc.on('error', (err) => {
    died = `could not be spawned: ${err.message}`
  })

  const deadline = Date.now() + LAUNCH_TIMEOUT_MS
  while (Date.now() < deadline) {
    if (died) break
    // Nothing is probed until this browser has said which port is its own.
    if (port !== null) {
      try {
        // The only path out of this function that reports success. The version
        // this replaces `break`-ed out of a bounded loop and then returned the
        // same value whether it had reached Chrome or given up, so the next
        // call to the port threw ECONNREFUSED and the run ended with a stack
        // trace about `fetch` instead of a sentence about Chrome.
        if ((await fetch(`http://127.0.0.1:${port}/json/version`)).ok) return { proc, port }
      } catch {
        /* announced but not answering yet */
      }
    }
    await new Promise((r) => setTimeout(r, LAUNCH_POLL_MS))
  }

  const why =
    died ??
    (port === null
      ? `never announced a debugging port within ${LAUNCH_TIMEOUT_MS / 1000}s`
      : `announced port ${port} but never answered on it within ${LAUNCH_TIMEOUT_MS / 1000}s`)
  proc.kill()
  cannotRun([
    `The gate could not start a browser: Chrome ${why}.`,
    `  binary  ${CHROME}`,
    ...(noise.length ? ['  chrome said:', ...noise.join('').trimEnd().split('\n').slice(0, 20).map((l) => `    ${l}`)] : ['  chrome said nothing on stderr.']),
    'Nothing was graded. This is not a pass and it is not a layout failure.',
  ])
}

async function connect(port) {
  let targets
  try {
    targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
  } catch (err) {
    cannotRun([
      `Chrome answered on port ${port} but its target list did not: ${err.message}`,
      'Nothing was graded.',
    ])
  }
  const page = targets.find((t) => t.type === 'page')
  // `page` was dereferenced unguarded, so a browser with no page target — it
  // happens when another instance holds the profile — died on
  // "Cannot read properties of undefined", which names neither Chrome nor the
  // gate.
  if (!page?.webSocketDebuggerUrl) {
    cannotRun([
      `Chrome is up on port ${port} but offers no page target to drive.`,
      `  targets  ${JSON.stringify(targets.map((t) => t.type))}`,
      'Nothing was graded.',
    ])
  }
  const ws = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((res, rej) => {
    ws.onopen = res
    // An Event, not an Error: rejecting with it produced an unreadable
    // "[object Event]" wherever it surfaced.
    ws.onerror = () => rej(new Error(`Could not open a CDP socket to ${page.webSocketDebuggerUrl}`))
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

// The browser is killed however this process ends, not only when it ends well.
//
// `proc.kill()` used to run in exactly one place — the last two lines, after
// the report — so any throw in between left a headless Chrome running. That is
// not a tidiness problem: a leaked browser is what put a stranger on the fixed
// debugging port that `launch()` then adopted, and a run of this very gate is
// what leaked it (a CDP "Inspected target navigated or closed" on 2026-08-26).
// The port is ephemeral now, so a leak can no longer be adopted; it should
// still not happen.
const reap = () => {
  try {
    proc.kill()
  } catch {
    /* already gone */
  }
}
process.on('exit', reap)
process.on('SIGINT', () => {
  reap()
  process.exit(130)
})
process.on('SIGTERM', () => {
  reap()
  process.exit(143)
})
process.on('uncaughtException', (err) => {
  reap()
  console.error('\nThe gate crashed rather than finishing. Nothing below was graded.\n')
  console.error(err)
  process.exit(CANNOT_RUN)
})
process.on('unhandledRejection', (err) => {
  reap()
  console.error('\nThe gate crashed rather than finishing. Nothing below was graded.\n')
  console.error(err)
  process.exit(CANNOT_RUN)
})

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

// 3a. THE OBJECTIVE PICKER — operated, not merely counted.
//
// `.chip` has been in the plan manifest since this gate was written, which
// proves chips exist and nothing more. It is the control that decides what
// gets routed, all six of its chips went live when the last three objectives
// shipped, and pressing one is the only way to learn that a chip presses at
// all: axe reads the markup, the sweep measures the box, and neither notices
// a dead handler or a pressed state that never paints.
await load(390, 844, true)

const chipStates = () =>
  cdp.evaluate(`([...document.querySelectorAll('.chip')]).map(c => ({
    id: (c.className.match(/chip--([a-z]+)/) || [])[1] ?? '?',
    disabled: c.disabled,
    pressed: c.getAttribute('aria-pressed') === 'true',
    washed: c.classList.contains('is-pressed'),
  }))`)

async function pressChip(id) {
  const hit = await cdp.evaluate(
    `(()=>{const c=document.querySelector('.chip--${id}');if(!c)return false;c.click();return true})()`,
  )
  await new Promise((r) => setTimeout(r, 200))
  return hit
}

const chipsAtRest = await chipStates()
const chipIds = chipsAtRest.map((c) => c.id)
check(
  '[objectives] every objective in dash.js has a chip that can be pressed',
  chipIds.length === OBJECTIVES.length &&
    OBJECTIVES.every((o) => chipIds.includes(o.id)) &&
    chipsAtRest.every((c) => !c.disabled),
  `${chipIds.join(', ') || 'none'}${
    chipsAtRest.some((c) => c.disabled)
      ? ` — disabled: ${chipsAtRest.filter((c) => c.disabled).map((c) => c.id).join(', ')}`
      : ''
  }`,
)
check(
  '[objectives] aria-pressed agrees with the pressed wash on every chip',
  chipsAtRest.every((c) => c.pressed === c.washed),
  chipsAtRest.filter((c) => c.pressed !== c.washed).map((c) => c.id).join(', '),
)

// Three are pressed on a fresh load and the reducer refuses a fourth on
// purpose, so the toggle makes room before it asks for anything. Pressing
// `quiet` straight into a full set would be refused, and a refusal looks
// exactly like a dead chip from out here.
const released = await pressChip('accessible')
const taken = await pressChip('quiet')
const chipsAfter = Object.fromEntries((await chipStates()).map((c) => [c.id, c]))
check('[objectives] both chips were there to press', released && taken)
check(
  '[objectives] pressing a pressed chip releases it',
  chipsAfter.accessible?.pressed === false && chipsAfter.accessible?.washed === false,
  JSON.stringify(chipsAfter.accessible ?? null),
)
check(
  '[objectives] pressing a free chip presses it',
  chipsAfter.quiet?.pressed === true && chipsAfter.quiet?.washed === true,
  JSON.stringify(chipsAfter.quiet ?? null),
)

const chipOverflow = await cdp.evaluate(overflowCheck)
check(
  '[objectives] no horizontal scroll with a different three pressed',
  chipOverflow.scrollW <= chipOverflow.clientW + 1,
  `${chipOverflow.scrollW} vs ${chipOverflow.clientW}${
    chipOverflow.wide.length ? ` — ${chipOverflow.wide.join(', ')}` : ''
  }`,
)

// Graded as its own screen: a pressed chip is the only place three of the
// wash families are drawn at all, and their text sits on them.
await a11yPass('objectives')

// 3a-ii. THE LAYER PICKER — operated, and its warning proved to exist.
//
// `.layers__toggle` in the plan manifest proves a button is painted and
// nothing more. What actually matters here is not the button: it is that
// choosing satellite carries a visible warning that tiles will be fetched
// while walking, and that the attribution line changes to name the imagery
// source. Both are obligations rather than features — the first is the honest
// half of a privacy claim the app makes elsewhere in writing, the second is a
// licence condition — and neither is the kind of thing axe or a target sweep
// would ever notice going missing.
await load(390, 844, true)

const attributionText = () =>
  cdp.evaluate(`(document.querySelector('.map-attribution')?.textContent ?? '').trim()`)

const beforeAttribution = await attributionText()
const opened = await cdp.evaluate(
  `(()=>{const b=document.querySelector('.layers__toggle');if(!b)return false;b.click();return true})()`,
)
await new Promise((r) => setTimeout(r, 200))
check('[layers] the toggle opens the menu', opened)

const layerCounts = await countSelectors(LAYERS_MANIFEST)
const layersOk = checkManifest('layers', LAYERS_MANIFEST, layerCounts)

if (layersOk) {
  const options = await cdp.evaluate(`([...document.querySelectorAll('.layers__option')]).map(o => ({
    label: o.querySelector('.layers__option-label')?.textContent ?? '?',
    checked: o.getAttribute('aria-checked') === 'true',
    described: !!document.getElementById(o.getAttribute('aria-describedby') || ''),
  }))`)
  check(
    '[layers] exactly one option is checked at rest',
    options.filter((o) => o.checked).length === 1,
    JSON.stringify(options),
  )
  check(
    '[layers] every option names the hint that describes it',
    options.every((o) => o.described),
    options.filter((o) => !o.described).map((o) => o.label).join(', '),
  )

  // Graded with the menu open: it is a popover of real controls over a map,
  // and it has never been on screen for any other pass.
  await a11yPass('layers')

  const picked = await cdp.evaluate(`(()=>{
    const o=[...document.querySelectorAll('.layers__option')].find(x=>/satellite/i.test(x.textContent||''))
    if(!o)return false; o.click(); return true})()`)
  await new Promise((r) => setTimeout(r, 300))
  check('[layers] satellite is there to choose', picked)

  const afterAttribution = await attributionText()
  check(
    '[layers] choosing satellite changes the attribution line',
    afterAttribution !== beforeAttribution && /esri/i.test(afterAttribution),
    `was ${JSON.stringify(beforeAttribution)}, now ${JSON.stringify(afterAttribution)}`,
  )
  check(
    '[layers] the OpenStreetMap credit survives the switch',
    /openstreetmap/i.test(afterAttribution),
    afterAttribution,
  )

  const layerOverflow = await cdp.evaluate(overflowCheck)
  check(
    '[layers] no horizontal scroll with the menu open',
    layerOverflow.scrollW <= layerOverflow.clientW + 1,
    `${layerOverflow.scrollW} vs ${layerOverflow.clientW}${
      layerOverflow.wide.length ? ` — ${layerOverflow.wide.join(', ')}` : ''
    }`,
  )
}

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
//
// Routed with `quiet` traded in for `accessible` rather than on the default
// three, because the two newest pieces of this panel only exist on a route
// that has them: the fourth score bar, and the sentence an ok route carries
// saying what its objective steered on. All three objectives that are on by
// default have neither, so grading the default set grades the old panel.
await load(390, 844, true)
await cdp.evaluate(`(()=>{document.querySelector('[aria-label="Use my location"]')?.click()})()`)
await waitFor(
  `!![...document.querySelectorAll('button')].find(x=>/find routes/i.test(x.textContent||'')&&!x.disabled)`,
  60,
)
await pressChip('accessible')
await pressChip('quiet')
const swapped = await cdp.evaluate(
  `document.querySelector('.chip--quiet')?.getAttribute('aria-pressed') === 'true'`,
)
check('[detail] the picker traded quiet in for accessible', swapped)
await cdp.evaluate(
  `(()=>{const b=[...document.querySelectorAll('button')].find(x=>/find routes/i.test(x.textContent||'')&&!x.disabled);if(b)b.click()})()`,
)
await waitFor(`document.querySelectorAll('button.route').length >= 3`, 80)
const quietCard = await cdp.evaluate(`(() => {
  const row = [...document.querySelectorAll('button.route')].find(b => /^Quiet/.test((b.textContent || '').trim()))
  if (!row) return false
  row.click()
  return true })()`)
check('[detail] the objective that was traded in has a card', quietCard)
const detailUp = await waitFor(`!!document.querySelector('.detail--sheet')`, 40, 100)
check('[detail] tapping a card opens the detail sheet', detailUp)
if (detailUp) {
  const panel = await cdp.evaluate(`(() => ({
    rows: [...document.querySelectorAll('.scores__row .scores__label')].map(s => s.textContent),
    basis: document.querySelectorAll('.detail__basis-note').length,
    blocked: document.querySelectorAll('.detail__blocked-note').length,
  }))()`)
  check(
    '[detail] one score row per field on the wire',
    panel.rows.join(',') === 'scenic,air,shade,quiet',
    panel.rows.join(',') || 'none',
  )
  check(
    "[detail] an ok route's note renders, and not in the rejection skin",
    panel.basis === 1 && panel.blocked === 0,
    `${panel.basis} basis, ${panel.blocked} blocked`,
  )
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
  ['.map__compass', 'MapView.jsx — the course-up toggle'],
]

await load(390, 844, true)
await driveToResults(true)
await cdp.evaluate(`(()=>{document.querySelector('button.route')?.click()})()`)
await waitFor(`!!document.querySelector('.detail--sheet')`, 40, 100)
await cdp.evaluate(
  `(()=>{const b=[...document.querySelectorAll('button')].find(x=>/start follow mode/i.test(x.textContent||''));if(b){b.scrollIntoView({block:'center'});b.click()}})()`,
)
const followUp = await waitFor(`!!document.querySelector('.follow')`, 40, 100)
// The overlay is FollowMode.jsx and the compass is MapView.jsx: two
// components, two render passes, and `.follow` appearing first is not a
// promise the compass has mounted yet. Counting at overlay-appearance + 0 ms
// lost this race intermittently — 1 of 94 FAILED on runs whose frontend was
// byte-identical to passing ones. So wait for the compass too, with the same
// budget. The manifest check below is untouched: if the compass genuinely
// never mounts, this line burns its four seconds and the zero-match still
// fails, which is the gate's rule — a slow selector is waited for, a missing
// one is never excused.
await waitFor(`!!document.querySelector('.map__compass')`, 40, 100)
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
