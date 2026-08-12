import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'

import App from './App.jsx'
import { refreshOfflineSetting } from './lib/offlineStore.js'
import { registerServiceWorker } from './lib/pwa.js'
import './styles.css'
import 'maplibre-gl/dist/maplibre-gl.css'

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <App />
  </StrictMode>,
)

registerServiceWorker()

// ⚠ **The consent sweep, which backs a privacy promise and was not running.**
//
// `offlineStore.js` says of this function: "This runs on every boot, before
// anything is rendered, so the longest such a route can survive is until the
// app is next opened." It has seven production call sites and **every one of
// them is reached only through `OfflineControl` -> `About`** — which `App.jsx`
// renders only in the non-first-run branch. So on a cold open with no origin,
// the common case, nothing swept and a saved route outlived a withdrawn
// consent indefinitely.
//
// Called here rather than from an effect in App, so it happens on every boot
// including the first-run screen, which is the one it was missing. The
// `if (!value.ready)` guard inside makes the later `useOfflineSetting` call a
// no-op, so this costs one IndexedDB read and changes nothing else.
//
// Deliberately not awaited: a boot must not wait on storage, and the sweep has
// nothing the first paint needs. Failures are already swallowed inside.
refreshOfflineSetting()
