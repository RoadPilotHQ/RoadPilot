import { CircleGauge, Flag, MapPin, Route, Timer } from 'lucide-react'
import { useDashboard } from '@/state/DashboardProvider'
import { routeView, type Provenance, type Sourced } from '@/domain/route'
import * as units from '@/domain/units'
import { Card } from '../components/controls'
import { formatDuration } from '../format'
import { useLink, useUnitSystem } from '../useLink'
import { useVehicleFormat } from '../vehicle/format'
import { Meter, ValueRow } from '../vehicle/parts'

const ICON = 18

/** Where a value comes from, next to its label. Nothing for unavailable values. */
function SourceTag({ source }: { source: Provenance }) {
  const f = useVehicleFormat()
  if (source === 'unavailable') return null
  return (
    <span
      className={`tag source-tag source-${source}`}
      title={f.t(source === 'game' ? 'route.source.gameHint' : 'route.source.calculatedHint')}
    >
      {f.t(source === 'game' ? 'route.source.game' : 'route.source.calculated')}
    </span>
  )
}

/**
 * Route information from the in-game Route Advisor, plus approximate values calculated from
 * it. RoadPilot plans no route and gives no directions.
 */
export function RouteInfo() {
  const { snapshot } = useDashboard()
  const f = useVehicleFormat()
  const system = useUnitSystem()
  const route = routeView(snapshot, useLink())
  const km = (v: number) => f.measure(units.distance(v, system))
  const row = <T,>(r: Sourced<T>, format: (v: T) => string) => ({
    state: r.reading.kind,
    value: f.reading(r.reading, format),
    badge: <SourceTag source={r.source} />,
  })
  const progress = route.progressPercent.reading
  const noJob = f.t('route.noActiveJob')
  const jobRow = <T,>(r: Sourced<T>, format: (v: T) => string) =>
    route.noActiveJob && r.reading.kind !== 'noData'
      ? { state: 'missing' as const, value: noJob, badge: null }
      : row(r, format)

  return (
    <Card label={f.t('route.title')} className="route-info">
      <div className="route-info-head">
        <h2 className="card-title">{f.t('route.title')}</h2>
        {route.demo ? (
          <span className="tag tag-demo" title={f.t('vehicle.demoHint')}>
            {f.t('vehicle.demo')}
          </span>
        ) : null}
      </div>
      <div className="route-progress">
        <div className="route-progress-head">
          <span className="label">{f.t('route.progress')}</span>
          <span className={`route-percent value-${progress.kind}`}>
            {route.noActiveJob && progress.kind !== 'noData'
              ? noJob
              : f.reading(progress, (p) => f.t('route.percent', { value: f.number(p) }))}
          </span>
          <SourceTag source={route.progressPercent.source} />
        </div>
        {progress.kind === 'value' ? (
          <Meter
            label={f.t('route.progress')}
            value={progress.value}
            max={100}
            text={f.t('route.percent', { value: f.number(progress.value) })}
          />
        ) : null}
      </div>
      <ul className="rows">
        <ValueRow
          icon={<MapPin size={ICON} />}
          label={f.t('route.remainingDistance')}
          {...row(route.remainingDistanceKm, km)}
        />
        <ValueRow
          icon={<Timer size={ICON} />}
          label={f.t('route.remainingTime')}
          hint={f.t('route.timeScaleHint')}
          {...row(route.remainingTimeMin, (min) => f.t('route.eta', formatDuration(min)))}
        />
        <ValueRow
          icon={<CircleGauge size={ICON} />}
          label={f.t('route.speedLimit')}
          {...row(route.speedLimit, (l) =>
            l.kind === 'none'
              ? f.t('navigation.speedLimit.none')
              : f.measure(units.speed(l.kmh, system)),
          )}
        />
        <ValueRow
          icon={<Flag size={ICON} />}
          label={f.t('route.jobDistance')}
          {...jobRow(route.jobDistanceKm, km)}
        />
        <ValueRow
          icon={<Route size={ICON} />}
          label={f.t('route.drivenDistance')}
          {...jobRow(route.drivenDistanceKm, (v) => `≈ ${km(v)}`)}
        />
      </ul>
      <p className="note">{f.t('route.note')}</p>
    </Card>
  )
}
