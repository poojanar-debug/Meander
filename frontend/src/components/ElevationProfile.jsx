import { fmtDist } from '../lib/format.js'
import { UNKNOWN, formatElevation } from '../lib/units.js'

/**
 * The route's climb: a 2.5px sky polyline over a hairline baseline, the steep
 * stretches re-drawn on top in 4px amber, the two ends of the distance axis,
 * and the stat line.
 *
 * **The amber stretches are not decoration.** They are the same gradient the
 * accessible preset refuses to cross, and the threshold arrives on the wire
 * as `limit_pct` rather than being restated here: the drawing and the verdict
 * cannot be allowed to disagree. The amber line is also thicker than the sky
 * one, so the marking survives greyscale.
 *
 * Null is "the router returned no elevation", which is not the same statement
 * as "this route is level" — it renders as the sentence, never as a flat
 * line. The SVG is aria-hidden and paired with a text summary, because a
 * polyline is not an accessible description of anything.
 */
export default function ElevationProfile({
  profile,
  units,
  // Metres walked so far, for the marker that rides the line in follow mode.
  // Null everywhere else, which is every use of this component that existed
  // before follow mode learned to draw it.
  atM = null,
  // Follow mode's version: the line, the marker, and nothing else. The stat
  // line and the axis are two more things to read on a screen somebody is
  // walking with, and both of them say what the detail sheet already said
  // before they set off.
  compact = false,
}) {
  if (!profile?.elevations_m?.length) {
    // Nothing at all in compact mode. On the detail sheet the sentence is the
    // honest answer to a question the reader asked by opening it; in follow
    // mode it is an unprompted paragraph about missing data, taking up the
    // space of the thing it is apologising for.
    if (compact) return null
    return (
      <p className="profile__absent">
        Climb was not measured for this route. That is not the same as it being level.
      </p>
    )
  }

  const {
    distances_m: xs,
    elevations_m: ys,
    steep_spans: steep = [],
    limit_pct: limit,
  } = profile

  const W = 100
  const H = 32
  const minY = Math.min(...ys)
  const maxY = Math.max(...ys)
  // A dead-flat route would divide by zero and, worse, would draw pinned to
  // the top or bottom of the box rather than through the middle of it.
  const span = maxY - minY || 1
  const maxX = xs[xs.length - 1] || 1

  const px = (i) => (xs[i] / maxX) * W
  const py = (i) => H - 2 - ((ys[i] - minY) / span) * (H - 6)

  const point = (i) => `${px(i).toFixed(2)},${py(i).toFixed(2)}`
  const line = ys.map((_, i) => point(i)).join(' ')

  // Gradients carry one decimal, no more: the samples are thinned and capped,
  // and a second decimal would be precision nothing measured. A profile that
  // arrives without a gradient figure renders the unknown glyph — Number(null)
  // is 0, and "max 0.0%" would be a measurement claim about a slope nobody
  // measured.
  const gradientKnown =
    typeof profile.max_gradient_pct === 'number' && Number.isFinite(profile.max_gradient_pct)
  const maxPct = gradientKnown ? `${profile.max_gradient_pct.toFixed(1)}%` : UNKNOWN
  const statLine =
    `${formatElevation(profile.ascent_m, units)} up · ` +
    `${formatElevation(profile.descent_m, units)} down · max ${maxPct}` +
    (limit == null ? '' : ` — limit ${limit}%`)

  const summary =
    `Climbs ${formatElevation(profile.ascent_m, units)} and descends ` +
    `${formatElevation(profile.descent_m, units)}. ` +
    (gradientKnown ? `Steepest gradient ${maxPct}` : 'Steepest gradient not measured') +
    (steep.length > 0
      ? `, over the ${limit}% limit the accessible preset holds to; ` +
        `${steep.length} stretch${steep.length === 1 ? '' : 'es'} marked in amber.`
      : limit == null
        ? '.'
        : `, within the ${limit}% limit.`)

  // Where the walker is on the line, in the SVG's own coordinates.
  //
  // Interpolated between the two bracketing samples rather than snapped to the
  // nearest one. The profile is thinned before it reaches the wire, so
  // consecutive samples can be a couple of hundred metres apart, and snapping
  // would park the marker at a sample while the elevation under it belonged to
  // somewhere else entirely.
  const walked =
    typeof atM === 'number' && Number.isFinite(atM) && maxX > 0
      ? Math.min(maxX, Math.max(0, atM))
      : null
  let marker = null
  if (walked != null) {
    let i = 1
    while (i < xs.length - 1 && xs[i] < walked) i += 1
    const span = xs[i] - xs[i - 1]
    const t = span > 0 ? (walked - xs[i - 1]) / span : 0
    marker = { x: px(i - 1) + (px(i) - px(i - 1)) * t, y: py(i - 1) + (py(i) - py(i - 1)) * t }
  }

  return (
    <div className={compact ? 'profile profile--compact' : 'profile'}>
      <svg
        className="profile__svg"
        viewBox={`0 0 ${W} ${H}`}
        preserveAspectRatio="none"
        aria-hidden="true"
        focusable="false"
      >
        <line className="profile__baseline" x1="0" y1={H - 0.5} x2={W} y2={H - 0.5} />
        <polyline className="profile__line" points={line} vectorEffect="non-scaling-stroke" />
        {steep.map(([a, b], i) => {
          const to = Math.min(b, ys.length - 1)
          const overlay = ys
            .slice(a, to + 1)
            .map((_, j) => point(a + j))
            .join(' ')
          return (
            <polyline
              key={`${a}-${b}-${i}`}
              className="profile__steep"
              points={overlay}
              vectorEffect="non-scaling-stroke"
            />
          )
        })}
        {marker && (
          <>
            {/* The stretch already walked, greyed under the live line, so the
                marker reads as a position on a journey rather than as a dot on
                a chart. Same relationship the map's follow-behind line has to
                follow-ahead, and drawn in the same token. */}
            <polyline
              className="profile__walked"
              points={ys
                .map((_, i) => (xs[i] <= walked ? point(i) : null))
                .filter(Boolean)
                .concat(`${marker.x.toFixed(2)},${marker.y.toFixed(2)}`)
                .join(' ')}
              vectorEffect="non-scaling-stroke"
            />
            {/* preserveAspectRatio is "none" on this SVG, so the viewBox is
                stretched horizontally by whatever width the container has.
                A <circle> would be drawn as an ellipse wider than it is tall,
                and noticeably so. A vertical rule has no aspect to distort. */}
            <line
              className="profile__here"
              x1={marker.x}
              y1="0"
              x2={marker.x}
              y2={H}
              vectorEffect="non-scaling-stroke"
            />
          </>
        )}
      </svg>

      {compact ? null : (
      <div className="profile__axis mono" aria-hidden="true">
        {/* The origin tick wears the far end's unit — "0 km" beside "2.6 km",
            per the mockups — derived from the formatter's own output rather
            than restated, so the units stay whatever the user chose. */}
        <span>{fmtDist(maxX, units).replace(/^[\d.]+/, '0')}</span>
        <span>{fmtDist(maxX, units)}</span>
      </div>
      )}

      {compact ? null : <p className="profile__stat mono">{statLine}</p>}

      {/* Not repeated in compact mode. Follow mode already announces its own
          state through the app's single live region, and a second description
          of the same route read out mid-walk is the duplication that makes
          people switch a screen reader off. */}
      {compact ? null : <p className="visually-hidden">{summary}</p>}
    </div>
  )
}
