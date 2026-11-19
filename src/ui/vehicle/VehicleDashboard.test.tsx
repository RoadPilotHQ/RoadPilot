import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { TelemetryData, TelemetryUpdate } from '@/domain/telemetry'
import { createTelemetrySource, type TelemetryBridge } from '@/backend/telemetrySource'
import { LOCAL_STALE_AFTER_MS } from '@/domain/vehicle'
import { App } from '@/app/App'
import { emptyData, fullData, update } from '@/test/telemetryFixtures'
import css from '@/theme/theme.css?raw'

/** Renders the app with a telemetry source driven by synthetic test updates. */
function setup() {
  let handler: ((u: TelemetryUpdate) => void) | null = null
  const bridge: TelemetryBridge = {
    listen: async (_event, h) => {
      handler = h
      return () => {}
    },
    getSnapshot: () => new Promise(() => {}),
  }
  render(<App source={createTelemetrySource(bridge)} />)
  const send = async (overrides: Partial<TelemetryUpdate>) => {
    await act(async () => {
      await Promise.resolve()
      handler?.(update(overrides))
    })
  }
  return { send }
}

const vehicle = () => within(screen.getByRole('region', { name: 'Vehicle Data' }))
const panel = (name: string) => within(vehicle().getByRole('region', { name }))
const strip = () => within(vehicle().getByRole('group', { name: 'Telemetry link' }))

const connected = (game: 'ets2' | 'ats', data: TelemetryData = fullData()) => ({
  status: 'connected' as const,
  game,
  data,
})

/** A complete truck: every vehicle value the telemetry can provide. */
function completeTruck(): TelemetryData {
  const d = fullData()
  Object.assign(d.vehicle, {
    speedKmh: 96.56064, // 60 mph
    displayedGear: 11,
    electricOn: true,
    fuelConsumptionLPer100km: 35,
    fuelWarning: false,
    fuelRangeKm: 1609.344, // 1,000 mi
    adblueCapacityL: 80,
    oilPressurePsi: 55,
    brakeAirPressurePsi: 120,
    brakeTemperatureC: 45,
    odometerKm: 160934.4, // 100,000 mi
    rpmLimit: 2500,
    forwardGears: 12,
    reverseGears: 2,
    engineBrake: true,
    retarderSteps: 3,
    brand: 'Test',
    model: 'Truck',
  })
  return d
}

afterEach(() => {
  vi.useRealTimers()
})

describe('vehicle data dashboard', () => {
  it('labels demo values as demo data and states that no game is connected', () => {
    setup()
    expect(vehicle().getByText('Demo')).toBeInTheDocument()
    expect(strip().getByText('Disconnected')).toBeInTheDocument()
    expect(strip().getByText('Demo data · not from a game')).toBeInTheDocument()
    expect(panel('Data source').getAllByText('Sample values')).toHaveLength(2)
  })

  it('shows every available ETS2 value in metric units, by priority', async () => {
    const { send } = setup()
    await send(connected('ets2', completeTruck()))
    expect(vehicle().queryByText('Demo')).not.toBeInTheDocument()
    expect(vehicle().getByText('Test Truck')).toBeInTheDocument()
    expect(strip().getByText('Connected')).toBeInTheDocument()
    expect(strip().getByText('Euro Truck Simulator 2')).toBeInTheDocument()
    expect(strip().getByText(/^Last update .* ago$/)).toBeInTheDocument()

    const speed = panel('Speed')
    expect(speed.getByText('97')).toBeInTheDocument()
    expect(speed.getByText('km/h')).toBeInTheDocument()
    expect(speed.getByText('≈ 60 mph')).toBeInTheDocument()
    expect(speed.getByText('Set to 80 km/h')).toBeInTheDocument()

    const power = panel('Engine speed and gear')
    expect(power.getByText('1,350 rpm')).toBeInTheDocument()
    expect(power.getByRole('meter', { name: 'Engine speed' })).toHaveAttribute(
      'aria-valuemax',
      '2500',
    )
    expect(power.getByText('Limit 2,500 rpm')).toBeInTheDocument()
    expect(power.getAllByText('11')).toHaveLength(2)
    expect(power.getByText('Forward')).toBeInTheDocument()
    expect(power.getByText('12 forward · 2 reverse')).toBeInTheDocument()

    const fuel = panel('Fuel')
    expect(fuel.getByRole('meter', { name: 'Fuel level' })).toHaveAttribute('aria-valuenow', '51.6')
    expect(fuel.getByText('413 l of 800 l')).toBeInTheDocument()
    expect(fuel.getByText('35.0 l/100 km')).toBeInTheDocument()
    expect(fuel.getByText('1,609 km')).toBeInTheDocument()
    expect(fuel.getByText('No warning')).toBeInTheDocument()
    expect(fuel.getByText('60 l of 80 l')).toBeInTheDocument()

    const engine = panel('Engine')
    expect(engine.getByText('Running')).toBeInTheDocument()
    expect(engine.getByText('88 °C')).toBeInTheDocument()
    expect(engine.getByText('3.8 bar')).toBeInTheDocument()

    const chassis = panel('Vehicle and brakes')
    expect(chassis.getByText('160,934 km')).toBeInTheDocument()
    expect(chassis.getByText('Released')).toBeInTheDocument()
    expect(chassis.getByText('25 %')).toBeInTheDocument()
    expect(chassis.getByText('On')).toBeInTheDocument()
    expect(chassis.getByText('Level 2 of 3')).toBeInTheDocument()
    expect(chassis.getByText('8.3 bar')).toBeInTheDocument()
    expect(chassis.getByText('45 °C')).toBeInTheDocument()

    const source = panel('Data source')
    expect(source.getByText('1.21')).toBeInTheDocument()
    expect(source.getByText('2')).toBeInTheDocument()
    expect(source.getByText('None')).toBeInTheDocument()
    expect(source.getByText('Metric (follows the game)')).toBeInTheDocument()
  })

  it('switches between ATS and ETS2 with the units following the game', async () => {
    const { send } = setup()
    await send(connected('ats', completeTruck()))
    expect(strip().getByText('American Truck Simulator')).toBeInTheDocument()
    expect(panel('Speed').getByText('60')).toBeInTheDocument()
    expect(panel('Speed').getByText('mph')).toBeInTheDocument()
    expect(panel('Speed').getByText('≈ 97 km/h')).toBeInTheDocument()
    expect(panel('Fuel').getByText('109 gal of 211 gal')).toBeInTheDocument()
    expect(panel('Fuel').getByText('6.7 mpg')).toBeInTheDocument()
    expect(panel('Fuel').getByText('1,000 mi')).toBeInTheDocument()
    expect(panel('Engine').getByText('190 °F')).toBeInTheDocument()
    expect(panel('Engine').getByText('55 psi')).toBeInTheDocument()
    expect(panel('Vehicle and brakes').getByText('100,000 mi')).toBeInTheDocument()
    expect(panel('Data source').getByText('US customary (follows the game)')).toBeInTheDocument()

    // The game exits and ETS2 starts.
    await send({ status: 'disconnected' })
    expect(strip().getByText('Disconnected')).toBeInTheDocument()
    await send({ status: 'connecting', game: 'ets2' })
    expect(strip().getByText('Connecting')).toBeInTheDocument()
    expect(strip().getByText('Waiting for the first frame')).toBeInTheDocument()
    await send(connected('ets2', completeTruck()))
    expect(strip().getByText('Euro Truck Simulator 2')).toBeInTheDocument()
    expect(panel('Speed').getByText('97')).toBeInTheDocument()
    expect(panel('Speed').getByText('km/h')).toBeInTheDocument()
  })

  it('keeps an explicit unit choice for both games', async () => {
    const { send } = setup()
    await send(connected('ats', completeTruck()))
    fireEvent.click(vehicle().getByRole('radio', { name: 'Metric' }))
    expect(panel('Speed').getByText('km/h')).toBeInTheDocument()
    expect(panel('Data source').getByText('Metric')).toBeInTheDocument()
    fireEvent.click(vehicle().getByRole('radio', { name: 'US' }))
    await send(connected('ets2', completeTruck()))
    expect(panel('Speed').getByText('mph')).toBeInTheDocument()
  })

  it('separates invalid, missing and unsupported values', async () => {
    const { send } = setup()
    const data = completeTruck()
    Object.assign(data.vehicle, { engineRpm: null, fuelL: null, fuelPercent: null })
    data.source.invalidFields = ['truck.engineRpm', 'truck.fuelL']
    data.vehicle.odometerKm = null
    await send(connected('ets2', data))
    expect(panel('Engine speed and gear').getByText('Invalid value')).toBeInTheDocument()
    expect(panel('Engine speed and gear').queryByRole('meter')).not.toBeInTheDocument()
    expect(panel('Fuel').getAllByText('Invalid value')).toHaveLength(2)
    expect(panel('Fuel').queryByRole('meter')).not.toBeInTheDocument()
    expect(panel('Vehicle and brakes').getByText('Not available')).toBeInTheDocument()
    expect(panel('Engine').getByText('Not provided by the telemetry')).toBeInTheDocument()
    expect(panel('Data source').getByText('2 in this frame')).toHaveAttribute(
      'title',
      'truck.engineRpm, truck.fuelL',
    )
  })

  it('never shows an impossible value as a number', async () => {
    const { send } = setup()
    const data = completeTruck()
    Object.assign(data.vehicle, { speedKmh: Number.NaN, fuelPercent: 250, gear: 1.5 })
    await send(connected('ets2', data))
    expect(panel('Speed').getByText('Invalid value')).toBeInTheDocument()
    expect(panel('Fuel').getByText('Invalid value')).toBeInTheDocument()
    expect(panel('Engine speed and gear').getAllByText('Invalid value')).toHaveLength(2)
  })

  it('shows schema 1 telemetry as speed, RPM and gear only', async () => {
    const { send } = setup()
    const data = emptyData()
    data.source.schemaVersion = 1
    data.source.gameVersion = null
    Object.assign(data.vehicle, { speedKmh: 36, engineRpm: 900, gear: 3 })
    await send(connected('ats', data))
    expect(panel('Data source').getByText('1 · speed, RPM and gear only')).toBeInTheDocument()
    expect(panel('Speed').getByText('22')).toBeInTheDocument()
    expect(panel('Engine speed and gear').getByText('900 rpm')).toBeInTheDocument()
    expect(panel('Fuel').getAllByText('Not available').length).toBeGreaterThan(0)
  })

  it('turns stale when updates stop, and clears values when the backend reports it', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] })
    vi.setSystemTime(1_800_000_000_000)
    const { send } = setup()
    await send(connected('ets2', fullData()))
    expect(strip().getByText('Connected')).toBeInTheDocument()

    act(() => {
      vi.advanceTimersByTime(LOCAL_STALE_AFTER_MS + 600)
    })
    expect(strip().getByText('Stale')).toBeInTheDocument()
    expect(strip().getByText(/^Last data .* · 3\.\d s ago$/)).toBeInTheDocument()
    expect(panel('Speed').queryByText('83')).not.toBeInTheDocument()
    expect(panel('Speed').getAllByText('No data').length).toBeGreaterThan(0)

    // The backend's own verdict; the last frame's age keeps counting.
    await send({ status: 'reconnecting', game: 'ets2' })
    act(() => {
      vi.advanceTimersByTime(60_000)
    })
    expect(strip().getByText('Stale')).toBeInTheDocument()
    expect(strip().getByText(/^Last data .* · 64 s ago$/)).toBeInTheDocument()

    // A new frame recovers the link.
    await send(connected('ets2', fullData()))
    expect(strip().getByText('Connected')).toBeInTheDocument()
    expect(panel('Speed').getByText('83')).toBeInTheDocument()
  })

  it('keeps a paused game connected with its last values', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] })
    const { send } = setup()
    await send({ ...connected('ets2', fullData()), paused: true })
    act(() => {
      vi.advanceTimersByTime(30_000)
    })
    expect(strip().getByText('Connected')).toBeInTheDocument()
    expect(strip().getByText('Game paused')).toBeInTheDocument()
    expect(panel('Speed').getByText('83')).toBeInTheDocument()
  })

  it('reports telemetry errors with their cause', async () => {
    const { send } = setup()
    await send({ status: 'unavailable', game: 'ats' })
    expect(strip().getByText('Error')).toBeInTheDocument()
    expect(strip().getByText('No telemetry from the game')).toBeInTheDocument()
    await send({ status: 'error', error: 'pipe busy' })
    expect(strip().getByText('Error')).toBeInTheDocument()
    expect(strip().getByText('pipe busy')).toBeInTheDocument()
    // Demo values stay labelled as such during an error.
    expect(vehicle().getByText('Demo')).toBeInTheDocument()
  })
})

describe('vehicle data layout at small window sizes', () => {
  const block = (query: string) => {
    const start = css.indexOf(`@media (${query})`)
    expect(start).toBeGreaterThan(-1)
    const rest = css.slice(start)
    const end = rest.indexOf('\n}\n')
    return rest.slice(0, end)
  }

  it('uses three columns on wide windows, two below 1000 px and one below 720 px', () => {
    expect(css).toMatch(
      /\.vehicle-grid \{[^}]*grid-template-columns: minmax\(0, 1fr\) minmax\(0, 1\.1fr\) minmax\(0, 1\.1fr\)/,
    )
    const medium = [...css.matchAll(/@media \(max-width: 1000px\) \{[\s\S]*?\n\}\n/g)].map(
      (m) => m[0],
    )
    expect(
      medium.some((b) =>
        /\.vehicle-grid \{\s*grid-template-columns: repeat\(2, minmax\(0, 1fr\)\)/.test(b),
      ),
    ).toBe(true)
    const small = [...css.matchAll(/@media \(max-width: 720px\) \{[\s\S]*?\n\}\n/g)].map(
      (m) => m[0],
    )
    expect(
      small.some((b) => /\.vehicle-grid \{\s*grid-template-columns: minmax\(0, 1fr\)/.test(b)),
    ).toBe(true)
    expect(block('max-width: 720px')).toBeTruthy()
  })

  it('lets panels shrink instead of overflowing and scales the speed readout', () => {
    expect(css).toMatch(/\.vehicle-panel \{[^}]*min-width: 0/)
    expect(css).toMatch(/\.speed-value \{[^}]*font-size: clamp\(/)
  })
})
