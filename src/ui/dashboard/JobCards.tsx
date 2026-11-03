import { Clock, Truck } from 'lucide-react'
import type { DeadlineValue } from '@/domain/types'
import { useDashboard } from '@/state/DashboardProvider'
import { useI18n } from '@/i18n'
import { Card } from '../components/controls'
import { clampPercent, formatCurrency, formatDuration } from '../format'

function useDeadlineText() {
  const { t } = useI18n()
  return (deadline: DeadlineValue | null): string => {
    if (!deadline) return t('common.noData')
    if (deadline.dayOffset <= 0) return t('job.deadline.today', { time: deadline.time })
    if (deadline.dayOffset === 1) return t('job.deadline.tomorrow', { time: deadline.time })
    return t('job.deadline.inDays', { days: deadline.dayOffset, time: deadline.time })
  }
}

export function CurrentJobCard() {
  const { t, formatNumber, locale } = useI18n()
  const { job } = useDashboard().snapshot
  const deadlineText = useDeadlineText()

  return (
    <Card title={t('job.title')} className="job-card">
      {job ? (
        <>
          <div className="job-route">
            <Truck size={18} className="icon-orange" aria-hidden />
            {t('job.route', { origin: job.origin, destination: job.destination })}
          </div>
          <dl className="facts">
            <div>
              <dt>{t('job.cargo')}</dt>
              <dd>{job.cargo}</dd>
            </div>
            <div>
              <dt>{t('job.weight')}</dt>
              <dd>
                {formatNumber(job.weightKg)} {t('unit.kg')}
              </dd>
            </div>
            <div>
              <dt>{t('job.income')}</dt>
              <dd>{formatCurrency(job.income, job.currency, locale)}</dd>
            </div>
            <div>
              <dt>{t('job.deadline')}</dt>
              <dd>{deadlineText(job.deadline)}</dd>
            </div>
          </dl>
        </>
      ) : (
        <p className="note">{t('job.none')}</p>
      )}
    </Card>
  )
}

export function RouteProgressCard() {
  const { t, formatNumber } = useI18n()
  const { job } = useDashboard().snapshot

  if (!job) {
    return (
      <Card title={t('route.title')}>
        <p className="note">{t('common.noData')}</p>
      </Card>
    )
  }
  const percent = clampPercent(job.progressPercent)
  const duration = formatDuration(job.remainingMinutes)

  return (
    <Card label={t('route.title')} className="route-card">
      <div className="route-head">
        <h2 className="card-title">{t('route.title')}</h2>
        <span className="route-percent">{Math.round(percent)} %</span>
      </div>
      <div
        className="progress"
        role="progressbar"
        aria-label={t('route.progress')}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(percent)}
      >
        <div className="progress-fill" style={{ width: `${percent}%` }} />
      </div>
      <div className="route-foot">
        <span>
          {t('route.remaining', { distance: `${formatNumber(job.remainingKm)} ${t('unit.km')}` })}
        </span>
        <span className="route-eta">
          <Clock size={16} aria-hidden />
          {t('route.eta', duration)}
        </span>
      </div>
    </Card>
  )
}
