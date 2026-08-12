import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'

/**
 * Layout and accessibility gate, in a real headless Chrome.
 *
 * **This is a rewrite, not a port.** The version on the branch this comes from
 * selects on `.row__button`, `.sheet__handle`, `.sheet__scroll`, `.card`,
 * `.footer`, `.topbar__origin` and `.controls-sheet__bar` — seven selector
 * families, none of which exist in this frontend. Four of its fourteen checks
 * would find zero elements and pass, and one is literally `check(label, true)`:
 * a pass value of the constant `true`, which cannot fail under any DOM.
 *
 * So the first thing this gate does is prove its own selectors match something.
 * The manifest below is checked before any assertion that depends on it, and a
 * selector matching zero elements is a FAILURE, not a silent skip. That is the
 * whole design: a gate that cannot fail is worse than no gate, because it reads
 * as coverage.
 *
 * Two checks from the original are deliberately NOT restored, because they
 * encode a layout this app does not have and would fail correctly-built code:
 *
 *   - "the page itself does not scroll at 390x844". Below 899px this app sets
 *     `.app { height: auto }` and `.panel { overflow-y: visible }` on purpose —
 *     the page scrolls as one document. That is the design, written out in the
 *     stylesheet.
 *   - "every route is visible without scrolling". That was a bottom-sheet
 *     contract, and there is no bottom sheet here.
 *
 * Usage:  node scripts/gate.mjs [url]        (default http://localhost:4173)
 */

const URL_ = process.argv[2] ?? 'http://localhost:4173/'
const CHROME =
  process.env.CHROME_PATH ??
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'

// Every selector this gate depends on, and what renders it. If one of these
// stops matching, the gate fails loudly instead of grading nothing.
const MANIFEST = [
  ['.app', 'App.jsx — the layout root'],
  ['.topbar', 'Topbar.jsx'],
  ['.panel', 'App.jsx — the scrolling column'],
  ['.stage', 'App.jsx — the map column'],
  ['button.route', 'RouteRow.jsx — a real row, not a skeleton'],
  ['.route__sub', 'RouteRow.jsx — the distance line'],
  ['.rail', 'RouteRail.jsx'],
  ['.detail', 'RouteDetail.jsx'],
  ['.chip', 'ObjectiveChips.jsx / UnitsControl.jsx'],
  ['.button', 'shared control class'],
  ['[role="status"][aria-live="polite"]', 'App.jsx — the one live region'],
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

async function load(width, height, mobile) {
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width,
    height,
    deviceScaleFactor: mobile ? 2 : 1,
    mobile,
  })
  await cdp.send('Page.navigate', { url: URL_ })
  for (let i = 0; i < 120; i += 1) {
    if ((await cdp.evaluate('document.readyState').catch(() => null)) === 'complete') break
    await new Promise((r) => setTimeout(r, 100))
  }
  await new Promise((r) => setTimeout(r, 500))
  // Past the first-run screen, so the panel, rail and detail exist.
  await cdp.evaluate(
    `(()=>{const b=[...document.querySelectorAll('button')].find(x=>/use my location/i.test(x.textContent));if(b)b.click()})()`,
  )
  for (let i = 0; i < 120; i += 1) {
    if (await cdp.evaluate(`!!document.querySelector('.route__sub')`)) break
    await new Promise((r) => setTimeout(r, 250))
  }
  // Select a route so the detail panel renders.
  await cdp.evaluate(`(()=>{const r=document.querySelector('button.route'); if(r) r.click()})()`)
  await new Promise((r) => setTimeout(r, 400))
}

async function setTheme(theme) {
  await cdp.evaluate(`document.documentElement.dataset.theme = '${theme}'`)
  await new Promise((r) => setTimeout(r, 200))
}

await load(390, 844, true)

// 1. THE MANIFEST — before anything that depends on it.
const counts = await cdp.evaluate(
  `(${JSON.stringify(MANIFEST.map((m) => m[0]))}).map(s => document.querySelectorAll(s).length)`,
)
let manifestOk = true
MANIFEST.forEach(([selector, owner], i) => {
  const n = counts[i]
  if (!check(`selector ${selector} matches something (${owner})`, n > 0, `${n} found`)) {
    manifestOk = false
  }
})

if (!manifestOk) {
  console.log('\nThe selector manifest failed. Every check below would be grading nothing,')
  console.log('so they are not run — that is the difference between this gate and the one')
  console.log('it replaces.\n')
  for (const [name, ok, detail] of results) {
    console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${name}${detail ? `   [${detail}]` : ''}`)
  }
  cdp.close()
  proc.kill()
  process.exit(1)
}

// 2. No horizontal scroll at the narrowest supported width.
for (const width of [320, 390]) {
  await load(width, 844, true)
  const overflow = await cdp.evaluate(`(() => {
    const doc = document.documentElement
    const wide = [...document.querySelectorAll('*')]
      .filter(el => el.getBoundingClientRect().right > doc.clientWidth + 1)
      .slice(0, 5)
      .map(el => el.className || el.tagName)
    return { scrollW: doc.scrollWidth, clientW: doc.clientWidth, wide } })()`)
  check(
    `no horizontal scroll at ${width}px`,
    overflow.scrollW <= overflow.clientW + 1,
    `${overflow.scrollW} vs ${overflow.clientW}${overflow.wide.length ? ` — ${overflow.wide.join(', ')}` : ''}`,
  )
}

// 3. Every interactive target clears 44x44, in both themes.
//
// Everything collapsible is opened first. A control behind a closed drawer
// measures 0x0 and is filtered out as "not rendered", so a gate that does not
// expand them silently exempts every control the user has to open something to
// reach — which on this app is most of them.
// The trip-bar segments are mutually exclusive — opening one closes the last —
// so they cannot all be open at once and are swept one at a time instead.
const openDetails = `(() => { for (const d of document.querySelectorAll('details')) d.open = true; return true })()`
const disclosures = `(() => [...document.querySelectorAll('[aria-expanded]')].length)()`

// Hoisted to module scope rather than declared inside the theme loop below,
// which is where it used to live. A function declared in that loop body is
// reachable from nowhere else in the file, and the one screen this gate had
// never swept — follow mode, section 7 — needs exactly this measurement. The
// alternative was a second copy of the WCAG 2.5.8 exemption logic, and two
// copies of an accessibility rule drift apart silently.
async function sweep() {
  return cdp.evaluate(`(() => {
    const sel = 'button:not([disabled]), a[href], input, select, [role="option"]'
    // WCAG 2.2 SC 2.5.8 exempts a target that is "in a sentence or its size is
    // otherwise constrained by the line-height of non-target text". Implemented
    // by that definition rather than by an ancestor class: a link is exempt when
    // the element containing it also holds text of its own. That covers the
    // credits sentence in About and MapLibre's attribution strip, and does not
    // cover a link styled as a button, whose container holds nothing but links.
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

// Open every disclosure in turn and union the offenders, so a control only
// reachable behind an open drawer is still measured.
async function sweepEveryDisclosure(theme) {
  await cdp.evaluate(openDetails)
  await new Promise((r) => setTimeout(r, 250))
  const passes = await cdp.evaluate(disclosures)
  check(`[${theme}] there are disclosures to sweep`, passes > 0, `${passes}`)
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

await load(390, 844, true)
for (const theme of ['light', 'dark']) {
  await setTheme(theme)
  const small = await sweepEveryDisclosure(theme)
  check(`[${theme}] every target clears 44x44`, small.length === 0, small.slice(0, 6).join('; '))
}

// 4. axe-core, both themes. Injected from the installed package rather than a CDN.
const axeSource = await import('node:fs').then((fs) =>
  fs.readFileSync(new URL('../node_modules/axe-core/axe.min.js', import.meta.url), 'utf8'),
)
for (const theme of ['light', 'dark']) {
  await setTheme(theme)
  await cdp.evaluate(axeSource)
  const violations = await cdp.evaluate(`(async () => {
    const r = await axe.run(document, { runOnly: { type: 'tag', values: ['wcag2a','wcag2aa'] } })
    return r.violations.map(v => \`\${v.id} (\${v.nodes.length})\`) })()`)
  check(`[${theme}] axe reports no wcag2a/2aa violations`, violations.length === 0, violations.join('; '))
}

// 5. The two-column layout above the breakpoint, one column below it.
await load(1200, 900, false)
const desktop = await cdp.evaluate(`(() => {
  const layout = getComputedStyle(document.querySelector('.layout'))
  const panel = document.querySelector('.panel').getBoundingClientRect()
  const stage = document.querySelector('.stage').getBoundingClientRect()
  return { columns: layout.gridTemplateColumns, sideBySide: stage.left >= panel.right - 2,
           panelScrolls: getComputedStyle(document.querySelector('.panel')).overflowY } })()`)
check('the panel and the stage sit side by side above 900px', desktop.sideBySide, desktop.columns)
check('the panel is the scrolling column above 900px', desktop.panelScrolls === 'auto', desktop.panelScrolls)

await load(390, 844, true)
const mobile = await cdp.evaluate(`(() => {
  const panel = document.querySelector('.panel').getBoundingClientRect()
  const stage = document.querySelector('.stage').getBoundingClientRect()
  return { stacked: stage.bottom <= panel.top + 2,
           pageScrolls: getComputedStyle(document.querySelector('.panel')).overflowY } })()`)
check('the stage sits above the panel below 900px', mobile.stacked)
// Deliberately asserting the design rather than the original gate's premise:
// below the breakpoint the document scrolls as one, by design.
check('the panel does not scroll independently below 900px', mobile.pageScrolls === 'visible', mobile.pageScrolls)

// 6. The route list is a complete text substitute for the map.
const substitute = await cdp.evaluate(`(() => {
  const rows = [...document.querySelectorAll('button.route')]
  return { rows: rows.length,
           allNamed: rows.every(r => (r.textContent || '').trim().length > 20),
           liveRegions: document.querySelectorAll('[role="status"][aria-live="polite"]').length } })()`)
check('every route row carries its own text', substitute.rows > 0 && substitute.allNamed, `${substitute.rows} rows`)
check('there is exactly one polite live region', substitute.liveRegions === 1, `${substitute.liveRegions}`)

// 7. FOLLOW MODE — the screen nothing automated had ever entered.
//
// Until this section existed, follow mode was the only user-facing screen in
// the app with no coverage of any kind: `gate.mjs` reached it through neither
// of its two entry points (it is not a `<details>` and carries no
// `aria-expanded`), and the 16 vitest files render no components at all. So
// `.follow` had never been through axe and never been through the 44x44 sweep,
// and the sheet had been overflowing its own container on every phone in
// portrait since it was written.
//
// Measured at e6ed697, before the fix, in this browser: the sheet's bottom edge
// lands 13.36px past `.stage` at 390x844 (iPhone SE +23.98, 13 mini +15.28,
// Pixel 7 +9.11, iPad portrait +2.56), and `.panel`'s padding below 420px is
// var(--s3) = 12px, not the 16px it is above that width — so the spill clears
// the padding and overlaps the first `.seg` by 1.36px. The map above the sheet
// gets a 64px strip on every viewport, because `padding-top` 12 + exit 44 +
// gap 8 are all fixed pixels and none of them scale.
//
// `.follow` and `.sheet` are deliberately NOT in the top-level MANIFEST. The
// rule stated at the head of this file is that a selector matching zero
// elements is a failure rather than a skip, and those two match zero elements
// on every load that has not entered follow mode — putting them up there would
// fail every normal pass.
const FOLLOW_MANIFEST = [
  ['.follow', 'FollowMode.jsx — the overlay'],
  ['.sheet', 'FollowMode.jsx — the instruction sheet'],
]

// The button is in `.detail__actions`, deep inside `.panel` and below a stage
// more than a viewport tall on a phone, so it has to be scrolled to before it
// can be clicked. `scrollIntoView` first is not cosmetic: it is how a thumb
// reaches it, and clicking from scrollY 0 would measure a state no user is in.
async function enterFollow() {
  const clicked = await cdp.evaluate(`(() => {
    const b = [...document.querySelectorAll('button')]
      .find(x => /start this route/i.test(x.textContent || ''))
    if (!b) return 'absent'
    if (b.disabled) return 'disabled'
    b.scrollIntoView({ block: 'center' })
    b.click()
    return 'clicked' })()`)
  for (let i = 0; i < 40; i += 1) {
    if (await cdp.evaluate(`!!document.querySelector('.follow')`)) return clicked
    await new Promise((r) => setTimeout(r, 100))
  }
  return clicked
}

await load(390, 844, true)
const entered = await enterFollow()
const followCounts = await cdp.evaluate(
  `(${JSON.stringify(FOLLOW_MANIFEST.map((m) => m[0]))}).map(s => document.querySelectorAll(s).length)`,
)
let followOk = true
FOLLOW_MANIFEST.forEach(([selector, owner], i) => {
  if (!check(`[follow] ${selector} matches something (${owner})`, followCounts[i] > 0, `${followCounts[i]} found, entry: ${entered}`)) {
    followOk = false
  }
})

if (followOk) {
  // The overflow that put this section here. Asserted against `.follow`'s
  // content box rather than the stage's border box so the check keeps meaning
  // the same thing after the overlay becomes `position: fixed` below 900px:
  // in both layouts the question is whether the sheet fits the layer that owns
  // it. `.follow` staying inside the viewport is the second half of that — a
  // fixed layer taller than the screen is the same defect one level up.
  const geom = await cdp.evaluate(`(() => {
    const follow = document.querySelector('.follow')
    const sheet = document.querySelector('.sheet')
    const cs = getComputedStyle(follow)
    const fb = follow.getBoundingClientRect(), sb = sheet.getBoundingClientRect()
    const contentBottom = fb.bottom - parseFloat(cs.paddingBottom)
    return {
      spill: +(sb.bottom - contentBottom).toFixed(2),
      belowViewport: +(fb.bottom - innerHeight).toFixed(2),
      strip: +(sb.top - fb.top).toFixed(2),
      // scrollHeight past clientHeight means flex-shrink squeezed the sheet
      // below its own text, which an explicit min-height permits because it
      // overrides the min-height:auto that would otherwise floor it.
      clipped: sheet.scrollHeight > sheet.clientHeight + 1,
      clip: sheet.scrollHeight + ' content vs ' + sheet.clientHeight + ' box' } })()`)
  check(
    '[follow] the sheet fits inside the follow layer',
    geom.spill <= 1 && geom.belowViewport <= 1,
    `sheet overhangs by ${geom.spill}px, layer past viewport by ${geom.belowViewport}px, map strip ${geom.strip}px`,
  )
  check('[follow] the sheet is not squeezed below its own content', !geom.clipped, geom.clip)

  const followOverflow = await cdp.evaluate(`(() => {
    const doc = document.documentElement
    const wide = [...document.querySelectorAll('*')]
      .filter(el => el.getBoundingClientRect().right > doc.clientWidth + 1)
      .slice(0, 5).map(el => el.className || el.tagName)
    return { scrollW: doc.scrollWidth, clientW: doc.clientWidth, wide } })()`)
  check(
    '[follow] no horizontal scroll at 390px',
    followOverflow.scrollW <= followOverflow.clientW + 1,
    `${followOverflow.scrollW} vs ${followOverflow.clientW}${followOverflow.wide.length ? ` — ${followOverflow.wide.join(', ')}` : ''}`,
  )

  for (const theme of ['light', 'dark']) {
    await setTheme(theme)
    const small = await sweep()
    check(`[follow][${theme}] every target clears 44x44`, small.length === 0, small.slice(0, 6).join('; '))
    await cdp.evaluate(axeSource)
    const violations = await cdp.evaluate(`(async () => {
      const r = await axe.run(document, { runOnly: { type: 'tag', values: ['wcag2a','wcag2aa'] } })
      return r.violations.map(v => \`\${v.id} (\${v.nodes.length})\`) })()`)
    check(`[follow][${theme}] axe reports no wcag2a/2aa violations`, violations.length === 0, violations.join('; '))
  }

  // Counted in this pass too, deliberately. The check in section 6 cannot see a
  // live region rendered inside FollowMode, because the gate never got here —
  // so "exactly one" was only ever an assertion about the screens it visited.
  // DESIGN-HANDOFF §6.7 asks for one voice; this is where that is now checked.
  const followLive = await cdp.evaluate(
    `document.querySelectorAll('[role="status"][aria-live="polite"]').length`,
  )
  check('[follow] there is still exactly one polite live region', followLive === 1, `${followLive}`)
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
