import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/api': { target: 'http://localhost:8000', changeOrigin: true },
    },
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
