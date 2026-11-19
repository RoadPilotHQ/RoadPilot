import { ArrowRight, Truck } from 'lucide-react'
import type { ReactNode } from 'react'
import { useDashboard } from '@/state/DashboardProvider'
import { jobView, knownJobMarket, type JobStatus, type JobView } from '@/domain/job'
import type { Reading } from '@/domain/reading'
import type { DeadlineValue } from '@/domain/types'
import * as units from '@/domain/units'
import { Card } from '../components/controls'
import { formatCurrency, formatDuration } from '../format'
import { useLink, useUnitSystem } from '../useLink'
import { useVehicleFormat } from '../vehicle/format'

const STATUS_CLASS: Record<JobStatus, string> = {
  none: 'job-status-none',
  active: 'job-status-active',
  delivered: 'job-status-delivered',
  cancelled: 'job-status-cancelled',
  unknown: 'job-status-unknown',
}

/**
 * The current job, compact. Read-only and exactly as the game reports it: four job states,
 * plus "Unavailable" when the telemetry says nothing about jobs.
 */
export function CurrentJob() {
  const { snapshot } = useDashboard()
  const f = useVehicleFormat()
  const job = jobView(snapshot, useLink())

  return (
    <Card label={f.t('job.title')} className="job">
      <div className="job-head">
        <h2 className="card-title">{f.t('job.title')}</h2>
        <span className={`tag job-status ${STATUS_CLASS[job.status]}`}>
          {f.t(`job.status.${job.status}`)}
        </span>
        {job.demo ? (
          <span className="tag tag-demo" title={f.t('vehicle.demoHint')}>
            {f.t('vehicle.demo')}
          </span>
        ) : null}
      </div>
      {job.status === 'unknown' ? (
        <p className="note">
          {f.t(
            job.unknownReason === 'notReported' ? 'job.unknown.notReported' : 'job.unknown.noData',
          )}
        </p>
      ) : job.status === 'none' ? (
        <p className="note">{f.t('job.none.hint')}</p>
      ) : (
        <JobDetails job={job} />
      )}
    </Card>
  )
}

function JobDetails({ job }: { job: JobView }) {
  const f = useVehicleFormat()
  const { locale } = f
  const system = useUnitSystem()
  const text = (r: Reading<string>) => f.reading(r, (v) => v)
  const currency = job.read('currency')
  const money = (r: Reading<number>) =>
    currency.kind !== 'value'
      ? f.reading(currency, () => '')
      : f.reading(r, (v) => formatCurrency(v, currency.value, locale))
  const cargoLoaded = job.read('cargoLoaded')
  const remaining = job.read('timeToDeadlineMin')
  const market = job.read('jobMarket')

  const [moneyLabel, moneyValue] =
    job.status === 'delivered'
      ? [f.t('job.revenue'), job.read('deliveredRevenue')]
      : job.status === 'cancelled'
        ? [f.t('job.penalty'), job.read('cancelPenalty')]
        : [f.t('job.income'), job.read('income')]

  return (
    <>
      <div className="job-places">
        <Place
          label={f.t('job.from')}
          city={job.read('sourceCity')}
          company={job.read('sourceCompany')}
        />
        <ArrowRight size={18} className="icon-orange job-arrow" aria-hidden />
        <Place
          label={f.t('job.to')}
          city={job.read('destinationCity')}
          company={job.read('destinationCompany')}
        />
      </div>
      <dl className="job-facts">
        <Fact label={f.t('job.cargo')} reading={job.read('cargo')} value={text(job.read('cargo'))}>
          {cargoLoaded.kind === 'value'
            ? f.t(cargoLoaded.value ? 'job.cargo.loaded' : 'job.cargo.notLoaded')
            : null}
        </Fact>
        <Fact
          label={f.t('job.weight')}
          reading={job.read('cargoMassKg')}
          value={f.reading(job.read('cargoMassKg'), (kg) => f.measure(units.mass(kg, system)))}
        />
        <Fact label={moneyLabel} reading={moneyValue} value={money(moneyValue)} />
        <Fact
          label={f.t('job.deadline')}
          reading={job.read('deadline')}
          value={f.reading(job.read('deadline'), (d) => deadlineText(f.t, d))}
        >
          {job.status === 'active' && remaining.kind === 'value'
            ? f.t(
                remaining.value >= 0 ? 'job.deadline.left' : 'job.deadline.late',
                formatDuration(Math.abs(remaining.value)),
              )
            : null}
        </Fact>
        <Fact
          label={f.t('job.damage')}
          reading={job.read('cargoDamagePercent')}
          value={f.reading(job.read('cargoDamagePercent'), (p) =>
            f.t('vehicle.fuel.percent', { value: f.number(p, 1) }),
          )}
        />
        <Fact
          label={f.t('job.market')}
          reading={market}
          value={f.reading(market, (token) => {
            const known = knownJobMarket(token)
            return known ? f.t(`job.market.${known}`) : token
          })}
        />
      </dl>
      {job.status === 'cancelled' ? <p className="note">{f.t('job.cancelled.hint')}</p> : null}
    </>
  )
}

function deadlineText(t: ReturnType<typeof useVehicleFormat>['t'], d: DeadlineValue): string {
  if (d.dayOffset <= 0) return t('job.deadline.today', { time: d.time })
  if (d.dayOffset === 1) return t('job.deadline.tomorrow', { time: d.time })
  return t('job.deadline.inDays', { days: d.dayOffset, time: d.time })
}

function Place({
  label,
  city,
  company,
}: {
  label: string
  city: Reading<string>
  company: Reading<string>
}) {
  const f = useVehicleFormat()
  return (
    <div className="job-place" title={f.t('job.localizedHint')}>
      <span className="label">{label}</span>
      <span className={`job-city value-${city.kind}`}>{f.reading(city, (v) => v)}</span>
      <span className={`job-company value-${company.kind}`}>
        <Truck size={12} aria-hidden /> {f.reading(company, (v) => v)}
      </span>
    </div>
  )
}

function Fact({
  label,
  reading,
  value,
  children,
}: {
  label: string
  reading: Reading<unknown>
  value: string
  children?: ReactNode
}) {
  return (
    <div>
      <dt>{label}</dt>
      <dd className={`value-${reading.kind}`}>{value}</dd>
      {children ? <dd className="sub">{children}</dd> : null}
    </div>
  )
}
