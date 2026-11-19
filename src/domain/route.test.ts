import { describe, expect, it } from 'vitest'
import { DEMO_SNAPSHOT, snapshotFromTelemetry } from '@/backend/dashboardSource'
import { emptyData, fullData, update } from '@/test/telemetryFixtures'
import type { TelemetryData } from './telemetry'
import { NAVIGATION_INVALID_TARGETS, routeView } from './route'
import { LOCAL_STALE_AFTER_MS, link } from './vehicle'

const NOW = 1_800_000_000_000

function view(data: TelemetryData, at = NOW) {
  const s = snapshotFromTelemetry(update({ status: 'connected', game: 'ets2', data }))
  return routeView(s, link(s, at))
}

describe('routeView', () => {
  it('takes remaining distance, time and speed limit from the game', () => {
    const r = view(fullData(NOW))
    expect(r.remainingDistanceKm).toEqual({
      source: 'game',
      reading: { kind: 'value', value: 510 },
    })
    expect(r.remainingTimeMin).toEqual({ source: 'game', reading: { kind: 'value', value: 400 } })
    expect(r.speedLimit).toEqual({
      source: 'game',
      reading: { kind: 'value', value: { kind: 'limit', kmh: 90 } },
    })
    expect(r.jobDistanceKm).toEqual({ source: 'game', reading: { kind: 'value', value: 680 } })
  })

  it('labels progress and driven distance as calculated', () => {
    const r = view(fullData(NOW))
    expect(r.jobActive).toBe(true)
    expect(r.progressPercent).toEqual({
      source: 'calculated',
      reading: { kind: 'value', value: 25 },
    })
    expect(r.drivenDistanceKm).toEqual({
      source: 'calculated',
      reading: { kind: 'value', value: 170 },
    })
  })

  it('never reports a negative driven distance', () => {
    const d = fullData(NOW)
    d.navigation.distanceKm = 900
    expect(view(d).drivenDistanceKm.reading).toEqual({ kind: 'value', value: 0 })
  })

  it('reports a road without a shown limit as none, not as zero', () => {
    const d = fullData(NOW)
    d.navigation.speedLimitKmh = null
    d.navigation.speedLimitShown = false
    expect(view(d).speedLimit.reading).toEqual({ kind: 'value', value: { kind: 'none' } })
  })

  it('keeps missing route data unavailable', () => {
    const r = view(emptyData(NOW))
    for (const v of [r.remainingDistanceKm, r.remainingTimeMin, r.speedLimit]) {
      expect(v).toEqual({ source: 'unavailable', reading: { kind: 'missing' } })
    }
    expect(r.jobActive).toBe(false)
    expect(r.drivenDistanceKm.source).toBe('unavailable')
  })

  it('shows Route Advisor values without a job, but no job progress', () => {
    const d = fullData(NOW)
    d.job = { ...emptyData().job, state: 'none' }
    const r = view(d)
    expect(r.remainingDistanceKm.reading).toEqual({ kind: 'value', value: 510 })
    expect(r.jobActive).toBe(false)
    expect(r.progressPercent.source).toBe('unavailable')
    expect(r.drivenDistanceKm.source).toBe('unavailable')
  })

  it('marks invalid values, and calculations from them, as invalid', () => {
    const d = fullData(NOW)
    d.navigation.distanceKm = null
    d.job.progressPercent = null
    d.source.invalidFields = ['navigation.distanceM']
    const r = view(d)
    expect(r.remainingDistanceKm).toEqual({ source: 'unavailable', reading: { kind: 'invalid' } })
    expect(r.progressPercent.reading).toEqual({ kind: 'invalid' })
    expect(r.drivenDistanceKm.reading).toEqual({ kind: 'invalid' })
    expect(r.remainingTimeMin.reading.kind).toBe('value')
  })

  it('rejects impossible Route Advisor values at the UI boundary', () => {
    const d = fullData(NOW)
    d.navigation.distanceKm = -4
    d.navigation.etaMin = Number.NaN
    d.navigation.speedLimitShown = false // a limit while none is shown
    const r = view(d)
    expect(r.remainingDistanceKm.reading).toEqual({ kind: 'invalid' })
    expect(r.remainingTimeMin.reading).toEqual({ kind: 'invalid' })
    expect(r.speedLimit.reading).toEqual({ kind: 'value', value: { kind: 'none' } })
    const s = snapshotFromTelemetry(update({ status: 'connected', game: 'ets2', data: d }))
    expect(s.telemetry?.invalidNavigationFields).toContain('speedLimitKmh')
  })

  it('has no values once the data is stale or interrupted', () => {
    const r = view(fullData(NOW), NOW + LOCAL_STALE_AFTER_MS + 1)
    expect(r.remainingDistanceKm).toEqual({ source: 'unavailable', reading: { kind: 'noData' } })
    expect(r.progressPercent.reading).toEqual({ kind: 'noData' })
    const s = snapshotFromTelemetry(update({ status: 'reconnecting', game: 'ets2' }))
    expect(routeView(s, link(s, NOW)).remainingTimeMin.reading).toEqual({ kind: 'noData' })
  })

  it('labels demo route values as demo', () => {
    const r = routeView(DEMO_SNAPSHOT, link(DEMO_SNAPSHOT, NOW))
    expect(r.demo).toBe(true)
    expect(r.drivenDistanceKm.reading).toEqual({ kind: 'value', value: 685 })
  })

  it('maps every navigation path the telemetry reader validates', () => {
    expect(Object.keys(NAVIGATION_INVALID_TARGETS).sort()).toEqual([
      'navigation.distanceM',
      'navigation.speedLimitMps',
      'navigation.timeS',
    ])
  })
})
