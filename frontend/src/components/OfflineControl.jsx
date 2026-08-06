import { setSaveResults, useOfflineSetting } from '../lib/offlineStore.js'

/**
 * Permission to keep the last result on this device.
 *
 * The app shell is cached without asking, and this control does not offer to
 * turn that off — it is the program, it is identical for every visitor, and
 * caching it is what makes the app open at all on a train. A *result* is the
 * opposite: a line through the streets around wherever the user is standing.
 * Writing that to disk is the most revealing thing Meander could do, so it is
 * off until asked for, in the same way and for the same reason as the units
 * preference in `UnitsControl`.
 *
 * The wording says what is kept rather than what the feature is called. "Work
 * offline" is a benefit; "one route, on this device, until you replace it" is
 * the thing being agreed to, and it is the second one a person needs in order
 * to decide.
 */
export default function OfflineControl() {
  const { saveResults } = useOfflineSetting()

  return (
    <fieldset className="chips">
      <legend>Keep my last route for offline</legend>

      <div className="chips__row">
        <button
          type="button"
          className="chip"
          aria-pressed={!saveResults}
          onClick={() => setSaveResults(false)}
        >
          Don’t keep it
        </button>
        <button
          type="button"
          className="chip"
          aria-pressed={saveResults}
          onClick={() => setSaveResults(true)}
        >
          Keep it
        </button>
      </div>

      {saveResults ? (
        <p className="field__hint">
          Your most recent result is stored on this device so it opens without a network.
          One route at a time — asking for another replaces it, and Meander never keeps a
          history of where you have looked. It is always labelled with its age when it is
          shown. Choosing “Don’t keep it” deletes it immediately.
        </p>
      ) : (
        <p className="field__hint">
          Nothing is kept. Meander opens without a network but has no route to show until
          you are back online. Turning this on stores your most recent result — which
          includes the roads it runs along — on this device only.
        </p>
      )}
    </fieldset>
  )
}
