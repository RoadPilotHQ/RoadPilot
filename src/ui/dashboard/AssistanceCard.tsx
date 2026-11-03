import { ArrowLeftRight, CarFront, Gauge, OctagonAlert, ScanEye, TriangleAlert } from 'lucide-react'
import type { ComponentType } from 'react'
import { ASSISTANCE_SYSTEMS, type AssistanceSystem } from '@/domain/types'
import { useDashboard } from '@/state/DashboardProvider'
import { useI18n } from '@/i18n'
import { Card, Toggle } from '../components/controls'

const ICONS: Record<AssistanceSystem, ComponentType<{ size?: number }>> = {
  laneDepartureWarning: ArrowLeftRight,
  collisionWarning: TriangleAlert,
  trafficSignRecognition: ScanEye,
  adaptiveCruiseControl: Gauge,
  driverAssistance: CarFront,
  autoBraking: OctagonAlert,
}

export function AssistanceCard() {
  const { t } = useI18n()
  const { snapshot, preferences, setAssistanceSystem } = useDashboard()

  return (
    <Card title={t('assist.title')}>
      <ul className="rows">
        {ASSISTANCE_SYSTEMS.map((system) => {
          const Icon = ICONS[system]
          const label = t(`assist.${system}`)
          const unavailable = snapshot.availability.assistance[system] === 'unavailable'
          return (
            <li key={system} className="row">
              <span className="row-icon" aria-hidden>
                <Icon size={18} />
              </span>
              <span className="row-label">
                {label}
                {unavailable ? <span className="tag">{t('assist.unavailable')}</span> : null}
              </span>
              <Toggle
                label={label}
                checked={preferences.assistance[system]}
                onChange={(on) => setAssistanceSystem(system, on)}
              />
            </li>
          )
        })}
      </ul>
      <p className="note">{t('assist.preferenceNote')}</p>
    </Card>
  )
}
