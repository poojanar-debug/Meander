import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { buildRoutes } from '../api/mock.js'
import ObjectiveChips from '../components/ObjectiveChips.jsx'
import { OBJECTIVES } from './dash.js'

/**
 * The three objectives that shipped as chips before they shipped as routes.
 *
 * `quiet`, `shade` and `air` were in the identity table, in the permalink
 * vocabulary and in the reducer from the beginning, and disabled in the one
 * place a user could reach them. Releasing them is mostly deletion, which is
 * exactly the kind of change that leaves one half behind: a chip that presses
 * against a stylesheet with no rule for it, a fourth score nothing labels, a
 * fixture still apologising for a feature that now exists.
 *
 * Two halves, like `destination-contract.test.js`. The mock is real behaviour
 * and is called; the picker is rendered to a string with `react-dom/server`,
 * which needs no DOM and no new dependency, so the one property that matters
 * about it — every chip is operable — is asserted rather than grepped.
 */

const SRC = fileURLToPath(new URL('..', import.meta.url))
const read = (rel) => readFileSync(`${SRC}${rel}`, 'utf8')

const COLOMBO = { lat: 6.9271, lon: 79.8612 }
const RELEASED = ['quiet', 'shade', 'air']
const ALL = OBJECTIVES.map((o) => o.id)

const allSix = () => buildRoutes({ origin: COLOMBO, minutes: 35, objectives: ALL })

describe('the mock routes every objective, not three of them', () => {
  const routes = buildRoutes({ origin: COLOMBO, minutes: 35, objectives: RELEASED })

  it('returns three real routes for the three that used to be placeholders', () => {
    // The old fallback answered these with an empty geometry, a zero distance
    // and "not implemented yet". The mock is the whole of the demo build and
    // the subject of the layout gate, so until this fixture existed the three
    // new chips could be pressed and the app had nothing to draw.
    expect(routes).toHaveLength(3)
    for (const route of routes) {
      expect(route.status, route.id).toBe('ok')
      expect(route.scoring_method, route.id).not.toBe('placeholder')
      expect(route.geometry.length, route.id).toBeGreaterThan(2)
      expect(route.distance_m, route.id).toBeGreaterThan(0)
      expect(route.duration_min, route.id).toBeGreaterThan(0)
      expect(route.status_note ?? '', route.id).not.toMatch(/not implemented/i)
    }
  })

  it('draws six different lines rather than three drawn twice', () => {
    // A copied geometry is invisible in every other assertion here and obvious
    // on the map: two objectives whose lines lie on top of each other read as
    // a picker that does nothing.
    const six = allSix()
    const shapes = new Set(six.map((r) => JSON.stringify(r.geometry)))
    expect(shapes.size).toBe(6)
    expect(new Set(six.map((r) => r.distance_m)).size).toBe(6)
    expect(new Set(six.map((r) => r.duration_min)).size).toBe(6)
  })

  it('carries the fourth score field on every fixture', () => {
    // `Scores` gained `quiet`, and a fixture missing the key renders the same
    // as one that measured nothing — which is a claim the backend did not make.
    for (const route of allSix()) {
      expect(Object.keys(route.scores), route.id).toContain('quiet')
    }
  })

  it('measures quiet on each of the three, and leaves the nulls where they were', () => {
    for (const route of routes) {
      expect(typeof route.scores.quiet, route.id).toBe('number')
    }
    const [accessible] = buildRoutes({ origin: COLOMBO, objectives: ['accessible'] })
    expect(accessible.scores.shade).toBeNull()
    expect(accessible.scores.quiet).toBeNull()
  })

  it('says what an ok route was steered by, which nothing used to render', () => {
    // `status_note` on a non-blocked route reached the frontend and was thrown
    // away for as long as the panel existed. These presets steer on way tags,
    // so the note is the difference between a proxy and a measurement.
    //
    // Structure, not wording. This asserted /inferred from/ until the notes
    // were brought into line with the backend's `PRESET_NOTES`, and a frontend
    // test that pins the backend's prose is a test that has to be rewritten
    // every time the backend improves a sentence. What has to hold is that
    // each of the three says something, and that they do not all say the same
    // thing — a shared note would mean one sentence standing in for three
    // different objectives.
    const noted = routes.filter((r) => r.status === 'ok' && r.status_note)
    expect(noted.map((r) => r.id).sort()).toEqual(['air', 'quiet', 'shade'])
    for (const route of noted) {
      expect(route.status_note.length).toBeGreaterThan(40)
    }
    expect(new Set(noted.map((r) => r.status_note)).size).toBe(3)
  })

  it('keeps accessible as the blocked fixture with its two blockers', () => {
    const [accessible] = buildRoutes({ origin: COLOMBO, objectives: ['accessible'] })
    expect(accessible.status).toBe('blocked')
    expect(accessible.blockers).toHaveLength(2)
  })

  it('answers rest stops three ways across the six', () => {
    // Checked and found some, checked and found none, and not checked at all.
    // The third is a sentence the UI writes and nothing in the mock used to
    // reach; it arrived with `air`.
    const six = allSix()
    expect(six.some((r) => r.rest_stops?.length > 0)).toBe(true)
    expect(six.some((r) => r.rest_stops?.length === 0)).toBe(true)
    expect(six.some((r) => r.rest_stops === null)).toBe(true)
  })

  it('narrates all six', () => {
    // NARRATION is module-private and arrives through the streamed second pass,
    // which costs about four seconds of real timers. The keys are what matters.
    const mock = read('api/mock.js')
    const narration = mock.slice(mock.indexOf('const NARRATION'))
    for (const id of ALL) expect(narration).toMatch(new RegExp(`^\\s{2}${id}:`, 'm'))
  })

  it('still refuses an id that is not an objective, without calling it unfinished', () => {
    const [unknown] = buildRoutes({ origin: COLOMBO, objectives: ['banana'] })
    expect(unknown.status).toBe('blocked')
    expect(unknown.status_note).not.toMatch(/not implemented/i)
    expect(unknown.status_note).toMatch(/no objective called banana/)
    // Nulls, not zeros. Nothing routed this and nothing scored it, and every
    // other surface in the app treats 0 as a measurement that came back empty.
    expect(Object.values(unknown.scores)).toEqual([null, null, null, null])
    expect(unknown.confidence).toBeNull()
  })
})

describe('the picker offers all six as live chips', () => {
  const html = renderToStaticMarkup(
    createElement(ObjectiveChips, { objectives: ['fastest', 'quiet'], onToggle: () => {} }),
  )

  it('renders one operable button per objective', () => {
    // Rendered, not grepped: `disabled` is what this test is about, and the
    // previous component set it from a hard-coded set of three ids. That
    // version fails this line.
    expect(html.match(/<button/g)).toHaveLength(OBJECTIVES.length)
    expect(html).not.toContain('disabled')
    expect(html).not.toMatch(/soon/i)
  })

  it('gives each chip its own accent dot and label', () => {
    for (const objective of OBJECTIVES) {
      expect(html, objective.id).toContain(`chip--${objective.id}`)
      expect(html, objective.id).toContain(`dot--${objective.id}`)
      expect(html, objective.id).toContain(objective.label)
    }
  })

  it('reports pressed state in aria-pressed, not only in the wash', () => {
    // Colour is never the only signal in this app, and a pressed chip is the
    // only record of what the next request will ask for.
    expect(html).toMatch(/chip--fastest is-pressed"[^>]*aria-pressed="true"/)
    expect(html).toMatch(/chip--quiet is-pressed"[^>]*aria-pressed="true"/)
    expect(html).toMatch(/chip--shade"[^>]*aria-pressed="false"/)
  })
})

describe('the detail panel accounts for the fourth score and the preset note', () => {
  const detail = read('components/RouteDetail.jsx')

  it('has a row for every score the wire carries', () => {
    const rows = [...detail.matchAll(/^\s*\['(\w+)', '\w+', '\w+'\],$/gm)].map((m) => m[1])
    expect(rows).toEqual(['scenic', 'air', 'shade', 'quiet'])
  })

  it('renders status_note on an ok route in a class of its own', () => {
    // It was gated on `status !== 'ok'`, so the sentence explaining what a
    // route optimised for was dropped on every route that had one. Sharing the
    // blocked note's rose skin would have been worse than dropping it: it
    // reads as a refusal.
    expect(detail).toMatch(/route\.status === 'ok' \? 'detail__basis-note' : 'detail__blocked-note'/)
    const css = read('styles.css')
    expect(css).toMatch(/\.detail__basis-note \{/)
    expect(css).toMatch(/\.detail__blocked-note \{\n\s+margin: 14px auto 0;/)
  })
})
