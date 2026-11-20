/**
 * PROTOTYPE (M2): the Canvas 2D side of the renderer comparison and the fallback of the lab.
 * It draws with the unchanged production painter (`drawRoads`, M0), so the comparison is
 * against exactly what the dashboard draws, with the same styles and geometry.
 */
import type { Viewport } from '@/domain/mapViewport'
import { fitCanvas } from '../canvasSize'
import { drawRoads } from '../roadPainter'
import { EMPTY_STATS, type RenderStats, type RoadRenderer, type SyntheticTile } from './types'

export type CreateCanvas2DResult =
  { ok: true; renderer: Canvas2DRoadRenderer } | { ok: false; reason: 'context_creation_failed' }

export function createCanvas2DRoadRenderer(canvas: HTMLCanvasElement): CreateCanvas2DResult {
  const ctx = canvas.getContext('2d')
  if (!ctx) return { ok: false, reason: 'context_creation_failed' }
  return { ok: true, renderer: new Canvas2DRoadRenderer(canvas, ctx) }
}

export class Canvas2DRoadRenderer implements RoadRenderer {
  readonly kind = 'canvas2d' as const
  private tiles: readonly SyntheticTile[] = []
  private segments = 0
  private viewport: Viewport = { cx: 0, cz: 0, scale: 1 }
  private width = 1
  private height = 1
  private dpr = 1
  private strokes = 0
  private disposed = false
  private readonly restoreStroke: () => void

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly ctx: CanvasRenderingContext2D,
  ) {
    // Counts strokes (draw calls) on this lab canvas only, without wrapping every call.
    const own = Object.prototype.hasOwnProperty.call(ctx, 'stroke')
    const stroke = ctx.stroke as (...a: unknown[]) => void
    const counted = (...args: unknown[]) => {
      this.strokes++
      stroke.apply(ctx, args)
    }
    ctx.stroke = counted as typeof ctx.stroke
    this.restoreStroke = () => {
      if (ctx.stroke !== counted) return
      if (own) ctx.stroke = stroke as typeof ctx.stroke
      else delete (ctx as { stroke?: unknown }).stroke
    }
  }

  resize(width: number, height: number, dpr: number): void {
    if (this.disposed) return
    this.width = Math.max(1, width)
    this.height = Math.max(1, height)
    this.dpr = dpr > 0 ? dpr : 1
    fitCanvas(this.canvas, this.width, this.height, this.dpr)
  }

  setView(viewport: Viewport): void {
    if (this.disposed) return
    if (![viewport.cx, viewport.cz, viewport.scale].every(Number.isFinite) || viewport.scale <= 0)
      return
    this.viewport = { ...viewport }
  }

  setTiles(tiles: readonly SyntheticTile[]): void {
    if (this.disposed) return
    const first = tiles[0]
    this.tiles = first ? tiles.filter((t) => t.contentId === first.contentId) : []
    // Unique segments, as the painter draws each road once.
    const seen = new Set<number>()
    let segments = 0
    for (const t of this.tiles)
      for (const r of t.roads) {
        if (seen.has(r.index)) continue
        seen.add(r.index)
        segments += Math.max(0, r.count - 1)
      }
    this.segments = segments
  }

  render(): RenderStats {
    if (this.disposed) return { ...EMPTY_STATS }
    this.strokes = 0
    const ctx = this.ctx
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0)
    const drawn = drawRoads(ctx, this.tiles, this.viewport, {
      width: this.width,
      height: this.height,
    })
    return {
      ...EMPTY_STATS,
      roads: drawn.roads,
      segments: this.segments,
      drawCalls: this.strokes,
    }
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.restoreStroke()
    this.tiles = []
    // Releases the backing store at once instead of waiting for garbage collection.
    this.canvas.width = 0
    this.canvas.height = 0
  }
}
