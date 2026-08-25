import { useCallback, useEffect, useRef, useState } from 'react'

/**
 * The mobile bottom sheet: surface, 22px top radius, a grabber, and three
 * heights — peek, half, full — reachable by dragging.
 *
 * The sheet itself never scrolls the page. Its content is the scroll
 * container (`overflow-y: auto` on `.sheet`, pinned by contract test), and a
 * drag on the grabber moves the sheet between snap points. Dragging the body
 * only moves the sheet while its content is scrolled to the top and the drag
 * is downward — the ordinary mobile-sheet contract, so reading a long detail
 * does not fling the sheet away.
 *
 * Snap heights are fractions of the stage rather than fixed pixels, so the
 * sheet is right on a 320px phone and on a tablet in portrait without a
 * device table. Motion is a 200ms ease-out translate, and none at all under
 * prefers-reduced-motion.
 */

const SNAPS = { peek: 0.22, half: 0.55, full: 0.94 }

const prefersReducedMotion = () =>
  typeof window !== 'undefined' &&
  window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true

export default function Sheet({ snap = 'half', onSnap, label, children }) {
  const sheetRef = useRef(null)
  const drag = useRef(null)
  const [dragOffset, setDragOffset] = useState(0)

  const heightFor = useCallback((name) => {
    const stage = sheetRef.current?.parentElement
    const total = stage?.clientHeight ?? window.innerHeight
    return Math.round(total * (SNAPS[name] ?? SNAPS.half))
  }, [])

  const onPointerDown = useCallback((event) => {
    // One pointer at a time; a second finger mid-drag is noise, not intent.
    if (drag.current) return
    drag.current = {
      id: event.pointerId,
      startY: event.clientY,
      moved: false,
    }
    event.currentTarget.setPointerCapture?.(event.pointerId)
  }, [])

  const onPointerMove = useCallback((event) => {
    const d = drag.current
    if (!d || event.pointerId !== d.id) return
    const dy = event.clientY - d.startY
    if (Math.abs(dy) > 4) d.moved = true
    setDragOffset(dy)
  }, [])

  const endDrag = useCallback(
    (event) => {
      const d = drag.current
      if (!d || event.pointerId !== d.id) return
      drag.current = null
      const dy = event.clientY - d.startY
      setDragOffset(0)
      if (!d.moved) return
      // Snap to whichever height the released edge is nearest.
      const released = heightFor(snap) - dy
      let best = snap
      let bestDelta = Infinity
      for (const name of Object.keys(SNAPS)) {
        const delta = Math.abs(heightFor(name) - released)
        if (delta < bestDelta) {
          bestDelta = delta
          best = name
        }
      }
      if (best !== snap) onSnap?.(best)
    },
    [snap, heightFor, onSnap],
  )

  // Keyboard access to the same three positions: the grabber is a button that
  // cycles upward through the snaps and wraps, so the whole range is reachable
  // without a pointer.
  const cycle = useCallback(() => {
    const order = ['peek', 'half', 'full']
    const next = order[(order.indexOf(snap) + 1) % order.length]
    onSnap?.(next)
  }, [snap, onSnap])

  const [height, setHeight] = useState(null)
  useEffect(() => {
    const apply = () => setHeight(heightFor(snap))
    apply()
    window.addEventListener('resize', apply)
    return () => window.removeEventListener('resize', apply)
  }, [snap, heightFor])

  const dragged = drag.current != null
  const style = {
    height: height == null ? undefined : `${Math.max(96, height - dragOffset)}px`,
    transition: dragged || prefersReducedMotion() ? 'none' : 'height 200ms ease-out',
  }

  return (
    <section
      className="sheet"
      ref={sheetRef}
      style={style}
      aria-label={label}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
    >
      <button
        type="button"
        className="sheet__grabber-hit"
        aria-label={`${label}: resize sheet`}
        onPointerDown={onPointerDown}
        onClick={cycle}
      >
        <span className="sheet__grabber" aria-hidden="true" />
      </button>
      <div className="sheet__body">{children}</div>
    </section>
  )
}
