/**
 * Draws the road network of decoded map tiles. Pure over a minimal canvas interface, so it is
 * testable without a browser canvas. Draws roads only: no vehicle, no telemetry, no route.
 */
import type { MapTile, RoadClass } from '@/domain/mapTile'
import { ROAD_FLAG_CHORD } from '@/domain/mapTile'
import { toScreen, type Size, type Viewport } from '@/domain/mapViewport'

export interface RoadStyle {
  color: string
  /** Line width in pixels at overview zoom; detailed zoom adds a little. */
  width: number
  dash?: number[]
}

/** Restrained beige and grey tones: orange stays reserved for the traveled path. */
export const ROAD_STYLES: Record<RoadClass, RoadStyle> = {
  motorway: { color: '#a8927a', width: 3 },
  primary: { color: '#bba891', width: 2.2 },
  local: { color: '#cdbda8', width: 1.4 },
  minor: { color: '#dccfbf', width: 1 },
  rail: { color: '#b5aca1', width: 1, dash: [4, 3] },
}

/** Most important on top. */
const DRAW_ORDER: readonly RoadClass[] = ['rail', 'minor', 'local', 'primary', 'motorway']

export type RoadCtx = Pick<
  CanvasRenderingContext2D,
  'clearRect' | 'beginPath' | 'moveTo' | 'lineTo' | 'stroke' | 'setLineDash'
> & {
  strokeStyle: string | CanvasGradient | CanvasPattern
  lineWidth: number
  lineJoin: CanvasLineJoin
  lineCap: CanvasLineCap
  globalAlpha: number
}

export interface DrawStats {
  roads: number
  /** Roads skipped because they lie entirely outside the canvas. */
  offscreen: number
}

/**
 * Draws every road once (a road crossing several tiles is listed in each). Roads entirely
 * outside the canvas are skipped. Chords (no estimated curve) are drawn fainter.
 */
export function drawRoads(
  ctx: RoadCtx,
  tiles: readonly MapTile[],
  vp: Viewport,
  size: Size,
): DrawStats {
  ctx.clearRect(0, 0, size.width, size.height)
  ctx.lineJoin = 'round'
  ctx.lineCap = 'round'
  const stats: DrawStats = { roads: 0, offscreen: 0 }
  const zoomBonus = vp.scale >= 0.4 ? 1.5 : vp.scale >= 0.05 ? 0.5 : 0
  const margin = 8
  for (const roadClass of DRAW_ORDER) {
    const style = ROAD_STYLES[roadClass]
    ctx.strokeStyle = style.color
    ctx.lineWidth = style.width + zoomBonus
    ctx.setLineDash(style.dash ?? [])
    const drawn = new Set<number>()
    for (const tile of tiles) {
      for (const road of tile.roads) {
        if (road.roadClass !== roadClass || drawn.has(road.index)) continue
        drawn.add(road.index)
        const xs: number[] = []
        const ys: number[] = []
        let minX = Infinity
        let maxX = -Infinity
        let minY = Infinity
        let maxY = -Infinity
        for (let i = road.first; i < road.first + road.count; i++) {
          const p = toScreen(
            vp,
            size,
            tile.originX + tile.points[i * 2]!,
            tile.originZ + tile.points[i * 2 + 1]!,
          )
          xs.push(p.x)
          ys.push(p.y)
          minX = Math.min(minX, p.x)
          maxX = Math.max(maxX, p.x)
          minY = Math.min(minY, p.y)
          maxY = Math.max(maxY, p.y)
        }
        if (
          maxX < -margin ||
          minX > size.width + margin ||
          maxY < -margin ||
          minY > size.height + margin
        ) {
          stats.offscreen++
          continue
        }
        ctx.globalAlpha = road.flags & ROAD_FLAG_CHORD ? 0.6 : 1
        ctx.beginPath()
        ctx.moveTo(xs[0]!, ys[0]!)
        for (let i = 1; i < xs.length; i++) ctx.lineTo(xs[i]!, ys[i]!)
        ctx.stroke()
        stats.roads++
      }
    }
  }
  ctx.globalAlpha = 1
  ctx.setLineDash([])
  return stats
}
