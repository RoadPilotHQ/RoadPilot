import { Clock } from 'lucide-react'
import { useDashboard } from '@/state/DashboardProvider'
import { useI18n } from '@/i18n'
import { Card } from '../components/controls'
import { clampPercent, formatDuration } from '../format'

export function RouteProgressCard() {
  const { t, formatNumber } = useI18n()
  const { job, mode } = useDashboard().snapshot

  if (!job || job.state !== 'active') {
    return (
      <Card title={t('route.title')}>
        <p className="note">{mode === 'live' ? t('common.unavailable') : t('common.noData')}</p>
      </Card>
    )
  }
  const percent = job.progressPercent != null ? clampPercent(job.progressPercent) : null
  const unavailable = t('common.unavailable')

  return (
    <Card label={t('route.title')} className="route-card">
      <div className="route-head">
        <h2 className="card-title">{t('route.title')}</h2>
        <span
          className="route-percent"
          title={mode === 'live' && percent != null ? t('route.approximate') : undefined}
        >
          {percent != null ? `${mode === 'live' ? '≈ ' : ''}${Math.round(percent)} %` : unavailable}
        </span>
      </div>
      <div
        className="progress"
        role="progressbar"
        aria-label={t('route.progress')}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent != null ? Math.round(percent) : undefined}
      >
        <div className="progress-fill" style={{ width: `${percent ?? 0}%` }} />
      </div>
      <div className="route-foot">
        <span>
          {job.remainingKm != null
            ? t('route.remaining', {
                distance: `${formatNumber(Math.round(job.remainingKm))} ${t('unit.km')}`,
              })
            : unavailable}
        </span>
        <span className="route-eta">
          <Clock size={16} aria-hidden />
          {job.remainingMinutes != null
            ? t('route.eta', formatDuration(job.remainingMinutes))
            : unavailable}
        </span>
      </div>
    </Card>
  )
}
