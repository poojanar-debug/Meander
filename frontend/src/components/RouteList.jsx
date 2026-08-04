import RouteCard from './RouteCard.jsx'

export default function RouteList({ routes, selected, onSelect }) {
  if (routes.length === 0) return null

  return (
    <section aria-labelledby="routes-heading">
      <h2 id="routes-heading" className="visually-hidden">
        Routes
      </h2>
      <ul className="route-list">
        {routes.map((route) => (
          <RouteCard
            key={route.id}
            route={route}
            selected={route.id === selected}
            onSelect={onSelect}
          />
        ))}
      </ul>
    </section>
  )
}
