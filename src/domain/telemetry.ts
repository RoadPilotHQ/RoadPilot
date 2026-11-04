/**
 * Wire contract of the `telemetry:update` event and the `telemetry_snapshot` command.
 * Mirrors `src-tauri/src/telemetry/model.rs`; see docs/telemetry.md for units and sources.
 * `null` always means "not provided by the game", never zero.
 */
import type { ConnectionState, GameId } from './types'

export interface TelemetryUpdate {
  status: ConnectionState
  game: GameId | null
  paused: boolean
  /** Present only while connected; never stale. */
  data: TelemetryData | null
  error: string | null
}

export interface TelemetryData {
  source: {
    /** 1 = speed, RPM and gear only. */
    schemaVersion: number
    gameVersion: string | null
    sequence: number
    simulationTimeUs: number | null
    receivedAtUnixMs: number
    invalidFields: string[]
  }
  vehicle: {
    speedKmh: number | null
    engineRpm: number | null
    gear: number | null
    displayedGear: number | null
    engineRunning: boolean | null
    electricOn: boolean | null
    fuelL: number | null
    fuelCapacityL: number | null
    fuelPercent: number | null
    fuelRangeKm: number | null
    fuelConsumptionLPer100km: number | null
    fuelWarning: boolean | null
    adblueL: number | null
    adblueCapacityL: number | null
    oilTemperatureC: number | null
    waterTemperatureC: number | null
    batteryVoltageV: number | null
    parkingBrake: boolean | null
    engineBrake: boolean | null
    retarderLevel: number | null
    retarderSteps: number | null
    cruiseControlOn: boolean | null
    cruiseControlKmh: number | null
    brand: string | null
    model: string | null
  }
  dynamics: {
    longitudinalVelocityMs: number | null
    lateralVelocityMs: number | null
    verticalVelocityMs: number | null
    longitudinalAccelerationMs2: number | null
    lateralAccelerationMs2: number | null
    verticalAccelerationMs2: number | null
    yawRateDegS: number | null
    steeringInput: number | null
    throttleInput: number | null
    brakeInput: number | null
    clutchInput: number | null
    steeringEffective: number | null
    throttleEffective: number | null
    brakeEffective: number | null
    clutchEffective: number | null
    wheelSteeringAngleDeg: number | null
  }
  /** World space: X east, Y up, Z south (m); heading counterclockwise from north. */
  position: {
    x: number
    y: number
    z: number
    headingDeg: number
    pitchDeg: number
    rollDeg: number
  } | null
  job: {
    state: 'unknown' | 'none' | 'active' | 'delivered' | 'cancelled'
    cargo: string | null
    cargoMassKg: number | null
    cargoDamagePercent: number | null
    sourceCity: string | null
    sourceCompany: string | null
    destinationCity: string | null
    destinationCompany: string | null
    income: number | null
    currency: string | null
    deadline: { dayOffset: number; time: string } | null
    timeToDeadlineMin: number | null
    plannedDistanceKm: number | null
    progressPercent: number | null
    deliveredRevenue: number | null
    cancelPenalty: number | null
  }
  navigation: {
    distanceKm: number | null
    etaMin: number | null
    speedLimitKmh: number | null
    speedLimitShown: boolean | null
  }
  environment: {
    gameTimeMin: number | null
    gameClock: string | null
    timeScale: number | null
  }
}
