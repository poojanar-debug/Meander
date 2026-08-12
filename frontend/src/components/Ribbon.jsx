import { usingMockApi } from '../api/client.js'

/**
 * Demonstration-data warning. Implements §4.2.
 *
 * Renders when the app is running on the mock API, or when *any* route in the
 * current result came from a hand-made fixture. Not dismissible: a route built
 * from invented geometry must never stop announcing itself, and someone who
 * dismissed this once would carry that dismissal into a session where it
 * mattered.
 *
 * This is a summary and not a replacement. The per-route line stays on the
 * routes that are actually synthetic, because a result can be mixed — one live
 * route and two fixtures is not "everything here is a demo", and collapsing
 * them into a single banner would lose which is which.
 */
export default function Ribbon({ routes }) {
  const anySynthetic = routes.some((route) => route.synthetic_upstream === true)
  if (!anySynthetic && !usingMockApi()) return null

  return (
    // A <section> with a name is a region landmark, so the warning is reachable
    // by landmark navigation instead of being loose content between the topbar
    // and the main element. role="note" is not a landmark and did not do this.
    <section className="ribbon" aria-label="Data source">
      <span className="ribbon__icon" aria-hidden="true">
        ⚠
      </span>
      <span>
        Demonstration data: routes come from fixtures, not live routing. Do not follow them.
      </span>
    </section>
  )
}
