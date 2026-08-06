/**
 * One inline drawer belonging to one trip-bar segment. Implements §4.3.
 *
 * Rendered *below* the segment grid rather than as an overlay, deliberately.
 * An overlay drawer on this layout would float over the map, and on mobile —
 * where the map sits above the panel — it would cover the answer the user is
 * trying to adjust. Inline means the panel grows and the map never moves.
 *
 * `hidden` rather than unmounting: the drawer's inputs keep their DOM identity
 * across open and close, so a half-typed place name survives closing the
 * drawer, and `aria-controls` on the segment always points at an element that
 * exists.
 */
export default function TripDrawer({ id, labelledBy, open, children }) {
  return (
    <div className="drawer" id={id} role="group" aria-labelledby={labelledBy} hidden={!open}>
      {children}
    </div>
  )
}
