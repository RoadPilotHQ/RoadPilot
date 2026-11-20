/**
 * PROTOTYPE (M2): WebGL 2 road renderer with instanced segments, per-tile GPU buffers and
 * stencil groups. Only the developer render lab uses it; the dashboard keeps the Canvas 2D
 * painter. See docs/webgl-prototype.md.
 *
 * - One buffer per tile and level (24-byte instances, `geometryBuilder.ts`), one vertex array
 *   per tile and road class, cached LRU within a byte budget (`gpuBufferCache.ts`).
 * - Pan and zoom only change uniforms: no geometry is rebuilt and nothing is uploaded.
 * - Each road class is a stencil group: a pixel is blended at most once per class, so a road
 *   listed in several tiles, overlapping caps at joints and same-class crossings never darken.
 * - No render loop of its own: the host calls `render()` at most once per animation frame.
 */
import type { RoadClass } from '@/domain/mapTile'
import { ROAD_CLASSES } from '@/domain/mapTile'
import type { Viewport } from '@/domain/mapViewport'
import { fitCanvas } from '../canvasSize'
import { ROAD_STYLES } from '../roadPainter'
import { buildTileGeometry, INSTANCE_BYTES, type GroupRange } from './geometryBuilder'
import {
  DEFAULT_GPU_BUDGET_BYTES,
  GpuBufferCache,
  tileKey,
  type CacheEntry,
} from './gpuBufferCache'
import { CHORD_ALPHA, dashOf, DRAW_ORDER, hexToRgb, lineWidth } from './roadStyle'
import fragmentSource from './shaders/road.frag?raw'
import vertexSource from './shaders/road.vert?raw'
import {
  EMPTY_STATS,
  type RendererFailure,
  type RendererStatus,
  type RenderStats,
  type RoadRenderer,
  type SyntheticTile,
} from './types'

/**
 * `single`: one pass per class, as proposed in M1. `coreFringe`: per class first the fully
 * covered fragments, then the smoothed edge, both stencilled (see docs/webgl-prototype.md).
 * `off`: no stencil, for comparison only (roads in several tiles are blended repeatedly).
 */
export type StencilMode = 'single' | 'coreFringe' | 'off'

export const DEFAULT_CONTEXT_ATTRIBUTES: WebGLContextAttributes = {
  antialias: false,
  alpha: true,
  premultipliedAlpha: true,
  preserveDrawingBuffer: false,
  depth: false,
  stencil: true,
  powerPreference: 'default',
  failIfMajorPerformanceCaveat: true,
}

export interface WebGL2Options {
  budgetBytes?: number
  stencilMode?: StencilMode
  contextAttributes?: WebGLContextAttributes
  onStatus?: (status: RendererStatus) => void
  /** Losses within `lossWindowMs` after which the renderer gives up. */
  maxLosses?: number
  lossWindowMs?: number
  /** A lost context not restored within this time counts as failed. */
  restoreTimeoutMs?: number
  /** Ask the browser to drop the context on dispose, releasing its memory at once. */
  loseContextOnDispose?: boolean
  now?: () => number
}

export type CreateWebGL2Result =
  | { ok: true; renderer: WebGL2RoadRenderer }
  | { ok: false; reason: RendererFailure; detail?: string }

export interface WebGL2Diagnostics {
  stencil: boolean
  stencilMode: StencilMode
  contextAttributes: WebGLContextAttributes | null
  gpu: string | null
  losses: number
  /** Last `setTiles`: geometry building and upload, all new tiles together, and the slowest tile. */
  lastBuildMs: number
  lastUploadMs: number
  maxTileBuildMs: number
  lastNewTiles: number
  skippedRoads: number
  culledTiles: number
}

interface TileEntry extends CacheEntry {
  buffer: WebGLBuffer | null
  /** Per class in `DRAW_ORDER`; null for an empty class. */
  vaos: (WebGLVertexArrayObject | null)[]
  groups: GroupRange[]
  originX: number
  originZ: number
  bounds: [number, number, number, number] | null
  roads: number
}

interface Program {
  program: WebGLProgram
  u: Record<
    'offset' | 'scale' | 'viewport' | 'halfWidth' | 'color' | 'chordAlpha' | 'dash' | 'pass',
    WebGLUniformLocation | null
  >
}

const PASS_CORE = 0
const PASS_FRINGE = 1
const PASS_SINGLE = 2

const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now())

function compile(
  gl: WebGL2RenderingContext,
  type: number,
  source: string,
): WebGLShader | { log: string } {
  const shader = gl.createShader(type)
  if (!shader) return { log: 'createShader returned null' }
  gl.shaderSource(shader, source)
  gl.compileShader(shader)
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(shader) ?? ''
    gl.deleteShader(shader)
    return { log }
  }
  return shader
}

/** Compiles and links the road program, or names the failure. */
export function createRoadProgram(
  gl: WebGL2RenderingContext,
): Program | { reason: RendererFailure; detail: string } {
  const vs = compile(gl, gl.VERTEX_SHADER, vertexSource)
  if ('log' in vs) return { reason: 'shader_compile', detail: `vertex: ${vs.log}` }
  const fs = compile(gl, gl.FRAGMENT_SHADER, fragmentSource)
  if ('log' in fs) {
    gl.deleteShader(vs)
    return { reason: 'shader_compile', detail: `fragment: ${fs.log}` }
  }
  const program = gl.createProgram()
  if (!program) {
    gl.deleteShader(vs)
    gl.deleteShader(fs)
    return { reason: 'program_link', detail: 'createProgram returned null' }
  }
  gl.attachShader(program, vs)
  gl.attachShader(program, fs)
  gl.linkProgram(program)
  // The program keeps what it needs; the shaders can go.
  gl.deleteShader(vs)
  gl.deleteShader(fs)
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    const detail = gl.getProgramInfoLog(program) ?? ''
    gl.deleteProgram(program)
    return { reason: 'program_link', detail }
  }
  const loc = (n: string) => gl.getUniformLocation(program, n)
  return {
    program,
    u: {
      offset: loc('u_offset'),
      scale: loc('u_scale'),
      viewport: loc('u_viewport'),
      halfWidth: loc('u_halfWidth[0]') ?? loc('u_halfWidth'),
      color: loc('u_color'),
      chordAlpha: loc('u_chordAlpha'),
      dash: loc('u_dash'),
      pass: loc('u_pass'),
    },
  }
}

/** Probes a throw-away canvas: does WebGL 2 exist when a major performance caveat is allowed? */
function probeCaveat(): boolean {
  if (typeof document === 'undefined') return false
  const probe = document.createElement('canvas')
  const gl = probe.getContext('webgl2', {
    ...DEFAULT_CONTEXT_ATTRIBUTES,
    failIfMajorPerformanceCaveat: false,
  }) as WebGL2RenderingContext | null
  if (!gl) return false
  gl.getExtension('WEBGL_lose_context')?.loseContext()
  return true
}

export function createWebGL2RoadRenderer(
  canvas: HTMLCanvasElement,
  options: WebGL2Options = {},
): CreateWebGL2Result {
  if (typeof WebGL2RenderingContext === 'undefined')
    return { ok: false, reason: 'webgl2_unavailable' }
  const attributes = options.contextAttributes ?? DEFAULT_CONTEXT_ATTRIBUTES
  let gl: WebGL2RenderingContext | null
  try {
    gl = canvas.getContext('webgl2', attributes) as WebGL2RenderingContext | null
  } catch (e) {
    return { ok: false, reason: 'context_creation_failed', detail: String(e) }
  }
  if (!gl) {
    const caveat = attributes.failIfMajorPerformanceCaveat && probeCaveat()
    return {
      ok: false,
      reason: 'context_creation_failed',
      detail: caveat ? 'major_performance_caveat' : undefined,
    }
  }
  const program = createRoadProgram(gl)
  if ('reason' in program) {
    gl.getExtension('WEBGL_lose_context')?.loseContext()
    return { ok: false, reason: program.reason, detail: program.detail }
  }
  return { ok: true, renderer: new WebGL2RoadRenderer(canvas, gl, program, options) }
}

export class WebGL2RoadRenderer implements RoadRenderer {
  readonly kind = 'webgl2' as const
  private readonly cache: GpuBufferCache<TileEntry>
  private readonly stencilMode: StencilMode
  private readonly opts: Required<
    Pick<WebGL2Options, 'maxLosses' | 'lossWindowMs' | 'restoreTimeoutMs' | 'loseContextOnDispose'>
  >
  private readonly clock: () => number
  private status: RendererStatus = { state: 'ready' }
  private program: Program | null
  private disposed = false
  private hasStencil: boolean
  private tiles: readonly SyntheticTile[] = []
  private visibleEntries: TileEntry[] = []
  private contentId: string | null = null
  private viewport: Viewport = { cx: 0, cz: 0, scale: 1 }
  private cssWidth = 1
  private cssHeight = 1
  private dpr = 1
  private uploads = 0
  private lossTimes: number[] = []
  private restoreTimer: ReturnType<typeof setTimeout> | null = null
  private diag: Omit<WebGL2Diagnostics, 'stencil' | 'stencilMode' | 'contextAttributes'> = {
    gpu: null,
    losses: 0,
    lastBuildMs: 0,
    lastUploadMs: 0,
    maxTileBuildMs: 0,
    lastNewTiles: 0,
    skippedRoads: 0,
    culledTiles: 0,
  }
  private readonly halfWidths = new Float32Array(ROAD_CLASSES.length)
  private readonly colors = new Map<RoadClass, [number, number, number]>(
    ROAD_CLASSES.map((c) => [c, hexToRgb(ROAD_STYLES[c].color)]),
  )

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly gl: WebGL2RenderingContext,
    program: Program,
    private readonly options: WebGL2Options = {},
  ) {
    this.program = program
    this.stencilMode = options.stencilMode ?? 'coreFringe'
    this.opts = {
      maxLosses: options.maxLosses ?? 3,
      lossWindowMs: options.lossWindowMs ?? 60_000,
      restoreTimeoutMs: options.restoreTimeoutMs ?? 5_000,
      loseContextOnDispose: options.loseContextOnDispose ?? true,
    }
    this.clock = options.now ?? now
    this.cache = new GpuBufferCache<TileEntry>(
      options.budgetBytes ?? DEFAULT_GPU_BUDGET_BYTES,
      (e) => this.release(e),
    )
    this.hasStencil = this.stencilMode !== 'off' && gl.getContextAttributes()?.stencil === true
    this.diag.gpu = readGpuName(gl)
    this.setupState()
    canvas.addEventListener('webglcontextlost', this.onLost)
    canvas.addEventListener('webglcontextrestored', this.onRestored)
  }

  get currentStatus(): RendererStatus {
    return this.status
  }

  diagnostics(): WebGL2Diagnostics {
    return {
      ...this.diag,
      stencil: this.hasStencil,
      stencilMode: this.stencilMode,
      contextAttributes: this.disposed ? null : this.gl.getContextAttributes(),
    }
  }

  resize(width: number, height: number, dpr: number): void {
    if (this.disposed) return
    this.cssWidth = Math.max(1, width)
    this.cssHeight = Math.max(1, height)
    this.dpr = dpr > 0 ? dpr : 1
    fitCanvas(this.canvas, this.cssWidth, this.cssHeight, this.dpr)
  }

  setView(viewport: Viewport): void {
    if (this.disposed) return
    if (![viewport.cx, viewport.cz, viewport.scale].every(Number.isFinite) || viewport.scale <= 0)
      return
    this.viewport = { ...viewport }
  }

  setTiles(tiles: readonly SyntheticTile[]): void {
    if (this.disposed || this.status.state === 'failed') return
    const first = tiles[0]
    if (first && first.contentId !== this.contentId) {
      // Another package: nothing of the previous one may be drawn or kept.
      if (this.status.state === 'ready') this.cache.clear()
      this.contentId = first.contentId
    }
    const own = tiles.filter((t) => t.contentId === this.contentId)
    this.tiles = own
    if (this.status.state !== 'ready') return
    this.upload(own)
  }

  private upload(tiles: readonly SyntheticTile[]): void {
    const gl = this.gl
    const entries: TileEntry[] = []
    const keys: string[] = []
    let buildMs = 0
    let uploadMs = 0
    let maxTile = 0
    let newTiles = 0
    let skippedRoads = 0
    const seen = new Set<string>()
    for (const tile of tiles) {
      const key = tileKey(tile.contentId, tile.level, tile.x, tile.z)
      if (seen.has(key)) continue
      seen.add(key)
      keys.push(key)
      let entry = this.cache.get(key)
      if (!entry) {
        const t0 = this.clock()
        const geo = buildTileGeometry(tile)
        const t1 = this.clock()
        buildMs += t1 - t0
        maxTile = Math.max(maxTile, t1 - t0)
        skippedRoads += geo.skippedRoads
        entry = {
          key,
          bytes: geo.data.byteLength,
          buffer: null,
          vaos: geo.groups.map(() => null),
          groups: geo.groups,
          originX: tile.originX,
          originZ: tile.originZ,
          bounds: geo.bounds,
          roads: geo.roads,
        }
        if (geo.instances > 0) {
          entry.buffer = gl.createBuffer()
          gl.bindBuffer(gl.ARRAY_BUFFER, entry.buffer)
          gl.bufferData(gl.ARRAY_BUFFER, geo.data, gl.STATIC_DRAW)
          this.uploads++
          entry.vaos = geo.groups.map((g) =>
            g.count > 0 ? this.createVao(entry!.buffer!, g) : null,
          )
          gl.bindBuffer(gl.ARRAY_BUFFER, null)
        }
        uploadMs += this.clock() - t1
        newTiles++
        this.cache.put(entry)
      }
      entries.push(entry)
    }
    this.cache.setVisible(keys)
    this.cache.evict()
    this.visibleEntries = entries
    this.diag.lastBuildMs = buildMs
    this.diag.lastUploadMs = uploadMs
    this.diag.maxTileBuildMs = maxTile
    this.diag.lastNewTiles = newTiles
    this.diag.skippedRoads = skippedRoads
    // One error check per batch: `getError` waits for the GPU process.
    if (newTiles > 0 && gl.getError() === gl.OUT_OF_MEMORY) this.fail('out_of_memory')
  }

  private createVao(buffer: WebGLBuffer, g: GroupRange): WebGLVertexArrayObject | null {
    const gl = this.gl
    const vao = gl.createVertexArray()
    gl.bindVertexArray(vao)
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer)
    const base = g.first * INSTANCE_BYTES
    gl.enableVertexAttribArray(0)
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, INSTANCE_BYTES, base)
    gl.vertexAttribDivisor(0, 1)
    gl.enableVertexAttribArray(1)
    gl.vertexAttribPointer(1, 2, gl.FLOAT, false, INSTANCE_BYTES, base + 8)
    gl.vertexAttribDivisor(1, 1)
    gl.enableVertexAttribArray(2)
    gl.vertexAttribPointer(2, 1, gl.FLOAT, false, INSTANCE_BYTES, base + 16)
    gl.vertexAttribDivisor(2, 1)
    gl.enableVertexAttribArray(3)
    gl.vertexAttribIPointer(3, 2, gl.UNSIGNED_BYTE, INSTANCE_BYTES, base + 20)
    gl.vertexAttribDivisor(3, 1)
    gl.bindVertexArray(null)
    return vao
  }

  private release(e: TileEntry): void {
    if (this.gl.isContextLost()) return
    for (const vao of e.vaos) if (vao) this.gl.deleteVertexArray(vao)
    if (e.buffer) this.gl.deleteBuffer(e.buffer)
    e.vaos = e.vaos.map(() => null)
    e.buffer = null
  }

  private setupState(): void {
    const gl = this.gl
    gl.disable(gl.DEPTH_TEST)
    gl.disable(gl.CULL_FACE)
    gl.enable(gl.BLEND)
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA)
    if (this.hasStencil) {
      gl.enable(gl.STENCIL_TEST)
      gl.stencilMask(0xff)
      gl.stencilOp(gl.KEEP, gl.KEEP, gl.REPLACE)
    }
    gl.clearColor(0, 0, 0, 0)
    gl.clearStencil(0)
  }

  private stats(roads = 0, segments = 0, drawCalls = 0): RenderStats {
    let vaos = 0
    let buffers = 0
    for (const e of this.cache.values()) {
      if (e.buffer) buffers++
      for (const v of e.vaos) if (v) vaos++
    }
    return {
      roads,
      segments,
      drawCalls,
      uploads: this.uploads,
      gpuBytes: this.cache.bytes,
      buffers,
      vertexArrays: vaos,
      overBudget: this.cache.overBudget,
      budgetBytes: this.cache.budgetBytes,
    }
  }

  render(): RenderStats {
    if (this.disposed) return { ...EMPTY_STATS }
    if (this.status.state !== 'ready' || !this.program) return this.stats()
    const gl = this.gl
    const W = gl.drawingBufferWidth
    const H = gl.drawingBufferHeight
    const { cx, cz, scale } = this.viewport
    const k = scale * this.dpr
    const p = this.program
    gl.viewport(0, 0, W, H)
    gl.clear(gl.COLOR_BUFFER_BIT | (this.hasStencil ? gl.STENCIL_BUFFER_BIT : 0))
    gl.useProgram(p.program)
    gl.uniform2f(p.u.viewport, W, H)
    gl.uniform1f(p.u.scale, k)
    gl.uniform1f(p.u.chordAlpha, CHORD_ALPHA)
    let maxHalf = 0
    ROAD_CLASSES.forEach((c, i) => {
      this.halfWidths[i] = (lineWidth(c, scale) * this.dpr) / 2
      maxHalf = Math.max(maxHalf, this.halfWidths[i]!)
    })
    gl.uniform1fv(p.u.halfWidth, this.halfWidths)

    // Tiles on screen, with their origin in device pixels.
    const margin = maxHalf + 2
    const drawn: { e: TileEntry; ox: number; oz: number }[] = []
    let culled = 0
    for (const e of this.visibleEntries) {
      if (!e.bounds || !e.buffer) continue
      const ox = W / 2 + (e.originX - cx) * k
      const oz = H / 2 + (e.originZ - cz) * k
      const [x0, z0, x1, z1] = e.bounds
      if (ox + x1 * k < -margin || ox + x0 * k > W + margin) {
        culled++
        continue
      }
      if (oz + z1 * k < -margin || oz + z0 * k > H + margin) {
        culled++
        continue
      }
      drawn.push({ e, ox, oz })
    }
    this.diag.culledTiles = culled

    const passes =
      this.hasStencil && this.stencilMode === 'coreFringe'
        ? [PASS_CORE, PASS_FRINGE]
        : [PASS_SINGLE]
    let drawCalls = 0
    let segments = 0
    let roads = 0
    for (const d of drawn) roads += d.e.roads
    DRAW_ORDER.forEach((roadClass, gi) => {
      if (!drawn.some((d) => d.e.vaos[gi])) return
      const [r, g, b] = this.colors.get(roadClass)!
      gl.uniform3f(p.u.color, r, g, b)
      const dash = dashOf(roadClass)
      if (dash) gl.uniform2f(p.u.dash, dash[0] * this.dpr, (dash[0] + dash[1]) * this.dpr)
      else gl.uniform2f(p.u.dash, 0, 0)
      if (this.hasStencil) gl.stencilFunc(gl.NOTEQUAL, gi + 1, 0xff)
      for (const pass of passes) {
        gl.uniform1i(p.u.pass, pass)
        for (const { e, ox, oz } of drawn) {
          const vao = e.vaos[gi]
          if (!vao) continue
          const count = e.groups[gi]!.count
          gl.uniform2f(p.u.offset, ox, oz)
          gl.bindVertexArray(vao)
          gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, count)
          drawCalls++
          if (pass !== PASS_FRINGE) segments += count
        }
      }
    })
    gl.bindVertexArray(null)
    return this.stats(roads, segments, drawCalls)
  }

  private setStatus(status: RendererStatus): void {
    this.status = status
    this.options.onStatus?.(status)
  }

  private fail(reason: RendererFailure, detail?: string): void {
    if (this.status.state === 'failed') return
    this.clearRestoreTimer()
    if (!this.gl.isContextLost()) {
      this.cache.clear()
      if (this.program) this.gl.deleteProgram(this.program.program)
    } else this.cache.forget()
    this.program = null
    this.visibleEntries = []
    this.setStatus(
      detail === undefined ? { state: 'failed', reason } : { state: 'failed', reason, detail },
    )
  }

  private clearRestoreTimer(): void {
    if (this.restoreTimer !== null) clearTimeout(this.restoreTimer)
    this.restoreTimer = null
  }

  private onLost = (event: Event): void => {
    // Without preventDefault the browser never restores the context.
    event.preventDefault()
    if (this.disposed || this.status.state === 'failed') return
    // The GL objects died with the context.
    this.cache.forget()
    this.program = null
    this.visibleEntries = []
    const t = this.clock()
    this.lossTimes = this.lossTimes.filter((x) => t - x < this.opts.lossWindowMs)
    this.lossTimes.push(t)
    this.diag.losses++
    if (this.lossTimes.length >= this.opts.maxLosses) {
      this.fail('context_lost_repeatedly')
      return
    }
    this.setStatus({ state: 'lost' })
    this.clearRestoreTimer()
    this.restoreTimer = setTimeout(() => {
      this.restoreTimer = null
      if (!this.disposed && this.status.state === 'lost') this.fail('context_restore_failed')
    }, this.opts.restoreTimeoutMs)
  }

  private onRestored = (): void => {
    if (this.disposed || this.status.state !== 'lost') return
    this.clearRestoreTimer()
    const program = createRoadProgram(this.gl)
    if ('reason' in program) {
      this.fail(program.reason, program.detail)
      return
    }
    this.program = program
    this.hasStencil = this.stencilMode !== 'off' && this.gl.getContextAttributes()?.stencil === true
    this.setupState()
    this.status = { state: 'ready' }
    // Rebuild the visible geometry from the CPU-side tiles.
    this.upload(this.tiles)
    if (this.status.state === 'ready') this.setStatus({ state: 'ready' })
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.clearRestoreTimer()
    this.canvas.removeEventListener('webglcontextlost', this.onLost)
    this.canvas.removeEventListener('webglcontextrestored', this.onRestored)
    const gl = this.gl
    if (!gl.isContextLost()) {
      this.cache.clear()
      if (this.program) gl.deleteProgram(this.program.program)
      if (this.opts.loseContextOnDispose) gl.getExtension('WEBGL_lose_context')?.loseContext()
    } else this.cache.forget()
    this.program = null
    this.visibleEntries = []
    this.tiles = []
  }
}

function readGpuName(gl: WebGL2RenderingContext): string | null {
  try {
    const ext = gl.getExtension('WEBGL_debug_renderer_info')
    const name = ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER)
    return typeof name === 'string' ? name : null
  } catch {
    return null
  }
}
