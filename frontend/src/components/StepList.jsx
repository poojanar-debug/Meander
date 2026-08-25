import { useState } from 'react'

import { fmtDist } from '../lib/format.js'
import { BlockerIcon } from './Icons.jsx'

/**
 * Below this, a distance is not worth saying and cannot be said honestly.
 *
 * `formatDistance` rounds to the nearest 10 m below 1 km, so anything under
 * 5 m renders as **"0 m"** — and under 1.524 m as "0 ft" — which tells someone
 * to travel no distance at all. Fixed at the call site rather than in
 * `formatDistance`, which `units.test.js` pins byte-for-byte over every
 * integer metre from 0 to 200,000 and which is right to keep saying 0 for a
 * number that rounds to 0. What is wrong is asking it about a distance nobody
 * needs to be told: under this floor the row simply carries no distance.
 */
const WORTH_SAYING_M = 5

/** How many rows show before the footer link unfolds the rest. */
const FOLDED_COUNT = 5

/**
 * Which barriers fall on which step.
 *
 * A barrier carries coordinates, and a step carries the span of point indices
 * it covers, so the two are matched by finding the nearest point on the route
 * to the barrier and asking which step's interval contains it.
 *
 * **Putting the barrier inside the step is the whole point of this feature.**
 * A barrier listed separately is something you read about; a barrier inside
 * step seven is something you meet. That is the difference between the app
 * warning you and the app filing a report.
 */
function barriersByStep(steps, blockers, geometry) {
  const map = new Map()
  if (!blockers?.length || !geometry?.length) return map

  for (const blocker of blockers) {
    let nearest = 0
    let best = Infinity
    for (let i = 0; i < geometry.length; i += 1) {
      const dx = geometry[i][0] - blocker.lon
      const dy = geometry[i][1] - blocker.lat
      const d = dx * dx + dy * dy
      if (d < best) {
        best = d
        nearest = i
      }
    }
    const index = steps.findIndex(
      (s) => s.interval?.length === 2 && nearest >= s.interval[0] && nearest <= s.interval[1],
    )
    const key = index === -1 ? steps.length - 1 : index
    if (!map.has(key)) map.set(key, [])
    map.get(key).push(blocker)
  }
  return map
}

/**
 * Turn-by-turn: numbered rows — a sky-wash index circle, the router's
 * instruction, the distance on the right — with a barrier chip indented under
 * any step that carries one. The list folds after five rows; the footer link
 * names how many more there are.
 *
 * Hover and focus highlight the matching stretch on the map. That is a state
 * change rather than motion, so prefers-reduced-motion does not suppress it.
 */
export default function StepList({ route, units, onHighlight }) {
  const [unfolded, setUnfolded] = useState(false)
  const steps = route?.steps ?? []

  if (steps.length === 0) {
    return (
      <p className="steps__absent">Step-by-step directions are not available for this route.</p>
    )
  }

  const barriers = barriersByStep(steps, route.blockers, route.geometry)
  const shown = unfolded ? steps : steps.slice(0, FOLDED_COUNT)
  const hidden = steps.length - shown.length

  return (
    <div className="steps">
      <ol className="steps__list">
        {shown.map((step, i) => (
          <li
            key={`${i}-${step.text}`}
            className="step"
            onMouseEnter={() => onHighlight?.(step.interval)}
            onMouseLeave={() => onHighlight?.(null)}
            onFocus={() => onHighlight?.(step.interval)}
            onBlur={() => onHighlight?.(null)}
            tabIndex={0}
          >
            <span className="step__row">
              <span className="step__index mono" aria-hidden="true">
                {i + 1}
              </span>
              <span className="step__text">{step.text}</span>
              {step.distance_m >= WORTH_SAYING_M && (
                <span className="step__dist mono">{fmtDist(step.distance_m, units)}</span>
              )}
            </span>
            {barriers.get(i)?.map((b, j) => (
              <span className="step__barrier" key={`${b.type}-${j}`}>
                <BlockerIcon type={b.type} size={14} />
                <span>{b.description}</span>
              </span>
            ))}
          </li>
        ))}
      </ol>
      {hidden > 0 && (
        <button type="button" className="steps__more" onClick={() => setUnfolded(true)}>
          {hidden} more step{hidden === 1 ? '' : 's'}
        </button>
      )}
    </div>
  )
}
