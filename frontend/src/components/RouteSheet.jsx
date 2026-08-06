import { useCallback, useEffect, useRef } from 'react'

/**
 * The bottom sheet that holds the answer.
 *
 * Three snap points, because the three things a user wants are different sizes:
 *
 *   peek  the three routes, one compact row each. This is what is on screen the
 *         instant results arrive, with no scrolling at all — which is the whole
 *         point of Phase 5. The old layout put the first route card about
 *         1,445 px down a 390 px viewport.
 *   half  the selected route's essentials.
 *   full  everything.
 *
 * **Not a modal.** The map behind it stays live and usable at every snap point,
 * so this deliberately does *not* trap focus — a trap would make the map
 * unreachable and would be lying about the relationship between the two.
 * Escape collapses rather than dismisses, because there is nothing to dismiss
 * to: the routes are the content of the page. ControlsSheet is the modal one,
 * and it does trap focus.
 *
 * Every snap point is reachable by button as well as by drag. A drag-only sheet
 * is unusable by keyboard, by switch control, and by anyone whose pointer is
 * not precise.
 *
 * Above 900 px the CSS re-composes this into a fixed left panel — same
 * component, same DOM, no second tree — and the snap machinery goes inert.
 */

export const SNAPS = ['peek', 'half', 'full']

const NEXT = { peek: 'half', half: 'full', full: 'full' }
const PREV = { full: 'half', half: 'peek', peek: 'peek' }

const LABEL = {
  peek: 'Showing the route list',
  half: 'Showing route details',
  full: 'Showing everything',
}

/** Past this, a drag counts as a deliberate move rather than a tap wobble. */
const DRAG_THRESHOLD_PX = 40

export default function RouteSheet({ snap, onSnap, labelledBy, tallRows, children }) {
  const sheetRef = useRef(null)
  const dragStart = useRef(null)

  const expand = useCallback(() => onSnap(NEXT[snap]), [snap, onSnap])
  const collapse = useCallback(() => onSnap(PREV[snap]), [snap, onSnap])

  // Escape collapses one step. Bound to the sheet rather than the document so
  // it cannot swallow Escape from a dialog or a combobox above it.
  const onKeyDown = useCallback(
    (event) => {
      if (event.key === 'Escape' && snap !== 'peek') {
        event.stopPropagation()
        collapse()
      }
    },
    [snap, collapse],
  )

  // Pointer events rather than touch events: one code path for finger, mouse
  // and pen, and it does not fight the sheet's own scrolling because the handle
  // is the only draggable part.
  const onPointerDown = (event) => {
    dragStart.current = { y: event.clientY, snap }
    event.currentTarget.setPointerCapture?.(event.pointerId)
  }

  const onPointerUp = (event) => {
    const start = dragStart.current
    dragStart.current = null
    if (!start) return
    const dy = event.clientY - start.y
    if (Math.abs(dy) < DRAG_THRESHOLD_PX) return
    onSnap(dy < 0 ? NEXT[start.snap] : PREV[start.snap])
  }

  useEffect(() => {
    // Moving to a taller snap should show the top of the content, not wherever
    // the user had scrolled the shorter one to.
    sheetRef.current?.querySelector('.sheet__scroll')?.scrollTo({ top: 0 })
  }, [snap])

  return (
    <section
      ref={sheetRef}
      /* A row carrying a saved-copy chip is two lines rather than one, so peek
         has to be told: its height is an exact calculation over three rows, and
         it would otherwise clip the third one — the single measurement Phase 5
         is graded on. */
      className={`sheet sheet--${snap}${tallRows ? ' sheet--tall-rows' : ''}`}
      data-snap={snap}
      aria-labelledby={labelledBy}
      onKeyDown={onKeyDown}
    >
      {/* The whole grab area is a button, so drag and click are the same target
          rather than a draggable strip with a separate control beside it. */}
      <button
        type="button"
        className="sheet__handle"
        aria-expanded={snap !== 'peek'}
        onPointerDown={onPointerDown}
        onPointerUp={onPointerUp}
        onClick={() => onSnap(snap === 'full' ? 'peek' : NEXT[snap])}
      >
        <span className="sheet__grip" aria-hidden="true" />
        <span className="visually-hidden">
          {LABEL[snap]}. {snap === 'full' ? 'Collapse the list' : 'Show more'}.
        </span>
      </button>

      <div className="sheet__scroll">{children}</div>

      {/* Explicit controls, always present. The handle above is the shortcut;
          these are the guarantee. */}
      <div className="sheet__snaps" role="group" aria-label="Panel size">
        {SNAPS.map((value) => (
          <button
            key={value}
            type="button"
            className="sheet__snap"
            aria-pressed={snap === value}
            onClick={() => onSnap(value)}
          >
            {value === 'peek' ? 'List' : value === 'half' ? 'Details' : 'Everything'}
          </button>
        ))}
      </div>
    </section>
  )
}

export { expandSnap, collapseSnap }

function expandSnap(snap) {
  return NEXT[snap]
}

function collapseSnap(snap) {
  return PREV[snap]
}
