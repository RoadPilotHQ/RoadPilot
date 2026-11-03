import { AUTOPILOT_FEATURES, type DrivingDistance } from '@/domain/types'
import { useDashboard } from '@/state/DashboardProvider'
import { useI18n } from '@/i18n'
import { Card, Segmented, Toggle } from '../components/controls'

const DISTANCES: readonly DrivingDistance[] = ['short', 'medium', 'long']

export function AutopilotCard() {
  const { t } = useI18n()
  const { snapshot, preferences, setAutopilotFeature, setDrivingDistance } = useDashboard()

  return (
    <Card title={t('autopilot.title')}>
      <ul className="rows">
        {AUTOPILOT_FEATURES.map((feature) => {
          const label = t(`autopilot.${feature}`)
          const unavailable = snapshot.availability.autopilot[feature] === 'unavailable'
          return (
            <li key={feature} className="row">
              <span className="row-label">
                {label}
                {unavailable ? <span className="tag">{t('assist.unavailable')}</span> : null}
              </span>
              <Toggle
                label={label}
                checked={preferences.autopilot[feature]}
                onChange={(on) => setAutopilotFeature(feature, on)}
              />
            </li>
          )
        })}
      </ul>
      <div className="sub-heading">{t('autopilot.distance')}</div>
      <Segmented
        label={t('autopilot.distance')}
        value={preferences.drivingDistance}
        onChange={setDrivingDistance}
        options={DISTANCES.map((value) => ({ value, label: t(`autopilot.distance.${value}`) }))}
      />
      <p className="note">{t('autopilot.preferenceNote')}</p>
    </Card>
  )
}
