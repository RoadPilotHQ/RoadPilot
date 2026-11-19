import type { TelemetryData, TelemetryUpdate } from '@/domain/telemetry'
import type { DashboardSnapshot, JobData, VehicleData, VehicleField } from '@/domain/types'
import { invalidVehicleFields } from '@/domain/vehicle'

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

/**
 * Clearly labelled sample data shown whenever no live telemetry is available. The UI marks
 * it as demo data wherever it appears; it is never mixed with live values.
 */
export const DEMO_SNAPSHOT: DashboardSnapshot = {
  mode: 'demo',
  connection: 'disconnected',
  game: null,
  paused: false,
  telemetry: null,
  lastFrameAtUnixMs: null,
  error: null,
  autopilotActive: false,
  vehicle: {
    brand: null,
    model: null,
    speedKmh: 80,
    targetSpeedKmh: 80,
    engineRpm: 1420,
    rpmLimit: 2500,
    gear: 12,
    displayedGear: 12,
    forwardGears: 12,
    reverseGears: 2,
    cruiseControl: true,
    engineRunning: true,
    electricOn: true,
    fuelL: 412,
    fuelCapacityL: 800,
    fuelPercent: 52,
    fuelRangeKm: 1180,
    fuelConsumptionLPer100km: 34.5,
    fuelWarning: false,
    adblueL: 61,
    adblueCapacityL: 80,
    waterTemperatureC: 88,
    oilTemperatureC: 96,
    oilPressurePsi: 55,
    batteryVoltageV: 26.4,
    odometerKm: 184_250,
    parkingBrake: false,
    engineBrake: false,
    retarderLevel: 0,
    retarderSteps: 3,
    brakeAirPressurePsi: 120,
    brakeTemperatureC: 42,
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

/**
 * Vehicle values of one frame. The telemetry reader already removed invalid values; this is
 * a second line of defence at the UI boundary: a value of the wrong type, a non-finite number,
 * a fractional gear or a percentage outside 0–100 is reported as invalid, never shown.
 */
function vehicleValues(v: TelemetryData['vehicle'], invalid: Set<VehicleField>): VehicleData {
  const reject = (field: VehicleField) => {
    invalid.add(field)
    return null
  }
  const num = (field: VehicleField, value: unknown, ok: (n: number) => boolean = () => true) =>
    value == null
      ? null
      : typeof value === 'number' && Number.isFinite(value) && ok(value)
        ? value
        : reject(field)
  const nonNegative = (n: number) => n >= 0
  const count = (n: number) => Number.isInteger(n) && n >= 0
  const flag = (field: VehicleField, value: unknown) =>
    value == null ? null : typeof value === 'boolean' ? value : reject(field)
  const text = (field: VehicleField, value: unknown) =>
    value == null ? null : typeof value === 'string' ? value : reject(field)
  return {
    brand: text('brand', v.brand),
    model: text('model', v.model),
    speedKmh: num('speedKmh', v.speedKmh),
    targetSpeedKmh: num('targetSpeedKmh', v.cruiseControlKmh, nonNegative),
    engineRpm: num('engineRpm', v.engineRpm, nonNegative),
    rpmLimit: num('rpmLimit', v.rpmLimit, (n) => n > 0),
    gear: num('gear', v.gear, Number.isInteger),
    displayedGear: num('displayedGear', v.displayedGear, Number.isInteger),
    forwardGears: num('forwardGears', v.forwardGears, count),
    reverseGears: num('reverseGears', v.reverseGears, count),
    cruiseControl: flag('cruiseControl', v.cruiseControlOn),
    engineRunning: flag('engineRunning', v.engineRunning),
    electricOn: flag('electricOn', v.electricOn),
    fuelL: num('fuelL', v.fuelL, nonNegative),
    fuelCapacityL: num('fuelCapacityL', v.fuelCapacityL, (n) => n > 0),
    fuelPercent: num('fuelPercent', v.fuelPercent, (n) => n >= 0 && n <= 100),
    fuelRangeKm: num('fuelRangeKm', v.fuelRangeKm, nonNegative),
    fuelConsumptionLPer100km: num(
      'fuelConsumptionLPer100km',
      v.fuelConsumptionLPer100km,
      nonNegative,
    ),
    fuelWarning: flag('fuelWarning', v.fuelWarning),
    adblueL: num('adblueL', v.adblueL, nonNegative),
    adblueCapacityL: num('adblueCapacityL', v.adblueCapacityL, (n) => n > 0),
    waterTemperatureC: num('waterTemperatureC', v.waterTemperatureC),
    oilTemperatureC: num('oilTemperatureC', v.oilTemperatureC),
    oilPressurePsi: num('oilPressurePsi', v.oilPressurePsi, nonNegative),
    batteryVoltageV: num('batteryVoltageV', v.batteryVoltageV, nonNegative),
    odometerKm: num('odometerKm', v.odometerKm, nonNegative),
    parkingBrake: flag('parkingBrake', v.parkingBrake),
    engineBrake: flag('engineBrake', v.engineBrake),
    retarderLevel: num('retarderLevel', v.retarderLevel, count),
    retarderSteps: num('retarderSteps', v.retarderSteps, count),
    brakeAirPressurePsi: num('brakeAirPressurePsi', v.brakeAirPressurePsi, nonNegative),
    brakeTemperatureC: num('brakeTemperatureC', v.brakeTemperatureC),
  }
}

/** Live view of one telemetry frame. Missing values stay `null`; nothing is filled in. */
function liveSnapshot(update: TelemetryUpdate, data: TelemetryData): DashboardSnapshot {
  const { vehicle: v, dynamics: d, job: j, navigation: n, environment: e, source } = data
  const jobKnown = j.state !== 'unknown' && j.state !== 'none'
  const invalid = new Set(invalidVehicleFields(source.invalidFields))
  const vehicle = vehicleValues(v, invalid)
  return {
    mode: 'live',
    connection: update.status,
    game: update.game,
    paused: update.paused,
    telemetry: {
      schemaVersion: source.schemaVersion,
      gameVersion: source.gameVersion,
      sequence: source.sequence,
      receivedAtUnixMs: source.receivedAtUnixMs,
      invalidVehicleFields: [...invalid],
      invalidFields: source.invalidFields,
    },
    lastFrameAtUnixMs: source.receivedAtUnixMs,
    error: null,
    autopilotActive: false,
    vehicle,
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
 * - reconnecting: live mode without values, so stale data is never shown as current. The
 *   receive time of the session's last frame (from `previous`) is kept to show its age.
 * - everything else: demo data, labelled as such, with the real connection state.
 */
export function snapshotFromTelemetry(
  update: TelemetryUpdate | null,
  previous: DashboardSnapshot | null = null,
): DashboardSnapshot {
  if (!update) return DEMO_SNAPSHOT
  if (update.status === 'connected' && update.data) return liveSnapshot(update, update.data)

  const base = {
    connection: update.status,
    game: update.game,
    paused: update.paused,
    telemetry: null,
    error: update.error,
  }
  if (update.status === 'reconnecting') {
    const sameSession = previous?.mode === 'live' && previous.game === update.game
    return {
      ...base,
      lastFrameAtUnixMs: sameSession ? previous.lastFrameAtUnixMs : null,
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
  return { ...DEMO_SNAPSHOT, ...base, paused: false, lastFrameAtUnixMs: null }
}

/** Static demo source for browsers and tests (no Tauri backend). */
export const offlineDemoSource: DashboardSource = {
  getSnapshot: () => DEMO_SNAPSHOT,
  subscribe: () => () => {},
}
