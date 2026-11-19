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
const panel = (name: string) => within(card('Vehicle Data').getByRole('region', { name }))
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
    expect(panel('Speed').getByText('83')).toBeInTheDocument()
    expect(panel('Speed').getByText('km/h')).toBeInTheDocument()
    expect(panel('Engine speed and gear').getByText('1,350 rpm')).toBeInTheDocument()
    expect(panel('Engine speed and gear').getByText('11')).toBeInTheDocument()
    const fuel = panel('Fuel')
    expect(fuel.getByText('413 l of 800 l')).toBeInTheDocument()
    expect(fuel.getByText('52 %')).toBeInTheDocument()
    expect(fuel.getByLabelText('Calculated by RoadPilot from game values')).toBeInTheDocument()
    expect(fuel.getByText('1,240 km')).toBeInTheDocument()
    expect(fuel.getByText('60 l')).toBeInTheDocument()
    const engine = panel('Engine')
    expect(engine.getByText('Running')).toBeInTheDocument()
    expect(engine.getByText('88 °C')).toBeInTheDocument()
    expect(engine.getByText('102 °C')).toBeInTheDocument()
    expect(engine.getByText('24.1 V')).toBeInTheDocument()
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

    const route = card('Route Information')
    expect(route.getByText('510 km')).toBeInTheDocument()
    expect(route.getByText('≈ 6 h 40 min')).toBeInTheDocument()
    expect(route.getByText('90 km/h')).toBeInTheDocument()
    expect(route.getByText('≈ 25 %')).toBeInTheDocument()

    const job = card('Current Job')
    expect(job.getByText('Berlin')).toBeInTheDocument()
    expect(job.getByText('Wien')).toBeInTheDocument()
    expect(job.getByText('Machinery')).toBeInTheDocument()
    expect(job.getByText('18,000 kg')).toBeInTheDocument()
    expect(job.getByText('€31,000')).toBeInTheDocument()
    expect(job.getByText('Today, 18:05')).toBeInTheDocument()

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
    expect(panel('Speed').getByText('50')).toBeInTheDocument()
    // Every supported vehicle value except the speed; the three values the telemetry does
    // not carry at all are labelled differently.
    expect(card('Vehicle Data').getAllByText('Not available')).toHaveLength(24)
    expect(card('Vehicle Data').getAllByText('Not provided by the telemetry')).toHaveLength(3)
    expect(card('Driving Dynamics').getAllByText('Not available')).toHaveLength(5)
    // Five route rows and the progress.
    expect(card('Route Information').getAllByText('Not available')).toHaveLength(6)
    expect(card('Vehicle Position').getAllByText('Not available')).toHaveLength(6)
    expect(card('Current Job').getByText('Unavailable')).toBeInTheDocument()
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
    expect(card('Current Job').getByText('Delivered')).toBeInTheDocument()
    expect(card('Current Job').getByText('€32,000')).toBeInTheDocument()
  })

  it('updates values as new telemetry arrives', async () => {
    const { send } = setup()
    await send(live())
    const reversing = fullData()
    Object.assign(reversing.vehicle, { speedKmh: -6.2, engineRpm: 900, gear: -1 })
    await send(live(reversing))
    expect(panel('Speed').getByText('6')).toBeInTheDocument()
    expect(panel('Speed').getByText('Reversing')).toBeInTheDocument()
    expect(panel('Engine speed and gear').getByText('R1')).toBeInTheDocument()
    expect(panel('Engine speed and gear').getByText('Reverse')).toBeInTheDocument()
    const neutral = fullData()
    Object.assign(neutral.vehicle, { speedKmh: 0, gear: 0 })
    await send(live(neutral))
    expect(panel('Speed').getByText('0')).toBeInTheDocument()
    expect(panel('Engine speed and gear').getByText('N')).toBeInTheDocument()
    expect(panel('Engine speed and gear').getByText('Neutral')).toBeInTheDocument()
  })

  it('clears live values when the connection is interrupted', async () => {
    const { send } = setup()
    await send(live())
    await send({ status: 'reconnecting', game: 'ets2' })
    expect(badge()).toHaveTextContent('ETS2 Reconnecting…')
    expect(screen.getByText('Telemetry interrupted')).toBeInTheDocument()
    expect(
      within(screen.getByRole('group', { name: 'Telemetry link' })).getByText('Stale'),
    ).toBeInTheDocument()
    expect(panel('Speed').queryByText('83')).not.toBeInTheDocument()
    expect(panel('Speed').getAllByText('No data')).toHaveLength(2)
    // No vehicle value of the interrupted session remains on screen.
    expect(card('Vehicle Data').queryAllByText(/^-?\d/)).toHaveLength(0)
    expect(card('Vehicle Data').getAllByText('No data')).toHaveLength(29)
    expect(card('Driving Dynamics').getAllByText('No data')).toHaveLength(5)
    expect(card('Environment').getAllByText('No data')).toHaveLength(3)
  })

  it('returns to labelled demo data after the game exits', async () => {
    const { send } = setup()
    await send(live())
    await send({ status: 'disconnected' })
    expect(badge()).toHaveTextContent('Game not running')
    expect(screen.getByText('Demo data')).toBeInTheDocument()
    expect(panel('Speed').getByText('80')).toBeInTheDocument()
    expect(card('Vehicle Data').getByText('Demo')).toBeInTheDocument()
    expect(card('Current Job').getByText('Hamburg')).toBeInTheDocument()
    expect(card('Current Job').getByText('Demo')).toBeInTheDocument()
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
