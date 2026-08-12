import { readFileSync, readdirSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

// A source scan, in the same spirit as `sw-contract.test.js` and
// `units-callsites.test.js`.
//
// It exists because nothing in this repo renders a component. There are 16 test
// files and no jsdom, no testing-library and no browser-mode vitest, so the
// follow-mode DOM is exercised only by the gate's follow pass in a real
// Chrome — which runs at one viewport, in CI, and cannot run at all on a
// machine with no browser. Everything below is a property of the source that
// can be checked anywhere, and each one is a defect this pass actually fixed.

const SRC = fileURLToPath(new URL('..', import.meta.url))
const read = (rel) => readFileSync(`${SRC}${rel}`, 'utf8')

function walk(dir = '', out = []) {
  for (const entry of readdirSync(`${SRC}${dir}`)) {
    const rel = dir ? `${dir}/${entry}` : entry
    if (statSync(`${SRC}${rel}`).isDirectory()) walk(rel, out)
    else if (/\.jsx?$/.test(entry) && !/\.test\.jsx?$/.test(entry)) out.push(rel)
  }
  return out
}

describe('the banner names the turn ahead', () => {
  it('derives the next step from stepIndex + 1', () => {
    // GraphHopper names a manoeuvre at the START of the interval it belongs to,
    // so the step CONTAINING the walker is the turn already taken. That is what
    // used to be rendered at 17px above "{distance} to the next turn" at 28px,
    // while `steps[stepIndex + 1]` was never rendered at all.
    expect(read('lib/followTracking.js')).toMatch(/steps\?\.\[stepIndex \+ 1\]/)
  })

  it('reads Step.sign, which nothing in the frontend ever had', () => {
    // `sign` is parsed at routing.py:441, carried at main.py:722 and declared at
    // models.py:159, and before this pass `grep -rn '\.sign\b' frontend/src`
    // returned zero lines. A turn banner without a glyph is a sentence.
    const readers = walk().filter((rel) => /\bsign\b/.test(read(rel)))
    expect(readers).toContain('components/FollowMode.jsx')
    expect(readers).toContain('components/ManoeuvreIcon.jsx')
  })

  it('draws every sign GraphHopper can send', () => {
    // An unmapped sign is a missing glyph beside a real instruction. The set is
    // fixed and small, so it is asserted rather than trusted.
    const src = read('components/ManoeuvreIcon.jsx')
    for (const sign of ['-7', '-3', '-2', '-1', '0', '1', '2', '3', '4', '5', '6', '7']) {
      expect(src, `sign ${sign} is not drawn`).toMatch(new RegExp(`'?${sign}'?:`))
    }
  })

  it('keeps the glyphs as inline SVG rather than files', () => {
    // A PNG in public/ is stat-ed and pinned by icons.test.js, whose maskable
    // assertions are about a launcher icon and have no business governing a
    // turn arrow; an external asset would also need a CSP change in
    // public/_headers, whose sha256 csp-hash.test.js pins byte for byte.
    const src = read('components/ManoeuvreIcon.jsx')
    expect(src).toMatch(/<svg/)
    expect(src).not.toMatch(/<img|url\(|\.png|\.svg['"]/)
    // currentColor, so the glyph inherits whatever the text beside it is and
    // check_palette.sh has nothing to find.
    expect(src).toMatch(/currentColor/)
  })
})

describe('there is exactly one place that watches the position', () => {
  it('starts no geolocation watch outside followTracking.js', () => {
    // Two watches would be two batteries, two answers and two sets of state
    // for the sheet and the map to disagree about. The lift into App exists so
    // there is one.
    const watchers = walk().filter((rel) => /watchPosition/.test(read(rel)))
    expect(watchers).toEqual(['lib/followTracking.js'])
  })

  it('makes no request from the follow feature', () => {
    // The privacy claim is that no request anywhere in this feature carries the
    // live position, and it is stated in the UI at the moment tracking starts.
    // This is the mechanised half of it.
    for (const rel of ['lib/followTracking.js', 'lib/follow.js', 'components/FollowMode.jsx']) {
      const src = read(rel)
      expect(src, `${rel} fetches`).not.toMatch(/\bfetch\(|XMLHttpRequest|navigator\.sendBeacon/)
    }
  })

  it('rejects a fix worse than the stated accuracy before it is used', () => {
    // A 2 km cell-tower fix used to advance the anchor, start the off-route
    // clock and fire the barrier vibration, with nothing able to reject it.
    const src = read('lib/followTracking.js')
    expect(src).toMatch(/ACCURACY_LIMIT_M = 75/)
    expect(src).toMatch(/accuracyM > ACCURACY_LIMIT_M/)
  })
})

describe('the sheet is sized by its content', () => {
  const css = read('styles.css')
  const stripped = css.replace(/\/\*[\s\S]*?\*\//g, '')

  it('puts no min-height on the sheet', () => {
    // `min-height: 30vh` failed in both directions: 12 + 44 + 8 + 30vh exceeds
    // the old 36vh band for every viewport height between 553px and 1067px, so
    // the sheet hung past the stage on every phone in portrait; and an explicit
    // min-height overrides `min-height: auto`, so flex-shrink could squeeze it
    // below its own text and clip the remainder with no way to reach it.
    const body = /\.sheet\s*\{([^}]*)\}/.exec(stripped)?.[1] ?? ''
    // Zero is the one permitted value, and it is not a floor: it is what lets
    // flex shrink the sheet at all, which is the other half of the fix.
    expect(/min-height:\s*([^;]+);/.exec(body)?.[1]?.trim()).toBe('0')
    expect(body).toMatch(/max-height:/)
    expect(body).toMatch(/overflow-y:\s*auto/)
  })

  it('declares the full-screen rules after .follow, not in the responsive block', () => {
    // The trap written out at the safe-area comment: `.follow` is declared after
    // the responsive block, so a `@media (max-width: 899px) { .follow { … } }`
    // placed up there loses on source order — equal specificity, later source
    // wins, media queries contribute nothing. It fails silently and looks fine
    // on every desktop.
    expect(stripped.indexOf('.stage--following')).toBeGreaterThan(stripped.indexOf('.follow {'))
    expect(stripped.indexOf('.stage--following')).toBeGreaterThan(stripped.indexOf('.sheet {'))
  })

  it('sizes the follow layer in dvh rather than vh', () => {
    // iOS measures `vh` with the URL bar retracted, so a plain-vh layer is about
    // 60px taller than the screen exactly while the bar is showing. `.app` has
    // used dvh since the safe-area work; these had been left behind.
    const follow = stripped.slice(stripped.indexOf('.stage--following'))
    expect(follow.slice(0, follow.indexOf('@media print'))).not.toMatch(/:\s*\d+vh\b/)
  })
})

describe('the breakpoint is written once', () => {
  it('shares one constant between the stylesheet and the modal decision', () => {
    // A literal 899 typed a second time in a component is how a layer becomes
    // modal on one side of a breakpoint while the layout stays two-column on
    // the other, which is a state with no way out.
    expect(read('lib/media.js')).toMatch(/MOBILE_LAYOUT = '\(max-width: 899px\)'/)
    const app = read('App.jsx')
    expect(app).toMatch(/useMatchMedia\(MOBILE_LAYOUT\)/)
    expect(app).not.toMatch(/max-width:\s*899px/)
  })
})
