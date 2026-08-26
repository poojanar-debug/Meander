import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react'

import { buildRouteRequest, fetchRoutes, usingMockApi } from './api/client.js'
import FollowMode from './components/FollowMode.jsx'
import MapView from './components/MapView.jsx'
import PlaceSearch from './components/PlaceSearch.jsx'
import PlanCapsule from './components/PlanCapsule.jsx'
import PlanSheet from './components/PlanSheet.jsx'
import Ribbon from './components/Ribbon.jsx'
import RouteDetail from './components/RouteDetail.jsx'
import RouteRail from './components/RouteRail.jsx'
import Sheet from './components/Sheet.jsx'
import StatusBanner from './components/StatusBanner.jsx'
import { DEFAULT_BASEMAP, streamsWhileFollowing } from './lib/basemap.js'
import { announceRoutes, announceSelection, effectiveMode } from './lib/format.js'
import { haversineM } from './lib/follow.js'
import { useFollowTracking } from './lib/followTracking.js'
import { MOBILE_LAYOUT, useMatchMedia } from './lib/media.js'
import { cacheAgeMs, formatCacheAge } from './lib/offline.js'
import { GEOLOCATED, decodeState, writeUrl } from './lib/permalink.js'
import { initialUnits } from './lib/units.js'

const MIN_MINUTES = 20
const MAX_MINUTES = 360

const initialState = {
  phase: 'idle', // idle | locating | loading | success | error
  minutes: 35,
  mode: 'auto',
  objectives: ['fastest', 'scenic', 'accessible'],
  origin: null,
  dest: null,
  routes: [],
  progress: null,
  cache: null,
  reason: null,
  bestDeparture: null,
  // When the user has picked a departure hour. Null means "now", which is
  // what the backend assumes when depart_at is absent.
  departAt: null,
  error: null,
  geoDenied: false,
  // Bumped by anything that should trigger a refetch; the effect keys on it.
  //
  // In this design that is exactly three things: pressing Find routes,
  // pressing Try again, and arriving through a permalink (init seeds 1).
  // Editing the plan changes state and nothing else — the capsule and the
  // sheet both carry an explicit primary action, and a request the user did
  // not ask for would spend routing credits narrating a half-finished
  // thought.
  nonce: 0,
  // One sentence explaining something an incoming link could not be honoured
  // verbatim. Null in every other case.
  linkNote: null,
}

/** Resolved at mount rather than at module load, so the read is not a side
 *  effect of importing this file. */
function init(state) {
  const shared = decodeState()
  if (!shared) return state

  const { expiredDeparture, ...fields } = shared
  // nonce 1 rather than 0: the fetch effect ignores 0, because nothing has been
  // asked for yet — and a link *is* a request. Seeding it here rather than
  // dispatching from an effect is what keeps the fetch effect untouched; the
  // alternative routes the defaults first and then routes again, spending two
  // requests and briefly showing the wrong answer. phase is seeded so the
  // cards show the right number of skeletons instead of one empty paint.
  return {
    ...state,
    ...fields,
    phase: 'loading',
    nonce: 1,
    linkNote: expiredDeparture
      ? 'That link asked to leave at a time that has already passed. These routes are for leaving now.'
      : null,
  }
}

/**
 * A route with the replay stamp removed.
 *
 * ⚠ **A spread cannot clear a key the incoming object does not have.** A
 * replayed route carries `servedFromCache: true` and `cachedAt`; a live SSE
 * route carries neither, so `{ ...old, ...new }` keeps the old stamp and the
 * new distance. Simulated: merging a live `{id:'fastest', distance_m:2450}`
 * over a replayed one yields the new distance and the old timestamp, and fresh
 * data is then announced as a saved copy.
 *
 * `cacheStamp` derives the replay-ness from the routes precisely so it cannot
 * drift from what is on screen — which only holds if the routes themselves are
 * honest. Merging onto a stamp-free base is what makes that true.
 */
function stampFree(route) {
  const { servedFromCache, cachedAt, ...rest } = route
  return rest
}

/**
 * Is what we are looking at a replay, and from when.
 *
 * Derived from the routes rather than held in the reducer, so it cannot drift
 * from what is on screen — and the moment a live route arrives the stamp is
 * gone with no separate state to remember to clear.
 */
function cacheStamp(routes) {
  const hit = routes.find((route) => route.servedFromCache)
  return hit ? { cachedAt: hit.cachedAt ?? null } : null
}

function withRefetch(state, patch) {
  return { ...state, ...patch, nonce: state.nonce + 1, error: null, linkNote: null }
}

function reducer(state, action) {
  switch (action.type) {
    case 'minutes':
      return {
        ...state,
        minutes: Math.min(MAX_MINUTES, Math.max(MIN_MINUTES, action.value)),
        linkNote: null,
      }

    case 'mode':
      return { ...state, mode: action.value, linkNote: null }

    case 'toggleObjective': {
      const present = state.objectives.includes(action.value)
      // Never allow zero: a route list with nothing in it is not a state the
      // user can recover from without guessing.
      if (present && state.objectives.length === 1) return state
      // The limit is real — the API accepts at most three objectives — so the
      // refusal is honest; being silent about it would not be.
      // `onToggleObjective` in App reads the same condition and says so.
      if (!present && state.objectives.length >= 3) return state
      const next = present
        ? state.objectives.filter((o) => o !== action.value)
        : [...state.objectives, action.value]
      return { ...state, objectives: next, linkNote: null }
    }

    case 'origin':
      // The phase is cleared when the fix lands, which it was not: `locating`
      // was set by the button and nothing ever unset it, so "Finding you…"
      // stayed under a field already showing the place it had found, until
      // Find routes moved the phase on. Same shape as `geoDenied` below, and
      // for the same reason: this is the answer to the question `locating`
      // asked, so it is what ends it.
      return {
        ...state,
        origin: action.value,
        phase:
          state.phase === 'locating' ? (state.routes.length ? 'success' : 'idle') : state.phase,
        geoDenied: false,
        linkNote: null,
      }

    case 'dest':
      return { ...state, dest: action.value, linkNote: null }

    // Find routes, and Try again: the two buttons that actually ask.
    case 'retry':
      return withRefetch(state, {})

    case 'departAt':
      return { ...state, departAt: action.value, linkNote: null }

    case 'locating':
      return { ...state, phase: 'locating', geoDenied: false }

    case 'geoDenied':
      return { ...state, phase: state.routes.length ? 'success' : 'idle', geoDenied: true }

    case 'loading':
      // Routes are deliberately preserved: the previous answer stays on
      // screen and interactive until the new one lands.
      return { ...state, phase: 'loading', progress: null, error: null }

    case 'progress':
      return { ...state, progress: action.value }

    case 'route': {
      // Merge by id, never append — the same id arrives up to three times as
      // narration and enrichment land on a route already on screen.
      const incoming = action.value
      const index = state.routes.findIndex((r) => r.id === incoming.id)
      const routes =
        index === -1
          ? [...state.routes, incoming]
          : state.routes.map((r) =>
              r.id === incoming.id ? { ...stampFree(r), ...incoming } : r,
            )
      // Routes for objectives the user has since removed are dropped rather
      // than merely re-ordered: a route for a chip that is no longer pressed
      // is an answer to a question nobody is asking. `indexOf` returns -1 for
      // an id no longer in the list and -1 sorts before 0, so the rank
      // function pins unknown ids to the bottom instead.
      const live = routes.filter((r) => state.objectives.includes(r.id))
      const rank = (id) => {
        const i = state.objectives.indexOf(id)
        return i === -1 ? Number.MAX_SAFE_INTEGER : i
      }
      const ordered = [...live].sort((a, b) => rank(a.id) - rank(b.id))
      return { ...state, routes: ordered }
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

    case 'error':
      return { ...state, phase: 'error', progress: null, error: action.value }

    default:
      return state
  }
}

export default function App() {
  const [state, dispatch] = useReducer(reducer, initialState, init)

  // --- state the reducer deliberately does not hold ------------------------
  //
  // Selection, units and the follow id are display state: none of them may
  // ever cost a request, so none of them lives where a request could key on
  // it. The follow-mode internals — the watch, the anchor, the off-route
  // clock, the passed-barrier set, the wake lock — live one level further
  // down, inside useFollowTracking.
  const [selected, setSelected] = useState(null)
  const [units] = useState(initialUnits)
  // Which basemap the map is drawn on.
  //
  // **Deliberately not persisted, and that is a rule rather than an
  // oversight.** RELEASE-SPECS R4 states it in as many words: localStorage is
  // theme and units ONLY, and `offlineStore.js` records what happened the last
  // time a third key was ported in. So the choice lasts a session. The cost is
  // that someone who prefers satellite re-picks it each visit; the alternative
  // is a third key and a promise this app makes in its own UI going quietly
  // false.
  //
  // It lives here rather than in MapView because FollowMode reads it too: the
  // provenance sentence printed while somebody walks is only true for the
  // basemaps that fetch nothing.
  const [layer, setLayer] = useState(DEFAULT_BASEMAP)
  const [follow, setFollow] = useState(null)
  const [detailOpen, setDetailOpen] = useState(false)
  // Which stretch of the selected route the map should emphasise, from the
  // step under the cursor. It changes on every mousemove across a list and
  // has no business near the fetch effect.
  const [highlight, setHighlight] = useState(null)
  // A blocker the user asked to see on the map: {lon, lat, seq}.
  const [focusPoint, setFocusPoint] = useState(null)
  // Mobile surfaces: which field the full-screen place search is editing, how
  // the sheet is snapped, and whether the plan is being held open over
  // results.
  //
  // `searchFor` is 'origin', 'dest' or null for "not open". It was a boolean
  // while there was only one field to search for; a boolean cannot say which
  // end of the trip is being typed, and both the screen's accessible name and
  // the place it writes the pick back to depend on that.
  const [searchFor, setSearchFor] = useState(null)
  const [planOverride, setPlanOverride] = useState(false)
  const [snap, setSnap] = useState('full')

  // `{ text, seq }` rather than a bare string, and the seq is the whole
  // reason. React bails out of a re-render when the new state is
  // `Object.is`-equal to the old, so setting the same sentence twice never
  // mutates the text node and no assistive technology fires — "GPX file
  // saved." twice in a row, announced once. Bumping a counter alongside the
  // text makes every announcement a distinct value while the rendered string
  // stays the sentence.
  const [announcement, setAnnouncement] = useState({ text: '', seq: 0 })
  const abortRef = useRef(null)
  // Read by the nonce-keyed effect below. A ref, not a dependency: adding
  // units to that dep array would re-fire the fetch on a unit change.
  const unitsRef = useRef(units)
  const announceTimer = useRef(null)

  const isMobile = useMatchMedia(MOBILE_LAYOUT)

  // The straight line to the destination, which is what resolves `auto` once
  // there is one. Null for a loop, which puts effectiveMode back on the time
  // ladder. A destination now arrives from the plan surfaces as well as from a
  // permalink; both are the same request and get the same answer.
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

  /** Debounced so a slider drag does not flood the live region. */
  const announce = useCallback((text) => {
    if (!text) return
    clearTimeout(announceTimer.current)
    announceTimer.current = setTimeout(
      () => setAnnouncement((prev) => ({ text, seq: prev.seq + 1 })),
      350,
    )
  }, [])

  /**
   * The same region, without the wait. A turn instruction is not a value
   * being scrubbed, it is a thing to do, and collapsing two of them loses
   * one. Follow mode announces through here so it keeps the app's single
   * voice without inheriting a cadence written for a slider.
   */
  const announceNow = useCallback((text) => {
    if (!text) return
    clearTimeout(announceTimer.current)
    setAnnouncement((prev) => ({ text, seq: prev.seq + 1 }))
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
    }, 0)

    return () => clearTimeout(timer)
    // Only `nonce` should retrigger: the two buttons that ask bump it, and
    // reading the other values here would fire requests nobody pressed for.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.nonce])

  useEffect(() => {
    unitsRef.current = units
  }, [units])

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
      departAt: state.departAt,
    })
  }, [state.origin, state.dest, state.minutes, state.mode, state.objectives, state.departAt])

  // --- selection, outside the reducer --------------------------------------

  // Selection follows the routes rather than being repaired inside the
  // reducer: whenever the current selection stops existing, the first
  // routable route wins, then the first route, then nothing.
  useEffect(() => {
    if (selected && state.routes.some((r) => r.id === selected)) return
    const firstRoutable = state.routes.find((r) => r.status === 'ok')
    setSelected((firstRoutable ?? state.routes[0])?.id ?? null)
  }, [state.routes, selected])

  const hasRoutes = state.routes.length > 0
  const selectedRoute = state.routes.find((r) => r.id === selected) ?? null
  const followRoute = follow ? (state.routes.find((r) => r.id === follow) ?? null) : null
  const isLoop = !state.dest

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
      // Desktop: first click selects, a click on the already-selected card
      // opens the detail. Mobile: one tap does both — the sheet metaphor
      // reads a card tap as "show me this one".
      if (isMobile || id === selected) setDetailOpen(true)
      setSelected(id)
      const route = state.routes.find((r) => r.id === id)
      announce(announceSelection(route, units))
    },
    [state.routes, units, announce, isMobile, selected],
  )

  const onToggleObjective = useCallback(
    (id) => {
      // Read before the dispatch, because the reducer is where the refusal
      // happens and it cannot speak.
      const pressed = state.objectives.includes(id)
      if (!pressed && state.objectives.length >= 3) {
        announce('Three route types at a time. Unpress one to choose another.')
        return
      }
      dispatch({ type: 'toggleObjective', value: id })
      announce('Objectives changed.')
    },
    [state.objectives, announce],
  )

  // A destination is only ever a place picked from search. There is no
  // "use my location" beside it, and that is a load-bearing absence rather
  // than an omission: `resultsStore.js` hashes the destination byte-exact
  // while the origin has to be snapped to a grid, precisely because a device
  // fix cannot reach this field.
  const onDest = useCallback(
    (place) => {
      dispatch({ type: 'dest', value: place })
      announce(
        place
          ? `Going to ${place.name}. The destination sets how long this takes.`
          : 'Round trip. Meander will bring you back to where you started.',
      )
    },
    [announce],
  )

  const onFind = useCallback(() => {
    setPlanOverride(false)
    setDetailOpen(false)
    setSnap('half')
    dispatch({ type: 'retry' })
  }, [])

  const onBlockerFocus = useCallback(
    (blocker) => {
      setFocusPoint((prev) => ({
        lon: blocker.lon,
        lat: blocker.lat,
        seq: (prev?.seq ?? 0) + 1,
      }))
      // On a phone the sheet owns most of the viewport; showing the barrier
      // means getting out of its way.
      if (isMobile) setSnap('peek')
    },
    [isMobile],
  )

  // --- follow mode ---------------------------------------------------------

  // One watch, one position, read by both the overlay and the map. Passing
  // null starts nothing.
  const tracking = useFollowTracking(followRoute)

  const returnFocusRef = useRef(null)

  const onStartFollow = useCallback((id, trigger) => {
    // The button that opened follow mode, passed explicitly rather than read
    // off `document.activeElement`: they are NOT the same after a touch tap
    // in Safari, which fires the click without moving focus — so the read
    // would quietly return `<body>` on exactly the devices this is for.
    returnFocusRef.current = trigger ?? document.activeElement
    setFollow(id)
  }, [])

  const onExitFollow = useCallback(() => {
    setFollow(null)
    const target = returnFocusRef.current
    returnFocusRef.current = null
    // After the unmount, or the focus call lands on an element the browser
    // still considers unfocusable. setTimeout rather than rAF: rAF does not
    // run in a hidden tab, and a walk that ends with the phone locked would
    // leave focus on `<body>`.
    setTimeout(() => {
      if (target?.isConnected) target.focus()
    }, 0)
  }, [])

  // Follow mode covers the whole viewport in this design, so it is modal at
  // every width: Escape leaves, Tab cycles inside the stage. The plan,
  // results and detail surfaces are simply not rendered while it runs, so
  // there is nothing behind it to inert.
  const stageRef = useRef(null)

  useEffect(() => {
    if (!followRoute) return undefined
    const layer = stageRef.current

    const onKeyDown = (event) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        onExitFollow()
        return
      }
      if (event.key !== 'Tab' || !layer) return
      const focusable = [
        ...layer.querySelectorAll(
          'button:not([disabled]), a[href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
        ),
      ].filter((el) => el.offsetWidth > 0 || el.offsetHeight > 0)
      if (!focusable.length) return
      const first = focusable[0]
      const last = focusable[focusable.length - 1]
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first.focus()
      } else if (!layer.contains(document.activeElement)) {
        event.preventDefault()
        first.focus()
      }
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [followRoute, onExitFollow])

  // Follow mode is not allowed to survive its own route disappearing. A
  // refetch can return a set without this id, and the overlay would be
  // walking a route that no longer exists.
  useEffect(() => {
    if (!follow) return
    if (state.routes.some((r) => r.id === follow)) return
    setFollow(null)
    announceNow('That route is no longer available, so following it has stopped.')
  }, [follow, state.routes, announceNow])

  // --- composition ---------------------------------------------------------

  const following = Boolean(followRoute)
  const showPlan = !following && (planOverride || (!hasRoutes && state.phase !== 'loading'))
  const loading = state.phase === 'loading'

  const planProps = {
    origin: state.origin,
    dest: state.dest,
    minutes: state.minutes,
    mode: state.mode,
    effectiveMode: mode,
    objectives: state.objectives,
    locating: state.phase === 'locating',
    geoDenied: state.geoDenied,
    onLocate,
    onMinutes: (value) => dispatch({ type: 'minutes', value }),
    onMode: (value) => dispatch({ type: 'mode', value }),
    onToggleObjective,
    onDest,
    onFind,
  }

  // The demonstration-data strip claims the top edge when it renders, and
  // every top-anchored layer shifts down under it — see .app--demo in the
  // stylesheet. Mirrors Ribbon's own render condition.
  const demo = usingMockApi() || state.routes.some((route) => route.synthetic_upstream === true)

  return (
    <div className={demo ? 'app app--demo' : 'app'}>
      {hasRoutes && !following && (
        <a className="skip-link" href="#results">
          Skip to the routes
        </a>
      )}

      {/* One polite live region for the whole app. */}
      <p className="visually-hidden" role="status" aria-live="polite">
        {announcement.text}
      </p>

      <Ribbon routes={state.routes} />

      <div className={following && isMobile ? 'stage stage--following' : 'stage'} ref={stageRef}>
        <MapView
          routes={state.routes}
          selected={selected}
          origin={state.origin}
          dest={state.dest}
          highlight={highlight}
          focus={detailOpen && Boolean(selectedRoute)}
          focusPoint={focusPoint}
          onSelect={onSelect}
          follow={followRoute ? { route: followRoute, tracking } : null}
          layer={layer}
          onLayer={setLayer}
        />

        {followRoute && (
          <FollowMode
            route={followRoute}
            units={units}
            isLoop={isLoop}
            tracking={tracking}
            onExit={onExitFollow}
            onAnnounce={announceNow}
            basemapStreams={streamsWhileFollowing(layer)}
          />
        )}
      </div>

      {/* ---------------- desktop: capsule, results row, modal ------------- */}
      {!isMobile && !following && (
        <>
          <PlanCapsule
            {...planProps}
            onOrigin={(value) => dispatch({ type: 'origin', value })}
          />

          {state.linkNote && <p className="linknote">{state.linkNote}</p>}
          <StatusBanner error={state.error} onRetry={() => dispatch({ type: 'retry' })} />

          {(hasRoutes || loading) && (
            <RouteRail
              routes={state.routes}
              objectives={state.objectives}
              selected={selected}
              loading={loading}
              progress={state.progress}
              reason={state.reason}
              isLoop={isLoop}
              units={units}
              onSelect={onSelect}
              onBlockerFocus={onBlockerFocus}
            />
          )}

          {detailOpen && selectedRoute && (
            <RouteDetail
              // Remounts on a route change, so nothing keeps state across
              // routes — a barrier reporter dragged to 3 km must not survive
              // into a 1 km route.
              key={selectedRoute?.id ?? 'none'}
              route={selectedRoute}
              origin={state.origin}
              dest={state.dest}
              units={units}
              isLoop={isLoop}
              mobile={false}
              bestDeparture={state.bestDeparture}
              reason={state.reason}
              onClose={() => setDetailOpen(false)}
              onStart={onStartFollow}
              onHighlight={setHighlight}
              onAnnounce={announce}
            />
          )}
        </>
      )}

      {/* ---------------- mobile: one sheet, three contents ---------------- */}
      {isMobile && !following && (
        <>
          {state.linkNote && <p className="linknote">{state.linkNote}</p>}
          <StatusBanner error={state.error} onRetry={() => dispatch({ type: 'retry' })} />

          {searchFor ? (
            <PlaceSearch
              key={searchFor}
              field={searchFor}
              value={null}
              onPick={(place) => {
                if (searchFor === 'dest') onDest(place)
                else dispatch({ type: 'origin', value: place })
                setSearchFor(null)
              }}
              onCancel={() => setSearchFor(null)}
            />
          ) : detailOpen && selectedRoute ? (
            <Sheet
              snap={snap}
              onSnap={(next) => {
                if (next === 'peek') {
                  // Dragging the detail all the way down is leaving it; the
                  // results sheet comes back at its resting height.
                  setDetailOpen(false)
                  setSnap('half')
                } else {
                  setSnap(next)
                }
              }}
              label={`${selectedRoute.label} route detail`}
            >
              <RouteDetail
                key={selectedRoute?.id ?? 'none'}
                route={selectedRoute}
                origin={state.origin}
                dest={state.dest}
                units={units}
                isLoop={isLoop}
                mobile
                bestDeparture={state.bestDeparture}
                reason={state.reason}
                onClose={() => setDetailOpen(false)}
                onStart={onStartFollow}
                onHighlight={setHighlight}
                onAnnounce={announce}
              />
            </Sheet>
          ) : showPlan ? (
            <Sheet snap={snap} onSnap={setSnap} label="Plan a route">
              <PlanSheet
                {...planProps}
                departAt={state.departAt}
                units={units}
                onDepartAt={(value) => dispatch({ type: 'departAt', value })}
                onOpenSearch={() => setSearchFor('origin')}
                onOpenDestSearch={() => setSearchFor('dest')}
                onClearDest={() => onDest(null)}
              />
            </Sheet>
          ) : (
            <Sheet snap={snap} onSnap={setSnap} label="Routes">
              <div className="rail__plan-row">
                <span className="mono rail__plan-summary">
                  {isLoop ? `${state.minutes} min` : `to ${state.dest.name}`} ·{' '}
                  {state.mode === 'auto' ? 'Auto' : mode}
                </span>
                <button
                  type="button"
                  className="rail__edit"
                  onClick={() => {
                    setPlanOverride(true)
                    setSnap('full')
                  }}
                >
                  Edit plan
                </button>
              </div>
              <RouteRail
                routes={state.routes}
                objectives={state.objectives}
                selected={selected}
                loading={loading}
                progress={state.progress}
                reason={state.reason}
                isLoop={isLoop}
                units={units}
                compact
                onSelect={(id) => {
                  onSelect(id)
                  setSnap('full')
                }}
                onBlockerFocus={onBlockerFocus}
              />
            </Sheet>
          )}
        </>
      )}

      {/* Keep the plan reachable while results are up: opening it again is a
          override, not a reset — the routes stay for the way back. */}
      {isMobile && !following && showPlan && hasRoutes && (
        <button
          type="button"
          className="plan__back pill"
          onClick={() => setPlanOverride(false)}
        >
          Back to routes
        </button>
      )}
    </div>
  )
}
