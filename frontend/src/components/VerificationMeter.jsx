import { fmtPct, verificationTier } from '../lib/format.js'

const SEGMENTS = [0, 1, 2, 3]

/**
 * Four segments and a word. Implements §4.7.
 *
 * **Renders only phrasing content — `<span>` and nothing else.** This component
 * is used inside `RouteRow`, which is a single `<button>`, and a `<button>`
 * containing `<p>`, `<dl>` or `<div>` is invalid HTML that screen readers
 * flatten into one unreadable label. Anything added here must stay a span.
 *
 * The meter is a summary and never a replacement: the detail panel still
 * renders the server's confidence sentence verbatim. A four-segment bar can be
 * compared across three routes in a second; a paragraph cannot. Both are needed
 * and they are not interchangeable.
 */
export default function VerificationMeter({ confidence, scoringMethod, showSentence = true }) {
  const tier = verificationTier(confidence, scoringMethod)
  const measured = scoringMethod !== 'placeholder' && typeof confidence === 'number'

  return (
    <span className={`verify verify--${tier.tone}`}>
      <span className="verify__track" aria-hidden="true">
        {SEGMENTS.map((i) => (
          <span key={i} className={i < tier.filled ? 'verify__seg is-on' : 'verify__seg'} />
        ))}
      </span>
      {showSentence && (
        <span className="verify__text">
          {/* Warning tiers carry the glyph as well as the colour and the weight. */}
          {tier.tone === 'warn' && (
            <span className="verify__glyph" aria-hidden="true">
              ⚠
            </span>
          )}
          {tier.word}
          {measured && ` · ${fmtPct(confidence)} of the route checked`}
        </span>
      )}
    </span>
  )
}
