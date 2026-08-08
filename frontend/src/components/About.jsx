import { forwardRef } from 'react'

/**
 * The old footer, collapsed. Implements §4.9.
 *
 * Two walls of prose used to bracket the app — a header paragraph and a footer
 * paragraph — and the footer one carried the single most important sentence in
 * the product: that accessibility answers are only as good as the tagging where
 * you are. Collapsing is not deleting. **Every sentence the footer had is still
 * here**, in the handoff's order: the OSM-tagging caveat first, then the
 * nothing-is-stored statement, then cache stats and attributions.
 *
 * The caveat leads because it is the one a reader most needs and least expects.
 */
const About = forwardRef(function About({ cache }, ref) {
  return (
    <details className="about" ref={ref} id="about">
      <summary className="about__summary">
        Where these numbers come from · privacy · credits
      </summary>

      <div className="about__body">
        <p>
          Accessibility answers are only as good as OpenStreetMap tagging where you are. Every
          route says how much of it was actually verified. Where it says the data is unverified,
          it means it.
        </p>

        <p>
          Nothing is stored about where you go. No cookies, no analytics, no location history —
          your coordinates are used to answer this one request and then discarded. Two words are
          kept in this browser: whether you chose the light or the dark theme, and whether you read
          distances in kilometres or miles.
        </p>

        {/* The paragraph above has exactly one exception, so it names it rather
            than quietly acquiring one. Reporting a barrier is the only thing in
            this application that writes anywhere, and it is opt-in, one press
            at a time. */}
        <p>
          There is one exception, and only if you ask for it. If you report a barrier, that report
          is published — the point you picked and the words you wrote become a public note on the
          OpenStreetMap development server, and it stays there. The form says so above the send
          button. Nothing else you do here leaves the browser.
        </p>

        {cache && (
          <p>
            {cache.segments_scored.toLocaleString()} map segments scored,{' '}
            {Math.round((cache.hit_rate ?? 0) * 100)}% served from cache.
          </p>
        )}

        <p>
          Map data © <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>{' '}
          contributors · tiles by <a href="https://openfreemap.org/">OpenFreeMap</a> · imagery
          from <a href="https://www.mapillary.com/">Mapillary</a> (CC BY-SA) · weather and air
          quality from <a href="https://open-meteo.com/">Open-Meteo</a>.
        </p>
      </div>
    </details>
  )
})

export default About
