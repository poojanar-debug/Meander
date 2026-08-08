import { canStateLocalTime, daylightGuard, minutesToFinishBySunset, sunTimes } from '../lib/sun.js'

/**
 * The one warning a route earns about the light. Implements §6.3's guards.
 *
 * Renders **nothing at all** when the calculation cannot be made — no
 * coordinates, no duration, a failed solve. An unknown daylight window is not a
 * caution; it is silence. Rendering "we could not work out when it gets dark"
 * would be noise on every route where the sun is not an issue.
 *
 * At most one warning, and at most one action. Offering both "shorten" and
 * "start at sunrise" would ask the user to compare two fixes for a problem they
 * have only just been told about.
 */
export default function DaylightGuard({
  route,
  origin,
  departAt,
  units,
  onMinutes,
  onDepartAt,
}) {
  if (!route || !origin || typeof route.duration_min !== 'number') return null
  // Every sentence this component can produce names a clock time or is about
  // to. If the viewer's timezone and the route's longitude disagree, none of
  // them can be stated honestly, so none of them are stated.
  if (!canStateLocalTime(origin.lon)) return null

  const start = departAt ? new Date(departAt) : new Date()
  if (Number.isNaN(start.valueOf())) return null
  const end = new Date(start.getTime() + route.duration_min * 60000)

  const guard = daylightGuard({ start, end, lat: origin.lat, lon: origin.lon, units })
  if (!guard) return null

  const times = sunTimes(start, origin.lat, origin.lon)
  const shorter =
    guard.action === 'shorten' && times?.sunset
      ? minutesToFinishBySunset(start, times.sunset)
      : null
  const sunrise = guard.action === 'sunrise' ? times?.sunrise : null

  return (
    <div className="note note--warn" role="note">
      <p className="note__title">{guard.text}</p>
      {shorter && (
        <button type="button" className="link-button" onClick={() => onMinutes(shorter)}>
          Shorten to finish before sunset
        </button>
      )}
      {sunrise && (
        <button
          type="button"
          className="link-button"
          onClick={() => onDepartAt(sunrise.toISOString())}
        >
          Start at sunrise instead
        </button>
      )}
    </div>
  )
}
