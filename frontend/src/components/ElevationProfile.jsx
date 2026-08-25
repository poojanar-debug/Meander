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
export default function ElevationProfile({ profile, units }) {
  if (!profile?.elevations_m?.length) {
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

  return (
    <div className="profile">
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
      </svg>

      <div className="profile__axis mono" aria-hidden="true">
        {/* The origin tick wears the far end's unit — "0 km" beside "2.6 km",
            per the mockups — derived from the formatter's own output rather
            than restated, so the units stay whatever the user chose. */}
        <span>{fmtDist(maxX, units).replace(/^[\d.]+/, '0')}</span>
        <span>{fmtDist(maxX, units)}</span>
      </div>

      <p className="profile__stat mono">{statLine}</p>

      <p className="visually-hidden">{summary}</p>
    </div>
  )
}
