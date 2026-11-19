import { useCallback, useState } from 'react'
import { useDashboard, usePathTrace } from '@/state/DashboardProvider'
import { useMap } from '@/state/MapProvider'
import * as units from '@/domain/units'
import { link } from '@/domain/vehicle'
import { Card, Segmented } from '../components/controls'
import { useUnitSystem } from '../useLink'
import { useNow } from '../vehicle/useNow'
import { useVehicleFormat } from '../vehicle/format'
import { MapPackagePanel, useMapStatusText } from './MapPackagePanel'
import { PathCanvas } from './PathCanvas'
import { scaleBar, type View, type ViewMode } from './pathView'
import { ROAD_STYLES } from './roadPainter'
import { RoadMapView, type MapMode } from './RoadMapView'

type NavView = 'map' | 'path'
const VIEWS: readonly NavView[] = ['map', 'path']
const PATH_MODES: readonly ViewMode[] = ['follow', 'fit']
const MAP_MODES: readonly Exclude<MapMode, 'free'>[] = ['follow', 'fit']
const LEGEND_CLASSES = ['motorway', 'primary', 'local', 'rail'] as const

/**
 * The navigation area, with two separate views:
 * - **Road map:** the real road network of the user's map package, in the package's own
 *   coordinates. The truck and its path are not drawn on it, because whether telemetry and map
 *   coordinates agree is not verified.
 * - **Traveled path:** the path traced from telemetry positions, in telemetry metres, not a map.
 */
export function NavigationArea() {
  const { snapshot } = useDashboard()
  const trace = usePathTrace()
  const { map, game, folder } = useMap()
  const now = useNow()
  const current = link(snapshot, now)
  const f = useVehicleFormat()
  const system = useUnitSystem()
  const mapStatusText = useMapStatusText()
  const [view, setView] = useState<NavView>(map.available ? 'map' : 'path')
  const [pathMode, setPathMode] = useState<ViewMode>('follow')
  const [mapMode, setMapModeState] = useState<MapMode>('fit')
  const setMapMode = useCallback((m: MapMode) => setMapModeState(m), [])
  const hasTrace = trace.last !== null
  const stale = hasTrace && current.state !== 'connected'
  const status = map.status?.game === game ? map.status : null
  const mapReady = status?.state === 'ready' && status.bounds !== null && status.tileSizes !== null

  const empty =
    snapshot.mode === 'demo'
      ? f.t('navigation.empty.demo')
      : current.state !== 'connected'
        ? f.t('navigation.empty.noData')
        : f.t('navigation.empty.noPosition')

  const staleAge = trace.last ? f.age(Math.max(0, now - trace.last.atUnixMs)) : null

  const renderScale = (v: View, size: { width: number }) => {
    const metric = system === 'metric'
    const short = metric ? 1 : 0.3048
    const long = metric ? 1000 : 1609.344
    let bar = scaleBar(v, size.width, short)
    let label = f.measure(units.length(bar.units * short, system))
    if (bar.units * short >= long) {
      bar = scaleBar(v, size.width, long)
      label = f.measure(units.distance((bar.units * long) / 1000, system))
    }
    return (
      <div className="path-scale" aria-label={f.t('navigation.scale', { value: label })}>
        <span className="path-scale-bar" style={{ width: `${bar.px}px` }} />
        <span>{label}</span>
      </div>
    )
  }

  // Centre for "Follow truck" on the map: the telemetry position of the same game only.
  const centre = trace.last && trace.game === game ? { x: trace.last.x, z: trace.last.z } : null
  const showMap = view === 'map'

  return (
    <Card label={f.t('navigation.title')} className="navigation">
      <div className="navigation-head">
        <h2 className="card-title">{f.t('navigation.title')}</h2>
        <span className="tag" title={f.t(showMap ? 'map.note' : 'navigation.note')}>
          {f.t(showMap ? 'map.tag' : 'navigation.traceTag')}
        </span>
        {map.synthetic ? <span className="tag tag-demo">{f.t('map.synthetic')}</span> : null}
        <div className="navigation-controls">
          <Segmented<NavView>
            label={f.t('navigation.show')}
            value={view}
            onChange={setView}
            options={VIEWS.map((v) => ({ value: v, label: f.t(`navigation.show.${v}`) }))}
          />
          {showMap ? (
            <Segmented<Exclude<MapMode, 'free'>>
              label={f.t('navigation.view')}
              value={mapMode === 'free' ? null : mapMode}
              onChange={setMapMode}
              options={MAP_MODES.map((m) => ({ value: m, label: f.t(`map.mode.${m}`) }))}
            />
          ) : (
            <Segmented<ViewMode>
              label={f.t('navigation.view')}
              value={pathMode}
              onChange={setPathMode}
              options={PATH_MODES.map((m) => ({ value: m, label: f.t(`navigation.view.${m}`) }))}
            />
          )}
        </div>
      </div>
      <div className={`navigation-stage${showMap ? ' navigation-stage-map' : ''}`}>
        {showMap ? (
          mapReady ? (
            <RoadMapView
              key={`${game}/${status.contentId}`}
              game={game}
              status={status}
              mode={mapMode}
              onModeChange={setMapMode}
              centre={centre}
            />
          ) : (
            <p className="navigation-empty">
              {!map.available ? (
                f.t('map.unavailable')
              ) : (
                <>
                  <span className="navigation-empty-status">{mapStatusText(status, !!folder)}</span>
                  {status?.state === 'loading' || status?.state === 'selecting' ? null : (
                    <span className="navigation-empty-hint">{f.t('map.emptyHint')}</span>
                  )}
                </>
              )}
            </p>
          )
        ) : (
          <>
            <PathCanvas
              trace={trace}
              mode={pathMode}
              stale={stale}
              label={f.t('navigation.canvasLabel', { count: trace.points })}
              overlay={renderScale}
            />
            {!hasTrace ? <p className="navigation-empty">{empty}</p> : null}
            {stale ? (
              <p className="navigation-stale">{f.t('navigation.stale', { age: staleAge ?? '' })}</p>
            ) : null}
          </>
        )}
      </div>
      {showMap ? (
        <>
          <div className="navigation-foot">
            {LEGEND_CLASSES.map((c) => (
              <span key={c} className="legend-road">
                <span
                  className={`legend-line${c === 'rail' ? ' legend-line-dashed' : ''}`}
                  style={{ borderColor: ROAD_STYLES[c].color }}
                  aria-hidden
                />
                {f.t(`map.class.${c}`)}
              </span>
            ))}
          </div>
          <p className="note">{f.t('map.note')}</p>
        </>
      ) : (
        <>
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
        </>
      )}
      <MapPackagePanel />
    </Card>
  )
}
