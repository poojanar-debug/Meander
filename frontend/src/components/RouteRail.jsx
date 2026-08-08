import { waysBack } from '../lib/format.js'
import RouteRow from './RouteRow.jsx'

/** Holds the row height while a result streams in, so the layout never jumps
 *  (§5, "Slow connection"). Three skeletons, one per objective asked for. */
function Skeleton() {
  return (
    <li>
      <div className="route route--skeleton" aria-hidden="true">
        <span className="route__edge" />
        <span className="route__body">
          <span className="sk sk--title" />
          <span className="sk sk--sub" />
          <span className="sk sk--scores" />
          <span className="sk sk--verify" />
        </span>
      </div>
    </li>
  )
}

/**
 * The comparison rail. Implements §4.6.
 *
 * Ordering is the reducer's, unchanged: routes sort by the order of
 * `state.objectives`, and the initially selected route is the first with
 * `status === 'ok'`. **Blocked routes are never hidden** — someone needs to be
 * able to see *where* a route fails, not just be told it does, so a blocked
 * route stays in the list and stays selectable.
 */
export default function RouteRail({
  routes,
  selected,
  theme,
  loading,
  expected,
  units,
  cacheAgeMs,
  onSelect,
}) {
  const showSkeletons = loading && routes.length === 0

  if (routes.length === 0 && !showSkeletons) return null

  return (
    <section aria-labelledby="routes-heading">
      <div className="results-head">
        <h2 className="results-head__title" id="routes-heading">
          {showSkeletons ? 'Working out your routes' : waysBack(routes.length)}
        </h2>
      </div>

      <ul className="rail">
        {showSkeletons
          ? Array.from({ length: expected }, (_, i) => <Skeleton key={i} />)
          : routes.map((route) => (
              <RouteRow
                key={route.id}
                route={route}
                selected={route.id === selected}
                theme={theme}
                units={units}
                cacheAgeMs={cacheAgeMs}
                onSelect={onSelect}
              />
            ))}
      </ul>
    </section>
  )
}
