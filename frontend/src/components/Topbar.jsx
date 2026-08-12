import ThemeToggle from './ThemeToggle.jsx'

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
export default function Topbar({ theme, onTheme, onAbout, ref }) {
  return (
    <header className="topbar" ref={ref}>
      <div className="topbar__brand">
        <h1 className="topbar__wordmark">Meander</h1>
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
