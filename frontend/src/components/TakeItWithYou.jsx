import { useEffect, useState } from 'react'

import {
  appleMapsUrl,
  downloadGeoJson,
  downloadGpx,
  exportStamp,
  googleMapsUrl,
  provenanceNote,
} from '../lib/export.js'

/**
 * Four ways to leave with the route, and the same caveat written into all of
 * them.
 *
 * The maps handoff is the one that needs a warning rather than a label: those
 * apps re-route from the endpoints, so what opens is emphatically not the route
 * on screen — not the surface checks, not the barriers, not the gradient limit.
 * The disclosure states that before the links exist in the DOM, and both links
 * are described by it.
 */
export default function TakeItWithYou({ route, origin, dest, onAnnounce }) {
  const [showHandoff, setShowHandoff] = useState(false)

  // A printed sheet with the directions collapsed is a printed sheet without
  // directions. The trick the source used — forcing [hidden] open from CSS —
  // does not port, because the collapsed content here is <details>, which CSS
  // cannot open. This fires for Cmd-P as well as for the button.
  useEffect(() => {
    let opened = []
    const before = () => {
      opened = [...document.querySelectorAll('details:not([open])')]
      opened.forEach((d) => {
        d.open = true
      })
    }
    const after = () => {
      opened.forEach((d) => {
        d.open = false
      })
      opened = []
    }
    window.addEventListener('beforeprint', before)
    window.addEventListener('afterprint', after)
    return () => {
      window.removeEventListener('beforeprint', before)
      window.removeEventListener('afterprint', after)
    }
  }, [])

  if (!route) return null

  const note = provenanceNote(route)
  const stamp = exportStamp(route)
  const exportable = (route.geometry?.length ?? 0) >= 2
  const google = exportable ? googleMapsUrl(route) : null
  const apple = exportable ? appleMapsUrl(route) : null

  const onGpx = () => {
    downloadGpx(route, { origin, dest })
    onAnnounce?.('GPX file saved.')
  }
  const onGeoJson = () => {
    downloadGeoJson(route)
    onAnnounce?.('GeoJSON file saved.')
  }

  return (
    <>
      <section className="takeaway" aria-labelledby="takeaway-h">
        <h4 className="detail__h" id="takeaway-h">
          Take it with you
        </h4>

        <div className="takeaway__row">
          <button type="button" className="button" onClick={onGpx} disabled={!exportable}>
            Download GPX
          </button>
          <button type="button" className="button" onClick={onGeoJson} disabled={!exportable}>
            Download GeoJSON
          </button>
          <button type="button" className="button" onClick={() => window.print()}>
            Print
          </button>
        </div>

        <p className="takeaway__note">
          The file carries the coverage figure, how it was measured, and any recorded barriers — so
          it still says what it does and does not know once it has left this page.
        </p>

        {(google || apple) && (
          <>
            <button
              type="button"
              className="link-button"
              aria-expanded={showHandoff}
              aria-controls="takeaway-handoff"
              onClick={() => setShowHandoff((open) => !open)}
            >
              Open in a maps app for turn-by-turn
            </button>

            <div className="takeaway__warn" id="takeaway-handoff" hidden={!showHandoff}>
              <p className="takeaway__warn-title" id="takeaway-warn-title">
                <span aria-hidden="true">⚠ </span>
                <strong>This will not be the same route.</strong> Those apps route again from the
                start and end points. None of the surface, kerb or gradient checks below apply to
                what they give you.
              </p>
              <p id="takeaway-provenance">{note}</p>
              <div className="takeaway__row">
                {google && (
                  <a
                    className="button"
                    href={google}
                    target="_blank"
                    rel="noreferrer noopener"
                    aria-describedby="takeaway-warn-title takeaway-provenance"
                  >
                    Google Maps
                  </a>
                )}
                {apple && (
                  <a
                    className="button"
                    href={apple}
                    target="_blank"
                    rel="noreferrer noopener"
                    aria-describedby="takeaway-warn-title takeaway-provenance"
                  >
                    Apple Maps
                  </a>
                )}
              </div>
            </div>
          </>
        )}
      </section>

      {/* Screen-hidden, print-only. The caveat has to be on the paper too. */}
      <section className="printsheet" aria-hidden="true">
        <h4 className="printsheet__h">Where this came from</h4>
        <p className="printsheet__note">{note}</p>
        <p className="printsheet__stamp">Printed from Meander, {stamp.isoTime}.</p>
      </section>
    </>
  )
}
