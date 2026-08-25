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

// ⚠ **The consent sweep, which backs a privacy promise.**
//
// `offlineStore.js` says of this function: "This runs on every boot, before
// anything is rendered, so the longest such a route can survive is until the
// app is next opened." It once ran only behind a settings disclosure the app
// no longer has, so on a cold open nothing swept and a saved route outlived a
// withdrawn consent indefinitely. Called here, it happens on every boot
// unconditionally — which matters more now that no screen exposes the
// consent control at all: a flag withdrawn in an earlier build must still be
// honoured by this one.
//
// Deliberately not awaited: a boot must not wait on storage, and the sweep has
// nothing the first paint needs. Failures are already swallowed inside.
refreshOfflineSetting()
