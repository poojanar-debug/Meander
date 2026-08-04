import maplibregl from 'maplibre-gl'
import { useEffect, useRef, useState } from 'react'

import { styleFor } from '../lib/dash.js'
import { fmtDist } from '../lib/format.js'

const STYLE_URL = 'https://tiles.openfreemap.org/styles/positron'
const INITIAL_CENTER = [79.8521, 6.921]
const INITIAL_ZOOM = 12.6

// How long to wait for the basemap before giving up on it and showing the
// fallback. Generous: a cold CDN on a slow connection is not a failure.
const MAP_LOAD_TIMEOUT_MS = 8000

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

/**
 * The map is an enhancement, never the only way to read a result.
 *
 * Everything drawn here is also written out in the route list, and the app is
 * tested with this component hidden. Markers carry real `aria-label`s, but they
 * are a convenience — the list is the accessibility story.
 */
export default function MapView({ routes, selected, origin, dest, onSelect }) {
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

    let map
    try {
      map = new maplibregl.Map({
        container: containerRef.current,
        style: STYLE_URL,
        center: INITIAL_CENTER,
        zoom: INITIAL_ZOOM,
        attributionControl: { compact: true },
      })
    } catch (err) {
      // WebGL unavailable, or the style host is blocked. The route list still
      // carries the whole answer, so this degrades rather than breaking.
      console.warn('Meander: map could not start —', err)
      setFailed(true)
      return undefined
    }

    // A map that never finishes loading is the failure mode this has to catch.
    // MapLibre can sit in style-loading indefinitely — a sandboxed WebGL
    // context, a stalled worker, a proxy that holds the connection open — and
    // it emits no `error` for any of them. Without a deadline the user gets an
    // unexplained grey rectangle forever, which is worse than being told the
    // map is unavailable and pointed at the list that has the whole answer.
    let settled = false
    const deadline = setTimeout(() => {
      if (!settled) {
        console.warn('Meander: map did not finish loading; falling back to the route list')
        setFailed(true)
      }
    }, MAP_LOAD_TIMEOUT_MS)

    map.on('load', () => {
      settled = true
      clearTimeout(deadline)
      setReady(true)
      setFailed(false)
    })
    map.on('error', (event) => {
      if (event?.error?.status === 404 || event?.error?.message?.includes('style')) {
        settled = true
        clearTimeout(deadline)
        setFailed(true)
      }
    })
    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right')
    mapRef.current = map

    // The container is sized by a CSS clamp and by the 860px breakpoint, so it
    // changes height without the window necessarily changing size — rotating a
    // phone, or a desktop crossing the breakpoint. MapLibre's own trackResize
    // did not pick that up here: the canvas stayed at its initial height and
    // left a band of empty container below it. Observing the element directly
    // is reliable regardless of how the resize was caused.
    const observer = new ResizeObserver(() => map.resize())
    observer.observe(containerRef.current)

    return () => {
      clearTimeout(deadline)
      observer.disconnect()
      markersRef.current.forEach((m) => m.remove())
      markersRef.current = []
      map.remove()
      mapRef.current = null
      setReady(false)
    }
  }, [])

  // --- route layers --------------------------------------------------------

  useEffect(() => {
    const map = mapRef.current
    if (!map || !ready) return

    for (const id of layerIdsRef.current) {
      if (map.getLayer(`line-${id}`)) map.removeLayer(`line-${id}`)
      if (map.getLayer(`case-${id}`)) map.removeLayer(`case-${id}`)
      if (map.getSource(`route-${id}`)) map.removeSource(`route-${id}`)
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

    // Cases first for every route, then lines, so one route's halo can never
    // paint over another route's line.
    for (const route of drawable) {
      map.addLayer({
        id: `case-${route.id}`,
        type: 'line',
        source: `route-${route.id}`,
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-color': '#ffffff', 'line-width': 7 },
      })
    }
    for (const route of drawable) {
      const style = styleFor(route.id)
      const paint = {
        'line-color': style.color,
        'line-width': 3.5,
        'line-opacity': 0.4,
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
  }, [routes, ready])

  // --- selection emphasis (paint properties only, never re-adding layers) ---

  useEffect(() => {
    const map = mapRef.current
    if (!map || !ready) return

    for (const id of layerIdsRef.current) {
      const isSelected = id === selected
      if (map.getLayer(`case-${id}`)) {
        map.setPaintProperty(`case-${id}`, 'line-width', isSelected ? 13 : 7)
      }
      if (map.getLayer(`line-${id}`)) {
        map.setPaintProperty(`line-${id}`, 'line-width', isSelected ? 7 : 3.5)
        map.setPaintProperty(`line-${id}`, 'line-opacity', isSelected ? 1 : 0.4)
      }
    }
  }, [selected, routes, ready])

  // --- viewport ------------------------------------------------------------

  useEffect(() => {
    const map = mapRef.current
    if (!map || !ready) return

    const target = routes.find((r) => r.id === selected && r.geometry?.length > 1)
    const coordinates = target
      ? target.geometry
      : routes.flatMap((r) => (r.geometry?.length > 1 ? r.geometry : []))
    if (coordinates.length < 2) return

    const narrow = map.getContainer().clientWidth < 640
    map.fitBounds(boundsOf(coordinates), {
      padding: narrow ? 40 : 70,
      duration: prefersReducedMotion() ? 0 : 600,
      maxZoom: 16,
    })
  }, [selected, routes, ready])

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
      add([origin.lon, origin.lat], markerElement('', 'A', `Start: ${origin.name ?? 'your location'}`))
    }
    if (dest) {
      add([dest.lon, dest.lat], markerElement('', 'B', `Destination: ${dest.name ?? 'chosen point'}`))
    }

    const chosen = routes.find((r) => r.id === selected)
    if (chosen) {
      for (const stop of chosen.rest_stops ?? []) {
        add(
          [stop.lon, stop.lat],
          markerElement(
            'marker--rest',
            '·',
            `Rest stop: ${stop.type}, ${fmtDist(stop.at_m)} along the ${chosen.label} route`,
          ),
        )
      }
    }

    for (const route of routes) {
      if (route.status !== 'blocked') continue
      for (const blocker of route.blockers ?? []) {
        add(
          [blocker.lon, blocker.lat],
          markerElement(
            'marker--blocker',
            '!',
            `Barrier on the ${route.label} route — ${blocker.type}: ${blocker.description}`,
          ),
        )
      }
    }
  }, [routes, selected, origin, dest, ready])

  return (
    <section className="map" aria-label="Map of the suggested routes">
      <div className="map__canvas" ref={containerRef} />
      {failed && (
        <div className="map__fallback">
          <p>
            The map could not load. Every route is described in full in the list below — nothing
            is missing from it.
          </p>
        </div>
      )}
      <p className="visually-hidden">
        This map is a visual summary. The same information, in words, is in the route list that
        follows it.
      </p>
    </section>
  )
}
