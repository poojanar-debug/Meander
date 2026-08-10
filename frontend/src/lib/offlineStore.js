import { useEffect, useState, useSyncExternalStore } from 'react'

/**
 * The consent flag for saving a route, and the clocks that keep an age honest.
 *
 * **The flag lives in CacheStorage, not in localStorage.** The branch this was
 * ported from kept it in localStorage under a third key, which this project's
 * rules do not allow — storage there is the theme and the units, and nothing
 * else.
 *
 * The original argument for CacheStorage was that a service worker cannot read
 * localStorage. That argument is gone: the worker no longer reads this flag,
 * because it no longer stores routes — lib/resultsStore.js does, on the page.
 * The flag stays here anyway, on the two reasons that survive it. It fails
 * closed harder, and a browser wiping site data wipes the flag and the saved
 * route **together**, where a localStorage copy could in principle outlive the
 * cache it was granting permission for — a permission that outlives the thing
 * it permits is how a "no" quietly becomes a "yes" later.
 *
 * It is also not a weaker promise. CacheStorage is origin-scoped and is never
 * attached to a request, so unlike a cookie it cannot become an identifier. The
 * prefs bucket holds one word — `true` or `false` — which is exactly as
 * revealing as the theme, which is to say not at all.
 *
 * Consequence to design around: the read is asynchronous, so the setting reads
 * as *off* until `ready`. Off-until-proven-on is the only correct direction for
 * a flag guarding a write of someone's location.
 */

// Duplicated in frontend/sw.js — the worker cannot import from src/. The two
// must agree on these four strings. Same arrangement, and the same standing
// warning, as the theme key in index.html and lib/theme.js.
export const PREFS_CACHE = 'meander-prefs'
export const PREF_URL = '/__meander__/save-results'
export const RESULTS_PREFIX = 'meander-results-'
// The worker owns the shell and stamps its name with the build version.
// lib/resultsStore.js reads that name to version itself against the same build,
// which is the whole reason this string is shared rather than private.
export const SHELL_PREFIX = 'meander-shell-'

let snapshot = { saveResults: false, chosen: false, ready: false }
const listeners = new Set()

const emit = (next) => {
  snapshot = next
  for (const listener of listeners) listener()
}

export function getOfflineSetting() {
  return snapshot
}

/**
 * Read the flag out of storage, without touching the React snapshot.
 *
 * Separate from `refreshOfflineSetting` because the two callers want different
 * things. React wants a snapshot it can render. **A write of someone's location
 * wants the flag as it is at the instant of the write**, not as it was when the
 * component last rendered — a "No" pressed in another tab, or in this one while
 * a stream was still finishing, must be seen by the code about to store a
 * route. lib/resultsStore.js calls this, never `getOfflineSetting()`.
 *
 * Every failure path — no CacheStorage at all on an insecure origin, storage
 * disabled, quota — resolves to "off, and the user has not been asked".
 */
export async function readSaveResults() {
  try {
    if (typeof caches === 'undefined') return { saveResults: false, chosen: false }
    const cache = await caches.open(PREFS_CACHE)
    const hit = await cache.match(PREF_URL)
    if (!hit) return { saveResults: false, chosen: false }
    return { saveResults: (await hit.text()) === 'true', chosen: true }
  } catch {
    return { saveResults: false, chosen: false }
  }
}

/**
 * Read the flag and publish it to every subscriber.
 *
 * Sweeps when the answer is anything but yes, and that is not tidiness. The
 * store's own undo — write, notice the withdrawal, delete — is two round trips
 * long, and a tab closed or a device asleep inside that window leaves a route
 * on disk that consent no longer covers. This runs on every boot, before
 * anything is rendered, so the longest such a route can survive is until the
 * app is next opened. A withdrawal that only holds while the page stays alive
 * is not a withdrawal.
 */
export async function refreshOfflineSetting() {
  const { saveResults, chosen } = await readSaveResults()
  if (!saveResults) await forgetResults()
  emit({ saveResults, chosen, ready: true })
  return snapshot
}

export async function setSaveResults(saveResults) {
  try {
    if (typeof caches !== 'undefined') {
      const cache = await caches.open(PREFS_CACHE)
      await cache.put(PREF_URL, new Response(saveResults ? 'true' : 'false'))
    }
  } catch {
    // Storage refused. Nothing is persisted — and, crucially, nothing will be
    // saved either, because resultsStore.js reads the same absent flag through
    // readSaveResults() and gets "off".
  }
  // Revoking deletes what was already kept, in the same breath. Saying "no"
  // and leaving yesterday's route on disk would be the worst of both.
  if (!saveResults) await forgetResults()

  // Re-read rather than assume. If the write failed, resultsStore.js will read
  // "off" and save nothing, so a UI still showing "Yes, keep them" would be
  // claiming a promise nothing is keeping. Reading back is what makes the
  // control reflect what the app will actually do.
  let confirmed = await refreshOfflineSetting()

  // A "No" that could not be written is the one failure this must not accept.
  // With storage full, `cache.put` throws, the flag on disk stays `true`, and
  // the read-back agrees — so the control springs back to "Yes, keep them" and
  // the next search stores again. The user pressed No; their existing routes
  // were deleted by forgetResults() above and then the app carried on saving
  // new ones.
  //
  // Deleting the entry needs no new bytes, which is exactly why it works when
  // writing one does not. Absence already means "off", so the fallback lands on
  // the fail-closed side. It costs the record that the question was answered —
  // `chosen` goes back to false on the next read — and that is the right thing
  // to lose: being asked twice is a smaller harm than storing after a refusal.
  if (!saveResults && confirmed.saveResults) {
    try {
      if (typeof caches !== 'undefined') {
        const cache = await caches.open(PREFS_CACHE)
        await cache.delete(PREF_URL)
      }
    } catch {
      // Nothing further to try. The snapshot below stays "yes", which at least
      // does not tell the user they are protected when they are not.
    }
    await forgetResults()
    confirmed = await refreshOfflineSetting()
  }

  if (confirmed.saveResults !== saveResults) return
  emit({ saveResults, chosen: true, ready: true })
}

/**
 * Delete every saved route.
 *
 * Never touches the shell or the prefs bucket: the shell is the program, which
 * is identical for every visitor and says nothing about anybody, and the prefs
 * bucket is the record of the decision itself.
 *
 * Deletes whole buckets by name prefix rather than entries by key, so it does
 * not need to know what the store called anything. That is what lets it delete
 * a route written by a build that is no longer installed.
 */
export async function forgetResults() {
  try {
    if (typeof caches === 'undefined') return
    const keys = await caches.keys()
    await Promise.all(
      keys.filter((key) => key.startsWith(RESULTS_PREFIX)).map((key) => caches.delete(key)),
    )
  } catch {
    // Nothing depends on the deletion having been observed here; the worker's
    // own else-branch sweeps too.
  }
}

export async function clearOfflineSetting() {
  try {
    if (typeof caches !== 'undefined') {
      const cache = await caches.open(PREFS_CACHE)
      await cache.delete(PREF_URL)
    }
  } catch {
    // As above.
  }
  await forgetResults()
  emit({ saveResults: false, chosen: false, ready: true })
}

const subscribe = (listener) => {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function useOfflineSetting() {
  const value = useSyncExternalStore(subscribe, getOfflineSetting, getOfflineSetting)
  useEffect(() => {
    if (!value.ready) refreshOfflineSetting()
  }, [value.ready])
  return value
}

/**
 * A clock that ticks.
 *
 * A phone left on a table with the app open is the ordinary case, not the edge
 * case, and an age that was rendered once and never updated is a lie that gets
 * worse the longer you look at it.
 */
export function useNow(intervalMs = 30_000) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), intervalMs)
    return () => clearInterval(timer)
  }, [intervalMs])
  return now
}

export function useCacheAge(cachedAt, intervalMs = 30_000) {
  const now = useNow(intervalMs)
  if (!cachedAt) return null
  const then = new Date(cachedAt).valueOf()
  if (Number.isNaN(then)) return null
  const age = now - then
  return age < 0 ? null : age
}

/**
 * Whether the browser thinks it has a link.
 *
 * `navigator.onLine` reports the link, not reachability — it is true on a
 * captive-portal wifi that answers nothing. It is used here for exactly one
 * thing: choosing between two wordings. Nothing is gated on it.
 */
export function useOnline() {
  const [online, setOnline] = useState(() =>
    typeof navigator === 'undefined' ? true : navigator.onLine !== false,
  )
  useEffect(() => {
    const up = () => setOnline(true)
    const down = () => setOnline(false)
    window.addEventListener('online', up)
    window.addEventListener('offline', down)
    return () => {
      window.removeEventListener('online', up)
      window.removeEventListener('offline', down)
    }
  }, [])
  return online
}
