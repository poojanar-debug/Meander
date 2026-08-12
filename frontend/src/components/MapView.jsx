import maplibregl from 'maplibre-gl'
import { useCallback, useEffect, useRef, useState } from 'react'

import { routeColor, styleFor, swatchBackground } from '../lib/dash.js'
import { pointAtDistance } from '../lib/follow.js'

const STYLE_URL = 'https://tiles.openfreemap.org/styles/positron'
const INITIAL_CENTER = [79.8521, 6.921]
const INITIAL_ZOOM = 12.6

const RAD = Math.PI / 180

/**
 * How much ground one pixel covers while following.
 *
 * The camera used to be a whole-route `fitBounds` and nothing else, which for
 * the default three routes at the gate's London origin computes to **3.4 to 5.1
 * metres per pixel**. At that scale a 1.4 m/s walker moves 0.28 px per second
 * and the 7px selected line is 35 m wide on the ground: the map is a picture of
 * the walk, not a thing to walk by.
 *
 * 0.4 m/px is about z17 at London's latitude, and a street is then a street.
 *
 * **This costs nothing in privacy, and that was checked rather than assumed.**
 * A camera that follows someone could disclose their path to the basemap host
 * through tile requests even though the app itself sends nothing. It does not
 * here: the OpenFreeMap style's vector source declares `maxzoom: 14`
 * (`https://tiles.openfreemap.org/planet`), so every zoom past 14 is served by
 * overzooming tiles the client already has — and the whole-route view fetched
 * exactly those z14 tiles before follow mode opened. Measured over a full
 * simulated walk of the route with a DevTools trace: three requests in the
 * entire session, all of them glyph ranges, and no tile request at all.
 */
const FOLLOW_METRES_PER_PIXEL = 0.4

/**
 * The zoom that puts `metresPerPixel` on the ground at this latitude.
 *
 * Computed rather than hard-coded to z17, because metres per pixel is what
 * actually matters and it is latitude-dependent: the same zoom that gives
 * 0.37 m/px in London gives 0.59 m/px in Colombo, and this app routes in both.
 *
 * MapLibre sizes the world as `512 * 2^zoom` pixels, so the scale at the
 * equator is 78271.516 / 2^zoom and shrinks with the cosine of the latitude.
 * The familiar 156543 constant is the 256px-tile figure and is off by exactly
 * one zoom level here.
 */
function zoomForScale(metresPerPixel, lat) {
  return Math.log2((78271.516 * Math.cos(lat * RAD)) / metresPerPixel)
}

/**
 * A circle of `radiusM` metres about a point, as a GeoJSON ring.
 *
 * A polygon rather than a `circle` layer with a zoom expression: `circle-radius`
 * is in screen pixels, so holding a *metre* radius through a zoom change means
 * an interpolation expression that has to be rewritten whenever the zoom range
 * moves. A ring in degrees is simply correct at every zoom and is updated as
 * source data, which is the separation this file already keeps.
 */
function circleRing([lon, lat], radiusM, steps = 48) {
  const dLat = radiusM / 111320
  const dLon = radiusM / (111320 * Math.max(0.01, Math.cos(lat * RAD)))
  const ring = []
  for (let i = 0; i <= steps; i += 1) {
    const a = (i / steps) * 2 * Math.PI
    ring.push([lon + dLon * Math.cos(a), lat + dLat * Math.sin(a)])
  }
  return { type: 'Polygon', coordinates: [ring] }
}

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
export default function MapView({
  routes,
  selected,
  origin,
  dest,
  theme,
  highlight,
  onSelect,
  follow = null,
}) {
  const containerRef = useRef(null)
  const mapRef = useRef(null)
  const markersRef = useRef([])
  const layerIdsRef = useRef([])
  const layerHandlersRef = useRef([])
  const onSelectRef = useRef(onSelect)
  const [ready, setReady] = useState(false)
  const [failed, setFailed] = useState(false)
  // Whether the user has taken the camera off the walker. Only a gesture sets
  // it, never one of our own camera calls — MapLibre fires `zoomstart` for
  // `easeTo` too, and treating that as a pan would make the re-centre button
  // appear the instant following began and never go away.
  const [cameraTaken, setCameraTaken] = useState(false)

  const followTracking = follow?.tracking ?? null
  const followPosition = followTracking?.position ?? null
  const followActive = Boolean(follow && followPosition)

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

    // Delegated listeners come off before their layers do. `map.off` appeared
    // zero times in this file, so every re-run of this effect added another
    // click/mouseenter/mouseleave triple for a layer id that keeps recurring
    // across searches — and MapLibre holds them on the map, not on the layer,
    // so removing the layer does not remove them. Seven routes arriving over a
    // stream meant seven live handlers per line, all firing onSelect.
    for (const [type, layer, handler] of layerHandlersRef.current) {
      map.off(type, layer, handler)
    }
    layerHandlersRef.current = []

    for (const id of layerIdsRef.current) {
      if (map.getLayer(`line-${id}`)) map.removeLayer(`line-${id}`)
      if (map.getLayer(`case-${id}`)) map.removeLayer(`case-${id}`)
      if (map.getSource(`route-${id}`)) map.removeSource(`route-${id}`)
    }
    for (const id of [
      'highlight',
      'rest-stops',
      'follow-walked-case',
      'follow-walked',
      'follow-accuracy',
      'follow-here',
    ]) {
      if (map.getLayer(id)) map.removeLayer(id)
    }
    for (const id of ['highlight', 'rest-stops', 'follow-walked', 'follow-here']) {
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

      const layer = `line-${route.id}`
      const onClick = () => onSelectRef.current?.(route.id)
      const onEnter = () => {
        map.getCanvas().style.cursor = 'pointer'
      }
      const onLeave = () => {
        map.getCanvas().style.cursor = ''
      }
      map.on('click', layer, onClick)
      map.on('mouseenter', layer, onEnter)
      map.on('mouseleave', layer, onLeave)
      layerHandlersRef.current.push(
        ['click', layer, onClick],
        ['mouseenter', layer, onEnter],
        ['mouseleave', layer, onLeave],
      )
    }

    // --- follow layers, added once and thereafter only fed new data ---------
    //
    // The separation this file keeps: sources and layers are created here,
    // paint and data are updated elsewhere. Re-adding a layer per GPS fix would
    // tear down and rebuild every route layer once a second.
    map.addSource('follow-walked', {
      type: 'geojson',
      data: { type: 'Feature', geometry: { type: 'LineString', coordinates: [] } },
    })
    // A --raised case at the selected line's own width, so the stretch already
    // walked is genuinely blanked before being repainted at the unselected 0.45
    // rather than merely tinted — painting 45% of a colour over 100% of the
    // same colour changes nothing.
    map.addLayer({
      id: 'follow-walked-case',
      type: 'line',
      source: 'follow-walked',
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: { 'line-color': token('--raised'), 'line-width': 7.5 },
    })
    map.addLayer({
      id: 'follow-walked',
      type: 'line',
      source: 'follow-walked',
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: { 'line-color': token('--ink-2'), 'line-width': 7, 'line-opacity': 0.45 },
    })

    map.addSource('follow-here', {
      type: 'geojson',
      data: { type: 'FeatureCollection', features: [] },
    })

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

    // Last, so the walker is on top of every route, every rest stop and every
    // highlight. Where you are is the one thing on this map that must never be
    // underneath anything.
    //
    // The reported accuracy is drawn rather than described: someone standing
    // still while the app insists they are sixty metres along deserves to see
    // how sure it is.
    map.addLayer({
      id: 'follow-accuracy',
      type: 'fill',
      source: 'follow-here',
      filter: ['==', ['geometry-type'], 'Polygon'],
      paint: { 'fill-color': token('--accent'), 'fill-opacity': 0.12 },
    })
    // Distinct from the brand-green A pin on purpose: on a round trip the start
    // and the walker are the same place at the start and the same place again
    // at the end, and two identical marks there say nothing.
    map.addLayer({
      id: 'follow-here',
      type: 'circle',
      source: 'follow-here',
      filter: ['==', ['geometry-type'], 'Point'],
      paint: {
        'circle-radius': 8,
        'circle-color': token('--accent'),
        'circle-stroke-width': 3,
        'circle-stroke-color': token('--raised'),
      },
    })
  }, [routes, ready, theme])

  // --- follow: data only, never a layer ------------------------------------

  useEffect(() => {
    const map = mapRef.current
    if (!map || !ready) return

    const walked = map.getSource('follow-walked')
    const here = map.getSource('follow-here')
    if (!walked || !here) return

    const at = followTracking?.at ?? null
    const geometry = follow?.route?.geometry ?? null

    // Split at `at.alongM`: whole vertices up to the one behind the walker,
    // then the projected point itself, so the join is where the person is
    // rather than at the last vertex they happened to pass.
    let trace = []
    if (followActive && at && geometry?.length > 1) {
      trace = geometry.slice(0, at.index + 1)
      const head = pointAtDistance(geometry, at.alongM, followTracking.cumulative)
      if (head) trace = [...trace, [head.lon, head.lat]]
    }
    walked.setData({
      type: 'Feature',
      geometry: { type: 'LineString', coordinates: trace.length > 1 ? trace : [] },
    })

    const features = []
    if (followActive) {
      const accuracyM = followTracking.accuracyM
      if (accuracyM != null && accuracyM > 0) {
        features.push({
          type: 'Feature',
          properties: {},
          geometry: circleRing(followPosition, accuracyM),
        })
      }
      features.push({
        type: 'Feature',
        properties: {},
        geometry: { type: 'Point', coordinates: followPosition },
      })
    }
    here.setData({ type: 'FeatureCollection', features })
  }, [followActive, followPosition, followTracking, follow?.route?.geometry, ready, theme])

  // --- follow: the camera ---------------------------------------------------

  // A gesture, and only a gesture. MapLibre fires movestart/zoomstart for
  // programmatic camera calls too, and those carry no `originalEvent` — without
  // that test our own easeTo would mark the camera as taken on the first fix.
  useEffect(() => {
    const map = mapRef.current
    if (!map || !ready) return undefined
    const taken = (event) => {
      if (event?.originalEvent) setCameraTaken(true)
    }
    map.on('dragstart', taken)
    map.on('zoomstart', taken)
    map.on('rotatestart', taken)
    return () => {
      map.off('dragstart', taken)
      map.off('zoomstart', taken)
      map.off('rotatestart', taken)
    }
  }, [ready])

  // Leaving follow mode hands the camera back.
  useEffect(() => {
    if (!follow) setCameraTaken(false)
  }, [follow])

  const recentre = useCallback(() => {
    const map = mapRef.current
    if (!map || !followPosition) return
    setCameraTaken(false)
    const instant = prefersReducedMotion() || document.hidden
    map.easeTo({
      center: followPosition,
      zoom: zoomForScale(FOLLOW_METRES_PER_PIXEL, followPosition[1]),
      duration: instant ? 0 : 400,
    })
  }, [followPosition])

  useEffect(() => {
    const map = mapRef.current
    if (!map || !ready || !followActive || cameraTaken) return
    // The same two guards every other camera call in this file uses. MapLibre
    // animates on requestAnimationFrame, which does not run in a hidden tab —
    // an animated move started while backgrounded never progresses, and coming
    // back shows the camera still where it was when the phone went in a pocket.
    const instant = prefersReducedMotion() || document.hidden
    map.easeTo({
      center: followPosition,
      zoom: zoomForScale(FOLLOW_METRES_PER_PIXEL, followPosition[1]),
      duration: instant ? 0 : 600,
    })
  }, [followActive, followPosition, cameraTaken, ready])

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

  // Not while following. `fit` is keyed on [routes, selected, ready], and
  // `case 'settled'` replaces `routes` wholesale — so a refetch landing
  // mid-walk used to yank the camera from the walker back out to the whole
  // route's bounds, at the exact moment someone was looking at it to decide
  // which way to turn. The button still calls `fit` deliberately.
  useEffect(() => {
    if (followActive) return
    fit()
  }, [fit, followActive])

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
    // Pressing + or - while following is a deliberate choice of scale, so it
    // counts as taking the camera. Without this the next fix would ease the
    // zoom straight back to 0.4 m/px and the button would look broken.
    if (followActive) setCameraTaken(true)
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
                {/* One property, not `background` plus `backgroundImage`.
                    Setting both — even with one undefined — makes React warn
                    about mixing shorthand and longhand, and swatchBackground
                    already returns whichever of the two this route needs. */}
                <span
                  className="legend__line"
                  style={{ background: swatchBackground(route.id, theme) }}
                />
                {route.label} <span className="legend__pattern">{style.pattern}</span>
              </p>
            )
          })}
        </div>
      )}

      {/* Only after a gesture has taken the camera, and gone again the moment
          it is handed back. A permanent re-centre button on a screen someone is
          walking with is one more thing to read; a button that appears exactly
          when it has something to do is a status as much as a control. */}
      {followActive && cameraTaken && (
        <button type="button" className="map__recentre" onClick={recentre}>
          <span aria-hidden="true">◎</span> Re-centre
        </button>
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
