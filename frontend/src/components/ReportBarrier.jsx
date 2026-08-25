import { useId, useMemo, useState } from 'react'

import { reportBarrier } from '../api/client.js'
import { fmtDist } from '../lib/format.js'
import { cumulativeDistances, pointAtDistance } from '../lib/follow.js'

/**
 * Report an obstruction the map does not know about.
 *
 * `POST /api/report-barrier` has been live since the launch branch with about
 * sixteen tests behind it, and nothing in the shipped UI called it. This is the
 * caller.
 *
 * It closes the only loop that can actually improve the app. Meander's central
 * limitation is that OpenStreetMap tagging is incomplete — most footways carry
 * no `surface`, no `smoothness` and no `kerb`, which is why so many routes
 * report low coverage — and a person who has just walked into a barrier is the
 * one source of that data nobody else has.
 *
 * **Where, not just what.** A report with no location is not actionable by a
 * mapper, so the position comes from a distance along the route. "About 400 m
 * along this route" is how people describe where something is, and unlike a tap
 * on a small map it is precision genuinely derived from the geometry rather
 * than from a fingertip.
 *
 * ⚠ **This is the one place the app writes anything, anywhere.** A note is
 * public and permanent. The privacy paragraphs in About and on the first-run
 * card name this exception rather than quietly acquiring one, and the warning
 * below is placed *before* the button — somebody offering real local knowledge
 * should know where it is going before they spend the effort typing it.
 *
 * On degradation: OSM_DEV_TOKEN is **optional**. backend/osm_report.py:60 notes
 * that anonymous notes are permitted, so an unset token yields an unattributed
 * note rather than a failure. Nothing here inspects configuration; the failure
 * message comes from the response, which is the only thing that knows.
 */

// The engine emits `steps` and `incline`; the others are things a person can
// find that it has no tag for at all, which is the point of the form.
const TYPES = [
  ['barrier', 'Barrier or obstruction'],
  ['steps', 'Steps'],
  ['surface', 'Surface'],
  ['smoothness', 'Surface condition'],
  ['incline', 'Gradient'],
]

export default function ReportBarrier({ route, units }) {
  const formId = useId()
  const [open, setOpen] = useState(false)
  const [type, setType] = useState('barrier')
  const [description, setDescription] = useState('')
  const [atM, setAtM] = useState(0)
  const [state, setState] = useState({ status: 'idle' })

  const geometry = route?.geometry ?? []
  const cumulative = useMemo(() => cumulativeDistances(geometry), [geometry])

  // The route's own reported distance, not a second measurement of the same
  // line. Two totals in one panel is the kind of disagreement that makes a
  // reader distrust both.
  const total = Math.round(route?.distance_m ?? cumulative[cumulative.length - 1] ?? 0)

  if (geometry.length < 2 || !(total > 0)) return null

  async function submit(event) {
    event.preventDefault()
    const at = pointAtDistance(geometry, atM, cumulative)
    if (!at) {
      setState({ status: 'failed', message: 'That point could not be placed on the route.' })
      return
    }

    setState({ status: 'sending' })
    try {
      // Rounded to six decimals — about 11 cm, far finer than anyone can point
      // at and no finer than the server keeps.
      const result = await reportBarrier({
        lat: Number(at.lat.toFixed(6)),
        lon: Number(at.lon.toFixed(6)),
        type,
        description: description.trim(),
      })
      setState({ status: 'sent', note: result?.note_id ?? null })
      setDescription('')
    } catch (err) {
      setState({
        status: 'failed',
        message:
          err?.message ??
          'That could not be sent. Nothing was filed, so nothing was published.',
      })
    }
  }

  if (!open) {
    return (
      <button type="button" className="report__open" onClick={() => setOpen(true)}>
        Report a barrier on this route
      </button>
    )
  }

  const sending = state.status === 'sending'

  return (
    <form className="report" onSubmit={submit} aria-labelledby={`${formId}-title`}>
      <h4 className="report__title" id={`${formId}-title`}>
        Report a barrier
      </h4>

      <p className="report__lede">
        Meander can only route around a barrier somebody has already recorded. If you found
        one it did not know about, this is how it gets known.
      </p>

      <div className="field">
        <label className="field__label" htmlFor={`${formId}-type`}>
          What kind?
        </label>
        <select
          id={`${formId}-type`}
          className="report__select"
          value={type}
          onChange={(e) => setType(e.target.value)}
        >
          {TYPES.map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
      </div>

      <div className="field">
        <label className="field__label" htmlFor={`${formId}-at`}>
          How far along the route? <span className="tabular">{fmtDist(atM, units)}</span> of{' '}
          <span className="tabular">{fmtDist(total, units)}</span>
        </label>
        <input
          id={`${formId}-at`}
          className="report__range"
          type="range"
          min={0}
          max={total}
          step={Math.max(10, Math.round(total / 100))}
          value={atM}
          aria-valuetext={`${fmtDist(atM, units)} along the route`}
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

      {/* Before the button, not after it. */}
      <p className="report__warn">
        This is published. It goes to the OpenStreetMap <strong>development</strong> server
        as a public note holding the point you chose and the words you wrote, not to the
        live map. That data is disposable and no navigation app reads it: the write path is
        real, but it will not help strangers yet. Nothing else you do in Meander leaves this
        device, and nothing is kept on it unless you ask.
      </p>

      <div className="report__actions">
        <button
          type="submit"
          className="button-sky"
          disabled={sending || !description.trim()}
        >
          {sending ? 'Sending…' : 'Send report'}
        </button>
        <button type="button" className="pill" onClick={() => setOpen(false)}>
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
