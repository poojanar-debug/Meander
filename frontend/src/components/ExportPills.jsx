import { useEffect } from 'react'

import {
  appleMapsUrl,
  downloadGeoJson,
  downloadGpx,
  exportStamp,
  googleMapsUrl,
  provenanceNote,
} from '../lib/export.js'
import { fmtDist } from '../lib/format.js'

/** Apple platforms hand off to Apple Maps; everything else to Google. The
 *  warning above the link covers both by name, because either way the caveat
 *  is the same: those apps route again from the endpoints. */
const isApplePlatform = () =>
  /Mac|iPhone|iPad|iPod/.test(navigator.platform ?? '') ||
  (navigator.maxTouchPoints > 1 && /Mac/.test(navigator.userAgent ?? ''))

/**
 * The export pills: GPX, GeoJSON, Print, Open in Maps — with the hand-off
 * warning in the DOM before the link it warns about, so nothing reachable
 * precedes its own caveat. Every file leaves with the provenance note; the
 * printed sheet carries it too, plus the complete directions, because a
 * folded step list must never fold on paper.
 */
export default function ExportPills({ route, origin, dest, units, onAnnounce }) {
  // A printed sheet with a disclosure collapsed is a printed sheet without
  // its contents. Fires for Cmd-P as well as for the Print pill.
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

  const note = provenanceNote(route, units)
  const stamp = exportStamp(route)
  const exportable = (route.geometry?.length ?? 0) >= 2
  const handoff = exportable ? (isApplePlatform() ? appleMapsUrl(route) : googleMapsUrl(route)) : null

  const onGpx = () => {
    downloadGpx(route, { origin, dest }, units)
    onAnnounce?.('GPX file saved.')
  }
  const onGeoJson = () => {
    downloadGeoJson(route, units)
    onAnnounce?.('GeoJSON file saved.')
  }

  return (
    <>
      <div className="exports">
        <p className="exports__warn mono" id="exports-warn">
          Google / Apple hand-off will not be the same route
        </p>
        <div className="exports__row">
          <button type="button" className="pill" onClick={onGpx} disabled={!exportable}>
            GPX
          </button>
          <button type="button" className="pill" onClick={onGeoJson} disabled={!exportable}>
            GeoJSON
          </button>
          <button type="button" className="pill" onClick={() => window.print()}>
            Print
          </button>
          {handoff && (
            <a
              className="pill"
              href={handoff}
              target="_blank"
              rel="noreferrer noopener"
              aria-describedby="exports-warn"
            >
              Open in Maps
            </a>
          )}
        </div>
      </div>

      {/* Screen-hidden, print-only: the provenance and the complete
          directions. The caveat has to be on the paper too. */}
      <section className="printsheet" aria-hidden="true">
        <h4 className="printsheet__h">Where this came from</h4>
        <p className="printsheet__note">{note}</p>
        {(route.steps?.length ?? 0) > 0 && (
          <ol className="printsheet__steps">
            {route.steps.map((step, i) => (
              <li key={`${i}-${step.text}`}>
                {step.text}
                {step.distance_m >= 5 && ` · ${fmtDist(step.distance_m, units)}`}
              </li>
            ))}
          </ol>
        )}
        <p className="printsheet__stamp">Printed from Meander, {stamp.isoTime}.</p>
      </section>
    </>
  )
}
