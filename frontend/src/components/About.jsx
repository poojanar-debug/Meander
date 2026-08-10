import { forwardRef } from 'react'
import OfflineControl from './OfflineControl.jsx'

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
          Nothing about where you go is kept unless you ask. No cookies, no analytics, no location
          history — your coordinates answer this one request and are then discarded. Three things
          are kept here: whether you chose light or dark, whether you read kilometres or miles, and
          the app itself, so it opens without a connection. That last one is the program — the same
          for everyone, and it says nothing about you.
        </p>

        {/* The control that changes this promise sits against the sentence that
            states it, rather than three screens away in a settings drawer.

            The second sentence is new, and it is here because the match stopped
            being exact. A saved set now answers a search from a spot a few
            paces off rather than only a byte-identical repeat, which is what
            makes it work at all for a starting point taken from the device —
            two fixes from the same doorstep are never identical. That is a
            thing the reader can observe, so it is stated rather than left to be
            noticed. See KEY_DP in lib/resultsStore.js. */}
        <p>
          If you turn on “keep the last routes”, one set of routes is kept too, always labelled
          with its age and deleted the moment you turn it off. It is handed back when you ask for
          the same walk from roughly the same place — within a few paces, not a street — because a
          phone’s idea of where you are shifts by a few metres each time you ask it.
        </p>

        <OfflineControl />

        {/* The address bar is the one place a coordinate becomes visible, so it
            is named here rather than left for someone to notice. A device fix
            is never written there — only a place the user searched for.

            The third sentence is the fix for BLOCKED.md §9 showing through. The
            old copy said a reload keeps your search, full stop, and that was
            false for a geolocated one in the direction that surprises someone:
            writeUrl returned without clearing, so the bar kept the *previous*
            search and a reload booted that instead. Clearing it is the honest
            behaviour, and this says what clearing means. */}
        <p>
          One exception you can see: a place you searched for is kept in the address bar, so a
          reload keeps it and the link is shareable. A place taken from your device is never written
          there. Starting from your location empties the bar instead, so a reload starts fresh
          rather than reopening the search before it. Nothing is added to the back button either
          way.
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
