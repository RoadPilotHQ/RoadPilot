import { act, render, screen, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import type { TelemetryUpdate } from '@/domain/types'
import { createTelemetrySource, type TelemetryBridge } from '@/backend/telemetrySource'
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
  const send = async (update: Partial<TelemetryUpdate>) => {
    await act(async () => {
      await Promise.resolve()
      handler?.({
        status: 'disconnected',
        game: null,
        paused: false,
        vehicle: null,
        error: null,
        ...update,
      })
    })
  }
  return { send }
}

const vehicleCard = () => screen.getByRole('region', { name: 'Vehicle Data' })
const badge = () => screen.getByRole('status')

const live = {
  status: 'connected' as const,
  game: 'ets2' as const,
  vehicle: { speedKmh: 83.4, engineRpm: 1350.4, gear: 11 },
}

describe('dashboard with live telemetry', () => {
  it('shows demo mode before any backend state arrives', () => {
    setup()
    expect(badge()).toHaveTextContent('Game not running')
    expect(screen.getByText('Demo data')).toBeInTheDocument()
  })

  it('shows the connecting state with demo data and a reason', async () => {
    const { send } = setup()
    await send({ status: 'connecting', game: 'ats' })
    expect(badge()).toHaveTextContent('ATS Connecting…')
    expect(screen.getByText('Demo data')).toBeInTheDocument()
    expect(screen.getByText('Waiting for the first telemetry data from ATS.')).toBeInTheDocument()
  })

  it('switches to live data when connected and marks missing values', async () => {
    const { send } = setup()
    await send(live)
    expect(badge()).toHaveTextContent('ETS2 Connected')
    expect(screen.getByText('Live data')).toBeInTheDocument()
    expect(screen.queryByText('Demo data')).not.toBeInTheDocument()
    const card = within(vehicleCard())
    expect(card.getByText('83 km/h')).toBeInTheDocument()
    expect(card.getByText('1,350 rpm')).toBeInTheDocument()
    expect(card.getByText('11')).toBeInTheDocument()
    // Cruise control is not part of telemetry protocol v1.
    expect(card.getByText('Not available')).toBeInTheDocument()
    // No demo job is mixed into live data.
    expect(screen.queryByText('Hamburg → Praha')).not.toBeInTheDocument()
  })

  it('updates values as new telemetry arrives', async () => {
    const { send } = setup()
    await send(live)
    await send({ ...live, vehicle: { speedKmh: -6.2, engineRpm: 900, gear: -1 } })
    const card = within(vehicleCard())
    expect(card.getByText('6 km/h')).toBeInTheDocument()
    expect(card.getByText('R1')).toBeInTheDocument()
    await send({ ...live, vehicle: { speedKmh: 0, engineRpm: 650, gear: 0 } })
    expect(within(vehicleCard()).getByText('N')).toBeInTheDocument()
  })

  it('clears live values when the connection is interrupted', async () => {
    const { send } = setup()
    await send(live)
    await send({ status: 'reconnecting', game: 'ets2' })
    expect(badge()).toHaveTextContent('ETS2 Reconnecting…')
    expect(screen.getByText('Telemetry interrupted')).toBeInTheDocument()
    expect(within(vehicleCard()).queryByText('83 km/h')).not.toBeInTheDocument()
    expect(within(vehicleCard()).getAllByText('No data').length).toBe(4)
  })

  it('returns to labelled demo data after the game exits', async () => {
    const { send } = setup()
    await send(live)
    await send({ status: 'disconnected' })
    expect(badge()).toHaveTextContent('Game not running')
    expect(screen.getByText('Demo data')).toBeInTheDocument()
    expect(within(vehicleCard()).getByText('80 km/h')).toBeInTheDocument()
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
    await send({ ...live, paused: true })
    expect(badge()).toHaveTextContent('ETS2 Paused')
  })
})
