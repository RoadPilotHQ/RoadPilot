/**
 * How the vehicle data dashboard reads values and the telemetry link. Pure functions: time is
 * passed in, so every state is testable without a clock or a game.
 */
import { fieldsFromPaths, read, type Reading } from './reading'
import type { ConnectionState, DashboardSnapshot, VehicleData, VehicleField } from './types'

export type { Reading } from './reading'

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

/**
 * Whether the snapshot's values may be shown as current: live and connected (also while
 * paused), or labelled demo data. Stale, interrupted or failed links have no current values.
 */
export function dataCurrent(snapshot: Pick<DashboardSnapshot, 'mode'>, current: Link): boolean {
  return snapshot.mode === 'demo' || current.state === 'connected'
}

/** Whether vehicle values may be shown as current. */
export function valuesCurrent(snapshot: DashboardSnapshot, current: Link): boolean {
  return snapshot.vehicle !== null && dataCurrent(snapshot, current)
}

export function readVehicle<K extends VehicleField>(
  snapshot: DashboardSnapshot,
  field: K,
  current: boolean,
): Reading<NonNullable<VehicleData[K]>> {
  return read(snapshot.vehicle?.[field], {
    current: current && snapshot.vehicle !== null,
    invalid: snapshot.telemetry?.invalidVehicleFields.includes(field) ?? false,
  })
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
  return fieldsFromPaths(INVALID_FIELD_TARGETS, wirePaths)
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
