import { describe, expect, it } from 'vitest'
import { DEMO_SNAPSHOT, snapshotFromTelemetry } from '@/backend/dashboardSource'
import { emptyData, fullData, update } from '@/test/telemetryFixtures'
import type { ConnectionState } from './types'
import {
  INVALID_FIELD_TARGETS,
  LOCAL_STALE_AFTER_MS,
  invalidVehicleFields,
  link,
  readVehicle,
  valuesCurrent,
} from './vehicle'

const NOW = 1_800_000_000_000

const base = {
  connection: 'connected' as ConnectionState,
  paused: false,
  telemetry: null,
  lastFrameAtUnixMs: null,
}
const at = (receivedAtUnixMs: number) => ({
  ...base,
  telemetry: {
    schemaVersion: 2,
    gameVersion: null,
    sequence: 1,
    receivedAtUnixMs,
    invalidVehicleFields: [],
    invalidJobFields: [],
    invalidNavigationFields: [],
    invalidFields: [],
  },
})

describe('link', () => {
  it.each([
    ['disconnected', 'disconnected'],
    ['connecting', 'connecting'],
    ['reconnecting', 'stale'],
    ['unavailable', 'error'],
    ['error', 'error'],
  ] as const)('maps the backend state %s to %s', (connection, expected) => {
    expect(link({ ...base, connection }, NOW).state).toBe(expected)
  })

  it('is connected while frames are fresh and reports their age', () => {
    const l = link(at(NOW - 250), NOW)
    expect(l).toEqual({ state: 'connected', ageMs: 250, paused: false })
  })

  it('becomes stale on its own when updates stop arriving', () => {
    expect(link(at(NOW - LOCAL_STALE_AFTER_MS), NOW).state).toBe('connected')
    expect(link(at(NOW - LOCAL_STALE_AFTER_MS - 1), NOW).state).toBe('stale')
  })

  it('keeps a paused game connected however old its last frame is', () => {
    const l = link({ ...at(NOW - 60_000), paused: true }, NOW)
    expect(l.state).toBe('connected')
    expect(l.paused).toBe(true)
  })

  it('never reports a negative age when the clock goes backwards', () => {
    expect(link(at(NOW + 5_000), NOW).ageMs).toBe(0)
  })

  it('reports the age of the last frame while interrupted', () => {
    const l = link({ ...base, connection: 'reconnecting', lastFrameAtUnixMs: NOW - 4_000 }, NOW)
    expect(l).toEqual({ state: 'stale', ageMs: 4_000, paused: false })
  })
})

describe('readVehicle', () => {
  it('distinguishes value, missing, invalid and no data', () => {
    const data = emptyData(NOW)
    data.vehicle.speedKmh = 50
    data.source.invalidFields = ['truck.engineRpm']
    const s = snapshotFromTelemetry(update({ status: 'connected', game: 'ets2', data }))
    expect(readVehicle(s, 'speedKmh', true)).toEqual({ kind: 'value', value: 50 })
    expect(readVehicle(s, 'fuelL', true)).toEqual({ kind: 'missing' })
    expect(readVehicle(s, 'engineRpm', true)).toEqual({ kind: 'invalid' })
    expect(readVehicle(s, 'speedKmh', false)).toEqual({ kind: 'noData' })
    const interrupted = snapshotFromTelemetry(update({ status: 'reconnecting', game: 'ets2' }), s)
    expect(readVehicle(interrupted, 'speedKmh', true)).toEqual({ kind: 'noData' })
  })

  it('keeps false and zero as values', () => {
    const data = fullData(NOW)
    Object.assign(data.vehicle, { speedKmh: 0, gear: 0, parkingBrake: false })
    const s = snapshotFromTelemetry(update({ status: 'connected', game: 'ats', data }))
    expect(readVehicle(s, 'speedKmh', true)).toEqual({ kind: 'value', value: 0 })
    expect(readVehicle(s, 'gear', true)).toEqual({ kind: 'value', value: 0 })
    expect(readVehicle(s, 'parkingBrake', true)).toEqual({ kind: 'value', value: false })
  })
})

describe('valuesCurrent', () => {
  it('shows demo values only as demo, and live values only while connected', () => {
    const demo = DEMO_SNAPSHOT
    expect(valuesCurrent(demo, link(demo, NOW))).toBe(true)
    const live = snapshotFromTelemetry(
      update({ status: 'connected', game: 'ets2', data: fullData(NOW) }),
    )
    expect(valuesCurrent(live, link(live, NOW + 100))).toBe(true)
    expect(valuesCurrent(live, link(live, NOW + LOCAL_STALE_AFTER_MS + 1))).toBe(false)
  })
})

describe('invalidVehicleFields', () => {
  it('maps wire paths to vehicle fields and ignores other sections', () => {
    expect(invalidVehicleFields(['truck.cruiseControlMps', 'navigation.distanceM'])).toEqual([
      'targetSpeedKmh',
      'cruiseControl',
    ])
    expect(invalidVehicleFields(['truck.fuelL', 'truckConfig.fuelCapacityL'])).toEqual([
      'fuelL',
      'fuelPercent',
      'fuelCapacityL',
    ])
  })

  it('covers every vehicle path the telemetry reader validates', () => {
    // Wire paths of `roadpilot-telemetry-client` (pinned in src-tauri/Cargo.toml) that feed
    // the vehicle model. Wheel geometry is not shown on the dashboard.
    const validated = [
      'truck.adblueL',
      'truck.batteryVoltageV',
      'truck.brakeAirPressurePsi',
      'truck.brakeTemperatureC',
      'truck.cruiseControlMps',
      'truck.displayedGear',
      'truck.engineRpm',
      'truck.fuelConsumptionLPerKm',
      'truck.fuelL',
      'truck.fuelRangeKm',
      'truck.gear',
      'truck.odometerKm',
      'truck.oilPressurePsi',
      'truck.oilTemperatureC',
      'truck.retarderLevel',
      'truck.speedMps',
      'truck.waterTemperatureC',
      'truckConfig.adblueCapacityL',
      'truckConfig.brand',
      'truckConfig.forwardGears',
      'truckConfig.fuelCapacityL',
      'truckConfig.name',
      'truckConfig.retarderSteps',
      'truckConfig.reverseGears',
      'truckConfig.rpmLimit',
    ]
    expect(Object.keys(INVALID_FIELD_TARGETS).sort()).toEqual(validated)
  })
})
