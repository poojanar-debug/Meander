import { fmtDist } from '../lib/format.js'

/**
 * GraphHopper's terse instruction, rewritten as a sentence.
 *
 * The router says "Turn left onto Green Path". The narration elsewhere in this
 * app is written for a human by a human, and a step list that reads
 * `TURN_LEFT · 400m` next to it looks like a different product. So the distance
 * is folded into the sentence — "Turn left onto Green Path and follow it for
 * 400 m" — rather than being stacked beside it as a datum.
 *
 * Nothing is invented. Every word except the connective comes from the router;
 * where it gives no street name, the sentence simply does not name one.
 */
function sentence(step) {
  const text = step.text.trim().replace(/\.$/, '')
  const far = step.distance_m >= 1

  // An arrival instruction has no distance and needs no "and follow it for".
  if (!far) return `${text}.`
  const followable = /\bonto\b|\balong\b|\bon\b/i.test(text)
  return followable
    ? `${text} and follow it for ${fmtDist(step.distance_m)}.`
    : `${text}, then continue for ${fmtDist(step.distance_m)}.`
}

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
 * Turn-by-turn directions. Implements §6.4.
 *
 * Collapsed by default: the rail and the detail panel answer "which route", and
 * this answers "how do I walk it", which is a question you only ask once you
 * have chosen.
 */
export default function StepList({ route, onHighlight }) {
  const steps = route?.steps ?? []

  if (steps.length === 0) {
    return (
      <p className="field__hint">
        Step-by-step directions are not available for this route.
      </p>
    )
  }

  const barriers = barriersByStep(steps, route.blockers, route.geometry)

  return (
    <details className="steps">
      <summary className="steps__summary">
        Directions · {steps.length} step{steps.length === 1 ? '' : 's'}
      </summary>
      <ol className="steps__list">
        {steps.map((step, i) => (
          <li
            key={`${i}-${step.text}`}
            className="step"
            // Hover and focus highlight the matching stretch on the map. This is
            // a state change rather than motion, so prefers-reduced-motion does
            // not suppress it.
            onMouseEnter={() => onHighlight?.(step.interval)}
            onMouseLeave={() => onHighlight?.(null)}
            onFocus={() => onHighlight?.(step.interval)}
            onBlur={() => onHighlight?.(null)}
            tabIndex={0}
          >
            <p className="step__text">{sentence(step)}</p>
            {step.street_name && (
              <p className="step__meta">
                {step.street_name}
                {step.distance_m >= 1 && ` · ${fmtDist(step.distance_m)}`}
              </p>
            )}
            {barriers.get(i)?.map((b, j) => (
              <p className="note note--warn step__barrier" key={`${b.type}-${j}`}>
                <strong>{b.type}:</strong> {b.description}
              </p>
            ))}
          </li>
        ))}
      </ol>
    </details>
  )
}
