/**
 * What the map is drawn on.
 *
 * Three choices, and only one of them is free.
 *
 * ## Why this is a table rather than three branches in MapView
 *
 * Each entry has to answer four separate questions that were previously
 * scattered: what raster source (if any) sits under the routes, how the vector
 * layers underneath are recoloured, what attribution the footer owes, and
 * **whether choosing it starts fetching tiles while somebody walks**. That last
 * one is not a styling detail, and keeping it in the same row as the label is
 * the point of the table: nothing can add a basemap here and forget to say
 * what it costs.
 *
 * ## The privacy cost, stated once, here
 *
 * The default basemap costs nothing to follow with, and that was measured
 * rather than assumed — see the note above `FOLLOW_METRES_PER_PIXEL` in
 * `MapView.jsx`. OpenFreeMap's vector source declares `maxzoom: 14`, so the
 * z17 camera follow mode uses is served by overzooming tiles the client
 * already holds. A full simulated walk made three requests, all glyph ranges,
 * and not one tile request.
 *
 * **Satellite breaks that, and it cannot be made not to.** Esri's imagery is
 * raster and goes to z19, so every metre walked at follow zoom pulls new tiles
 * from `server.arcgisonline.com`, and the sequence of those requests is the
 * walk. `sw.js` will not cache them (a tile cache is a record of where you have
 * been), so they are not written to disk either, but they are made, and the
 * host sees them.
 *
 * That is a real trade and the app says so in three places rather than none:
 * `streamsTiles` puts a warning in the layer picker at the moment of choosing,
 * `MapView` swaps the attribution line, and `FollowMode` swaps its provenance
 * sentence so the screen someone is walking with never claims "no network in
 * follow mode" while it is streaming imagery. A privacy claim that is true for
 * the default and false for one setting is worse than no claim, because the
 * setting is the one where it matters.
 *
 * ## Green cover costs nothing
 *
 * It is the same OpenFreeMap vector tiles with a different set of paint
 * properties, so it is exactly as cheap and exactly as private as the default,
 * and it is the layer that actually shows what the scenic and shade presets
 * are steering on.
 */

/** The vector basemap every layer here is built from. */
export const STYLE_URL = 'https://tiles.openfreemap.org/styles/positron'

/**
 * Esri's World Imagery.
 *
 * ## `{z}/{y}/{x}`, and this was verified rather than assumed
 *
 * The ArcGIS REST tile scheme addresses **row before column**, so `{y}` comes
 * second and `{x}` last. Transposing them does not fail. Measured directly: at
 * z10 the tile covering London is x=511, y=340, and both `/10/340/511` and
 * `/10/511/340` return HTTP 200 with `image/jpeg`. The first is London with the
 * Thames through it. The second is dense tropical forest. Both indices are
 * valid at z10, so the server has no way to know one of them is a mistake and
 * no error is ever raised — the symptom is a map of the wrong hemisphere that
 * looks entirely healthy.
 *
 * ## ⚠ Licensing: this needs a free ArcGIS Developer account
 *
 * The endpoint is technically keyless, and that is not the same as being
 * licensed. Esri's own published guidance permits unrestricted keyless use for
 * OpenStreetMap *tracing and editing*; embedding the imagery in a third-party
 * application is a different case, and for that Esri asks for all four of: a
 * free ArcGIS Developer account, no revenue generation, under a million tiles a
 * month, and the attribution below. This project clears three of those on its
 * own. The account is a registration, not a payment, and it is the one that has
 * to be done by a person rather than by this file.
 *
 * If that ever becomes untenable — the project takes revenue, or Esri changes
 * the terms — the swap is one line. EOX's Sentinel-2 cloudless is verified
 * keyless, CC BY-NC-SA 4.0, and CORS-open:
 *
 *   https://tiles.maps.eox.at/wmts/1.0.0/s2cloudless-2020_3857/default/g/{z}/{y}/{x}.jpg
 *   attribution: EOxCloudless 2020 by EOX IT Services GmbH,
 *                contains modified Copernicus Sentinel data 2020
 *
 * It is not the default because it is 10 m/pixel and EOX's own documentation
 * says z13 best resembles the source resolution. Follow mode runs at about z17.
 * At that zoom Sentinel-2 is an upsampled blur, which for a walking app is the
 * difference between seeing the path and seeing a green smear.
 */
const ESRI_IMAGERY =
  'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'

/** The origin the CSP has to name, in `img-src` and `connect-src` both.
 *
 *  Both, and not just `img-src`: MapLibre v5 loads raster tiles through
 *  `fetch`, not through an `<img>`. `MapView.jsx` records what a CSP that
 *  forgot `connect-src` looks like from the user's side — a permanently blank
 *  basemap after a twenty-second timeout, with no error anywhere. The service
 *  sends `Access-Control-Allow-Origin: *`, which is the other half of what a
 *  fetch-based tile loader needs and was confirmed against live responses. */
export const ESRI_ORIGIN = 'https://server.arcgisonline.com'

/**
 * The recolour applied to the vector layers under each basemap.
 *
 * Values are **token names**, never literals: MapLibre paints to a canvas and
 * needs a colour string, so `MapView` resolves these through `getComputedStyle`
 * at paint time. Writing a hex here would put a colour outside the two `:root`
 * blocks, which is the one rule `check_palette.sh` exists to enforce, and it
 * would drift from the stylesheet the first time either moved.
 */
const PALETTES = {
  map: {
    land: '--map-land',
    park: '--map-park',
    water: '--map-water',
    road: '--map-road',
    building: '--map-land',
    label: '--ink',
    labelHalo: '--map-land',
  },
  // Greenery forward, everything else stepped back. The park tone is the one
  // that changes most; roads and buildings drop toward the land tone so a
  // wooded corridor reads as a shape rather than competing with the street
  // grid it runs through.
  green: {
    land: '--map-green-land',
    park: '--map-green-park',
    water: '--map-green-water',
    road: '--map-green-road',
    building: '--map-green-land',
    // Still `--ink`, not a lighter grey. Stepping the labels back would suit the
    // layer's intent and cost legibility on the one screen where a street name
    // is the thing being looked for; the roads receding is what puts the
    // greenery forward, and that is enough.
    label: '--ink',
    labelHalo: '--map-green-land',
  },
  // Under imagery only the labels are visible, and they are being read against
  // photographs of unknown darkness. Light text with a dark halo is the pair
  // that survives both a snow field and a night-dark forest.
  satellite: {
    label: '--on-dark',
    labelHalo: '--ink',
  },
}

/**
 * Attribution owed, as fragments the footer joins with commas.
 *
 * Split into `before` / `text` / `after` rather than held as one string
 * because only the middle is a link, and OpenStreetMap's licence asks for a
 * credit *and* a link to the licence. Esri's asks for the credit line only, so
 * that entry has no `href` and renders as plain text.
 *
 * This is a licence obligation, not a design element. Adding a basemap without
 * adding its credit here is the one change in this file that can be unlawful,
 * which is why `credits` is a required field on every row rather than an
 * optional one that defaults to empty.
 */
const OSM_CREDIT = {
  before: 'map data ©',
  text: 'OpenStreetMap',
  href: 'https://www.openstreetmap.org/copyright',
  after: 'contributors',
}

export const BASEMAPS = [
  {
    id: 'map',
    label: 'Map',
    hint: 'The default. Streets, parks and water.',
    palette: PALETTES.map,
    raster: null,
    streamsTiles: false,
    credits: [OSM_CREDIT],
  },
  {
    id: 'green',
    label: 'Green cover',
    hint: 'Parks and woodland forward. Same tiles, same privacy.',
    palette: PALETTES.green,
    raster: null,
    streamsTiles: false,
    credits: [OSM_CREDIT],
  },
  {
    id: 'satellite',
    label: 'Satellite',
    hint: 'Aerial imagery. Fetches tiles as you move, including while following.',
    palette: PALETTES.satellite,
    raster: {
      tiles: [ESRI_IMAGERY],
      tileSize: 256,
      maxzoom: 19,
    },
    streamsTiles: true,
    // The labels are still OpenStreetMap's: the raster sits *under* the first
    // symbol layer, so every street name over the imagery came from the vector
    // tiles. Both credits are owed, and dropping the OSM one because the
    // picture is Esri's would be the easy mistake.
    //
    // The Esri line is the service's own `copyrightText`, read from
    // `.../World_Imagery/MapServer?f=json` and reproduced verbatim rather than
    // paraphrased. It is not the string most tutorials carry: Maxar rebranded
    // to Vantor in 2025 and the service updated its credit accordingly, so
    // "Esri, Maxar, Earthstar Geographics" is now the wrong attribution rather
    // than merely an old one. Re-read that field before editing this.
    credits: [
      OSM_CREDIT,
      { text: 'Source: Esri, Vantor, Earthstar Geographics, and the GIS User Community' },
    ],
  },
]

export const DEFAULT_BASEMAP = 'map'

/** Never returns undefined: an unknown id is the default, not a blank map. */
export function basemapFor(id) {
  return BASEMAPS.find((b) => b.id === id) ?? BASEMAPS[0]
}

/**
 * Whether this basemap makes tile requests while following.
 *
 * A function rather than a field read at every call site so that the question
 * has one name. `FollowMode` asks it to decide which provenance sentence is
 * honest, and that decision must not be reachable by anything else.
 */
export function streamsWhileFollowing(id) {
  return basemapFor(id).streamsTiles === true
}
