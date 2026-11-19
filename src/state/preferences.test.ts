import { describe, expect, it } from 'vitest'
import { DEFAULT_PREFERENCES } from '@/domain/types'
import { PREFERENCES_KEY, loadPreferences, parsePreferences, savePreferences } from './preferences'

describe('preferences', () => {
  it('returns defaults when nothing is stored', () => {
    expect(loadPreferences()).toEqual(DEFAULT_PREFERENCES)
  })

  it('round-trips saved preferences', () => {
    const prefs = {
      ...DEFAULT_PREFERENCES,
      drivingDistance: 'long' as const,
      autopilot: { ...DEFAULT_PREFERENCES.autopilot, laneKeeping: false },
    }
    savePreferences(prefs)
    expect(loadPreferences()).toEqual(prefs)
  })

  it('ignores invalid values and corrupt JSON', () => {
    expect(
      parsePreferences({ drivingDistance: 'huge', autopilot: { laneKeeping: 'yes' } }),
    ).toEqual(DEFAULT_PREFERENCES)
    localStorage.setItem(PREFERENCES_KEY, '{not json')
    expect(loadPreferences()).toEqual(DEFAULT_PREFERENCES)
  })

  it('stores the unit choice and defaults to following the game', () => {
    expect(DEFAULT_PREFERENCES.units).toBe('auto')
    expect(parsePreferences({ units: 'imperial' }).units).toBe('imperial')
    expect(parsePreferences({ units: 'parsecs' }).units).toBe('auto')
    // Preferences saved before the unit choice existed still load.
    expect(parsePreferences({ drivingDistance: 'long' })).toEqual({
      ...DEFAULT_PREFERENCES,
      drivingDistance: 'long',
    })
  })
})
