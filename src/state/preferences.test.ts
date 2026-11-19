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

  it('stores a package folder per game and ignores anything else', () => {
    expect(DEFAULT_PREFERENCES.mapPackages).toEqual({ ets2: null, ats: null })
    const p = parsePreferences({
      mapGame: 'ats',
      mapPackages: { ets2: 'D:/Maps/ets2', ats: 42, ets3: 'x' },
    })
    expect(p.mapPackages).toEqual({ ets2: 'D:/Maps/ets2', ats: null })
    expect(p.mapGame).toBe('ats')
    expect(parsePreferences({ mapGame: 'ets3', mapPackages: 'D:' }).mapPackages).toEqual({
      ets2: null,
      ats: null,
    })
    expect(parsePreferences({ mapPackages: { ats: '   ' } }).mapPackages.ats).toBeNull()
  })
})
