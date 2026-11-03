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

  return (
    <Card title={t('vehicle.title')}>
      <ul className="rows">
        <Row
          icon={<Gauge size={18} />}
          label={t('vehicle.speed')}
          value={vehicle ? `${formatNumber(vehicle.speedKmh)} ${t('unit.kmh')}` : none}
        />
        <Row
          icon={<Cog size={18} />}
          label={t('vehicle.rpm')}
          value={vehicle ? `${formatNumber(vehicle.engineRpm)} ${t('unit.rpm')}` : none}
        />
        <Row
          icon={<Settings2 size={18} />}
          label={t('vehicle.gear')}
          value={vehicle ? String(vehicle.gear) : none}
        />
        <Row
          icon={<Navigation size={18} />}
          label={t('vehicle.cruise')}
          value={
            vehicle ? t(vehicle.cruiseControl ? 'vehicle.cruise.on' : 'vehicle.cruise.off') : none
          }
        />
      </ul>
    </Card>
  )
}
