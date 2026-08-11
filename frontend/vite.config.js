import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { defineConfig, loadEnv } from 'vite'
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
 * Both ends are now measured, and they disagree, which is worth writing down.
 * Under `wrangler pages dev dist`, GET /_headers is a 502 once the file is
 * consumed as configuration — non-OK, so the install fails and there is no
 * worker at all. Production Pages instead answers 200 with the SPA shell:
 *
 *   $ curl -sS -o /dev/null -w '%{http_code} %{content_type}' \
 *       https://meander-eoc.pages.dev/_headers
 *   200 text/html; charset=utf-8
 *
 * So on production the install would have survived and quietly cached a copy of
 * index.html under /_headers, while a developer running the emulator would see
 * offline break outright. The exclusion is right for both, and the earlier note
 * here — which asserted the 404/install-failure reading as though it were the
 * production answer — was wrong about which branch ships.
 */
export const PAGES_CONTROL_FILES = ['_headers', '_redirects', '_routes.json', '_worker.js']

/**
 * Does this build-output URL belong in the service worker's precache?
 *
 * The rule is the underscore, not the list. Testing membership of
 * PAGES_CONTROL_FILES was a tautology — the gate asserted
 * `isPrecachable(x) === !PAGES_CONTROL_FILES.includes(x)` against an
 * implementation that *was* that expression, so deleting an entry deleted its
 * own assertion. Verified: with `_routes.json` in public/ and removed from the
 * list, the whole suite stayed green and the built manifest shipped it.
 *
 * Cloudflare reserves the underscore prefix at the build root for its own
 * configuration, so any root-level `_*` is a file Pages consumes rather than
 * serves. That rule catches the next control file whether or not anyone
 * remembered to name it. The list stays, as documentation and as the thing the
 * gate pins by name.
 */
export function isPrecachable(url) {
  if (url.endsWith('/sw.js')) return false
  if (url.endsWith('.map')) return false
  return !/^\/_[^/]*$/.test(url)
}

/**
 * Refuse to produce a Cloudflare Pages build that would talk to itself.
 *
 * client.js:19 reads VITE_API_BASE and falls back to the empty string, which
 * means same-origin `/api`. That default is right for local dev, where Vite
 * proxies, and it is silently wrong on Pages: the API is on another host, so an
 * unset variable ships an app that requests https://meander-eoc.pages.dev/api/…
 * and gets the SPA shell back with a 200, because Pages falls back to
 * index.html for anything with no asset behind it.
 *
 * The user sees `Unexpected token '<', "<!doctype "... is not valid JSON` in the
 * error banner, because res.json() is unguarded at client.js:112, :160 and :215.
 * Nothing in that message names the cause.
 *
 * `_redirects` cannot close it — Cloudflare supports no rule that answers 404 —
 * so it is closed here, at the point where the mistake is actually made.
 *
 * Gated on CF_PAGES, which Cloudflare sets to "1" in its build environment and
 * nothing else does. A developer running `npm run build`, and `make check`
 * running it in CI, are unaffected: they legitimately have no API base.
 */
function requireApiBaseOnPages() {
  return {
    name: 'meander-require-api-base',
    apply: 'build',
    config(_config, { mode }) {
      if (process.env.CF_PAGES !== '1') return
      // loadEnv, not process.env: Vite's own precedence, so a .env.production
      // carrying VITE_API_BASE is honoured rather than failing the build for
      // having configured it the idiomatic way.
      const env = loadEnv(mode, here, '')
      const base = (env.VITE_API_BASE ?? '').trim()
      if (!/^https:\/\/[^/\s]+$/.test(base.replace(/\/$/, ''))) {
        throw new Error(
          `VITE_API_BASE must be an absolute https origin in a Cloudflare Pages build, got ${
            base === '' ? '(unset)' : JSON.stringify(base)
          }. Unset, every /api call goes to the Pages origin, comes back as the ` +
            'HTML shell with a 200, and surfaces as a JSON parse error in the UI.',
        )
      }
      const origin = base.replace(/\/$/, '')

      // The exact defect this exists to stop, spelled correctly. A shape check
      // passes https://meander-eoc.pages.dev happily, and that is the app
      // pointed at itself — every /api call falls back to the SPA shell.
      const self = process.env.CF_PAGES_URL ?? ''
      if (self && new URL(origin).host === new URL(self).host) {
        throw new Error(
          `VITE_API_BASE is this Pages project's own origin (${origin}). Every /api ` +
            'call would come back as the HTML shell with a 200.',
        )
      }

      // And a base the CSP will not permit builds cleanly and then fails in the
      // browser on every request, with the cause only visible in a console.
      const headersFile = join(here, 'public', '_headers')
      if (existsSync(headersFile)) {
        const csp = /^\s+Content-Security-Policy:\s*(.*)$/m.exec(readFileSync(headersFile, 'utf8'))
        const connect = csp && /(?:^|;)\s*connect-src\s+([^;]*)/.exec(csp[1])
        if (connect && !connect[1].split(/\s+/).includes(origin)) {
          throw new Error(
            `VITE_API_BASE is ${origin}, which public/_headers does not name in ` +
              `connect-src (${connect[1].trim()}). The build would succeed and the ` +
              'browser would block every call to it.',
          )
        }
      }

      if (env.VITE_MOCK_API === '1') {
        throw new Error(
          'VITE_MOCK_API=1 in a Cloudflare Pages build would deploy the mock API. ' +
            'The site would answer every request with invented routes and say nothing.',
        )
      }
      void mode
    },
  }
}

/**
 * Emit sw.js with a real precache list and a version derived from the build.
 *
 * `enforce: 'post'` is load-bearing: without it the plugin runs before the
 * bundle is assembled and the precache ends up with no document in it.
 *
 * The version is derived from the build's *contents*, never stamped with a
 * clock. A timestamp changes the worker's bytes on every build and evicts every
 * user's shell whether or not anything actually changed — that property is
 * deliberate and is kept.
 *
 * It used to hash the file *names* instead, which has the opposite failure and
 * a worse one. Hashed names are stable whenever the names are, so any change
 * that does not rename a file produced a byte-identical `sw.js`. Measured:
 * change only the `<title>` in index.html, rebuild, and both builds emit
 * `VERSION = '0ed7d9268540'` and identical worker bytes while `dist/index.html`
 * differs. The browser's update check byte-compares the worker, finds no
 * change, installs nothing, and `handleShell` — cache-first, never
 * revalidating — serves the old shell forever. The same holds for any in-place
 * edit under `public/`. The `_headers` mitigation cannot help: it never reaches
 * a client the old worker is already controlling.
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

      // Contents, not names. Each precached entry contributes its own bytes:
      // bundle entries are in memory at this point (`code` for a chunk,
      // `source` for an asset), and public/ files are read from disk because
      // they are copied verbatim and never enter the bundle.
      //
      // The path is hashed alongside the bytes so that moving a file also
      // changes the version, and the list is sorted so a directory-order
      // difference between machines cannot produce two versions of one build.
      const digest = createHash('sha256')
      for (const url of [...precache].sort()) {
        digest.update(url)
        digest.update('\0')
        const name = url.slice(1)
        const entry = bundle[name]
        if (entry) {
          digest.update(entry.code ?? entry.source ?? '')
        } else if (name && existsSync(join(publicDir, name))) {
          digest.update(readFileSync(join(publicDir, name)))
        }
        // '/' has no file of its own — it is served by index.html, which is in
        // the bundle under its own name and hashed there.
        digest.update('\0')
      }
      const version = digest.digest('hex').slice(0, 12)

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
  plugins: [react(), requireApiBaseOnPages(), meanderServiceWorker()],
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
