/**
 * The banner is the only thing that changes during a refetch. Routes and the
 * map stay rendered and interactive with the previous result until the new one
 * lands — replacing a good answer with a spinner is a worse experience than
 * showing a slightly stale one.
 */
export default function StatusBanner({ phase, progress, error, routes, onRetry, onMoreTime }) {
  if (phase === 'error') {
    return (
      <div className="banner banner--warn" role="alert">
        <p className="banner__text">{error?.message ?? 'Something went wrong.'}</p>
        <button type="button" className="button" onClick={onRetry}>
          Try again
        </button>
      </div>
    )
  }

  if (phase === 'idle') {
    return (
      <div className="banner">
        <p className="banner__text">
          Set a starting point to begin. Leave the destination empty and you will get a loop that
          brings you back.
        </p>
      </div>
    )
  }

  if (phase === 'locating') {
    return (
      <div className="banner">
        <p className="banner__text">Asking your browser where you are…</p>
      </div>
    )
  }

  if (phase === 'loading') {
    const pct = progress?.pct ?? 5
    return (
      <div className="banner">
        <p className="banner__text">
          {progress?.text ?? 'Working out your routes'}
          {routes.length > 0 && `, ${routes.length} ready so far`}
        </p>
        <div
          className="banner__progress"
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={pct}
          aria-label="Route search progress"
        >
          <div className="banner__bar" style={{ width: `${pct}%` }} />
        </div>
      </div>
    )
  }

  const routable = routes.filter((r) => r.status === 'ok')
  if (routes.length > 0 && routable.length === 0) {
    return (
      <div className="banner banner--warn" role="alert">
        <p className="banner__text">
          None of these routes can be completed. Every option runs into a barrier or has no
          connected path. More time, or a different way of travelling, usually opens one up.
        </p>
        <button type="button" className="button" onClick={onMoreTime}>
          Add 30 minutes
        </button>
      </div>
    )
  }

  return null
}
