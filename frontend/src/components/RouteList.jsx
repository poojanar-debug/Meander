import BlockedRouteCard from './BlockedRouteCard.jsx'
import RouteCard from './RouteCard.jsx'
import RouteRow from './RouteRow.jsx'

/**
 * The routes, at whichever level of detail the sheet is showing.
 *
 *   peek   one compact row each — three routes, no scrolling
 *   half   the selected route in full, the rest as rows
 *   full   every route in full
 *
 * One component tree for both breakpoints. Above 900 px the sheet is a fixed
 * left panel and the composer forces `snap` to 'full', so this renders every
 * card without needing a desktop-specific branch.
 */
export default function RouteList({ routes, selected, snap = 'full', onSelect, skeletonCount = 0 }) {
  if (routes.length === 0 && skeletonCount > 0) {
    return (
      <ul className="route-list" aria-busy="true">
        {Array.from({ length: skeletonCount }, (_, i) => (
          <li className="row row--skeleton" key={i}>
            <span className="skeleton skeleton--swatch" aria-hidden="true" />
            <span className="skeleton skeleton--label" aria-hidden="true" />
            <span className="skeleton skeleton--figure" aria-hidden="true" />
          </li>
        ))}
        <li className="visually-hidden">Working out your routes…</li>
      </ul>
    )
  }

  if (routes.length === 0) return null

  const wantsDetail = (route) => {
    if (snap === 'full') return true
    if (snap === 'half') return route.id === selected
    return false
  }

  return (
    <ul className="route-list">
      {routes.map((route) => {
        if (!wantsDetail(route)) {
          return (
            <RouteRow
              key={route.id}
              route={route}
              selected={route.id === selected}
              onSelect={onSelect}
            />
          )
        }
        // A blocked route is a different component, not a variant — see
        // BlockedRouteCard for why that matters more than it looks.
        const Card = route.status === 'ok' ? RouteCard : BlockedRouteCard
        return (
          <Card
            key={route.id}
            route={route}
            selected={route.id === selected}
            onSelect={onSelect}
          />
        )
      })}
    </ul>
  )
}
