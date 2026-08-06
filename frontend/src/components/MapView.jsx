import maplibregl from 'maplibre-gl'
import { useCallback, useEffect, useRef, useState } from 'react'

import { routeColor, styleFor } from '../lib/dash.js'

const STYLE_URL = 'https://tiles.openfreemap.org/styles/positron'
const INITIAL_CENTER = [79.8521, 6.921]
const INITIAL_ZOOM = 12.6

// How long to wait for the basemap before giving up on it and showing the
// fallback. Deliberately generous: a cold tile CDN fetching style, sprites,
// glyphs and a first ring of vector tiles can take well over ten seconds on a
// slow connection, and flashing "the map could not load" at someone whose map
// is merely loading is worse than making them wait. This only needs to catch a
// map that is never coming — a blocked tile host, a CSP that forgot
// connect-src, a stalled worker — none of which resolve themselves.
const MAP_LOAD_TIMEOUT_MS = 20000

const prefersReducedMotion = () =>
  typeof window !== 'undefined' &&
  window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true

function boundsOf(coordinates) {
  return coordinates.reduce(
    (bounds, coord) => bounds.extend(coord),
    new maplibregl.LngLatBounds(coordinates[0], coordinates[0]),
  )
}

function markerElement(className, text, label) {
  const el = document.createElement('div')
  el.className = `marker ${className}`
  el.textContent = text
  el.setAttribute('role', 'img')
  el.setAttribute('aria-label', label)
  return el
}

/** Read a design token. MapLibre paints to a canvas and cannot resolve
 *  `var(--map-water)`, so every colour has to be handed over as a literal. */
function token(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim()
}

/**
 * Recolour the basemap to the §2.4 palette.
 *
 * OpenFreeMap ships no dark style, so rather than a second tile source the
 * existing style's layers are repainted in place — the option §2.4 offers first.
 * Layers are matched by id and source-layer rather than by a hard-coded list,
 * because the upstream style is not ours and its layer names change without
 * notice; a missing match must degrade to "that layer keeps its own colour",
 * never to a thrown error that takes the map down.
 */
function applyMapPalette(map) {
  const land = token('--map-land')
  const park = token('--map-park')
  const water = token('--map-water')
  const road = token('--map-road')
  const ink = token('--ink')
  const halo = token('--map-land')

  let layers
  try {
    layers = map.getStyle()?.layers ?? []
  } catch {
    return
  }

  for (const layer of layers) {
    const id = layer.id.toLowerCase()
    const source = (layer['source-layer'] ?? '').toLowerCase()
    const set = (prop, value) => {
      try {
        map.setPaintProperty(layer.id, prop, value)
      } catch {
        // The layer does not carry that paint property. Not an error.
      }
    }

    if (layer.type === 'background') {
      set('background-color', land)
    } else if (id.includes('water') || source.includes('water')) {
      if (layer.type === 'fill') set('fill-color', water)
      if (layer.type === 'line') set('line-color', water)
    } else if (
      id.includes('park') ||
      id.includes('wood') ||
      id.includes('grass') ||
      id.includes('forest') ||
      id.includes('landcover') ||
      id.includes('green')
    ) {
      if (layer.type === 'fill') set('fill-color', park)
    } else if (id.includes('building')) {
      if (layer.type === 'fill') set('fill-color', land)
    } else if (
      id.includes('road') ||
      id.includes('street') ||
      id.includes('highway') ||
      id.includes('bridge') ||
      id.includes('tunnel') ||
      source.includes('transportation')
    ) {
      if (layer.type === 'line') set('line-color', road)
    } else if (id.includes('landuse') || id.includes('landcover')) {
      if (layer.type === 'fill') set('fill-color', land)
    }

    if (layer.type === 'symbol') {
      set('text-color', ink)
      set('text-halo-color', halo)
    }
  }
}

/**
 * The map is an enhancement, never the only way to read a result.
 *
 * Everything drawn here is also written out in the route rail, and the app is
 * tested with this component removed from the DOM entirely. Markers carry real
 * `aria-label`s, but they are a convenience — the rail is the accessibility
 * story.
 *
 * Three things in here were bug fixes rather than choices, and are marked as
 * such below: the deferred creation that survives StrictMode, the load deadline
 * that only runs while the page is visible, and the `jump`-instead-of-`fly`
 * guard for a hidden tab. None of them should be tidied away.
 */
export default function MapView({ routes, selected, origin, dest, theme, highlight, onSelect }) {
  const containerRef = useRef(null)
  const mapRef = useRef(null)
  const markersRef = useRef([])
  const layerIdsRef = useRef([])
  const onSelectRef = useRef(onSelect)
  const [ready, setReady] = useState(false)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    onSelectRef.current = onSelect
  }, [onSelect])

  // --- map lifecycle -------------------------------------------------------

  useEffect(() => {
    if (!containerRef.current || mapRef.current) return undefined

    // Creation is deferred by one frame, and that is load-bearing.
    //
    // React StrictMode runs every effect twice in development: mount, clean up,
    // mount again, synchronously. Creating the map inline therefore builds one,
    // calls map.remove() on it while its workers are still starting, and builds
    // a second. MapLibre does not survive that — the second map loads its style
    // and its sprites and then requests no tiles at all, forever, with no error
    // event. The symptom is a blank basemap in `npm run dev` while the
    // production build works, which is a miserable thing to debug.
    //
    // Deferring past that synchronous cycle means the teardown cancels the
    // pending creation before any map exists, so exactly one is ever built.
    //
    // setTimeout rather than requestAnimationFrame: rAF does not fire at all in
    // a hidden tab, so opening the app in a background tab would leave the map
    // permanently uncreated rather than merely unpainted.
    let cancelled = false
    let map = null
    let deadline
    let observer
    let onVisibility
    let readyPoll

    const pending = setTimeout(() => {
      if (cancelled || !containerRef.current) return
      try {
        map = new maplibregl.Map({
          container: containerRef.current,
          style: STYLE_URL,
          center: INITIAL_CENTER,
          zoom: INITIAL_ZOOM,
          attributionControl: { compact: true },
        })
      } catch (err) {
        // WebGL unavailable, or the style host is blocked. The route rail still
        // carries the whole answer, so this degrades rather than breaking.
        console.warn('Meander: map could not start —', err)
        setFailed(true)
        return
      }
      start(map)
    }, 0)

    function start(map) {
      // A map that never finishes loading is the failure mode this has to
      // catch. MapLibre can sit in style-loading indefinitely — a blocked tile
      // host, a CSP missing connect-src, a stalled worker — and emits no
      // `error` for any of them. Without a deadline the user gets an
      // unexplained grey rectangle forever, which is worse than being told the
      // map is unavailable and pointed at the list that has the whole answer.
      // The deadline only runs while the page is actually visible. A hidden tab
      // does not render, so MapLibre legitimately never reaches `load`, and a
      // plain timer would blame the map for the browser's own power saving —
      // showing "the map could not load" on a tab nobody has looked at yet.
      let settled = false
      const startDeadline = () => {
        clearTimeout(deadline)
        deadline = setTimeout(() => {
          if (settled) return
          console.warn('Meander: map did not finish loading; falling back to the route list')
          setFailed(true)
        }, MAP_LOAD_TIMEOUT_MS)
      }
      if (!document.hidden) startDeadline()

      onVisibility = () => {
        if (!settled && !document.hidden) startDeadline()
      }
      document.addEventListener('visibilitychange', onVisibility)

      // `load` is not enough on its own, and relying on it alone cost an
      // afternoon. The basemap style is third party and can change without
      // notice: with the current OpenFreeMap positron, tiles render and
      // `areTilesLoaded()` is true, but `isStyleLoaded()` stays false forever
      // and `load` never fires — so every route layer was waiting on an event
      // that was never coming, and the map drew streets and nothing else.
      //
      // `idle` is the signal that actually means "rendering has settled and you
      // may add layers", and it fires whether or not the style ever declares
      // itself loaded. Both are wired, and readiness is idempotent, so
      // whichever arrives first wins and the second is a no-op.
      const markReady = () => {
        if (settled) return
        settled = true
        clearTimeout(deadline)
        clearInterval(readyPoll)
        applyMapPalette(map)
        setReady(true)
        setFailed(false)
      }
      map.on('load', markReady)
      map.on('idle', markReady)
      // Last resort, and the one that actually fires against the current
      // upstream style: poll until the style object exists and will accept a
      // source. `getStyle()` returning layers is the real precondition for
      // addSource/addLayer — `isStyleLoaded()` is a stricter claim that this
      // basemap never makes.
      readyPoll = setInterval(() => {
        if (settled) {
          clearInterval(readyPoll)
          return
        }
        try {
          if (map.getStyle()?.layers?.length) markReady()
        } catch {
          // Style not constructed yet. Try again on the next tick.
        }
      }, 250)
      map.on('error', (event) => {
        if (event?.error?.status === 404 || event?.error?.message?.includes('style')) {
          settled = true
          clearTimeout(deadline)
          setFailed(true)
        }
      })
      mapRef.current = map
      if (import.meta.env.DEV) window.__meanderMap = map

      // The container is sized by the layout grid and by the 900px breakpoint,
      // so it changes height without the window necessarily changing size — a
      // phone rotating, or a desktop crossing the breakpoint. MapLibre's own
      // trackResize did not pick that up here: the canvas kept its initial
      // height and left a band of empty container below it.
      observer = new ResizeObserver(() => map.resize())
      observer.observe(containerRef.current)
    }

    return () => {
      cancelled = true
      clearTimeout(pending)
      clearTimeout(deadline)
      clearInterval(readyPoll)
      if (onVisibility) document.removeEventListener('visibilitychange', onVisibility)
      observer?.disconnect()
      markersRef.current.forEach((m) => m.remove())
      markersRef.current = []
      map?.remove()
      mapRef.current = null
      setReady(false)
    }
  }, [])

  // --- theme ---------------------------------------------------------------

  useEffect(() => {
    const map = mapRef.current
    if (!map || !ready) return
    applyMapPalette(map)
  }, [theme, ready])

  // --- route layers --------------------------------------------------------

  useEffect(() => {
    const map = mapRef.current
    if (!map || !ready) return

    for (const id of layerIdsRef.current) {
      if (map.getLayer(`line-${id}`)) map.removeLayer(`line-${id}`)
      if (map.getLayer(`case-${id}`)) map.removeLayer(`case-${id}`)
      if (map.getSource(`route-${id}`)) map.removeSource(`route-${id}`)
    }
    for (const id of ['highlight', 'rest-stops']) {
      if (map.getLayer(id)) map.removeLayer(id)
      if (map.getSource(id)) map.removeSource(id)
    }

    const drawable = routes.filter((r) => r.geometry?.length > 1)
    layerIdsRef.current = drawable.map((r) => r.id)

    for (const route of drawable) {
      map.addSource(`route-${route.id}`, {
        type: 'geojson',
        data: {
          type: 'Feature',
          properties: { id: route.id, label: route.label },
          geometry: { type: 'LineString', coordinates: route.geometry },
        },
      })
    }

    // Cases first for every route, then lines, so one route's casing can never
    // paint over another route's line.
    for (const route of drawable) {
      map.addLayer({
        id: `case-${route.id}`,
        type: 'line',
        source: `route-${route.id}`,
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-color': token('--raised'), 'line-width': 7 },
      })
    }
    for (const route of drawable) {
      const style = styleFor(route.id)
      const paint = {
        'line-color': routeColor(route.id, theme),
        'line-width': 5,
        'line-opacity': 0.45,
      }
      const isSolid = style.dash.length === 2 && style.dash[1] === 0
      if (!isSolid) paint['line-dasharray'] = style.dash

      map.addLayer({
        id: `line-${route.id}`,
        type: 'line',
        source: `route-${route.id}`,
        layout: { 'line-cap': isSolid ? 'round' : 'butt', 'line-join': 'round' },
        paint,
      })

      map.on('click', `line-${route.id}`, () => onSelectRef.current?.(route.id))
      map.on('mouseenter', `line-${route.id}`, () => {
        map.getCanvas().style.cursor = 'pointer'
      })
      map.on('mouseleave', `line-${route.id}`, () => {
        map.getCanvas().style.cursor = ''
      })
    }

    // The stretch of line belonging to the step under the cursor (§6.4). Added
    // before the rest stops so their circles stay on top of it.
    map.addSource('highlight', {
      type: 'geojson',
      data: { type: 'Feature', geometry: { type: 'LineString', coordinates: [] } },
    })
    map.addLayer({
      id: 'highlight',
      type: 'line',
      source: 'highlight',
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: { 'line-color': token('--accent'), 'line-width': 11, 'line-opacity': 0.55 },
    })

    // Rest stops for the selected route only (§4.10). A circle layer rather
    // than DOM markers: there can be a dozen of them, and they need to sit
    // under the barrier markers rather than competing with them.
    map.addSource('rest-stops', {
      type: 'geojson',
      data: { type: 'FeatureCollection', features: [] },
    })
    map.addLayer({
      id: 'rest-stops',
      type: 'circle',
      source: 'rest-stops',
      paint: {
        'circle-radius': 4.5,
        'circle-color': token('--raised'),
        'circle-stroke-width': 3,
        'circle-stroke-color': ['get', 'colour'],
      },
    })
  }, [routes, ready, theme])

  // --- selection emphasis (paint properties only, never re-adding layers) ---

  useEffect(() => {
    const map = mapRef.current
    if (!map || !ready) return

    for (const id of layerIdsRef.current) {
      const isSelected = id === selected
      // The casing is --raised at line-width + 6, so the selected line stays
      // legible where it crosses a park or open water (§2.4).
      if (map.getLayer(`case-${id}`)) {
        map.setPaintProperty(`case-${id}`, 'line-color', token('--raised'))
        map.setPaintProperty(`case-${id}`, 'line-width', isSelected ? 13 : 7)
        map.setPaintProperty(`case-${id}`, 'line-opacity', isSelected ? 1 : 0.45)
      }
      if (map.getLayer(`line-${id}`)) {
        map.setPaintProperty(`line-${id}`, 'line-width', isSelected ? 7 : 5)
        map.setPaintProperty(`line-${id}`, 'line-opacity', isSelected ? 1 : 0.45)
      }
    }

    const chosen = routes.find((r) => r.id === selected)
    const source = map.getSource('rest-stops')
    if (source) {
      source.setData({
        type: 'FeatureCollection',
        features: (chosen?.rest_stops ?? []).map((stop) => ({
          type: 'Feature',
          properties: { colour: routeColor(chosen.id, theme) },
          geometry: { type: 'Point', coordinates: [stop.lon, stop.lat] },
        })),
      })
    }
  }, [selected, routes, ready, theme])

  // --- step highlight ------------------------------------------------------

  useEffect(() => {
    const map = mapRef.current
    if (!map || !ready) return
    const source = map.getSource('highlight')
    if (!source) return

    const route = routes.find((r) => r.id === selected)
    const span =
      highlight && route?.geometry?.length > 1
        ? route.geometry.slice(highlight[0], highlight[1] + 1)
        : []
    source.setData({
      type: 'Feature',
      geometry: { type: 'LineString', coordinates: span.length > 1 ? span : [] },
    })
    if (map.getLayer('highlight')) {
      map.setPaintProperty('highlight', 'line-color', token('--accent'))
    }
  }, [highlight, selected, routes, ready, theme])

  // --- viewport ------------------------------------------------------------

  const fit = useCallback(() => {
    const map = mapRef.current
    if (!map || !ready) return

    const target = routes.find((r) => r.id === selected && r.geometry?.length > 1)
    const coordinates = target
      ? target.geometry
      : routes.flatMap((r) => (r.geometry?.length > 1 ? r.geometry : []))
    if (coordinates.length < 2) return

    const narrow = map.getContainer().clientWidth < 640
    // Jump rather than fly when nobody can see it. MapLibre animates the camera
    // with requestAnimationFrame, which does not run in a hidden tab — so an
    // animated fitBounds started while the page is backgrounded never
    // progresses, and switching back shows the map still sitting at its initial
    // centre with the routes off-screen.
    const instant = prefersReducedMotion() || document.hidden
    map.fitBounds(boundsOf(coordinates), {
      padding: narrow ? 40 : 60,
      duration: instant ? 0 : 500,
      maxZoom: 16,
    })
  }, [routes, selected, ready])

  useEffect(fit, [fit])

  // --- markers -------------------------------------------------------------

  useEffect(() => {
    const map = mapRef.current
    if (!map || !ready) return

    markersRef.current.forEach((m) => m.remove())
    markersRef.current = []

    const add = (lngLat, element) => {
      const marker = new maplibregl.Marker({ element }).setLngLat(lngLat).addTo(map)
      markersRef.current.push(marker)
    }

    if (origin) {
      add(
        [origin.lon, origin.lat],
        markerElement('', 'A', `Start: ${origin.name ?? 'your location'}`),
      )
    }
    if (dest) {
      add(
        [dest.lon, dest.lat],
        markerElement('', 'B', `Destination: ${dest.name ?? 'chosen point'}`),
      )
    }

    // Barriers stay DOM markers rather than a circle layer: they carry a glyph
    // and an aria-label, and they are the one thing on this map that a user
    // must not miss.
    for (const route of routes) {
      if (route.status === 'ok') continue
      for (const blocker of route.blockers ?? []) {
        add(
          [blocker.lon, blocker.lat],
          markerElement(
            'marker--blocker',
            '✕',
            `Barrier on the ${route.label} route — ${blocker.type}: ${blocker.description}`,
          ),
        )
      }
    }
  }, [routes, selected, origin, dest, ready])

  // --- controls ------------------------------------------------------------

  const zoom = (delta) => {
    const map = mapRef.current
    if (!map) return
    map.easeTo({ zoom: map.getZoom() + delta, duration: prefersReducedMotion() ? 0 : 200 })
  }

  const drawn = routes.filter((r) => r.geometry?.length > 1)
  const chosen = routes.find((r) => r.id === selected)
  const summary = drawn.length
    ? `Map showing ${drawn.length} route${drawn.length === 1 ? '' : 's'}: ${drawn
        .map((r) => `${r.label} as a ${styleFor(r.id).pattern} line`)
        .join(', ')}.${chosen ? ` ${chosen.label} is selected.` : ''} Every route is described in full in the list beside this map.`
    : 'Map of the area. No routes are drawn yet.'

  return (
    // §4.10 asks for role="img" on the container. It cannot go here, and this
    // is not a shortcut: role="img" declares the element a single graphic whose
    // contents are not exposed, so nesting the zoom buttons inside it is
    // `nested-interactive` — a serious WCAG 4.1.2 failure, which axe caught.
    // It cannot go on .map__canvas either, because MapLibre injects its own
    // attribution button in there. The summary therefore reaches assistive
    // technology through the labelled region plus the visually-hidden
    // description below, which conveys the same sentence without lying about
    // what the element is.
    <section className="map" aria-label="Map of the suggested routes">
      <div className="map__canvas" ref={containerRef} />

      {failed && (
        <div className="map__fallback">
          <p>
            The map could not load. Every route is described in full in the list beside it —
            nothing is missing from it.
          </p>
        </div>
      )}

      {/* Legend, bottom-left. Hidden below 900px, where the rail is the legend. */}
      {drawn.length > 0 && (
        <div className="legend" aria-hidden="true">
          {drawn.map((route) => {
            const style = styleFor(route.id)
            return (
              <p
                key={route.id}
                className={route.id === selected ? 'legend__row is-selected' : 'legend__row'}
              >
                <span
                  className="legend__line"
                  style={{
                    background:
                      style.dash.length === 2 && style.dash[1] === 0
                        ? routeColor(route.id, theme)
                        : undefined,
                    backgroundImage:
                      style.dash.length === 2 && style.dash[1] === 0
                        ? undefined
                        : `repeating-linear-gradient(90deg, ${routeColor(route.id, theme)} 0 ${style.dash[0] * 3}px, transparent ${style.dash[0] * 3}px ${(style.dash[0] + style.dash[1]) * 3}px)`,
                  }}
                />
                {route.label} <span className="legend__pattern">{style.pattern}</span>
              </p>
            )
          })}
        </div>
      )}

      {/* Last in the DOM inside the stage, and the stage is after the panel, so
          a keyboard user reaching the routes never traverses zoom buttons
          first (§9). */}
      <div className="map__controls">
        <button type="button" className="map__ctrl" onClick={() => zoom(1)}>
          <span aria-hidden="true">+</span>
          <span className="visually-hidden">Zoom in</span>
        </button>
        <button type="button" className="map__ctrl" onClick={() => zoom(-1)}>
          <span aria-hidden="true">−</span>
          <span className="visually-hidden">Zoom out</span>
        </button>
        <button type="button" className="map__ctrl" onClick={fit}>
          <span aria-hidden="true">⌖</span>
          <span className="visually-hidden">Recentre on the selected route</span>
        </button>
      </div>

      <p className="visually-hidden">{summary}</p>
    </section>
  )
}
