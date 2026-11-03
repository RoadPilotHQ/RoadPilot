import { describe, expect, it, vi } from 'vitest'
import type { TelemetryUpdate } from '@/domain/types'
import { DEMO_SNAPSHOT, snapshotFromTelemetry } from './dashboardSource'
import { createTelemetrySource, TELEMETRY_EVENT, type TelemetryBridge } from './telemetrySource'

const connected: TelemetryUpdate = {
  status: 'connected',
  game: 'ets2',
  paused: false,
  vehicle: { speedKmh: 83.4, engineRpm: 1350, gear: 11 },
  error: null,
}

const status = (s: TelemetryUpdate['status'], game: TelemetryUpdate['game'] = 'ets2') => ({
  status: s,
  game,
  paused: false,
  vehicle: null,
  error: null,
})

describe('snapshotFromTelemetry', () => {
  it('uses demo data until the backend reports anything', () => {
    expect(snapshotFromTelemetry(null)).toBe(DEMO_SNAPSHOT)
  })

  it('maps a connected update to live data without any demo values', () => {
    const s = snapshotFromTelemetry(connected)
    expect(s.mode).toBe('live')
    expect(s.connection).toBe('connected')
    expect(s.game).toBe('ets2')
    expect(s.vehicle).toEqual({
      speedKmh: 83.4,
      targetSpeedKmh: null,
      engineRpm: 1350,
      gear: 11,
      cruiseControl: null,
    })
    expect(s.job).toBeNull()
  })

  it('keeps missing telemetry values missing', () => {
    const s = snapshotFromTelemetry({
      ...connected,
      vehicle: { speedKmh: null, engineRpm: null, gear: null },
    })
    expect(s.vehicle?.speedKmh).toBeNull()
    expect(s.vehicle?.engineRpm).toBeNull()
  })

  it('shows no values while reconnecting', () => {
    const s = snapshotFromTelemetry(status('reconnecting'))
    expect(s.mode).toBe('live')
    expect(s.vehicle).toBeNull()
    expect(s.job).toBeNull()
  })

  it.each(['disconnected', 'connecting', 'unavailable', 'error'] as const)(
    'falls back to labelled demo data when %s',
    (state) => {
      const s = snapshotFromTelemetry(status(state, 'ats'))
      expect(s.mode).toBe('demo')
      expect(s.connection).toBe(state)
      expect(s.game).toBe('ats')
      expect(s.vehicle).toEqual(DEMO_SNAPSHOT.vehicle)
    },
  )

  it('treats a connected update without vehicle data as demo, never as live zeros', () => {
    expect(snapshotFromTelemetry({ ...connected, vehicle: null }).mode).toBe('demo')
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
