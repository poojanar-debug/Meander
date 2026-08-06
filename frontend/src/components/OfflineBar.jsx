import { cacheTier, cachedNotice, offlineBarText } from '../lib/offline.js'

/**
 * The full statement that what is on screen came off the disk, not the network.
 *
 * Volume scales with age, exactly as `TrustSignal` scales it with coverage —
 * a copy from four minutes ago is a chip, a copy from two days ago is a block
 * with a border and a paragraph naming what in it has stopped being true.
 *
 * This is the *long* form and it sits with the results, so the sheet's peek
 * snap does not render it: peek is three route rows and nothing else, which is
 * the Phase 5 gate. The short form travels instead — a pill under the top bar
 * that no snap can hide, and a chip on each compact row. Between them the age
 * is on screen in every state the app has, which is the requirement; this adds
 * the part a chip has no room for, which is *what* has gone stale.
 */
export default function OfflineBar({ ageMs, online }) {
  const tier = cacheTier(ageMs)
  // The headline says *why* there is a saved copy as well as how old it is, and
  // the two reasons are not the same sentence. A dead server with a perfectly
  // good network is the commoner of the two, and telling that user they are
  // offline sends them to restart a router that was never the problem. The
  // per-route surfaces use `cachedNotice` instead — on a card the age is the
  // point and the cause is not.
  const { detail } = cachedNotice(ageMs)

  return (
    <div className={`offline offline--${tier}`} role="status">
      <p className="offline__headline">{offlineBarText(ageMs, online)}</p>
      {detail && <p className="offline__detail">{detail}</p>}
      {/* Map tiles are third-party and are deliberately never cached — a tile
          cache is a record of where you have been. Said here because a blank
          map otherwise reads as the app being broken. */}
      {!online && (
        <p className="offline__detail offline__detail--map">
          Map tiles are not kept on your device, so the map will be blank until you are back
          online. Everything the routes say is in the list.
        </p>
      )}
    </div>
  )
}
