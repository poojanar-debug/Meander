import { DASH } from '../lib/dash.js'
import RouteRow, { RouteRowSkeleton } from './RouteRow.jsx'

/**
 * The streaming results: a progress strip while the server is thinking, then
 * one card per requested objective — real ones as they land, skeletons for
 * the slots still coming. Route order is the objective order; a blocked route
 * keeps its slot rather than sinking.
 *
 * `progress` is null on a cache hit, and then no strip renders at all: an
 * instant answer needs no narration of the work it did not do.
 *
 * When every arrived route is blocked, the payload's top-level `reason`
 * renders above the cards, verbatim — the server's sentence, not ours.
 */
export default function RouteRail({
  routes,
  objectives,
  selected,
  loading,
  progress,
  reason,
  isLoop,
  units,
  compact = false,
  onSelect,
  onBlockerFocus,
}) {
  const byId = new Map(routes.map((route) => [route.id, route]))
  const slots = objectives.map((id) => ({ id, route: byId.get(id) ?? null }))
  const arrived = routes.length > 0
  const allBlocked = arrived && !loading && routes.every((route) => route.status !== 'ok')

  return (
    <div className={compact ? 'rail rail--sheet' : 'rail rail--row'} id="results">
      {loading && progress && (
        <p className="rail__progress">
          <span className="rail__pulse" aria-hidden="true" />
          <span className="rail__phase mono">{progress.text}</span>
          <span className="rail__bar" aria-hidden="true">
            <span
              className="rail__bar-fill"
              style={{ width: `${Math.max(0, Math.min(100, progress.pct ?? 0))}%` }}
            />
          </span>
        </p>
      )}

      {allBlocked && reason && <p className="rail__reason">{reason}</p>}

      <div className="rail__cards">
        {slots.map(({ id, route }) =>
          route ? (
            <RouteRow
              key={id}
              route={route}
              selected={id === selected}
              isLoop={isLoop}
              units={units}
              compact={compact}
              onSelect={onSelect}
              onBlockerFocus={onBlockerFocus}
            />
          ) : loading ? (
            <RouteRowSkeleton key={id} id={id} label={DASH[id]?.label ?? id} />
          ) : null,
        )}
      </div>
    </div>
  )
}
