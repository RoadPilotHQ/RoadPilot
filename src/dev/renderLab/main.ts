/**
 * DEVELOPMENT ONLY: the M2/M3 render lab. Compares the WebGL 2 prototype with the Canvas 2D
 * painter on synthetic road networks. It reads no package, no telemetry, calls no backend
 * command and changes no preference. `window.renderLab` is the interface of the desktop
 * measurement harness (docs/webgl-prototype.md); in M3 it runs inside RoadPilot's own
 * WebView2 as well as in a browser.
 */
import './lab.css'
import {
  clampScale,
  fitBounds,
  panBy,
  zoomAt,
  type Size,
  type Viewport,
} from '@/domain/mapViewport'
import { createCanvas2DRoadRenderer } from '@/ui/navigation/render/Canvas2DRoadRenderer'
import {
  RoadRendererHost,
  type Fallback,
  type FrameInfo,
} from '@/ui/navigation/render/createRoadRenderer'
import type {
  RendererKind,
  RendererStatus,
  RenderStats,
  RoadRenderer,
  SyntheticTile,
} from '@/ui/navigation/render/types'
import { readGpuInfo } from '@/ui/navigation/render/gpuInfo'
import {
  createWebGL2RoadRenderer,
  DEFAULT_CONTEXT_ATTRIBUTES,
  DEFAULT_STENCIL_MODE,
  DEFAULT_UPLOAD_BUDGET_MS,
  WebGL2RoadRenderer,
  type StencilMode,
} from '@/ui/navigation/render/WebGL2RoadRenderer'
import {
  buildScenario,
  SCENARIOS,
  ScenarioTiles,
  type LodMode,
  type Scenario,
  type ScenarioId,
} from '../syntheticScenarios'

interface Config {
  renderer: RendererKind
  stencilMode: StencilMode
  scenario: ScenarioId
  segments: number
  lod: LodMode
  budgetMiB: number
  /** M3: build-and-upload time per frame, ms; Infinity uploads everything at once (M2). */
  uploadBudgetMs: number
  /** Test switch: the WebGL canvas refuses a context, as without WebGL 2. */
  simulateNoWebGL2: boolean
  /** M3 test switch: no `WEBGL_debug_renderer_info`, masked `RENDERER` / `VENDOR`. */
  simulateMaskedRenderer: boolean
  /** M3: draw with a software renderer instead of falling back (comparisons only). */
  allowSoftwareRenderer: boolean
}

const BACKGROUND: [number, number, number] = [0xf8, 0xf1, 0xe6]

const config: Config = {
  renderer: 'webgl2',
  stencilMode: DEFAULT_STENCIL_MODE,
  scenario: 'small',
  segments: 100_000,
  lod: 'auto',
  budgetMiB: 64,
  uploadBudgetMs: DEFAULT_UPLOAD_BUDGET_MS,
  simulateNoWebGL2: false,
  simulateMaskedRenderer: false,
  allowSoftwareRenderer: false,
}

// ---------------------------------------------------------------- DOM

const root = document.getElementById('lab')!
root.className = 'lab'
root.innerHTML = `
  <aside class="lab-panel">
    <h1>Render lab (M3 prototype)</h1>
    <p class="note">Synthetic data only. Not part of the dashboard.</p>
    <label>Renderer <select id="renderer"><option value="webgl2">WebGL 2</option><option value="canvas2d">Canvas 2D</option></select></label>
    <label>Overlaps <select id="stencil"><option value="coverage">coverage, MAX (M3)</option><option value="coreFringe">stencil core + fringe (M2)</option><option value="single">stencil single pass (M1)</option><option value="off">off (comparison)</option></select></label>
    <label>Scenario <select id="scenario">${SCENARIOS.map((s) => `<option value="${s.id}">${s.label}</option>`).join('')}</select></label>
    <label>Segments <input id="segments" type="number" min="10" step="1000" /></label>
    <label>Detail <select id="lod"><option value="auto">auto (as dashboard)</option><option value="full">full (level 0)</option></select></label>
    <label>GPU budget <input id="budget" type="number" min="0" step="8" /> </label>
    <label>Upload ms/frame <input id="uploadBudget" type="number" min="0" step="1" placeholder="all at once" /></label>
    <label>No WebGL 2 <input id="nowebgl" type="checkbox" /></label>
    <label>Masked renderer <input id="masked" type="checkbox" /></label>
    <label>Allow software <input id="allowsw" type="checkbox" /></label>
    <div class="buttons">
      <button id="apply">Apply</button>
      <button id="zoomIn">+</button><button id="zoomOut">−</button>
      <button id="whole">Whole map</button>
    </div>
    <div class="buttons">
      <button id="lose">Lose context</button>
      <button id="restore">Restore context</button>
      <button id="release">Release resources</button>
      <button id="remount">Remount</button>
    </div>
    <div class="buttons"><button id="bench">Pan + 3 zoom cycles</button></div>
    <table id="stats"></table>
  </aside>
  <main class="lab-stage" id="stage"></main>
`
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T
const stage = $('stage')

// ---------------------------------------------------------------- frame pump

/** The one animation-frame loop of the lab: driver step, then at most one render. */
let queued: ((time: number) => void) | null = null
let driver: ((time: number) => void) | null = null
let pumping = false
function pump(time: number) {
  driver?.(time)
  const q = queued
  queued = null
  q?.(time)
  if (driver || queued) requestAnimationFrame(pump)
  else pumping = false
}
function ensurePump() {
  if (pumping) return
  pumping = true
  requestAnimationFrame(pump)
}

// ---------------------------------------------------------------- state

let scenario: Scenario
let tiler: ScenarioTiles
let view: Viewport = { cx: 0, cz: 0, scale: 1 }
let size: Size = { width: 1, height: 1 }
let dpr = window.devicePixelRatio || 1
let level = 0
let tileKeys = ''
let currentTiles: SyntheticTile[] = []
let lastFrame: FrameInfo | null = null
let status: RendererStatus = { state: 'ready' }
let fallback: Fallback | null = null
let lastSetTilesMs = 0
let lastTileGenMs = 0
const frameLog: FrameInfo[] = []
/** Frames ever logged; `collect` counts on it, since the log drops its oldest entries. */
let framesLogged = 0

const host = new RoadRendererHost(stage, {
  get webgl() {
    return {
      stencilMode: config.stencilMode,
      budgetBytes: config.budgetMiB * 1024 * 1024,
      uploadBudgetMs: config.uploadBudgetMs,
      allowSoftwareRenderer: config.allowSoftwareRenderer,
    }
  },
  createCanvas: () => {
    const c = document.createElement('canvas')
    if (config.simulateNoWebGL2) {
      const original = c.getContext.bind(c)
      c.getContext = ((type: string, attrs?: unknown) =>
        type === 'webgl2' ? null : original(type as '2d', attrs as never)) as never
    } else if (config.simulateMaskedRenderer) maskRenderer(c)
    return c
  },
  schedule: (cb) => {
    queued = cb
    ensurePump()
    return 1
  },
  cancel: () => {
    queued = null
  },
  onFrame: (info) => {
    lastFrame = info
    frameLog.push(info)
    framesLogged++
    if (frameLog.length > 4000) frameLog.splice(0, 1000)
    checkDpr()
    showStats()
  },
  onStatus: (_kind, s) => {
    status = s
    showStats()
  },
  onFallback: (fb) => {
    fallback = fb
    status = { state: 'ready' }
    showStats()
  },
})

/**
 * Test switch: the canvas's WebGL 2 context hides the diagnostic extension and reports the
 * masked strings some browsers use, as a browser without `WEBGL_debug_renderer_info` would.
 */
function maskRenderer(c: HTMLCanvasElement) {
  const original = c.getContext.bind(c)
  c.getContext = ((type: string, attrs?: unknown) => {
    const ctx = original(type as 'webgl2', attrs as never) as WebGL2RenderingContext | null
    if (type !== 'webgl2' || !ctx || (ctx as unknown as { masked?: boolean }).masked) return ctx
    const getExtension = ctx.getExtension.bind(ctx)
    const getParameter = ctx.getParameter.bind(ctx)
    ctx.getExtension = ((name: string) =>
      name === 'WEBGL_debug_renderer_info' ? null : getExtension(name)) as never
    ctx.getParameter = ((p: number) =>
      p === ctx.RENDERER ? 'WebKit WebGL' : p === ctx.VENDOR ? 'WebKit' : getParameter(p)) as never
    ;(ctx as unknown as { masked: boolean }).masked = true
    return ctx
  }) as never
}

function updateTiles() {
  const t0 = performance.now()
  const visible = tiler.visible(config.lod, view, size)
  lastTileGenMs = performance.now() - t0
  level = visible.level
  const keys = visible.tiles.map((t) => `${t.level}/${t.x}/${t.z}`).join(',')
  if (keys === tileKeys) return
  tileKeys = keys
  currentTiles = visible.tiles
  const t1 = performance.now()
  host.setTiles(currentTiles)
  lastSetTilesMs = performance.now() - t1
}

function setView(v: Viewport) {
  view = v
  updateTiles()
  host.setView(view)
}

function measureStage() {
  const r = stage.getBoundingClientRect()
  size = { width: Math.max(1, Math.round(r.width)), height: Math.max(1, Math.round(r.height)) }
  dpr = window.devicePixelRatio || 1
  host.resize(size.width, size.height, dpr)
}

/**
 * M3: a DPR change (browser zoom, other monitor, emulation) resizes the backing store. The
 * resolution media query reports real changes; WebView2 does not fire it for a DevTools
 * emulation change, so the ratio is also compared after every frame and twice a second.
 */
let dprChanges = 0
function checkDpr() {
  if ((window.devicePixelRatio || 1) === dpr) return
  dprChanges++
  measureStage()
  updateTiles()
  host.invalidate()
}
function watchDpr() {
  const query = window.matchMedia(`(resolution: ${window.devicePixelRatio || 1}dppx)`)
  query.addEventListener(
    'change',
    () => {
      checkDpr()
      watchDpr()
    },
    { once: true },
  )
}
watchDpr()
setInterval(checkDpr, 500)

function wholeMap() {
  setView(fitBounds(scenario.bounds, size) ?? view)
}

function loadScenario() {
  scenario = buildScenario(config.scenario, config.segments)
  tiler = new ScenarioTiles(scenario)
  tileKeys = ''
  currentTiles = []
}

function mount() {
  fallback = null
  status = { state: 'ready' }
  host.mount(config.renderer)
  measureStage()
  showStats()
}

// ---------------------------------------------------------------- stats

const mib = (b: number) => (b / 1024 / 1024).toFixed(2)
function quantile(values: number[], q: number): number {
  if (values.length === 0) return NaN
  const s = values.slice().sort((a, b) => a - b)
  return s[Math.min(s.length - 1, Math.floor(q * (s.length - 1) + 0.5))]!
}
function jsHeap(): number | null {
  const m = (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory
  return m ? m.usedJSHeapSize : null
}
function webglDiag() {
  const r = host.renderer
  return r instanceof WebGL2RoadRenderer ? r.diagnostics() : null
}

function showStats() {
  const s: RenderStats | undefined = lastFrame?.stats
  const d = webglDiag()
  const gaps = frameGaps(frameLog.slice(-240))
  const statusText = status.state === 'failed' ? `failed: ${status.reason}` : status.state
  const rows: [string, string][] = [
    ['Renderer', host.renderer?.kind ?? 'none'],
    ['Status', statusText],
    [
      'Fallback',
      fallback ? `${fallback.reason}${fallback.detail ? ` (${fallback.detail})` : ''}` : '–',
    ],
    ['GPU', d?.gpu ?? fallback?.gpu?.renderer ?? '–'],
    ['GPU class', gpuClassText()],
    ['Overlaps', overlapText()],
    ['DPR', String(dpr)],
    ['Canvas', `${size.width} × ${size.height}`],
    ['Scenario segments', scenario ? scenario.segments.toLocaleString('en') : '–'],
    ['Level / tiles', `${level} / ${currentTiles.length}`],
    ['Scale', view.scale.toPrecision(4)],
    ['Roads drawn', String(s?.roads ?? 0)],
    ['Segments drawn', (s?.segments ?? 0).toLocaleString('en')],
    ['Draw calls', String(s?.drawCalls ?? 0)],
    ['Uploads', String(s?.uploads ?? 0)],
    ['GPU buffers', String(s?.buffers ?? 0)],
    ['Vertex arrays', String(s?.vertexArrays ?? 0)],
    ['GPU bytes (MiB)', `${mib(s?.gpuBytes ?? 0)} / ${mib(s?.budgetBytes ?? 0)}`],
    ['Over budget', s?.overBudget ? 'yes' : 'no'],
    ['Loading', s?.pending ? `${s.pending} tiles pending` : 'complete'],
    ['Target (MiB)', d ? mib(d.targetBytes) : '–'],
    ['render() ms', lastFrame ? lastFrame.renderMs.toFixed(2) : '–'],
    ['setTiles ms', lastSetTilesMs.toFixed(2)],
    ['Build / upload ms', d ? `${d.lastBuildMs.toFixed(2)} / ${d.lastUploadMs.toFixed(2)}` : '–'],
    ['FPS (last 240)', gaps.fps.toFixed(1)],
    [
      'Gap p50 / p95 / max',
      `${gaps.p50.toFixed(1)} / ${gaps.p95.toFixed(1)} / ${gaps.max.toFixed(1)}`,
    ],
    ['Context losses', String(d?.losses ?? 0)],
    ['JS heap (MiB)', jsHeap() === null ? 'n/a' : mib(jsHeap()!)],
  ]
  $('stats').innerHTML = rows
    .map(
      ([k, v]) =>
        `<tr><td>${k}</td><td class="${k === 'Status' && status.state === 'failed' ? 'status-failed' : ''}">${v}</td></tr>`,
    )
    .join('')
}

function gpuClassText(): string {
  const g = webglDiag()?.gpuInfo ?? fallback?.gpu
  return g ? `${g.gpuClass} (${g.evidence}${g.unmasked ? '' : ', masked'})` : '–'
}

function overlapText(): string {
  const d = webglDiag()
  if (!d) return '–'
  const fb = d.coverageFallback ? ` (fallback: ${d.coverageFallback})` : ''
  const noStencil = d.stencilMode !== 'coverage' && !d.stencil ? ' (no stencil buffer)' : ''
  return `${d.stencilMode}${fb}${noStencil}`
}

/** Gaps between consecutive rendered frames (only frames rendered back to back count). */
function frameGaps(frames: FrameInfo[]) {
  const gaps: number[] = []
  for (let i = 1; i < frames.length; i++) gaps.push(frames[i]!.time - frames[i - 1]!.time)
  const span = frames.length > 1 ? frames[frames.length - 1]!.time - frames[0]!.time : 0
  return {
    fps: span > 0 ? ((frames.length - 1) * 1000) / span : 0,
    p50: quantile(gaps, 0.5),
    p95: quantile(gaps, 0.95),
    max: gaps.length ? Math.max(...gaps) : NaN,
  }
}

// ---------------------------------------------------------------- controls

function readControls() {
  config.renderer = ($('renderer') as HTMLSelectElement).value as RendererKind
  config.stencilMode = ($('stencil') as HTMLSelectElement).value as StencilMode
  config.scenario = ($('scenario') as HTMLSelectElement).value as ScenarioId
  config.segments = Number(($('segments') as HTMLInputElement).value) || 100_000
  config.lod = ($('lod') as HTMLSelectElement).value as LodMode
  config.budgetMiB = Math.max(0, Number(($('budget') as HTMLInputElement).value) || 0)
  const ub = ($('uploadBudget') as HTMLInputElement).value
  config.uploadBudgetMs = ub === '' ? Infinity : Math.max(0, Number(ub) || 0)
  config.simulateNoWebGL2 = ($('nowebgl') as HTMLInputElement).checked
  config.simulateMaskedRenderer = ($('masked') as HTMLInputElement).checked
  config.allowSoftwareRenderer = ($('allowsw') as HTMLInputElement).checked
}
function writeControls() {
  ;($('renderer') as HTMLSelectElement).value = config.renderer
  ;($('stencil') as HTMLSelectElement).value = config.stencilMode
  ;($('scenario') as HTMLSelectElement).value = config.scenario
  ;($('segments') as HTMLInputElement).value = String(config.segments)
  ;($('lod') as HTMLSelectElement).value = config.lod
  ;($('budget') as HTMLInputElement).value = String(config.budgetMiB)
  ;($('uploadBudget') as HTMLInputElement).value = Number.isFinite(config.uploadBudgetMs)
    ? String(config.uploadBudgetMs)
    : ''
  ;($('nowebgl') as HTMLInputElement).checked = config.simulateNoWebGL2
  ;($('masked') as HTMLInputElement).checked = config.simulateMaskedRenderer
  ;($('allowsw') as HTMLInputElement).checked = config.allowSoftwareRenderer
}

$('scenario').addEventListener('change', () => {
  const def = SCENARIOS.find((s) => s.id === ($('scenario') as HTMLSelectElement).value)
  if (def?.defaultSegments) ($('segments') as HTMLInputElement).value = String(def.defaultSegments)
})
$('apply').addEventListener('click', () => {
  readControls()
  apply()
})
$('zoomIn').addEventListener('click', () =>
  setView(zoomAt(view, size, 2, size.width / 2, size.height / 2)),
)
$('zoomOut').addEventListener('click', () =>
  setView(zoomAt(view, size, 0.5, size.width / 2, size.height / 2)),
)
$('whole').addEventListener('click', wholeMap)
$('lose').addEventListener('click', () => loseContext())
$('restore').addEventListener('click', () => restoreContext())
$('release').addEventListener('click', () => {
  host.release()
  lastFrame = null
  showStats()
})
$('remount').addEventListener('click', mount)
$('bench').addEventListener('click', async () => {
  await run('pan')
  await run('zoom')
})

stage.addEventListener('wheel', (e) => {
  e.preventDefault()
  const r = stage.getBoundingClientRect()
  setView(zoomAt(view, size, e.deltaY < 0 ? 1.25 : 0.8, e.clientX - r.left, e.clientY - r.top))
})
let drag: { x: number; y: number } | null = null
stage.addEventListener('pointerdown', (e) => {
  drag = { x: e.clientX, y: e.clientY }
  stage.setPointerCapture(e.pointerId)
})
stage.addEventListener('pointermove', (e) => {
  if (!drag) return
  setView(panBy(view, e.clientX - drag.x, e.clientY - drag.y))
  drag = { x: e.clientX, y: e.clientY }
})
stage.addEventListener('pointerup', () => (drag = null))
new ResizeObserver(() => {
  measureStage()
  updateTiles()
  host.invalidate()
}).observe(stage)

// ---------------------------------------------------------------- context loss

/**
 * The extension of the current WebGL canvas. `getExtension` returns null while the context is
 * lost, so the object is kept from before the loss to be able to restore.
 */
let loseExt: { canvas: HTMLCanvasElement; ext: WEBGL_lose_context | null } | null = null
function loseExtension(): WEBGL_lose_context | null {
  const c = host.canvas
  if (!c || host.renderer?.kind !== 'webgl2') return null
  if (loseExt?.canvas === c && loseExt.ext) return loseExt.ext
  const gl = c.getContext('webgl2') as WebGL2RenderingContext | null
  loseExt = { canvas: c, ext: gl?.getExtension('WEBGL_lose_context') ?? null }
  return loseExt.ext
}
function loseContext(): boolean {
  const ext = loseExtension()
  ext?.loseContext()
  return ext !== null
}
function restoreContext(): boolean {
  const ext = loseExtension()
  ext?.restoreContext()
  return ext !== null
}

// ---------------------------------------------------------------- harness interface

function apply() {
  loadScenario()
  writeControls()
  mount()
  wholeMap()
}

function nextFrames(n = 1): Promise<void> {
  return new Promise((resolve) => {
    let left = n
    const step = () => (--left <= 0 ? resolve() : requestAnimationFrame(step))
    requestAnimationFrame(step)
  })
}

interface PhaseResult {
  phase: string
  frames: number
  durationMs: number
  fps: number
  gapP50: number
  gapP95: number
  gapMax: number
  renderP50: number
  renderP95: number
  renderMax: number
  setTilesMax: number
  setTilesTotal: number
  tileGenMax: number
  uploads: number
  drawCallsMax: number
  segmentsMax: number
  gpuBytesMax: number
  buffersMax: number
  overBudget: boolean
}

/** Animates the view every frame: `pan` for `ms`, or `zoom` cycles (in ×64 and out). */
function run(phase: 'pan' | 'zoom', opts: { ms?: number; cycles?: number } = {}) {
  return new Promise<PhaseResult>((resolve) => {
    const start = view
    const frames: FrameInfo[] = []
    const setTilesTimes: number[] = []
    const genTimes: number[] = []
    const firstUploads = lastFrame?.stats.uploads ?? 0
    let t0 = -1
    const total = phase === 'pan' ? (opts.ms ?? 3000) : (opts.cycles ?? 3) * 3000
    const stopFrameCollect = collect(frames)
    driver = (time) => {
      if (t0 < 0) t0 = time
      const t = time - t0
      if (t >= total) {
        driver = null
        setTimeout(() => {
          stopFrameCollect()
          setView(start)
          resolve(summarize(phase, frames, setTilesTimes, genTimes, firstUploads))
        }, 0)
        return
      }
      let next: Viewport
      if (phase === 'pan') {
        // A circle of 300 CSS pixels radius, one turn per 1.5 s.
        const a = (t / 1500) * Math.PI * 2
        const r = 300 / start.scale
        next = { ...start, cx: start.cx + Math.cos(a) * r - r, cz: start.cz + Math.sin(a) * r }
      } else {
        const c = (t % 3000) / 1500
        const f = c <= 1 ? c : 2 - c
        next = { ...start, scale: clampScale(start.scale * 64 ** f) }
      }
      view = next
      updateTiles()
      setTilesTimes.push(lastSetTilesMs)
      genTimes.push(lastTileGenMs)
      host.setView(view)
    }
    ensurePump()
  })
}

function collect(into: FrameInfo[]) {
  const start = framesLogged
  return () => {
    const n = Math.min(framesLogged - start, frameLog.length)
    if (n > 0) into.push(...frameLog.slice(-n))
  }
}

function summarize(
  phase: string,
  frames: FrameInfo[],
  setTiles: number[],
  gen: number[],
  firstUploads: number,
): PhaseResult {
  const g = frameGaps(frames)
  const r = frames.map((f) => f.renderMs)
  const last = frames[frames.length - 1]?.stats
  return {
    phase,
    frames: frames.length,
    durationMs: frames.length > 1 ? frames[frames.length - 1]!.time - frames[0]!.time : 0,
    fps: g.fps,
    gapP50: g.p50,
    gapP95: g.p95,
    gapMax: g.max,
    renderP50: quantile(r, 0.5),
    renderP95: quantile(r, 0.95),
    renderMax: r.length ? Math.max(...r) : NaN,
    setTilesMax: setTiles.length ? Math.max(...setTiles) : 0,
    setTilesTotal: setTiles.reduce((a, b) => a + b, 0),
    tileGenMax: gen.length ? Math.max(...gen) : 0,
    uploads: (last?.uploads ?? firstUploads) - firstUploads,
    drawCallsMax: Math.max(0, ...frames.map((f) => f.stats.drawCalls)),
    segmentsMax: Math.max(0, ...frames.map((f) => f.stats.segments)),
    gpuBytesMax: Math.max(0, ...frames.map((f) => f.stats.gpuBytes)),
    buffersMax: Math.max(0, ...frames.map((f) => f.stats.buffers)),
    overBudget: frames.some((f) => f.stats.overBudget),
  }
}

/**
 * Time from handing the tiles to a new, empty renderer to the first frame with geometry on
 * screen (`ms`, with a one-pixel read-back to wait for the GPU) and, with incremental uploads
 * (M3), to the frame where nothing is pending (`fullMs`). Every frame of the load runs in its
 * own animation frame; `maxBlockMs` is the longest `render()` call (main-thread blocking).
 */
async function firstFrame() {
  // The new renderer must start empty, so that building and uploading are measured below.
  host.setTiles([])
  host.release()
  await nextFrames(2)
  mount()
  tileKeys = ''
  const visible = tiler.visible(config.lod, view, size)
  currentTiles = visible.tiles
  tileKeys = visible.tiles.map((t) => `${t.level}/${t.x}/${t.z}`).join(',')
  const r = host.renderer!
  const t0 = performance.now()
  r.setTiles(currentTiles)
  const t1 = performance.now()
  r.setView(view)
  const t2 = performance.now()
  let stats = r.render()
  readOnePixel()
  const t3 = performance.now()
  const first = { ms: t3 - t0, segments: stats.segments, pending: stats.pending }
  const blocks = [t3 - t2]
  const times = [t3]
  // The rest of the load, one render per animation frame, as the host would drive it.
  while (stats.pending > 0 && host.renderer === r) {
    await nextFrames(1)
    const a = performance.now()
    stats = r.render()
    const b = performance.now()
    blocks.push(b - a)
    times.push(b)
  }
  readOnePixel()
  const t4 = performance.now()
  const gaps: number[] = []
  for (let i = 1; i < times.length; i++) gaps.push(times[i]! - times[i - 1]!)
  const diag = webglDiag()
  host.setTiles(currentTiles)
  return {
    ms: first.ms,
    firstSegments: first.segments,
    firstPending: first.pending,
    fullMs: t4 - t0,
    fullSegments: stats.segments,
    loadFrames: blocks.length,
    maxBlockMs: Math.max(...blocks),
    loadGapMax: gaps.length ? Math.max(...gaps) : 0,
    setTilesMs: t1 - t0,
    renderMs: t3 - t2,
    tiles: currentTiles.length,
    diag,
  }
}

/**
 * CPU + GPU time per frame of the mounted renderer: `n` frames back to back, each followed by
 * a one-pixel read-back, so each sample includes the GPU's work. Median and p95, ms.
 */
async function gpuTime(n = 60) {
  const r = host.renderer
  if (!r) return null
  await nextFrames(2)
  const samples: number[] = []
  for (let i = 0; i < n; i++) {
    const t = performance.now()
    r.render()
    readOnePixel()
    samples.push(performance.now() - t)
  }
  return { median: quantile(samples, 0.5), p95: quantile(samples, 0.95), max: Math.max(...samples) }
}

/**
 * What the browser reports about WebGL 2 on throw-away canvases, per power preference:
 * renderer strings (plain and unmasked), class, limits, extensions, and whether a context
 * exists with and without `failIfMajorPerformanceCaveat`.
 */
function gpuReport() {
  const probe = (attrs: WebGLContextAttributes) => {
    const c = document.createElement('canvas')
    let gl: WebGL2RenderingContext | null
    try {
      gl = c.getContext('webgl2', attrs) as WebGL2RenderingContext | null
    } catch (e) {
      return { context: false, error: String(e) }
    }
    if (!gl) return { context: false }
    const info = readGpuInfo(gl)
    const out = {
      context: true,
      ...info,
      plainRenderer: gl.getParameter(gl.RENDERER) as string,
      plainVendor: gl.getParameter(gl.VENDOR) as string,
      version: gl.getParameter(gl.VERSION) as string,
      glsl: gl.getParameter(gl.SHADING_LANGUAGE_VERSION) as string,
      maxTextureSize: gl.getParameter(gl.MAX_TEXTURE_SIZE) as number,
      maxDrawBuffers: gl.getParameter(gl.MAX_DRAW_BUFFERS) as number,
      maxSamples: gl.getParameter(gl.MAX_SAMPLES) as number,
      attributes: gl.getContextAttributes(),
      extensions: gl.getSupportedExtensions(),
    }
    gl.getExtension('WEBGL_lose_context')?.loseContext()
    return out
  }
  return {
    userAgent: navigator.userAgent,
    devicePixelRatio: window.devicePixelRatio,
    screen: { width: screen.width, height: screen.height },
    default: probe(DEFAULT_CONTEXT_ATTRIBUTES),
    withoutCaveat: probe({ ...DEFAULT_CONTEXT_ATTRIBUTES, failIfMajorPerformanceCaveat: false }),
    highPerformance: probe({ ...DEFAULT_CONTEXT_ATTRIBUTES, powerPreference: 'high-performance' }),
    lowPower: probe({ ...DEFAULT_CONTEXT_ATTRIBUTES, powerPreference: 'low-power' }),
  }
}

/** Waits for the GPU: reads one pixel back. */
function readOnePixel() {
  const c = host.canvas
  if (!c) return
  if (host.renderer?.kind === 'webgl2') {
    const gl = c.getContext('webgl2') as WebGL2RenderingContext
    gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(4))
  } else c.getContext('2d')?.getImageData(0, 0, 1, 1)
}

/** Composites a canvas over the map background: RGB per pixel, top row first. */
function readComposited(renderer: RoadRenderer, canvas: HTMLCanvasElement): Uint8ClampedArray {
  const w = canvas.width
  const h = canvas.height
  const out = new Uint8ClampedArray(w * h * 3)
  if (renderer.kind === 'webgl2') {
    const gl = canvas.getContext('webgl2') as WebGL2RenderingContext
    const px = new Uint8Array(w * h * 4)
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px)
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        const i = ((h - 1 - y) * w + x) * 4 // bottom-up, premultiplied
        const a = px[i + 3]! / 255
        for (let c = 0; c < 3; c++) out[(y * w + x) * 3 + c] = px[i + c]! + BACKGROUND[c]! * (1 - a)
      }
  } else {
    const data = canvas.getContext('2d')!.getImageData(0, 0, w, h).data
    for (let i = 0, j = 0; i < data.length; i += 4, j += 3) {
      const a = data[i + 3]! / 255
      for (let c = 0; c < 3; c++) out[j + c] = data[i + c]! * a + BACKGROUND[c]! * (1 - a)
    }
  }
  return out
}

/**
 * Renders the current view once per renderer on detached canvases, one renderer at a time
 * (the live renderer is released first), and compares each WebGL mode with Canvas 2D.
 */
async function compare(
  opts: { modes?: StencilMode[]; images?: boolean; dpr?: number; timeFrames?: number } = {},
) {
  const modes = opts.modes ?? ['coverage', 'coreFringe', 'single', 'off']
  const ratio = opts.dpr ?? dpr
  const timeFrames = opts.timeFrames ?? 0
  host.release()
  await nextFrames(2)
  const shot = (kind: RendererKind, mode?: StencilMode) => {
    const canvas = document.createElement('canvas')
    const created =
      kind === 'webgl2'
        ? createWebGL2RoadRenderer(canvas, {
            stencilMode: mode,
            // One complete frame: everything uploaded before it.
            uploadBudgetMs: Infinity,
            allowSoftwareRenderer: config.allowSoftwareRenderer,
          })
        : createCanvas2DRoadRenderer(canvas)
    if (!created.ok) return null
    const r = created.renderer
    r.resize(size.width, size.height, ratio)
    r.setView(view)
    r.setTiles(currentTiles)
    const stats = r.render()
    const px = readComposited(r, canvas)
    // CPU + GPU time of one frame of this mode (render and a one-pixel read-back).
    const samples: number[] = []
    for (let i = 0; i < timeFrames; i++) {
      const t = performance.now()
      r.render()
      readOne(r, canvas)
      samples.push(performance.now() - t)
    }
    const image = opts.images ? toDataUrl(px, canvas.width, canvas.height) : undefined
    const mode2 = r instanceof WebGL2RoadRenderer ? r.diagnostics().stencilMode : null
    r.dispose()
    return {
      px,
      w: canvas.width,
      h: canvas.height,
      image,
      drawCalls: stats.drawCalls,
      usedMode: mode2,
      frameMedian: samples.length ? quantile(samples, 0.5) : null,
      frameP95: samples.length ? quantile(samples, 0.95) : null,
    }
  }
  const ref = shot('canvas2d')!
  const results: Record<string, unknown> = {
    canvas2dImage: ref.image,
    canvas2d: { frameMedian: ref.frameMedian, frameP95: ref.frameP95, drawCalls: ref.drawCalls },
    dpr: ratio,
    size: [ref.w, ref.h],
  }
  for (const mode of modes) {
    const s = shot('webgl2', mode)
    if (!s) {
      results[mode] = null
      continue
    }
    let differs = 0
    let lighter = 0
    let darker = 0
    let sum = 0
    let roadPx = 0
    let roadSum = 0
    let missing = 0
    let extra = 0
    const diff = new Uint8ClampedArray(s.px.length)
    for (let i = 0; i < s.px.length; i += 3) {
      const lum = (p: Uint8ClampedArray) => p[i]! * 0.3 + p[i + 1]! * 0.59 + p[i + 2]! * 0.11
      const fromBg = (p: Uint8ClampedArray) =>
        Math.abs(p[i]! - BACKGROUND[0]) +
        Math.abs(p[i + 1]! - BACKGROUND[1]) +
        Math.abs(p[i + 2]! - BACKGROUND[2])
      const road = (p: Uint8ClampedArray) => fromBg(p) > 6
      const isRoad = road(ref.px) || road(s.px)
      if (isRoad) roadPx++
      // Continuity: a clear road pixel in Canvas 2D that WebGL leaves (almost) empty, or the
      // reverse. A gap or a cut-off cap shows here, a slightly lighter edge does not.
      if (fromBg(ref.px) > 48 && fromBg(s.px) <= 6) missing++
      if (fromBg(s.px) > 48 && fromBg(ref.px) <= 6) extra++
      const dl = lum(s.px) - lum(ref.px)
      const m = Math.max(
        Math.abs(s.px[i]! - ref.px[i]!),
        Math.abs(s.px[i + 1]! - ref.px[i + 1]!),
        Math.abs(s.px[i + 2]! - ref.px[i + 2]!),
      )
      sum += m
      if (isRoad) roadSum += m
      if (m > 24) {
        differs++
        if (dl > 0) lighter++
        else darker++
      }
      diff[i] = dl > 24 ? 255 : 255 - Math.min(255, m * 4)
      diff[i + 1] = 255 - Math.min(255, m * 4)
      diff[i + 2] = dl < -24 ? 255 : 255 - Math.min(255, m * 4)
    }
    results[mode] = {
      pixels: s.px.length / 3,
      roadPixels: roadPx,
      differ: differs,
      differShareOfRoad: roadPx ? differs / roadPx : 0,
      lighterThanCanvas: lighter,
      darkerThanCanvas: darker,
      lighterShareOfRoad: roadPx ? lighter / roadPx : 0,
      missing,
      extra,
      meanAbs: sum / (s.px.length / 3),
      meanAbsRoad: roadPx ? roadSum / roadPx : 0,
      usedMode: s.usedMode,
      drawCalls: s.drawCalls,
      frameMedian: s.frameMedian,
      frameP95: s.frameP95,
      image: s.image,
      diffImage: opts.images ? toDataUrl(diff, s.w, s.h) : undefined,
    }
  }
  mount()
  host.setTiles(currentTiles)
  host.setView(view)
  return results
}

/** Waits for the GPU of one renderer: reads one pixel back. */
function readOne(renderer: RoadRenderer, canvas: HTMLCanvasElement) {
  if (renderer.kind === 'webgl2') {
    const gl = canvas.getContext('webgl2') as WebGL2RenderingContext
    gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(4))
  } else canvas.getContext('2d')?.getImageData(0, 0, 1, 1)
}

function toDataUrl(rgb: Uint8ClampedArray, w: number, h: number): string {
  const c = document.createElement('canvas')
  c.width = w
  c.height = h
  const ctx = c.getContext('2d')!
  const img = ctx.createImageData(w, h)
  for (let i = 0, j = 0; j < rgb.length; i += 4, j += 3) {
    img.data[i] = rgb[j]!
    img.data[i + 1] = rgb[j + 1]!
    img.data[i + 2] = rgb[j + 2]!
    img.data[i + 3] = 255
  }
  ctx.putImageData(img, 0, 0)
  return c.toDataURL('image/png')
}

declare global {
  interface Window {
    renderLab: unknown
  }
}

window.renderLab = {
  configure(partial: Partial<Config>) {
    Object.assign(config, partial)
    apply()
    return state()
  },
  state,
  setView: (v: Viewport) => setView(v),
  zoom: (factor: number) => setView(zoomAt(view, size, factor, size.width / 2, size.height / 2)),
  wholeMap,
  run,
  firstFrame,
  compare,
  gpuTime,
  gpuReport,
  loseContext,
  restoreContext,
  release: () => host.release(),
  remount: mount,
  nextFrames,
  frames: () => frameGaps(frameLog.slice(-240)),
}

function state() {
  return {
    config: { ...config },
    renderer: host.renderer?.kind ?? null,
    status,
    fallback,
    dpr,
    dprChanges,
    size,
    view,
    level,
    tiles: currentTiles.length,
    scenarioSegments: scenario?.segments ?? 0,
    stats: lastFrame?.stats ?? null,
    renderMs: lastFrame?.renderMs ?? null,
    webgl: webglDiag(),
    jsHeap: jsHeap(),
  }
}

apply()
