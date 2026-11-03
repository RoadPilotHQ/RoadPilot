import { Cog, Gauge, Navigation, Settings2 } from 'lucide-react'
import type { ReactNode } from 'react'
import { useDashboard } from '@/state/DashboardProvider'
import { useI18n } from '@/i18n'
import { Card } from '../components/controls'

function Row({ icon, label, value }: { icon: ReactNode; label: string; value: string }) {
  return (
    <li className="row">
      <span className="row-icon" aria-hidden>
        {icon}
      </span>
      <span className="row-label">{label}</span>
      <span className="row-value">{value}</span>
    </li>
  )
}

export function VehicleDataCard() {
  const { t, formatNumber } = useI18n()
  const { vehicle } = useDashboard().snapshot
  const none = t('common.noData')
  const unavailable = t('common.unavailable')
  /** No vehicle at all: "No data". One missing value: "Not available". */
  const show = <T,>(value: T | null | undefined, format: (v: T) => string) =>
    !vehicle ? none : value == null ? unavailable : format(value)
  const gearText = (gear: number) =>
    gear === 0
      ? t('vehicle.gear.neutral')
      : gear < 0
        ? t('vehicle.gear.reverse', { gear: -gear })
        : String(gear)

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
      </ul>
    </Card>
  )
}
