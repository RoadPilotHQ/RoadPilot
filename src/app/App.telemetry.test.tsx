import { act, render, screen, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import type { TelemetryData, TelemetryUpdate } from '@/domain/telemetry'
import { createTelemetrySource, type TelemetryBridge } from '@/backend/telemetrySource'
import { emptyData, fullData, update } from '@/test/telemetryFixtures'
import { App } from './App'

/** A telemetry source driven by the test instead of the Rust backend. */
function setup() {
  let handler: ((u: TelemetryUpdate) => void) | null = null
  const bridge: TelemetryBridge = {
    listen: async (_event, h) => {
      handler = h
      return () => {}
    },
    getSnapshot: () => new Promise(() => {}),
  }
  const source = createTelemetrySource(bridge)
  render(<App source={source} />)
  const send = async (overrides: Partial<TelemetryUpdate>) => {
    await act(async () => {
      await Promise.resolve()
      handler?.(update(overrides))
    })
  }
  return { send }
}

const card = (name: string) => within(screen.getByRole('region', { name }))
const badge = () => screen.getByRole('status')

const live = (data: TelemetryData = fullData()): Partial<TelemetryUpdate> => ({
  status: 'connected',
  game: 'ets2',
  data,
})

describe('dashboard with live telemetry', () => {
  it('shows demo mode before any backend state arrives', () => {
    setup()
    expect(badge()).toHaveTextContent('Game not running')
    expect(screen.getByText('Demo data')).toBeInTheDocument()
    // The new cards also show labelled demo values.
    expect(card('Environment').getByText('09:20')).toBeInTheDocument()
  })

  it('shows the connecting state with demo data and a reason', async () => {
    const { send } = setup()
    await send({ status: 'connecting', game: 'ats' })
    expect(badge()).toHaveTextContent('ATS Connecting…')
    expect(screen.getByText('Demo data')).toBeInTheDocument()
    expect(screen.getByText('Waiting for the first telemetry data from ATS.')).toBeInTheDocument()
  })

  it('shows live vehicle data including fuel, engine and temperature', async () => {
    const { send } = setup()
    await send(live())
    expect(badge()).toHaveTextContent('ETS2 Connected')
    expect(screen.getByText('Live data')).toBeInTheDocument()
    expect(screen.queryByText('Demo data')).not.toBeInTheDocument()
    const vehicle = card('Vehicle Data')
    expect(vehicle.getByText('83 km/h')).toBeInTheDocument()
    expect(vehicle.getByText('1,350 rpm')).toBeInTheDocument()
    expect(vehicle.getByText('11')).toBeInTheDocument()
    expect(vehicle.getByText('413 l · 52 %')).toBeInTheDocument()
    expect(vehicle.getByLabelText('Calculated by RoadPilot from game values')).toBeInTheDocument()
    expect(vehicle.getByText('Running')).toBeInTheDocument()
    expect(vehicle.getByText('88 °C')).toBeInTheDocument()
    expect(vehicle.getByText('1,240 km')).toBeInTheDocument()
    expect(vehicle.getByText('60 l')).toBeInTheDocument()
    expect(vehicle.getByText('102 °C')).toBeInTheDocument()
    expect(vehicle.getByText('24.1 V')).toBeInTheDocument()
  })

  it('shows driving dynamics, navigation, job and environment', async () => {
    const { send } = setup()
    await send(live())
    const dynamics = card('Driving Dynamics')
    expect(dynamics.getByText('-1.3 m/s²')).toBeInTheDocument()
    expect(dynamics.getByText('40 %')).toBeInTheDocument()
    expect(dynamics.getByText('25 %')).toBeInTheDocument()
    expect(dynamics.getByText('12 % right')).toBeInTheDocument()
    expect(dynamics.getByText('On · 80 km/h')).toBeInTheDocument()

    const navigation = card('Navigation')
    expect(navigation.getByText('510 km')).toBeInTheDocument()
    expect(navigation.getByText('≈ 6 h 40 min')).toBeInTheDocument()
    expect(navigation.getByText('90 km/h')).toBeInTheDocument()

    const job = card('Current Job')
    expect(job.getByText('Berlin → Wien')).toBeInTheDocument()
    expect(job.getByText('Machinery')).toBeInTheDocument()
    expect(job.getByText('18,000 kg')).toBeInTheDocument()
    expect(job.getByText('€31,000')).toBeInTheDocument()
    expect(job.getByText('Today, 18:05')).toBeInTheDocument()

    const route = card('Route Progress')
    expect(route.getByText('≈ 25 %')).toBeInTheDocument()
    expect(route.getByText('510 km remaining')).toBeInTheDocument()

    const environment = card('Environment')
    expect(environment.getByText('09:20')).toBeInTheDocument()
    expect(environment.getAllByText('Not provided by the game')).toHaveLength(2)
  })

  it('shows live world position and orientation with the SDK convention', async () => {
    const { send } = setup()
    await send(live())
    const position = card('Vehicle Position')
    expect(position.getByText('1,200.5 m')).toBeInTheDocument()
    expect(position.getByText('-3,400.3 m')).toBeInTheDocument()
    expect(position.getByText('90°')).toBeInTheDocument()
    expect(
      position.getByText('Game world coordinates · heading counterclockwise from north.'),
    ).toBeInTheDocument()
  })

  it('marks every value the game does not provide as not available', async () => {
    const { send } = setup()
    const data = emptyData()
    data.vehicle.speedKmh = 50
    await send(live(data))
    expect(card('Vehicle Data').getByText('50 km/h')).toBeInTheDocument()
    expect(card('Vehicle Data').getAllByText('Not available')).toHaveLength(12)
    expect(card('Driving Dynamics').getAllByText('Not available')).toHaveLength(5)
    expect(card('Navigation').getAllByText('Not available')).toHaveLength(3)
    expect(card('Vehicle Position').getAllByText('Not available')).toHaveLength(6)
    expect(card('Current Job').getByText('Not available')).toBeInTheDocument()
    // No demo job is mixed into live data.
    expect(screen.queryByText('Hamburg → Praha')).not.toBeInTheDocument()
    expect(screen.queryByText('80 km/h')).not.toBeInTheDocument()
  })

  it('shows job states from the game', async () => {
    const { send } = setup()
    const none = fullData()
    none.job = { ...emptyData().job, state: 'none' }
    await send(live(none))
    expect(card('Current Job').getByText('No active job')).toBeInTheDocument()

    const delivered = fullData()
    delivered.job = { ...delivered.job, state: 'delivered', deliveredRevenue: 32000 }
    await send(live(delivered))
    expect(card('Current Job').getByText('Job delivered')).toBeInTheDocument()
    expect(card('Current Job').getByText('€32,000')).toBeInTheDocument()
  })

  it('updates values as new telemetry arrives', async () => {
    const { send } = setup()
    await send(live())
    const reversing = fullData()
    Object.assign(reversing.vehicle, { speedKmh: -6.2, engineRpm: 900, gear: -1 })
    await send(live(reversing))
    expect(card('Vehicle Data').getByText('6 km/h')).toBeInTheDocument()
    expect(card('Vehicle Data').getByText('R1')).toBeInTheDocument()
    const neutral = fullData()
    Object.assign(neutral.vehicle, { speedKmh: 0, gear: 0 })
    await send(live(neutral))
    expect(card('Vehicle Data').getByText('N')).toBeInTheDocument()
  })

  it('clears live values when the connection is interrupted', async () => {
    const { send } = setup()
    await send(live())
    await send({ status: 'reconnecting', game: 'ets2' })
    expect(badge()).toHaveTextContent('ETS2 Reconnecting…')
    expect(screen.getByText('Telemetry interrupted')).toBeInTheDocument()
    expect(card('Vehicle Data').queryByText('83 km/h')).not.toBeInTheDocument()
    expect(card('Vehicle Data').getAllByText('No data')).toHaveLength(13)
    expect(card('Driving Dynamics').getAllByText('No data')).toHaveLength(5)
    expect(card('Environment').getAllByText('No data')).toHaveLength(3)
  })

  it('returns to labelled demo data after the game exits', async () => {
    const { send } = setup()
    await send(live())
    await send({ status: 'disconnected' })
    expect(badge()).toHaveTextContent('Game not running')
    expect(screen.getByText('Demo data')).toBeInTheDocument()
    expect(card('Vehicle Data').getByText('80 km/h')).toBeInTheDocument()
    expect(screen.getByText('Hamburg → Praha', { selector: '.job-route' })).toBeInTheDocument()
  })

  it('explains unavailable telemetry and endpoint errors', async () => {
    const { send } = setup()
    await send({ status: 'unavailable', game: 'ets2' })
    expect(badge()).toHaveTextContent('ETS2 Telemetry unavailable')
    expect(screen.getByText(/RoadPilot telemetry plugin is installed/)).toBeInTheDocument()
    await send({ status: 'error', error: 'pipe busy' })
    expect(badge()).toHaveTextContent('Telemetry error')
    expect(screen.getByText(/Another telemetry reader may be running/)).toBeInTheDocument()
  })

  it('shows a paused game as paused', async () => {
    const { send } = setup()
    await send({ ...live(), paused: true })
    expect(badge()).toHaveTextContent('ETS2 Paused')
  })
})
