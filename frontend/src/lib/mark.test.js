import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

import { MARK_BOX, MARK_PATH_D, MARK_STROKE, markPoints, markStroke } from './mark.js'

// The mark is drawn by three renderers that cannot share one: the launcher
// icons are written pixel by pixel in scripts/make-icons.mjs, the favicon is an
// SVG that script emits, and the in-page lockup is an inline SVG in
// Wordmark.jsx. Three copies of one curve is how a favicon and a wordmark come
// to disagree, with nothing to catch it.

const SRC = new URL('..', import.meta.url)
const read = (rel) => readFileSync(new URL(rel, SRC), 'utf8')

/**
 * Source with `/* *\/` and `//` comments blanked, in the same spirit as
 * `styles.safe-area.test.js`: every structural assertion below runs against
 * this rather than the raw file, so prose can never satisfy — or break — a
 * check about code. Two of the checks below tripped on their own explanatory
 * comment before this existed, which is the point exactly.
 */
const code = (rel) =>
  read(rel)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')

/** The approved geometry, quoted from the design rather than derived. */
const APPROVED_D = 'M8 32 C14 14 20 14 24 24 C28 34 34 34 40 16'

describe('one shape, one definition', () => {
  it('publishes the approved path and weight, character for character', () => {
    // mark.js emits the path from an array of control points rather than
    // storing the string, so that the `d` the SVG renderers ship and the points
    // the pixel renderer walks cannot be edited apart from each other. That
    // only helps if the emission is pinned to what design actually approved.
    expect(MARK_PATH_D).toBe(APPROVED_D)
    // The design states the weight as literally as it states the curve, and
    // every consumer scales from this one constant — so a change to it moves
    // the lockup and all five icons together, and nothing downstream notices.
    // The number is held here or it is held nowhere.
    expect(MARK_STROKE).toBe(5.5)
  })

  it('is the only place the curve is defined', () => {
    // If a renderer grows its own copy of the geometry, this fails. Both
    // consumers are checked, because the wordmark is the one that left with
    // the 2026 redesign and came back — and it came back to a module that only
    // has one definition in it because nothing was allowed to restate it.
    const icons = read('../scripts/make-icons.mjs')
    expect(icons).toMatch(/import \{[^}]*\bmarkPoints\b[^}]*\} from '\.\.\/src\/lib\/mark\.js'/)
    expect(icons).toMatch(/import \{[^}]*\bMARK_PATH_D\b[^}]*\} from '\.\.\/src\/lib\/mark\.js'/)
    expect(icons).not.toMatch(/Math\.sin/)

    const wordmark = code('components/Wordmark.jsx')
    expect(wordmark).toMatch(/import \{[^}]*\bMARK_PATH_D\b[^}]*\} from '\.\.\/lib\/mark\.js'/)
    // Importing it is not using it. The check has to be that the rendered
    // <path> takes its `d` from the module — an import can sit there unused
    // while the element draws something else entirely, which is drift with the
    // paperwork in order. Found by mutation: `d="M8 32 H40"`, a straight line
    // where the meander should be, passed an earlier version of this file and
    // the whole suite with it.
    expect(wordmark.replace(/\s+/g, ' ')).toMatch(/<path d=\{MARK_PATH_D\}/)
    // And no literal path data anywhere in the file, in any command set. The
    // flat statement of the rule, rather than a guess at which letters a
    // hand-written path might happen to use.
    expect(wordmark).not.toMatch(/\bd="/)
  })

  it('carries no colour, so it can be imported from a build script', () => {
    // scripts/tokens.mjs reads the palette at build time and says in its own
    // header that nothing under src/ may import it, because it must never enter
    // the bundle. This module is the other direction, and it is only safe
    // because there is nothing in it but numbers.
    const src = code('lib/mark.js')
    expect(src).not.toMatch(/#[0-9a-fA-F]{3,8}\b/)
    expect(src).not.toMatch(/tokens\.mjs|var\(--/)
  })

  it('keeps the whole stroked mark inside the frame', () => {
    // Ink outside the box would be clipped by the icon's rounded tile and
    // cropped by the SVG viewBox, differently in each. The bound includes the
    // stroke rather than only the centreline, because a round cap sitting on
    // the edge is half outside it. Measured: the stroked extent is
    // x [5.25, 42.75], y [13.25, 34.75] in a 48 box.
    const half = MARK_STROKE / 2
    for (const [x, y] of markPoints()) {
      expect(x).toBeGreaterThanOrEqual(half)
      expect(x).toBeLessThanOrEqual(MARK_BOX - half)
      expect(y).toBeGreaterThanOrEqual(half)
      expect(y).toBeLessThanOrEqual(MARK_BOX - half)
    }
  })

  it('samples the polyline off the same curve the path publishes', () => {
    // The claim the whole module rests on: markPoints() is the approved
    // Béziers evaluated, not a hand-fitted lookalike. So this test parses the
    // published `d` and evaluates it independently, then asks whether the two
    // agree — rather than trusting that they came from one array.
    const numbers = MARK_PATH_D.match(/-?\d+(?:\.\d+)?/g).map(Number)
    expect(numbers).toHaveLength(14) // M x y, then two C runs of six
    const start = numbers.slice(0, 2)
    const curves = [numbers.slice(2, 8), numbers.slice(8, 14)].reduce(
      ({ from, out }, [c1x, c1y, c2x, c2y, x, y]) => ({
        from: [x, y],
        out: [...out, [from, [c1x, c1y], [c2x, c2y], [x, y]]],
      }),
      { from: start, out: [] },
    ).out

    const at = (p0, p1, p2, p3, t) => {
      const u = 1 - t
      return u * u * u * p0 + 3 * u * u * t * p1 + 3 * u * t * t * p2 + t * t * t * p3
    }

    const perCurve = 24
    const points = markPoints(perCurve)
    expect(points).toHaveLength(curves.length * perCurve + 1)
    expect(points[0]).toEqual(start)

    points.forEach(([x, y], i) => {
      if (i === 0) return
      const [p0, c1, c2, p3] = curves[Math.floor((i - 1) / perCurve)]
      const t = (((i - 1) % perCurve) + 1) / perCurve
      expect(x).toBeCloseTo(at(p0[0], c1[0], c2[0], p3[0], t), 10)
      expect(y).toBeCloseTo(at(p0[1], c1[1], c2[1], p3[1], t), 10)
    })
  })

  it('flattens closely enough that no renderer can show the difference', () => {
    // 24 segments per curve is a number, and a number is worth checking rather
    // than believing. The largest render this project ships is a 512px tile
    // with the mark box at 55% of it, so one box unit is 5.87 device pixels;
    // the deviation below is a tenth of one of those.
    const dense = markPoints(4000)
    let worst = 0
    for (const [x, y] of dense) {
      let nearest = Infinity
      const coarse = markPoints()
      for (let i = 1; i < coarse.length; i += 1) {
        const [ax, ay] = coarse[i - 1]
        const [bx, by] = coarse[i]
        const dx = bx - ax
        const dy = by - ay
        const lengthSq = dx * dx + dy * dy
        const t = lengthSq === 0 ? 0 : Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / lengthSq))
        nearest = Math.min(nearest, Math.hypot(x - (ax + t * dx), y - (ay + t * dy)))
      }
      worst = Math.max(worst, nearest)
    }
    expect(worst).toBeLessThan(0.02)
  })

  it('thickens the line only where the design says it may', () => {
    // The approved weight is 5.5, with 6 to 7 permitted at or below a 24px
    // box. A bump that leaked into the lockup would be a different logo.
    expect(markStroke(26)).toBe(MARK_STROKE)
    expect(markStroke(48)).toBe(MARK_STROKE)
    expect(markStroke(24)).toBeGreaterThanOrEqual(6)
    expect(markStroke(24)).toBeLessThanOrEqual(7)
    expect(markStroke(16)).toBe(markStroke(24))
  })
})

describe('nothing resets by reloading', () => {
  it('never reloads the page', () => {
    // The wordmark is back, and the reducer case that once went with it is
    // not. Before the 2026 redesign the mark was pressable and starting over
    // meant a reload; the rule that killed it outlives both. A reload re-reads
    // the current URL, so a permalinked page would boot straight back into the
    // search it was asked to clear; it discards an offline-saved route; and it
    // costs a network round trip in exactly the situation the app is built to
    // survive without one.
    expect(code('App.jsx')).not.toMatch(/location\.reload/)
    expect(code('components/Wordmark.jsx')).not.toMatch(/location\.reload/)
  })

  it('keeps the lockup out of the way of the target-size sweep', () => {
    // scripts/gate.mjs measures `button:not([disabled]), a[href], input,
    // select, [role="option"]` against 44x44 on four screens in two themes. A
    // 26px mark inside a button fails it eight times. It was a button once.
    const wordmark = code('components/Wordmark.jsx')
    expect(wordmark).not.toMatch(/<button|<a\b|onClick|role="button"/)
  })
})
