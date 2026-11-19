/**
 * Draws the road network of decoded map tiles. Pure over a minimal canvas interface, so it is
 * testable without a browser canvas. Draws roads only: no vehicle, no telemetry, no route.
 */
import type { MapTile, RoadClass } from '@/domain/mapTile'
import { ROAD_FLAG_CHORD } from '@/domain/mapTile'
import type { Size, Viewport } from '@/domain/mapViewport'

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

/**
 * Points per stroked path, a measured compromise (docs/map.md, M0). Roads of one class are
 * stroked together: the memory of the WebView2 GPU process grows with the number of paths
 * drawn, while a single path with tens of thousands of points rasterises slowly.
 */
export const MAX_PATH_POINTS = 4096

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

interface Visible {
  tile: MapTile
  road: MapTile['roads'][number]
}

/**
 * Draws every road once (a road crossing several tiles is listed in each). Roads entirely
 * outside the canvas are skipped. Chords (no estimated curve) are drawn fainter.
 *
 * All roads of one class and opacity form one path with one stroke, at most ten per frame,
 * instead of one stroke per road. Points are transformed inline, without an object per point.
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
  const k = vp.scale
  const left = -margin
  const top = -margin
  const right = size.width + margin
  const bottom = size.height + margin

  // Visible roads per class, solid and chord apart; each road once.
  const groups = new Map<RoadClass, [Visible[], Visible[]]>()
  for (const c of DRAW_ORDER) groups.set(c, [[], []])
  const seen = new Set<number>()
  for (const tile of tiles) {
    const ax = size.width / 2 + (tile.originX - vp.cx) * k
    const ay = size.height / 2 + (tile.originZ - vp.cz) * k
    const pts = tile.points
    for (const road of tile.roads) {
      if (seen.has(road.index)) continue
      seen.add(road.index)
      let minX = Infinity
      let maxX = -Infinity
      let minY = Infinity
      let maxY = -Infinity
      const end = (road.first + road.count) * 2
      for (let i = road.first * 2; i < end; i += 2) {
        const x = ax + pts[i]! * k
        const y = ay + pts[i + 1]! * k
        if (x < minX) minX = x
        if (x > maxX) maxX = x
        if (y < minY) minY = y
        if (y > maxY) maxY = y
      }
      if (maxX < left || minX > right || maxY < top || minY > bottom) {
        stats.offscreen++
        continue
      }
      groups.get(road.roadClass)![road.flags & ROAD_FLAG_CHORD ? 1 : 0].push({ tile, road })
      stats.roads++
    }
  }

  for (const roadClass of DRAW_ORDER) {
    const style = ROAD_STYLES[roadClass]
    const [solid, chords] = groups.get(roadClass)!
    if (solid.length === 0 && chords.length === 0) continue
    ctx.strokeStyle = style.color
    ctx.lineWidth = style.width + zoomBonus
    ctx.setLineDash(style.dash ?? [])
    for (const [list, alpha] of [
      [solid, 1],
      [chords, 0.6],
    ] as const) {
      if (list.length === 0) continue
      ctx.globalAlpha = alpha
      let points = 0
      ctx.beginPath()
      for (const { tile, road } of list) {
        if (points > 0 && points + road.count > MAX_PATH_POINTS) {
          ctx.stroke()
          ctx.beginPath()
          points = 0
        }
        points += road.count
        const ax = size.width / 2 + (tile.originX - vp.cx) * k
        const ay = size.height / 2 + (tile.originZ - vp.cz) * k
        const pts = tile.points
        const first = road.first * 2
        ctx.moveTo(ax + pts[first]! * k, ay + pts[first + 1]! * k)
        const end = (road.first + road.count) * 2
        for (let i = first + 2; i < end; i += 2) ctx.lineTo(ax + pts[i]! * k, ay + pts[i + 1]! * k)
      }
      ctx.stroke()
    }
  }
  ctx.globalAlpha = 1
  ctx.setLineDash([])
  return stats
}
