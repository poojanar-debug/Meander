import { describe, expect, it } from 'vitest'

import { isViewpoint, normaliseType, shortLabel, spokenLabel } from './amenities.js'

/**
 * Behavioural coverage for the one table `RouteDetail`, `MapView` and
 * `FollowMode` all read instead of each keeping its own opinion about what a
 * `rest_stops` type string means. The header comment on amenities.js names the
 * defect this file existed to fix: `restPillLabel` in RouteDetail already
 * normalised both spellings the backend can send, and nothing else did.
 */

describe('normaliseType', () => {
  it('folds spaces to underscores, so both backend spellings land on one key', () => {
    // Both really do reach the frontend — see the file header — so this is not
    // a hypothetical input.
    expect(normaliseType('drinking water')).toBe('drinking_water')
    expect(normaliseType('drinking_water')).toBe('drinking_water')
    expect(normaliseType('drinking water')).toBe(normaliseType('drinking_water'))
  })

  it('lower-cases and trims', () => {
    expect(normaliseType('  Bench  ')).toBe('bench')
    expect(normaliseType('VIEWPOINT')).toBe('viewpoint')
  })

  it('collapses internal runs of whitespace to one underscore', () => {
    expect(normaliseType('drinking   water')).toBe('drinking_water')
  })

  it('does not throw on empty, null or undefined, and treats them alike', () => {
    expect(() => normaliseType(null)).not.toThrow()
    expect(() => normaliseType(undefined)).not.toThrow()
    expect(() => normaliseType('')).not.toThrow()
    expect(normaliseType(null)).toBe('')
    expect(normaliseType(undefined)).toBe('')
    expect(normaliseType('')).toBe('')
  })
})

describe('isViewpoint', () => {
  it('is true for viewpoint, in either spelling of case or padding', () => {
    expect(isViewpoint('viewpoint')).toBe(true)
    expect(isViewpoint('Viewpoint')).toBe(true)
    expect(isViewpoint(' VIEWPOINT ')).toBe(true)
  })

  it('is false for every facility type — a viewpoint is not a rest stop', () => {
    for (const type of ['bench', 'drinking_water', 'drinking water', 'toilets', 'shelter', 'fountain']) {
      expect(isViewpoint(type), type).toBe(false)
    }
  })

  it('is false, not throwing, for empty, null or undefined', () => {
    expect(isViewpoint(null)).toBe(false)
    expect(isViewpoint(undefined)).toBe(false)
    expect(isViewpoint('')).toBe(false)
  })
})

describe('shortLabel', () => {
  it('gives the declared pill word for each known type', () => {
    expect(shortLabel('bench')).toBe('Bench')
    expect(shortLabel('drinking_water')).toBe('Water')
    expect(shortLabel('drinking water')).toBe('Water')
    expect(shortLabel('fountain')).toBe('Water')
    expect(shortLabel('toilets')).toBe('Toilets')
    expect(shortLabel('shelter')).toBe('Shelter')
    expect(shortLabel('viewpoint')).toBe('Viewpoint')
  })

  it('drinking_water and fountain share one pill word, on purpose', () => {
    // Both are a place to get water; the pill vocabulary does not distinguish
    // the OSM tag that recorded it.
    expect(shortLabel('fountain')).toBe(shortLabel('drinking_water'))
  })

  it('gives an unknown type a readable fallback of its own name, not another type\'s label', () => {
    // The header comment is explicit about this: "An unknown type keeps its
    // own name, made readable, rather than being folded into a neighbour it is
    // not." A future amenity type (say `picnic_table`) must not silently show
    // up as "Bench" or "Shelter".
    expect(shortLabel('picnic_table')).toBe('Picnic table')
    expect(shortLabel('waste_basket')).toBe('Waste basket')
  })

  it('does not throw on empty, null or undefined', () => {
    expect(() => shortLabel(null)).not.toThrow()
    expect(() => shortLabel(undefined)).not.toThrow()
    expect(() => shortLabel('')).not.toThrow()
    // normaliseType('') is '', and '' has no SHORT entry, so the fallback path
    // runs on an empty string. It must not crash on charAt(0) of nothing.
    expect(shortLabel('')).toBe('')
  })
})

describe('spokenLabel', () => {
  it('gives the declared mid-sentence phrase for each known type', () => {
    expect(spokenLabel('bench')).toBe('a bench')
    expect(spokenLabel('drinking_water')).toBe('drinking water')
    expect(spokenLabel('drinking water')).toBe('drinking water')
    expect(spokenLabel('fountain')).toBe('drinking water')
    expect(spokenLabel('toilets')).toBe('toilets')
    expect(spokenLabel('shelter')).toBe('shelter')
    expect(spokenLabel('viewpoint')).toBe('a view')
  })

  it('names the thing seen, not the OSM tag, for a viewpoint', () => {
    expect(spokenLabel('viewpoint')).not.toContain('viewpoint')
  })

  it('gives an unknown type a readable fallback rather than throwing', () => {
    expect(spokenLabel('picnic_table')).toBe('picnic table')
  })

  it('does not throw on empty, null or undefined', () => {
    expect(() => spokenLabel(null)).not.toThrow()
    expect(() => spokenLabel(undefined)).not.toThrow()
    expect(() => spokenLabel('')).not.toThrow()
    expect(spokenLabel(null)).toBe('')
  })
})
