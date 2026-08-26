/**
 * What the things on the wire as `rest_stops` actually are.
 *
 * ## Why this file exists at all
 *
 * The backend has returned `rest_stops` since it shipped, four amenity types
 * deep, and three surfaces consumed them: `RouteDetail` drew a mint pill with
 * a word in it, `MapView` drew an undifferentiated mint circle, and
 * `followTracking` computed the next one ahead which nothing rendered. Each of
 * those had its own opinion about what a type string meant, and none of them
 * agreed about normalisation — `restPillLabel` in RouteDetail already handled
 * both `drinking water` and `drinking_water` because the two spellings both
 * reach the frontend, and nothing else did.
 *
 * One table, read by all of them.
 *
 * ## Viewpoints are not rest stops, and the code has to know that
 *
 * The other four are facilities: places to sit, drink, shelter, relieve
 * yourself. They matter to someone who is already tired or already caught in
 * the rain. A viewpoint is the opposite kind of thing — a reason to take the
 * route in the first place — and it arrives here from `tourism=viewpoint`
 * rather than `amenity=*`.
 *
 * It travels in the same list because the corridor match, the spacing score
 * and the map layer all want to treat it the same way geometrically. It is
 * drawn and worded differently everywhere a person sees it, because treating
 * "there is a bench in 200 m" and "there is a view in 200 m" as the same
 * sentence would waste the only one of the two that would make somebody look
 * up from the phone.
 */

/** `drinking water` and `drinking_water` both reach the frontend. */
export function normaliseType(type) {
  return String(type ?? '')
    .toLowerCase()
    .trim()
    .replace(/\s+/g, '_')
}

export function isViewpoint(type) {
  return normaliseType(type) === 'viewpoint'
}

/** The short pill vocabulary. An unknown type keeps its own name, made
 *  readable, rather than being folded into a neighbour it is not. */
const SHORT = {
  bench: 'Bench',
  drinking_water: 'Water',
  fountain: 'Water',
  toilets: 'Toilets',
  shelter: 'Shelter',
  viewpoint: 'Viewpoint',
}

export function shortLabel(type) {
  const key = normaliseType(type)
  if (SHORT[key]) return SHORT[key]
  const readable = key.replace(/_/g, ' ')
  return readable.charAt(0).toUpperCase() + readable.slice(1)
}

/**
 * How the thing is named mid-sentence, in follow mode.
 *
 * Lower case and with an article, because these land inside "There is a bench
 * in 200 m" rather than on a pill of their own. A viewpoint gets "a view"
 * rather than "a viewpoint": the noun somebody walking cares about is what
 * they will see, not the OSM tag that recorded it.
 */
const SPOKEN = {
  bench: 'a bench',
  drinking_water: 'drinking water',
  fountain: 'drinking water',
  toilets: 'toilets',
  shelter: 'shelter',
  viewpoint: 'a view',
}

export function spokenLabel(type) {
  const key = normaliseType(type)
  return SPOKEN[key] ?? key.replace(/_/g, ' ')
}
