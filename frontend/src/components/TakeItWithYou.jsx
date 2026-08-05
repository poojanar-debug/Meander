import { useState } from 'react'

import { appleMapsUrl, downloadGeoJson, downloadGpx, googleMapsUrl } from '../lib/export.js'

/**
 * Get the route off this screen and onto something you can follow.
 *
 * The two halves are deliberately not presented as equivalent. A GPX or GeoJSON
 * file *is* this route. A maps handoff is a different route that happens to
 * start and end in the same places, and the warning below is not decoration —
 * for a route Meander rejected because of steps, handing the endpoints to Apple
 * Maps hands the steps straight back.
 */
export default function TakeItWithYou({ route, origin, dest }) {
  const [confirmHandoff, setConfirmHandoff] = useState(false)
  if (!route?.geometry?.length) return null

  const google = googleMapsUrl(route)
  const apple = appleMapsUrl(route)

  return (
    <div className="takeaway">
      <h4 className="takeaway__title">Take it with you</h4>

      <div className="takeaway__row">
        <button type="button" className="button" onClick={() => downloadGpx(route, { origin, dest })}>
          Download GPX
        </button>
        <button type="button" className="button" onClick={() => downloadGeoJson(route)}>
          Download GeoJSON
        </button>
        <button type="button" className="button" onClick={() => window.print()}>
          Print
        </button>
      </div>
      <p className="takeaway__note">
        The file carries this route exactly, with the coverage figure and any barriers written
        into it.
      </p>

      {(google || apple) && (
        <>
          <button
            type="button"
            className="takeaway__disclose"
            aria-expanded={confirmHandoff}
            onClick={() => setConfirmHandoff((v) => !v)}
          >
            Open in a maps app for turn-by-turn
          </button>

          {confirmHandoff && (
            <div className="takeaway__warn">
              <p>
                <strong>This will not be the same route.</strong> Google and Apple re-plan from
                the start and end points with their own routing, so none of Meander’s steering
                survives the handoff
                {route.id === 'accessible' || route.status !== 'ok' ? (
                  <> — <strong>including the accessibility constraints</strong></>
                ) : null}
                .
              </p>
              <div className="takeaway__row">
                {google && (
                  <a className="button" href={google} target="_blank" rel="noreferrer noopener">
                    Google Maps
                  </a>
                )}
                {apple && (
                  <a className="button" href={apple} target="_blank" rel="noreferrer noopener">
                    Apple Maps
                  </a>
                )}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  )
}
