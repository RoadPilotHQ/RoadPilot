import { describe, expect, it } from 'vitest'
import { DEMO_SNAPSHOT, snapshotFromTelemetry } from '@/backend/dashboardSource'
import { emptyData, fullData, update } from '@/test/telemetryFixtures'
import type { TelemetryData } from './telemetry'
import { JOB_INVALID_TARGETS, invalidJobFields, jobView, knownJobMarket } from './job'
import { LOCAL_STALE_AFTER_MS, link } from './vehicle'

const NOW = 1_800_000_000_000

function view(data: TelemetryData, game: 'ets2' | 'ats' = 'ets2', at = NOW) {
  const s = snapshotFromTelemetry(update({ status: 'connected', game, data }))
  return jobView(s, link(s, at))
}

function withJob(job: Partial<TelemetryData['job']>): TelemetryData {
  const d = fullData(NOW)
  d.job = { ...d.job, ...job }
  return d
}

describe('jobView', () => {
  it('shows an active job with every reported value', () => {
    const d = withJob({
      sourceCompany: 'Source Co',
      destinationCompany: 'Target Co',
      cargoDamagePercent: 1.5,
      cargoLoaded: true,
      jobMarket: 'freight_market',
      timeToDeadlineMin: 125,
    })
    const j = view(d)
    expect(j.status).toBe('active')
    expect(j.unknownReason).toBeNull()
    expect(j.demo).toBe(false)
    expect(j.read('cargo')).toEqual({ kind: 'value', value: 'Machinery' })
    expect(j.read('cargoMassKg')).toEqual({ kind: 'value', value: 18000 })
    expect(j.read('sourceCompany')).toEqual({ kind: 'value', value: 'Source Co' })
    expect(j.read('destinationCity')).toEqual({ kind: 'value', value: 'Wien' })
    expect(j.read('income')).toEqual({ kind: 'value', value: 31000 })
    expect(j.read('currency')).toEqual({ kind: 'value', value: 'EUR' })
    expect(j.read('cargoLoaded')).toEqual({ kind: 'value', value: true })
    expect(j.read('timeToDeadlineMin')).toEqual({ kind: 'value', value: 125 })
  })

  it('reports no active job without any job values', () => {
    const j = view(withJob({ ...emptyData().job, state: 'none', cargo: 'Leftover' }))
    expect(j.status).toBe('none')
    expect(j.read('cargo')).toEqual({ kind: 'missing' })
  })

  it('keeps a delivered job with its revenue', () => {
    const j = view(withJob({ state: 'delivered', deliveredRevenue: 32000 }))
    expect(j.status).toBe('delivered')
    expect(j.read('deliveredRevenue')).toEqual({ kind: 'value', value: 32000 })
  })

  it('keeps a cancelled job as cancelled, never as failed', () => {
    const j = view(withJob({ state: 'cancelled', cancelPenalty: 4500 }))
    expect(j.status).toBe('cancelled')
    expect(j.read('cancelPenalty')).toEqual({ kind: 'value', value: 4500 })
  })

  it('is unknown when the telemetry reports no job information', () => {
    const j = view(emptyData(NOW))
    expect(j.status).toBe('unknown')
    expect(j.unknownReason).toBe('notReported')
    expect(j.read('cargo')).toEqual({ kind: 'noData' })
  })

  it('marks missing cargo and company information as missing', () => {
    const j = view(withJob({ cargo: null, cargoMassKg: null, sourceCompany: null }))
    expect(j.read('cargo')).toEqual({ kind: 'missing' })
    expect(j.read('cargoMassKg')).toEqual({ kind: 'missing' })
    expect(j.read('sourceCompany')).toEqual({ kind: 'missing' })
    expect(j.read('sourceCity')).toEqual({ kind: 'value', value: 'Berlin' })
  })

  it('uses the game currency and rejects one from the other game', () => {
    const ats = withJob({ currency: 'USD' })
    expect(view(ats, 'ats').read('currency')).toEqual({ kind: 'value', value: 'USD' })
    const mixed = view(withJob({ currency: 'EUR' }), 'ats')
    expect(mixed.read('currency')).toEqual({ kind: 'invalid' })
    expect(mixed.read('income')).toEqual({ kind: 'invalid' })
    expect(mixed.read('cargo')).toEqual({ kind: 'value', value: 'Machinery' })
  })

  it('marks values removed by the telemetry reader as invalid', () => {
    const d = withJob({ income: null, plannedDistanceKm: null, progressPercent: null })
    d.source.invalidFields = ['job.income', 'job.plannedDistanceKm', 'truck.fuelL']
    const j = view(d)
    expect(j.read('income')).toEqual({ kind: 'invalid' })
    expect(j.read('plannedDistanceKm')).toEqual({ kind: 'invalid' })
    expect(j.read('progressPercent')).toEqual({ kind: 'invalid' })
    expect(j.read('cargo')).toEqual({ kind: 'value', value: 'Machinery' })
  })

  it('rejects impossible values at the UI boundary', () => {
    const d = withJob({
      cargoMassKg: -1,
      cargoDamagePercent: 140,
      income: 1.5,
      cargo: 42 as unknown as string,
      deadline: { dayOffset: 0, time: 'soon' },
    })
    const j = view(d)
    for (const field of [
      'cargoMassKg',
      'cargoDamagePercent',
      'income',
      'cargo',
      'deadline',
    ] as const)
      expect(j.read(field)).toEqual({ kind: 'invalid' })
  })

  it('shows no job values once the data is stale', () => {
    const j = view(withJob({}), 'ets2', NOW + LOCAL_STALE_AFTER_MS + 1)
    expect(j.status).toBe('unknown')
    expect(j.unknownReason).toBe('noData')
    expect(j.read('cargo')).toEqual({ kind: 'noData' })
    const s = snapshotFromTelemetry(update({ status: 'reconnecting', game: 'ets2' }))
    expect(jobView(s, link(s, NOW)).status).toBe('unknown')
  })

  it('keeps a paused game current', () => {
    const s = snapshotFromTelemetry(
      update({ status: 'connected', game: 'ets2', paused: true, data: fullData(NOW) }),
    )
    expect(jobView(s, link(s, NOW + 600_000)).status).toBe('active')
  })

  it('labels the demo job as demo', () => {
    const j = jobView(DEMO_SNAPSHOT, link(DEMO_SNAPSHOT, NOW))
    expect(j.demo).toBe(true)
    expect(j.status).toBe('active')
  })

  it('never carries the job of one game into the other', () => {
    const ats = snapshotFromTelemetry(
      update({ status: 'connected', game: 'ats', data: withJob({ currency: 'USD' }) }),
    )
    const ets2 = snapshotFromTelemetry(
      update({ status: 'connected', game: 'ets2', data: emptyData(NOW) }),
      ats,
    )
    const j = jobView(ets2, link(ets2, NOW))
    expect(j.status).toBe('unknown')
    expect(j.read('cargo')).toEqual({ kind: 'noData' })
  })
})

describe('job wire paths and markets', () => {
  it('maps every job and navigation path the telemetry reader validates', () => {
    expect(Object.keys(JOB_INVALID_TARGETS).sort()).toEqual([
      'job.cancelPenalty',
      'job.cargo',
      'job.cargoDamage',
      'job.cargoMassKg',
      'job.deliveredRevenue',
      'job.destinationCity',
      'job.destinationCompany',
      'job.income',
      'job.jobMarket',
      'job.plannedDistanceKm',
      'job.sourceCity',
      'job.sourceCompany',
      'navigation.distanceM',
    ])
    expect(invalidJobFields(['job.cargoDamage', 'truck.gear'])).toEqual(['cargoDamagePercent'])
  })

  it('names the documented job markets and keeps unknown tokens', () => {
    expect(knownJobMarket('quick_job')).toBe('quick_job')
    expect(knownJobMarket('mod_market')).toBeNull()
  })
})
