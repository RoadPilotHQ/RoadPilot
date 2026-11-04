import { describe, expect, it, vi } from 'vitest'
import type { TelemetryUpdate } from '@/domain/telemetry'
import { emptyData, fullData, update } from '@/test/telemetryFixtures'
import { DEMO_SNAPSHOT, snapshotFromTelemetry } from './dashboardSource'
import { createTelemetrySource, TELEMETRY_EVENT, type TelemetryBridge } from './telemetrySource'

const connected = update({ status: 'connected', game: 'ets2', data: fullData() })

const status = (s: TelemetryUpdate['status'], game: TelemetryUpdate['game'] = 'ets2') =>
  update({ status: s, game })

describe('snapshotFromTelemetry', () => {
  it('uses demo data until the backend reports anything', () => {
    expect(snapshotFromTelemetry(null)).toBe(DEMO_SNAPSHOT)
  })

  it('maps a connected update to live data in every section', () => {
    const s = snapshotFromTelemetry(connected)
    expect(s.mode).toBe('live')
    expect(s.connection).toBe('connected')
    expect(s.game).toBe('ets2')
    expect(s.vehicle).toEqual({
      speedKmh: 83.4,
      targetSpeedKmh: 80,
      engineRpm: 1350.4,
      gear: 11,
      cruiseControl: true,
      engineRunning: true,
      fuelL: 412.5,
      fuelPercent: 51.6,
      waterTemperatureC: 88,
    })
    expect(s.dynamics).toEqual({
      accelerationMs2: -1.26,
      throttle: 0.4,
      brake: 0.25,
      steering: -0.12,
      cruiseControl: true,
      cruiseControlKmh: 80,
    })
    expect(s.job).toMatchObject({
      state: 'active',
      cargo: 'Machinery',
      origin: 'Berlin',
      destination: 'Wien',
      weightKg: 18000,
      income: 31000,
      currency: 'EUR',
      remainingKm: 510,
      remainingMinutes: 400,
      progressPercent: 25,
    })
    expect(s.navigation).toEqual({
      distanceKm: 510,
      etaMinutes: 400,
      speedLimitKmh: 90,
      speedLimitShown: true,
    })
    expect(s.environment).toEqual({ gameClock: '09:20', weather: null, rain: null })
  })

  it('keeps missing telemetry values missing instead of inventing them', () => {
    const s = snapshotFromTelemetry(update({ status: 'connected', game: 'ats', data: emptyData() }))
    expect(s.mode).toBe('live')
    expect(Object.values(s.vehicle ?? {}).every((v) => v === null)).toBe(true)
    expect(Object.values(s.dynamics ?? {}).every((v) => v === null)).toBe(true)
    expect(s.job).toBeNull()
    expect(s.environment?.gameClock).toBeNull()
  })

  it('distinguishes no job, delivered jobs and unknown job information', () => {
    const none = fullData()
    none.job = { ...emptyData().job, state: 'none' }
    expect(snapshotFromTelemetry(update({ status: 'connected', data: none })).job?.state).toBe(
      'none',
    )

    const delivered = fullData()
    delivered.job = { ...delivered.job, state: 'delivered', deliveredRevenue: 32000 }
    const job = snapshotFromTelemetry(update({ status: 'connected', data: delivered })).job
    expect(job?.state).toBe('delivered')
    expect(job?.revenue).toBe(32000)
    expect(job?.remainingKm).toBeNull()

    const unknown = fullData()
    unknown.job = emptyData().job
    expect(snapshotFromTelemetry(update({ status: 'connected', data: unknown })).job).toBeNull()
  })

  it('shows no values while reconnecting', () => {
    const s = snapshotFromTelemetry(status('reconnecting'))
    expect(s.mode).toBe('live')
    expect(s.vehicle).toBeNull()
    expect(s.job).toBeNull()
    expect(s.dynamics).toBeNull()
    expect(s.navigation).toBeNull()
    expect(s.environment).toBeNull()
  })

  it.each(['disconnected', 'connecting', 'unavailable', 'error'] as const)(
    'falls back to labelled demo data when %s',
    (state) => {
      const s = snapshotFromTelemetry(status(state, 'ats'))
      expect(s.mode).toBe('demo')
      expect(s.connection).toBe(state)
      expect(s.game).toBe('ats')
      expect(s.vehicle).toEqual(DEMO_SNAPSHOT.vehicle)
      expect(s.job).toEqual(DEMO_SNAPSHOT.job)
    },
  )

  it('treats a connected update without data as demo, never as live zeros', () => {
    expect(snapshotFromTelemetry({ ...connected, data: null }).mode).toBe('demo')
  })
})

function fakeBridge(initial: Promise<TelemetryUpdate>) {
  let handler: ((u: TelemetryUpdate) => void) | null = null
  const stop = vi.fn()
  const bridge: TelemetryBridge = {
    listen: vi.fn(async (event, h) => {
      expect(event).toBe(TELEMETRY_EVENT)
      handler = h
      return stop
    }),
    getSnapshot: () => initial,
  }
  return { bridge, stop, emit: (u: TelemetryUpdate) => handler?.(u) }
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

describe('createTelemetrySource', () => {
  it('starts in demo mode and applies the initial backend state', async () => {
    const { bridge } = fakeBridge(Promise.resolve(status('connecting')))
    const source = createTelemetrySource(bridge)
    expect(source.getSnapshot().mode).toBe('demo')
    await flush()
    expect(source.getSnapshot().connection).toBe('connecting')
  })

  it('notifies subscribers on events and keeps a stable snapshot between them', async () => {
    const { bridge, emit } = fakeBridge(Promise.resolve(status('disconnected')))
    const source = createTelemetrySource(bridge)
    await flush()
    const listener = vi.fn()
    source.subscribe(listener)
    const before = source.getSnapshot()
    expect(source.getSnapshot()).toBe(before)
    emit(connected)
    expect(listener).toHaveBeenCalledTimes(1)
    expect(source.getSnapshot().mode).toBe('live')
  })

  it('does not let a late initial snapshot overwrite a newer event', async () => {
    let resolve!: (u: TelemetryUpdate) => void
    const { bridge, emit } = fakeBridge(new Promise((r) => (resolve = r)))
    const source = createTelemetrySource(bridge)
    await flush()
    emit(connected)
    resolve(status('disconnected'))
    await flush()
    expect(source.getSnapshot().connection).toBe('connected')
  })

  it('stays in demo mode when the backend is unreachable', async () => {
    const bridge: TelemetryBridge = {
      listen: () => Promise.reject(new Error('no tauri')),
      getSnapshot: () => Promise.reject(new Error('no tauri')),
    }
    const source = createTelemetrySource(bridge)
    await flush()
    expect(source.getSnapshot()).toBe(DEMO_SNAPSHOT)
  })

  it('stops listening and ignores events after dispose', async () => {
    const { bridge, stop, emit } = fakeBridge(Promise.resolve(status('disconnected')))
    const source = createTelemetrySource(bridge)
    await flush()
    source.dispose()
    expect(stop).toHaveBeenCalled()
    emit(connected)
    expect(source.getSnapshot().mode).toBe('demo')
  })
})
