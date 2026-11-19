import { act, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { LOCAL_STALE_AFTER_MS } from '@/domain/vehicle'
import { emptyData, fullData } from '@/test/telemetryFixtures'
import { region, renderLiveApp } from '@/test/liveApp'

const route = () => region('Route Information')
/** The row of a label, to check its value and its source tag together. */
const row = (label: string) => within(route().getByText(label).closest('li') as HTMLElement)

afterEach(() => vi.useRealTimers())

describe('Route Information', () => {
  it('shows game and calculated values with their provenance', async () => {
    const { send } = renderLiveApp()
    await send({ status: 'connected', game: 'ets2', data: fullData() })
    expect(route().queryByText('Demo')).not.toBeInTheDocument()
    expect(row('Remaining distance').getByText('510 km')).toBeInTheDocument()
    expect(row('Remaining distance').getByText('Game')).toBeInTheDocument()
    expect(row('Remaining driving time').getByText('≈ 6 h 40 min')).toBeInTheDocument()
    expect(row('Remaining driving time').getByText('Game')).toBeInTheDocument()
    expect(row('Speed limit').getByText('90 km/h')).toBeInTheDocument()
    expect(row('Job distance').getByText('680 km')).toBeInTheDocument()
    expect(row('Driven distance').getByText('≈ 170 km')).toBeInTheDocument()
    expect(row('Driven distance').getByText('Calculated')).toBeInTheDocument()
    expect(route().getByText('≈ 25 %')).toBeInTheDocument()
    expect(route().getByRole('meter', { name: 'Route progress' })).toHaveAttribute(
      'aria-valuenow',
      '25',
    )
    expect(
      route().getByText(/RoadPilot plans no route and gives no directions/),
    ).toBeInTheDocument()
  })

  it('says that the time scale of the driving time is not confirmed', async () => {
    const { send } = renderLiveApp()
    await send({ status: 'connected', game: 'ets2', data: fullData() })
    expect(row('Remaining driving time').getByText('≈ 6 h 40 min')).toHaveAttribute(
      'title',
      'Route Advisor estimate. Whether it counts game time or real time is not confirmed.',
    )
  })

  it('uses miles and mph for ATS', async () => {
    const { send } = renderLiveApp()
    const d = fullData()
    d.job.currency = 'USD'
    await send({ status: 'connected', game: 'ats', data: d })
    expect(row('Remaining distance').getByText('317 mi')).toBeInTheDocument()
    expect(row('Speed limit').getByText('56 mph')).toBeInTheDocument()
  })

  it('shows missing route data without inventing values', async () => {
    const { send } = renderLiveApp()
    await send({ status: 'connected', game: 'ets2', data: emptyData() })
    expect(row('Remaining distance').getByText('Not available')).toBeInTheDocument()
    expect(row('Remaining distance').queryByText('Game')).not.toBeInTheDocument()
    // The telemetry reports no job information at all: not available, not "no job".
    expect(row('Driven distance').getByText('Not available')).toBeInTheDocument()
    expect(route().queryByRole('meter')).not.toBeInTheDocument()
  })

  it('says when there is no active job', async () => {
    const { send } = renderLiveApp()
    const d = fullData()
    d.job = { ...emptyData().job, state: 'none' }
    await send({ status: 'connected', game: 'ets2', data: d })
    expect(row('Remaining distance').getByText('510 km')).toBeInTheDocument()
    expect(row('Job distance').getByText('No active job')).toBeInTheDocument()
    expect(row('Driven distance').getByText('No active job')).toBeInTheDocument()
  })

  it('marks invalid values', async () => {
    const { send } = renderLiveApp()
    const d = fullData()
    d.navigation.distanceKm = null
    d.job.progressPercent = null
    d.source.invalidFields = ['navigation.distanceM']
    await send({ status: 'connected', game: 'ets2', data: d })
    expect(row('Remaining distance').getByText('Invalid value')).toBeInTheDocument()
    expect(row('Driven distance').getByText('Invalid value')).toBeInTheDocument()
  })

  it('shows no values once the data is stale', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] })
    const { send } = renderLiveApp()
    await send({ status: 'connected', game: 'ets2', data: fullData() })
    expect(row('Remaining distance').getByText('510 km')).toBeInTheDocument()
    act(() => {
      vi.advanceTimersByTime(LOCAL_STALE_AFTER_MS + 500)
    })
    expect(row('Remaining distance').getByText('No data')).toBeInTheDocument()
    expect(screen.queryByText('510 km')).not.toBeInTheDocument()
  })

  it('labels demo values as demo', () => {
    renderLiveApp()
    expect(route().getByText('Demo')).toBeInTheDocument()
    expect(route().getByText('≈ 48 %')).toBeInTheDocument()
  })
})
