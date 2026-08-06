import { fmtDur } from '../lib/format.js'
import { cacheChipText, cacheTier, formatCacheAge } from '../lib/offline.js'

/**
 * The compact bar that overlays the map.
 *
 * Three things only: where you are starting, how long you have, and a way into
 * everything else. Everything that used to live in an 782 px permanent stack is
 * now behind one of these two buttons.
 *
 * On desktop the CSS moves this to the top of the left panel rather than
 * overlaying the map — same markup, different composition.
 */
export default function TopBar({
  origin,
  minutes,
  mode,
  stale,
  cached,
  cacheAgeMs,
  onOpenSearch,
  onOpenSettings,
}) {
  return (
    <div className="topbar">
      <button type="button" className="topbar__origin" onClick={onOpenSearch}>
        <span className="topbar__origin-label">From</span>
        <span className="topbar__origin-name">{origin?.name ?? 'Choose a starting point'}</span>
      </button>

      <button type="button" className="topbar__time" onClick={onOpenSettings}>
        <span className="visually-hidden">Time budget and travel options: </span>
        <span aria-hidden="true" className="topbar__time-value">
          {fmtDur(minutes)}
        </span>
        <span className="visually-hidden">
          {minutes} minutes, {mode}
        </span>
      </button>

      {/* In-place freshness signals, stacked under the bar. Refetching
          deliberately keeps the previous routes on screen and interactive,
          which is right — but the only sign of it used to be a banner far
          above the fold, so a stale answer and a fresh one looked identical.

          The cached pill is the one surface the sheet cannot hide. Peek shows
          three route rows and nothing else, so at that snap this is where the
          age lives — and a saved copy must be labelled at every snap, not only
          the ones with room for a paragraph. */}
      <div className="topbar__flags">
        {cached && (
          <span className={`topbar__cached topbar__cached--${cacheTier(cacheAgeMs)}`}>
            <span className="visually-hidden">
              These routes are a saved copy from {formatCacheAge(cacheAgeMs)}.{' '}
            </span>
            <span aria-hidden="true">{cacheChipText(cacheAgeMs)}</span>
          </span>
        )}
        {stale && (
          <span className="topbar__stale" role="status">
            <span className="topbar__stale-dot" aria-hidden="true" />
            Updating…
          </span>
        )}
      </div>
    </div>
  )
}
