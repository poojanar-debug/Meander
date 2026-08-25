/**
 * The failure surface. A stream that closed without `done` is a failure, not
 * an empty result — client.js turns it into an ApiError with written copy —
 * and this is where that copy lands, with the one action that can help.
 *
 * Renders nothing in every healthy state: the cards are their own status.
 */
export default function StatusBanner({ error, onRetry }) {
  if (!error) return null
  return (
    <div className="status" role="alert">
      <p className="status__text">{error.message}</p>
      <button type="button" className="pill status__retry" onClick={onRetry}>
        Try again
      </button>
    </div>
  )
}
