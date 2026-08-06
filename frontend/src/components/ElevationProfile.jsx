import { useId } from 'react'

import { fmtDist } from '../lib/format.js'

/**
 * The route's shape.
 *
 * Two sizes from one component: a bare sparkline for tier 1, and the full
 * profile with axes and shaded steep stretches for tier 3.
 *
 * **The shaded stretches are not decoration.** They are the same >8% gradient
 * the accessibility engine rejects on, and the threshold travels on the wire
 * (`limit_pct`) rather than being restated here, so the drawing cannot drift
 * from the verdict. A hill drawn as fine on a route the engine refused would be
 * the app contradicting itself about the thing it exists to get right.
 *
 * The SVG is aria-hidden and paired with a text summary, because a polyline is
 * not an accessible description of anything. The summary carries the same
 * facts: total climb, total descent, steepest gradient, and whether any of it
 * breaks the limit.
 */
export default function ElevationProfile({ profile, compact = false }) {
  const gradientId = useId()
  if (!profile?.elevations_m?.length) return null

  const { distances_m: xs, elevations_m: ys, steep_spans: steep = [], limit_pct: limit } = profile

  const W = 100
  const H = compact ? 20 : 40
  const minY = Math.min(...ys)
  const maxY = Math.max(...ys)
  // A dead-flat route would divide by zero and, worse, would draw as a line
  // pinned to the top or bottom of the box rather than through the middle.
  const span = maxY - minY || 1
  const maxX = xs[xs.length - 1] || 1

  const px = (i) => (xs[i] / maxX) * W
  const py = (i) => H - ((ys[i] - minY) / span) * (H - 2) - 1

  const line = ys.map((_, i) => `${px(i).toFixed(2)},${py(i).toFixed(2)}`).join(' ')
  const area = `0,${H} ${line} ${W},${H}`

  const hasSteep = steep.length > 0
  const summary =
    `Climbs ${Math.round(profile.ascent_m)} m and descends ` +
    `${Math.round(profile.descent_m)} m. Steepest gradient ` +
    `${profile.max_gradient_pct}%` +
    (hasSteep
      ? `, which is over the ${limit}% limit this app treats as impassable — ` +
        `${steep.length} stretch${steep.length === 1 ? '' : 'es'} marked.`
      : `, within the ${limit}% limit.`)

  if (compact) {
    return (
      <span className="spark" title={summary}>
        <svg
          className="spark__svg"
          viewBox={`0 0 ${W} ${H}`}
          preserveAspectRatio="none"
          aria-hidden="true"
          focusable="false"
        >
          <polyline className="spark__line" points={line} vectorEffect="non-scaling-stroke" />
        </svg>
        <span className="visually-hidden">{summary}</span>
      </span>
    )
  }

  return (
    <div className="profile">
      <h4 className="profile__title">Climb</h4>

      <svg
        className="profile__svg"
        viewBox={`0 0 ${W} ${H}`}
        preserveAspectRatio="none"
        aria-hidden="true"
        focusable="false"
      >
        <defs>
          <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" className="profile__fill-top" />
            <stop offset="100%" className="profile__fill-bottom" />
          </linearGradient>
        </defs>

        <polygon points={area} fill={`url(#${gradientId})`} />

        {/* Drawn under the line, so the line stays readable over the shading. */}
        {steep.map(([a, b], i) => {
          const x = px(a)
          const width = Math.max(0.6, px(Math.min(b, xs.length - 1)) - x)
          return <rect key={i} className="profile__steep" x={x} y="0" width={width} height={H} />
        })}

        <polyline className="profile__line" points={line} vectorEffect="non-scaling-stroke" />
      </svg>

      <div className="profile__axis" aria-hidden="true">
        <span>{Math.round(minY)} m</span>
        <span>{fmtDist(maxX)}</span>
        <span>{Math.round(maxY)} m</span>
      </div>

      <p className="profile__summary">{summary}</p>

      {hasSteep && (
        <p className="profile__warn">
          The shaded stretches are steeper than {limit}%. That is the same limit the
          accessible route refuses to cross.
        </p>
      )}
    </div>
  )
}
