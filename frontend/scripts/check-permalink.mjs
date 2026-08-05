/**
 * The permalink contract: a shared link reproduces the same request.
 *
 *     npm run check:permalink
 *
 * Round-trip, hostile input, and — the one that actually matters — that the
 * decoded state produces a byte-identical API request body to the state that
 * encoded it. A link that returns a *different* answer than the sender was
 * looking at is worse than no link.
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))

// The modules are plain ESM with no JSX, so they import directly under node.
const { encodeState, decodeState, shareUrl } = await import(
  join(here, '..', 'src', 'lib', 'permalink.js')
)

// buildRouteRequest lives beside an import.meta.env reference, so read the one
// function out rather than importing the module and needing a bundler.
const clientSource = readFileSync(join(here, '..', 'src', 'api', 'client.js'), 'utf8')
const fnSource = clientSource.slice(
  clientSource.indexOf('export function buildRouteRequest'),
  clientSource.indexOf('export class ApiError'),
)
const buildRouteRequest = new Function(`${fnSource.replace('export function', 'return function')}`)()

globalThis.window = {
  location: { search: '', pathname: '/', origin: 'https://meander.example' },
  history: { replaceState() {} },
}

let failures = 0
function check(name, fn) {
  try {
    fn()
    console.log(`  PASS  ${name}`)
  } catch (err) {
    failures += 1
    console.log(`  FAIL  ${name}\n        ${err.message.split('\n')[0]}`)
  }
}

const FULL = {
  origin: { lat: 6.933727, lon: 79.85008, name: 'Colombo Fort' },
  dest: { lat: 51.507489, lon: -0.162207, name: 'Hyde Park' },
  minutes: 65,
  mode: 'bike',
  objectives: ['nature', 'accessible'],
}

check('round trip preserves every field', () => {
  const back = decodeState(encodeState(FULL))
  assert.equal(back.origin.name, 'Colombo Fort')
  assert.equal(back.dest.name, 'Hyde Park')
  assert.equal(back.minutes, 65)
  assert.equal(back.mode, 'bike')
  assert.deepEqual(back.objectives, ['nature', 'accessible'])
})

check('THE CONTRACT: the same request body comes out the other side', () => {
  const before = buildRouteRequest(FULL)
  const after = buildRouteRequest({ ...FULL, ...decodeState(encodeState(FULL)) })
  assert.deepEqual(after, before)
})

check('coordinates survive to routing precision', () => {
  const back = decodeState(encodeState(FULL))
  assert.ok(Math.abs(back.origin.lat - FULL.origin.lat) < 1e-5)
  assert.ok(Math.abs(back.origin.lon - FULL.origin.lon) < 1e-5)
})

check('a round trip has no destination rather than a null one', () => {
  const loop = { ...FULL, dest: null }
  const back = decodeState(encodeState(loop))
  assert.equal(back.dest, undefined)
  assert.equal('destination' in buildRouteRequest({ ...loop, ...back }), false)
})

check('no origin means no link at all', () => {
  assert.equal(encodeState({ ...FULL, origin: null }), '')
  assert.equal(shareUrl({ ...FULL, origin: null }), '')
})

check('"Your location" is not put in a shared link', () => {
  const q = encodeState({ ...FULL, origin: { ...FULL.origin, name: 'Your location' } })
  assert.ok(!q.includes('fromName'))
})

// --- hostile input: somebody else wrote this link -------------------------

check('a garbage coordinate is rejected outright', () => {
  assert.equal(decodeState('?from=notacoord'), null)
  assert.equal(decodeState('?from=999,999'), null)
  assert.equal(decodeState('?from=51.5'), null)
})

check('minutes is clamped to the range the dial can show', () => {
  assert.equal(decodeState('?from=51.5,-0.16&min=99999').minutes, undefined)
  assert.equal(decodeState('?from=51.5,-0.16&min=-5').minutes, undefined)
  assert.equal(decodeState('?from=51.5,-0.16&min=63').minutes, 65) // snapped to the 5-min step
})

check('an unknown mode or objective is dropped, not passed through', () => {
  assert.equal(decodeState('?from=51.5,-0.16&mode=teleport').mode, undefined)
  assert.equal(decodeState('?from=51.5,-0.16&obj=nature,rm -rf,air').objectives.join(),
    'nature,air')
})

check('objectives are deduplicated and capped at three', () => {
  const back = decodeState('?from=51.5,-0.16&obj=nature,nature,air,shade,quiet,fastest')
  assert.equal(back.objectives.length, 3)
  assert.equal(new Set(back.objectives).size, 3)
})

check('a hostile name cannot be unbounded', () => {
  const back = decodeState(`?from=51.5,-0.16&fromName=${'x'.repeat(5000)}`)
  assert.ok(back.origin.name.length <= 120)
})

check('a missing name degrades to the coordinates', () => {
  assert.match(decodeState('?from=51.50749,-0.16221').origin.name, /51\.5/)
})

console.log(failures ? `\n${failures} permalink check(s) failed` : '\nPermalink contract holds.')
process.exit(failures ? 1 : 0)
