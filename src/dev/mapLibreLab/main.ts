/**
 * DEVELOPMENT ONLY (Phase 2.4D B1): the MapLibre lab. Draws synthetic road networks with MapLibre
 * GL JS in a registered planar CRS (`roadpilot:scs`, or the built-in `identity` for comparison) and,
 * on the very same dataset and viewport, with the unchanged M3 WebGL 2 prototype.
 *
 * Served only by the Vite dev server (`/src/dev/mapLibreLab/index.html`); nothing in the app imports
 * it, and the production build does not contain it. No backend, no IPC, no telemetry, no settings;
 * it stores nothing. `window.mapLibreLab` is the interface of the desktop harness.
 */
import 'maplibre-gl/dist/maplibre-gl.css'
import './lab.css'
import {
  addProjection,
  getGlobalDispatcher,
  getVersion,
  getWorkerUrl,
  Map as MapLibreMap,
  NavigationControl,
  prewarm,
  setWorkerUrl,
  type GeoJSONSource,
  type IControl,
  type MapEventType,
  type MapGeoJSONFeature,
} from 'maplibre-gl'
import workerEntryUrl from './scsWorkerEntry.mjs?url'
import { fitBounds } from '@/domain/mapViewport'
import type { MapTile } from '@/domain/mapTile'
import {
  createWebGL2RoadRenderer,
  DEFAULT_STENCIL_MODE,
  DEFAULT_UPLOAD_BUDGET_MS,
  type WebGL2RoadRenderer,
} from '@/ui/navigation/render/WebGL2RoadRenderer'
import { ScenarioTiles } from '../syntheticScenarios'
import {
  checkProbeInfrastructure,
  summarizeAccuracy,
  type AccuracyCase,
  type ProbeResult,
} from './accuracyReport'
import {
  cameraOf,
  expectedScreen,
  fromCarrier,
  pixelsPerUnit,
  scsCrs,
  toCarrier,
  viewportOf,
  zoomForScale,
  type CrsChoice,
  type NativePoint,
} from './coordinates'
import {
  createRetryableInit,
  DEFAULT_LOAD_TIMEOUT_MS,
  LoadSession,
  LoadTimeoutError,
  ReleasedError,
  type Emitter,
} from './lifecycle'
import { createWorkerProjection } from './workerProjection'
import { findDot, probeMeasurability } from './probeMeasure'
import { panCamera, summarizePhase, zoomCamera, type Camera, type PhaseSummary } from './benchmark'
import { buildStyle, COLORS, DRAW_ORDER } from './mapStyle'
import { countRoadPixels, detectableRoadColours } from './roadPixels'
import {
  buildDataset,
  citiesGeoJSON,
  LAB_SCENARIOS,
  probesGeoJSON,
  roadsGeoJSON,
  toM3Scenario,
  type LabDataset,
  type LabProbe,
  type LabScenarioId,
} from './syntheticData'

type RendererChoice = 'maplibre' | 'm3'

interface Config {
  renderer: RendererChoice
  scenario: LabScenarioId
  segments: number
  crs: CrsChoice
  labels: boolean
  probes: boolean
  /**
   * B1.2 (F2): longest wait, ms, for each loading step (worker setup, style load, data until
   * complete, idle, M3 uploads) before the lab reports a `LoadTimeoutError`.
   */
  loadTimeoutMs: number
}

const config: Config = {
  renderer: 'maplibre',
  scenario: 'basic',
  segments: 100_000,
  crs: 'scs',
  labels: true,
  probes: false,
  loadTimeoutMs: DEFAULT_LOAD_TIMEOUT_MS,
}

// ---------------------------------------------------------------- request and CSP log

/** Every resource the page itself fetched (workers' own requests are logged by the harness). */
const resourceLog: { url: string; type: string; t: number }[] = []
try {
  new PerformanceObserver((list) => {
    for (const e of list.getEntries() as PerformanceResourceTiming[])
      resourceLog.push({ url: e.name, type: e.initiatorType, t: e.startTime })
  }).observe({ type: 'resource', buffered: true })
} catch {
  // PerformanceObserver is optional; the harness logs requests over DevTools as well.
}
const cspViolations: { blocked: string; directive: string; source: string }[] = []
document.addEventListener('securitypolicyviolation', (e) =>
  cspViolations.push({
    blocked: e.blockedURI,
    directive: e.violatedDirective,
    source: `${e.sourceFile}:${e.lineNumber}`,
  }),
)
/** Every request MapLibre itself asked for (`transformRequest`); expected to stay empty. */
const maplibreRequests: { url: string; type: string }[] = []
const mapErrors: string[] = []

// ---------------------------------------------------------------- DOM

const $ = (id: string) => document.getElementById(id)!
const root = $('lab')
root.className = 'lab'
root.innerHTML = `
  <aside class="lab-panel">
    <h1>MapLibre lab (B1)</h1>
    <p class="note">Development only. Synthetic data at SCS-like magnitudes; planar CRS; offline.</p>
    <label>Renderer <select id="renderer">
      <option value="maplibre">MapLibre GL JS</option>
      <option value="m3">M3 WebGL 2 prototype</option></select></label>
    <label>Scenario <select id="scenario">${LAB_SCENARIOS.map(
      (s) => `<option value="${s.id}">${s.label}</option>`,
    ).join('')}</select></label>
    <label>Segments <input id="segments" type="number" min="1000" step="1000" value="100000"></label>
    <label>CRS <select id="crs">
      <option value="scs">roadpilot:scs (registered)</option>
      <option value="identity">identity (built-in)</option></select></label>
    <label>Labels <input id="labels" type="checkbox" checked></label>
    <label>Probes <input id="probes" type="checkbox"></label>
    <div class="buttons">
      <button id="apply" class="primary">Apply</button>
      <button id="whole">Whole map</button>
      <button id="pan">Pan 3 s</button>
      <button id="zoom">Zoom ×3</button>
    </div>
    <table id="stats"></table>
  </aside>
  <main class="lab-stage" id="stageWrap">
    <div class="lab-map" id="stage"></div>
    <div class="lab-overlay" id="overlay">Starting…</div>
  </main>`

const stage = $('stage')
const overlay = $('overlay')

function setOverlay(text: string | null, error = false) {
  overlay.hidden = text === null
  overlay.textContent = text ?? ''
  overlay.classList.toggle('error', error)
}

// ---------------------------------------------------------------- state

let dataset: LabDataset | null = null
let camera: Camera = { center: { x: 0, z: 0 }, zoom: 0 }
let map: MapLibreMap | null = null
let m3: { renderer: WebGL2RoadRenderer; canvas: HTMLCanvasElement; tiler: ScenarioTiles } | null =
  null
let m3TileKeys = ''
let lastLoad: Record<string, unknown> | null = null
let lastError: { name: string; message: string; details?: readonly string[] } | null = null
let busy = false
/**
 * B1.2 (F2, F3): owns every listener and pending wait of the mounted renderer; `release()`
 * releases it, which removes those listeners and settles every pending wait.
 */
let session: LoadSession | null = null

const now = () => performance.now()
const nextFrame = () => new Promise<number>((r) => requestAnimationFrame(r))
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms))

function stageSize() {
  return { width: stage.clientWidth, height: stage.clientHeight }
}

/** B1.2 (F1): the M3 viewport uses the selected CRS's scale, like every other path. */
const viewOf = (c: Camera) => viewportOf(c, config.crs)

/** The whole-map camera: the production `fitBounds` (16 px padding) as a zoom level. */
function wholeCamera(ds: LabDataset): Camera {
  return cameraOf(fitBounds(ds.bounds, stageSize())!, config.crs)
}

/** MapLibre's `Map` as the session's emitter (same listener object for `on` and `off`). */
function emitterOf(m: MapLibreMap): Emitter {
  return {
    on: (type, listener) => m.on(type as keyof MapEventType, listener as never),
    off: (type, listener) => m.off(type as keyof MapEventType, listener as never),
  }
}

const waitOptions = (label: string) => ({
  label,
  timeoutMs: config.loadTimeoutMs,
  details: () => mapErrors.slice(-5),
})

// ---------------------------------------------------------------- MapLibre setup

/**
 * Once per page: the registered CRS. B1.2 (F4): concurrent callers share one attempt; a failure
 * is not cached, and a retry repeats only the steps that did not succeed, so the CRS is
 * registered once (MapLibre throws on a second registration).
 */
const ensureMapLibreGlobals = createRetryableInit([
  { name: 'projection', run: () => addProjection(scsCrs) },
])

/**
 * B1.5.3: MapLibre starts every worker from the lab's own entry `scsWorkerEntry.mjs` (same-origin
 * module worker, no `blob:`), which installs the projection handler before the worker can handle
 * any message. `workerProjection` sets that worker URL before the first worker exists, keeps the
 * pool (`prewarm()`), and verifies the handler in every worker of every generation (secondary
 * check). Every map mount and data load waits for it; a failure is an error of that load, never a
 * silent fallback.
 */
const workerProjection = createWorkerProjection(
  {
    setWorkerUrl: (url) => setWorkerUrl(url),
    getWorkerUrl: () => getWorkerUrl(),
    keepWorkersAlive: () => prewarm(),
    broadcast: (type) => getGlobalDispatcher().broadcast<null, unknown>(type, null),
    onWorkersCreated: (listener) => {
      const dispatcher = getGlobalDispatcher()
      dispatcher.on('workerscreate', listener)
      return () => void dispatcher.off('workerscreate', listener)
    },
    onWorkerError: (listener) => {
      const dispatcher = getGlobalDispatcher()
      const l = (e: { error?: unknown }) =>
        listener(e.error instanceof Error ? e.error.message : String(e.error))
      dispatcher.on('error', l)
      return () => void dispatcher.off('error', l)
    },
  },
  new URL(workerEntryUrl, location.href).href,
)

/** Worker projection events since page load (recreations, re-registrations, failures). */
const projectionEvents: { t: number; event: string; generation: number; detail?: string }[] = []

/**
 * Workers recreated after a registration (only `WorkerPool.restart` can do that while `prewarm()`
 * holds the pool): verify again, then reload the mounted map's road and city data. With the
 * B1.5.3 worker entry the new workers have the handler from their start, so the reload is a
 * safety net (MapLibre reloads the sources itself after a restart). A load that saw a recreation
 * is marked in its result (`workerProjection.recreatedDuringLoad`); the harness treats such runs
 * as invalid. A failed re-registration becomes the lab's error.
 */
workerProjection.onRecreated((generation) => {
  projectionEvents.push({ t: now(), event: 'workers-recreated', generation })
  void (async () => {
    try {
      const ready = await workerProjection.ensureReady()
      projectionEvents.push({ t: now(), event: 're-registered', generation: ready.generation })
      const m = map
      if (!m || !dataset || busy) return // a running configure waits for the handler itself
      ;(m.getSource('roads') as GeoJSONSource | undefined)?.setData(
        roadsGeoJSON(dataset) as unknown as Json,
      )
      ;(m.getSource('cities') as GeoJSONSource | undefined)?.setData(
        citiesGeoJSON(dataset) as unknown as Json,
      )
      projectionEvents.push({ t: now(), event: 'data-reloaded', generation: ready.generation })
    } catch (e) {
      const err = e instanceof Error ? e : new Error(String(e))
      projectionEvents.push({ t: now(), event: 'failed', generation, detail: err.message })
      mapErrors.push(err.message)
      lastError = { name: err.name, message: err.message }
      setOverlay(`Error: ${err.message}`, true)
    }
  })()
})

class WholeMapControl implements IControl {
  private el: HTMLElement | null = null
  onAdd(): HTMLElement {
    const el = document.createElement('div')
    el.className = 'maplibregl-ctrl maplibregl-ctrl-group'
    el.innerHTML =
      '<button type="button" class="lab-whole" title="Whole map" aria-label="Whole map">⤢</button>'
    el.querySelector('button')!.addEventListener('click', () => void showWholeMap())
    this.el = el
    return el
  }
  onRemove(): void {
    this.el?.remove()
  }
}

async function mountMapLibre(s: LoadSession): Promise<{ initMs: number }> {
  await s.guard(ensureMapLibreGlobals(), waitOptions('MapLibre worker setup'))
  s.throwIfReleased('MapLibre mount')
  // B1.5.1 (defect A): no map before every worker has the projection handler.
  await s.guard(workerProjection.ensureReady(), waitOptions('MapLibre worker projection'))
  s.throwIfReleased('MapLibre mount')
  const t0 = now()
  const m = new MapLibreMap({
    container: stage,
    style: buildStyle({
      crs: config.crs,
      thin: config.scenario === 'thin',
      labels: config.labels,
      probes: config.probes,
    }),
    center: toCarrier(camera.center),
    zoom: camera.zoom,
    minZoom: -2,
    maxZoom: 16,
    // North up: no rotation, no pitch (rotation is checked through the API only).
    dragRotate: false,
    pitchWithRotate: false,
    touchPitch: false,
    maxPitch: 0,
    rollEnabled: false,
    renderWorldCopies: false,
    attributionControl: {
      compact: true,
      customAttribution: 'Synthetic data · MapLibre GL JS (BSD-3-Clause)',
    },
    transformRequest: (url, type) => {
      maplibreRequests.push({ url, type: String(type) })
      return { url }
    },
  })
  m.touchZoomRotate.disableRotation()
  m.keyboard.disableRotation()
  m.addControl(new NavigationControl({ showCompass: false }), 'top-right')
  m.addControl(new WholeMapControl(), 'top-right')
  map = m
  const em = emitterOf(m)
  s.on(em, 'error', (e) => {
    const err = (e as { error?: { message?: string } }).error
    mapErrors.push(String(err?.message ?? err))
  })
  s.on(em, 'moveend', () => {
    if (map !== m) return
    const c = m.getCenter()
    camera = { center: fromCarrier(c.lng, c.lat), zoom: m.getZoom() }
    renderStats()
  })
  await s.wait(em, 'load', waitOptions('MapLibre style load'))
  return { initMs: now() - t0 }
}

function mapGl(): WebGL2RenderingContext | null {
  return (map?.getCanvas().getContext('webgl2') as WebGL2RenderingContext | null) ?? null
}

function readOnePixel(gl: WebGL2RenderingContext) {
  gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(4))
}

/** The whole current drawing buffer (`readPixels` layout, bottom row first). */
function readFrame(gl: WebGL2RenderingContext): Uint8Array {
  const px = new Uint8Array(gl.drawingBufferWidth * gl.drawingBufferHeight * 4)
  gl.readPixels(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight, gl.RGBA, gl.UNSIGNED_BYTE, px)
  return px
}

/**
 * Pixels of the current drawing buffer that differ from the background (every 2nd pixel). Any
 * drawn content counts, labels included: used only by the context-loss check ("is anything drawn
 * at all"), never for first visible geometry (B1.4, see `roadPixels.ts`).
 */
function countDrawnPixels(gl: WebGL2RenderingContext): number {
  const w = gl.drawingBufferWidth
  const h = gl.drawingBufferHeight
  const px = new Uint8Array(w * h * 4)
  gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px)
  const [r, g, b] = [0xf2, 0xe8, 0xd8]
  let n = 0
  for (let i = 0; i < px.length; i += 8) {
    if (Math.abs(px[i]! - r) > 10 || Math.abs(px[i + 1]! - g) > 10 || Math.abs(px[i + 2]! - b) > 10)
      n++
  }
  return n
}

type Json = Parameters<GeoJSONSource['setData']>[0]

/**
 * Hands the dataset to the mounted map and times it: data preparation (GeoJSON in carrier
 * coordinates, main thread), `setData` (main thread), first visible geometry, complete geometry
 * (every tile of the view loaded and drawn) and idle (placement and fades done).
 *
 * B1.4 (O3): first visible geometry is the first rendered frame with at least one pixel of the
 * road line layers, as classified by `countRoadPixels` with the road colours that no background,
 * label, halo or probe pixel of the mounted style can match (`detectableRoadColours`). The time
 * is taken after a one-pixel read-back (GPU done, as in M3) and before the full read-back used
 * for classification. Labels drawn first can no longer stop the clock.
 */
async function loadMapLibreData(s: LoadSession, ds: LabDataset) {
  const m = map!
  const em = emitterOf(m)
  const gl = mapGl()!
  const p0 = now()
  const roads = roadsGeoJSON(ds)
  const cities = citiesGeoJSON(ds)
  const probes = probesGeoJSON(ds.probes)
  const prepMs = now() - p0

  // B1.5.1 (defect A): the GeoJSON goes to the workers only once each has the handler (normally
  // already verified by the mount; this catches workers recreated in between). Outside the timing.
  const projectionReady = await s.guard(
    workerProjection.ensureReady(),
    waitOptions('MapLibre worker projection'),
  )
  s.throwIfReleased('MapLibre data load')
  const projectionGeneration = projectionReady.generation

  const roadColours = detectableRoadColours({ labels: config.labels, probes: config.probes })
  let tileArrived = false
  let firstMs = NaN
  let firstRoadPixels = 0
  let completeMs = NaN
  let frames = 0
  let longestFrame = 0
  // B1.2 (F2, F3): the session removes this listener when the load ends, fails or is released.
  const stopData = s.on(em, 'data', (e) => {
    const d = e as { sourceId?: string; tile?: unknown }
    if (d.sourceId === 'roads' && d.tile) tileArrived = true
  })
  const t0 = now()
  let lastRender = t0
  const details = () => [
    `tile arrived: ${tileArrived}`,
    `first visible: ${Number.isNaN(firstMs) ? 'no' : 'yes'}`,
    ...mapErrors.slice(-5),
  ]
  const done = s.wait(em, 'render', {
    ...waitOptions('MapLibre data load (first visible and complete geometry)'),
    details,
    until: () => {
      const t = now()
      frames++
      longestFrame = Math.max(longestFrame, t - lastRender)
      lastRender = t
      if (Number.isNaN(firstMs) && tileArrived) {
        readOnePixel(gl)
        const tf = now()
        const n = countRoadPixels(readFrame(gl), roadColours)
        if (n > 0) {
          firstMs = tf - t0
          firstRoadPixels = n
        }
      }
      if (!Number.isNaN(firstMs) && m.areTilesLoaded()) {
        readOnePixel(gl)
        completeMs = now() - t0
        return true
      }
      return false
    },
  })
  const idle = s.wait(em, 'idle', { ...waitOptions('MapLibre idle after data load'), details })
  const s0 = now()
  const sent = s.guard(
    Promise.all([
      (m.getSource('roads') as GeoJSONSource).setData(roads as unknown as Json),
      (m.getSource('cities') as GeoJSONSource).setData(cities as unknown as Json),
      (m.getSource('probes') as GeoJSONSource).setData(probes as unknown as Json),
    ]),
    { ...waitOptions('MapLibre setData'), details },
  )
  const setDataMs = now() - s0
  // The first rejection (setData error, timeout or release) ends the load; all three settle.
  try {
    await Promise.all([done, idle, sent])
  } finally {
    stopData()
  }
  s.throwIfReleased('MapLibre data load')
  const idleMs = now() - t0
  const projectionAfter = workerProjection.status()
  return {
    /**
     * B1.5.1: the handler was verified in every worker before `setData`; `recreatedDuringLoad`
     * is true when MapLibre created workers while this load ran (its tiles may lack the handler).
     */
    workerProjection: {
      verified: true,
      generation: projectionGeneration,
      workers: projectionReady.workers,
      recreatedDuringLoad: projectionAfter.generation !== projectionGeneration,
    },
    prepMs,
    setDataMs,
    firstMs,
    firstRoadPixels,
    /** Road layers whose pixels were counted (depends on labels and probes, see roadPixels.ts). */
    roadDetectionLayers: roadColours.map((c) => c.layer),
    completeMs,
    idleMs,
    loadFrames: frames,
    loadGapMax: longestFrame,
  }
}

// ---------------------------------------------------------------- M3 setup

function mountM3(ds: LabDataset): { initMs: number; tileBuildMs: number } {
  const canvas = document.createElement('canvas')
  canvas.className = 'm3'
  stage.append(canvas)
  const t0 = now()
  const created = createWebGL2RoadRenderer(canvas, {
    stencilMode: DEFAULT_STENCIL_MODE,
    uploadBudgetMs: DEFAULT_UPLOAD_BUDGET_MS,
    budgetBytes: 64 * 1024 * 1024,
  })
  const initMs = now() - t0
  if (!created.ok) {
    canvas.remove()
    throw new Error(`M3 renderer failed: ${created.reason}`)
  }
  const tiler = new ScenarioTiles(toM3Scenario(ds))
  m3 = { renderer: created.renderer, canvas, tiler }
  const s = stageSize()
  created.renderer.resize(s.width, s.height, window.devicePixelRatio || 1)
  // Tile building is data preparation, outside the timed load (as in the M3 lab).
  const b0 = now()
  tiler.visible('full', viewOf(camera), s)
  return { initMs, tileBuildMs: now() - b0 }
}

function m3Tiles(): MapTile[] {
  const { tiles } = m3!.tiler.visible('full', viewOf(camera), stageSize())
  return tiles
}

function m3UpdateTiles() {
  const tiles = m3Tiles()
  const keys = tiles.map((t) => `${t.x}/${t.z}`).join(',')
  if (keys !== m3TileKeys) {
    m3TileKeys = keys
    m3!.renderer.setTiles(tiles)
  }
}

/** The M3 lab's `firstFrame`: hand the tiles to the empty renderer, then render until complete. */
async function loadM3Data(s: LoadSession) {
  const r = m3!.renderer
  const gl = m3!.canvas.getContext('webgl2') as WebGL2RenderingContext
  const tiles = m3Tiles()
  m3TileKeys = tiles.map((t) => `${t.x}/${t.z}`).join(',')
  const t0 = now()
  r.setTiles(tiles)
  r.setView(viewOf(camera))
  let stats = r.render()
  readOnePixel(gl)
  const firstMs = now() - t0
  const firstSegments = stats.segments
  let frames = 1
  let lastT = now()
  let gapMax = 0
  while (stats.pending > 0) {
    await nextFrame()
    // B1.2 (F2, F3): stop on release (the renderer is disposed) and after the load timeout.
    s.throwIfReleased('M3 upload')
    if (now() - t0 > config.loadTimeoutMs)
      throw new LoadTimeoutError('M3 upload', config.loadTimeoutMs, [
        `pending tiles: ${stats.pending}`,
      ])
    stats = r.render()
    frames++
    const t = now()
    gapMax = Math.max(gapMax, t - lastT)
    lastT = t
  }
  readOnePixel(gl)
  return {
    firstMs,
    firstSegments,
    completeMs: now() - t0,
    segments: stats.segments,
    tiles: tiles.length,
    gpuBytes: stats.gpuBytes,
    loadFrames: frames,
    loadGapMax: gapMax,
  }
}

function m3Render() {
  if (!m3) return
  m3.renderer.setView(viewOf(camera))
  m3.renderer.render()
}

// ---------------------------------------------------------------- lifecycle

/**
 * Releases the mounted renderer. B1.2 (F3): first the session, which removes every listener the
 * lab attached and rejects every pending wait with `ReleasedError` (so a pending `configure()`
 * settles), then the map or the M3 renderer. Safe to call more than once. B1.5.1: MapLibre's
 * global worker pool is held by `prewarm()` (see `workerProjection`), so removing the map here
 * does not terminate the workers.
 */
function release() {
  const s = session
  session = null
  s?.release()
  const m = map
  map = null
  m?.remove()
  const r = m3
  m3 = null
  if (r) {
    r.renderer.dispose()
    r.canvas.remove()
  }
  m3TileKeys = ''
  return { canvases: stage.querySelectorAll('canvas').length }
}

function readControls() {
  config.renderer = ($('renderer') as HTMLSelectElement).value as RendererChoice
  config.scenario = ($('scenario') as HTMLSelectElement).value as LabScenarioId
  config.segments = Number(($('segments') as HTMLInputElement).value) || 100_000
  config.crs = ($('crs') as HTMLSelectElement).value as CrsChoice
  config.labels = ($('labels') as HTMLInputElement).checked
  config.probes = ($('probes') as HTMLInputElement).checked
}

function writeControls() {
  ;($('renderer') as HTMLSelectElement).value = config.renderer
  ;($('scenario') as HTMLSelectElement).value = config.scenario
  ;($('segments') as HTMLInputElement).value = String(config.segments)
  ;($('crs') as HTMLSelectElement).value = config.crs
  ;($('labels') as HTMLInputElement).checked = config.labels
  ;($('probes') as HTMLInputElement).checked = config.probes
}

/** Builds the dataset (kept while scenario and size stay the same), mounts and loads. */
async function configure(next: Partial<Config> = {}) {
  if (busy) throw new Error('busy')
  busy = true
  release()
  const s = new LoadSession()
  session = s
  lastError = null
  try {
    Object.assign(config, next)
    writeControls()
    setOverlay('Building synthetic data…')
    await nextFrame()
    s.throwIfReleased('configure')
    const g0 = now()
    const segments =
      LAB_SCENARIOS.find((s) => s.id === config.scenario)!.defaultSegments !== undefined
        ? config.segments
        : undefined
    if (
      !dataset ||
      dataset.id !== config.scenario ||
      (segments !== undefined && dataset.segments !== segments)
    )
      dataset = buildDataset(config.scenario, segments)
    const generateMs = now() - g0
    camera = wholeCamera(dataset)
    setOverlay('Loading…')
    await nextFrame()
    s.throwIfReleased('configure')
    let load: Record<string, unknown>
    if (config.renderer === 'maplibre') {
      const { initMs } = await mountMapLibre(s)
      load = { renderer: 'maplibre', generateMs, initMs, ...(await loadMapLibreData(s, dataset)) }
    } else {
      const { initMs, tileBuildMs } = mountM3(dataset)
      load = { renderer: 'm3', generateMs, initMs, tileBuildMs, ...(await loadM3Data(s)) }
    }
    // B1.2 (F3): a result that arrives after a release must not update the lab.
    s.throwIfReleased('configure')
    lastLoad = load
    setOverlay(null)
    renderStats()
    return state()
  } catch (e) {
    const err = e instanceof Error ? e : new Error(String(e))
    lastError = {
      name: err.name,
      message: err.message,
      ...(err instanceof LoadTimeoutError ? { details: err.details } : {}),
    }
    // A release is deliberate, not an error. Any other failure (timeout, setData or worker
    // error, GPU initialisation) releases its own session and map, so no listener or half-loaded
    // map stays behind; the error remains in `state().error` and `mapErrors`.
    if (!(err instanceof ReleasedError) && session === s) {
      release()
      setOverlay(`Error: ${err.message}`, true)
    } else if (session === null) setOverlay(null)
    throw err
  } finally {
    busy = false
  }
}

async function showWholeMap() {
  if (!dataset) return
  camera = wholeCamera(dataset)
  if (map) map.jumpTo({ center: toCarrier(camera.center), zoom: camera.zoom })
  else m3Render()
}

// ---------------------------------------------------------------- benchmark

function applyCamera(c: Camera) {
  camera = c
  if (map) {
    map.jumpTo({ center: toCarrier(c.center), zoom: c.zoom })
    map.redraw()
  } else if (m3) {
    m3UpdateTiles()
    m3Render()
  }
}

/** Waits until nothing is loading: MapLibre tiles loaded, or M3 uploads done. */
async function settle(timeoutMs = 20_000): Promise<number> {
  const t0 = now()
  while (now() - t0 < timeoutMs) {
    // B1.2 (F3): nothing mounted (released) means nothing to wait for.
    if (!map && !m3) return NaN
    if (map && map.areTilesLoaded() && !map.isMoving()) return now() - t0
    if (m3) {
      m3.renderer.setView(viewOf(camera))
      if (m3.renderer.render().pending === 0) return now() - t0
    }
    if (map) map.redraw()
    await nextFrame()
  }
  return NaN
}

/** Animates the camera every frame: `pan` for `ms`, or `zoom` cycles, as the M3 lab. */
async function run(
  phase: 'pan' | 'zoom',
  opts: { ms?: number; cycles?: number } = {},
): Promise<PhaseSummary & { settleMs: number; glError: number }> {
  const start = camera
  const total = phase === 'pan' ? (opts.ms ?? 3000) : (opts.cycles ?? 3) * 3000
  const times: number[] = []
  const renders: number[] = []
  await new Promise<void>((resolve) => {
    let t0 = -1
    const step = (time: number) => {
      if (t0 < 0) t0 = time
      const t = time - t0
      if (t >= total) {
        resolve()
        return
      }
      const c = phase === 'pan' ? panCamera(start, t, config.crs) : zoomCamera(start, t)
      const a = now()
      applyCamera(c)
      renders.push(now() - a)
      times.push(time)
      requestAnimationFrame(step)
    }
    requestAnimationFrame(step)
  })
  applyCamera(start)
  const settleMs = await settle()
  const gl = map ? mapGl() : (m3?.canvas.getContext('webgl2') as WebGL2RenderingContext | null)
  return { ...summarizePhase(phase, times, renders), settleMs, glError: gl ? gl.getError() : -1 }
}

// ---------------------------------------------------------------- accuracy

function hideNonProbeLayers(hide: boolean) {
  const m = map!
  for (const l of m.getStyle().layers) {
    if (l.id === 'background' || l.id === 'probe') continue
    m.setLayoutProperty(l.id, 'visibility', hide ? 'none' : 'visible')
  }
}

/** A 3 × 3 grid of probes at fractional native coordinates, ±30 % of the view around `c`. */
function probeGrid(c: NativePoint, zoom: number, size: { width: number; height: number }) {
  const s = pixelsPerUnit(zoom, config.crs)
  const probes: LabProbe[] = []
  for (const fx of [-0.3, 0, 0.3])
    for (const fz of [-0.3, 0, 0.3])
      probes.push({
        id: `g${fx},${fz}`,
        x: c.x + (fx * size.width) / s + 0.123,
        z: c.z + (fz * size.height) / s - 0.377,
      })
  return probes
}

/**
 * Places probe dots at known native positions and compares, for every centre, zoom and size:
 * MapLibre's `project` (API), the centroid of the drawn dot (rendered), and `unproject` back to
 * native units, against `expectedScreen` (independent of MapLibre). Road and label layers are
 * hidden while measuring, so road edges do not disturb the centroids.
 *
 * B1.5.5: a probe outside the CRS world or within its edge margin is `not_measurable`
 * (`probeMeasurability`): it is not searched for and is counted separately; `findDot` only counts
 * opaque background-to-probe pixels (`probeMeasure.ts`).
 */
async function accuracy(
  opts: {
    centers?: NativePoint[]
    zooms?: number[]
    sizes?: [number, number][]
  } = {},
) {
  const m = map
  if (!m) throw new Error('accuracy needs the MapLibre renderer')
  const centers = opts.centers ?? [
    { x: 0, z: 0 },
    { x: -100_000, z: -70_000 },
    { x: 100_000, z: 70_000 },
    { x: -120_000, z: 60_000 },
    { x: 120_000, z: -60_000 },
  ]
  const zooms = opts.zooms ?? [1, 3, 5, 7, 9, 11, 13]
  const sizes = opts.sizes ?? [[0, 0]]
  const gl = mapGl()!
  const dpr = window.devicePixelRatio || 1
  // B1.2 (F5): without the probe layer and source nothing can be measured; report that as a
  // test-infrastructure error, never as missing dots (a rendering observation) or as a pass.
  const style = m.getStyle()
  const infrastructure = checkProbeInfrastructure(
    style.layers.map((l) => l.id),
    Object.keys(style.sources),
  )
  if (infrastructure) return { crs: config.crs, dpr, ...infrastructure }
  const results: AccuracyCase[] = []
  hideNonProbeLayers(true)
  const source = m.getSource('probes') as GeoJSONSource
  const saved = camera
  try {
    for (const [w, h] of sizes) {
      if (w > 0) {
        stage.style.width = `${w}px`
        stage.style.height = `${h}px`
        stage.style.inset = 'auto'
      }
      m.resize()
      const size = stageSize()
      for (const center of centers) {
        for (const zoom of zooms) {
          m.jumpTo({ center: toCarrier(center), zoom })
          const c = m.getCenter()
          const actualCenter = fromCarrier(c.lng, c.lat)
          const actualZoom = m.getZoom()
          const probes = probeGrid(actualCenter, actualZoom, size)
          const measurability = probes.map((p) => probeMeasurability(p, actualZoom, config.crs))
          // The dot the wait loop looks for: the first measurable probe (the centre if it is).
          const order = [4, 0, 1, 2, 3, 5, 6, 7, 8]
          const waitFor = order.find((i) => measurability[i]?.measurable)
          await source.setData(probesGeoJSON(probes) as unknown as Json)
          await settle()
          // Wait for the dots to be drawn: the worker returns the tile asynchronously.
          let px = new Uint8Array(0)
          for (let attempt = 0; attempt < 30; attempt++) {
            m.redraw()
            px = new Uint8Array(gl.drawingBufferWidth * gl.drawingBufferHeight * 4)
            gl.readPixels(
              0,
              0,
              gl.drawingBufferWidth,
              gl.drawingBufferHeight,
              gl.RGBA,
              gl.UNSIGNED_BYTE,
              px,
            )
            if (waitFor === undefined) break // nothing measurable to wait for
            const target = probes[waitFor]!
            const centre = expectedScreen(actualCenter, actualZoom, size, target, config.crs)
            if (findDot(px, gl.drawingBufferWidth, gl.drawingBufferHeight, dpr, centre)) break
            await delay(30)
          }
          const pr: ProbeResult[] = probes.map((p, i) => {
            const meas = measurability[i]!
            const expected = expectedScreen(actualCenter, actualZoom, size, p, config.crs)
            const api = m.project(toCarrier(p))
            const rendered = meas.measurable
              ? findDot(px, gl.drawingBufferWidth, gl.drawingBufferHeight, dpr, expected)
              : null
            const back = m.unproject([expected.x, expected.y])
            const nb = fromCarrier(back.lng, back.lat)
            return {
              id: p.id,
              measurable: meas.measurable,
              notMeasurableReason: meas.reason,
              edgeDistancePx: meas.edgeDistancePx,
              expected,
              api: { x: api.x, y: api.y },
              apiError: Math.hypot(api.x - expected.x, api.y - expected.y),
              rendered,
              renderedError: rendered
                ? Math.hypot(rendered.x - expected.x, rendered.y - expected.y)
                : NaN,
              unprojectError:
                Math.hypot(nb.x - p.x, nb.z - p.z) * pixelsPerUnit(actualZoom, config.crs),
            }
          })
          results.push({
            center,
            actualCenter,
            zoom,
            actualZoom,
            size,
            constrained:
              Math.hypot(actualCenter.x - center.x, actualCenter.z - center.z) > 1e-6 ||
              Math.abs(actualZoom - zoom) > 1e-9,
            probes: pr,
          })
        }
      }
    }
  } finally {
    stage.style.width = ''
    stage.style.height = ''
    stage.style.inset = ''
    m.resize()
    hideNonProbeLayers(false)
    if (dataset) await source.setData(probesGeoJSON(dataset.probes) as unknown as Json)
    camera = saved
    m.jumpTo({ center: toCarrier(saved.center), zoom: saved.zoom })
  }
  return { crs: config.crs, dpr, ...summarizeAccuracy(results, dpr), results }
}

/** Orientation, picking, fitBounds and rotation checks against known synthetic coordinates. */
async function apiChecks() {
  const m = map
  if (!m || !dataset) throw new Error('apiChecks needs the MapLibre renderer and a dataset')
  const size = stageSize()
  const saved = camera
  const out: Record<string, unknown> = {}
  const c = { x: -100_000, z: -70_000 }
  m.jumpTo({ center: toCarrier(c), zoom: 9 })
  await settle()
  const at = (p: NativePoint) => m.project(toCarrier(p))
  const o = at(c)
  const east = at({ x: c.x + 100, z: c.z })
  const south = at({ x: c.x, z: c.z + 100 })
  out.orientation = {
    eastIsRight: east.x > o.x && Math.abs(east.y - o.y) < 1e-6,
    southIsDown: south.y > o.y && Math.abs(south.x - o.x) < 1e-6,
    pxPer100UnitsX: east.x - o.x,
    pxPer100UnitsY: south.y - o.y,
    expectedPxPer100: 100 * pixelsPerUnit(9, config.crs),
  }
  // Picking: the probe at the SCS-like position and the motorway M 1 (scenario A) by name.
  const probePx = at({ x: -100_000, z: -70_000 })
  const picked = m.queryRenderedFeatures([probePx.x, probePx.y], { layers: ['probe'] })
  out.pickProbe = picked.map((f: MapGeoJSONFeature) => f.properties?.id)
  if (dataset.id === 'basic') {
    m.jumpTo({ center: toCarrier({ x: -50_000, z: -35_000 }), zoom: 8 })
    await settle()
    const mid = at({ x: -50_000, z: -35_000 })
    const box: [[number, number], [number, number]] = [
      [mid.x - 3, mid.y - 3],
      [mid.x + 3, mid.y + 3],
    ]
    out.pickRoad = m
      .queryRenderedFeatures(box, { layers: DRAW_ORDER.map((d) => `road-${d}`) })
      .map((f: MapGeoJSONFeature) => `${f.properties?.c}:${f.properties?.n ?? ''}`)
    const off = at({ x: -50_000, z: -34_000 })
    out.pickRoadMiss = m
      .queryRenderedFeatures([off.x, off.y], { layers: DRAW_ORDER.map((d) => `road-${d}`) })
      .map((f: MapGeoJSONFeature) => `${f.properties?.c}:${f.properties?.n ?? ''}`)
  }
  // fitBounds: compare with the production fitBounds (same padding).
  const [minX, minZ, maxX, maxZ] = dataset.bounds
  m.fitBounds([toCarrier({ x: minX, z: maxZ }), toCarrier({ x: maxX, z: minZ })], {
    padding: 16,
    animate: false,
  })
  const fc = m.getCenter()
  const expectedVp = fitBounds(dataset.bounds, size)!
  const fitCenter = fromCarrier(fc.lng, fc.lat)
  out.fitBounds = {
    center: fitCenter,
    zoom: m.getZoom(),
    expectedCenter: { x: expectedVp.cx, z: expectedVp.cz },
    expectedZoom: zoomForScale(expectedVp.scale, config.crs),
    centerErrorPx:
      Math.hypot(fitCenter.x - expectedVp.cx, fitCenter.z - expectedVp.cz) * expectedVp.scale,
  }
  // Rotation (bonus; disabled for users): a bearing of 30° through the API.
  m.jumpTo({ center: toCarrier(c), zoom: 9, bearing: 30 })
  await settle()
  const b = (30 * Math.PI) / 180
  const d = 100 * pixelsPerUnit(9, config.crs)
  const rotEast = at({ x: c.x + 100, z: c.z })
  const centre = { x: size.width / 2, y: size.height / 2 }
  const expRot = { x: centre.x + d * Math.cos(b), y: centre.y - d * Math.sin(b) }
  out.rotation = {
    bearing: m.getBearing(),
    eastAt: { x: rotEast.x, y: rotEast.y },
    expected: expRot,
    errorPx: Math.hypot(rotEast.x - expRot.x, rotEast.y - expRot.y),
  }
  m.jumpTo({ center: toCarrier(saved.center), zoom: saved.zoom, bearing: 0 })
  camera = saved
  await settle()
  out.pitch = { pitch: m.getPitch(), maxPitch: m.getMaxPitch() }
  return out
}

// ---------------------------------------------------------------- labels, stability

/** Placed labels per layer in the current view (rendered symbols only, after collisions). */
async function labelStats() {
  const m = map
  if (!m) throw new Error('labelStats needs the MapLibre renderer')
  await settle()
  // Idle may already have passed; a short timeout then simply continues.
  await session!
    .wait(emitterOf(m), 'idle', { label: 'idle', timeoutMs: 2000 })
    .catch(() => undefined)
  const layers = m
    .getStyle()
    .layers.filter((l) => l.type === 'symbol')
    .map((l) => l.id)
  const counts: Record<string, number> = {}
  for (const id of layers) counts[id] = m.queryRenderedFeatures({ layers: [id] }).length
  return { zoom: m.getZoom(), counts }
}

async function contextLoss() {
  const m = map
  if (!m) throw new Error('contextLoss needs the MapLibre renderer')
  const gl = mapGl()!
  const ext = gl.getExtension('WEBGL_lose_context')!
  const before = countDrawnPixels(gl)
  const s = session!
  const em = emitterOf(m)
  const lost = s.wait(em, 'webglcontextlost', waitOptions('WebGL context loss'))
  const t0 = now()
  ext.loseContext()
  await lost
  const lostMs = now() - t0
  await delay(100)
  s.throwIfReleased('context loss test')
  const restored = s.wait(em, 'webglcontextrestored', waitOptions('WebGL context restore'))
  const r0 = now()
  ext.restoreContext()
  await restored
  const restoreMs = now() - r0
  await settle()
  m.redraw()
  const gl2 = mapGl()!
  const after = countDrawnPixels(gl2)
  return { lostMs, restoreMs, pixelsBefore: before, pixelsAfter: after, errors: mapErrors.slice() }
}

function gpuInfo() {
  const gl = map ? mapGl() : (m3?.canvas.getContext('webgl2') as WebGL2RenderingContext | null)
  if (!gl) return null
  const ext = gl.getExtension('WEBGL_debug_renderer_info')
  return {
    renderer: ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER),
    vendor: ext ? gl.getParameter(ext.UNMASKED_VENDOR_WEBGL) : gl.getParameter(gl.VENDOR),
    version: gl.getParameter(gl.VERSION),
    attributes: gl.getContextAttributes(),
  }
}

function jsHeap(): number | null {
  const mem = (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory
  return mem ? mem.usedJSHeapSize : null
}

function state() {
  return {
    maplibre: getVersion(),
    config: { ...config },
    dataset: dataset && {
      id: dataset.id,
      seed: dataset.seed,
      segments: dataset.segments,
      roads: dataset.roads.length,
      cities: dataset.cities.length,
      bounds: dataset.bounds,
      hash: dataset.hash,
    },
    camera,
    size: stageSize(),
    dpr: window.devicePixelRatio || 1,
    canvases: stage.querySelectorAll('canvas').length,
    load: lastLoad,
    error: lastError,
    listeners: session?.listenerCount ?? 0,
    pendingWaits: session?.pendingCount ?? 0,
    jsHeap: jsHeap(),
    requests: {
      resources: resourceLog.slice(),
      maplibre: maplibreRequests.slice(),
      cspViolations: cspViolations.slice(),
    },
    mapErrors: mapErrors.slice(),
    /** B1.5.1 (defect A): registration state per worker generation, attempts and events. */
    workerProjection: { ...workerProjection.status(), events: projectionEvents.slice() },
  }
}

// ---------------------------------------------------------------- UI

function renderStats() {
  const s = state()
  const load = s.load ?? {}
  const fmt = (v: unknown) =>
    typeof v === 'number'
      ? Number.isInteger(v)
        ? v
        : v.toFixed(1)
      : v !== null && typeof v === 'object' && !Array.isArray(v)
        ? JSON.stringify(v)
        : v
  const rows: [string, unknown][] = [
    ['MapLibre', s.maplibre],
    ['Renderer', s.config.renderer],
    ['CRS', s.config.crs],
    ['Segments', s.dataset?.segments],
    ['Roads', s.dataset?.roads],
    ['Hash', s.dataset?.hash],
    ['Centre X / Z', `${s.camera.center.x.toFixed(1)} / ${s.camera.center.z.toFixed(1)}`],
    ['Zoom', s.camera.zoom.toFixed(2)],
    ['Size × DPR', `${s.size.width}×${s.size.height} × ${s.dpr}`],
    ...Object.entries(load).map(([k, v]) => [k, fmt(v)] as [string, unknown]),
    ['External requests', s.requests.resources.filter((r) => !isLocal(r.url)).length],
    ['MapLibre requests', s.requests.maplibre.length],
    ['CSP violations', s.requests.cspViolations.length],
  ]
  $('stats').innerHTML = rows
    .map(([k, v]) => `<tr><td>${k}</td><td>${String(v ?? '–')}</td></tr>`)
    .join('')
}

function isLocal(url: string): boolean {
  try {
    const u = new URL(url, location.href)
    return u.origin === location.origin || u.protocol === 'data:' || u.protocol === 'blob:'
  } catch {
    return false
  }
}

$('apply').addEventListener('click', () => {
  readControls()
  configure().catch(() => undefined)
})
$('whole').addEventListener('click', () => void showWholeMap())
$('pan').addEventListener('click', () => void run('pan').then(renderStats))
$('zoom').addEventListener('click', () => void run('zoom').then(renderStats))

declare global {
  interface Window {
    mapLibreLab: unknown
  }
}

window.mapLibreLab = {
  configure,
  run,
  settle,
  accuracy,
  apiChecks,
  labelStats,
  contextLoss,
  release,
  remount: () => configure(),
  gpuInfo,
  state,
  setCamera: (c: Camera) => applyCamera(c),
  whole: showWholeMap,
  colors: COLORS,
}

configure().catch((e: unknown) => console.error(e))
