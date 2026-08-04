import { usingMockApi } from '../api/client.js'

export default function Header() {
  return (
    <header className="header">
      <div>
        <h1 className="header__wordmark">Meander</h1>
        <p className="header__tagline">
          Tell it where you are and how long you have. It gives you the fastest way, the
          greenest way, and one that holds to real accessibility constraints.
        </p>
        {usingMockApi() && (
          <p className="header__mock">
            Demo data — this build is running on fixtures, not live routing.
          </p>
        )}
      </div>
      <p className="header__privacy">
        Nothing is stored. No cookies, no analytics, no location history — your coordinates are
        used to answer this one request and then discarded.
      </p>
    </header>
  )
}
