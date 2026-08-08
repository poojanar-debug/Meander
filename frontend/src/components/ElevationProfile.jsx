import { useId } from 'react'

import { fmtDist } from '../lib/format.js'

/**
 * The route's climb.
 *
 * `Route.elevation` has been populated on every response since the launch
 * branch (backend/elevation.py, 12 tests) and nothing in the shipped UI read
 * it. This is the reader.
 *
 * **The shaded stretches are not decoration.** They are the same gradient the
 * accessible preset refuses to cross, and the threshold arrives on the wire as
 * `limit_pct` rather than being restated here — `backend/models.py:112-116`
 * says why: the drawing and the verdict cannot be allowed to disagree. A hill
 * drawn as fine on a route the engine rejected would be the app contradicting
 * itself about the one thing it exists to get right.
 *
 * Two departures from the launch original, both deliberate:
 *
 * 1. It no longer returns `null` when there is no profile. Absent elevation and
 *    a flat route are different statements, exactly as `models.py:100-105` says
 *    of the field itself, and a section that quietly disappears makes the
 *    second claim on behalf of the first. It says so in a sentence instead,
 *    mirroring how RouteDetail already handles `rest_stops == null`.
 *
 * 2. The steep stretches are hatched as well as tinted. Colour is never the only
 *    differentiator here, and a tinted rectangle is exactly that. The hatch and
 *    the count in the summary both survive a greyscale screenshot.
 *
 * The SVG is aria-hidden and paired with a text summary, because a polyline is
 * not an accessible description of anything.
 */
export default function ElevationProfile({ profile }) {
  const gradientId = useId()
  const hatchId = useId()

  // Null is "the router returned no elevation", not "this route is level".
  if (!profile?.elevations_m?.length) {
    return (
      <p className="field__hint">
        Climb was not measured for this route — that is not the same as it being level.
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
  const H = 40
  const minY = Math.min(...ys)
  const maxY = Math.max(...ys)
  // A dead-flat route would divide by zero and, worse, would draw pinned to the
  // top or bottom of the box rather than through the middle of it.
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

  return (
    <div className="profile">
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
          {/* Hatch, not just tint — see the note above about greyscale. */}
          <pattern
            id={hatchId}
            width="4"
            height="4"
            patternUnits="userSpaceOnUse"
            patternTransform="rotate(45)"
          >
            <line className="profile__hatch-line" x1="0" y1="0" x2="0" y2="4" />
          </pattern>
        </defs>

        <polygon points={area} fill={`url(#${gradientId})`} />

        {/* Drawn under the line, so the line stays readable over the shading. */}
        {steep.map(([a, b], i) => {
          const x = px(a)
          const width = Math.max(0.6, px(Math.min(b, xs.length - 1)) - x)
          return (
            <g key={`${a}-${b}-${i}`}>
              <rect className="profile__steep" x={x} y="0" width={width} height={H} />
              <rect x={x} y="0" width={width} height={H} fill={`url(#${hatchId})`} />
            </g>
          )
        })}

        <polyline className="profile__line" points={line} vectorEffect="non-scaling-stroke" />
      </svg>

      <div className="profile__axis" aria-hidden="true">
        <span className="tabular">{Math.round(minY)} m</span>
        <span className="tabular">{fmtDist(maxX)}</span>
        <span className="tabular">{Math.round(maxY)} m</span>
      </div>

      <p className="profile__summary">{summary}</p>

      {hasSteep && (
        <p className="profile__warn">
          The hatched stretches are steeper than {limit}%. That is the same limit the accessible
          route refuses to cross.
        </p>
      )}
    </div>
  )
}
