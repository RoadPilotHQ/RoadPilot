import { describe, expect, it } from 'vitest'
import { DEMO_SNAPSHOT, snapshotFromTelemetry } from '@/backend/dashboardSource'
import { fullData, update } from '@/test/telemetryFixtures'
import { addToTrace, EMPTY_TRACE, PATH_LIMITS, traceBounds, type PathTrace } from './path'
import type { DashboardSnapshot } from './types'
import { LOCAL_STALE_AFTER_MS } from './vehicle'

const NOW = 1_800_000_000_000

/** A connected frame at a position (metres, telemetry convention). */
function at(
  x: number,
  z: number,
  { game = 'ets2', headingDeg = 0 }: { game?: 'ets2' | 'ats'; headingDeg?: number } = {},
): DashboardSnapshot {
  const d = fullData(NOW)
  d.position = { x, y: 0, z, headingDeg, pitchDeg: 0, rollDeg: 0 }
  return snapshotFromTelemetry(update({ status: 'connected', game, data: d }))
}

const drive = (snaps: DashboardSnapshot[], trace: PathTrace = EMPTY_TRACE) =>
  snaps.reduce((t, s) => addToTrace(t, s, NOW), trace)

describe('addToTrace', () => {
  it('starts empty and records live positions', () => {
    const t = drive([at(0, 0), at(10, 0), at(20, -5)])
    expect(t.game).toBe('ets2')
    expect(t.points).toBe(3)
    expect(t.segments).toEqual([
      [
        { x: 0, z: 0 },
        { x: 10, z: 0 },
        { x: 20, z: -5 },
      ],
    ])
    expect(t.last).toMatchObject({ x: 20, z: -5, headingDeg: 0, atUnixMs: NOW })
  })

  it('records nothing from demo data, interrupted or stale links', () => {
    expect(addToTrace(EMPTY_TRACE, DEMO_SNAPSHOT, NOW)).toBe(EMPTY_TRACE)
    const interrupted = snapshotFromTelemetry(update({ status: 'reconnecting', game: 'ets2' }))
    expect(addToTrace(EMPTY_TRACE, interrupted, NOW)).toBe(EMPTY_TRACE)
    expect(addToTrace(EMPTY_TRACE, at(5, 5), NOW + LOCAL_STALE_AFTER_MS + 1)).toBe(EMPTY_TRACE)
  })

  it('records nothing without a position', () => {
    const s = snapshotFromTelemetry(
      update({ status: 'connected', game: 'ets2', data: { ...fullData(NOW), position: null } }),
    )
    expect(addToTrace(EMPTY_TRACE, s, NOW)).toBe(EMPTY_TRACE)
  })

  it('skips invalid and non-finite coordinates and counts them', () => {
    const t = drive([
      at(0, 0),
      at(Number.NaN, 0),
      at(0, Number.POSITIVE_INFINITY),
      at(2e7, 0),
      at(0, 0, { headingDeg: Number.NaN }),
      at(10, 0),
    ])
    expect(t.rejected).toBe(4)
    expect(t.points).toBe(2)
    expect(t.last).toMatchObject({ x: 10, z: 0 })
  })

  it('ignores movements below the minimum step but keeps the heading current', () => {
    const t1 = drive([at(0, 0), at(0.5, 0)])
    expect(t1.points).toBe(1)
    const t2 = addToTrace(t1, at(0.5, 0, { headingDeg: 45 }), NOW)
    expect(t2.points).toBe(1)
    expect(t2.last?.headingDeg).toBe(45)
    // Standing still changes nothing at all.
    expect(addToTrace(t2, at(0.5, 0, { headingDeg: 45 }), NOW)).toBe(t2)
  })

  it('starts a new segment after a jump (ferry, train, teleport)', () => {
    const t = drive([at(0, 0), at(10, 0), at(10 + PATH_LIMITS.jumpM + 1, 0), at(1030, 0)])
    expect(t.segments).toHaveLength(2)
    expect(t.segments[1]![0]).toEqual({ x: 1011, z: 0 })
  })

  it('keeps a long history bounded, with its start and end', () => {
    let t = EMPTY_TRACE
    const n = 50_000
    for (let i = 0; i < n; i++) t = addToTrace(t, at(i * 5, 0), NOW)
    expect(t.points).toBeLessThanOrEqual(PATH_LIMITS.maxPoints)
    expect(t.points).toBeGreaterThan(PATH_LIMITS.maxPoints / 2)
    const all = t.segments.flat()
    expect(all[0]).toEqual({ x: 0, z: 0 })
    expect(all[all.length - 1]).toEqual({ x: (n - 1) * 5, z: 0 })
    expect(t.segments).toHaveLength(1)
  })

  it('clears the trace when the game changes and never mixes coordinates', () => {
    const ets2 = drive([at(0, 0), at(100, 0)])
    const connecting = snapshotFromTelemetry(update({ status: 'connecting', game: 'ats' }))
    const cleared = addToTrace(ets2, connecting, NOW)
    expect(cleared.points).toBe(0)
    expect(cleared.last).toBeNull()
    const ats = addToTrace(cleared, at(-5000, 7000, { game: 'ats' }), NOW)
    expect(ats.game).toBe('ats')
    expect(ats.segments).toEqual([[{ x: -5000, z: 7000 }]])
    // Directly from one game's frame to the other's, too.
    const direct = addToTrace(ets2, at(1, 1, { game: 'ats' }), NOW)
    expect(direct.segments).toEqual([[{ x: 1, z: 1 }]])
  })

  it('keeps the trace of the same game across an interruption', () => {
    const t = drive([at(0, 0), at(50, 0)])
    const gone = snapshotFromTelemetry(update({ status: 'disconnected' }))
    expect(addToTrace(t, gone, NOW)).toBe(t)
  })
})

describe('traceBounds', () => {
  it('spans every segment', () => {
    expect(traceBounds(EMPTY_TRACE)).toBeNull()
    const t = drive([at(0, 0), at(10, -20), at(5000, 300), at(5010, 310)])
    expect(traceBounds(t)).toEqual({ minX: 0, maxX: 5010, minZ: -20, maxZ: 310 })
  })
})
