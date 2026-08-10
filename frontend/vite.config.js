import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

const here = dirname(fileURLToPath(import.meta.url))

// docker-compose sets this and nothing read it, so the compose frontend
// resolved localhost:8000 inside its own container and every /api call was a
// connection refused that presented as the backend being down.
const API_PROXY = {
  '/api': {
    target: process.env.VITE_API_PROXY_TARGET || 'http://localhost:8000',
    changeOrigin: true,
  },
}

/**
 * Files Cloudflare Pages reads as configuration and does not serve as assets.
 *
 * They have to sit in public/, because that is where Pages looks for them in
 * the build output — but they must never reach the precache manifest.
 * `cache.addAll()` is atomic (sw.js:49): one non-OK response rejects the whole
 * promise, the install event fails, and *no* service worker registers. So a
 * single unserved URL in this list does not cost you one cached file, it costs
 * you the entire offline shell, and the only trace is a failed install.
 *
 * This is a list rather than a `_`-prefix rule on purpose. `_headers` and
 * `_redirects` are the two that exist today; the other two are the rest of the
 * Pages control surface, added now so that reaching for one later does not
 * quietly reintroduce the same failure.
 */
export const PAGES_CONTROL_FILES = ['_headers', '_redirects', '_routes.json', '_worker.js']

/** Does this build-output URL belong in the service worker's precache? */
export function isPrecachable(url) {
  if (url.endsWith('/sw.js')) return false
  if (url.endsWith('.map')) return false
  return !PAGES_CONTROL_FILES.includes(url.slice(1))
}

/**
 * Emit sw.js with a real precache list and a version derived from the build.
 *
 * `enforce: 'post'` is load-bearing: without it the plugin runs before the
 * bundle is assembled and the precache ends up with no document in it.
 *
 * The version is derived from the file list, never stamped with a clock. A
 * timestamp changes the worker's bytes on every build and evicts every user's
 * shell whether or not anything actually changed.
 */
function meanderServiceWorker() {
  return {
    name: 'meander-service-worker',
    apply: 'build',
    enforce: 'post',
    generateBundle(_options, bundle) {
      const assets = Object.keys(bundle).map((name) => `/${name}`)
      // public/ is copied verbatim and never appears in the bundle. It may not
      // exist yet — the icons are a separate capability.
      const publicDir = join(here, 'public')
      const extras = existsSync(publicDir)
        ? readdirSync(publicDir).map((name) => `/${name}`)
        : []
      const precache = ['/', ...assets, ...extras].filter(isPrecachable)
      const version = createHash('sha256').update(precache.join('\n')).digest('hex').slice(0, 12)

      const source = readFileSync(join(here, 'sw.js'), 'utf8')
      // replaceAll, not replace: a non-global replace hits only the first
      // mention and ships the placeholder that appears in sw.js's own header.
      const out = source
        .replaceAll('__PRECACHE_MANIFEST__', JSON.stringify(precache))
        .replaceAll('__PRECACHE_VERSION__', version)

      // Assert rather than hope. A shipped placeholder is a worker that throws
      // on install, and the symptom is "the app just does not update".
      if (out.includes('__PRECACHE_')) {
        throw new Error('sw.js still contains a __PRECACHE_ placeholder after substitution')
      }

      this.emitFile({ type: 'asset', fileName: 'sw.js', source: out })
    },
  }
}

export default defineConfig({
  plugins: [react(), meanderServiceWorker()],
  server: {
    proxy: API_PROXY,
  },
  // `vite preview` is the only way to exercise the worker at all, and it had no
  // /api proxy — so every route request 404'd there.
  preview: {
    proxy: API_PROXY,
  },
  build: {
    // MapLibre is large and rarely changes; keeping it in its own chunk means a
    // UI change does not invalidate it in the browser cache.
    rollupOptions: {
      output: {
        manualChunks: { maplibre: ['maplibre-gl'] },
      },
    },
  },
  test: {
    // Forced, not inherited. canStateLocalTime() compares a longitude's solar
    // offset against the *viewer's* timezone, so the answer for a given
    // longitude depends on where the suite is run — and sun.test.js was written
    // against a UTC runner. It passed in CI (GitHub runners are UTC) and failed
    // on a machine in Asia/Colombo with the assertions exactly inverted: London
    // refused, Colombo accepted. Nothing said why.
    //
    // The same reasoning as backend/tests/conftest.py, which forces
    // MEANDER_FIXTURES and MEANDER_GRAPHHOPPER_URL rather than defaulting them:
    // an environment variable that decides what a test asserts has to be pinned
    // by the harness, not assumed of the developer. Node re-reads TZ when it
    // changes, so setting it here is enough.
    env: { TZ: 'UTC' },
  },
})
