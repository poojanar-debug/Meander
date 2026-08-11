import { useCallback, useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState } from 'react'

import { buildRouteRequest, fetchRoutes } from './api/client.js'
import FirstRun from './components/FirstRun.jsx'
import About from './components/About.jsx'
import DaylightGuard from './components/DaylightGuard.jsx'
import DepartureStrip from './components/DepartureStrip.jsx'
import FollowMode from './components/FollowMode.jsx'
import MapView from './components/MapView.jsx'
import OfflineBar from './components/OfflineBar.jsx'
import RouteDetail from './components/RouteDetail.jsx'
import RouteRail from './components/RouteRail.jsx'
import StepList from './components/StepList.jsx'
import Ribbon from './components/Ribbon.jsx'
import StatusBanner from './components/StatusBanner.jsx'
import Topbar from './components/Topbar.jsx'
import ShareButton from './components/ShareButton.jsx'
import TakeItWithYou from './components/TakeItWithYou.jsx'
import TripBar from './components/TripBar.jsx'
import { announceRoutes, announceSelection, effectiveMode } from './lib/format.js'
import { haversineM } from './lib/follow.js'
import { applyTheme, initialTheme, readStoredTheme, storeTheme, systemTheme } from './lib/theme.js'
import { cacheAgeMs, formatCacheAge } from './lib/offline.js'
import { useCacheAge, useOnline } from './lib/offlineStore.js'
import { GEOLOCATED, decodeState, writeUrl } from './lib/permalink.js'
import {
  METRIC_24,
  clearStoredUnits,
  detectUnits,
  initialUnits,
  storeUnits,
} from './lib/units.js'

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
  departure: 200,
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
  // When the user has picked a departure hour. Null means "now", which is
  // what the backend assumes when depart_at is absent.
  departAt: null,
  error: null,
  geoDenied: false,
  // The id of the route being followed, or null. Deliberately outside
  // withRefetch: entering follow mode must never re-request anything.
  follow: null,
  // A display preference, not an input to the route request. It deliberately
  // does not live in `withRefetch`.
  theme: 'light',
  // The same, and for the same reason. The wire format is always metric; this
  // only decides how a distance is spelled on the way to the screen.
  units: METRIC_24,
  // Bumped by anything that should trigger a refetch; the effect keys on it.
  nonce: 0,
  debounceMs: 0,
  // One sentence explaining something an incoming link could not be honoured
  // verbatim. Null in every other case.
  linkNote: null,
}

/** Resolved at mount rather than at module load, so the read is not a side
 *  effect of importing this file. */
function init(state) {
  const seeded = { ...state, theme: initialTheme(), units: initialUnits() }
  const shared = decodeState()
  if (!shared) return seeded

  const { expiredDeparture, ...fields } = shared
  // nonce 1 rather than 0: the fetch effect ignores 0, because nothing has been
  // asked for yet — and a link *is* a request. Seeding it here rather than
  // dispatching from an effect is what keeps the fetch effect untouched; the
  // alternative routes the defaults first and then routes again, spending two
  // requests and briefly showing the wrong answer. phase is seeded so the rail
  // shows the right number of skeletons instead of one empty paint.
  return {
    ...seeded,
    ...fields,
    phase: 'loading',
    nonce: 1,
    debounceMs: 0,
    linkNote: expiredDeparture
      ? 'That link asked to leave at a time that has already passed. These routes are for leaving now.'
      : null,
  }
}

/**
 * Is what we are looking at a replay, and from when.
 *
 * Derived from the routes rather than held in the reducer, so it cannot drift
 * from what is on screen — and the moment a live route arrives the stamp is
 * gone with no separate state to remember to clear. That is why this capability
 * adds no reducer case, no DEBOUNCE key and no initialState field.
 */
function cacheStamp(routes) {
  const hit = routes.find((route) => route.servedFromCache)
  return hit ? { cachedAt: hit.cachedAt ?? null } : null
}

function withRefetch(state, patch, debounceMs) {
  return { ...state, ...patch, nonce: state.nonce + 1, debounceMs, error: null, linkNote: null }
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

    case 'departAt':
      return withRefetch(state, { departAt: action.value }, DEBOUNCE.departure)

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

    // Neither of these goes through withRefetch: units are a display
    // preference, so changing them must never cost a request.
    case 'units':
      return { ...state, units: { ...state.units, ...action.value, chosen: true } }
    case 'unitsCleared':
      return { ...state, units: detectUnits() }

    // Follow mode reads geometry the app already has. It does not fetch, and it
    // must not run through the nonce effect.
    case 'follow':
      return { ...state, follow: action.value }

    default:
      return state
  }
}

export default function App() {
  const [state, dispatch] = useReducer(reducer, initialState, init)
  const [announcement, setAnnouncement] = useState('')
  // Which stretch of the selected route the map should emphasise, from the step
  // under the cursor. Local state, not reducer state: it changes on every
  // mousemove across a list and has no business triggering the fetch effect.
  const [highlight, setHighlight] = useState(null)
  const abortRef = useRef(null)
  // Read by the nonce-keyed effect below. A ref, not a dependency: adding
  // state.units to that dep array would re-fire every fetch on a unit change.
  const unitsRef = useRef(initialState.units)
  const announceTimer = useRef(null)
  const aboutRef = useRef(null)
  const online = useOnline()

  // The straight line to the destination, which is what resolves `auto` once
  // there is one — the dial does not describe a trip whose ends are both fixed.
  // Null for a loop, which is what puts effectiveMode back on the time ladder.
  const straightLineM = useMemo(
    () =>
      state.dest && state.origin
        ? haversineM([state.origin.lon, state.origin.lat], [state.dest.lon, state.dest.lat])
        : null,
    [state.origin, state.dest],
  )

  const mode = useMemo(
    () => effectiveMode(state.mode, state.minutes, straightLineM),
    [state.mode, state.minutes, straightLineM],
  )

  const cached = useMemo(() => cacheStamp(state.routes), [state.routes])
  const ageMs = useCacheAge(cached?.cachedAt)

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
            departAt: state.departAt,
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
        const settled = payload?.routes ?? arrived
        const replay = cacheStamp(settled)
        const preamble = replay
          ? `Showing a saved copy from ${formatCacheAge(cacheAgeMs(replay.cachedAt))}. `
          : ''
        announce(preamble + announceRoutes(settled, unitsRef.current))
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

  useEffect(() => {
    unitsRef.current = state.units
  }, [state.units])

  useEffect(() => () => abortRef.current?.abort(), [])

  // The address bar follows the controls. replaceState, never pushState — a
  // slider drag would otherwise put fifty entries behind the back button.
  // Deliberately its own effect: folding it into the fetch effect would mean
  // adding these six values to that dependency array, which is exactly what the
  // comment there forbids.
  useEffect(() => {
    writeUrl({
      origin: state.origin,
      dest: state.dest,
      minutes: state.minutes,
      mode: state.mode,
      objectives: state.objectives,
      departAt: state.departAt,
    })
  }, [state.origin, state.dest, state.minutes, state.mode, state.objectives, state.departAt])

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

  // Persist on the way in, exactly as onTheme does. `patch` is one field, so
  // the stored object is rebuilt from current state rather than from the patch.
  const onUnits = useCallback(
    (patch) => {
      const next = { ...state.units, ...patch, chosen: true }
      storeUnits(next)
      dispatch({ type: 'units', value: patch })
    },
    [state.units],
  )

  // The escape hatch: drop the key and fall back to what the device implies.
  const onClearUnits = useCallback(() => {
    clearStoredUnits()
    dispatch({ type: 'unitsCleared' })
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
            name: GEOLOCATED,
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
      announce(announceSelection(route, state.units))
    },
    [state.routes, state.units, announce],
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
  const followRoute = state.follow
    ? (state.routes.find((r) => r.id === state.follow) ?? null)
    : null

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

      {cached && <OfflineBar ageMs={ageMs} online={online} />}

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
            units={state.units}
            onUnits={onUnits}
            onClearUnits={onClearUnits}
          />

          <DepartureStrip
            bestDeparture={state.bestDeparture}
            reason={state.reason}
            origin={state.origin}
            departAt={state.departAt}
            units={state.units}
            onDepartAt={(value) => dispatch({ type: 'departAt', value })}
          />

          {/* Outside DepartureStrip deliberately: that component returns null
              whenever there is no best departure, which is the common case, so
              anything mounted inside it disappears. */}
          {state.linkNote && <p className="field__hint">{state.linkNote}</p>}

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

            {state.reason && !state.bestDeparture && (
              <p className="field__hint">{state.reason}</p>
            )}

            <RouteRail
              routes={state.routes}
              selected={state.selected}
              theme={state.theme}
              loading={state.phase === 'loading'}
              expected={state.objectives.length}
              units={state.units}
              cacheAgeMs={ageMs}
              onSelect={onSelect}
            />

            <RouteDetail
              route={selectedRoute}
              theme={state.theme}
              units={state.units}
              cacheAgeMs={ageMs}
              takeaway={
                <TakeItWithYou
                  route={selectedRoute}
                  origin={state.origin}
                  dest={state.dest}
                  onAnnounce={announce}
                />
              }
              stepList={
                <StepList route={selectedRoute} units={state.units} onHighlight={setHighlight} />
              }
              onStart={(id) => dispatch({ type: 'follow', value: id })}
            >
              <DaylightGuard
                route={selectedRoute}
                origin={state.origin}
                departAt={state.departAt}
                units={state.units}
                onMinutes={(value) => dispatch({ type: 'minutes', value })}
                onDepartAt={(value) => dispatch({ type: 'departAt', value })}
              />
            </RouteDetail>

            {hasRoutes && (
              <ShareButton
                origin={state.origin}
                dest={state.dest}
                minutes={state.minutes}
                mode={state.mode}
                objectives={state.objectives}
                departAt={state.departAt}
                onAnnounce={announce}
              />
            )}
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
              highlight={highlight}
              onSelect={onSelect}
            />
          )}

          {/* The sheet is not a modal: the map underneath stays reachable. */}
          {followRoute && (
            <FollowMode
              route={followRoute}
              units={state.units}
              onExit={() => dispatch({ type: 'follow', value: null })}
              onAnnounce={announce}
            />
          )}
        </div>
      </div>
      )}
    </div>
  )
}
