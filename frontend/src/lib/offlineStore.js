import { useEffect, useState, useSyncExternalStore } from 'react'

/**
 * The consent flag for saving a route, and the clocks that keep an age honest.
 *
 * **The flag lives in CacheStorage, not in localStorage.** The branch this was
 * ported from kept it in localStorage under a third key, which this project's
 * rules do not allow — storage there is the theme and the units, and nothing
 * else. That branch then had to *mirror* the flag into CacheStorage anyway,
 * because a service worker cannot read localStorage, and re-push it on every
 * page load so an evicted worker could not come back holding a permission the
 * user had withdrawn.
 *
 * Deleting the mirror removes that whole class of problem. One source of truth,
 * in the bucket the worker already owns, and it fails closed harder: a browser
 * wiping site data wipes the flag and the saved route together, where a
 * localStorage mirror could in principle outlive the cache it was granting
 * permission for.
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
// must agree on these three strings. Same arrangement, and the same standing
// warning, as the theme key in index.html and lib/theme.js.
export const PREFS_CACHE = 'meander-prefs'
export const PREF_URL = '/__meander__/save-results'
export const RESULTS_PREFIX = 'meander-results-'

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
 * Read the flag. Every failure path — no CacheStorage at all on an insecure
 * origin, storage disabled, quota — resolves to "off, and the user has not
 * been asked".
 */
export async function refreshOfflineSetting() {
  try {
    if (typeof caches === 'undefined') {
      emit({ saveResults: false, chosen: false, ready: true })
      return snapshot
    }
    const cache = await caches.open(PREFS_CACHE)
    const hit = await cache.match(PREF_URL)
    if (!hit) {
      emit({ saveResults: false, chosen: false, ready: true })
      return snapshot
    }
    const body = await hit.text()
    emit({ saveResults: body === 'true', chosen: true, ready: true })
    return snapshot
  } catch {
    emit({ saveResults: false, chosen: false, ready: true })
    return snapshot
  }
}

export async function setSaveResults(saveResults) {
  try {
    if (typeof caches !== 'undefined') {
      const cache = await caches.open(PREFS_CACHE)
      await cache.put(PREF_URL, new Response(saveResults ? 'true' : 'false'))
    }
  } catch {
    // Storage refused. Nothing is persisted — and, crucially, nothing will be
    // saved either, because the worker reads the same absent flag.
  }
  // Revoking deletes what was already kept, in the same breath. Saying "no"
  // and leaving yesterday's route on disk would be the worst of both.
  if (!saveResults) await forgetResults()

  // Re-read rather than assume. If the write failed, the worker will read "off"
  // and save nothing, so a UI still showing "Yes, keep them" would be claiming
  // a promise nothing is keeping. Reading back is what makes the control
  // reflect what the worker will actually do.
  const confirmed = await refreshOfflineSetting()
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
 * Page-side, so it works with no worker running. sw.js keeps its own copy for
 * the same reason in reverse.
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
