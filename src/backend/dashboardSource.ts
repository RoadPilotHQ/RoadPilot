import type { DashboardSnapshot, TelemetryUpdate } from '@/domain/types'

/**
 * Boundary between the UI and the data producers. Compatible with React's
 * `useSyncExternalStore`: `getSnapshot` must return the same object until it changes.
 */
export interface DashboardSource {
  getSnapshot(): DashboardSnapshot
  subscribe(listener: () => void): () => void
}

/** No driving or assistance logic exists yet, so every feature is reported as unavailable. */
const AVAILABILITY: DashboardSnapshot['availability'] = {
  autopilot: {
    laneKeeping: 'unavailable',
    speedControl: 'unavailable',
    trafficAwareness: 'unavailable',
  },
  assistance: {
    laneDepartureWarning: 'unavailable',
    collisionWarning: 'unavailable',
    trafficSignRecognition: 'unavailable',
    adaptiveCruiseControl: 'unavailable',
    driverAssistance: 'unavailable',
    autoBraking: 'unavailable',
  },
}

/** Clearly labelled sample data shown whenever no live telemetry is available. */
export const DEMO_SNAPSHOT: DashboardSnapshot = {
  mode: 'demo',
  connection: 'disconnected',
  game: null,
  paused: false,
  autopilotActive: false,
  vehicle: { speedKmh: 80, targetSpeedKmh: 80, engineRpm: 1420, gear: 12, cruiseControl: true },
  job: {
    cargo: 'Electronics',
    weightKg: 12400,
    income: 24360,
    currency: 'EUR',
    origin: 'Hamburg',
    destination: 'Praha',
    deadline: { dayOffset: 1, time: '14:32' },
    remainingKm: 742,
    remainingMinutes: 552,
    progressPercent: 48,
  },
  availability: AVAILABILITY,
}

/**
 * Maps a telemetry update to what the dashboard shows. Live and demo values are never mixed:
 * - connected: live values; anything the telemetry does not provide is `null`.
 * - reconnecting: live mode without values, so stale data is never shown as current.
 * - everything else: demo data, labelled as such, with the real connection state.
 */
export function snapshotFromTelemetry(update: TelemetryUpdate | null): DashboardSnapshot {
  if (!update) return DEMO_SNAPSHOT
  const base = { connection: update.status, game: update.game, paused: update.paused }

  if (update.status === 'connected' && update.vehicle) {
    const v = update.vehicle
    return {
      ...base,
      mode: 'live',
      autopilotActive: false,
      vehicle: {
        speedKmh: v.speedKmh,
        targetSpeedKmh: null,
        engineRpm: v.engineRpm,
        gear: v.gear,
        cruiseControl: null,
      },
      job: null,
      availability: AVAILABILITY,
    }
  }
  if (update.status === 'reconnecting') {
    return {
      ...base,
      mode: 'live',
      autopilotActive: false,
      vehicle: null,
      job: null,
      availability: AVAILABILITY,
    }
  }
  return { ...DEMO_SNAPSHOT, ...base, paused: false }
}

/** Static demo source for browsers and tests (no Tauri backend). */
export const offlineDemoSource: DashboardSource = {
  getSnapshot: () => DEMO_SNAPSHOT,
  subscribe: () => () => {},
}
