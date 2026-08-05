import { confidenceSentence, coverageChipText, trustTier } from '../lib/format.js'

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
 */
export default function TrustSignal({ route }) {
  const tier = trustTier(route)
  const confidence = confidenceSentence(
    route.confidence,
    route.scoring_method,
    route.confidence_note,
  )

  if (tier === 'loud') {
    return (
      <div className="trust trust--loud">
        {route.synthetic_upstream && (
          <p className="trust__headline">
            Built from demonstration data, not a live routing response. Do not follow it.
          </p>
        )}
        <p className="trust__body">{confidence.text}</p>
        {route.status_note && <p className="trust__body">{route.status_note}</p>}
      </div>
    )
  }

  return (
    <>
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
