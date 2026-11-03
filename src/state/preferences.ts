import {
  ASSISTANCE_SYSTEMS,
  AUTOPILOT_FEATURES,
  DEFAULT_PREFERENCES,
  type DrivingDistance,
  type Preferences,
} from '@/domain/types'

export const PREFERENCES_KEY = 'roadpilot.preferences.v1'
const DISTANCES: readonly DrivingDistance[] = ['short', 'medium', 'long']

function pickBooleans<K extends string>(
  keys: readonly K[],
  source: unknown,
  fallback: Record<K, boolean>,
): Record<K, boolean> {
  const src = (typeof source === 'object' && source !== null ? source : {}) as Record<
    string,
    unknown
  >
  const out = { ...fallback }
  for (const key of keys) {
    const value = src[key]
    if (typeof value === 'boolean') out[key] = value
  }
  return out
}

/** Validates untrusted stored data; unknown or invalid fields fall back to defaults. */
export function parsePreferences(raw: unknown): Preferences {
  const obj = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>
  const distance = DISTANCES.find((d) => d === obj.drivingDistance)
  return {
    autopilot: pickBooleans(AUTOPILOT_FEATURES, obj.autopilot, DEFAULT_PREFERENCES.autopilot),
    assistance: pickBooleans(ASSISTANCE_SYSTEMS, obj.assistance, DEFAULT_PREFERENCES.assistance),
    drivingDistance: distance ?? DEFAULT_PREFERENCES.drivingDistance,
  }
}

export function loadPreferences(storage: Storage = localStorage): Preferences {
  try {
    const text = storage.getItem(PREFERENCES_KEY)
    return parsePreferences(text ? JSON.parse(text) : null)
  } catch {
    return DEFAULT_PREFERENCES
  }
}

export function savePreferences(prefs: Preferences, storage: Storage = localStorage): void {
  try {
    storage.setItem(PREFERENCES_KEY, JSON.stringify(prefs))
  } catch {
    // Persistence is best-effort; the UI keeps working with in-memory state.
  }
}
