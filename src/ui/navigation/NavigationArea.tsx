import { useState } from 'react'
import { useDashboard, usePathTrace } from '@/state/DashboardProvider'
import * as units from '@/domain/units'
import { Card, Segmented } from '../components/controls'
import { link } from '@/domain/vehicle'
import { useUnitSystem } from '../useLink'
import { useNow } from '../vehicle/useNow'
import { useVehicleFormat } from '../vehicle/format'
import { MapPackagePanel } from './MapPackagePanel'
import { PathCanvas } from './PathCanvas'
import { scaleBar, type View, type ViewMode } from './pathView'

const MODES: readonly ViewMode[] = ['follow', 'fit']

/**
 * The navigation area. In this phase it shows only the path the truck has traveled, traced
 * from telemetry positions: no roads, no map, no route and no destination.
 */
export function NavigationArea() {
  const { snapshot } = useDashboard()
  const trace = usePathTrace()
  const now = useNow()
  const current = link(snapshot, now)
  const f = useVehicleFormat()
  const system = useUnitSystem()
  const [mode, setMode] = useState<ViewMode>('follow')
  const hasTrace = trace.last !== null
  const stale = hasTrace && current.state !== 'connected'

  const empty =
    snapshot.mode === 'demo'
      ? f.t('navigation.empty.demo')
      : current.state !== 'connected'
        ? f.t('navigation.empty.noData')
        : f.t('navigation.empty.noPosition')

  const staleAge = trace.last ? f.age(Math.max(0, now - trace.last.atUnixMs)) : null

  const renderScale = (view: View, size: { width: number }) => {
    const metric = system === 'metric'
    const short = metric ? 1 : 0.3048
    const long = metric ? 1000 : 1609.344
    let bar = scaleBar(view, size.width, short)
    let label = f.measure(units.length(bar.units * short, system))
    if (bar.units * short >= long) {
      bar = scaleBar(view, size.width, long)
      label = f.measure(units.distance((bar.units * long) / 1000, system))
    }
    return (
      <div className="path-scale" aria-label={f.t('navigation.scale', { value: label })}>
        <span className="path-scale-bar" style={{ width: `${bar.px}px` }} />
        <span>{label}</span>
      </div>
    )
  }

  return (
    <Card label={f.t('navigation.title')} className="navigation">
      <div className="navigation-head">
        <h2 className="card-title">{f.t('navigation.title')}</h2>
        <span className="tag" title={f.t('navigation.note')}>
          {f.t('navigation.traceTag')}
        </span>
        <div className="navigation-mode">
          <Segmented<ViewMode>
            label={f.t('navigation.view')}
            value={mode}
            onChange={setMode}
            options={MODES.map((m) => ({ value: m, label: f.t(`navigation.view.${m}`) }))}
          />
        </div>
      </div>
      <div className="navigation-stage">
        <PathCanvas
          trace={trace}
          mode={mode}
          stale={stale}
          label={f.t('navigation.canvasLabel', { count: trace.points })}
          overlay={renderScale}
        />
        {!hasTrace ? <p className="navigation-empty">{empty}</p> : null}
        {stale ? (
          <p className="navigation-stale">{f.t('navigation.stale', { age: staleAge ?? '' })}</p>
        ) : null}
      </div>
      <div className="navigation-foot">
        <span className="legend legend-start">{f.t('navigation.legend.start')}</span>
        <span className="legend legend-current">{f.t('navigation.legend.current')}</span>
        <span>{f.t('navigation.points', { count: f.number(trace.points) })}</span>
        {trace.rejected > 0 ? (
          <span className="value-invalid">
            {f.t('navigation.rejected', { count: f.number(trace.rejected) })}
          </span>
        ) : null}
      </div>
      <p className="note">{f.t('navigation.note')}</p>
      <MapPackagePanel />
    </Card>
  )
}
