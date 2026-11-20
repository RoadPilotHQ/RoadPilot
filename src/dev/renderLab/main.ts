/**
 * DEVELOPMENT ONLY: the M2 render lab. Compares the WebGL 2 prototype with the Canvas 2D
 * painter on synthetic road networks. It reads no package, no telemetry, calls no backend
 * command and changes no preference. `window.renderLab` is the interface of the desktop
 * measurement harness (docs/webgl-prototype.md).
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
import {
  createWebGL2RoadRenderer,
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
  /** Test switch: the WebGL canvas refuses a context, as without WebGL 2. */
  simulateNoWebGL2: boolean
}

const BACKGROUND: [number, number, number] = [0xf8, 0xf1, 0xe6]

const config: Config = {
  renderer: 'webgl2',
  stencilMode: 'coreFringe',
  scenario: 'small',
  segments: 100_000,
  lod: 'auto',
  budgetMiB: 64,
  simulateNoWebGL2: false,
}

// ---------------------------------------------------------------- DOM

const root = document.getElementById('lab')!
root.className = 'lab'
root.innerHTML = `
  <aside class="lab-panel">
    <h1>Render lab (M2 prototype)</h1>
    <p class="note">Synthetic data only. Not part of the dashboard.</p>
    <label>Renderer <select id="renderer"><option value="webgl2">WebGL 2</option><option value="canvas2d">Canvas 2D</option></select></label>
    <label>Stencil <select id="stencil"><option value="coreFringe">core + fringe</option><option value="single">single pass (M1)</option><option value="off">off (comparison)</option></select></label>
    <label>Scenario <select id="scenario">${SCENARIOS.map((s) => `<option value="${s.id}">${s.label}</option>`).join('')}</select></label>
    <label>Segments <input id="segments" type="number" min="10" step="1000" /></label>
    <label>Detail <select id="lod"><option value="auto">auto (as dashboard)</option><option value="full">full (level 0)</option></select></label>
    <label>GPU budget <input id="budget" type="number" min="0" step="8" /> </label>
    <label>No WebGL 2 <input id="nowebgl" type="checkbox" /></label>
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

const host = new RoadRendererHost(stage, {
  get webgl() {
    return { stencilMode: config.stencilMode, budgetBytes: config.budgetMiB * 1024 * 1024 }
  },
  createCanvas: () => {
    const c = document.createElement('canvas')
    if (config.simulateNoWebGL2) {
      const original = c.getContext.bind(c)
      c.getContext = ((type: string, attrs?: unknown) =>
        type === 'webgl2' ? null : original(type as '2d', attrs as never)) as never
    }
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
    if (frameLog.length > 4000) frameLog.splice(0, 1000)
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
    ['GPU', d?.gpu ?? '–'],
    ['Stencil', d ? `${d.stencilMode}${d.stencil ? '' : ' (no stencil buffer)'}` : '–'],
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
  config.simulateNoWebGL2 = ($('nowebgl') as HTMLInputElement).checked
}
function writeControls() {
  ;($('renderer') as HTMLSelectElement).value = config.renderer
  ;($('stencil') as HTMLSelectElement).value = config.stencilMode
  ;($('scenario') as HTMLSelectElement).value = config.scenario
  ;($('segments') as HTMLInputElement).value = String(config.segments)
  ;($('lod') as HTMLSelectElement).value = config.lod
  ;($('budget') as HTMLInputElement).value = String(config.budgetMiB)
  ;($('nowebgl') as HTMLInputElement).checked = config.simulateNoWebGL2
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
  const start = frameLog.length
  return () => into.push(...frameLog.slice(start))
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

/** Time from handing the tiles to the renderer to the first frame on screen, with readback. */
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
  r.render()
  readOnePixel()
  const t3 = performance.now()
  const diag = webglDiag()
  host.setTiles(currentTiles)
  return { ms: t3 - t0, setTilesMs: t1 - t0, renderMs: t3 - t2, tiles: currentTiles.length, diag }
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
async function compare(opts: { modes?: StencilMode[]; images?: boolean } = {}) {
  const modes = opts.modes ?? ['coreFringe', 'single', 'off']
  host.release()
  await nextFrames(2)
  const shot = (kind: RendererKind, mode?: StencilMode) => {
    const canvas = document.createElement('canvas')
    const created =
      kind === 'webgl2'
        ? createWebGL2RoadRenderer(canvas, { stencilMode: mode })
        : createCanvas2DRoadRenderer(canvas)
    if (!created.ok) return null
    const r = created.renderer
    r.resize(size.width, size.height, dpr)
    r.setView(view)
    r.setTiles(currentTiles)
    r.render()
    const px = readComposited(r, canvas)
    const image = opts.images ? toDataUrl(px, canvas.width, canvas.height) : undefined
    r.dispose()
    return { px, w: canvas.width, h: canvas.height, image }
  }
  const ref = shot('canvas2d')!
  const results: Record<string, unknown> = { canvas2dImage: ref.image }
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
    const diff = new Uint8ClampedArray(s.px.length)
    for (let i = 0; i < s.px.length; i += 3) {
      const lum = (p: Uint8ClampedArray) => p[i]! * 0.3 + p[i + 1]! * 0.59 + p[i + 2]! * 0.11
      const road = (p: Uint8ClampedArray) =>
        Math.abs(p[i]! - BACKGROUND[0]) +
          Math.abs(p[i + 1]! - BACKGROUND[1]) +
          Math.abs(p[i + 2]! - BACKGROUND[2]) >
        6
      if (road(ref.px) || road(s.px)) roadPx++
      const dl = lum(s.px) - lum(ref.px)
      const m = Math.max(
        Math.abs(s.px[i]! - ref.px[i]!),
        Math.abs(s.px[i + 1]! - ref.px[i + 1]!),
        Math.abs(s.px[i + 2]! - ref.px[i + 2]!),
      )
      sum += m
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
      meanAbs: sum / (s.px.length / 3),
      image: s.image,
      diffImage: opts.images ? toDataUrl(diff, s.w, s.h) : undefined,
    }
  }
  mount()
  host.setTiles(currentTiles)
  host.setView(view)
  return results
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
