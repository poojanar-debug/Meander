import { readFileSync, readdirSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

// A source scan, in the same spirit as the awk gate over styles.css.
//
// It exists because there is no ESLint anywhere in this repo, and because
// `units` is a defaulted parameter: a call site nobody threaded keeps
// compiling, keeps rendering, and keeps saying "1.4 km" to a user who asked for
// miles. Nothing else in the build can see that. There are 24 such sites, and
// two of them — the barrier-proximity alert and the elevation axis — are
// hand-formatted, so a grep for fmtDist alone would miss them.

const SRC = fileURLToPath(new URL('..', import.meta.url))
const read = (rel) => readFileSync(`${SRC}${rel}`, 'utf8')

const DISTANCE_FILES = [
  'components/RouteRow.jsx',
  'components/RouteDetail.jsx',
  'components/StepList.jsx',
  'components/FollowMode.jsx',
  'components/ElevationProfile.jsx',
  'components/ReportBarrier.jsx',
  'lib/format.js',
]

const CLOCK_FILES = ['components/DepartureStrip.jsx', 'lib/sun.js']

/** Every `.js`/`.jsx` under src/, relative to src/. */
function walk(dir = '', out = []) {
  for (const entry of readdirSync(`${SRC}${dir}`)) {
    const rel = dir ? `${dir}/${entry}` : entry
    if (statSync(`${SRC}${rel}`).isDirectory()) walk(rel, out)
    else if (/\.jsx?$/.test(entry)) out.push(rel)
  }
  return out
}

describe('every distance call site is threaded', () => {
  it.each(DISTANCE_FILES)('%s calls fmtDist with units', (rel) => {
    // A single argument means the default METRIC_24 applies. The definition
    // `fmtDist(metres, units = METRIC_24)` has a comma, so it does not match.
    const bare = [...read(rel).matchAll(/\bfmtDist\(\s*[^,)]+\)/g)].map((m) => m[0])
    expect(bare, `${rel} has un-threaded fmtDist calls`).toEqual([])
  })

  it.each(['components/ElevationProfile.jsx'])('%s calls formatElevation with units', (rel) => {
    const bare = [...read(rel).matchAll(/\bformatElevation\(\s*[^,)]+\)/g)].map((m) => m[0])
    expect(bare, `${rel} has un-threaded formatElevation calls`).toEqual([])
  })
})

describe('every clock call site is threaded', () => {
  it.each(CLOCK_FILES)('%s calls fmtClock with units', (rel) => {
    const bare = [...read(rel).matchAll(/\bfmtClock\(\s*[^,)]+\)/g)].map((m) => m[0])
    expect(bare, `${rel} has un-threaded fmtClock calls`).toEqual([])
  })

  it('does not hard-code hour12 in sun.js', () => {
    // The shape must come from units.clock, not from a literal.
    expect(read('lib/sun.js')).not.toMatch(/hour12:\s*(true|false)/)
  })
})

describe('nothing hand-formats a distance', () => {
  // FollowMode's barrier alert used to read `{Math.round(closest.distanceM)} m
  // ahead`. It is the most safety-relevant number in the app and it never went
  // through a formatter, so it would have kept saying "180 m ahead" to a user
  // who chose miles — while every number around it changed.
  it.each([...DISTANCE_FILES, 'components/DepartureStrip.jsx'])(
    '%s renders no bare metres',
    (rel) => {
      const src = read(rel)
      expect(src, `${rel} interpolates a bare "m"`).not.toMatch(/\}\s*m\s+ahead/)
      expect(src, `${rel} rounds metres by hand`).not.toMatch(/Math\.round\([^)]*\)\}\s*m\b/)
    },
  )
})

describe('durations are never converted', () => {
  it('keeps a one-argument signature on every duration formatter', () => {
    // Minutes and hours are identical in both systems. A "helpful" implementer
    // threading units through these would be adding a bug, not fixing one.
    const src = read('lib/format.js')
    expect(src).toMatch(/export function fmtDur\(minutes\)/)
    expect(src).toMatch(/export function fmtDurSpoken\(minutes\)/)
    expect(src).toMatch(/export function durationParts\(minutes\)/)
  })
})

describe('localStorage stays where rule 5 puts it', () => {
  it('is touched by exactly two modules', () => {
    const users = walk()
      .filter((rel) => !/\.test\.jsx?$/.test(rel))
      .filter((rel) => read(rel).includes('localStorage'))
      .sort()
    // A third key is a CI failure rather than a review question. Saved places
    // and profiles are described elsewhere and stay deferred; whoever ships one
    // has to delete this assertion deliberately.
    expect(users).toEqual(['lib/theme.js', 'lib/units.js'])
  })

  it('does not duplicate the units read into first paint', () => {
    // Unlike the theme, units affect nothing before a fetch resolves, so there
    // is no flash to prevent and no reason for a second copy of the key to
    // exist in a place that has to be kept in sync by hand.
    const html = readFileSync(fileURLToPath(new URL('../../index.html', import.meta.url)), 'utf8')
    const keys = [...html.matchAll(/meander:[a-z]+/g)].map((m) => m[0])
    expect([...new Set(keys)]).toEqual(['meander:theme'])
  })
})
