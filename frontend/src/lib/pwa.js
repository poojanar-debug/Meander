import { syncToServiceWorker } from './offlineStore.js'

/**
 * Register the service worker, and tell it what it is allowed to keep.
 *
 * Production only. A dev server has no `sw.js` — it is emitted from the bundle
 * by a build plugin, because a precache list has to name hashed filenames — so
 * registering in dev would 404 on every reload and, worse, a worker left
 * registered from a previous `vite preview` would start serving a stale shell
 * over the top of the dev server.
 *
 * The permission is re-sent on every load rather than assumed to have stuck.
 * A worker can be evicted and restarted at any time, and it must never come
 * back holding a permission the user has since withdrawn.
 */
export function registerServiceWorker() {
  if (!import.meta.env.PROD) return
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return

  // After load: registration competes with the app's own first render and its
  // first route request for the same connection, and the app is what the user
  // is waiting for.
  window.addEventListener('load', () => {
    navigator.serviceWorker
      .register('/sw.js', { scope: '/' })
      .then(() => syncToServiceWorker())
      .catch(() => {
        // A refused registration — an insecure origin, storage disabled, a
        // policy — costs the offline copy and nothing else. There is nothing
        // to tell the user here; the settings sheet reports the real state.
      })
  })
}

/** Unregister everything and drop every cache. Used by the PWA gate. */
export async function unregisterServiceWorkers() {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return
  const registrations = await navigator.serviceWorker.getRegistrations()
  await Promise.all(registrations.map((r) => r.unregister()))
  const keys = await caches.keys()
  await Promise.all(keys.map((k) => caches.delete(k)))
}
