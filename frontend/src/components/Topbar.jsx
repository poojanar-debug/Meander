import { markPathD } from '../lib/mark.js'
import ThemeToggle from './ThemeToggle.jsx'

/**
 * The mark, beside the wordmark.
 *
 * **`currentColor`, never a hex.** `.topbar__wordmark` already sets
 * `color: var(--brand)`, so the mark is `#1c4633` in light and `#7fc79b` in
 * dark for free, and there is no colour in this file for `check_palette.sh` to
 * miss — that gate only scans stylesheets, so a hard-coded hex in JSX would
 * sail past it and break dark mode in exactly one theme.
 *
 * Contrast, measured against `--raised`: **10.55:1 in light, 8.45:1 in dark**,
 * against a 3:1 threshold for a graphical object. The five generated PNGs
 * cannot be reused here for precisely this reason — their ground is `--brand`,
 * which against the dark topbar is **1.58:1**. Two artefacts, one shape: the
 * geometry is shared through `lib/mark.js` and each renderer applies its own
 * colour.
 *
 * `aria-hidden` with the accessible name on the button, or axe's `button-name`
 * (WCAG 4.1.2, in the gate's rule set) fails. Sized in `em` so it tracks the
 * wordmark under Dynamic Type rather than staying at whatever px it was born.
 */
function Mark() {
  return (
    <svg
      className="topbar__logo"
      viewBox="0 0 24 24"
      width="1.1em"
      height="1.1em"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d={markPathD(24)} />
    </svg>
  )
}

/**
 * 56px sticky bar. Implements §4.1.
 *
 * The tagline that used to be a paragraph of header prose lives here now, cut
 * to one line. The rest of that prose — the privacy statement in particular —
 * moved into the About disclosure at the foot of the panel rather than being
 * deleted; §4.9 keeps every sentence the old footer had.
 *
 * There is no profile button. §4.1 specifies one, but the sheet it opens is
 * §6.5, which is deferred — and a control that opens nothing is worse than an
 * absent one, because it reads as broken rather than as unbuilt. When §6.5 is
 * promoted, the button belongs between the theme toggle and About.
 */
// `ref` is taken as an ordinary prop, which React 19 allows for a function
// component without forwardRef. App needs the element itself so it can mark the
// bar `inert` while full-screen follow mode is open: the bar is behind that
// layer, and a focusable control underneath a modal layer is reachable by Tab
// while being invisible, which is the failure `aria-hidden-focus` describes
// from the other direction.
export default function Topbar({ theme, onTheme, onAbout, onReset, ref }) {
  return (
    <header className="topbar" ref={ref}>
      <div className="topbar__brand">
        {/* A button, not a link, and not for tidiness. The action is "clear this
            app's state", not "navigate to a document", and `role="button"` is
            what a screen-reader user needs to hear before they press it.
            There is also a concrete trap: `gate.mjs`'s 44x44 sweep exempts an
            `<a>` that sits beside sibling text, under the WCAG 2.5.8
            in-a-sentence rule — which is exactly the shape a logo link in
            `.topbar__brand` would take, so a link here would go unmeasured.
            It carries no `aria-expanded`: the gate clicks every element with
            one, once per sweep pass, and a logo carrying it would reset the app
            mid-sweep and fail several later checks with a baffling message. */}
        <h1 className="topbar__wordmark">
          <button type="button" className="topbar__home" onClick={onReset}>
            <Mark />
            Meander
            <span className="visually-hidden">, start a new walk</span>
          </button>
        </h1>
        <span className="topbar__tagline">routes that are worth the walk</span>
      </div>

      <div className="topbar__actions">
        <ThemeToggle theme={theme} onToggle={onTheme} />
        <button type="button" className="icon-button" onClick={onAbout}>
          <span aria-hidden="true">?</span>
          <span className="visually-hidden">
            Where these numbers come from, privacy and credits
          </span>
        </button>
      </div>
    </header>
  )
}
