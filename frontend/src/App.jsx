import { useCallback, useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState } from 'react'

import { buildRouteRequest, fetchRoutes } from './api/client.js'
import FirstRun from './components/FirstRun.jsx'
import About from './components/About.jsx'
import MapView from './components/MapView.jsx'
import RouteDetail from './components/RouteDetail.jsx'
import RouteRail from './components/RouteRail.jsx'
import Ribbon from './components/Ribbon.jsx'
import StatusBanner from './components/StatusBanner.jsx'
import Topbar from './components/Topbar.jsx'
import TripBar from './components/TripBar.jsx'
import { announceRoutes, announceSelection, effectiveMode } from './lib/format.js'
import { applyTheme, initialTheme, readStoredTheme, storeTheme, systemTheme } from './lib/theme.js'

const prefersReducedMotion = () =>
  window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true

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
  // A display preference, not an input to the route request. It deliberately
  // does not live in `withRefetch`.
  theme: 'light',
  // Bumped by anything that should trigger a refetch; the effect keys on it.
  nonce: 0,
  debounceMs: 0,
}

/** Resolved at mount rather than at module load, so the read is not a side
 *  effect of importing this file. */
function init(state) {
  return { ...state, theme: initialTheme() }
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
      return withRefetch(state, { objectives: next }, DEBOUNCE.objectives)
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

    // Not routed through withRefetch: changing the theme must never re-request
    // routes. It is a paint change and nothing else.
    case 'theme':
      return { ...state, theme: action.value }

    default:
      return state
  }
}

export default function App() {
  const [state, dispatch] = useReducer(reducer, initialState, init)
  const [announcement, setAnnouncement] = useState('')
  const abortRef = useRef(null)
  const announceTimer = useRef(null)
  const aboutRef = useRef(null)

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
        announce(announceRoutes(payload?.routes ?? arrived))
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

  // --- theme ---------------------------------------------------------------

  // index.html already painted the right theme before React existed; this keeps
  // the DOM in step once the user starts toggling.
  //
  // useLayoutEffect, not useEffect, and that is load-bearing. React runs every
  // child's passive effect before the parent's, so MapView's theme effect ran
  // *before* this one had flipped `data-theme` — it read the outgoing palette
  // out of getComputedStyle and repainted the basemap in the colours we were
  // leaving. Layout effects all run before any passive effect, so this now
  // lands first and the map reads the palette it is switching to.
  useLayoutEffect(() => {
    applyTheme(state.theme)
  }, [state.theme])

  // Follow the system only while the user has expressed no view of their own.
  // Someone who has explicitly chosen light should stay in light when their
  // laptop flips to dark at sunset.
  useEffect(() => {
    if (readStoredTheme()) return undefined
    const query = window.matchMedia?.('(prefers-color-scheme: dark)')
    if (!query) return undefined
    const onChange = () => {
      if (!readStoredTheme()) dispatch({ type: 'theme', value: systemTheme() })
    }
    query.addEventListener('change', onChange)
    return () => query.removeEventListener('change', onChange)
  }, [])

  const onTheme = useCallback((value) => {
    storeTheme(value)
    dispatch({ type: 'theme', value })
  }, [])

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
  const selectedRoute = state.routes.find((r) => r.id === state.selected) ?? null

  // The first-run card replaces panel and stage entirely (§7). Gating on
  // `origin` rather than on `routes` means the map is never created until there
  // is somewhere to draw — and once created it is never unmounted, which is the
  // single-MapLibre-instance rule the old build already held to.
  const firstRun = !state.origin && state.phase !== 'locating' && !hasRoutes

  // The About disclosure lives at the foot of a panel that scrolls, so the
  // topbar button has to open it *and* bring it into view. Opening alone would
  // look like nothing happened.
  const onAbout = useCallback(() => {
    const details = aboutRef.current
    if (!details) return
    details.open = true
    details.scrollIntoView({ behavior: prefersReducedMotion() ? 'auto' : 'smooth', block: 'end' })
    details.querySelector('summary')?.focus()
  }, [])

  return (
    <div className="app">
      <a className="skip-link" href="#results">
        Skip to the routes
      </a>

      {/* One polite live region for the whole app. */}
      <p className="visually-hidden" role="status" aria-live="polite">
        {announcement}
      </p>

      <Topbar theme={state.theme} onTheme={onTheme} onAbout={onAbout} />

      <Ribbon routes={state.routes} />

      {firstRun ? (
        <FirstRun
          minutes={state.minutes}
          origin={state.origin}
          locating={state.phase === 'locating'}
          geoDenied={state.geoDenied}
          onMinutes={(value) => dispatch({ type: 'minutes', value })}
          onOrigin={(value) => dispatch({ type: 'origin', value })}
          onLocate={onLocate}
        />
      ) : (
      <div className="layout">
        <main className="panel">
          <TripBar
            minutes={state.minutes}
            mode={state.mode}
            effectiveMode={mode}
            objectives={state.objectives}
            theme={state.theme}
            origin={state.origin}
            dest={state.dest}
            locating={state.phase === 'locating'}
            geoDenied={state.geoDenied}
            onMinutes={(value) => dispatch({ type: 'minutes', value })}
            onMode={(value) => dispatch({ type: 'mode', value })}
            onToggleObjective={onToggleObjective}
            onOrigin={(value) => dispatch({ type: 'origin', value })}
            onDest={(value) => dispatch({ type: 'dest', value })}
            onLocate={onLocate}
          />

          <div id="results">
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

            {state.reason && <p className="field__hint">{state.reason}</p>}

            <RouteRail
              routes={state.routes}
              selected={state.selected}
              theme={state.theme}
              loading={state.phase === 'loading'}
              expected={state.objectives.length}
              onSelect={onSelect}
            />

            <RouteDetail route={selectedRoute} theme={state.theme} />
          </div>

          <div className="panel__spacer" aria-hidden="true" />

          <About ref={aboutRef} cache={state.cache} />
        </main>

        <div className="stage">
          {hasRoutes && (
            <MapView
              routes={state.routes}
              selected={state.selected}
              origin={state.origin}
              dest={state.dest}
              theme={state.theme}
              onSelect={onSelect}
            />
          )}
        </div>
      </div>
      )}
    </div>
  )
}
