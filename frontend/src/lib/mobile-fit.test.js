import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

// The two halves of "this app fits the device it is on": no control may make
// iOS zoom the page sideways, and a computer is told the app is built for a
// phone. Source scans, in the same spirit as `follow-contract.test.js` —
// nothing in this repo renders a component, so the properties are asserted
// against the source that has to hold them.

const SRC = fileURLToPath(new URL('..', import.meta.url))
const read = (rel) => readFileSync(`${SRC}${rel}`, 'utf8')

describe('no focused control may zoom the page on iOS', () => {
  // iOS Safari zooms the page when a focused text control renders under 16px,
  // and the zoom stays after the keyboard goes: from then on the layout
  // viewport is wider than the glass and everything on the right edge — the
  // layer stack, Re-centre, the End pill — hangs half off the screen for the
  // rest of the session. The overflow gate cannot see it, because nothing
  // overflows the document; the document itself is wider than the view. So
  // the floor is asserted at the source.
  const css = read('styles.css').replace(/\/\*[\s\S]*?\*\//g, '')

  const sizeIn = (body) => {
    const m = /font-size:\s*([\d.]+)px/.exec(body)
    return m ? parseFloat(m[1]) : null
  }

  it('floors the bare controls at 16px', () => {
    const base = /input,\s*select,\s*textarea\s*\{([^}]*)\}/.exec(css)?.[1] ?? ''
    expect(base).toMatch(/font-size:\s*max\(1em,\s*16px\)/)
  })

  it('keeps the place input at 16px or more', () => {
    const body = /\.place__input\s*\{([^}]*)\}/.exec(css)?.[1] ?? ''
    expect(sizeIn(body)).toBeGreaterThanOrEqual(16)
  })

  it('keeps the report select and textarea at 16px or more', () => {
    const body = /\.report__select,\s*\.report__text\s*\{([^}]*)\}/.exec(css)?.[1] ?? ''
    expect(sizeIn(body)).toBeGreaterThanOrEqual(16)
  })
})

describe('a computer is told this is a phone app', () => {
  it('App shows the notice only for the desktop layout with a fine pointer', () => {
    // Width alone would lecture an iPad in landscape; pointer alone would put
    // a scrim over the CI gate, which drives a desktop-class browser at phone
    // widths. Both conditions, and dismissal is state, not storage —
    // localStorage stays theme and units only.
    const app = read('App.jsx')
    expect(app).toMatch(/\(hover: hover\) and \(pointer: fine\)/)
    expect(app).toMatch(/!isMobile && finePointer && !deskNoticeSeen/)
    expect(app).not.toMatch(/localStorage[^\n]*desknote/i)
  })

  it('the notice is a real dialog with a way out', () => {
    const src = read('components/DesktopNotice.jsx')
    expect(src).toMatch(/role="alertdialog"/)
    expect(src).toMatch(/aria-labelledby/)
    expect(src).toMatch(/aria-describedby/)
    expect(src).toMatch(/Escape/)
    expect(src).toMatch(/best used on a smartphone/)
  })
})
