import {
  Cog,
  Fuel,
  Gauge,
  Navigation,
  Power,
  Settings2,
  Thermometer,
  Battery,
  OctagonMinus,
} from 'lucide-react'
import { useDashboard } from '@/state/DashboardProvider'
import { useI18n } from '@/i18n'
import { Card } from '../components/controls'
import { Row, useValueText } from './rows'

export function VehicleDataCard() {
  const { t, formatNumber } = useI18n()
  const { vehicle } = useDashboard().snapshot
  const show = useValueText(vehicle !== null)
  const gearText = (gear: number) =>
    gear === 0
      ? t('vehicle.gear.neutral')
      : gear < 0
        ? t('vehicle.gear.reverse', { gear: -gear })
        : String(gear)
  const fuelText = (litres: number) =>
    vehicle?.fuelPercent != null
      ? t('vehicle.fuel.withPercent', {
          litres: formatNumber(Math.round(litres)),
          percent: formatNumber(Math.round(vehicle.fuelPercent)),
        })
      : t('vehicle.fuel.value', { litres: formatNumber(Math.round(litres)) })

  return (
    <Card title={t('vehicle.title')}>
      <ul className="rows">
        <Row
          icon={<Gauge size={18} />}
          label={t('vehicle.speed')}
          value={show(
            vehicle?.speedKmh,
            (v) => `${formatNumber(Math.round(Math.abs(v)))} ${t('unit.kmh')}`,
          )}
        />
        <Row
          icon={<Cog size={18} />}
          label={t('vehicle.rpm')}
          value={show(vehicle?.engineRpm, (v) => `${formatNumber(Math.round(v))} ${t('unit.rpm')}`)}
        />
        <Row
          icon={<Settings2 size={18} />}
          label={t('vehicle.gear')}
          value={show(vehicle?.gear, gearText)}
        />
        <Row
          icon={<Navigation size={18} />}
          label={t('vehicle.cruise')}
          value={show(vehicle?.cruiseControl, (on) =>
            t(on ? 'vehicle.cruise.on' : 'vehicle.cruise.off'),
          )}
        />
        <Row
          icon={<Fuel size={18} />}
          label={t('vehicle.fuel')}
          value={show(vehicle?.fuelL, fuelText)}
          calculated={vehicle?.fuelL != null && vehicle.fuelPercent != null}
        />
        <Row
          icon={<Power size={18} />}
          label={t('vehicle.engine')}
          value={show(vehicle?.engineRunning, (on) =>
            t(on ? 'vehicle.engine.running' : 'vehicle.engine.off'),
          )}
        />
        <Row
          icon={<Thermometer size={18} />}
          label={t('vehicle.temperature')}
          value={show(vehicle?.waterTemperatureC, (v) =>
            t('vehicle.temperature.value', { value: formatNumber(Math.round(v)) }),
          )}
        />
        <Row
          icon={<Navigation size={18} />}
          label={t('vehicle.fuelRange')}
          value={show(vehicle?.fuelRangeKm, (v) =>
            t('vehicle.range.value', { value: formatNumber(Math.round(v)) }),
          )}
        />
        <Row
          icon={<Fuel size={18} />}
          label={t('vehicle.adblue')}
          value={show(vehicle?.adblueL, (v) =>
            t('vehicle.adblue.value', { value: formatNumber(Math.round(v)) }),
          )}
        />
        <Row
          icon={<Thermometer size={18} />}
          label={t('vehicle.oilTemperature')}
          value={show(vehicle?.oilTemperatureC, (v) =>
            t('vehicle.temperature.value', { value: formatNumber(Math.round(v)) }),
          )}
        />
        <Row
          icon={<Battery size={18} />}
          label={t('vehicle.voltage')}
          value={show(vehicle?.batteryVoltageV, (v) =>
            t('vehicle.voltage.value', { value: formatNumber(Math.round(v * 10) / 10) }),
          )}
        />
        <Row
          icon={<OctagonMinus size={18} />}
          label={t('vehicle.parkingBrake')}
          value={show(vehicle?.parkingBrake, (on) =>
            t(on ? 'vehicle.cruise.on' : 'vehicle.cruise.off'),
          )}
        />
        <Row
          icon={<Settings2 size={18} />}
          label={t('vehicle.retarder')}
          value={show(vehicle?.retarderLevel, (v) => formatNumber(v))}
        />
      </ul>
    </Card>
  )
}
