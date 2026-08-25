import { useEffect, useId, useRef, useState } from 'react'

import { geocode } from '../api/client.js'
import { GEOLOCATED } from '../lib/permalink.js'
import { LocationArrowIcon, MagnifierIcon } from './Icons.jsx'

/**
 * How long after the last keystroke the search fires.
 *
 * **300 ms sat exactly on the median inter-keystroke interval of a 40 wpm
 * typist** — 200 characters a minute is 300 ms a character — which made the
 * cost of a name knife-edge bimodal. At a constant 299 ms gap a 20-character
 * name costs 1 request; at 301 ms it costs 19. Simulated with lognormal gaps
 * (200,000 trials, sigma 0.40, 20 characters): 60 wpm costs a mean of 3.8
 * requests, **40 wpm costs 8.6**, and a slower typist at a 400 ms median costs
 * 14.8.
 *
 * The failure that produced: two place names came to 17.1 requests against a
 * per-IP bucket of 12 that /api/routes shared, so **the bucket was empty before
 * the first route request was made** and that request was refused too, showing
 * routing copy under the place box. Continuous typing hit the first 429 at a
 * median of 32 characters.
 *
 * 500 ms is well clear of a 40 wpm typist's gaps, which is what moves it off
 * the knife edge: the same 20-character name drops from a mean of 8.6 requests
 * to 2.8, about 67% fewer. Not 600: the last keystroke's request always fires
 * at exactly +DEBOUNCE_MS, so the entire visible cost of this change is 200 ms
 * more before suggestions appear after someone stops typing.
 */
const DEBOUNCE_MS = 500

/**
 * Queries already answered, so backspacing costs nothing.
 *
 * Module-level rather than per-component on purpose: this combobox mounts in
 * two places (the capsule popover and the mobile search screen) and both
 * search the same world. Deleting three characters and typing them back is the
 * case this actually serves — the server-side cache exists for the same reason,
 * and neither is really a normalisation win: case-folding the 12-query burst
 * recorded in `fixtures/nominatim/` still gives 12 distinct keys.
 *
 * Small and short-lived because it is a keystroke cache, not a store. Fifty
 * entries is far more than one session's typing, and five minutes is long
 * enough to cover editing a trip and short enough that a place renamed in OSM
 * is not remembered wrongly for the rest of the day.
 */
const LRU_MAX = 50
const LRU_TTL_MS = 5 * 60 * 1000
const lru = new Map()

const cacheKey = (q) => q.replace(/\s+/g, ' ').trim().toLowerCase()

function lruGet(key) {
  const hit = lru.get(key)
  if (!hit) return null
  if (Date.now() - hit.at > LRU_TTL_MS) {
    lru.delete(key)
    return null
  }
  // Re-inserted so it becomes the most recent. A Map iterates in insertion
  // order, which is what makes the eviction below least-recently-used rather
  // than least-recently-written.
  lru.delete(key)
  lru.set(key, hit)
  return hit.results
}

function lruPut(key, results) {
  lru.delete(key)
  lru.set(key, { results, at: Date.now() })
  while (lru.size > LRU_MAX) lru.delete(lru.keys().next().value)
}

/** Exported for the test suite only; nothing in the app calls it. */
export function __resetPlaceCache() {
  lru.clear()
}

/** "Colombo Fort, Colombo, Sri Lanka" → a name and the part after it, for the
 *  two-line result row. Nothing is invented: both halves are the geocoder's. */
function splitPlaceName(name) {
  const comma = name.indexOf(',')
  if (comma === -1) return { main: name, sub: null }
  return { main: name.slice(0, comma), sub: name.slice(comma + 1).trim() }
}

/**
 * Debounced place search with a proper combobox.
 *
 * The listbox is a real `<ul role="listbox">` with `aria-activedescendant`, so
 * arrow keys move a visible highlight without moving DOM focus out of the
 * input — which is what a screen reader expects from a combobox and what the
 * browser's own autofill does.
 *
 * Two skins over one engine: the mobile place-search screen renders it
 * `inline` (the list is part of the page, at most six rows, the top hit
 * marked in mint), and the desktop capsule popover renders the same combobox
 * floating. The debounce, the cache and the sentinel skip are identical in
 * both, which is the point of them living here.
 */
export default function PlaceInput({
  label,
  placeholder,
  value,
  onPick,
  onClear,
  onLocate,
  locating = false,
  inline = false,
  autoFocus = false,
}) {
  const inputId = useId()
  const listId = `${inputId}-listbox`
  const errorId = `${inputId}-error`

  const [query, setQuery] = useState(value?.name ?? '')
  const [results, setResults] = useState([])
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(-1)
  const [error, setError] = useState(null)
  // "Looked, found nothing" is a quiet real answer, not an error — the same
  // distinction the rest of the app keeps between [] and null.
  const [noneFound, setNoneFound] = useState(false)
  const [searching, setSearching] = useState(false)

  const abortRef = useRef(null)
  // Seeded from the incoming value, so a field that arrives already filled does
  // not search for what it is already showing. It used to: the effect ran on
  // mount against `value.name`, so pressing "Use my location" issued
  // `GET /api/geocode?q=Your%20location` — a request for a sentinel string that
  // names no place, spending a token from the bucket the type-ahead needs, on
  // the one path where the user has told us the coordinates outright.
  const skipNextSearch = useRef(Boolean(value?.name))

  useEffect(() => {
    setQuery(value?.name ?? '')
  }, [value])

  // The effect keys on the trimmed value, not the raw one. Typing the space in
  // a two-word name used to re-arm the timer for a byte-identical query and
  // cost a duplicate request — the effect depended on `query` while the search
  // used `query.trim()`, so "St " and "St" were different dependencies and the
  // same search.
  const trimmed = query.trim()

  useEffect(() => {
    if (skipNextSearch.current) {
      skipNextSearch.current = false
      return undefined
    }
    if (trimmed.length < 2) {
      setResults([])
      setOpen(false)
      setError(null)
      setNoneFound(false)
      return undefined
    }
    // Never the sentinel. GEOLOCATED is the name given to a position the
    // browser reported, so it is the one query guaranteed to match nothing.
    if (trimmed === GEOLOCATED) return undefined

    const key = cacheKey(trimmed)
    const remembered = lruGet(key)
    if (remembered) {
      setResults(remembered)
      setOpen(remembered.length > 0)
      setActive(-1)
      setError(null)
      setNoneFound(remembered.length === 0)
      return undefined
    }

    const timer = setTimeout(async () => {
      abortRef.current?.abort()
      const controller = new AbortController()
      abortRef.current = controller
      // Set before the await and cleared in `finally`, and the hint below is no
      // longer gated on `!open`: nothing ever set `open` back to false between
      // queries, so after the first successful search the "Searching…" hint
      // could never appear again for the rest of the session.
      setSearching(true)
      try {
        const found = await geocode(trimmed, { signal: controller.signal })
        lruPut(key, found)
        setResults(found)
        setOpen(found.length > 0)
        setActive(-1)
        setError(null)
        setNoneFound(found.length === 0)
      } catch (err) {
        // An abort is the expected outcome of typing another character.
        if (err?.name === 'AbortError') return
        setResults([])
        setOpen(false)
        setNoneFound(false)
        setError(err.message ?? 'Place search failed.')
      } finally {
        setSearching(false)
      }
    }, DEBOUNCE_MS)

    return () => clearTimeout(timer)
  }, [trimmed])

  useEffect(() => () => abortRef.current?.abort(), [])

  function choose(place) {
    skipNextSearch.current = true
    setQuery(place.name)
    setOpen(false)
    setResults([])
    setActive(-1)
    setNoneFound(false)
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
  // At most six rows, by design. The mock already stops there; the live
  // geocoder is capped here so both behave alike.
  const shown = results.slice(0, 6)

  return (
    <div className={inline ? 'place place--inline' : 'place'}>
      <div className="place__field">
        <span className="place__magnifier" aria-hidden="true">
          <MagnifierIcon size={16} />
        </span>
        <input
          id={inputId}
          className="place__input"
          type="text"
          role="combobox"
          autoComplete="off"
          // eslint-disable-next-line jsx-a11y/no-autofocus
          autoFocus={autoFocus}
          placeholder={placeholder}
          aria-label={label}
          value={query}
          aria-expanded={open}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-describedby={describedBy}
          aria-activedescendant={active >= 0 ? `${listId}-${active}` : undefined}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onKeyDown}
        />
        {value ? (
          <button
            type="button"
            className="place__locate"
            onClick={() => {
              skipNextSearch.current = true
              setQuery('')
              setResults([])
              setOpen(false)
              setError(null)
              setNoneFound(false)
              onClear?.()
            }}
          >
            Clear
            <span className="visually-hidden"> {label.toLowerCase()}</span>
          </button>
        ) : (
          onLocate && (
            <button
              type="button"
              className="place__locate place__locate--arrow"
              onClick={onLocate}
              disabled={locating}
              aria-label="Use my location"
            >
              <LocationArrowIcon size={16} />
            </button>
          )
        )}
      </div>

      {open && (
        <ul className="place__list" id={listId} role="listbox" aria-label={`${label} suggestions`}>
          {shown.map((place, i) => {
            const { main, sub } = splitPlaceName(place.name)
            return (
              <li
                key={`${place.lat},${place.lon},${place.name}`}
                id={`${listId}-${i}`}
                role="option"
                aria-selected={i === active}
                className={`place__row${i === active ? ' is-active' : ''}`}
                onMouseDown={(e) => {
                  // mousedown, not click: the input's blur would close the
                  // list before a click ever landed.
                  e.preventDefault()
                  choose(place)
                }}
              >
                {/* The top hit wears the mint circle; the rest stay neutral. */}
                <span
                  className={`place__circle${i === 0 ? ' place__circle--top' : ''}`}
                  aria-hidden="true"
                >
                  <span className={`dot ${i === 0 ? 'dot--scenic' : 'dot--ink'}`} />
                </span>
                <span className="place__name">
                  {main}
                  {sub && <span className="place__sub">{sub}</span>}
                </span>
              </li>
            )
          })}
        </ul>
      )}

      {locating && !error && <p className="place__hint mono">Finding you…</p>}
      {!locating && !error && searching && <p className="place__hint mono">Searching…</p>}
      {/* An empty list is a quiet real answer, not an error. */}
      {!error && !searching && noneFound && (
        <p className="place__hint mono">No places found for that search.</p>
      )}
      {error && (
        <p className="place__hint mono" id={errorId} role="alert">
          {error}
        </p>
      )}
    </div>
  )
}
