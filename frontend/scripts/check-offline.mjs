/**
 * The offline contract: a saved route is never presented as a current one.
 *
 *     npm run check:offline
 *
 * `lib/offline.js` is the only place that decides how a cached answer is
 * described, and it is pure so that this can execute every branch of it without
 * a bundler, a DOM or a test runner — the same arrangement as
 * check-permalink.mjs.
 *
 * The invariant that matters is the last group: **there is no input for which
 * the label is absent, empty, or quieter than the situation deserves.** A bug
 * that let one age fall through to "no notice" would not look like a bug — the
 * card would simply render as though the data were live, which is the exact
 * failure the whole project is built to prevent.
 */

import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))

const {
  cacheAgeMs,
  cacheChipText,
  cacheTier,
  cachedNotice,
  departureHasPassed,
  formatCacheAge,
  offlineBarText,
} = await import(join(here, '..', 'src', 'lib', 'offline.js'))

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

const SECOND = 1000
const MINUTE = 60 * SECOND
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

const NOW = Date.parse('2026-08-06T12:00:00Z')
const ago = (ms) => new Date(NOW - ms).toISOString()

// --- age ------------------------------------------------------------------

check('an age is measured from the stored timestamp', () => {
  assert.equal(cacheAgeMs(ago(5 * MINUTE), NOW), 5 * MINUTE)
  assert.equal(cacheAgeMs(new Date(NOW - HOUR), NOW), HOUR)
})

check('a missing or unparseable timestamp is unknown, not zero', () => {
  assert.equal(cacheAgeMs(null, NOW), null)
  assert.equal(cacheAgeMs(undefined, NOW), null)
  assert.equal(cacheAgeMs('', NOW), null)
  assert.equal(cacheAgeMs('yesterday afternoon', NOW), null)
})

check('a timestamp in the future is unknown, not fresh', () => {
  // The device clock moved between writing the entry and reading it. "0 minutes
  // ago" would be a specific false claim; "we cannot tell" is the true one.
  assert.equal(cacheAgeMs(new Date(NOW + HOUR).toISOString(), NOW), null)
})

// --- wording --------------------------------------------------------------

check('the age reads the way a person would say it', () => {
  assert.equal(formatCacheAge(20 * SECOND), 'less than a minute ago')
  assert.equal(formatCacheAge(70 * SECOND), 'a minute ago')
  assert.equal(formatCacheAge(14 * MINUTE), '14 minutes ago')
  assert.equal(formatCacheAge(2 * HOUR), '2 hours ago')
  assert.equal(formatCacheAge(30 * HOUR), 'a day ago')
  assert.equal(formatCacheAge(3 * DAY), '3 days ago')
})

check('an unknown age says so rather than picking a number', () => {
  assert.equal(formatCacheAge(null), 'an unknown time ago')
  assert.match(cacheChipText(null), /unknown/)
  assert.match(cachedNotice(null).headline, /cannot tell how old/)
})

check('the chip stays short enough for a compact row', () => {
  for (const ms of [0, 30 * SECOND, 45 * MINUTE, 5 * HOUR, 9 * DAY, null]) {
    assert.ok(cacheChipText(ms).length <= 20, `too long: ${cacheChipText(ms)}`)
  }
})

check('being offline and the server being down are worded differently', () => {
  assert.match(offlineBarText(MINUTE, false), /You are offline/)
  assert.match(offlineBarText(MINUTE, true), /could not reach the server/)
  // Sending someone to check their wifi when their wifi is fine wastes the one
  // thing they have less of than usual, which is patience.
  assert.ok(!offlineBarText(MINUTE, true).includes('You are offline'))
})

// --- escalation -----------------------------------------------------------

check('the tier escalates with age and never goes back down', () => {
  const RANK = { quiet: 0, amber: 1, loud: 2 }
  const ages = [0, MINUTE, 14 * MINUTE, 15 * MINUTE, HOUR, 5 * HOUR, 6 * HOUR, DAY, 30 * DAY]
  let last = -1
  for (const ms of ages) {
    const rank = RANK[cacheTier(ms)]
    assert.ok(rank >= last, `tier fell at ${ms}ms: ${cacheTier(ms)}`)
    last = rank
  }
  assert.equal(cacheTier(0), 'quiet')
  assert.equal(cacheTier(30 * MINUTE), 'amber')
  assert.equal(cacheTier(DAY), 'loud')
})

check('an unknown age is the loudest tier, not the quietest', () => {
  assert.equal(cacheTier(null), 'loud')
})

check('past the enrichment threshold the notice names what has gone stale', () => {
  // Air quality, rest stops and the departure time are measurements of a
  // moment. Saying the route is old without saying which parts of it stopped
  // being true is the kind of warning people learn to skip.
  for (const ms of [30 * MINUTE, 5 * HOUR, DAY, null]) {
    const { detail } = cachedNotice(ms)
    assert.ok(detail, `no detail at ${ms}`)
    assert.match(detail, /[Aa]ir quality/)
    assert.match(detail, /best time to leave|out of date/)
  }
})

// --- the invariant --------------------------------------------------------

check('THE CONTRACT: every possible age produces a visible label with its age', () => {
  const ages = [
    null, 0, 1, SECOND, 59 * SECOND, MINUTE, 89 * MINUTE, 90 * MINUTE,
    23 * HOUR, DAY, 47 * HOUR, 400 * DAY, Number.MAX_SAFE_INTEGER,
  ]
  for (const ms of ages) {
    const notice = cachedNotice(ms)
    assert.ok(notice.headline?.trim(), `empty headline at ${ms}`)
    assert.ok(['quiet', 'amber', 'loud'].includes(notice.tier), `bad tier at ${ms}`)
    // The headline must carry the age itself, not merely the word "saved" —
    // "this is a saved copy" without a when is not a labelled copy.
    assert.ok(
      notice.headline.includes(formatCacheAge(ms)) ||
        notice.headline.includes('cannot tell how old'),
      `headline at ${ms} does not state the age: ${notice.headline}`,
    )
    assert.ok(cacheChipText(ms).trim(), `empty chip at ${ms}`)
  }
})

// --- expiry ---------------------------------------------------------------

check('a departure time that has passed is not presented as a suggestion', () => {
  assert.equal(departureHasPassed(ago(HOUR), NOW), true)
  assert.equal(departureHasPassed(new Date(NOW + HOUR).toISOString(), NOW), false)
})

check('a missing or unparseable departure is not "passed"', () => {
  // There is nothing to withdraw, and rendering the withdrawal notice where
  // there was never a suggestion invents a recommendation to retract.
  assert.equal(departureHasPassed(null, NOW), false)
  assert.equal(departureHasPassed('', NOW), false)
  assert.equal(departureHasPassed('soon', NOW), false)
})

console.log(failures ? `\n${failures} offline check(s) failed` : '\nOffline contract holds.')
process.exit(failures ? 1 : 0)
