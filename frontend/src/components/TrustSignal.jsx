import { confidenceSentence, coverageChipText, trustTier } from '../lib/format.js'
import { cachedNotice } from '../lib/offline.js'

/**
 * Tier 2 of the card: how much of this route was actually checked.
 *
 * **Always visible. Never behind a tap. Never the same for good data and bad.**
 *
 * The volume is what changes, not the presence:
 *
 *   quiet   a chip, one line, easy to skim past
 *   amber   a chip, coloured, harder to skim past
 *   loud    a full-width block, expanded, at full size — the "do not rely on
 *           it" wording that the README calls the most important thing on the
 *           card
 *
 * Uniformly loud honesty is honesty nobody reads, which is why the good case is
 * quiet. But the bad case is never quiet, and a route whose numbers are not
 * measurements at all is always loud regardless of what its coverage figure
 * says — 90% coverage of invented terrain is 90% of nothing.
 *
 * **"When" is part of "how much can you trust this".** A route replayed from
 * the offline cache carries its age here, above the coverage statement, because
 * the two answer the same question and a reader should not have to find them in
 * different places. It is rendered first: coverage describes how good the data
 * was, age describes whether it is still the data.
 */
export default function TrustSignal({ route, cacheAgeMs }) {
  const tier = trustTier(route)
  const confidence = confidenceSentence(
    route.confidence,
    route.scoring_method,
    route.confidence_note,
  )

  const cached = route.servedFromCache ? cachedNotice(cacheAgeMs) : null

  if (tier === 'loud') {
    return (
      <div className="trust trust--loud">
        {cached && <p className="trust__headline">{cached.headline}</p>}
        {route.synthetic_upstream && (
          <p className="trust__headline">
            Built from demonstration data, not a live routing response. Do not follow it.
          </p>
        )}
        <p className="trust__body">{confidence.text}</p>
        {cached?.detail && <p className="trust__body">{cached.detail}</p>}
        {route.status_note && <p className="trust__body">{route.status_note}</p>}
      </div>
    )
  }

  return (
    <>
      {cached && (
        <div className={`trust trust--cached trust--cached-${cached.tier}`}>
          <p className="trust__headline">{cached.headline}</p>
          {cached.detail && <p className="trust__body">{cached.detail}</p>}
        </div>
      )}
      <p className={`trust trust--chip trust--${tier}`}>
        <span className="visually-hidden">Accessibility coverage: </span>
        {coverageChipText(route)}
      </p>
      {/* preset_note arrives here as status_note. It is the app admitting a
          promise was not kept — "this is not actually greener than the fastest
          way" — so it reads like one rather than sitting in small grey type
          under the methodology. */}
      {route.status_note && <p className="trust trust--note">{route.status_note}</p>}
    </>
  )
}
