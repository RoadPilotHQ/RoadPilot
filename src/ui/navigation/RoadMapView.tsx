import { useEffect, useRef, useState } from 'react'
import { Minus, Plus } from 'lucide-react'
import type { MapStatus } from '@/domain/map'
import {
  chooseLevel,
  clampScale,
  fitBounds,
  panBy,
  scaleBarUnits,
  zoomAt,
  type Viewport,
} from '@/domain/mapViewport'
import type { GameId } from '@/domain/types'
import { useVehicleFormat } from '../vehicle/format'
import { fitCanvas, useDevicePixelRatio } from './canvasSize'
import { useElementSize } from './PathCanvas'
import { drawRoads, type RoadCtx } from './roadPainter'
import { useMapTiles } from '@/state/mapTiles'

export type MapMode = 'follow' | 'fit' | 'free'

/** Zoom factor of one button press. */
const ZOOM_STEP = 1.6
const DEFAULT_FOLLOW_SCALE = 0.5

/**
 * The real road network of the loaded package, north up, in the package's own coordinates.
 * The truck and its path are deliberately not drawn here: whether telemetry and map
 * coordinates agree is not verified. "Follow truck" only centres the view on the telemetry
 * position.
 */
export function RoadMapView({
  game,
  status,
  mode,
  onModeChange,
  centre,
}: {
  game: GameId
  /** A ready map status (content id, bounds and tile sizes present). */
  status: MapStatus
  mode: MapMode
  onModeChange: (mode: MapMode) => void
  /** Telemetry position to centre on in follow mode (no marker is drawn). */
  centre: { x: number; z: number } | null
}) {
  const f = useVehicleFormat()
  const box = useRef<HTMLDivElement>(null)
  const canvas = useRef<HTMLCanvasElement>(null)
  const size = useElementSize(box)
  const ratio = useDevicePixelRatio()
  const [free, setFree] = useState<Viewport | null>(null)
  const [followScale, setFollowScale] = useState(DEFAULT_FOLLOW_SCALE)
  const bounds = status.bounds!
  const tileSizes = status.tileSizes!

  const fit = fitBounds(bounds, size)
  const following = mode === 'follow' && centre !== null
  const viewport: Viewport | null =
    mode === 'free' && free
      ? free
      : following
        ? { cx: centre.x, cz: centre.z, scale: followScale }
        : fit

  const choice = viewport && size.width > 0 ? chooseLevel(viewport, size, tileSizes, bounds) : null
  const view = useMapTiles(
    choice && status.contentId
      ? {
          game,
          contentId: status.contentId,
          level: choice.level,
          tileSize: tileSizes[choice.level]!,
          tiles: choice.tiles,
        }
      : null,
  )

  // Distinct roads of the loaded tiles (a road crossing tiles is listed in each).
  const roads = new Set(view.tiles.flatMap((t) => t.roads.map((r) => r.index))).size

  // Draw at most once per frame, and only when the tiles, the view, the size or the pixel
  // ratio changed.
  const drawKey = viewport
    ? `${viewport.cx}|${viewport.cz}|${viewport.scale}|${size.width}x${size.height}@${ratio}|` +
      view.tiles.map((t) => `${t.contentId}/${t.level}/${t.x}/${t.z}`).join(',')
    : ''
  const lastDraw = useRef('')
  const pending = useRef<number | null>(null)
  useEffect(() => {
    const el = canvas.current
    if (!el || !viewport || drawKey === lastDraw.current) return
    lastDraw.current = drawKey
    const tiles = view.tiles
    if (pending.current !== null) cancelAnimationFrame(pending.current)
    pending.current = requestAnimationFrame(() => {
      pending.current = null
      // The backing store is reallocated only when its pixel size changes, never for a
      // zoom or a pan.
      fitCanvas(el, size.width, size.height, ratio)
      const ctx = el.getContext?.('2d') as (CanvasRenderingContext2D & RoadCtx) | null
      if (!ctx) return
      ctx.setTransform(ratio, 0, 0, ratio, 0, 0)
      drawRoads(ctx, tiles, viewport, size)
    })
  })
  useEffect(
    () => () => {
      if (pending.current !== null) cancelAnimationFrame(pending.current)
    },
    [],
  )

  // Zoom with the wheel about the pointer. A native listener, so the page does not scroll.
  const latest = useRef({ viewport, following, size })
  useEffect(() => {
    latest.current = { viewport, following, size }
  })
  useEffect(() => {
    const el = box.current
    if (!el) return
    const onWheel = (e: WheelEvent) => {
      const { viewport: vp, following: follow, size: s } = latest.current
      if (!vp) return
      e.preventDefault()
      const factor = Math.exp(-e.deltaY * 0.0015)
      if (follow) {
        setFollowScale((v) => clampScale(v * factor))
        return
      }
      const rect = el.getBoundingClientRect()
      setFree(zoomAt(vp, s, factor, e.clientX - rect.left, e.clientY - rect.top))
      onModeChange('free')
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [onModeChange])

  const drag = useRef<{ x: number; y: number } | null>(null)
  const zoomBy = (factor: number) => {
    if (!viewport) return
    if (following) {
      setFollowScale((v) => clampScale(v * factor))
      return
    }
    setFree(zoomAt(viewport, size, factor, size.width / 2, size.height / 2))
    onModeChange('free')
  }

  const bar = viewport && size.width > 0 ? scaleBarUnits(viewport, size.width) : null
  const empty = view.loading === 0 && view.failed === 0 && choice !== null && roads === 0

  return (
    <div
      ref={box}
      className="road-map"
      onPointerDown={(e) => {
        drag.current = { x: e.clientX, y: e.clientY }
        e.currentTarget.setPointerCapture?.(e.pointerId)
      }}
      onPointerMove={(e) => {
        if (!drag.current || !viewport) return
        const dx = e.clientX - drag.current.x
        const dy = e.clientY - drag.current.y
        drag.current = { x: e.clientX, y: e.clientY }
        // A pointer without coordinates (or no movement) changes nothing.
        if (!Number.isFinite(dx) || !Number.isFinite(dy) || (dx === 0 && dy === 0)) return
        setFree(panBy(viewport, dx, dy))
        onModeChange('free')
      }}
      onPointerUp={() => {
        drag.current = null
      }}
      onPointerCancel={() => {
        drag.current = null
      }}
    >
      <canvas
        ref={canvas}
        className="path-canvas"
        role="img"
        aria-label={f.t('map.canvasLabel', { game: f.t(`game.${game}`), roads: f.number(roads) })}
      />
      <div className="map-zoom" onPointerDown={(e) => e.stopPropagation()}>
        <button
          type="button"
          className="map-zoom-button"
          aria-label={f.t('map.zoomIn')}
          onClick={() => zoomBy(ZOOM_STEP)}
        >
          <Plus size={16} aria-hidden />
        </button>
        <button
          type="button"
          className="map-zoom-button"
          aria-label={f.t('map.zoomOut')}
          onClick={() => zoomBy(1 / ZOOM_STEP)}
        >
          <Minus size={16} aria-hidden />
        </button>
      </div>
      {bar ? (
        <div className="path-scale" aria-label={f.t('map.scale', { value: f.number(bar.units) })}>
          <span className="path-scale-bar" style={{ width: `${bar.px}px` }} />
          <span>{f.t('map.scaleValue', { value: f.number(bar.units) })}</span>
        </div>
      ) : null}
      <div className="map-badges">
        {view.loading > 0 ? (
          <span className="tag" role="note">
            {f.t('map.loadingTiles', { count: view.loading })}
          </span>
        ) : null}
        {view.failed > 0 ? (
          <span className="tag tag-warn" role="note">
            {f.t('map.failedTiles', { count: view.failed })}
          </span>
        ) : null}
        {view.truncated ? <span className="tag">{f.t('map.truncated')}</span> : null}
        {mode === 'follow' && !centre ? (
          <span className="tag">{f.t('map.followNoPosition')}</span>
        ) : null}
      </div>
      {empty ? <p className="navigation-empty">{f.t('map.emptyView')}</p> : null}
    </div>
  )
}
