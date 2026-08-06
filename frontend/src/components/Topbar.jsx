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
export default function Topbar({ theme, onTheme, onAbout }) {
  return (
    <header className="topbar">
      <div className="topbar__brand">
        <span className="topbar__wordmark">Meander</span>
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
