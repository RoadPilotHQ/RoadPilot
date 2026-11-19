import {
  Battery,
  CircleGauge,
  Cog,
  Droplets,
  Fuel,
  Gauge,
  Info,
  Lightbulb,
  OctagonMinus,
  Power,
  Settings2,
  Thermometer,
  TriangleAlert,
  Truck,
} from 'lucide-react'
import { useDashboard } from '@/state/DashboardProvider'
import type { DashboardSnapshot, UnitPreference, VehicleData, VehicleField } from '@/domain/types'
import { UNIT_PREFERENCES } from '@/domain/types'
import * as units from '@/domain/units'
import type { UnitSystem } from '@/domain/units'
import { link, readVehicle, valuesCurrent, type Link, type Reading } from '@/domain/vehicle'
import { Card, Segmented } from '../components/controls'
import { useVehicleFormat } from './format'
import { Meter, Panel, ValueRow, type ValueState } from './parts'
import { useNow } from './useNow'

interface View {
  snapshot: DashboardSnapshot
  link: Link
  system: UnitSystem
  /** Whether the values may be shown as current (live and connected, or labelled demo). */
  current: boolean
  read: <K extends VehicleField>(field: K) => Reading<NonNullable<VehicleData[K]>>
}

const ICON = 18

/**
 * Vehicle data from ETS2/ATS telemetry, read-only. Ordered by priority: speed, engine speed
 * and gear, fuel, engine and vehicle state, then the data source.
 */
export function VehicleDashboard() {
  const { snapshot, preferences, setUnits } = useDashboard()
  const f = useVehicleFormat()
  const now = useNow()
  const current = link(snapshot, now)
  const shown = valuesCurrent(snapshot, current)
  const view: View = {
    snapshot,
    link: current,
    system: units.resolveUnitSystem(preferences.units, snapshot.game),
    current: shown,
    read: (field) => readVehicle(snapshot, field, shown),
  }
  const demo = snapshot.mode === 'demo'
  const truck = [snapshot.vehicle?.brand, snapshot.vehicle?.model].filter(Boolean).join(' ')

  return (
    <Card label={f.t('vehicle.title')} className={`vehicle${demo ? ' vehicle-demo' : ''}`}>
      <div className="vehicle-head">
        <h2 className="card-title">{f.t('vehicle.title')}</h2>
        {demo ? (
          <span className="tag tag-demo" title={f.t('vehicle.demoHint')}>
            {f.t('vehicle.demo')}
          </span>
        ) : null}
        {truck && shown ? <span className="vehicle-truck">{truck}</span> : null}
        <div className="vehicle-units">
          <Segmented<UnitPreference>
            label={f.t('vehicle.units')}
            value={preferences.units}
            onChange={setUnits}
            options={UNIT_PREFERENCES.map((u) => ({ value: u, label: f.t(`vehicle.units.${u}`) }))}
          />
        </div>
      </div>
      <LinkStrip view={view} />
      <div className="vehicle-grid">
        <SpeedPanel view={view} />
        <PowertrainPanel view={view} />
        <FuelPanel view={view} />
        <EnginePanel view={view} />
        <ChassisPanel view={view} />
        <SourcePanel view={view} />
      </div>
    </Card>
  )
}

function LinkStrip({ view }: { view: View }) {
  const f = useVehicleFormat()
  const { snapshot, link: l } = view
  const game = snapshot.game ? f.t(`link.game.${snapshot.game}`) : f.t('link.game.none')
  const frameAt = snapshot.telemetry?.receivedAtUnixMs ?? snapshot.lastFrameAtUnixMs
  const timed = (key: 'link.updated' | 'link.lastData') =>
    frameAt != null && l.ageMs != null
      ? f.t(key, { time: f.clock(frameAt), age: f.age(l.ageMs) })
      : null

  let detail: string
  if (snapshot.mode === 'demo' && l.state === 'disconnected') detail = f.t('link.demo')
  else if (l.state === 'connected') detail = timed('link.updated') ?? f.t('link.waiting')
  else if (l.state === 'stale') detail = timed('link.lastData') ?? f.t('link.noNewData')
  else if (l.state === 'connecting') detail = f.t('link.waiting')
  else if (l.state === 'error')
    detail =
      snapshot.connection === 'unavailable' ? f.t('link.noTelemetry') : (snapshot.error ?? '')
  else detail = f.t('link.demo')

  return (
    <div className={`link link-${l.state}`} role="group" aria-label={f.t('link.label')}>
      <span className="link-state">
        <span className="link-dot" aria-hidden />
        {f.t(`link.${l.state}`)}
      </span>
      {l.paused ? <span className="tag">{f.t('link.paused')}</span> : null}
      <span className="link-game">{game}</span>
      {detail ? <span className="link-detail">{detail}</span> : null}
    </div>
  )
}

function stateOf(r: Reading<unknown>): ValueState {
  return r.kind
}

function SpeedPanel({ view }: { view: View }) {
  const f = useVehicleFormat()
  const speed = view.read('speedKmh')
  const cruise = view.read('cruiseControl')
  const target = view.read('targetSpeedKmh')
  const other: UnitSystem = view.system === 'metric' ? 'imperial' : 'metric'
  const main = speed.kind === 'value' ? units.speed(Math.abs(speed.value), view.system) : null

  return (
    <Panel title={f.t('vehicle.speed')} className="vehicle-speed">
      <div className="speed-readout">
        {main ? (
          <>
            <span className="speed-value">{f.number(main.value)}</span>
            <span className="speed-unit">{f.t(main.unit)}</span>
          </>
        ) : (
          <span className={`speed-missing value-${stateOf(speed)}`}>
            {f.reading(speed, () => '')}
          </span>
        )}
      </div>
      <div className="speed-meta">
        {speed.kind === 'value' ? (
          <span>
            {f.t('vehicle.speed.other', {
              value: f.measure(units.speed(Math.abs(speed.value), other)),
            })}
          </span>
        ) : null}
        {speed.kind === 'value' && speed.value < -0.5 ? (
          <span className="tag">{f.t('vehicle.speed.reverse')}</span>
        ) : null}
      </div>
      <ul className="rows">
        <ValueRow
          icon={<Gauge size={ICON} />}
          label={f.t('vehicle.cruise')}
          state={stateOf(cruise)}
          value={f.reading(cruise, (on) =>
            on && target.kind === 'value'
              ? f.t('vehicle.cruise.set', {
                  value: f.measure(units.speed(target.value, view.system)),
                })
              : f.t(on ? 'vehicle.cruise.on' : 'vehicle.cruise.off'),
          )}
        />
      </ul>
    </Panel>
  )
}

function PowertrainPanel({ view }: { view: View }) {
  const f = useVehicleFormat()
  const rpm = view.read('engineRpm')
  const limit = view.read('rpmLimit')
  const gear = view.read('gear')
  const displayed = view.read('displayedGear')
  const forward = view.read('forwardGears')
  const reverse = view.read('reverseGears')
  const rpmText = (v: number) => `${f.number(v)} ${f.t('unit.rpm')}`

  return (
    <Panel title={f.t('vehicle.powertrain')} className="vehicle-powertrain">
      <div className="powertrain-main">
        <div className="gear-box">
          <span className="label">{f.t('vehicle.gear')}</span>
          <span className={`gear-value value-${stateOf(gear)}`}>{f.reading(gear, f.gear)}</span>
        </div>
        <div className="rpm-box">
          <span className="label">{f.t('vehicle.rpm')}</span>
          <span className={`rpm-value value-${stateOf(rpm)}`}>{f.reading(rpm, rpmText)}</span>
          {rpm.kind === 'value' && limit.kind === 'value' ? (
            <>
              <Meter
                label={f.t('vehicle.rpm')}
                value={rpm.value}
                max={limit.value}
                text={rpmText(rpm.value)}
                warn={rpm.value > limit.value * 0.9}
              />
              <span className="sub">
                {f.t('vehicle.rpm.limit', { value: f.number(limit.value) })}
              </span>
            </>
          ) : null}
        </div>
      </div>
      <ul className="rows">
        <ValueRow
          icon={<Settings2 size={ICON} />}
          label={f.t('vehicle.gear.status')}
          state={stateOf(gear)}
          value={f.reading(gear, (g) =>
            f.t(
              g > 0
                ? 'vehicle.gear.forward'
                : g < 0
                  ? 'vehicle.gear.reverseName'
                  : 'vehicle.gear.neutralName',
            ),
          )}
        />
        <ValueRow
          icon={<Settings2 size={ICON} />}
          label={f.t('vehicle.gear.displayed')}
          state={stateOf(displayed)}
          value={f.reading(displayed, f.gear)}
        />
        <ValueRow
          icon={<Cog size={ICON} />}
          label={f.t('vehicle.gearbox')}
          state={forward.kind === 'value' ? 'value' : stateOf(forward)}
          value={f.reading(forward, (fw) =>
            f.t('vehicle.gearbox.value', {
              forward: fw,
              reverse: reverse.kind === 'value' ? reverse.value : '–',
            }),
          )}
        />
        <ValueRow
          icon={<Cog size={ICON} />}
          label={f.t('vehicle.transmissionMode')}
          state="unsupported"
          value={f.t('reading.unsupported')}
        />
      </ul>
    </Panel>
  )
}

function FuelPanel({ view }: { view: View }) {
  const f = useVehicleFormat()
  const fuel = view.read('fuelL')
  const capacity = view.read('fuelCapacityL')
  const percent = view.read('fuelPercent')
  const consumption = view.read('fuelConsumptionLPer100km')
  const range = view.read('fuelRangeKm')
  const warning = view.read('fuelWarning')
  const adblue = view.read('adblueL')
  const adblueCapacity = view.read('adblueCapacityL')
  const vol = (l: number) => f.measure(units.volume(l, view.system))
  const amount = (value: number, cap: Reading<number>) =>
    cap.kind === 'value'
      ? f.t('vehicle.fuel.ofCapacity', { amount: vol(value), capacity: vol(cap.value) })
      : vol(value)
  const low = warning.kind === 'value' && warning.value

  return (
    <Panel title={f.t('vehicle.fuel')} className="vehicle-fuel">
      <div className="fuel-head">
        <span className={`fuel-percent value-${stateOf(percent)}`}>
          {f.reading(percent, (p) => f.t('vehicle.fuel.percent', { value: f.number(p) }))}
          {percent.kind === 'value' ? (
            <span className="calc-mark" aria-label={f.t('common.calculated')}>
              *
            </span>
          ) : null}
        </span>
        {low ? (
          <span className="tag tag-warn">
            <TriangleAlert size={12} aria-hidden /> {f.t('vehicle.fuel.warning')}
          </span>
        ) : null}
      </div>
      {percent.kind === 'value' ? (
        <Meter
          label={f.t('vehicle.fuel.level')}
          value={percent.value}
          max={100}
          text={f.t('vehicle.fuel.percent', { value: f.number(percent.value) })}
          warn={low}
        />
      ) : null}
      <ul className="rows">
        <ValueRow
          icon={<Fuel size={ICON} />}
          label={f.t('vehicle.fuel.amount')}
          state={stateOf(fuel)}
          value={f.reading(fuel, (l) => amount(l, capacity))}
        />
        <ValueRow
          icon={<Gauge size={ICON} />}
          label={f.t('vehicle.fuel.consumption')}
          state={stateOf(consumption)}
          hint={consumption.kind === 'value' ? f.t('vehicle.fuel.gameValue') : undefined}
          value={f.reading(consumption, (c) => {
            const m = units.consumption(c, view.system)
            return m ? f.measure(m, 1) : f.t('reading.missing')
          })}
        />
        <ValueRow
          icon={<CircleGauge size={ICON} />}
          label={f.t('vehicle.fuel.range')}
          state={stateOf(range)}
          hint={range.kind === 'value' ? f.t('vehicle.fuel.gameValue') : undefined}
          value={f.reading(range, (km) => f.measure(units.distance(km, view.system)))}
        />
        <ValueRow
          icon={<TriangleAlert size={ICON} />}
          label={f.t('vehicle.fuel.warning')}
          state={stateOf(warning)}
          value={f.reading(warning, (on) =>
            f.t(on ? 'vehicle.fuel.warning.on' : 'vehicle.fuel.warning.off'),
          )}
        />
        <ValueRow
          icon={<Droplets size={ICON} />}
          label={f.t('vehicle.adblue')}
          state={stateOf(adblue)}
          value={f.reading(adblue, (l) => amount(l, adblueCapacity))}
        />
      </ul>
    </Panel>
  )
}

function EnginePanel({ view }: { view: View }) {
  const f = useVehicleFormat()
  const running = view.read('engineRunning')
  const electric = view.read('electricOn')
  const water = view.read('waterTemperatureC')
  const oil = view.read('oilTemperatureC')
  const oilPressure = view.read('oilPressurePsi')
  const voltage = view.read('batteryVoltageV')
  const temp = (c: number) => f.measure(units.temperature(c, view.system))
  const approximated = f.t('vehicle.approximated')

  return (
    <Panel title={f.t('vehicle.engine')} className="vehicle-engine">
      <ul className="rows">
        <ValueRow
          icon={<Power size={ICON} />}
          label={f.t('vehicle.engine.state')}
          state={stateOf(running)}
          value={f.reading(running, (on) =>
            f.t(
              on
                ? 'vehicle.engine.running'
                : electric.kind === 'value' && electric.value
                  ? 'vehicle.engine.ignition'
                  : 'vehicle.engine.off',
            ),
          )}
        />
        <ValueRow
          icon={<Thermometer size={ICON} />}
          label={f.t('vehicle.temperature')}
          state={stateOf(water)}
          hint={water.kind === 'value' ? approximated : undefined}
          value={f.reading(water, temp)}
        />
        <ValueRow
          icon={<Thermometer size={ICON} />}
          label={f.t('vehicle.oilTemperature')}
          state={stateOf(oil)}
          hint={oil.kind === 'value' ? approximated : undefined}
          value={f.reading(oil, temp)}
        />
        <ValueRow
          icon={<Droplets size={ICON} />}
          label={f.t('vehicle.oilPressure')}
          state={stateOf(oilPressure)}
          value={f.reading(oilPressure, (psi) => {
            const m = units.pressure(psi, view.system)
            return f.measure(m, m.unit === 'unit.bar' ? 1 : 0)
          })}
        />
        <ValueRow
          icon={<Battery size={ICON} />}
          label={f.t('vehicle.voltage')}
          state={stateOf(voltage)}
          hint={voltage.kind === 'value' ? approximated : undefined}
          value={f.reading(voltage, (v) => `${f.number(v, 1)} ${f.t('unit.volt')}`)}
        />
        <ValueRow
          icon={<Gauge size={ICON} />}
          label={f.t('vehicle.engineLoad')}
          state="unsupported"
          value={f.t('reading.unsupported')}
        />
      </ul>
    </Panel>
  )
}

function ChassisPanel({ view }: { view: View }) {
  const f = useVehicleFormat()
  const odometer = view.read('odometerKm')
  const parking = view.read('parkingBrake')
  const engineBrake = view.read('engineBrake')
  const retarder = view.read('retarderLevel')
  const steps = view.read('retarderSteps')
  const air = view.read('brakeAirPressurePsi')
  const brakeTemp = view.read('brakeTemperatureC')
  const pedalValue = view.snapshot.dynamics?.brake
  const pedal: Reading<number> = !view.current
    ? { kind: 'noData' }
    : pedalValue == null
      ? { kind: 'missing' }
      : { kind: 'value', value: pedalValue }
  const retarderText = (level: number) => {
    if (steps.kind === 'value' && steps.value === 0) return f.t('vehicle.retarder.none')
    if (level === 0) return f.t('vehicle.retarder.off')
    return steps.kind === 'value'
      ? f.t('vehicle.retarder.levelOf', { level, steps: steps.value })
      : f.t('vehicle.retarder.level', { level })
  }

  return (
    <Panel title={f.t('vehicle.chassis')} className="vehicle-chassis">
      <ul className="rows">
        <ValueRow
          icon={<Truck size={ICON} />}
          label={f.t('vehicle.odometer')}
          state={stateOf(odometer)}
          value={f.reading(odometer, (km) => f.measure(units.distance(km, view.system)))}
        />
        <ValueRow
          icon={<OctagonMinus size={ICON} />}
          label={f.t('vehicle.parkingBrake')}
          state={stateOf(parking)}
          value={f.reading(parking, (on) =>
            f.t(on ? 'vehicle.parkingBrake.on' : 'vehicle.parkingBrake.off'),
          )}
        />
        <ValueRow
          icon={<OctagonMinus size={ICON} />}
          label={f.t('vehicle.brakePedal')}
          state={stateOf(pedal)}
          value={f.reading(pedal, (v) =>
            f.t('vehicle.fuel.percent', { value: f.number(Math.abs(v) * 100) }),
          )}
        />
        <ValueRow
          icon={<Cog size={ICON} />}
          label={f.t('vehicle.engineBrake')}
          state={stateOf(engineBrake)}
          value={f.reading(engineBrake, (on) =>
            f.t(on ? 'vehicle.cruise.on' : 'vehicle.cruise.off'),
          )}
        />
        <ValueRow
          icon={<Settings2 size={ICON} />}
          label={f.t('vehicle.retarder')}
          state={stateOf(retarder)}
          value={f.reading(retarder, retarderText)}
        />
        <ValueRow
          icon={<CircleGauge size={ICON} />}
          label={f.t('vehicle.brakeAirPressure')}
          state={stateOf(air)}
          value={f.reading(air, (psi) => {
            const m = units.pressure(psi, view.system)
            return f.measure(m, m.unit === 'unit.bar' ? 1 : 0)
          })}
        />
        <ValueRow
          icon={<Thermometer size={ICON} />}
          label={f.t('vehicle.brakeTemperature')}
          state={stateOf(brakeTemp)}
          value={f.reading(brakeTemp, (c) => f.measure(units.temperature(c, view.system)))}
        />
        <ValueRow
          icon={<Lightbulb size={ICON} />}
          label={f.t('vehicle.lights')}
          state="unsupported"
          value={f.t('reading.unsupported')}
        />
      </ul>
    </Panel>
  )
}

function SourcePanel({ view }: { view: View }) {
  const f = useVehicleFormat()
  const { preferences } = useDashboard()
  const { snapshot } = view
  const meta = snapshot.telemetry
  const live = snapshot.mode === 'live'
  const noData = f.t('reading.noData')
  const systemName = f.t(`vehicle.source.units.${view.system}`)
  const invalid = meta?.invalidFields ?? []

  return (
    <Panel title={f.t('vehicle.source')} className="vehicle-source">
      <ul className="rows">
        <ValueRow
          icon={<Info size={ICON} />}
          label={f.t('vehicle.source.game')}
          state={snapshot.game ? 'value' : 'noData'}
          value={snapshot.game ? f.t(`link.game.${snapshot.game}`) : f.t('link.game.none')}
        />
        <ValueRow
          icon={<Info size={ICON} />}
          label={f.t('vehicle.source.gameVersion')}
          state={meta ? (meta.gameVersion ? 'value' : 'missing') : 'noData'}
          value={
            meta
              ? (meta.gameVersion ?? f.t('reading.missing'))
              : live
                ? noData
                : f.t('vehicle.source.demo')
          }
        />
        <ValueRow
          icon={<Info size={ICON} />}
          label={f.t('vehicle.source.schema')}
          state={meta ? 'value' : 'noData'}
          value={
            meta
              ? meta.schemaVersion === 1
                ? f.t('vehicle.source.schema1')
                : `${meta.schemaVersion}`
              : live
                ? noData
                : f.t('vehicle.source.demo')
          }
        />
        <ValueRow
          icon={<Info size={ICON} />}
          label={f.t('vehicle.source.frame')}
          state={meta ? 'value' : 'noData'}
          value={meta ? `#${meta.sequence}` : noData}
        />
        <ValueRow
          icon={<TriangleAlert size={ICON} />}
          label={f.t('vehicle.source.invalid')}
          state={meta ? 'value' : 'noData'}
          hint={invalid.length > 0 ? invalid.join(', ') : undefined}
          value={
            !meta
              ? noData
              : invalid.length === 0
                ? f.t('vehicle.source.invalid.none')
                : f.t('vehicle.source.invalid.count', { count: invalid.length })
          }
        />
        <ValueRow
          icon={<Gauge size={ICON} />}
          label={f.t('vehicle.source.units')}
          value={
            preferences.units === 'auto'
              ? f.t('vehicle.source.units.auto', { system: systemName })
              : systemName
          }
        />
      </ul>
    </Panel>
  )
}
