/**
 * The turn glyph beside the next instruction.
 *
 * `Step.sign` has been on the wire since the first day there were steps —
 * parsed at `routing.py:441`, carried at `main.py:722`, declared at
 * `models.py:159` — and until this file existed `grep -rn '\.sign\b'
 * frontend/src` returned zero lines. Nothing had ever read it. A Google Maps
 * banner is a glyph, a distance and a street name, and this is the glyph.
 *
 * **Inline SVG rather than an image, for two concrete reasons.** A PNG in
 * `frontend/public/` is scanned by `icons.test.js`, which stats every
 * `href="/…"` in index.html and pins the maskable icon's geometry to the pixel
 * — a turn arrow has no business in that contract. And an external asset would
 * need a CSP change in `public/_headers`, whose sha256 for the one inline
 * script is asserted byte-for-byte by `csp-hash.test.js`. Inline SVG needs
 * neither.
 *
 * Colour comes from `currentColor`, so the glyph is whatever the text beside it
 * is in both themes and `check_palette.sh` has nothing to find.
 *
 * ## Why the arrows are generated rather than drawn
 *
 * Eight of the twelve signs are the same arrow at a different angle. Hand-
 * authoring eight sets of path data means eight chances for one of them to sit
 * a pixel off the others, and the family reads as wrong long before anyone can
 * say which member is wrong. So the shaft, the leg and the head are computed
 * from one turn angle, and the four that are not arrows — arrive, via,
 * roundabout, and the two keep-left/right forks — are drawn explicitly because
 * they genuinely are different shapes.
 */

/** GraphHopper's sign vocabulary, in degrees clockwise from straight on. */
const TURN_ANGLE = {
  '-3': -135, // sharp left
  '-2': -90, // left
  '-1': -35, // slight left
  0: 0, // continue
  1: 35, // slight right
  2: 90, // right
  3: 135, // sharp right
}

const RAD = Math.PI / 180
const CORNER = [12, 13.5]
const LEG = 8.5
const HEAD = 4.5

/**
 * Shaft up the middle to a corner, one leg out at the turn angle, and a head on
 * the end of it. At angle 0 the corner is collinear with both and the result is
 * a straight arrow, which is what "continue" should look like.
 */
function arrow(angleDeg) {
  const dx = Math.sin(angleDeg * RAD)
  const dy = -Math.cos(angleDeg * RAD)
  const tip = [CORNER[0] + LEG * dx, CORNER[1] + LEG * dy]
  const barb = (spread) => {
    const a = (angleDeg + spread) * RAD
    return [tip[0] - HEAD * Math.sin(a), tip[1] + HEAD * Math.cos(a)]
  }
  const [l, r] = [barb(-40), barb(40)]
  const n = (v) => Math.round(v * 100) / 100
  return [
    `M12 22 L${n(CORNER[0])} ${n(CORNER[1])} L${n(tip[0])} ${n(tip[1])}`,
    `M${n(l[0])} ${n(l[1])} L${n(tip[0])} ${n(tip[1])} L${n(r[0])} ${n(r[1])}`,
  ]
}

/** A stem that splits, with the taken branch drawn and the other left thin. */
function fork(toRight) {
  const s = toRight ? 1 : -1
  const n = (v) => Math.round(v * 100) / 100
  return {
    taken: `M12 22 V15 L${n(12 + s * 5.5)} ${n(8)}`,
    other: `M12 15 L${n(12 - s * 5.5)} ${n(8)}`,
    head: `M${n(12 + s * 5.5 - s * 4.6)} ${n(8.6)} L${n(12 + s * 5.5)} ${n(8)} L${n(12 + s * 5.5 + s * 0.6)} ${n(12.6)}`,
  }
}

/**
 * The spoken name of each manoeuvre.
 *
 * Not rendered: the instruction text beside the glyph already says it, and a
 * screen reader reading "turn right, Turn right onto Fleet Street" is the
 * duplication that makes people switch the thing off. The glyph is
 * `aria-hidden` and this table exists so the *title* is available to anyone
 * debugging the DOM, and so the mapping is written down somewhere legible.
 */
export const MANOEUVRE_NAME = {
  '-7': 'keep left',
  '-3': 'sharp left',
  '-2': 'left',
  '-1': 'slight left',
  0: 'continue',
  1: 'slight right',
  2: 'right',
  3: 'sharp right',
  4: 'arrive',
  5: 'via point',
  6: 'roundabout',
  7: 'keep right',
}

export default function ManoeuvreIcon({ sign = 0, className = 'manoeuvre' }) {
  const key = String(sign ?? 0)
  const common = {
    className,
    viewBox: '0 0 24 24',
    width: '1em',
    height: '1em',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 2,
    strokeLinecap: 'round',
    strokeLinejoin: 'round',
    'aria-hidden': 'true',
    focusable: 'false',
  }

  if (key === '4') {
    // Arrive: a pin, because a flag reads as a start and this is an end.
    return (
      <svg {...common}>
        <path d="M12 22c0-5 6-7.5 6-12a6 6 0 1 0-12 0c0 4.5 6 7 6 12z" />
        <circle cx="12" cy="10" r="2.25" />
      </svg>
    )
  }

  if (key === '5') {
    // Via: a waypoint diamond, distinct from both the turn arrows and the pin.
    return (
      <svg {...common}>
        <path d="M12 3.5 20.5 12 12 20.5 3.5 12z" />
        <circle cx="12" cy="12" r="1.75" />
      </svg>
    )
  }

  if (key === '6') {
    // Roundabout: the ring, the approach, and one exit taken.
    return (
      <svg {...common}>
        <circle cx="11" cy="12" r="5" />
        <path d="M11 22v-5" />
        <path d="M16 12h5" />
        <path d="M18.5 9 21 12l-2.5 3" />
      </svg>
    )
  }

  if (key === '7' || key === '-7') {
    const f = fork(key === '7')
    return (
      <svg {...common}>
        <path d={f.other} strokeWidth={1.25} opacity={0.55} />
        <path d={f.taken} />
        <path d={f.head} />
      </svg>
    )
  }

  const [shaft, head] = arrow(TURN_ANGLE[key] ?? 0)
  return (
    <svg {...common}>
      <path d={shaft} />
      <path d={head} />
    </svg>
  )
}
