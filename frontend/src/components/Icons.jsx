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
