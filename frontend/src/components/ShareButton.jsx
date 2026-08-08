import { useEffect, useRef, useState } from 'react'

import { GEOLOCATED, shareUrl } from '../lib/permalink.js'

/**
 * Share the search, not the selected route.
 *
 * A three-rung ladder, because the two good APIs are both conditional: the
 * share sheet exists on phones, the clipboard needs a secure context and a
 * permission, and neither is guaranteed. The last rung is a visible read-only
 * field, which always works.
 *
 * Cancelling the share sheet throws AbortError. That is a user changing their
 * mind, not a failure, and reporting it as one would be a small lie told at the
 * moment the user is paying most attention.
 *
 * Announcements go through the app's one live region via onAnnounce. The
 * component this was ported from opened its own role="status"; two polite
 * regions race, and the outcome sentence is rendered visibly here anyway, so
 * carrying a role would announce it twice.
 */
export default function ShareButton({ origin, dest, minutes, mode, objectives, departAt, onAnnounce }) {
  const [status, setStatus] = useState('')
  const [fallbackUrl, setFallbackUrl] = useState('')
  const timer = useRef(null)

  useEffect(() => () => clearTimeout(timer.current), [])

  const url = shareUrl({ origin, dest, minutes, mode, objectives, departAt })
  if (!url) return null

  const report = (sentence) => {
    setStatus(sentence)
    onAnnounce?.(sentence)
    clearTimeout(timer.current)
    timer.current = setTimeout(() => setStatus(''), 4000)
  }

  const onShare = async () => {
    setFallbackUrl('')
    if (navigator.share) {
      try {
        await navigator.share({ title: 'Meander', text: 'A walk I found', url })
        return
      } catch (err) {
        // Changing your mind is not an error.
        if (err?.name === 'AbortError') return
      }
    }
    try {
      await navigator.clipboard.writeText(url)
      report('Link copied. It reproduces these exact routes.')
    } catch {
      setFallbackUrl(url)
      report('Could not copy automatically — the link is below.')
    }
  }

  return (
    <div className="share">
      <button type="button" className="button" onClick={onShare}>
        Share these routes
      </button>

      {origin?.name === GEOLOCATED && (
        <p className="field__hint">This link contains your current coordinates.</p>
      )}

      {/* Visible, but not a live region — onAnnounce already spoke it. */}
      <p className="share__status">{status}</p>

      {fallbackUrl && (
        <input
          className="share__url"
          type="text"
          readOnly
          value={fallbackUrl}
          aria-label="Link to these routes"
          onFocus={(e) => e.target.select()}
        />
      )}
    </div>
  )
}
