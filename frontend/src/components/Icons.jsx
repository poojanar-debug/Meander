/**
 * The redesign's icon vocabulary: tiny inline geometric SVGs in currentColor,
 * round-capped strokes between 1.8 and 4px. Inline rather than files for the
 * reasons ManoeuvreIcon.jsx already records: a PNG in public/ falls under
 * icons.test.js's launcher-icon contract, and an external asset would need a
 * CSP change whose hash csp-hash.test.js pins byte for byte.
 *
 * Every icon here is decoration beside real text, so all of them are
 * aria-hidden. The turn arrows live in ManoeuvreIcon.jsx and are generated;
 * these are drawn, because none of them is a rotation of another.
 */

const common = (size, strokeWidth) => ({
  viewBox: '0 0 24 24',
  width: size,
  height: size,
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth,
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
  'aria-hidden': 'true',
  focusable: 'false',
  className: 'icon',
})

export function MagnifierIcon({ size = 16 }) {
  return (
    <svg {...common(size, 2)}>
      <circle cx="10.5" cy="10.5" r="6" />
      <path d="M15 15l5 5" />
    </svg>
  )
}

/** Filled location arrow — the "use my location" mark. */
export function LocationArrowIcon({ size = 16 }) {
  return (
    <svg {...common(size, 1.8)}>
      <path d="M20.5 3.5 11.8 20.7l-1.6-7-7-1.6z" fill="currentColor" stroke="currentColor" />
    </svg>
  )
}

export function CaretDownIcon({ size = 12 }) {
  return (
    <svg {...common(size, 2.2)}>
      <path d="M6 9.5 12 15.5 18 9.5" />
    </svg>
  )
}

export function ChevronRightIcon({ size = 14 }) {
  return (
    <svg {...common(size, 2.2)}>
      <path d="M9 5.5 15.5 12 9 18.5" />
    </svg>
  )
}

export function ChevronLeftIcon({ size = 14 }) {
  return (
    <svg {...common(size, 2.2)}>
      <path d="M15 5.5 8.5 12 15 18.5" />
    </svg>
  )
}

/** Gate: two posts and two crossbars. */
export function GateIcon({ size = 16 }) {
  return (
    <svg {...common(size, 2)}>
      <path d="M5 4.5v15" />
      <path d="M19 4.5v15" />
      <path d="M5 9.5h14" />
      <path d="M5 15h14" />
    </svg>
  )
}

/** Steps: a 45°-rotated square. */
export function StepsIcon({ size = 16 }) {
  return (
    <svg {...common(size, 2)}>
      <path d="M12 4.5 19.5 12 12 19.5 4.5 12z" />
    </svg>
  )
}

export function CheckIcon({ size = 16 }) {
  return (
    <svg {...common(size, 2.6)}>
      <path d="M5 12.5 10 17.5 19 6.5" />
    </svg>
  )
}

/** Close mark for the modal's hairline circle. */
export function CloseIcon({ size = 14 }) {
  return (
    <svg {...common(size, 2.2)}>
      <path d="M6 6l12 12" />
      <path d="M18 6 6 18" />
    </svg>
  )
}

/** The glyph for a barrier row or chip: steps get the rotated square, gates
 *  the gate; anything else the router reports falls back to the gate mark,
 *  which reads as "something across the path" without claiming to know what. */
export function BlockerIcon({ type, size = 16 }) {
  return type === 'steps' ? <StepsIcon size={size} /> : <GateIcon size={size} />
}

/** Stacked plates: the layer picker's toggle. Three offset diamonds rather
 *  than the more common stacked rectangles, because at 20px a rectangle stack
 *  reads as a list and a diamond stack reads as sheets of map. */
export function LayersIcon({ size = 20 }) {
  return (
    <svg {...common(size, 1.9)}>
      <path d="M12 3.2 21 8l-9 4.8L3 8z" />
      <path d="M4.4 12 12 16.1 19.6 12" />
      <path d="M4.4 16 12 20.1 19.6 16" />
    </svg>
  )
}

/** North-up compass, for the button that takes the rotation back.
 *  The filled north half is what makes it a compass rather than a diamond:
 *  a symmetrical mark cannot say which way it is pointing, which is the one
 *  thing this control exists to communicate. */
export function CompassIcon({ size = 20 }) {
  return (
    <svg {...common(size, 1.8)}>
      <circle cx="12" cy="12" r="8.4" />
      <path d="M12 5.6 15 12 12 10.6 9 12z" fill="currentColor" stroke="currentColor" />
      <path d="M12 10.6 15 12 12 18.4 9 12z" />
    </svg>
  )
}

/** Drinking water: the tap and the drop it throws. */
export function WaterIcon({ size = 16 }) {
  return (
    <svg {...common(size, 1.9)}>
      <path d="M6 5.5h5.5a4 4 0 0 1 4 4V12" />
      <path d="M4 5.5h4" />
      <path d="M15.5 15.2c1.5 1.7 2.4 2.9 2.4 3.9a2.4 2.4 0 1 1-4.8 0c0-1 .9-2.2 2.4-3.9z" />
    </svg>
  )
}

/** A bench, seen from the side. */
export function BenchIcon({ size = 16 }) {
  return (
    <svg {...common(size, 1.9)}>
      <path d="M3.5 10.5h17" />
      <path d="M3.5 13.5h17" />
      <path d="M6 13.5v5" />
      <path d="M18 13.5v5" />
      <path d="M5 10.5V7" />
      <path d="M19 10.5V7" />
    </svg>
  )
}

/** Toilets: the door and its handle, which is all a 16px glyph can carry
 *  without resorting to the gendered figures this app has no business
 *  drawing. */
export function ToiletsIcon({ size = 16 }) {
  return (
    <svg {...common(size, 1.9)}>
      <path d="M6 3.5h12v17H6z" />
      <circle cx="14.8" cy="12" r="1" fill="currentColor" stroke="none" />
    </svg>
  )
}

/** Shelter: a roof over nothing, which is what a shelter is. */
export function ShelterIcon({ size = 16 }) {
  return (
    <svg {...common(size, 1.9)}>
      <path d="M2.8 11.5 12 4.5l9.2 7" />
      <path d="M5.5 11.5v8" />
      <path d="M18.5 11.5v8" />
    </svg>
  )
}

/** Viewpoint: an eye on the horizon. The one amenity type that is a reason to
 *  go somewhere rather than a facility for when you are already there. */
export function ViewpointIcon({ size = 16 }) {
  return (
    <svg {...common(size, 1.9)}>
      <path d="M2.5 12s3.6-5.5 9.5-5.5S21.5 12 21.5 12s-3.6 5.5-9.5 5.5S2.5 12 2.5 12z" />
      <circle cx="12" cy="12" r="2.4" />
    </svg>
  )
}

/** The fallback amenity mark: a plain ring, claiming nothing about what is
 *  there beyond that something is. */
export function AmenityIcon({ size = 16 }) {
  return (
    <svg {...common(size, 2)}>
      <circle cx="12" cy="12" r="6.5" />
    </svg>
  )
}

/** The glyph for an amenity, chosen by its type.
 *
 *  Lives here rather than beside one of its callers because three surfaces
 *  want it — the detail pills, the follow-mode cue and (as an aria-label) the
 *  map summary — and a switch statement copied three times is three chances
 *  for a bench to acquire a toilet's icon on one screen and not the others.
 *
 *  The fallback is the plain ring, which claims nothing beyond "something is
 *  here". That is load-bearing: the Overpass query can widen without this
 *  table widening with it, and an unrecognised amenity borrowing a bench's
 *  glyph would be the map telling somebody there is somewhere to sit. */
export function AmenityGlyph({ type, size = 14 }) {
  const t = String(type ?? '').toLowerCase().replace(/\s+/g, '_')
  if (t === 'bench') return <BenchIcon size={size} />
  if (t === 'drinking_water' || t === 'fountain') return <WaterIcon size={size} />
  if (t === 'toilets') return <ToiletsIcon size={size} />
  if (t === 'shelter') return <ShelterIcon size={size} />
  if (t === 'viewpoint') return <ViewpointIcon size={size} />
  return <AmenityIcon size={size} />
}
