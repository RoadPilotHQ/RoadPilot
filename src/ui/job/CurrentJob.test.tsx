import { act, fireEvent, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { TelemetryData } from '@/domain/telemetry'
import { LOCAL_STALE_AFTER_MS } from '@/domain/vehicle'
import { emptyData, fullData } from '@/test/telemetryFixtures'
import { region, renderLiveApp } from '@/test/liveApp'

const job = () => region('Current Job')

function withJob(overrides: Partial<TelemetryData['job']>): TelemetryData {
  const d = fullData()
  d.job = {
    ...d.job,
    sourceCompany: 'Source Co',
    destinationCompany: 'Target Co',
    cargoDamagePercent: 1.5,
    cargoLoaded: true,
    jobMarket: 'freight_market',
    timeToDeadlineMin: 125,
    ...overrides,
  }
  return d
}

afterEach(() => vi.useRealTimers())

describe('Current Job', () => {
  it('labels the demo job as demo data', () => {
    renderLiveApp()
    expect(job().getByText('Demo')).toBeInTheDocument()
    expect(job().getByText('Active')).toBeInTheDocument()
    expect(job().getByText('Hamburg')).toBeInTheDocument()
  })

  it('shows an active ETS2 job with every reported value', async () => {
    const { send } = renderLiveApp()
    await send({ status: 'connected', game: 'ets2', data: withJob({}) })
    expect(job().queryByText('Demo')).not.toBeInTheDocument()
    expect(job().getByText('Active')).toBeInTheDocument()
    expect(job().getByText('Berlin')).toBeInTheDocument()
    expect(job().getByText('Source Co')).toBeInTheDocument()
    expect(job().getByText('Wien')).toBeInTheDocument()
    expect(job().getByText('Target Co')).toBeInTheDocument()
    expect(job().getByText('Machinery')).toBeInTheDocument()
    expect(job().getByText('Loaded')).toBeInTheDocument()
    expect(job().getByText('18,000 kg')).toBeInTheDocument()
    expect(job().getByText('€31,000')).toBeInTheDocument()
    expect(job().getByText('Today, 18:05')).toBeInTheDocument()
    expect(job().getByText('2 h 5 min left · game time')).toBeInTheDocument()
    expect(job().getByText('1.5 %')).toBeInTheDocument()
    expect(job().getByText('Freight market')).toBeInTheDocument()
  })

  it('shows ATS amounts in US dollars and pounds', async () => {
    const { send } = renderLiveApp()
    await send({ status: 'connected', game: 'ats', data: withJob({ currency: 'USD' }) })
    expect(job().getByText('$31,000')).toBeInTheDocument()
    expect(job().getByText('39,683 lb')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('radio', { name: 'Metric' }))
    expect(job().getByText('18,000 kg')).toBeInTheDocument()
  })

  it('never shows an amount with the currency of the other game', async () => {
    const { send } = renderLiveApp()
    await send({ status: 'connected', game: 'ats', data: withJob({ currency: 'EUR' }) })
    expect(job().queryByText('€31,000')).not.toBeInTheDocument()
    expect(job().getAllByText('Invalid value').length).toBeGreaterThan(0)
  })

  it('shows late deliveries as late', async () => {
    const { send } = renderLiveApp()
    await send({ status: 'connected', game: 'ets2', data: withJob({ timeToDeadlineMin: -75 }) })
    expect(job().getByText('1 h 15 min late · game time')).toBeInTheDocument()
  })

  it('shows no active job, delivered and cancelled jobs as reported', async () => {
    const { send } = renderLiveApp()
    await send({
      status: 'connected',
      game: 'ets2',
      data: withJob({ ...emptyData().job, state: 'none' }),
    })
    expect(job().getByText('No active job')).toBeInTheDocument()
    expect(job().getByText('The game reports no active job.')).toBeInTheDocument()

    await send({
      status: 'connected',
      game: 'ets2',
      data: withJob({ state: 'delivered', deliveredRevenue: 32000 }),
    })
    expect(job().getByText('Delivered')).toBeInTheDocument()
    expect(job().getByText('Revenue')).toBeInTheDocument()
    expect(job().getByText('€32,000')).toBeInTheDocument()
    expect(job().queryByText(/left · game time/)).not.toBeInTheDocument()

    await send({
      status: 'connected',
      game: 'ets2',
      data: withJob({ state: 'cancelled', cancelPenalty: 4500 }),
    })
    expect(job().getByText('Cancelled')).toBeInTheDocument()
    expect(job().getByText('Penalty')).toBeInTheDocument()
    expect(job().getByText('€4,500')).toBeInTheDocument()
    expect(job().queryByText(/fail/i)).not.toBeInTheDocument()
  })

  it('marks missing cargo and company information', async () => {
    const { send } = renderLiveApp()
    await send({
      status: 'connected',
      game: 'ets2',
      data: withJob({ cargo: null, cargoMassKg: null, sourceCompany: null, cargoLoaded: null }),
    })
    expect(job().getAllByText('Not available')).toHaveLength(3)
    expect(job().queryByText('Loaded')).not.toBeInTheDocument()
  })

  it('marks invalid values', async () => {
    const { send } = renderLiveApp()
    const data = withJob({ income: null })
    data.source.invalidFields = ['job.income']
    await send({ status: 'connected', game: 'ets2', data })
    expect(job().getByText('Invalid value')).toBeInTheDocument()
  })

  it('explains unknown job information and stale data', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] })
    const { send } = renderLiveApp()
    await send({ status: 'connected', game: 'ets2', data: emptyData() })
    expect(job().getByText('Unavailable')).toBeInTheDocument()
    expect(
      job().getByText('The telemetry has not reported any job information.'),
    ).toBeInTheDocument()

    await send({ status: 'connected', game: 'ets2', data: withJob({}) })
    expect(job().getByText('Machinery')).toBeInTheDocument()
    act(() => {
      vi.advanceTimersByTime(LOCAL_STALE_AFTER_MS + 500)
    })
    expect(job().queryByText('Machinery')).not.toBeInTheDocument()
    expect(job().getByText(/No current telemetry/)).toBeInTheDocument()
  })

  it('clears the job when the game changes', async () => {
    const { send } = renderLiveApp()
    await send({ status: 'connected', game: 'ats', data: withJob({ currency: 'USD' }) })
    expect(job().getByText('Machinery')).toBeInTheDocument()
    await send({ status: 'disconnected' })
    await send({ status: 'connected', game: 'ets2', data: emptyData() })
    expect(job().queryByText('Machinery')).not.toBeInTheDocument()
    expect(job().getByText('Unavailable')).toBeInTheDocument()
  })
})
