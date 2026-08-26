import { MARK_BOX, MARK_PATH_D, markStroke } from '../lib/mark.js'

/**
 * The Meander mark, and the wordmark lockup it sits in.
 *
 * The geometry comes from lib/mark.js, which is the one place the curve is
 * stated — the same module scripts/make-icons.mjs walks to draw the launcher
 * icons and to write public/favicon.svg. Nothing here restates a coordinate,
 * and mark.test.js holds that true: it refuses a `d` attribute written into
 * this file.
 *
 * Colour follows the vocabulary the rest of the icons already use. The SVG
 * strokes `currentColor` and the stylesheet sets `color` on it from
 * `--sky-deep`. That is not a stylistic preference: scripts/check_palette.sh
 * reads styles.css and nothing else, so a `stroke="#4e7fbe"` written here
 * would be a hard-coded colour the gate cannot see.
 *
 * Nothing here animates, and it needs no exemption to honour
 * prefers-reduced-motion: styles.css ends with a blanket reduce block that
 * kills every animation and transition in the document, so anything added to
 * the mark later is covered by that rule from the moment it exists.
 */

/**
 * The mark alone, `size` CSS pixels square.
 *
 * Decorative, like every other inline SVG in this app — the word beside it is
 * real text and carries the name, so a `role="img"` here would be a second
 * announcement of something already said. It would also be a gate failure:
 * axe's `svg-img-alt` is tagged wcag2a, and scripts/gate.mjs runs wcag2a and
 * wcag2aa on four screens in both themes. `focusable="false"` is load-bearing
 * for the same reason — legacy SVG focusability is what `aria-hidden-focus`
 * fires on.
 */
export function MeanderMark({ size = 26 }) {
  return (
    <svg
      className="wordmark__mark"
      viewBox={`0 0 ${MARK_BOX} ${MARK_BOX}`}
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      // Heavier below a 24px box, where 5.5 units land on under three device
      // pixels and the curve reads as a grey smudge rather than a line.
      strokeWidth={markStroke(size)}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d={MARK_PATH_D} />
    </svg>
  )
}

/**
 * The lockup: a 26px mark, a 12px gap, and the name.
 *
 * Not a heading. It names the application rather than opening a section, and
 * the two headings this app has — the route detail's title and follow mode's
 * arrival — are both h2 inside their own surface. An h1 around a wordmark
 * would put the app's name into the outline above them while describing
 * nothing a reader can navigate to, and it would appear on the plan surface
 * and vanish on the results one.
 *
 * Not a button either. It was one before the 2026 redesign, and bringing that
 * back would put a 26px control in front of the gate's 44x44 sweep on four
 * screens in two themes. Adding the logo is the whole scope here.
 */
export default function Wordmark({ className }) {
  return (
    <p className={className ? `wordmark ${className}` : 'wordmark'}>
      <MeanderMark size={26} />
      <span className="wordmark__name">Meander</span>
    </p>
  )
}
