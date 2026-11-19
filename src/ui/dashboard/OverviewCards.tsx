import { Gauge } from 'lucide-react'
import { SteeringWheel } from '../components/SteeringWheel'
import { useDashboard } from '@/state/DashboardProvider'
import { useI18n } from '@/i18n'

export function OverviewCards() {
  const { t, formatNumber } = useI18n()
  const { snapshot } = useDashboard()
  const { vehicle, autopilotActive, mode } = snapshot
  const noData = t('common.noData')
  // In live mode a missing value means the telemetry does not provide it.
  const missing = mode === 'live' && vehicle ? t('common.unavailable') : noData

  return (
    <div className="overview">
      <div className="card overview-card">
        <SteeringWheel
          size={38}
          className={autopilotActive ? 'icon-green' : 'icon-muted'}
          aria-hidden
        />
        <div>
          <div className="label">{t('overview.autopilot')}</div>
          <div className={`overview-value ${autopilotActive ? 'text-green' : 'text-muted'}`}>
            {autopilotActive ? t('overview.autopilot.active') : t('overview.autopilot.inactive')}
          </div>
        </div>
      </div>

      <div className="card overview-card">
        <Gauge size={38} className="icon-orange" aria-hidden />
        <div>
          <div className="label">{t('overview.speed')}</div>
          {vehicle?.speedKmh != null ? (
            <>
              <div className="overview-value">
                {formatNumber(Math.round(Math.abs(vehicle.speedKmh)))} {t('unit.kmh')}
              </div>
              {vehicle.targetSpeedKmh != null ? (
                <div className="sub">
                  {t('overview.speed.target', { value: formatNumber(vehicle.targetSpeedKmh) })}
                </div>
              ) : null}
            </>
          ) : (
            <div className="overview-value text-muted">{missing}</div>
          )}
        </div>
      </div>
    </div>
  )
}
