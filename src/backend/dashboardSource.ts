import type { TelemetryData, TelemetryUpdate } from '@/domain/telemetry'
import type { DashboardSnapshot, JobData } from '@/domain/types'

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
  vehicle: {
    speedKmh: 80,
    targetSpeedKmh: 80,
    engineRpm: 1420,
    gear: 12,
    cruiseControl: true,
    engineRunning: true,
    fuelL: 412,
    fuelRangeKm: null,
    fuelPercent: 52,
    waterTemperatureC: 88,
    adblueL: null,
    oilTemperatureC: null,
    batteryVoltageV: null,
    parkingBrake: null,
    retarderLevel: null,
  },
  job: {
    state: 'active',
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
    revenue: null,
  },
  dynamics: {
    accelerationMs2: 0.2,
    throttle: 0.35,
    brake: 0,
    steering: -0.05,
    cruiseControl: true,
    cruiseControlKmh: 80,
  },
  navigation: { distanceKm: 742, etaMinutes: 552, speedLimitKmh: 80, speedLimitShown: true },
  environment: { gameClock: '09:20', weather: null, rain: null },
  position: null,
  availability: AVAILABILITY,
}

/** Live view of one telemetry frame. Missing values stay `null`; nothing is filled in. */
function liveSnapshot(update: TelemetryUpdate, data: TelemetryData): DashboardSnapshot {
  const { vehicle: v, dynamics: d, job: j, navigation: n, environment: e } = data
  const jobKnown = j.state !== 'unknown' && j.state !== 'none'
  return {
    mode: 'live',
    connection: update.status,
    game: update.game,
    paused: update.paused,
    autopilotActive: false,
    vehicle: {
      speedKmh: v.speedKmh,
      targetSpeedKmh: v.cruiseControlKmh,
      engineRpm: v.engineRpm,
      gear: v.gear,
      cruiseControl: v.cruiseControlOn,
      engineRunning: v.engineRunning,
      fuelL: v.fuelL,
      fuelRangeKm: v.fuelRangeKm,
      fuelPercent: v.fuelPercent,
      waterTemperatureC: v.waterTemperatureC,
      adblueL: v.adblueL,
      oilTemperatureC: v.oilTemperatureC,
      batteryVoltageV: v.batteryVoltageV,
      parkingBrake: v.parkingBrake,
      retarderLevel: v.retarderLevel,
    },
    job: jobKnown
      ? {
          state: j.state,
          cargo: j.cargo,
          weightKg: j.cargoMassKg,
          income: j.income,
          currency: j.currency,
          origin: j.sourceCity,
          destination: j.destinationCity,
          deadline: j.deadline,
          // Route Advisor values describe the current route, which is the job route
          // only while a job is active.
          remainingKm: j.state === 'active' ? n.distanceKm : null,
          remainingMinutes: j.state === 'active' ? n.etaMin : null,
          progressPercent: j.progressPercent,
          revenue: j.deliveredRevenue,
        }
      : j.state === 'none'
        ? { ...EMPTY_JOB, state: 'none' }
        : null,
    dynamics: {
      accelerationMs2: d.longitudinalAccelerationMs2,
      throttle: d.throttleInput,
      brake: d.brakeInput,
      steering: d.steeringInput,
      cruiseControl: v.cruiseControlOn,
      cruiseControlKmh: v.cruiseControlKmh,
    },
    navigation: {
      distanceKm: n.distanceKm,
      etaMinutes: n.etaMin,
      speedLimitKmh: n.speedLimitKmh,
      speedLimitShown: n.speedLimitShown,
    },
    environment: { gameClock: e.gameClock, weather: null, rain: null },
    position: data.position,
    availability: AVAILABILITY,
  }
}

const EMPTY_JOB: JobData = {
  state: 'none',
  cargo: null,
  weightKg: null,
  income: null,
  currency: null,
  origin: null,
  destination: null,
  deadline: null,
  remainingKm: null,
  remainingMinutes: null,
  progressPercent: null,
  revenue: null,
}

/**
 * Maps a telemetry update to what the dashboard shows. Live and demo values are never mixed:
 * - connected: live values; anything the telemetry does not provide is `null`.
 * - reconnecting: live mode without values, so stale data is never shown as current.
 * - everything else: demo data, labelled as such, with the real connection state.
 */
export function snapshotFromTelemetry(update: TelemetryUpdate | null): DashboardSnapshot {
  if (!update) return DEMO_SNAPSHOT
  if (update.status === 'connected' && update.data) return liveSnapshot(update, update.data)

  const base = { connection: update.status, game: update.game, paused: update.paused }
  if (update.status === 'reconnecting') {
    return {
      ...base,
      mode: 'live',
      autopilotActive: false,
      vehicle: null,
      job: null,
      dynamics: null,
      navigation: null,
      environment: null,
      position: null,
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
