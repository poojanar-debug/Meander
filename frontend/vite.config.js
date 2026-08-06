import { createHash } from 'node:crypto'
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

const here = dirname(fileURLToPath(import.meta.url))

const API_PROXY = {
  // localhost is right when the backend runs on the same machine. Under
  // docker compose the API is a different container, so `localhost` here
  // would be the *frontend* container and every /api call would fail with
  // a connection refused that looks like the backend being down.
  '/api': {
    target: process.env.VITE_API_PROXY_TARGET || 'http://localhost:8000',
    changeOrigin: true,
  },
}

/**
 * Emit `sw.js` with a precache list that matches the bundle that was actually
 * built.
 *
 * A service worker in `public/` is copied verbatim, so it cannot name
 * `index-B7dK2p.js` — and a shell precache that misses the app's own JavaScript
 * caches nothing worth having. This runs after the bundle exists and
 * substitutes the real filenames.
 *
 * No `vite-plugin-pwa`. It is a good plugin, but it brings Workbox and its
 * dependency tree to generate about eighty lines of worker whose exact
 * behaviour around POST caching and an opt-in permission gate we need to be
 * able to read and reason about. The worker is the interesting part of this
 * phase, not boilerplate to be delegated.
 *
 * **The version is derived, not stamped.** `Date.now()` here would change the
 * worker's bytes on every build, so every deploy would evict the shell whether
 * or not anything had changed. Hashing the precache list plus the worker source
 * means the version moves exactly when the thing it names moves, and two builds
 * of the same commit produce identical output.
 */
function meanderServiceWorker() {
  return {
    name: 'meander-service-worker',
    apply: 'build',
    // After Vite's own plugins, so `index.html` is in the bundle by the time
    // this reads it. Without this the first build produced a precache list of
    // JS, CSS and icons with no document in it — a shell that cached everything
    // except the page.
    enforce: 'post',
    generateBundle(_options, bundle) {
      const built = Object.keys(bundle).map((f) => `/${f}`)

      // public/ is copied outside the bundle, so it has to be listed directly.
      // Only the files the app needs in order to *open*: the icons a launcher
      // or an install prompt reads, and the manifest itself.
      const publicFiles = readdirSync(join(here, 'public'))
        .filter((f) => f.endsWith('.png') || f === 'manifest.webmanifest')
        .map((f) => `/${f}`)

      const precache = [...new Set([...built, ...publicFiles])].sort()

      // Not a nicety. The navigation fallback matches '/index.html' by name, so
      // a build that emitted the document under any other key would produce a
      // worker that serves every asset offline and then has no page to put them
      // in — and it would only show up on a real offline load.
      if (!precache.includes('/index.html')) {
        this.error('service worker precache has no /index.html')
      }

      const source = readFileSync(join(here, 'sw.js'), 'utf8')
      const version = createHash('sha256')
        .update(source)
        .update(precache.join('\n'))
        .digest('hex')
        .slice(0, 12)

      // replaceAll, not replace. A non-global replace substitutes the first
      // occurrence, which was the one in sw.js's own header comment — so the
      // worker shipped with a literal `__PRECACHE__` in the code and threw on
      // install, while `dist/sw.js` looked perfectly reasonable at a glance.
      const emitted = source
        .replaceAll('__VERSION__', version)
        .replaceAll('__PRECACHE__', JSON.stringify(precache, null, 2))

      if (emitted.includes('__VERSION__') || emitted.includes('__PRECACHE__')) {
        this.error('service worker placeholders were not substituted')
      }

      this.emitFile({ type: 'asset', fileName: 'sw.js', source: emitted })
    },
  }
}

/**
 * HTTPS for testing on a real phone, and it is not optional there.
 *
 * A service worker needs a secure context, and `http://192.168.1.5:5173` is not
 * one — only `localhost` gets the exemption. So over plain LAN HTTP the app
 * runs, but nothing about Phase 6.5 does: no worker registers, no install
 * prompt appears, and the offline path cannot be reached at all. Tapping
 * through a certificate warning does not help either; browsers refuse to
 * register a worker on an origin with a certificate error, interstitial
 * accepted or not. The certificate has to actually be trusted on the device.
 *
 * Off unless both variables are set, so a normal `npm run dev` is unchanged:
 *
 *   MEANDER_DEV_CERT=… MEANDER_DEV_KEY=… npm run preview -- --host
 */
const devHttps = () => {
  const cert = process.env.MEANDER_DEV_CERT
  const key = process.env.MEANDER_DEV_KEY
  if (!cert || !key) return undefined
  return { cert: readFileSync(cert), key: readFileSync(key) }
}

export default defineConfig({
  plugins: [react(), meanderServiceWorker()],
  server: { proxy: API_PROXY, https: devHttps() },
  // `vite preview` serves the real build, which is the only way to exercise the
  // service worker — a dev server has no hashed assets and no sw.js. It needs
  // the same proxy as the dev server or every route request 404s.
  preview: { proxy: API_PROXY, https: devHttps() },
  build: {
    // MapLibre is large and rarely changes; keeping it in its own chunk means a
    // UI change does not invalidate it in the browser cache.
    rollupOptions: {
      output: {
        manualChunks: { maplibre: ['maplibre-gl'] },
      },
    },
  },
})
