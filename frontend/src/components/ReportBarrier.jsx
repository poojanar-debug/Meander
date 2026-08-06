import { useId, useState } from 'react'

import { reportBarrier } from '../api/client.js'
import { BLOCKER_TYPE_NAMES, fmtDist, pointAtDistance, polylineLength } from '../lib/format.js'

/**
 * Report an obstruction the map does not know about.
 *
 * This closes the only loop that can actually improve the app. Meander's
 * central limitation is that OpenStreetMap tagging is incomplete — most of the
 * world's footways carry no `surface`, no `smoothness` and no `kerb` tag, which
 * is why so many routes report low coverage — and a person who has just walked
 * into a barrier is the one source of that data nobody else has.
 *
 * **Where, not just what.** A report with no location is not actionable by a
 * mapper, so the position comes from a distance along the route: "about 400 m
 * along this route" is how people describe where something is, and unlike a tap
 * on a small map it is precision genuinely derived from the route geometry
 * rather than from a fingertip.
 *
 * ⚠ The destination is api06.dev.openstreetmap.org — the OSM **development**
 * server, whose data is disposable and which no navigation app reads. The
 * backend asserts that host at call time rather than only configuring it. The
 * form says so, because a user offering real local knowledge deserves to know
 * it is going somewhere it will not help strangers yet.
 */

const TYPES = Object.entries(BLOCKER_TYPE_NAMES)

export default function ReportBarrier({ route }) {
  const formId = useId()
  const [open, setOpen] = useState(false)
  const [type, setType] = useState('barrier')
  const [description, setDescription] = useState('')
  const [atM, setAtM] = useState(0)
  const [state, setState] = useState({ status: 'idle' })

  const geometry = route?.geometry ?? []
  const total = Math.round(polylineLength(geometry))
  if (geometry.length < 2) return null

  async function submit(event) {
    event.preventDefault()
    const at = pointAtDistance(geometry, atM)
    if (!at) return

    setState({ status: 'sending' })
    try {
      const result = await reportBarrier({
        lat: Number(at.lat.toFixed(6)),
        lon: Number(at.lon.toFixed(6)),
        type,
        description: description.trim(),
      })
      setState({ status: 'sent', note: result?.note_id ?? null })
      setDescription('')
    } catch (err) {
      setState({ status: 'failed', message: err?.message ?? 'That could not be sent.' })
    }
  }

  if (!open) {
    return (
      <button type="button" className="report__open" onClick={() => setOpen(true)}>
        Report a barrier on this route
      </button>
    )
  }

  return (
    <form className="report" onSubmit={submit} aria-labelledby={`${formId}-title`}>
      <h4 className="report__title" id={`${formId}-title`}>
        Report a barrier
      </h4>

      <p className="report__where">
        Meander can only reject a barrier somebody has already recorded. If you found one
        it did not know about, this is how it gets known.
      </p>

      <div className="field">
        <label className="field__label" htmlFor={`${formId}-type`}>
          What kind?
        </label>
        <select id={`${formId}-type`} value={type} onChange={(e) => setType(e.target.value)}>
          {TYPES.map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
      </div>

      <div className="field">
        <label className="field__label" htmlFor={`${formId}-at`}>
          How far along the route? <span className="tabular">{fmtDist(atM)}</span> of{' '}
          <span className="tabular">{fmtDist(total)}</span>
        </label>
        <input
          id={`${formId}-at`}
          type="range"
          min={0}
          max={total}
          step={Math.max(10, Math.round(total / 100))}
          value={atM}
          aria-valuetext={`${fmtDist(atM)} along the route`}
          onChange={(e) => setAtM(Number(e.target.value))}
        />
      </div>

      <div className="field">
        <label className="field__label" htmlFor={`${formId}-desc`}>
          What is there?
        </label>
        <textarea
          id={`${formId}-desc`}
          className="report__text"
          rows={3}
          maxLength={500}
          required
          placeholder="e.g. Four steps up to the bridge, no ramp"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
        />
      </div>

      {/* Said before the button, not after. Somebody offering real local
          knowledge should know where it is going before they spend the effort. */}
      <p className="report__warn">
        This goes to the OpenStreetMap <strong>development</strong> server, not the live
        map. It is disposable data that no navigation app reads — the write path is real,
        but it will not help strangers yet.
      </p>

      <div className="report__actions">
        <button
          type="submit"
          className="button button--primary"
          disabled={state.status === 'sending' || !description.trim()}
        >
          {state.status === 'sending' ? 'Sending…' : 'Send report'}
        </button>
        <button type="button" className="button" onClick={() => setOpen(false)}>
          Cancel
        </button>
      </div>

      <p className="report__status" role="status">
        {state.status === 'sent' &&
          `Thank you. Filed on the OpenStreetMap development server${
            state.note ? ` as note ${state.note}` : ''
          }.`}
        {state.status === 'failed' && state.message}
      </p>
    </form>
  )
}
