/**
 * PROTOTYPE (M2, M3): renderer selection with Canvas 2D fallback, and the host that owns the
 * canvas element and drives rendering through `requestAnimationFrame`.
 *
 * M3: WebGL 2 on a software renderer falls back like a missing WebGL 2 (`software_renderer`);
 * an unknown renderer keeps WebGL 2. While the renderer reports pending tiles (incremental
 * uploads), the host keeps requesting frames until everything is drawn.
 *
 * A canvas keeps the first context type it was given, so every renderer gets a new canvas
 * element; the previous renderer is disposed and its canvas removed first, so two renderers
 * never draw the same map at the same time.
 */
import type { Viewport } from '@/domain/mapViewport'
import { createCanvas2DRoadRenderer } from './Canvas2DRoadRenderer'
import type { GpuInfo } from './gpuInfo'
import type {
  RendererFailure,
  RendererKind,
  RendererStatus,
  RenderStats,
  RoadRenderer,
  SyntheticTile,
} from './types'
import { createWebGL2RoadRenderer, type WebGL2Options } from './WebGL2RoadRenderer'

export interface Fallback {
  from: RendererKind
  reason: RendererFailure
  detail?: string
  /** M3: what the failed WebGL 2 attempt found out about the GPU, when it got that far. */
  gpu?: GpuInfo
}

export interface CreatedRenderer {
  renderer: RoadRenderer
  canvas: HTMLCanvasElement
  /** Set when WebGL 2 was asked for and Canvas 2D is used instead. */
  fallback: Fallback | null
}

/**
 * Creates the preferred renderer on a new canvas from `createCanvas`, or Canvas 2D on another
 * new canvas when WebGL 2 is unavailable or fails to start. Returns null only when not even
 * Canvas 2D is available.
 */
export function createRoadRenderer(
  prefer: RendererKind,
  createCanvas: () => HTMLCanvasElement,
  webgl: WebGL2Options = {},
): CreatedRenderer | null {
  let fallback: Fallback | null = null
  if (prefer === 'webgl2') {
    const canvas = createCanvas()
    const result = createWebGL2RoadRenderer(canvas, webgl)
    if (result.ok) return { renderer: result.renderer, canvas, fallback: null }
    fallback = { from: 'webgl2', reason: result.reason, gpu: result.gpu }
    if (result.detail !== undefined) fallback.detail = result.detail
  }
  const canvas = createCanvas()
  const result = createCanvas2DRoadRenderer(canvas)
  return result.ok ? { renderer: result.renderer, canvas, fallback } : null
}

export interface FrameInfo {
  kind: RendererKind
  stats: RenderStats
  /** CPU time of `render()`, milliseconds. */
  renderMs: number
  /** `requestAnimationFrame` timestamp. */
  time: number
}

export interface HostOptions {
  webgl?: Omit<WebGL2Options, 'onStatus'>
  createCanvas?: () => HTMLCanvasElement
  schedule?: (cb: (time: number) => void) => number
  cancel?: (id: number) => void
  onFrame?: (info: FrameInfo) => void
  onStatus?: (kind: RendererKind, status: RendererStatus) => void
  onFallback?: (fallback: Fallback) => void
}

export class RoadRendererHost {
  private current: CreatedRenderer | null = null
  private pending: number | null = null
  private disposed = false
  private size: [number, number, number] | null = null
  private view: Viewport | null = null
  private tiles: readonly SyntheticTile[] = []
  private readonly schedule: (cb: (time: number) => void) => number
  private readonly cancel: (id: number) => void
  private readonly createCanvas: () => HTMLCanvasElement

  constructor(
    private readonly container: HTMLElement,
    private readonly options: HostOptions = {},
  ) {
    this.schedule = options.schedule ?? ((cb) => requestAnimationFrame(cb))
    this.cancel = options.cancel ?? ((id) => cancelAnimationFrame(id))
    this.createCanvas =
      options.createCanvas ?? (() => container.ownerDocument.createElement('canvas'))
  }

  get renderer(): RoadRenderer | null {
    return this.current?.renderer ?? null
  }

  get canvas(): HTMLCanvasElement | null {
    return this.current?.canvas ?? null
  }

  get fallback(): Fallback | null {
    return this.current?.fallback ?? null
  }

  /** Replaces the renderer: dispose the old one and its canvas, then create the new one. */
  mount(prefer: RendererKind): CreatedRenderer | null {
    if (this.disposed) return null
    this.unmount()
    let mountedRenderer: RoadRenderer | null = null
    const created = createRoadRenderer(prefer, this.createCanvas, {
      ...this.options.webgl,
      onStatus: (status) => {
        // Status changes of a renderer that is no longer mounted are ignored.
        if (!mountedRenderer || this.current?.renderer !== mountedRenderer) return
        this.options.onStatus?.('webgl2', status)
        if (status.state === 'failed') {
          const fb: Fallback = { from: 'webgl2', reason: status.reason }
          if (status.detail !== undefined) fb.detail = status.detail
          // Switch outside the renderer's own call stack.
          queueMicrotask(() => {
            if (this.current?.renderer !== mountedRenderer || this.disposed) return
            this.mount('canvas2d')
            if (this.current) this.current.fallback = fb
            this.options.onFallback?.(fb)
          })
        } else if (status.state === 'ready') this.invalidate()
      },
    })
    if (!created) return null
    mountedRenderer = created.renderer
    this.current = created
    created.canvas.classList.add('render-lab-canvas')
    this.container.appendChild(created.canvas)
    if (created.fallback) this.options.onFallback?.(created.fallback)
    if (this.size) created.renderer.resize(...this.size)
    if (this.view) created.renderer.setView(this.view)
    created.renderer.setTiles(this.tiles)
    this.invalidate()
    return created
  }

  /** Disposes the renderer and removes its canvas; the host stays usable for `mount`. */
  release(): void {
    this.unmount()
  }

  private unmount(): void {
    if (this.pending !== null) this.cancel(this.pending)
    this.pending = null
    const old = this.current
    this.current = null
    if (old) {
      old.renderer.dispose()
      old.canvas.remove()
    }
  }

  resize(width: number, height: number, dpr: number): void {
    this.size = [width, height, dpr]
    this.current?.renderer.resize(width, height, dpr)
    this.invalidate()
  }

  setView(view: Viewport): void {
    this.view = view
    this.current?.renderer.setView(view)
    this.invalidate()
  }

  setTiles(tiles: readonly SyntheticTile[]): void {
    this.tiles = tiles
    this.current?.renderer.setTiles(tiles)
    this.invalidate()
  }

  /** Requests one frame; any number of changes before it are drawn by that one frame. */
  invalidate(): void {
    if (this.disposed || this.pending !== null || !this.current) return
    this.pending = this.schedule((time) => this.frame(time))
  }

  private frame(time: number): void {
    this.pending = null
    const current = this.current
    if (!current || this.disposed) return
    const t0 = performance.now()
    const stats = current.renderer.render()
    const renderMs = performance.now() - t0
    this.options.onFrame?.({ kind: current.renderer.kind, stats, renderMs, time })
    // Incremental uploads: the next frame continues until nothing is pending.
    if (stats.pending > 0 && this.current === current) this.invalidate()
  }

  dispose(): void {
    if (this.disposed) return
    this.unmount()
    this.disposed = true
    this.tiles = []
  }
}
