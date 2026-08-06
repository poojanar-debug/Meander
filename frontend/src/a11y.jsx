/**
 * Accessibility audit harness. Development only — see a11y.html.
 *
 * Mounts the real app, drives it far enough to render routes, then runs
 * axe-core against WCAG 2.0/2.1 A and AA. Results land on
 * `window.__axeResults` so a browser automation step can read them.
 *
 * Auditing an empty page proves nothing, so this waits for actual route cards
 * before running.
 */

import axe from 'axe-core'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'

import App from './App.jsx'
import './styles.css'
import 'maplibre-gl/dist/maplibre-gl.css'

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <App />
  </StrictMode>,
)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function setOrigin() {
  const input = document.querySelector('input[role="combobox"]')
  if (!input) return false
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
  setter.call(input, 'Colombo Fort')
  input.dispatchEvent(new Event('input', { bubbles: true }))

  for (let i = 0; i < 40; i += 1) {
    await sleep(150)
    if (document.querySelector('[role="option"]')) break
  }
  input.focus()
  input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))
  await sleep(60)
  input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
  return true
}

// `.card` is the pre-redesign row, `.route` the rail row that replaces it in
// phase 4. Matching both means this harness keeps working across the change
// rather than silently auditing an empty page — which would pass.
const ROW_SELECTOR = '.route, .card'

async function waitForRoutes() {
  for (let i = 0; i < 120; i += 1) {
    await sleep(250)
    if (document.querySelectorAll(ROW_SELECTOR).length >= 3) return true
  }
  return false
}

async function run() {
  window.__axeStatus = 'starting'
  await sleep(600)
  await setOrigin()
  const ready = await waitForRoutes()
  // The map canvas is third-party and irrelevant to the audit; letting it
  // settle first avoids racing its DOM insertions.
  await sleep(1200)

  const summarise = (list) =>
    list.map((v) => ({
      id: v.id,
      impact: v.impact,
      help: v.help,
      tags: v.tags.filter((t) => t.startsWith('wcag') || t === 'best-practice'),
      nodes: v.nodes.slice(0, 4).map((n) => ({
        target: n.target.join(' '),
        summary: (n.failureSummary || '').split('\n').slice(0, 3).join(' | '),
      })),
    }))

  const WCAG = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']
  const conformance = await axe.run(document, { runOnly: { type: 'tag', values: WCAG } })
  // Best-practice rules are not WCAG failures, but landmark and region issues
  // in that set are real for screen-reader users, so they are reported too.
  const everything = await axe.run(document, {
    runOnly: { type: 'tag', values: [...WCAG, 'best-practice'] },
  })

  window.__axeResults = {
    routesRendered: ready,
    rows: document.querySelectorAll(ROW_SELECTOR).length,
    rulesPassed: everything.passes.length,
    violations: summarise(conformance.violations),
    bestPracticeViolations: summarise(
      everything.violations.filter((v) => !v.tags.some((t) => t.startsWith('wcag'))),
    ),
    incomplete: everything.incomplete.map((v) => ({ id: v.id, help: v.help, count: v.nodes.length })),
  }
  window.__axeStatus = 'done'
  // eslint-disable-next-line no-console
  console.log('axe violations:', window.__axeResults.violations.length)
}

run()
