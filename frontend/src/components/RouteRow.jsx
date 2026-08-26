import { MODE_NOUN, fmtDist, fmtDur } from '../lib/format.js'
import { UNKNOWN } from '../lib/units.js'
import { BlockerIcon } from './Icons.jsx'

/** A score as the card meta shows it: 0.41 → "41", null → the unknown glyph.
 *  Null is "we did not measure this", and it renders as absence, never as 0. */
const score = (value) => (typeof value === 'number' ? String(Math.round(value * 100)) : UNKNOWN)

/** "steps" → "Steps", "kissing_gate" → "Kissing gate". The label is the
 *  router's own type made readable; the sentence after it is verbatim. */
const typeLabel = (type) => {
  const readable = String(type ?? '').replace(/_/g, ' ')
  return readable.charAt(0).toUpperCase() + readable.slice(1)
}

/**
 * The scores this card compares, in the order it reads them.
 *
 * The wire carries a fourth, `quiet`, and it deliberately stays in the detail
 * panel. This line already wraps at 320px with three terms on it, and a card
 * is a comparison rather than a report: a fourth number makes every card
 * taller for something the panel one tap away states as a bar, with its own
 * "not measured" wording when there is nothing to state.
 */
const CARD_SCORES = ['scenic', 'air', 'shade']

const scoreLine = (scores) => CARD_SCORES.map((key) => `${key} ${score(scores[key])}`)

const coveragePct = (confidence) =>
  typeof confidence === 'number' && Number.isFinite(confidence)
    ? Math.round(confidence * 100)
    : null

/**
 * One result card.
 *
 * Anatomy, top to bottom: accent dot + label + duration right; the mono meta
 * line; the mono scores line (folded into the meta line on the compact
 * mobile variant); one sentence — the server's own coverage sentence,
 * verbatim. Selected wears a 2px ring in the route's accent.
 *
 * A blocked route keeps its slot and its card. It trades the scores line for
 * its blocker rows — each one a button that shows that barrier on the map —
 * and the accessible card carries the status chip both ways: rose `blocked`,
 * or mint `no blockers found` with the step-free-as-far-as-the-data-goes
 * sentence. "Accessible" outright is never claimed.
 */
export default function RouteRow({
  route,
  selected,
  isLoop,
  units,
  compact = false,
  onSelect,
  onBlockerFocus,
}) {
  const blocked = route.status !== 'ok'
  const pending = Boolean(route.enrichment_pending)
  const scores = route.scores ?? {}
  const pct = coveragePct(route.confidence)

  const shape = isLoop ? 'loop' : 'one way'
  const metaParts = [fmtDist(route.distance_m, units), shape]
  // The folded scores wait for the enrichment pass: a dash there would read
  // as "unknown" while the truth is "being checked", and those are different
  // statements. The pending line below carries the honest one.
  if (compact && !blocked && !pending) {
    metaParts.push(...scoreLine(scores))
  } else {
    metaParts.push(MODE_NOUN[route.mode] ?? route.mode)
  }

  const isAccessible = route.id === 'accessible'

  return (
    <article
      className={`card${selected ? ' is-selected' : ''} card--${route.id}`}
      style={selected ? { boxShadow: `0 0 0 2px var(--route-${route.id}, var(--ink-2)), var(--shadow-selected)` } : undefined}
    >
      <button type="button" className="card__hit route" onClick={() => onSelect(route.id)}>
        <span className="card__head">
          <span className={`dot dot--${route.id}`} aria-hidden="true" />
          <span className="card__label">{route.label}</span>
          {blocked ? (
            <span className="card__chip card__chip--rose mono">blocked</span>
          ) : (
            isAccessible && (route.blockers?.length ?? 0) === 0 && !pending && (
              <span className="card__chip card__chip--mint mono">no blockers found</span>
            )
          )}
          <span className="card__duration mono">{fmtDur(route.duration_min)}</span>
        </span>

        <span className="card__meta mono route__sub">{metaParts.join(' · ')}</span>

        {!blocked && !compact && (
          pending ? (
            <span className="card__skeleton" aria-hidden="true">
              <span className="card__skeleton-bar" style={{ width: '72%' }} />
              <span className="card__skeleton-bar" style={{ width: '46%' }} />
            </span>
          ) : (
            <span className="card__scores mono">{scoreLine(scores).join(' · ')}</span>
          )
        )}

        {pending ? (
          <span className="card__pending mono">
            <span className="card__pulse" aria-hidden="true" />
            Checking surfaces, air and rest stops
          </span>
        ) : blocked ? null : isAccessible && (route.blockers?.length ?? 0) === 0 && pct != null ? (
          <span className="card__sentence">
            Step-free as far as the data goes — it covers {pct}% of this route.
          </span>
        ) : (
          route.confidence_note && <span className="card__sentence">{route.confidence_note}</span>
        )}
      </button>

      {blocked && (
        <div className="card__blockers">
          {(route.blockers ?? []).map((blocker, i) => (
            <button
              key={`${blocker.type}-${i}`}
              type="button"
              className="card__blocker"
              onClick={() => onBlockerFocus?.(blocker)}
            >
              <span
                className={`card__blocker-circle${blocker.type === 'steps' ? ' card__blocker-circle--rose' : ''}`}
                aria-hidden="true"
              >
                <BlockerIcon type={blocker.type} size={12} />
              </span>
              <span className="card__blocker-text">
                {typeLabel(blocker.type)} — {blocker.description}
              </span>
            </button>
          ))}
          <p className="card__blocker-foot mono">
            kept in its slot — tap a blocker to see it on the map
          </p>
        </div>
      )}
    </article>
  )
}

/** The pending placeholder for an objective whose route has not arrived yet:
 *  pulsing dot, two skeleton bars, and the one honest sentence. */
export function RouteRowSkeleton({ label, id }) {
  return (
    <article className={`card card--skeleton card--${id}`} aria-label={`${label}: still checking`}>
      <span className="card__head">
        <span className={`dot dot--${id} card__pulse-dot`} aria-hidden="true" />
        <span className="card__label">{label}</span>
      </span>
      <span className="card__skeleton" aria-hidden="true">
        <span className="card__skeleton-bar" style={{ width: '72%' }} />
        <span className="card__skeleton-bar" style={{ width: '46%' }} />
      </span>
      <span className="card__pending mono">Checking surfaces, air and rest stops</span>
    </article>
  )
}
