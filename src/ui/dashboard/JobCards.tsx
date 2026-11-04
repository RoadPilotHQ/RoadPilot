import { Clock, Truck } from 'lucide-react'
import type { DeadlineValue, JobData } from '@/domain/types'
import { useDashboard } from '@/state/DashboardProvider'
import { useI18n } from '@/i18n'
import { Card } from '../components/controls'
import { clampPercent, formatCurrency, formatDuration } from '../format'

function useDeadlineText() {
  const { t } = useI18n()
  return (deadline: DeadlineValue): string => {
    if (deadline.dayOffset <= 0) return t('job.deadline.today', { time: deadline.time })
    if (deadline.dayOffset === 1) return t('job.deadline.tomorrow', { time: deadline.time })
    return t('job.deadline.inDays', { days: deadline.dayOffset, time: deadline.time })
  }
}

/** Text for a job without details: none, delivered, cancelled, or unknown. */
function useJobStatusText() {
  const { t } = useI18n()
  const { mode } = useDashboard().snapshot
  return (job: JobData | null): string => {
    if (!job) return mode === 'live' ? t('common.unavailable') : t('job.none')
    if (job.state === 'delivered') return t('job.delivered')
    if (job.state === 'cancelled') return t('job.cancelled')
    return t('job.none')
  }
}

export function CurrentJobCard() {
  const { t, formatNumber, locale } = useI18n()
  const { job } = useDashboard().snapshot
  const deadlineText = useDeadlineText()
  const statusText = useJobStatusText()
  const unavailable = t('common.unavailable')
  const money = (value: number | null) =>
    value != null && job?.currency ? formatCurrency(value, job.currency, locale) : unavailable

  if (!job || job.state === 'none') {
    return (
      <Card title={t('job.title')} className="job-card">
        <p className="note">{statusText(job)}</p>
      </Card>
    )
  }

  const finished = job.state === 'delivered' || job.state === 'cancelled'
  return (
    <Card title={t('job.title')} className="job-card">
      <div className="job-route">
        <Truck size={18} className="icon-orange" aria-hidden />
        {t('job.route', {
          origin: job.origin ?? unavailable,
          destination: job.destination ?? unavailable,
        })}
        {finished ? <span className="tag">{statusText(job)}</span> : null}
      </div>
      <dl className="facts">
        <div>
          <dt>{t('job.cargo')}</dt>
          <dd>{job.cargo ?? unavailable}</dd>
        </div>
        <div>
          <dt>{t('job.weight')}</dt>
          <dd>
            {job.weightKg != null
              ? `${formatNumber(Math.round(job.weightKg))} ${t('unit.kg')}`
              : unavailable}
          </dd>
        </div>
        <div>
          <dt>{job.state === 'delivered' ? t('job.revenue') : t('job.income')}</dt>
          <dd>
            {money(job.state === 'delivered' && job.revenue != null ? job.revenue : job.income)}
          </dd>
        </div>
        <div>
          <dt>{t('job.deadline')}</dt>
          <dd>{job.deadline ? deadlineText(job.deadline) : unavailable}</dd>
        </div>
      </dl>
    </Card>
  )
}

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
