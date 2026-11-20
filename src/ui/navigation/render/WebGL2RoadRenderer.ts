/**
 * PROTOTYPE (M2, M3): WebGL 2 road renderer with instanced segments and per-tile GPU buffers.
 * Only the developer render lab uses it; the dashboard keeps the Canvas 2D painter. See
 * docs/webgl-prototype.md.
 *
 * - One buffer per tile and level (24-byte instances, `geometryBuilder.ts`), cached LRU within a
 *   byte budget (`gpuBufferCache.ts`).
 * - Pan and zoom only change uniforms: no geometry is rebuilt and nothing is uploaded.
 * - Overlaps (a road listed in several tiles, overlapping caps at joints, same-class crossings)
 *   must not darken. M3 default `coverage`: every class's coverage goes into its own channel of
 *   an offscreen target with MAX blending, then one composite pass lays the classes over each
 *   other in draw order. The M2 stencil modes remain for comparison.
 * - M3: tiles are built and uploaded incrementally, visible tiles nearest the view centre
 *   first, within a time budget per frame; `RenderStats.pending` reports what is still missing.
 * - M3: a context that renders in software (SwiftShader, WARP, llvmpipe) is refused.
 * - No render loop of its own: the host calls `render()` at most once per animation frame.
 */
import type { RoadClass } from '@/domain/mapTile'
import { ROAD_CLASSES } from '@/domain/mapTile'
import type { Viewport } from '@/domain/mapViewport'
import { fitCanvas } from '../canvasSize'
import { ROAD_STYLES } from '../roadPainter'
import { buildTileGeometry, INSTANCE_BYTES, type GroupRange } from './geometryBuilder'
import { readGpuInfo, UNAVAILABLE_GPU, type GpuInfo } from './gpuInfo'
import {
  DEFAULT_GPU_BUDGET_BYTES,
  GpuBufferCache,
  tileKey,
  type CacheEntry,
} from './gpuBufferCache'
import { CHORD_ALPHA, dashOf, DRAW_ORDER, hexToRgb, lineWidth } from './roadStyle'
import compositeFragmentSource from './shaders/composite.frag?raw'
import compositeVertexSource from './shaders/composite.vert?raw'
import fragmentSource from './shaders/road.frag?raw'
import vertexSource from './shaders/road.vert?raw'
import coverageFragmentSource from './shaders/roadCoverage.frag?raw'
import {
  EMPTY_STATS,
  type RendererFailure,
  type RendererStatus,
  type RenderStats,
  type RoadRenderer,
  type SyntheticTile,
} from './types'

/**
 * How overlapping fragments of one road class are combined.
 *
 * - `coverage` (M3 default): per-class coverage with MAX blending in an offscreen target, then
 *   one composite pass. Exact for overlaps of one class; no stencil needed.
 * - `coreFringe` (M2 default): per class first the fully covered fragments, then the smoothed
 *   edge, both stencilled. Loses coverage where two edge fragments meet (thin lines).
 * - `single`: one stencilled pass per class, as proposed in M1.
 * - `off`: no stencil, for comparison only (roads in several tiles are blended repeatedly).
 *
 * The name is kept from M2, when every mode was a stencil mode.
 */
export type StencilMode = 'coverage' | 'coreFringe' | 'single' | 'off'

export const DEFAULT_STENCIL_MODE: StencilMode = 'coverage'

/**
 * Time per frame for building and uploading new tiles, milliseconds. At least one tile is
 * handled per frame, so a slow tile cannot stall loading. `Infinity` uploads everything in
 * `setTiles`, as in M2.
 */
export const DEFAULT_UPLOAD_BUDGET_MS = 6

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
  uploadBudgetMs?: number
  contextAttributes?: WebGLContextAttributes
  /** Use a context that renders in software instead of refusing it (lab comparisons only). */
  allowSoftwareRenderer?: boolean
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
  | { ok: false; reason: RendererFailure; detail?: string; gpu: GpuInfo }

export interface WebGL2Diagnostics {
  stencil: boolean
  /** The mode asked for, and the one in use (they differ after a coverage fallback). */
  requestedMode: StencilMode
  stencilMode: StencilMode
  /** Why `coverage` was not used, when it was asked for. */
  coverageFallback: string | null
  contextAttributes: WebGLContextAttributes | null
  gpu: string | null
  gpuInfo: GpuInfo
  losses: number
  /** Since the last `setTiles`: geometry building and upload of new tiles, and the slowest tile. */
  lastBuildMs: number
  lastUploadMs: number
  maxTileBuildMs: number
  lastNewTiles: number
  /** Since the last `setTiles`: the longest build-and-upload slice of one frame. */
  maxSliceMs: number
  pendingTiles: number
  skippedRoads: number
  culledTiles: number
  /** Bytes of the offscreen coverage target (`coverage` mode), not part of the buffer budget. */
  targetBytes: number
}

interface TileEntry extends CacheEntry {
  buffer: WebGLBuffer | null
  /** Stencil modes: per class in `DRAW_ORDER`; null for an empty class. */
  vaos: (WebGLVertexArrayObject | null)[]
  /** Coverage mode: one vertex array over the whole buffer. */
  all: WebGLVertexArrayObject | null
  groups: GroupRange[]
  instances: number
  originX: number
  originZ: number
  bounds: [number, number, number, number] | null
  roads: number
}

type Uniforms = Record<string, WebGLUniformLocation | null>
interface Program {
  program: WebGLProgram
  u: Uniforms
}

interface Programs {
  road: Program | null
  coverage: Program | null
  composite: Program | null
}

interface CoverageTarget {
  fbo: WebGLFramebuffer | null
  low: WebGLTexture | null
  high: WebGLTexture | null
  width: number
  height: number
}

const PASS_CORE = 0
const PASS_FRINGE = 1
const PASS_SINGLE = 2

const ROAD_UNIFORMS = [
  'u_offset',
  'u_scale',
  'u_viewport',
  'u_halfWidth',
  'u_color',
  'u_chordAlpha',
  'u_dash',
  'u_pass',
]
const COVERAGE_UNIFORMS = [
  'u_offset',
  'u_scale',
  'u_viewport',
  'u_halfWidth',
  'u_slot',
  'u_chordAlpha',
  'u_dashes',
]
const COMPOSITE_UNIFORMS = ['u_low', 'u_high', 'u_colors']

const ZERO4 = new Float32Array(4)

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

function linkProgram(
  gl: WebGL2RenderingContext,
  vsSource: string,
  fsSource: string,
  uniforms: readonly string[],
): Program | { reason: RendererFailure; detail: string } {
  const vs = compile(gl, gl.VERTEX_SHADER, vsSource)
  if ('log' in vs) return { reason: 'shader_compile', detail: `vertex: ${vs.log}` }
  const fs = compile(gl, gl.FRAGMENT_SHADER, fsSource)
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
  const u: Uniforms = {}
  for (const n of uniforms)
    u[n] = gl.getUniformLocation(program, `${n}[0]`) ?? gl.getUniformLocation(program, n)
  return { program, u }
}

/** Compiles and links the stencil-mode road program, or names the failure. */
export function createRoadProgram(
  gl: WebGL2RenderingContext,
): Program | { reason: RendererFailure; detail: string } {
  return linkProgram(gl, vertexSource, fragmentSource, ROAD_UNIFORMS)
}

/**
 * The programs for `mode`. `coverage` needs the coverage and composite programs; when either
 * fails, the stencil program with `coreFringe` is used instead and the reason is returned.
 */
function createPrograms(
  gl: WebGL2RenderingContext,
  mode: StencilMode,
):
  | { programs: Programs; mode: StencilMode; coverageFallback: string | null }
  | { reason: RendererFailure; detail: string } {
  let coverageFallback: string | null = null
  if (mode === 'coverage') {
    const coverage = linkProgram(gl, vertexSource, coverageFragmentSource, COVERAGE_UNIFORMS)
    if (!('reason' in coverage)) {
      const composite = linkProgram(
        gl,
        compositeVertexSource,
        compositeFragmentSource,
        COMPOSITE_UNIFORMS,
      )
      if (!('reason' in composite))
        return { programs: { road: null, coverage, composite }, mode, coverageFallback }
      gl.deleteProgram(coverage.program)
      coverageFallback = `composite ${composite.reason}: ${composite.detail}`
    } else coverageFallback = `coverage ${coverage.reason}: ${coverage.detail}`
  }
  const road = createRoadProgram(gl)
  if ('reason' in road) return road
  return {
    programs: { road, coverage: null, composite: null },
    mode: mode === 'coverage' ? 'coreFringe' : mode,
    coverageFallback,
  }
}

/**
 * Probes a throw-away canvas: does WebGL 2 exist when a major performance caveat is allowed?
 * Returns what renders it, or null without any WebGL 2 context.
 */
function probeWithoutCaveat(attributes: WebGLContextAttributes): GpuInfo | null {
  if (typeof document === 'undefined') return null
  const probe = document.createElement('canvas')
  let gl: WebGL2RenderingContext | null
  try {
    gl = probe.getContext('webgl2', {
      ...attributes,
      failIfMajorPerformanceCaveat: false,
    }) as WebGL2RenderingContext | null
  } catch {
    return null
  }
  if (!gl) return null
  const info = readGpuInfo(gl)
  gl.getExtension('WEBGL_lose_context')?.loseContext()
  return info
}

export function createWebGL2RoadRenderer(
  canvas: HTMLCanvasElement,
  options: WebGL2Options = {},
): CreateWebGL2Result {
  if (typeof WebGL2RenderingContext === 'undefined')
    return { ok: false, reason: 'webgl2_unavailable', gpu: UNAVAILABLE_GPU }
  const attributes = options.contextAttributes ?? DEFAULT_CONTEXT_ATTRIBUTES
  let gl: WebGL2RenderingContext | null
  try {
    gl = canvas.getContext('webgl2', attributes) as WebGL2RenderingContext | null
  } catch (e) {
    return { ok: false, reason: 'context_creation_failed', detail: String(e), gpu: UNAVAILABLE_GPU }
  }
  if (!gl) {
    const probe = attributes.failIfMajorPerformanceCaveat ? probeWithoutCaveat(attributes) : null
    if (!probe) return { ok: false, reason: 'context_creation_failed', gpu: UNAVAILABLE_GPU }
    // Only a context with a performance caveat exists. Its renderer string decides whether
    // that is software; otherwise the cause is unknown and stays reported as such.
    if (probe.gpuClass === 'SOFTWARE')
      return {
        ok: false,
        reason: 'software_renderer',
        detail: `major_performance_caveat: ${probe.renderer ?? ''}`,
        gpu: probe,
      }
    return {
      ok: false,
      reason: 'context_creation_failed',
      detail: 'major_performance_caveat',
      gpu: { ...probe, gpuClass: 'UNKNOWN', evidence: 'major_performance_caveat' },
    }
  }
  const gpu = readGpuInfo(gl)
  if (gpu.gpuClass === 'SOFTWARE' && !options.allowSoftwareRenderer) {
    gl.getExtension('WEBGL_lose_context')?.loseContext()
    return { ok: false, reason: 'software_renderer', detail: gpu.renderer ?? undefined, gpu }
  }
  const created = createPrograms(gl, options.stencilMode ?? DEFAULT_STENCIL_MODE)
  if ('reason' in created) {
    // On a context lost meanwhile every compile fails: that is not a shader error.
    if (gl.isContextLost())
      return {
        ok: false,
        reason: 'context_creation_failed',
        detail: 'context lost during setup',
        gpu,
      }
    gl.getExtension('WEBGL_lose_context')?.loseContext()
    return { ok: false, reason: created.reason, detail: created.detail, gpu }
  }
  return {
    ok: true,
    renderer: new WebGL2RoadRenderer(canvas, gl, created, gpu, options),
  }
}

export class WebGL2RoadRenderer implements RoadRenderer {
  readonly kind = 'webgl2' as const
  private readonly cache: GpuBufferCache<TileEntry>
  private readonly requestedMode: StencilMode
  private mode: StencilMode
  private coverageFallback: string | null
  private readonly uploadBudgetMs: number
  private readonly opts: Required<
    Pick<WebGL2Options, 'maxLosses' | 'lossWindowMs' | 'restoreTimeoutMs' | 'loseContextOnDispose'>
  >
  private readonly clock: () => number
  private status: RendererStatus = { state: 'ready' }
  private programs: Programs | null
  private target: CoverageTarget | null = null
  private disposed = false
  private hasStencil: boolean
  /** CPU-side tiles of the last `setTiles` (kept for a restore). */
  private tiles: readonly SyntheticTile[] = []
  /** Keys of the last `setTiles`, in its order. */
  private wanted: string[] = []
  /** Tiles of the last `setTiles` not built and uploaded yet. */
  private readonly queue = new Map<string, SyntheticTile>()
  private visibleEntries: TileEntry[] = []
  private contentId: string | null = null
  private viewport: Viewport = { cx: 0, cz: 0, scale: 1 }
  private cssWidth = 1
  private cssHeight = 1
  private dpr = 1
  private uploads = 0
  private lossTimes: number[] = []
  private restoreTimer: ReturnType<typeof setTimeout> | null = null
  private readonly gpu: GpuInfo
  private diag = {
    losses: 0,
    lastBuildMs: 0,
    lastUploadMs: 0,
    maxTileBuildMs: 0,
    lastNewTiles: 0,
    maxSliceMs: 0,
    skippedRoads: 0,
    culledTiles: 0,
  }
  private readonly halfWidths = new Float32Array(ROAD_CLASSES.length)
  private readonly colors = new Map<RoadClass, [number, number, number]>(
    ROAD_CLASSES.map((c) => [c, hexToRgb(ROAD_STYLES[c].color)]),
  )
  /** Coverage mode: draw-order slot per class index, dash and colour per slot. */
  private readonly slots = new Int32Array(ROAD_CLASSES.map((c) => DRAW_ORDER.indexOf(c)))
  private readonly slotDashes = new Float32Array(DRAW_ORDER.length * 2)
  private readonly slotColors = new Float32Array(
    DRAW_ORDER.flatMap((c) => hexToRgb(ROAD_STYLES[c].color)),
  )

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly gl: WebGL2RenderingContext,
    created: { programs: Programs; mode: StencilMode; coverageFallback: string | null },
    gpu: GpuInfo,
    private readonly options: WebGL2Options = {},
  ) {
    this.programs = created.programs
    this.requestedMode = options.stencilMode ?? DEFAULT_STENCIL_MODE
    this.mode = created.mode
    this.coverageFallback = created.coverageFallback
    this.gpu = gpu
    const budget = options.uploadBudgetMs ?? DEFAULT_UPLOAD_BUDGET_MS
    this.uploadBudgetMs = budget >= 0 ? budget : DEFAULT_UPLOAD_BUDGET_MS
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
    this.hasStencil = this.computeStencil()
    if (this.mode === 'coverage' && !this.ensureTarget(1, 1)) this.leaveCoverage()
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
      requestedMode: this.requestedMode,
      stencilMode: this.mode,
      coverageFallback: this.coverageFallback,
      contextAttributes: this.disposed ? null : this.gl.getContextAttributes(),
      gpu: this.gpu.renderer,
      gpuInfo: this.gpu,
      pendingTiles: this.queue.size,
      targetBytes: this.target ? this.target.width * this.target.height * 5 : 0,
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
      this.queue.clear()
      this.contentId = first.contentId
    }
    const own = tiles.filter((t) => t.contentId === this.contentId)
    this.tiles = own
    if (this.status.state !== 'ready') return
    this.enqueue(own)
  }

  /**
   * Makes `tiles` the wanted set: known tiles are drawn at once, the others are queued.
   * Queued tiles no longer wanted are dropped from the queue (they were never drawn).
   */
  private enqueue(tiles: readonly SyntheticTile[]): void {
    const keys: string[] = []
    const seen = new Set<string>()
    this.queue.clear()
    for (const tile of tiles) {
      const key = tileKey(tile.contentId, tile.level, tile.x, tile.z)
      if (seen.has(key)) continue
      seen.add(key)
      keys.push(key)
      if (!this.cache.get(key)) this.queue.set(key, tile)
    }
    this.wanted = keys
    this.cache.setVisible(keys)
    this.cache.evict()
    this.refreshVisible()
    this.diag.lastBuildMs = 0
    this.diag.lastUploadMs = 0
    this.diag.maxTileBuildMs = 0
    this.diag.lastNewTiles = 0
    this.diag.maxSliceMs = 0
    this.diag.skippedRoads = 0
    if (!Number.isFinite(this.uploadBudgetMs)) this.drain(Infinity)
  }

  private refreshVisible(): void {
    const entries: TileEntry[] = []
    for (const k of this.wanted) {
      const e = this.cache.peek(k)
      if (e) entries.push(e)
    }
    this.visibleEntries = entries
  }

  /**
   * The queue in loading order: tiles on screen before tiles off screen, each by distance of
   * the tile centre from the view centre (world units). Uses the current view, so a pan
   * during loading moves the newly visible tiles forward.
   */
  private prioritized(): [string, SyntheticTile][] {
    const { cx, cz, scale } = this.viewport
    const hw = this.cssWidth / 2 / scale
    const hh = this.cssHeight / 2 / scale
    const ranked = [...this.queue].map(([k, t]) => {
      const x0 = t.originX
      const z0 = t.originZ
      const x1 = x0 + t.tileSize
      const z1 = z0 + t.tileSize
      const off = x1 < cx - hw || x0 > cx + hw || z1 < cz - hh || z0 > cz + hh ? 1 : 0
      const d = Math.hypot((x0 + x1) / 2 - cx, (z0 + z1) / 2 - cz)
      return { k, t, off, d }
    })
    ranked.sort((a, b) => a.off - b.off || a.d - b.d)
    return ranked.map(({ k, t }) => [k, t])
  }

  /** Builds and uploads queued tiles until `budgetMs` has passed (at least one tile). */
  private drain(budgetMs: number): void {
    // A lost context (its event may still be on the way) gets no new objects.
    if (this.queue.size === 0 || this.gl.isContextLost()) return
    const gl = this.gl
    const start = this.clock()
    const deadline = start + budgetMs
    let newTiles = 0
    for (const [key, tile] of this.prioritized()) {
      if (newTiles > 0 && this.clock() >= deadline) break
      const t0 = this.clock()
      const geo = buildTileGeometry(tile)
      const t1 = this.clock()
      this.diag.lastBuildMs += t1 - t0
      this.diag.maxTileBuildMs = Math.max(this.diag.maxTileBuildMs, t1 - t0)
      this.diag.skippedRoads += geo.skippedRoads
      const entry: TileEntry = {
        key,
        bytes: geo.data.byteLength,
        buffer: null,
        vaos: geo.groups.map(() => null),
        all: null,
        groups: geo.groups,
        instances: geo.instances,
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
        this.createVaos(entry)
        gl.bindBuffer(gl.ARRAY_BUFFER, null)
      }
      this.diag.lastUploadMs += this.clock() - t1
      this.cache.put(entry)
      this.queue.delete(key)
      newTiles++
    }
    this.diag.lastNewTiles += newTiles
    this.diag.maxSliceMs = Math.max(this.diag.maxSliceMs, this.clock() - start)
    this.cache.evict()
    this.refreshVisible()
    // One error check per slice: `getError` waits for the GPU process.
    if (gl.getError() === gl.OUT_OF_MEMORY) this.fail('out_of_memory')
  }

  /** The vertex arrays the current mode draws with. */
  private createVaos(entry: TileEntry): void {
    if (!entry.buffer) return
    if (this.mode === 'coverage') {
      entry.all = this.createVao(entry.buffer, 0)
      return
    }
    entry.vaos = entry.groups.map((g) =>
      g.count > 0 ? this.createVao(entry.buffer!, g.first) : null,
    )
  }

  private createVao(buffer: WebGLBuffer, firstInstance: number): WebGLVertexArrayObject | null {
    const gl = this.gl
    const vao = gl.createVertexArray()
    gl.bindVertexArray(vao)
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer)
    // WebGL 2 has no base instance: the pointers start at the first instance of the range.
    const base = firstInstance * INSTANCE_BYTES
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
    if (e.all) this.gl.deleteVertexArray(e.all)
    if (e.buffer) this.gl.deleteBuffer(e.buffer)
    e.vaos = e.vaos.map(() => null)
    e.all = null
    e.buffer = null
  }

  private computeStencil(): boolean {
    return (
      this.mode !== 'off' &&
      this.mode !== 'coverage' &&
      this.gl.getContextAttributes()?.stencil === true
    )
  }

  /**
   * The offscreen coverage target in the size of the drawing buffer: RGBA8 for four classes
   * and R8 for the fifth. Returns false when the framebuffer is not complete.
   */
  private ensureTarget(width: number, height: number): boolean {
    const t = this.target
    if (t && t.width === width && t.height === height) return true
    this.releaseTarget()
    const gl = this.gl
    const texture = (format: number) => {
      const tex = gl.createTexture()
      gl.bindTexture(gl.TEXTURE_2D, tex)
      gl.texStorage2D(gl.TEXTURE_2D, 1, format, width, height)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
      return tex
    }
    const low = texture(gl.RGBA8)
    const high = texture(gl.R8)
    gl.bindTexture(gl.TEXTURE_2D, null)
    const fbo = gl.createFramebuffer()
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo)
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, low, 0)
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT1, gl.TEXTURE_2D, high, 0)
    gl.drawBuffers([gl.COLOR_ATTACHMENT0, gl.COLOR_ATTACHMENT1])
    const complete = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE
    gl.bindFramebuffer(gl.FRAMEBUFFER, null)
    this.target = { fbo, low, high, width, height }
    if (!complete) {
      this.releaseTarget()
      this.coverageFallback = 'coverage target incomplete'
    }
    return complete
  }

  private releaseTarget(): void {
    const t = this.target
    this.target = null
    if (!t || this.gl.isContextLost()) return
    if (t.fbo) this.gl.deleteFramebuffer(t.fbo)
    if (t.low) this.gl.deleteTexture(t.low)
    if (t.high) this.gl.deleteTexture(t.high)
  }

  /**
   * Switches from `coverage` to `coreFringe` (the coverage target cannot be used): builds the
   * stencil program and the per-class vertex arrays of every cached tile.
   */
  private leaveCoverage(): boolean {
    // A target that failed because the context is lost says nothing about coverage support:
    // stay in coverage mode and let the loss and restore handle it.
    if (this.gl.isContextLost()) return false
    const p = this.programs
    if (p?.coverage) this.gl.deleteProgram(p.coverage.program)
    if (p?.composite) this.gl.deleteProgram(p.composite.program)
    this.releaseTarget()
    this.mode = 'coreFringe'
    this.coverageFallback ??= 'coverage unavailable'
    const road = p?.road ?? createRoadProgram(this.gl)
    if ('reason' in road) {
      this.programs = null
      this.fail(road.reason, road.detail)
      return false
    }
    this.programs = { road, coverage: null, composite: null }
    this.hasStencil = this.computeStencil()
    for (const e of this.cache.values()) {
      if (e.all) this.gl.deleteVertexArray(e.all)
      e.all = null
      this.createVaos(e)
    }
    this.setupState()
    return true
  }

  private setupState(): void {
    const gl = this.gl
    gl.disable(gl.DEPTH_TEST)
    gl.disable(gl.CULL_FACE)
    gl.enable(gl.BLEND)
    gl.blendEquation(gl.FUNC_ADD)
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA)
    if (this.hasStencil) {
      gl.enable(gl.STENCIL_TEST)
      gl.stencilMask(0xff)
      gl.stencilOp(gl.KEEP, gl.KEEP, gl.REPLACE)
    } else gl.disable(gl.STENCIL_TEST)
    gl.clearColor(0, 0, 0, 0)
    gl.clearStencil(0)
  }

  private stats(roads = 0, segments = 0, drawCalls = 0): RenderStats {
    let vaos = 0
    let buffers = 0
    for (const e of this.cache.values()) {
      if (e.buffer) buffers++
      for (const v of e.vaos) if (v) vaos++
      if (e.all) vaos++
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
      pending: this.queue.size,
    }
  }

  render(): RenderStats {
    if (this.disposed) return { ...EMPTY_STATS }
    // `loseContext()` (or a GPU reset) loses the context at once, but `webglcontextlost`
    // arrives later. Until then nothing is drawn or created; the event does the rest.
    if (this.gl.isContextLost()) return this.stats()
    if (this.status.state !== 'ready' || !this.programs) return this.stats()
    if (this.queue.size > 0) this.drain(this.uploadBudgetMs)
    if (this.status.state !== 'ready' || !this.programs) return this.stats()
    const gl = this.gl
    const W = gl.drawingBufferWidth
    const H = gl.drawingBufferHeight
    const { cx, cz, scale } = this.viewport
    const k = scale * this.dpr
    let maxHalf = 0
    ROAD_CLASSES.forEach((c, i) => {
      this.halfWidths[i] = (lineWidth(c, scale) * this.dpr) / 2
      maxHalf = Math.max(maxHalf, this.halfWidths[i]!)
    })

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
    let roads = 0
    for (const d of drawn) roads += d.e.roads

    if (this.mode === 'coverage' && !this.ensureTarget(W, H) && !this.leaveCoverage())
      return this.stats()
    const result =
      this.mode === 'coverage'
        ? this.drawCoverage(drawn, W, H, k)
        : this.drawStencilled(drawn, W, H, k)
    return this.stats(roads, result.segments, result.drawCalls)
  }

  private drawCoverage(
    drawn: { e: TileEntry; ox: number; oz: number }[],
    W: number,
    H: number,
    k: number,
  ): { segments: number; drawCalls: number } {
    const gl = this.gl
    const cov = this.programs!.coverage!
    const comp = this.programs!.composite!
    const t = this.target!
    gl.viewport(0, 0, W, H)
    gl.clear(gl.COLOR_BUFFER_BIT)
    if (drawn.length === 0) return { segments: 0, drawCalls: 0 }

    // Pass 1: coverage of every class into its channel, MAX blended.
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, t.fbo)
    gl.clearBufferfv(gl.COLOR, 0, ZERO4)
    gl.clearBufferfv(gl.COLOR, 1, ZERO4)
    gl.useProgram(cov.program)
    gl.uniform2f(cov.u.u_viewport!, W, H)
    gl.uniform1f(cov.u.u_scale!, k)
    gl.uniform1f(cov.u.u_chordAlpha!, CHORD_ALPHA)
    gl.uniform1fv(cov.u.u_halfWidth!, this.halfWidths)
    gl.uniform1iv(cov.u.u_slot!, this.slots)
    DRAW_ORDER.forEach((c, slot) => {
      const dash = dashOf(c)
      this.slotDashes[slot * 2] = dash ? dash[0] * this.dpr : 0
      this.slotDashes[slot * 2 + 1] = dash ? (dash[0] + dash[1]) * this.dpr : 0
    })
    gl.uniform2fv(cov.u.u_dashes!, this.slotDashes)
    gl.blendEquation(gl.MAX)
    let drawCalls = 0
    let segments = 0
    for (const { e, ox, oz } of drawn) {
      if (!e.all) continue
      gl.uniform2f(cov.u.u_offset!, ox, oz)
      gl.bindVertexArray(e.all)
      gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, e.instances)
      drawCalls++
      segments += e.instances
    }
    gl.bindVertexArray(null)
    gl.blendEquation(gl.FUNC_ADD)
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, null)

    // Pass 2: the classes over each other in draw order, onto the canvas.
    gl.disable(gl.BLEND)
    gl.useProgram(comp.program)
    gl.activeTexture(gl.TEXTURE0)
    gl.bindTexture(gl.TEXTURE_2D, t.low)
    gl.activeTexture(gl.TEXTURE1)
    gl.bindTexture(gl.TEXTURE_2D, t.high)
    gl.uniform1i(comp.u.u_low!, 0)
    gl.uniform1i(comp.u.u_high!, 1)
    gl.uniform3fv(comp.u.u_colors!, this.slotColors)
    gl.drawArrays(gl.TRIANGLES, 0, 3)
    drawCalls++
    // Unbound again, so the next coverage pass never samples the target it draws into.
    gl.bindTexture(gl.TEXTURE_2D, null)
    gl.activeTexture(gl.TEXTURE0)
    gl.bindTexture(gl.TEXTURE_2D, null)
    gl.enable(gl.BLEND)
    return { segments, drawCalls }
  }

  private drawStencilled(
    drawn: { e: TileEntry; ox: number; oz: number }[],
    W: number,
    H: number,
    k: number,
  ): { segments: number; drawCalls: number } {
    const gl = this.gl
    const p = this.programs!.road!
    gl.viewport(0, 0, W, H)
    gl.clear(gl.COLOR_BUFFER_BIT | (this.hasStencil ? gl.STENCIL_BUFFER_BIT : 0))
    gl.useProgram(p.program)
    gl.uniform2f(p.u.u_viewport!, W, H)
    gl.uniform1f(p.u.u_scale!, k)
    gl.uniform1f(p.u.u_chordAlpha!, CHORD_ALPHA)
    gl.uniform1fv(p.u.u_halfWidth!, this.halfWidths)

    const passes =
      this.hasStencil && this.mode === 'coreFringe' ? [PASS_CORE, PASS_FRINGE] : [PASS_SINGLE]
    let drawCalls = 0
    let segments = 0
    DRAW_ORDER.forEach((roadClass, gi) => {
      if (!drawn.some((d) => d.e.vaos[gi])) return
      const [r, g, b] = this.colors.get(roadClass)!
      gl.uniform3f(p.u.u_color!, r, g, b)
      const dash = dashOf(roadClass)
      if (dash) gl.uniform2f(p.u.u_dash!, dash[0] * this.dpr, (dash[0] + dash[1]) * this.dpr)
      else gl.uniform2f(p.u.u_dash!, 0, 0)
      if (this.hasStencil) gl.stencilFunc(gl.NOTEQUAL, gi + 1, 0xff)
      for (const pass of passes) {
        gl.uniform1i(p.u.u_pass!, pass)
        for (const { e, ox, oz } of drawn) {
          const vao = e.vaos[gi]
          if (!vao) continue
          const count = e.groups[gi]!.count
          gl.uniform2f(p.u.u_offset!, ox, oz)
          gl.bindVertexArray(vao)
          gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, count)
          drawCalls++
          if (pass !== PASS_FRINGE) segments += count
        }
      }
    })
    gl.bindVertexArray(null)
    return { segments, drawCalls }
  }

  private setStatus(status: RendererStatus): void {
    this.status = status
    this.options.onStatus?.(status)
  }

  private deletePrograms(): void {
    const p = this.programs
    this.programs = null
    if (!p || this.gl.isContextLost()) return
    for (const x of [p.road, p.coverage, p.composite]) if (x) this.gl.deleteProgram(x.program)
  }

  private fail(reason: RendererFailure, detail?: string): void {
    if (this.status.state === 'failed') return
    this.clearRestoreTimer()
    if (!this.gl.isContextLost()) {
      this.cache.clear()
      this.releaseTarget()
      this.deletePrograms()
    } else {
      this.cache.forget()
      this.target = null
      this.programs = null
    }
    this.queue.clear()
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
    this.programs = null
    this.target = null
    this.queue.clear()
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
    // Lost again before this event was handled: wait for the next loss and restore.
    if (this.gl.isContextLost()) return
    this.clearRestoreTimer()
    const created = createPrograms(this.gl, this.requestedMode)
    if ('reason' in created) {
      if (!this.gl.isContextLost()) this.fail(created.reason, created.detail)
      return
    }
    this.programs = created.programs
    this.mode = created.mode
    this.coverageFallback = created.coverageFallback
    this.hasStencil = this.computeStencil()
    if (this.mode === 'coverage' && !this.ensureTarget(1, 1) && !this.leaveCoverage()) return
    this.setupState()
    this.status = { state: 'ready' }
    // Rebuild the visible geometry from the CPU-side tiles (incrementally, like any new tile).
    this.enqueue(this.tiles)
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
      this.releaseTarget()
      this.deletePrograms()
      if (this.opts.loseContextOnDispose) gl.getExtension('WEBGL_lose_context')?.loseContext()
    } else {
      this.cache.forget()
      this.target = null
      this.programs = null
    }
    this.queue.clear()
    this.visibleEntries = []
    this.tiles = []
  }
}
