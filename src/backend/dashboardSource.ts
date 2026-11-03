import type { DashboardSnapshot } from '@/domain/types'

/**
 * Boundary to the Rust backend. Phase 5 adds an implementation that reads real telemetry
 * through Tauri; until then only the offline source below exists.
 */
export interface DashboardSource {
  getSnapshot(): DashboardSnapshot
}

/**
 * Offline source: no game connection is attempted, so the state is truthfully `disconnected`.
 * The sample values are flagged as `demo` and every feature is reported as unavailable,
 * because no assistance or driving logic exists yet.
 */
export const offlineDemoSource: DashboardSource = {
  getSnapshot: () => ({
    mode: 'demo',
    connection: 'disconnected',
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
    availability: {
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
    },
  }),
}
