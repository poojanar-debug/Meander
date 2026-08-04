import { useEffect, useId, useRef, useState } from 'react'

import { geocode } from '../api/client.js'

const DEBOUNCE_MS = 300

/**
 * Debounced place search with a proper combobox.
 *
 * The listbox is a real `<ul role="listbox">` with `aria-activedescendant`, so
 * arrow keys move a visible highlight without moving DOM focus out of the
 * input — which is what a screen reader expects from a combobox and what the
 * browser's own autofill does.
 */
export default function PlaceInput({ label, placeholder, value, onPick, onClear }) {
  const inputId = useId()
  const listId = `${inputId}-listbox`
  const errorId = `${inputId}-error`

  const [query, setQuery] = useState(value?.name ?? '')
  const [results, setResults] = useState([])
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(-1)
  const [error, setError] = useState(null)
  const [searching, setSearching] = useState(false)

  const abortRef = useRef(null)
  const skipNextSearch = useRef(false)

  useEffect(() => {
    setQuery(value?.name ?? '')
  }, [value])

  useEffect(() => {
    if (skipNextSearch.current) {
      skipNextSearch.current = false
      return undefined
    }
    const trimmed = query.trim()
    if (trimmed.length < 2) {
      setResults([])
      setOpen(false)
      setError(null)
      return undefined
    }

    const timer = setTimeout(async () => {
      abortRef.current?.abort()
      const controller = new AbortController()
      abortRef.current = controller
      setSearching(true)
      try {
        const found = await geocode(trimmed, { signal: controller.signal })
        setResults(found)
        setOpen(found.length > 0)
        setActive(-1)
        setError(found.length === 0 ? 'No places found for that search.' : null)
      } catch (err) {
        // An abort is the expected outcome of typing another character.
        if (err?.name === 'AbortError') return
        setResults([])
        setOpen(false)
        setError(err.message ?? 'Place search failed.')
      } finally {
        setSearching(false)
      }
    }, DEBOUNCE_MS)

    return () => clearTimeout(timer)
  }, [query])

  useEffect(() => () => abortRef.current?.abort(), [])

  function choose(place) {
    skipNextSearch.current = true
    setQuery(place.name)
    setOpen(false)
    setResults([])
    setActive(-1)
    onPick(place)
  }

  function onKeyDown(event) {
    if (!open || results.length === 0) {
      if (event.key === 'ArrowDown' && results.length > 0) setOpen(true)
      return
    }
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      setActive((i) => (i + 1) % results.length)
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      setActive((i) => (i <= 0 ? results.length - 1 : i - 1))
    } else if (event.key === 'Enter') {
      if (active >= 0) {
        event.preventDefault()
        choose(results[active])
      }
    } else if (event.key === 'Escape') {
      setOpen(false)
      setActive(-1)
    }
  }

  const describedBy = error ? errorId : undefined

  return (
    <div className="field">
      <label className="field__label" htmlFor={inputId}>
        {label}
      </label>
      <div className="place-row">
        <div>
          <input
            id={inputId}
            type="text"
            role="combobox"
            autoComplete="off"
            placeholder={placeholder}
            value={query}
            aria-expanded={open}
            aria-controls={listId}
            aria-autocomplete="list"
            aria-describedby={describedBy}
            aria-activedescendant={active >= 0 ? `${listId}-${active}` : undefined}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKeyDown}
          />
          {open && (
            <ul className="suggestions" id={listId} role="listbox" aria-label={`${label} suggestions`}>
              {results.map((place, i) => (
                <li
                  key={`${place.lat},${place.lon},${place.name}`}
                  id={`${listId}-${i}`}
                  role="option"
                  aria-selected={i === active}
                  className="suggestions__item"
                  onMouseDown={(e) => {
                    // mousedown, not click: the input's blur would close the
                    // list before a click ever landed.
                    e.preventDefault()
                    choose(place)
                  }}
                >
                  {place.name}
                </li>
              ))}
            </ul>
          )}
          {!open && !error && searching && (
            <p className="field__hint">Searching…</p>
          )}
          {error && (
            <p className="field__error" id={errorId} role="alert">
              {error}
            </p>
          )}
        </div>
        {value && (
          <button
            type="button"
            className="button"
            onClick={() => {
              skipNextSearch.current = true
              setQuery('')
              setResults([])
              setOpen(false)
              setError(null)
              onClear()
            }}
          >
            Clear
            <span className="visually-hidden"> {label.toLowerCase()}</span>
          </button>
        )}
      </div>
    </div>
  )
}
