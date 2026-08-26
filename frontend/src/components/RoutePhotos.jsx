import { useEffect, useRef, useState } from 'react'

import { fetchPhotos, photoUrl } from '../api/client.js'
import { fmtDist } from '../lib/format.js'

/**
 * What the route looks like: one hero image chosen for what the route
 * optimises, and a strip of a few more along the way.
 *
 * ## The honest version of "show me something scenic"
 *
 * The idea is that picking the scenic route should show you something scenic
 * on it. Two of the six objectives can genuinely deliver that and four cannot,
 * and this component's main job is to not paper over the difference.
 *
 * `accessible` anchors the hero at the first barrier, which is a real
 * coordinate off `Route.blockers` — so the photo is of the thing that blocks
 * you, which is the single most useful picture this feature can produce.
 * `fastest` anchors at the midpoint, which is arithmetic and cannot be wrong.
 *
 * For `scenic`, `shade`, `quiet` and `air` the backend has no per-segment data
 * to anchor on. Those scores reach the wire as one aggregate number per route;
 * the per-way tag spans they are computed from are consumed server-side and
 * never leave it. So the hero falls back to the most-photographed point near
 * the route, and the response says `objective_measured: false`.
 *
 * **That distinction is rendered, not swallowed.** A measured hero gets a
 * caption naming what it is anchored to. An unmeasured one gets a caption that
 * says only where along the route it is. Neither ever reads "the greenest point
 * on this route", because nothing measured greenery point by point and this
 * project does not make claims it cannot support — the same rule that makes a
 * missing OSM tag `UNKNOWN` rather than "accessible".
 *
 * ## Attribution is not optional
 *
 * Every image here is somebody else's work under a licence that requires
 * credit. The backend assembles `attribution` and drops any photo whose licence
 * it could not determine, so a photo that arrives is a photo that may be shown.
 * This component renders that string verbatim under the image. It is not a
 * caption to be shortened for layout.
 *
 * ## It never breaks a route
 *
 * No photos, a failed request, a backend too old to have the endpoint: all of
 * them render nothing at all. There is no error state and no retry, because
 * there is no action the user could take and nothing they are missing — the
 * route, its steps, its barriers and its scores are all complete without a
 * single image.
 */

/** Why this hero is this hero, in a sentence, when the anchor was measured. */
const BASIS_SENTENCE = {
  barrier: 'At the barrier on this route.',
  midpoint: 'Halfway along the route.',
}

function Credit({ photo }) {
  // Verbatim. The backend assembles this from the licence, the author and the
  // source, and drops any photo it could not build one for.
  return (
    <p className="photos__credit">
      {photo.source_page ? (
        <a href={photo.source_page} target="_blank" rel="noreferrer">
          {photo.attribution}
        </a>
      ) : (
        photo.attribution
      )}
    </p>
  )
}

export default function RoutePhotos({ route, units }) {
  const [data, setData] = useState(null)
  const routeRef = useRef(route)
  routeRef.current = route

  const geometry = route?.geometry
  const objective = route?.id

  /**
   * One request per route, not one per arriving field.
   *
   * The naive dependency array is `[geometry, objective, blockers]`, and it is
   * wrong here in a way that costs real requests. A route is merged into state
   * up to three times as narration and enrichment land on it, and `case
   * 'settled'` replaces `state.routes` wholesale — so `route.geometry` gets a
   * new array identity several times for the same walk, without a single
   * coordinate changing. Every one of those would abort a request that was
   * nearly done and start another, against a backend that rate-limits image
   * fetches in their own bucket precisely because six of them come per view.
   *
   * The signature is what actually identifies the question being asked: which
   * objective, over how many vertices, between which two endpoints. The live
   * geometry is read through a ref at fetch time, so the request still sends
   * the current coordinates rather than a stale closure's.
   */
  const signature =
    Array.isArray(geometry) && geometry.length > 1 && objective
      ? `${objective}|${geometry.length}|${geometry[0].join(',')}|${geometry[geometry.length - 1].join(',')}`
      : null

  useEffect(() => {
    if (!signature) return undefined
    const current = routeRef.current
    const geometry = current?.geometry
    const objective = current?.id
    const blockers = current?.blockers
    const controller = new AbortController()
    let live = true

    // Thinned before it is sent. The endpoint caps the geometry it accepts and
    // a route can carry hundreds of vertices, but the real reason is smaller
    // than the cap: the backend only needs enough of the line to place a
    // handful of search anchors on it, and posting every vertex would send a
    // higher-resolution trace of somebody's walk than the question requires.
    const step = Math.max(1, Math.ceil(geometry.length / 200))
    const thinned = geometry.filter((_, i) => i % step === 0 || i === geometry.length - 1)

    fetchPhotos(
      {
        geometry: thinned,
        objective,
        blockers: (blockers ?? []).map((b) => ({ ...b })),
      },
      { signal: controller.signal },
    ).then((result) => {
      if (live) setData(result)
    })

    return () => {
      live = false
      controller.abort()
    }
  }, [signature])

  const hero = data?.hero ?? null
  const strip = data?.strip ?? []
  if (!hero && strip.length === 0) return null

  const basis = data?.objective_measured ? BASIS_SENTENCE[data.hero_basis] : null

  return (
    <section className="photos" aria-label="Photographs along this route">
      {hero && (
        <figure className="photos__hero">
          <img
            className="photos__hero-img"
            src={photoUrl(hero.url)}
            // The alt text says what is known and no more. It is not a
            // description of the photograph — nothing here has looked at the
            // pixels — so it says where the picture was taken and leaves the
            // claim at that. Inventing "a tree-lined path" would be a caption
            // for an image nobody has seen.
            alt={
              hero.title
                ? `Photograph titled ${hero.title}, taken near this route`
                : 'Photograph taken near this route'
            }
            loading="lazy"
            decoding="async"
            width={hero.width || undefined}
            height={hero.height || undefined}
          />
          <figcaption className="photos__caption">
            {basis ?? (
              typeof hero.at_m === 'number'
                ? `${fmtDist(hero.at_m, units)} along the route.`
                : 'Near this route.'
            )}
            <Credit photo={hero} />
          </figcaption>
        </figure>
      )}

      {strip.length > 0 && (
        <ul className="photos__strip">
          {strip.map((photo) => (
            <li className="photos__strip-item" key={photo.id}>
              <figure className="photos__thumb">
                <img
                  className="photos__thumb-img"
                  src={photoUrl(photo.url)}
                  alt={
                    typeof photo.at_m === 'number'
                      ? `Photograph taken about ${fmtDist(photo.at_m, units)} along this route`
                      : 'Photograph taken near this route'
                  }
                  loading="lazy"
                  decoding="async"
                />
                <figcaption className="photos__thumb-caption mono">
                  {typeof photo.at_m === 'number' ? fmtDist(photo.at_m, units) : ''}
                  <Credit photo={photo} />
                </figcaption>
              </figure>
            </li>
          ))}
        </ul>
      )}

      {/* The sentence that stops the hero from being read as a measurement.
          Only when the backend says the anchor was not measured, which for
          four of the six objectives is always. */}
      {data?.note && <p className="photos__note">{data.note}</p>}
    </section>
  )
}
