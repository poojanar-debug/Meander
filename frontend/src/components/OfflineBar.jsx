import { offlineBarText } from '../lib/offline.js'

/**
 * The banner above the whole list when what is on screen is a saved copy.
 *
 * Mounted as a sibling of Ribbon, inside .app — a 100dvh flex column — and
 * above .layout. The panel is the only thing that scrolls, so no scroll
 * position can hide this. That is the whole reason it lives there rather than
 * inside the panel.
 *
 * `role="status"` makes it an inert landmark, not a second live region: the
 * announcement still goes through the app's single polite region, with the
 * caveat spoken *before* the route durations.
 *
 * The ⚠ appears at amber and loud. Volume must not be carried by colour alone.
 */
export default function OfflineBar({ ageMs, online }) {
  const { tier, headline, detail, mapDetail } = offlineBarText(ageMs, online)

  return (
    <div className={`offline offline--${tier}`} role="status">
      <p className="offline__headline">
        {tier !== 'quiet' && (
          <span className="offline__icon" aria-hidden="true">
            ⚠{' '}
          </span>
        )}
        {headline}
      </p>
      <p className="offline__detail">{detail}</p>
      {!online && <p className="offline__detail">{mapDetail}</p>}
    </div>
  )
}
