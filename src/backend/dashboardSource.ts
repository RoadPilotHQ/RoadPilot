import type { TelemetryData, TelemetryUpdate } from '@/domain/telemetry'
import { invalidJobFields } from '@/domain/job'
import { invalidNavigationFields } from '@/domain/route'
import { boundaryChecks, count, nonNegative } from '@/domain/reading'
import type {
  DashboardSnapshot,
  DeadlineValue,
  JobData,
  JobField,
  NavigationData,
  NavigationField,
  VehicleData,
  VehicleField,
} from '@/domain/types'
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
    cargoMassKg: 12400,
    cargoDamagePercent: 0.8,
    cargoLoaded: true,
    jobMarket: 'freight_market',
    sourceCity: 'Hamburg',
    sourceCompany: 'Port terminal',
    destinationCity: 'Praha',
    destinationCompany: 'Distribution centre',
    income: 24360,
    currency: 'EUR',
    deadline: { dayOffset: 1, time: '14:32' },
    timeToDeadlineMin: 1752,
    plannedDistanceKm: 1427,
    progressPercent: 48,
    deliveredRevenue: null,
    cancelPenalty: null,
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
  const { num, flag, text } = boundaryChecks(invalid)
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
  const invalid = new Set(invalidVehicleFields(source.invalidFields))
  const vehicle = vehicleValues(v, invalid)
  const invalidJob = new Set(invalidJobFields(source.invalidFields))
  const job = jobValues(j, invalidJob)
  const invalidNavigation = new Set(invalidNavigationFields(source.invalidFields))
  const navigation = navigationValues(n, invalidNavigation)
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
      invalidJobFields: [...invalidJob],
      invalidNavigationFields: [...invalidNavigation],
      invalidFields: source.invalidFields,
    },
    lastFrameAtUnixMs: source.receivedAtUnixMs,
    error: null,
    autopilotActive: false,
    vehicle,
    job,
    dynamics: {
      accelerationMs2: d.longitudinalAccelerationMs2,
      throttle: d.throttleInput,
      brake: d.brakeInput,
      steering: d.steeringInput,
      cruiseControl: v.cruiseControlOn,
      cruiseControlKmh: v.cruiseControlKmh,
    },
    navigation,
    environment: { gameClock: e.gameClock, weather: null, rain: null },
    position: data.position,
    availability: AVAILABILITY,
  }
}

const EMPTY_JOB: JobData = {
  state: 'none',
  cargo: null,
  cargoMassKg: null,
  cargoDamagePercent: null,
  cargoLoaded: null,
  jobMarket: null,
  sourceCity: null,
  sourceCompany: null,
  destinationCity: null,
  destinationCompany: null,
  income: null,
  currency: null,
  deadline: null,
  timeToDeadlineMin: null,
  plannedDistanceKm: null,
  progressPercent: null,
  deliveredRevenue: null,
  cancelPenalty: null,
}

/**
 * Route Advisor values of one frame, checked like the vehicle values. A speed limit needs
 * its "shown" flag: a limit without it, or a limit while none is shown, is invalid.
 */
function navigationValues(
  n: TelemetryData['navigation'],
  invalid: Set<NavigationField>,
): NavigationData {
  const { num, flag, reject } = boundaryChecks(invalid)
  const shown = flag('speedLimitShown', n.speedLimitShown)
  let limit = num('speedLimitKmh', n.speedLimitKmh, (v) => v > 0)
  if (limit != null && shown !== true) limit = reject('speedLimitKmh')
  return {
    distanceKm: num('distanceKm', n.distanceKm, nonNegative),
    etaMinutes: num('etaMinutes', n.etaMin, nonNegative),
    speedLimitKmh: limit,
    speedLimitShown: shown,
  }
}

const isDeadline = (d: unknown): d is DeadlineValue =>
  typeof d === 'object' &&
  d !== null &&
  Number.isInteger((d as DeadlineValue).dayOffset) &&
  typeof (d as DeadlineValue).time === 'string' &&
  /^\d{2}:\d{2}$/.test((d as DeadlineValue).time)

/**
 * Job values of one frame, checked like the vehicle values. `null` when the telemetry has no
 * job information (`unknown`): nothing is shown as a job then. Without an active job the
 * game's job fields are not shown either.
 */
function jobValues(j: TelemetryData['job'], invalid: Set<JobField>): JobData | null {
  if (j.state === 'unknown') return null
  if (j.state === 'none') return EMPTY_JOB
  const { num, flag, text, reject } = boundaryChecks(invalid)
  const amount = (field: JobField, value: unknown) => num(field, value, Number.isInteger)
  return {
    state: j.state,
    cargo: text('cargo', j.cargo),
    cargoMassKg: num('cargoMassKg', j.cargoMassKg, nonNegative),
    cargoDamagePercent: num('cargoDamagePercent', j.cargoDamagePercent, (p) => p >= 0 && p <= 100),
    cargoLoaded: flag('cargoLoaded', j.cargoLoaded),
    jobMarket: text('jobMarket', j.jobMarket),
    sourceCity: text('sourceCity', j.sourceCity),
    sourceCompany: text('sourceCompany', j.sourceCompany),
    destinationCity: text('destinationCity', j.destinationCity),
    destinationCompany: text('destinationCompany', j.destinationCompany),
    income: num('income', j.income, count),
    currency: text('currency', j.currency),
    deadline: j.deadline == null ? null : isDeadline(j.deadline) ? j.deadline : reject('deadline'),
    timeToDeadlineMin: num('timeToDeadlineMin', j.timeToDeadlineMin, Number.isInteger),
    plannedDistanceKm: num('plannedDistanceKm', j.plannedDistanceKm, nonNegative),
    progressPercent: num('progressPercent', j.progressPercent, (p) => p >= 0 && p <= 100),
    deliveredRevenue: amount('deliveredRevenue', j.deliveredRevenue),
    cancelPenalty: amount('cancelPenalty', j.cancelPenalty),
  }
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
