import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react'

import { buildRouteRequest, fetchRoutes } from './api/client.js'
import BetterLater from './components/BetterLater.jsx'
import Controls from './components/Controls.jsx'
import ControlsSheet from './components/ControlsSheet.jsx'
import Header from './components/Header.jsx'
import MapView from './components/MapView.jsx'
import OfflineBar from './components/OfflineBar.jsx'
import RouteList from './components/RouteList.jsx'
import RouteSheet from './components/RouteSheet.jsx'
import ShareButton from './components/ShareButton.jsx'
import StatusBanner from './components/StatusBanner.jsx'
import TopBar from './components/TopBar.jsx'
import { announceRoutes, announceSelection, effectiveMode } from './lib/format.js'
import { useMediaQuery } from './lib/media.js'
import { cacheAgeMs, formatCacheAge } from './lib/offline.js'
import { useCacheAge, useOnline } from './lib/offlineStore.js'
import { decodeState, writeUrl } from './lib/permalink.js'
import { useTheme } from './lib/theme.js'

const MIN_MINUTES = 20
const MAX_MINUTES = 360

/** Per-trigger debounce, from the handoff spec. */
const DEBOUNCE = {
  minutes: 400,
  mode: 120,
  objectives: 120,
  place: 0,
  retry: 0,
}

const initialState = {
  phase: 'idle', // idle | locating | loading | success | error
  minutes: 35,
  mode: 'auto',
  objectives: ['fastest', 'nature', 'accessible'],
  origin: null,
  dest: null,
  routes: [],
  selected: null,
  progress: null,
  cache: null,
  reason: null,
  bestDeparture: null,
  error: null,
  geoDenied: false,
  // The objective that a fourth selection pushed out, so the UI can say which.
  droppedObjective: null,
  // Bumped by anything that should trigger a refetch; the effect keys on it.
  nonce: 0,
  debounceMs: 0,
}

function withRefetch(state, patch, debounceMs) {
  return { ...state, ...patch, nonce: state.nonce + 1, debounceMs, error: null }
}

function reducer(state, action) {
  switch (action.type) {
    case 'minutes':
      return withRefetch(
        state,
        { minutes: Math.min(MAX_MINUTES, Math.max(MIN_MINUTES, action.value)) },
        DEBOUNCE.minutes,
      )

    case 'mode':
      return withRefetch(state, { mode: action.value }, DEBOUNCE.mode)

    case 'toggleObjective': {
      const present = state.objectives.includes(action.value)
      // Never allow zero: a route list with nothing in it is not a state the
      // user can recover from without guessing.
      if (present && state.objectives.length === 1) return state
      const next = present
        ? state.objectives.filter((o) => o !== action.value)
        : [...state.objectives, action.value].slice(-3)
      // Which one fell off, so the UI can say so. Silently dropping the oldest
      // is a state change with no feedback anywhere the user is looking —
      // especially on a phone, where the dropped chip is usually off screen.
      const dropped = state.objectives.find((o) => !next.includes(o) && o !== action.value)
      return withRefetch(
        state,
        { objectives: next, droppedObjective: dropped ?? null },
        DEBOUNCE.objectives,
      )
    }

    case 'origin':
      return withRefetch(state, { origin: action.value, geoDenied: false }, DEBOUNCE.place)

    case 'dest':
      return withRefetch(state, { dest: action.value }, DEBOUNCE.place)

    case 'retry':
      return withRefetch(state, {}, DEBOUNCE.retry)

    case 'locating':
      return { ...state, phase: 'locating', geoDenied: false }

    case 'geoDenied':
      return { ...state, phase: state.routes.length ? 'success' : 'idle', geoDenied: true }

    case 'loading':
      // Routes and selection are deliberately preserved: the previous answer
      // stays on screen and interactive until the new one lands.
      return { ...state, phase: 'loading', progress: null, error: null }

    case 'progress':
      return { ...state, progress: action.value }

    case 'route': {
      // Merge by id — narration arrives in a second pass on the same route.
      const incoming = action.value
      const index = state.routes.findIndex((r) => r.id === incoming.id)
      const routes =
        index === -1
          ? [...state.routes, incoming]
          : state.routes.map((r) => (r.id === incoming.id ? { ...r, ...incoming } : r))
      const ordered = [...routes].sort(
        (a, b) => state.objectives.indexOf(a.id) - state.objectives.indexOf(b.id),
      )
      const firstRoutable = ordered.find((r) => r.status === 'ok')
      return {
        ...state,
        routes: ordered,
        selected:
          state.selected && ordered.some((r) => r.id === state.selected)
            ? state.selected
            : (firstRoutable ?? ordered[0])?.id ?? null,
      }
    }

    case 'settled':
      return {
        ...state,
        phase: 'success',
        progress: null,
        routes: action.routes ?? state.routes,
        cache: action.cache ?? state.cache,
        reason: action.reason ?? null,
        bestDeparture: action.bestDeparture ?? null,
      }

    case 'replaceRoutes':
      return { ...state, routes: action.value }

    case 'error':
      return { ...state, phase: 'error', progress: null, error: action.value }

    case 'select':
      return { ...state, selected: action.value }

    default:
      return state
  }
}

/**
 * Did this answer come off the disk rather than the wire?
 *
 * Read from the routes rather than held in the reducer, so it cannot drift out
 * of step with what is actually rendered. Every route in one response carries
 * the same stamp, and a refetch replaces routes by id — so the moment a live
 * route lands the stamp is gone with no separate state to remember to clear.
 *
 * `cachedAt: null` means "cached, but the age is unknown", which is a different
 * answer from "not cached" and is treated as the *least* trustworthy case by
 * lib/offline.js. The distinction is why this returns an object or null rather
 * than a timestamp.
 */
function cacheStamp(routes) {
  const hit = routes.find((route) => route.servedFromCache)
  return hit ? { cachedAt: hit.cachedAt ?? null } : null
}

/**
 * A shared link is the initial state, not something applied afterwards.
 *
 * Seeding the reducer means the one fetch effect fires on the first render with
 * the right inputs — applying it in an effect instead would route the defaults
 * first and then route again, which spends two requests and briefly shows the
 * wrong answer.
 */
function initialStateFromUrl() {
  if (typeof window === 'undefined') return initialState
  const shared = decodeState()
  if (!shared) return initialState
  // nonce 1 rather than 0: the fetch effect ignores 0 (nothing has been asked
  // for yet), and a link *is* a request.
  return { ...initialState, ...shared, nonce: 1, debounceMs: 0 }
}

export default function App() {
  const [state, dispatch] = useReducer(reducer, undefined, initialStateFromUrl)
  const [announcement, setAnnouncement] = useState('')
  // 'hidden' until the first routes arrive, so an empty sheet does not sit over
  // the map before there is anything to put in it.
  const [sheetSnap, setSheetSnap] = useState('hidden')
  const [sheet, setSheet] = useState(null) // null | 'search' | 'settings'
  const theme = useTheme()
  const online = useOnline()
  const abortRef = useRef(null)
  const announceTimer = useRef(null)

  const cached = useMemo(() => cacheStamp(state.routes), [state.routes])
  const ageMs = useCacheAge(cached?.cachedAt)

  const mode = useMemo(
    () => effectiveMode(state.mode, state.minutes),
    [state.mode, state.minutes],
  )

  /** Debounced so a dial drag does not flood the live region. */
  const announce = useCallback((text) => {
    if (!text) return
    clearTimeout(announceTimer.current)
    announceTimer.current = setTimeout(() => setAnnouncement(text), 350)
  }, [])

  // --- the one fetch effect ------------------------------------------------

  useEffect(() => {
    if (!state.origin) return undefined
    if (state.nonce === 0) return undefined

    const timer = setTimeout(async () => {
      abortRef.current?.abort()
      const controller = new AbortController()
      abortRef.current = controller

      dispatch({ type: 'loading' })
      const arrived = []

      try {
        const payload = await fetchRoutes(
          buildRouteRequest({
            origin: state.origin,
            dest: state.dest,
            minutes: state.minutes,
            mode: state.mode,
            objectives: state.objectives,
          }),
          {
            signal: controller.signal,
            onProgress: (evt) => dispatch({ type: 'progress', value: evt }),
            onRoute: (route) => {
              arrived.push(route)
              dispatch({ type: 'route', value: route })
            },
          },
        )
        if (controller.signal.aborted) return

        dispatch({
          type: 'settled',
          routes: payload?.routes,
          cache: payload?.cache,
          reason: payload?.reason,
          bestDeparture: payload?.best_departure,
        })
        // A saved copy is announced before the routes are, not after. Someone
        // listening rather than looking gets the caveat first, in the same
        // order a sighted reader meets it, instead of hearing three durations
        // and only then being told they are old.
        const stamp = cacheStamp(payload?.routes ?? arrived)
        const preamble = stamp
          ? `Showing a saved copy from ${formatCacheAge(cacheAgeMs(stamp.cachedAt))}. `
          : ''
        announce(preamble + announceRoutes(payload?.routes ?? arrived))
      } catch (err) {
        if (err?.name === 'AbortError') return
        dispatch({ type: 'error', value: err })
        announce(`Could not load routes. ${err.message ?? ''}`)
      }
    }, state.debounceMs)

    return () => clearTimeout(timer)
    // Only `nonce` should retrigger: every input change bumps it with the right
    // debounce, and reading the other values here would double-fire.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.nonce])

  useEffect(() => () => abortRef.current?.abort(), [])

  // The address bar follows the controls. replaceState, never pushState — a
  // slider drag would otherwise put fifty entries behind the back button.
  useEffect(() => {
    writeUrl({
      origin: state.origin,
      dest: state.dest,
      minutes: state.minutes,
      mode: state.mode,
      objectives: state.objectives,
    })
  }, [state.origin, state.dest, state.minutes, state.mode, state.objectives])

  // --- handlers ------------------------------------------------------------

  const onLocate = useCallback(() => {
    if (!navigator.geolocation) {
      dispatch({ type: 'geoDenied' })
      announce('This browser cannot share your location. Search for a starting point instead.')
      return
    }
    dispatch({ type: 'locating' })
    navigator.geolocation.getCurrentPosition(
      (position) => {
        dispatch({
          type: 'origin',
          value: {
            name: 'Your location',
            lat: position.coords.latitude,
            lon: position.coords.longitude,
          },
        })
        announce('Starting from your location.')
      },
      () => {
        dispatch({ type: 'geoDenied' })
        announce('Your browser did not share your location. Search for a starting point instead.')
      },
      { enableHighAccuracy: false, timeout: 10000, maximumAge: 60000 },
    )
  }, [announce])

  const onSelect = useCallback(
    (id) => {
      dispatch({ type: 'select', value: id })
      const route = state.routes.find((r) => r.id === id)
      announce(announceSelection(route))
    },
    [state.routes, announce],
  )

  const onToggleObjective = useCallback(
    (id) => {
      dispatch({ type: 'toggleObjective', value: id })
      announce(`Objectives changed.`)
    },
    [announce],
  )

  const hasRoutes = state.routes.length > 0
  const loading = state.phase === 'loading'

  // Above this the sheet becomes a fixed left panel and the snap machinery goes
  // inert, so every card renders in full. Matched here as well as in CSS
  // because RouteList needs the answer to decide row-vs-card, and a CSS-only
  // version would leave the DOM saying "peek" while the layout said otherwise.
  const desktop = useMediaQuery('(min-width: 900px)')
  const effectiveSnap = desktop ? 'full' : sheetSnap
  // Peek is the three routes and nothing else.
  const showChrome = effectiveSnap !== 'peek'

  // Results arriving is the moment the sheet earns its place. Lifting it to
  // peek — not half, not full — is what puts three routes on screen with no
  // scrolling, which is the whole point of this layout.
  useEffect(() => {
    if (hasRoutes && sheetSnap === 'hidden') setSheetSnap('peek')
  }, [hasRoutes, sheetSnap])

  return (
    <div className="app">
      <a className="skip-link" href="#results">
        Skip to the routes
      </a>

      {/* One polite live region for the whole app. */}
      <p className="visually-hidden" role="status" aria-live="polite">
        {announcement}
      </p>

      <Header />

      <main className="shell">
        {/* The map is the background layer and it is always mounted, at its
            final size. It used to appear only once the first route arrived,
            which shoved everything below it down the page mid-read. */}
        <div className="shell__map">
          <MapView
            key={theme}
            theme={theme}
            routes={state.routes}
            selected={state.selected}
            origin={state.origin}
            dest={state.dest}
            onSelect={onSelect}
          />
        </div>

        <TopBar
          origin={state.origin}
          minutes={state.minutes}
          mode={mode}
          stale={loading && hasRoutes}
          cached={Boolean(cached)}
          cacheAgeMs={ageMs}
          onOpenSearch={() => setSheet('search')}
          onOpenSettings={() => setSheet('settings')}
        />

        <RouteSheet
          snap={effectiveSnap}
          onSnap={setSheetSnap}
          labelledBy="routes-heading"
          tallRows={Boolean(cached)}
        >
          <div id="results">
            <h2 id="routes-heading" className="visually-hidden">
              Routes
            </h2>

            {/* Peek is exactly three route rows and nothing else — that is the
                whole point of the snap, and the gate measures it. A banner
                above them costs one route. The exception is when the banner IS
                the answer: an error, or nothing routed at all. */}
            {(showChrome || !hasRoutes || state.phase === 'error') && (
              <StatusBanner
                phase={state.phase}
                progress={state.progress}
                error={state.error}
                routes={state.routes}
                onRetry={() => dispatch({ type: 'retry' })}
                onMoreTime={() =>
                  dispatch({ type: 'minutes', value: Math.min(MAX_MINUTES, state.minutes + 30) })
                }
              />
            )}

            {/* The long form of the saved-copy notice: what in this answer has
                stopped being true, which a chip has no room for. Gated with the
                rest of the chrome, because peek is three route rows and nothing
                else — the short form travels to peek instead, on the rows
                themselves and on the pill under the top bar. */}
            {showChrome && cached && <OfflineBar ageMs={ageMs} online={online} />}

            {showChrome && <BetterLater when={state.bestDeparture} reason={state.reason} />}

            <RouteList
              routes={state.routes}
              selected={state.selected}
              snap={effectiveSnap}
              onSelect={onSelect}
              skeletonCount={loading ? state.objectives.length : 0}
              origin={state.origin}
              dest={state.dest}
              cacheAgeMs={ageMs}
            />

            {showChrome && hasRoutes && (
              <ShareButton
                origin={state.origin}
                dest={state.dest}
                minutes={state.minutes}
                mode={state.mode}
                objectives={state.objectives}
              />
            )}

            {showChrome && <Footer />}
          </div>
        </RouteSheet>

        <ControlsSheet
          open={sheet === 'search'}
          title="Where are you starting?"
          onClose={() => setSheet(null)}
        >
          <Controls
            section="places"
            origin={state.origin}
            dest={state.dest}
            locating={state.phase === 'locating'}
            geoDenied={state.geoDenied}
            onOrigin={(value) => dispatch({ type: 'origin', value })}
            onDest={(value) => dispatch({ type: 'dest', value })}
            onLocate={onLocate}
          />
        </ControlsSheet>

        <ControlsSheet
          open={sheet === 'settings'}
          title="How long, and how"
          onClose={() => setSheet(null)}
        >
          <Controls
            section="options"
            minutes={state.minutes}
            mode={state.mode}
            effectiveMode={mode}
            objectives={state.objectives}
            droppedObjective={state.droppedObjective}
            onMinutes={(value) => dispatch({ type: 'minutes', value })}
            onMode={(value) => dispatch({ type: 'mode', value })}
            onToggleObjective={onToggleObjective}
          />
        </ControlsSheet>
      </main>
    </div>
  )
}

function Footer() {
  return (
    <footer className="footer">
      <p>
        Map data © <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>{' '}
        contributors · tiles by <a href="https://openfreemap.org/">OpenFreeMap</a> · imagery
        from <a href="https://www.mapillary.com/">Mapillary</a> (CC BY-SA) · weather and air
        quality from <a href="https://open-meteo.com/">Open-Meteo</a>.
      </p>
      <p>
        Accessibility answers are only as good as OpenStreetMap tagging where you are. Every
        route says how much of it was actually verified. Where it says the data is unverified,
        it means it.
      </p>
    </footer>
  )
}
