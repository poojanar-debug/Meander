import { useEffect, useState, useSyncExternalStore } from 'react'

import { cacheAgeMs } from './offline.js'

/**
 * Whether Meander may keep your last result on this device.
 *
 * ⚠ **This is opt-in, and it is opt-in for a reason.** The app shell — the
 * JavaScript, the stylesheet, the icons — is cached unconditionally by the
 * service worker, because that is the program itself and caching it reveals
 * nothing about anybody. A *result* is a different object entirely: it is a
 * polyline through the streets around wherever the user happens to be, and
 * writing it to disk is the most location-revealing thing this app could do.
 *
 * The project's rule is that browser storage is opt-in and labelled, and the
 * rule does not bend because the feature is convenient. So:
 *
 *   * **off by default** — nothing is written until the user turns it on
 *   * **labelled** — the settings sheet says what is kept and why
 *   * **revocable, and the revocation is real** — turning it off tells the
 *     service worker to delete the cache, it does not merely stop adding to it
 *
 * The flag is mirrored into the service worker rather than read from it,
 * because a worker cannot see localStorage. It is re-sent on every page load,
 * so a worker that was evicted and restarted cannot come back holding a
 * permission the user has since withdrawn.
 */

const KEY = 'meander.offline'

export const SW_MESSAGE = 'meander.offline-pref'
export const SW_FORGET = 'meander.forget-results'

function read() {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return { saveResults: false, chosen: false }
    const saved = JSON.parse(raw)
    return { saveResults: saved.saveResults === true, chosen: true }
  } catch {
    // Unreadable or disabled storage is "no preference expressed", which is the
    // same as never having been asked — and that means off.
    return { saveResults: false, chosen: false }
  }
}

let current =
  typeof window === 'undefined' ? { saveResults: false, chosen: false } : read()

const listeners = new Set()
const emit = () => {
  for (const listener of listeners) listener()
}

export function getOfflineSetting() {
  return current
}

/**
 * Tell the service worker what it is allowed to keep.
 *
 * Sent to the *registered* worker rather than `controller`, because on the very
 * first load the page is not yet controlled and `controller` is null — which is
 * precisely the moment a user who has already opted in expects it to work.
 */
export async function syncToServiceWorker(saveResults = current.saveResults) {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return
  try {
    const registration = await navigator.serviceWorker.ready
    const worker = registration.active ?? navigator.serviceWorker.controller
    if (!worker) return
    worker.postMessage({ type: SW_MESSAGE, saveResults })
    if (!saveResults) worker.postMessage({ type: SW_FORGET })
  } catch {
    // No worker, or a browser that refuses one. The app works without it; the
    // only loss is the offline copy, and the user is told when there isn't one.
  }
}

export function setSaveResults(saveResults) {
  current = { saveResults: saveResults === true, chosen: true }
  try {
    localStorage.setItem(KEY, JSON.stringify({ saveResults: current.saveResults }))
  } catch {
    // Private browsing. The choice still applies for this session — including
    // the *off* direction, which is the one that matters.
  }
  void syncToServiceWorker(current.saveResults)
  emit()
}

/** Forget the preference itself, and anything stored under it. */
export function clearOfflineSetting() {
  try {
    localStorage.removeItem(KEY)
  } catch {
    /* nothing to clean up */
  }
  current = { saveResults: false, chosen: false }
  void syncToServiceWorker(false)
  emit()
}

function subscribe(listener) {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function useOfflineSetting() {
  return useSyncExternalStore(subscribe, getOfflineSetting, getOfflineSetting)
}

/**
 * The age of the displayed copy, recomputed as it ages.
 *
 * Without the interval the label is written once and then quietly becomes
 * wrong: a phone left on a table shows "saved 2 minutes ago" an hour later,
 * which is a worse failure than not labelling it at all — it is a specific
 * false claim rather than a missing one. Thirty seconds is fine-grained enough
 * that the minute count is never visibly stale and cheap enough to run for as
 * long as the copy is on screen.
 *
 * Returns `null` for "no cached copy" as well as for "cached, age unknown", so
 * callers must check `cachedAt` first to tell the two apart. That is why this
 * takes the timestamp rather than a boolean.
 */
export function useCacheAge(cachedAt, intervalMs = 30_000) {
  return cacheAgeMs(cachedAt, useNow(intervalMs))
}

/**
 * A clock that re-renders.
 *
 * Anything that renders a *relative* time needs one: the value was correct when
 * it was computed and silently stops being correct while nothing re-renders. A
 * phone left on a table is the ordinary case, not an edge case.
 */
export function useNow(intervalMs = 30_000) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs)
    return () => clearInterval(id)
  }, [intervalMs])
  return now
}

/**
 * Whether the browser thinks it has a network.
 *
 * `navigator.onLine` is famously weak — it reports the link, not reachability,
 * so it says `true` on a captive portal and on a wifi network with no route out.
 * It is used here only to choose between two wordings, never to decide whether
 * to attempt a request, and the fallback copy covers the case where it is wrong.
 */
export function useOnline() {
  const [online, setOnline] = useState(
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
