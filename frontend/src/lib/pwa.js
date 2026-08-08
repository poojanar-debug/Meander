/**
 * Service worker registration.
 *
 * Production only: in dev the worker would serve a precached shell over the top
 * of Vite's HMR and every edit would appear not to work. Deferred to `load` so
 * registration never competes with first paint.
 */

export function registerServiceWorker() {
  if (!import.meta.env.PROD) return
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {
      // A worker that will not register is a missing optimisation, not a
      // broken app. Everything works without it.
    })
  })
}

/** Kept for the offline gate, which has to prove the app still works without one. */
export async function unregisterServiceWorkers() {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return
  const registrations = await navigator.serviceWorker.getRegistrations()
  await Promise.all(registrations.map((registration) => registration.unregister()))
}
