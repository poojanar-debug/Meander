import { usingMockApi } from '../api/client.js'
import ThemeToggle from './ThemeToggle.jsx'

export default function Header({ theme, onTheme }) {
  return (
    <header className="topbar">
      <div>
        <h1 className="topbar__wordmark">Meander</h1>
        <p className="topbar__tagline">
          Tell it where you are and how long you have. It gives you the fastest way, the
          greenest way, and one that holds to real accessibility constraints.
        </p>
        {usingMockApi() && (
          <p className="topbar__mock">
            Demo data — this build is running on fixtures, not live routing.
          </p>
        )}
      </div>
      <div className="topbar__actions">
        <p className="topbar__privacy">
          Nothing is stored. No cookies, no analytics, no location history — your coordinates are
          used to answer this one request and then discarded.
        </p>
        <ThemeToggle theme={theme} onToggle={onTheme} />
      </div>
    </header>
  )
}
