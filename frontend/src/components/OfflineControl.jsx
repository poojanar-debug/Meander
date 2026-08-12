import { setSaveResults, useOfflineSetting } from '../lib/offlineStore.js'

/**
 * The one permission this app asks for.
 *
 * It sits inside About, against the paragraph that states the privacy promise,
 * because a control that changes what that paragraph means belongs next to the
 * sentence it changes rather than three screens away in a settings drawer.
 * Same argument as lib/theme.js — this is the only other thing written to the
 * browser at the user's request.
 *
 * It is a standing permission, not a per-route save. The detail panel carries a
 * standing prohibition on Save controls, and keeping this in About is what
 * makes the distinction visible rather than merely intended.
 *
 * Reads as off until the asynchronous read resolves. Off-until-proven-on is the
 * only correct default for a flag guarding a write of someone's location.
 */
export default function OfflineControl() {
  const { saveResults, ready } = useOfflineSetting()

  return (
    <fieldset className="chips">
      <legend>Keep the last routes on this device?</legend>
      <div className="chips__row">
        <button
          type="button"
          className="chip"
          aria-pressed={ready && !saveResults}
          onClick={() => setSaveResults(false)}
        >
          No
          {ready && !saveResults && (
            <span className="chip__check" aria-hidden="true">
              ✓
            </span>
          )}
        </button>
        <button
          type="button"
          className="chip"
          aria-pressed={ready && saveResults}
          onClick={() => setSaveResults(true)}
        >
          Yes, keep them
          {ready && saveResults && (
            <span className="chip__check" aria-hidden="true">
              ✓
            </span>
          )}
        </button>
      </div>

      <p className="field__hint">
        {saveResults
          ? 'The last set of routes is kept on this device, in the browser’s cache store. Not in a cookie, and never sent anywhere. Only the most recent one is kept, it is always labelled with its age, and choosing “No” deletes it immediately. It comes back when you ask for the same walk again from within about twenty-five metres of where you saved it, so that it still works when your phone’s idea of where you are has drifted.'
          : 'Nothing about where you go is kept. The app itself is stored so it opens without a connection, but that is the program: the same for everyone, and it says nothing about you.'}
      </p>
    </fieldset>
  )
}
