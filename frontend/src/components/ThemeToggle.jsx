/**
 * Light / dark switch.
 *
 * The label names the theme you will *get*, not the one you are in — "Dark"
 * while the page is light. A button labelled with its current state reads as a
 * status display, and people click it expecting to be told rather than to
 * change something.
 *
 * The visible word is a prefix of the accessible name ("Dark theme, switch
 * from light") rather than being replaced by an aria-label, so speech-input
 * users can say what they can see (WCAG 2.5.3). The glyph is decorative: the
 * word carries the meaning on its own.
 */
export default function ThemeToggle({ theme, onToggle }) {
  const next = theme === 'dark' ? 'light' : 'dark'

  return (
    <button
      type="button"
      className="theme-toggle"
      onClick={() => onToggle(next)}
      aria-live="off"
    >
      <span className="theme-toggle__glyph" aria-hidden="true">
        {next === 'dark' ? '◓' : '◒'}
      </span>
      <span>{next === 'dark' ? 'Dark' : 'Light'}</span>
      <span className="visually-hidden"> theme, switch from {theme}</span>
    </button>
  )
}
