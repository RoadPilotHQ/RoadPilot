/**
 * How the vehicle data dashboard reads values and the telemetry link. Pure functions: time is
 * passed in, so every state is testable without a clock or a game.
 */
import type { ConnectionState, DashboardSnapshot, VehicleData, VehicleField } from './types'

/**
 * One displayed value:
 * - `value`: current and valid.
 * - `missing`: supported by RoadPilot, but this game, plugin or frame did not provide it.
 * - `invalid`: provided, but rejected as invalid (non-finite or implausible).
 * - `noData`: there is no current telemetry at all (not connected, interrupted or stale).
 */
export type Reading<T> =
  { kind: 'value'; value: T } | { kind: 'missing' } | { kind: 'invalid' } | { kind: 'noData' }

/** The five link states the dashboard distinguishes. */
export type LinkState = 'disconnected' | 'connecting' | 'connected' | 'stale' | 'error'

/**
 * The backend clears values 2 s after the last frame (`reconnecting`). If even that update
 * does not arrive, the dashboard stops trusting the values itself after this age.
 */
export const LOCAL_STALE_AFTER_MS = 3000

export interface Link {
  state: LinkState
  /** Age of the newest frame of this session, if one is known. */
  ageMs: number | null
  paused: boolean
}

const BACKEND_TO_LINK: Record<ConnectionState, LinkState> = {
  disconnected: 'disconnected',
  connecting: 'connecting',
  connected: 'connected',
  // Telemetry was live, frames stopped while the game still runs.
  reconnecting: 'stale',
  // The game runs, but no telemetry arrives (plugin missing), or the pipe failed.
  unavailable: 'error',
  error: 'error',
}

export function link(
  snapshot: Pick<DashboardSnapshot, 'connection' | 'paused' | 'telemetry' | 'lastFrameAtUnixMs'>,
  nowUnixMs: number,
): Link {
  const frameAt = snapshot.telemetry?.receivedAtUnixMs ?? snapshot.lastFrameAtUnixMs
  // A clock that went backwards must not produce a negative age.
  const ageMs = frameAt == null ? null : Math.max(0, nowUnixMs - frameAt)
  let state = BACKEND_TO_LINK[snapshot.connection]
  // A paused game may stop sending frames; its last values remain current.
  if (state === 'connected' && !snapshot.paused && ageMs != null && ageMs > LOCAL_STALE_AFTER_MS) {
    state = 'stale'
  }
  return { state, ageMs, paused: snapshot.connection === 'connected' && snapshot.paused }
}

/** Whether vehicle values may be shown as current: live and connected, or labelled demo data. */
export function valuesCurrent(snapshot: DashboardSnapshot, current: Link): boolean {
  if (!snapshot.vehicle) return false
  return snapshot.mode === 'demo' || current.state === 'connected'
}

export function readVehicle<K extends VehicleField>(
  snapshot: DashboardSnapshot,
  field: K,
  current: boolean,
): Reading<NonNullable<VehicleData[K]>> {
  const vehicle = snapshot.vehicle
  if (!vehicle || !current) return { kind: 'noData' }
  if (snapshot.telemetry?.invalidVehicleFields.includes(field)) return { kind: 'invalid' }
  const value = vehicle[field]
  return value == null ? { kind: 'missing' } : { kind: 'value', value }
}

/**
 * Telemetry wire paths (as reported in `invalidFields`) and the vehicle values they feed.
 * Calculated values depend on every input.
 */
export const INVALID_FIELD_TARGETS: Readonly<Record<string, readonly VehicleField[]>> = {
  'truck.speedMps': ['speedKmh'],
  'truck.engineRpm': ['engineRpm'],
  'truck.gear': ['gear'],
  'truck.displayedGear': ['displayedGear'],
  'truck.fuelL': ['fuelL', 'fuelPercent'],
  'truck.fuelRangeKm': ['fuelRangeKm'],
  'truck.fuelConsumptionLPerKm': ['fuelConsumptionLPer100km'],
  'truck.adblueL': ['adblueL'],
  'truck.oilTemperatureC': ['oilTemperatureC'],
  'truck.waterTemperatureC': ['waterTemperatureC'],
  'truck.oilPressurePsi': ['oilPressurePsi'],
  'truck.batteryVoltageV': ['batteryVoltageV'],
  'truck.brakeAirPressurePsi': ['brakeAirPressurePsi'],
  'truck.brakeTemperatureC': ['brakeTemperatureC'],
  'truck.retarderLevel': ['retarderLevel'],
  'truck.cruiseControlMps': ['targetSpeedKmh', 'cruiseControl'],
  'truck.odometerKm': ['odometerKm'],
  'truckConfig.fuelCapacityL': ['fuelCapacityL', 'fuelPercent'],
  'truckConfig.adblueCapacityL': ['adblueCapacityL'],
  'truckConfig.rpmLimit': ['rpmLimit'],
  'truckConfig.forwardGears': ['forwardGears'],
  'truckConfig.reverseGears': ['reverseGears'],
  'truckConfig.retarderSteps': ['retarderSteps'],
  'truckConfig.brand': ['brand'],
  'truckConfig.name': ['model'],
}

export function invalidVehicleFields(wirePaths: readonly string[]): VehicleField[] {
  const fields = new Set<VehicleField>()
  for (const path of wirePaths) INVALID_FIELD_TARGETS[path]?.forEach((f) => fields.add(f))
  return [...fields]
}

/**
 * Vehicle data the dashboard was asked for that the RoadPilot telemetry protocol does not
 * carry at all. Shown as "Not provided by the telemetry", never as a value.
 */
export const UNSUPPORTED_VEHICLE_DATA = [
  'engineLoad',
  'transmissionMode',
  'lights',
  'brakeLights',
] as const
export type UnsupportedVehicleData = (typeof UNSUPPORTED_VEHICLE_DATA)[number]
