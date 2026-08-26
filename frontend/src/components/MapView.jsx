import maplibregl from 'maplibre-gl'
import { useCallback, useEffect, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'

import LayerPicker from './LayerPicker.jsx'
import ManoeuvreIcon, { MANOEUVRE_NAME } from './ManoeuvreIcon.jsx'
import { CompassIcon } from './Icons.jsx'
import { isViewpoint, shortLabel } from '../lib/amenities.js'
import { STYLE_URL, basemapFor } from '../lib/basemap.js'
import { routeColor, styleFor } from '../lib/dash.js'
import { pointAtDistance } from '../lib/follow.js'
import { MOBILE_LAYOUT, useMatchMedia } from '../lib/media.js'

const INITIAL_CENTER = [79.8521, 6.921]
const INITIAL_ZOOM = 12.6

const RAD = Math.PI / 180

/**
 * How much ground one pixel covers while following.
 *
 * The camera used to be a whole-route `fitBounds` and nothing else, which for
 * the default three routes at the gate's London origin computes to **3.4 to 5.1
 * metres per pixel**. At that scale a 1.4 m/s walker moves 0.28 px per second
 * and the selected line is tens of metres wide on the ground: the map is a
 * picture of the walk, not a thing to walk by.
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

// How long to wait for the basemap before giving up on it and showing the
// fallback. Deliberately generous: a cold tile CDN fetching style, sprites,
// glyphs and a first ring of vector tiles can take well over ten seconds on a
// slow connection, and flashing "the map could not load" at someone whose map
// is merely loading is worse than making them wait. This only needs to catch a
// map that is never coming — a blocked tile host, a CSP that forgot
// connect-src, a stalled worker — none of which resolve themselves.
const MAP_LOAD_TIMEOUT_MS = 20000

/** The puck, in the design's stated geometry: a 9.5 sky core inside a 13
 *  surface ring, under a 34 halo that breathes between .22 and .07 opacity
 *  over 2.6s. Those are diameters; circle-radius wants radii. */
const PUCK_CORE_R = 9.5 / 2
const PUCK_RING_W = (13 - 9.5) / 2
const HALO_R = 34 / 2
const HALO_BREATH_MS = 2600
const HALO_OPACITY_HIGH = 0.22
const HALO_OPACITY_LOW = 0.07

/**
 * The heading cone, the chevrons, and why they are drawn to a canvas.
 *
 * MapLibre's `addImage` wants pixels. Everything else this app draws is inline
 * SVG for the reasons `ManoeuvreIcon.jsx` sets out — a file in `public/` falls
 * under `icons.test.js`'s launcher-icon contract, and an external asset needs a
 * CSP entry whose hash `csp-hash.test.js` pins byte for byte. A canvas keeps
 * both of those properties: nothing is fetched, nothing is a file, and the
 * colours are still read from the tokens rather than written here.
 *
 * `pixelRatio` is capped at 2. It is a real cap, not a rounding: a 3x phone
 * would otherwise allocate 9x the pixels for a mark that is 26 CSS px across,
 * and MapLibre holds every icon in one texture atlas that the whole style
 * shares.
 */
function rasterise(size, paint) {
  const ratio = Math.min(2, Math.ceil(window.devicePixelRatio || 1))
  const canvas = document.createElement('canvas')
  canvas.width = Math.round(size * ratio)
  canvas.height = Math.round(size * ratio)
  const ctx = canvas.getContext('2d')
  if (!ctx) return null
  ctx.scale(ratio, ratio)
  paint(ctx, size)
  return { image: ctx.getImageData(0, 0, canvas.width, canvas.height), pixelRatio: ratio }
}

/**
 * The direction-of-travel cone, apex at the centre of the image.
 *
 * Apex at the centre and not at the bottom edge, and that is the whole trick:
 * MapLibre rotates an icon about its anchor, so a cone drawn from the bottom
 * of its own box would swing around a point 30 px behind the walker rather
 * than pivoting under the puck.
 *
 * It is a cone rather than a chevron because a cone is the honest shape. A
 * sharp arrow claims a heading the phone does not have — `heading` from the
 * Geolocation API is derived from successive fixes and is noisy at walking
 * pace. A widening wedge says "roughly this way", which is what is known.
 */
const CONE_SIZE = 108
const CONE_LENGTH = 46
const CONE_HALF_ANGLE = 26 * (Math.PI / 180)

function paintCone(fill) {
  return (ctx, size) => {
    const cx = size / 2
    const cy = size / 2
    ctx.beginPath()
    ctx.moveTo(cx, cy)
    ctx.arc(cx, cy, CONE_LENGTH, -Math.PI / 2 - CONE_HALF_ANGLE, -Math.PI / 2 + CONE_HALF_ANGLE)
    ctx.closePath()
    // A gradient out to nothing, so the cone has no edge to be read as a
    // boundary. A flat wedge with a hard end looks like a measurement.
    const gradient = ctx.createRadialGradient(cx, cy, 4, cx, cy, CONE_LENGTH)
    gradient.addColorStop(0, withAlpha(fill, 0.42))
    gradient.addColorStop(1, withAlpha(fill, 0))
    ctx.fillStyle = gradient
    ctx.fill()
  }
}

/** A single direction chevron, pointing up, for repeating along the line. */
const CHEVRON_SIZE = 18

function paintChevron(stroke) {
  return (ctx, size) => {
    const mid = size / 2
    ctx.strokeStyle = stroke
    ctx.lineWidth = 2.6
    ctx.lineCap = 'round'
    ctx.lineJoin = 'round'
    ctx.beginPath()
    ctx.moveTo(mid - 4.6, mid + 3)
    ctx.lineTo(mid, mid - 3)
    ctx.lineTo(mid + 4.6, mid + 3)
    ctx.stroke()
  }
}

/**
 * A token colour at a given alpha.
 *
 * The tokens are hex, and canvas gradients need a colour with an alpha
 * channel. Parsing 3- and 6-digit hex covers everything `styles.css` declares;
 * anything else is handed back unchanged, which produces a fully opaque stop
 * rather than a thrown error on a map somebody is walking with.
 */
function withAlpha(hex, alpha) {
  const value = String(hex).trim()
  const short = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/i.exec(value)
  const long = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(value)
  if (!short && !long) return value
  const parts = short
    ? [short[1] + short[1], short[2] + short[2], short[3] + short[3]]
    : [long[1], long[2], long[3]]
  const [r, g, b] = parts.map((p) => parseInt(p, 16))
  return `rgba(${r}, ${g}, ${b}, ${alpha})`
}

/**
 * How far the heading has to move before the map is turned to follow it.
 *
 * See the note at the call site: a smaller number makes the map rock on a
 * straight street, a larger one makes it lag through a real turn. Eight
 * degrees is comfortably outside the noise of a derived walking heading and
 * comfortably inside the smallest turn anybody navigates by.
 */
const BEARING_STEP_DEG = 8

/** Signed difference between two bearings, in (-180, 180]. Plain subtraction
 *  reports 358 degrees where the answer is -2, which around north would keep
 *  the map permanently mid-rotation. */
function bearingDelta(from, to) {
  return ((to - from + 540) % 360) - 180
}

/**
 * The bearing the camera should hold, or null for "leave it alone".
 *
 * Null rather than 0 when there is no heading: 0 is due north and is a real
 * bearing, so returning it would snap the map north every time somebody paused
 * long enough for the heading to go away, which is most junctions.
 *
 * Reduced motion turns the whole thing off. A map that rotates continuously
 * under someone is the textbook vestibular trigger, and it is not a decoration
 * that can be shortened to a fade — the only respectful version of course-up
 * is no course-up.
 */
function courseBearing(courseUp, headingDeg) {
  if (!courseUp || prefersReducedMotion()) return null
  return typeof headingDeg === 'number' && Number.isFinite(headingDeg) ? headingDeg : null
}

const prefersReducedMotion = () =>
  typeof window !== 'undefined' &&
  window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true

function boundsOf(coordinates) {
  return coordinates.reduce(
    (bounds, coord) => bounds.extend(coord),
    new maplibregl.LngLatBounds(coordinates[0], coordinates[0]),
  )
}

/**
 * The part of the map a person can actually see.
 *
 * The camera frames content in that part, not in the whole viewport. Below the
 * breakpoint the bottom sheet owns a bit over half the stage at its resting
 * height; above it, the capsule claims the top and the card row the bottom.
 * Framing to the full viewport put every loop squarely behind the sheet —
 * measured, on the first screenshot pass.
 *
 * One function because there are now two callers: the route fit, and the
 * before-any-route frame that has to hold both ends of a point-to-point trip.
 */
function framePadding(map, isMobile) {
  const height = map.getContainer().clientHeight
  return isMobile
    ? { top: 70, left: 40, right: 40, bottom: Math.round(height * 0.6) }
    : { top: 140, left: 60, right: 60, bottom: 360 }
}

function markerElement(className, label) {
  const el = document.createElement('div')
  el.className = `marker ${className}`
  el.setAttribute('role', 'img')
  el.setAttribute('aria-label', label)
  return el
}

/** Read a design token. MapLibre paints to a canvas and cannot resolve
 *  `var(--map-water)`, so every colour has to be handed over as a literal. */
function token(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim()
}

/** Layers this app added, as opposed to the basemap's own. Matched on the
 *  source rather than on a list of layer ids, because every one of ours draws
 *  from a source we created and the basemap's draw from the style's. */
const isOurLayer = (layer) =>
  typeof layer?.source === 'string' &&
  (layer.source.startsWith('route-') ||
    ['highlight', 'rest-stops', 'follow-behind', 'follow-ahead', 'follow-connector', 'follow-here', 'basemap-raster'].includes(
      layer.source,
    ))

/** The id of the first symbol layer *belonging to the basemap*, or undefined.
 *
 *  Everything the app draws goes on top of everything, but the satellite
 *  raster is the one exception: it belongs *under* the place labels, so that
 *  choosing imagery does not also mean losing every street name. `addLayer`
 *  with this as its `beforeId` is what puts it there.
 *
 *  ⚠ Our own layers are excluded, and that is not defensive tidying. Follow
 *  mode adds `follow-chevrons`, which is a symbol layer, at the very top of
 *  the stack. If the upstream basemap ever ships without symbols of its own —
 *  or renames them past the match — a naive "first symbol layer" would find
 *  the chevrons and insert the imagery *below the route lines but above
 *  nothing else*, burying the walk under a photograph at the exact moment
 *  somebody is following it.
 *
 *  Undefined is still a valid answer and means "append", which is the correct
 *  degradation: the imagery covers the labels, which is ugly, rather than
 *  covering the route, which is dangerous. */
function firstSymbolLayerId(map) {
  try {
    return map.getStyle()?.layers?.find((l) => l.type === 'symbol' && !isOurLayer(l))?.id
  } catch {
    return undefined
  }
}

/**
 * Recolour the basemap to one of the palettes in `lib/basemap.js`.
 *
 * OpenFreeMap's positron is not ours, so rather than a second tile source the
 * existing style's layers are repainted in place. Layers are matched by id and
 * source-layer rather than by a hard-coded list, because the upstream style's
 * layer names change without notice; a missing match must degrade to "that
 * layer keeps its own colour", never to a thrown error that takes the map
 * down.
 *
 * The palette arrives as **token names**, resolved here. That is the whole
 * reason `basemap.js` can hold three palettes without holding a single hex:
 * `check_palette.sh` requires every colour to be declared in the two `:root`
 * blocks, and a literal in a JS table is exactly the drift it exists to stop.
 *
 * A palette may omit keys. The satellite one carries only `label` and
 * `labelHalo`, because the imagery covers every fill and line beneath it and
 * repainting them would be work with no visible result. `set` is skipped for
 * an absent token rather than being handed `''`, which MapLibre rejects with a
 * console error per layer per repaint.
 */
function applyMapPalette(map, palette) {
  const colour = (key) => (palette[key] ? token(palette[key]) : null)
  const land = colour('land')
  const park = colour('park')
  const water = colour('water')
  const road = colour('road')
  const building = colour('building')
  const label = colour('label')
  const halo = colour('labelHalo')

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
      if (!value) return
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
      set('fill-color', building)
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
      set('text-color', label)
      set('text-halo-color', halo)
    }
  }
}

/**
 * The map is an enhancement, never the only way to read a result.
 *
 * Everything drawn here is also written out in the result cards and the route
 * detail, and the app is tested with this component removed from the DOM
 * entirely. Markers carry real `aria-label`s, but they are a convenience — the
 * cards are the accessibility story.
 *
 * Three things in here were bug fixes rather than choices, and are marked as
 * such below: the deferred creation that survives StrictMode, the load
 * deadline that only runs while the page is visible, and the
 * `jump`-instead-of-`fly` guard for a hidden tab. None of them should be
 * tidied away.
 */
export default function MapView({
  routes,
  selected,
  origin,
  dest,
  highlight,
  onSelect,
  // Detail-focus: the scrimmed modal shows only the selected route and its
  // barrier dots; every other line comes off the map until the modal closes.
  focus = false,
  // A blocker the user asked to see: {lon, lat, seq}. The seq makes asking
  // for the same barrier twice two requests, so the camera comes back.
  focusPoint = null,
  follow = null,
  // Which basemap. Owned by App rather than by this component, because
  // FollowMode has to read it too: the provenance sentence it prints while
  // somebody walks is only true for the basemaps that fetch nothing.
  layer = 'map',
  onLayer,
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
  const [pickerOpen, setPickerOpen] = useState(false)
  // Whether the map turns so that the direction of travel is up.
  //
  // On by default in follow mode, because that is the whole reason the
  // rotation exists: reading "turn left" off a north-up map means doing the
  // mental rotation yourself, at a junction, while walking. Off is one press
  // away and the press is remembered for the session.
  const [courseUp, setCourseUp] = useState(true)

  const followTracking = follow?.tracking ?? null
  const followPosition = followTracking?.position ?? null
  const followActive = Boolean(follow && followPosition)
  const followRouteId = follow?.route?.id ?? null
  const isMobile = useMatchMedia(MOBILE_LAYOUT)

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
          // The design's own centered line replaces the injected control; the
          // sentence it renders is the attribution OpenStreetMap asks for.
          attributionControl: false,
        })
      } catch (err) {
        // WebGL unavailable, or the style host is blocked. The result cards
        // still carry the whole answer, so this degrades rather than breaking.
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
      // map is unavailable and pointed at the cards that have the whole
      // answer. The deadline only runs while the page is actually visible: a
      // hidden tab does not render, so MapLibre legitimately never reaches
      // `load`, and a plain timer would blame the map for the browser's own
      // power saving.
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
        // The palette is no longer applied here. It depends on which basemap
        // is chosen, and that can change after load, so it belongs to the
        // effect keyed on [layer, ready] rather than to a one-shot at load —
        // which is exactly the bug it would be: pick satellite, and the label
        // colours would stay set for a basemap nobody is looking at.
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

      // The container is sized by the viewport and by the 1024px breakpoint,
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

  // --- the basemap ---------------------------------------------------------
  //
  // A raster source added once and thereafter only shown or hidden, and a
  // palette reapplied on every change.
  //
  // **Not `map.setStyle()`.** Swapping the style is the obvious way to change
  // basemap and it is the wrong one here: it destroys every source and layer
  // on the map, so all six route lines, the highlight, the rest stops and the
  // whole follow stack would have to be rebuilt on `styledata` — including,
  // for somebody mid-walk, the puck. Adding one raster layer under the labels
  // costs a single source and leaves everything else untouched.
  //
  // The raster is added lazily rather than at load: nobody who never opens the
  // picker should pay a tile request for imagery they did not ask for, and
  // MapLibre begins fetching the moment a visible raster layer exists.

  useEffect(() => {
    const map = mapRef.current
    if (!map || !ready) return

    const basemap = basemapFor(layer)

    if (basemap.raster) {
      try {
        if (!map.getSource('basemap-raster')) {
          map.addSource('basemap-raster', {
            type: 'raster',
            tiles: basemap.raster.tiles,
            tileSize: basemap.raster.tileSize,
            maxzoom: basemap.raster.maxzoom,
            // The credit MapLibre would inject into its own attribution
            // control. That control is off, and the design's own centred line
            // renders `credits` instead, but the field costs nothing and means
            // a future `attributionControl: true` is not a licence breach.
            attribution: basemap.credits.map((c) => c.text).join(', '),
          })
        }
        if (!map.getLayer('basemap-raster')) {
          map.addLayer(
            { id: 'basemap-raster', type: 'raster', source: 'basemap-raster' },
            firstSymbolLayerId(map),
          )
        }
        map.setLayoutProperty('basemap-raster', 'visibility', 'visible')
      } catch (err) {
        // A raster that will not attach leaves the vector basemap underneath,
        // which is a working map. Never a thrown error that takes the whole
        // canvas down over a choice of backdrop.
        console.warn('Meander: satellite layer could not be added.', err)
      }
    } else if (map.getLayer('basemap-raster')) {
      // Hidden, not removed. Removing it would drop the tile cache MapLibre is
      // holding, so toggling back to satellite would refetch everything that
      // is already on screen.
      map.setLayoutProperty('basemap-raster', 'visibility', 'none')
    }

    applyMapPalette(map, basemap.palette)
  }, [layer, ready])

  // --- the icons the follow symbol layers draw ------------------------------
  //
  // Declared BEFORE the route-layers effect on purpose. React runs effects in
  // declaration order, and a symbol layer whose `icon-image` names an image the
  // style does not hold yet draws nothing and logs one warning per frame.
  // Registering here means the image always exists by the time the layer that
  // wants it is added.
  //
  // Keyed on [ready] alone: the colours come from tokens, and this design
  // commits to one look, so there is no theme change that would need them
  // redrawn. If that ever stops being true, this is the effect that has to grow
  // a dependency.

  useEffect(() => {
    const map = mapRef.current
    if (!map || !ready) return

    const add = (id, size, paint) => {
      if (map.hasImage(id)) return
      const drawn = rasterise(size, paint)
      if (!drawn) return
      try {
        map.addImage(id, drawn.image, { pixelRatio: drawn.pixelRatio })
      } catch {
        // Already registered by a racing effect, or the style was swapped out
        // underneath. A missing icon is a missing chevron, never a broken map.
      }
    }

    add('follow-cone', CONE_SIZE, paintCone(token('--sky-deep')))
    add('follow-chevron', CHEVRON_SIZE, paintChevron(token('--surface')))
  }, [ready])

  // --- route layers --------------------------------------------------------

  useEffect(() => {
    const map = mapRef.current
    if (!map || !ready) return

    // Delegated listeners come off before their layers do. MapLibre holds them
    // on the map, not on the layer, so removing the layer does not remove
    // them; without this sweep every re-run of the effect added another
    // click/mouseenter/mouseleave triple for a layer id that keeps recurring
    // across searches, all firing onSelect.
    for (const [type, layer, handler] of layerHandlersRef.current) {
      map.off(type, layer, handler)
    }
    layerHandlersRef.current = []

    for (const id of layerIdsRef.current) {
      if (map.getLayer(`line-${id}`)) map.removeLayer(`line-${id}`)
      if (map.getSource(`route-${id}`)) map.removeSource(`route-${id}`)
    }
    for (const id of [
      'highlight',
      'rest-stops',
      'follow-behind',
      'follow-ahead',
      'follow-chevrons',
      'follow-connector',
      'follow-cone',
      'follow-halo',
      'follow-here',
    ]) {
      if (map.getLayer(id)) map.removeLayer(id)
    }
    for (const id of ['highlight', 'rest-stops', 'follow-behind', 'follow-ahead', 'follow-connector', 'follow-here']) {
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

    for (const route of drawable) {
      const style = styleFor(route.id)
      const paint = {
        'line-color': routeColor(route.id),
        'line-width': 4.5,
        'line-opacity': 0.75,
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

    // The stretch of line belonging to the step under the cursor. Added
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
      paint: { 'line-color': token('--sky-deep'), 'line-width': 11, 'line-opacity': 0.55 },
    })

    // Rest stops for the selected route only. A circle layer rather than DOM
    // markers: there can be a dozen of them, and they sit under the barrier
    // markers rather than competing with them. Mint, the rest-stop accent.
    map.addSource('rest-stops', {
      type: 'geojson',
      data: { type: 'FeatureCollection', features: [] },
    })
    // Data-driven rather than one paint value, on three properties.
    //
    // `viewpoint` splits the amber from the mint: a viewpoint arrives from
    // `tourism=viewpoint` and is a reason to take the route, where the other
    // four are facilities for somebody already stopped. `lib/amenities.js`
    // argues that at length and owns the test; this layer only draws it.
    //
    // `selected` is what makes it safe to show every route's amenities at
    // once. The unselected ones are smaller and half-transparent, so the
    // chosen route's are legible against them rather than lost in them —
    // which is the failure mode that kept this layer restricted to one route.
    //
    // Colour is not the only channel here either: the visually-hidden summary
    // below counts the viewpoints separately, and the detail list carries a
    // glyph and a word per stop.
    map.addLayer({
      id: 'rest-stops',
      type: 'circle',
      source: 'rest-stops',
      paint: {
        'circle-radius': [
          'case',
          ['!', ['get', 'selected']],
          3,
          ['get', 'viewpoint'],
          6,
          4.5,
        ],
        'circle-color': token('--surface'),
        'circle-stroke-width': ['case', ['!', ['get', 'selected']], 2, 3],
        'circle-stroke-color': [
          'case',
          ['get', 'viewpoint'],
          token('--amber-deep'),
          token('--mint-deep'),
        ],
        'circle-opacity': ['case', ['!', ['get', 'selected']], 0.5, 1],
        'circle-stroke-opacity': ['case', ['!', ['get', 'selected']], 0.5, 1],
      },
    })

    // --- follow layers, added once and thereafter only fed new data ---------
    //
    // The separation this file keeps: sources and layers are created here,
    // paint and data are updated elsewhere. Re-adding a layer per GPS fix
    // would tear down and rebuild every route layer once a second.
    //
    // Follow mode redraws the followed route as two lines: the stretch ahead
    // in mint at 11px, the stretch already walked behind at 9px and 55%.
    map.addSource('follow-behind', {
      type: 'geojson',
      data: { type: 'Feature', geometry: { type: 'LineString', coordinates: [] } },
    })
    map.addSource('follow-ahead', {
      type: 'geojson',
      data: { type: 'Feature', geometry: { type: 'LineString', coordinates: [] } },
    })
    map.addLayer({
      id: 'follow-behind',
      type: 'line',
      source: 'follow-behind',
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: { 'line-color': token('--map-follow-behind'), 'line-width': 9, 'line-opacity': 0.55 },
    })
    map.addLayer({
      id: 'follow-ahead',
      type: 'line',
      source: 'follow-ahead',
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: { 'line-color': token('--mint-deep'), 'line-width': 11 },
    })

    // Which way along the line is forward.
    //
    // `symbol-placement: 'line'` is doing the work here: MapLibre lays the
    // chevrons along the geometry and orients each one to the local direction
    // of the segment it sits on, so nothing has to compute a bearing. It reads
    // the vertex order to decide which way is forward, and `follow-ahead` is
    // built walker-first in the data effect below, so forward is the direction
    // of travel rather than the direction the router happened to draw.
    //
    // `icon-allow-overlap` is deliberately left false. On a hairpin the
    // chevrons would otherwise stack into an unreadable clot at the bend,
    // which is precisely where somebody needs to know which way the path goes.
    map.addLayer({
      id: 'follow-chevrons',
      type: 'symbol',
      source: 'follow-ahead',
      layout: {
        'icon-image': 'follow-chevron',
        'symbol-placement': 'line',
        'symbol-spacing': 58,
        'icon-rotation-alignment': 'map',
        'icon-padding': 2,
      },
      paint: { 'icon-opacity': 0.92 },
    })

    // Off route: a dashed connector from the walker back to the marked path.
    // 2.5px, dash 4 6 — MapLibre's dasharray is in multiples of line width.
    map.addSource('follow-connector', {
      type: 'geojson',
      data: { type: 'Feature', geometry: { type: 'LineString', coordinates: [] } },
    })
    map.addLayer({
      id: 'follow-connector',
      type: 'line',
      source: 'follow-connector',
      paint: {
        'line-color': token('--map-connector'),
        'line-width': 2.5,
        'line-dasharray': [4 / 2.5, 6 / 2.5],
      },
    })

    // Last, so the walker is on top of every route and every rest stop. Where
    // you are is the one thing on this map that must never be underneath
    // anything. The halo breathes; its opacity is animated elsewhere.
    map.addSource('follow-here', {
      type: 'geojson',
      data: { type: 'FeatureCollection', features: [] },
    })
    // The direction-of-travel cone, under both the halo and the puck.
    //
    // Filtered on `hasHeading` rather than shown always. Most fixes at walking
    // pace carry no heading at all — the Geolocation API derives it from
    // successive positions and reports null when standing still — and a cone
    // frozen at the last known bearing while somebody turns on the spot is a
    // confident claim about the one thing they are trying to work out.
    map.addLayer({
      id: 'follow-cone',
      type: 'symbol',
      source: 'follow-here',
      filter: ['==', ['get', 'hasHeading'], true],
      layout: {
        'icon-image': 'follow-cone',
        'icon-rotate': ['get', 'heading'],
        'icon-rotation-alignment': 'map',
        'icon-allow-overlap': true,
        'icon-ignore-placement': true,
      },
    })
    map.addLayer({
      id: 'follow-halo',
      type: 'circle',
      source: 'follow-here',
      paint: {
        'circle-radius': HALO_R,
        'circle-color': token('--sky-deep'),
        'circle-opacity': HALO_OPACITY_HIGH,
      },
    })
    map.addLayer({
      id: 'follow-here',
      type: 'circle',
      source: 'follow-here',
      paint: {
        'circle-radius': PUCK_CORE_R,
        'circle-color': token('--sky-deep'),
        'circle-stroke-width': PUCK_RING_W,
        'circle-stroke-color': token('--surface'),
      },
    })
  }, [routes, ready])

  // --- which lines are visible: streaming, detail focus, or follow ---------

  useEffect(() => {
    const map = mapRef.current
    if (!map || !ready) return

    for (const id of layerIdsRef.current) {
      if (!map.getLayer(`line-${id}`)) continue
      const visible = followActive
        ? false // the ahead/behind pair carries the whole picture
        : focus
          ? id === selected
          : true
      map.setLayoutProperty(`line-${id}`, 'visibility', visible ? 'visible' : 'none')
      if (visible) {
        const isSelected = id === selected
        map.setPaintProperty(`line-${id}`, 'line-width', isSelected ? 7 : 4.5)
        map.setPaintProperty(`line-${id}`, 'line-opacity', isSelected ? 1 : 0.75)
      }
    }

    const source = map.getSource('rest-stops')
    if (source) {
      // Every route's amenities, not only the chosen one's, with the
      // difference carried in a property the paint expressions read. Comparing
      // "which of these three has somewhere to sit" was impossible while only
      // the selected route contributed dots, and switching between cards to
      // find out is not comparing.
      //
      // Follow mode still clears them: the map is then a thing to walk by, and
      // the amenity ahead is announced in the dock as a sentence with a
      // distance instead.
      const drawnRoutes = followActive
        ? []
        : routes.filter((route) => (route.rest_stops ?? []).length > 0)
      source.setData({
        type: 'FeatureCollection',
        features: drawnRoutes.flatMap((route) =>
          (route.rest_stops ?? []).map((stop) => ({
            type: 'Feature',
            properties: {
              selected: route.id === selected,
              viewpoint: isViewpoint(stop.type),
            },
            geometry: { type: 'Point', coordinates: [stop.lon, stop.lat] },
          })),
        ),
      })
    }
  }, [selected, routes, focus, followActive, ready])

  // --- follow: data only, never a layer ------------------------------------

  useEffect(() => {
    const map = mapRef.current
    if (!map || !ready) return

    const behind = map.getSource('follow-behind')
    const ahead = map.getSource('follow-ahead')
    const here = map.getSource('follow-here')
    const connector = map.getSource('follow-connector')
    if (!behind || !ahead || !here || !connector) return

    const at = followTracking?.at ?? null
    const geometry = follow?.route?.geometry ?? null

    // Split at `at.alongM`: whole vertices up to the one behind the walker,
    // then the projected point itself, so the join is where the person is
    // rather than at the last vertex they happened to pass.
    let walked = []
    let remaining = geometry ?? []
    if (followActive && at && geometry?.length > 1) {
      const head = pointAtDistance(geometry, at.alongM, followTracking.cumulative)
      walked = geometry.slice(0, at.index + 1)
      remaining = geometry.slice(at.index + 1)
      if (head) {
        walked = [...walked, [head.lon, head.lat]]
        remaining = [[head.lon, head.lat], ...remaining]
      }
    }
    behind.setData({
      type: 'Feature',
      geometry: { type: 'LineString', coordinates: walked.length > 1 ? walked : [] },
    })
    ahead.setData({
      type: 'Feature',
      geometry: {
        type: 'LineString',
        coordinates: followActive && remaining.length > 1 ? remaining : [],
      },
    })

    // The dashed way back, only while genuinely off route.
    let connectorLine = []
    if (followActive && followTracking?.offRoute && at && geometry?.length > 1) {
      const nearest = pointAtDistance(geometry, at.alongM, followTracking.cumulative)
      if (nearest) connectorLine = [followPosition, [nearest.lon, nearest.lat]]
    }
    connector.setData({
      type: 'Feature',
      geometry: { type: 'LineString', coordinates: connectorLine.length > 1 ? connectorLine : [] },
    })

    // `hasHeading` is a separate boolean rather than a null check on `heading`,
    // because a MapLibre filter cannot distinguish an absent property from one
    // set to 0 — and 0 is due north, a perfectly ordinary heading to be walking
    // in. Filtering on `['!=', ['get','heading'], null]` would have hidden the
    // cone for everybody walking north.
    const heading = followTracking?.headingDeg
    const hasHeading = typeof heading === 'number' && Number.isFinite(heading)
    here.setData({
      type: 'FeatureCollection',
      features: followActive
        ? [
            {
              type: 'Feature',
              properties: { hasHeading, heading: hasHeading ? heading : 0 },
              geometry: { type: 'Point', coordinates: followPosition },
            },
          ]
        : [],
    })
  }, [followActive, followPosition, followTracking, follow?.route?.geometry, ready])

  // The halo breathes: .22 to .07 and back over 2.6s. Static under
  // prefers-reduced-motion, at the midpoint, and not run at all when there is
  // no puck to breathe under.
  useEffect(() => {
    const map = mapRef.current
    if (!map || !ready || !followActive) return undefined
    if (prefersReducedMotion()) {
      if (map.getLayer('follow-halo')) {
        map.setPaintProperty('follow-halo', 'circle-opacity', (HALO_OPACITY_HIGH + HALO_OPACITY_LOW) / 2)
      }
      return undefined
    }
    const started = performance.now()
    const timer = setInterval(() => {
      if (!map.getLayer('follow-halo')) return
      const phase = ((performance.now() - started) % HALO_BREATH_MS) / HALO_BREATH_MS
      const wave = (1 + Math.cos(phase * 2 * Math.PI)) / 2
      map.setPaintProperty(
        'follow-halo',
        'circle-opacity',
        HALO_OPACITY_LOW + wave * (HALO_OPACITY_HIGH - HALO_OPACITY_LOW),
      )
    }, 80)
    return () => clearInterval(timer)
  }, [followActive, ready])

  // --- follow: the turn badge on the line ----------------------------------
  //
  // The glyph the banner shows, drawn again at the point on the route where
  // the turn actually happens. Two things had to be true for it to be worth
  // adding rather than trusting the banner alone: the banner says *what* the
  // turn is and *how far*, and neither of those tells you *which of the three
  // junctions in front of you* it means. The badge on the line does.
  //
  // **`steps[stepIndex + 1].interval[0]`, and each part of that matters.**
  // GraphHopper names a manoeuvre at the START of the interval it belongs to,
  // so the step containing the walker is the turn already taken and `+ 1` is
  // the one ahead; `interval[0]` is then the first vertex of that step, which
  // is the corner itself rather than anywhere along the street after it. The
  // banner derives its own step the same way, in `followTracking.js`, and the
  // two must not be allowed to disagree about which turn is next.
  //
  // ## Why a DOM marker and a React root
  //
  // A symbol layer would need every one of the twelve manoeuvre glyphs
  // rasterised to canvas, which means a second copy of geometry that
  // `ManoeuvreIcon` already owns and a second place for it to drift. A marker
  // renders the component itself, so there is exactly one arrow vocabulary in
  // this app. It also gets an `aria-label` for free, and MapLibre keeps it
  // positioned without this component re-rendering on every camera frame.
  //
  // DOM markers do not rotate with the map, which under course-up is the
  // behaviour wanted: the badge stays upright and legible while the world
  // turns under it.

  useEffect(() => {
    const map = mapRef.current
    if (!map || !ready) return undefined

    const steps = follow?.route?.steps
    const geometry = follow?.route?.geometry
    const stepIndex = followTracking?.stepIndex
    const next =
      followActive && Array.isArray(steps) && typeof stepIndex === 'number' && stepIndex >= 0
        ? (steps[stepIndex + 1] ?? null)
        : null
    const vertex = next?.interval?.[0]
    const point =
      typeof vertex === 'number' && Array.isArray(geometry) ? (geometry[vertex] ?? null) : null

    if (!next || !point) return undefined

    const element = document.createElement('div')
    element.className = 'marker marker--turn'
    element.setAttribute('role', 'img')
    element.setAttribute(
      'aria-label',
      `Next turn on the map: ${MANOEUVRE_NAME[String(next.sign ?? 0)] ?? 'continue'}. ${next.text}`,
    )
    const root = createRoot(element)
    root.render(<ManoeuvreIcon sign={next.sign ?? 0} className="marker__turn-glyph" />)
    const marker = new maplibregl.Marker({ element }).setLngLat(point).addTo(map)

    return () => {
      marker.remove()
      // Deferred by a microtask, and not for tidiness. Unmounting a root
      // synchronously from an effect cleanup can land while React is already
      // rendering the parent, which it warns about and which is a real
      // re-entrancy hazard. The element is already off the map by then, so
      // nothing is visible in the gap.
      queueMicrotask(() => root.unmount())
    }
  }, [followActive, followTracking?.stepIndex, follow?.route?.steps, follow?.route?.geometry, ready])

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
    // Bearing included, because a gesture can rotate the map as well as pan
    // it. Re-centre that restored the position and left the map spun 40
    // degrees off would be a control that half works, and the half it left
    // undone is the one this screen was rotated for.
    const bearing = courseBearing(courseUp, followTracking?.headingDeg)
    map.easeTo({
      center: followPosition,
      zoom: zoomForScale(FOLLOW_METRES_PER_PIXEL, followPosition[1]),
      bearing: bearing ?? 0,
      duration: instant ? 0 : 400,
    })
  }, [followPosition, courseUp, followTracking?.headingDeg])

  useEffect(() => {
    const map = mapRef.current
    if (!map || !ready || !followActive || cameraTaken) return
    // The same two guards every other camera call in this file uses. MapLibre
    // animates on requestAnimationFrame, which does not run in a hidden tab —
    // an animated move started while backgrounded never progresses, and coming
    // back shows the camera still where it was when the phone went in a pocket.
    const instant = prefersReducedMotion() || document.hidden
    const camera = {
      center: followPosition,
      zoom: zoomForScale(FOLLOW_METRES_PER_PIXEL, followPosition[1]),
      duration: instant ? 0 : 600,
    }

    const target = courseBearing(courseUp, followTracking?.headingDeg)
    // Omitted rather than repeated when the change is small, and this is the
    // difference between course-up being usable and being unbearable.
    //
    // `heading` from the Geolocation API is derived from consecutive fixes, so
    // at walking pace it wanders by several degrees while somebody walks in a
    // dead straight line. Feeding every one of those into `easeTo` gives a map
    // that rocks continuously under a person already trying to read it. Below
    // the threshold no bearing is passed at all, and MapLibre keeps the one it
    // has — which is how the map holds still on a straight street and turns
    // only when the walker does.
    if (target != null && Math.abs(bearingDelta(map.getBearing(), target)) >= BEARING_STEP_DEG) {
      camera.bearing = target
    }

    map.easeTo(camera)
  }, [followActive, followPosition, followTracking?.headingDeg, courseUp, cameraTaken, ready])

  // Turning course-up off puts north back at the top, once, rather than
  // waiting for the next fix to notice. Leaving follow mode does the same:
  // a rotated map handed back to the plan screen is a map nobody asked to
  // rotate and no longer has a control to fix.
  useEffect(() => {
    const map = mapRef.current
    if (!map || !ready) return
    if (courseUp && followActive) return
    if (Math.abs(map.getBearing()) < 0.5) return
    map.easeTo({ bearing: 0, duration: prefersReducedMotion() || document.hidden ? 0 : 400 })
  }, [courseUp, followActive, ready])

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
  }, [highlight, selected, routes, ready])

  // --- viewport ------------------------------------------------------------

  const fit = useCallback(() => {
    const map = mapRef.current
    if (!map || !ready) return

    const target = routes.find((r) => r.id === selected && r.geometry?.length > 1)
    const coordinates =
      focus && target
        ? target.geometry
        : routes.flatMap((r) => (r.geometry?.length > 1 ? r.geometry : []))
    if (coordinates.length < 2) return

    const padding = framePadding(map, isMobile)
    // Jump rather than fly when nobody can see it. MapLibre animates the camera
    // with requestAnimationFrame, which does not run in a hidden tab — so an
    // animated fitBounds started while the page is backgrounded never
    // progresses, and switching back shows the map still sitting at its initial
    // centre with the routes off-screen.
    const instant = prefersReducedMotion() || document.hidden
    map.fitBounds(boundsOf(coordinates), {
      padding,
      duration: instant ? 0 : 500,
      maxZoom: 16,
    })
  }, [routes, selected, focus, isMobile, ready])

  // Not while following. `fit` is keyed on [routes, selected, ready], and
  // `case 'settled'` replaces `routes` wholesale — so a refetch landing
  // mid-walk used to yank the camera from the walker back out to the whole
  // route's bounds, at the exact moment someone was looking at it to decide
  // which way to turn.
  useEffect(() => {
    if (followActive) return
    fit()
  }, [fit, followActive])

  // "Tap a blocker to see it on the map": ease to the barrier's own
  // coordinates, close enough that the dot means something.
  useEffect(() => {
    const map = mapRef.current
    if (!map || !ready || !focusPoint) return
    const instant = prefersReducedMotion() || document.hidden
    map.easeTo({
      center: [focusPoint.lon, focusPoint.lat],
      zoom: Math.max(map.getZoom(), 15.5),
      duration: instant ? 0 : 450,
    })
  }, [focusPoint, ready])

  // Centre on the origin before any route exists, so the plan screen's map is
  // the neighbourhood the walk would start in rather than the initial city.
  //
  // With a destination it frames both ends instead. The two markers are the
  // only confirmation this app gives that it understood where the trip runs
  // between, and at zoom 14 a destination more than about a kilometre off is
  // simply not on the screen — so the user picks a place, the map does not
  // move, and nothing tells them it landed.
  useEffect(() => {
    const map = mapRef.current
    if (!map || !ready || !origin || routes.length > 0) return
    const instant = prefersReducedMotion() || document.hidden
    if (dest) {
      map.fitBounds(
        boundsOf([
          [origin.lon, origin.lat],
          [dest.lon, dest.lat],
        ]),
        {
          padding: framePadding(map, isMobile),
          duration: instant ? 0 : 500,
          // One step shy of the route fit's 16: this frames a straight line
          // between two points, and the route that ends up drawn between them
          // is longer than it in every case.
          maxZoom: 15,
        },
      )
      return
    }
    map.easeTo({ center: [origin.lon, origin.lat], zoom: 14, duration: instant ? 0 : 500 })
  }, [origin, dest, routes.length, isMobile, ready])

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
        markerElement('marker--origin', `Start: ${origin.name ?? 'your location'}`),
      )
    }
    if (dest) {
      add(
        [dest.lon, dest.lat],
        markerElement('marker--dest', `Destination: ${dest.name ?? 'chosen point'}`),
      )
    }

    // Barrier dots: rose for steps, amber for everything else, each with a
    // surface ring, at the barrier's own coordinates. DOM markers rather than
    // a circle layer: they carry an aria-label, and they are the one thing on
    // this map a user must not miss. In detail focus and in follow mode only
    // the route being looked at contributes its barriers.
    const withBarriers =
      followActive && followRouteId
        ? routes.filter((r) => r.id === followRouteId)
        : focus
          ? routes.filter((r) => r.id === selected)
          : routes
    for (const route of withBarriers) {
      for (const blocker of route.blockers ?? []) {
        add(
          [blocker.lon, blocker.lat],
          markerElement(
            blocker.type === 'steps' ? 'marker--barrier marker--barrier-steps' : 'marker--barrier',
            `Barrier on the ${route.label} route. ${blocker.type}: ${blocker.description}`,
          ),
        )
      }
    }
  }, [routes, selected, origin, dest, focus, followActive, followRouteId, ready])

  const basemap = basemapFor(layer)
  const drawn = routes.filter((r) => r.geometry?.length > 1)
  const chosen = routes.find((r) => r.id === selected)
  const summary = drawn.length
    ? `Map showing ${drawn.length} route${drawn.length === 1 ? '' : 's'}: ${drawn
        .map((r) => `${r.label} as a ${styleFor(r.id).pattern} line`)
        .join(', ')}.${chosen ? ` ${chosen.label} is selected.` : ''} Every route is described in full in the cards over this map.`
    : 'Map of the area. No routes are drawn yet.'
  // The basemap belongs in the summary as well as in the picker's own label.
  // Someone arriving at this region has not necessarily passed the control,
  // and "drawn on satellite imagery" is the sentence that explains why the
  // labels look different from the last time they were here.
  const layerSummary = `Drawn on the ${basemap.label.toLowerCase()} layer.`

  // The amenity dots, in words.
  //
  // They are drawn as two colours of circle, and colour is never the only
  // channel in this app. The detail list carries a glyph and a name for each
  // one; this is the map's own account of them, so that a screen-reader user
  // who is told there are dots is also told what the dots are. Types rather
  // than a bare count, because "3 amenities" and "a bench, a viewpoint and
  // drinking water" answer different questions.
  const stops = chosen?.rest_stops ?? []
  const stopKinds = [...new Set(stops.map((stop) => shortLabel(stop.type).toLowerCase()))]
  const amenitySummary = stops.length
    ? ` ${stops.length} amenit${stops.length === 1 ? 'y' : 'ies'} marked on it: ${stopKinds.join(', ')}.`
    : ''

  return (
    <section className="map" aria-label="Map of the suggested routes">
      <div className="map__canvas" ref={containerRef} />

      {failed && (
        <div className="map__fallback">
          <p>
            The map could not load. Every route is described in full in its card and detail;
            nothing is missing from them.
          </p>
        </div>
      )}

      {/* One right-edge stack for every map control, in both states.
          Deliberately not top-right: in follow mode the turn banner is a
          full-width card at the top of the layer, and a top-right control
          would sit on the distance figure — the single largest thing on a
          screen somebody is walking by. */}
      <div className="map__controls">
        <LayerPicker layer={layer} onLayer={onLayer} open={pickerOpen} onOpen={setPickerOpen} />

        {/* Follow mode only. On the plan screen the map is always north-up and
            a compass with nothing to undo is a control that teaches people the
            wrong thing about what this app does. */}
        {followActive && (
          <button
            type="button"
            className={courseUp ? 'map__compass map__compass--on' : 'map__compass'}
            aria-pressed={courseUp}
            // The name says what the control does, not what state it is in.
            // "North up" as a label on a pressed toggle reads as a claim that
            // north IS up, which is the opposite of true while it is pressed.
            aria-label="Turn the map to face the way you are walking"
            onClick={() => setCourseUp((on) => !on)}
          >
            <CompassIcon size={20} />
          </button>
        )}

        {/* Only after a gesture has taken the camera, and gone again the moment
            it is handed back. A permanent re-centre button on a screen someone
            is walking with is one more thing to read; a button that appears
            exactly when it has something to do is a status as much as a
            control. */}
        {followActive && cameraTaken && (
          <button type="button" className="map__recentre" onClick={recentre}>
            Re-centre
          </button>
        )}
      </div>

      <p className="map-attribution">
        {basemap.credits.map((credit, i) => (
          <span key={credit.text}>
            {i > 0 ? ', ' : null}
            {credit.before ? `${credit.before} ` : null}
            {credit.href ? (
              <a href={credit.href} target="_blank" rel="noreferrer">
                {credit.text}
              </a>
            ) : (
              credit.text
            )}
            {credit.after ? ` ${credit.after}` : null}
          </span>
        ))}
      </p>

      <p className="visually-hidden">{`${summary}${amenitySummary} ${layerSummary}`}</p>
    </section>
  )
}
