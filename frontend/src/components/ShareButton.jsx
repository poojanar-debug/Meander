import { useEffect, useState } from 'react'

import { shareUrl } from '../lib/permalink.js'

/**
 * Copy a link that reproduces this exact request.
 *
 * Uses the Web Share sheet where there is one — on a phone that is the whole
 * point, because it reaches the messaging app the user actually wants — and
 * falls back to the clipboard, and then to selecting the text of the link so
 * it can be copied by hand. Every rung of that ladder is reachable by keyboard.
 */
export default function ShareButton({ origin, dest, minutes, mode, objectives }) {
  const [status, setStatus] = useState(null) // null | 'copied' | 'failed'
  const url = shareUrl({ origin, dest, minutes, mode, objectives })

  useEffect(() => {
    if (!status) return undefined
    const timer = setTimeout(() => setStatus(null), 4000)
    return () => clearTimeout(timer)
  }, [status])

  if (!url) return null

  async function share() {
    // The native sheet first. It is cancellable, and a cancel is an
    // AbortError, which is not a failure and must not be reported as one.
    if (navigator.share) {
      try {
        await navigator.share({ title: 'Meander', text: 'A route from Meander', url })
        return
      } catch (err) {
        if (err?.name === 'AbortError') return
      }
    }
    try {
      await navigator.clipboard.writeText(url)
      setStatus('copied')
    } catch {
      setStatus('failed')
    }
  }

  return (
    <div className="share">
      <button type="button" className="button" onClick={share}>
        Share this search
      </button>
      {/* role="status" so the outcome is announced, not just shown. */}
      <p className="share__status" role="status">
        {status === 'copied' && 'Link copied. It reproduces these exact routes.'}
        {status === 'failed' && 'Could not copy automatically — the link is below.'}
      </p>
      {status === 'failed' && (
        <input className="share__url" readOnly value={url} onFocus={(e) => e.target.select()} />
      )}
    </div>
  )
}
