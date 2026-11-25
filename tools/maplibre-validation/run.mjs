/* global process, console, Buffer, URL, setTimeout, clearTimeout */
/**
 * B1 runtime validation driver (MapLibre lab). See docs/maplibre-validation.md.
 *
 *   node tools/maplibre-validation/run.mjs <mode> [options]
 *
 * Modes that start RoadPilot (need --confirm-runtime, an idle desktop and the debug build):
 * functional, perf, cycles. Without --confirm-runtime they only print what they would do.
 * Mode `report` reads saved results from --out (or --session) and writes report-<tag>.json; it
 * starts nothing.
 *
 * B1.5.4B: a runtime mode runs as one session (lifecycle.mjs): preflight (result files, idle
 * desktop, RoadPilot not running), its OWN Vite dev server (devserver.mjs: started by this script,
 * proven ready over HTTP before RoadPilot starts, stopped gracefully at the end), the measurement,
 * then cleanup checks. Port 1420 must be free: a dev server started by hand (`npm run dev`) is
 * refused, because its process and readiness cannot be verified.
 *
 * Options: --session=<name> (results go to out/<name>/; default: a new timestamped folder),
 * --out=<dir> (instead of a session folder), --nv (RTX via --force_high_performance_gpu),
 * --only=urban|stress, --kinds=maplibre,m3, --runs=3, --kind=maplibre (cycles),
 * --busy=<process,process> (extra processes that block a start), --attempts=1 (app starts per
 * lab opening, see openlab.mjs; more than 1 makes the `startup` criterion INVALID on a retry).
 *
 * B1.5.4G: `control --negative-control` (negativecontrol.mjs) runs ONE negative-control session:
 * no placeholder, the real app page renders before the lab navigation, evidence only, never a
 * measurement. Both tokens are required; any other mode with the flag, and every measurement
 * option with it, is refused before anything starts (exit code 2). A control whose outcome is not
 * `detected` ends with exit code 4.
 *
 * B1.5.1: results never overwrite earlier results. Runtime modes write into a session folder and
 * refuse to start when a result file they would write already exists there; every failed lab
 * opening saves its own `openlab-failure-*` diagnostics.
 *
 * This script only collects data; every verdict comes from report.mjs.
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  appIdentifier,
  appPids,
  assertDesktopIdle,
  closeApp,
  connect,
  cspLogEntries,
  devServerStatus,
  heaps,
  instrument,
  launchApp,
  listTargets,
  processInfo,
  REPO,
  sleep,
} from './cdp.mjs'
import { startDevServer, stopDevServer } from './devserver.mjs'
import { nodeDevServerDeps } from './devserver-node.mjs'
import { createScreenshotRecorder } from './evidence.mjs'
import { runSession } from './lifecycle.mjs'
import {
  CONTROL_HOLD_MS,
  CONTROL_KIND,
  CONTROL_MODE,
  controlSessionName,
  validateRunArgs,
} from './negativecontrol.mjs'
import { openLab as openLabStaged } from './openlab.mjs'
import { PLACEHOLDER_MARKER } from './placeholder.mjs'
import { buildReport, MIN_RUNS, THRESHOLDS, worstProbe } from './report.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const args = process.argv.slice(2)
const mode = args[0]
const opt = (name, fallback) =>
  args.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback
const flag = (name) => args.includes(`--${name}`)

const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15)
// B1.5.4G: checked before anything else; a refused command line starts nothing.
const ARGS_CHECK = validateRunArgs(mode, args)
const NEGATIVE_CONTROL = ARGS_CHECK.ok && ARGS_CHECK.negativeControl
const SESSION = opt(
  'session',
  mode === 'report' ? null : NEGATIVE_CONTROL ? controlSessionName(stamp) : `run-${stamp}`,
)
if (SESSION !== null && !/^[\w.-]+$/.test(SESSION)) throw new Error(`invalid --session ${SESSION}`)
const OUT = resolve(opt('out', SESSION ? join(HERE, 'out', SESSION) : join(HERE, 'out')))
const ATTEMPTS = Math.max(1, Number(opt('attempts', '1')) || 1)
const CONFIRMED = flag('confirm-runtime')
const NV = flag('nv')
const TAG = NV ? 'nv' : 'amd'
const ONLY = opt('only', null)
const RUNS = Math.max(1, Number(opt('runs', String(MIN_RUNS))) || MIN_RUNS)
const BUSY = (opt('busy', '') || '').split(',').filter(Boolean)
const KEEP_VISIBLE = [
  '--disable-features=CalculateNativeWinOcclusion',
  '--disable-backgrounding-occluded-windows',
]
const FLAGS = [...KEEP_VISIBLE, ...(NV ? ['--force_high_performance_gpu'] : [])]

const tauri = JSON.parse(readFileSync(join(REPO, 'src-tauri', 'tauri.conf.json'), 'utf8'))
const DEV_URL = new URL(tauri.build.devUrl)
const PAGE_ORIGIN = DEV_URL.origin
const LAB_PATH = '/src/dev/mapLibreLab/index.html'
const LAB = `${PAGE_ORIGIN}${LAB_PATH}`
/** Served by the dev server only for the lab page itself (not for Vite's SPA fallback). */
const LAB_MARKER = 'RoadPilot MapLibre lab'
/** Started by URL (setWorkerUrl), not imported: the module crawl must request it explicitly. */
const WORKER_ENTRY = '/src/dev/mapLibreLab/scsWorkerEntry.mjs'
const SCENARIO_SEGMENTS = { urban: THRESHOLDS.urban.segments, stress: THRESHOLDS.stress.segments }

/** Writes a result; never replaces an existing file (`wx`). */
const save = (name, data) => {
  mkdirSync(OUT, { recursive: true })
  writeFileSync(join(OUT, name), JSON.stringify(data, null, 1), { flag: 'wx' })
}
/** A rebuilt report gets a new name instead of replacing an earlier one. Returns the name used. */
const saveReport = (name, data) => {
  mkdirSync(OUT, { recursive: true })
  const used = existsSync(join(OUT, name)) ? name.replace(/\.json$/, `-${stamp}.json`) : name
  writeFileSync(join(OUT, used), JSON.stringify(data, null, 1), { flag: 'wx' })
  return used
}
const errorText = (e) => (e instanceof Error ? `${e.name}: ${e.message}` : String(e))

/** Refuses a runtime mode before anything starts if one of its result files already exists. */
function refuseExisting(names) {
  const existing = names.filter((n) => existsSync(join(OUT, n)))
  if (existing.length)
    throw new Error(
      `results already exist in ${OUT} (${existing.join(', ')}); use a new --session. Nothing was started.`,
    )
}

/** Diagnostics of a failed lab opening: a JSON file and, if captured, a screenshot (unique names). */
function saveDiagnostics(name, data, pngBase64) {
  mkdirSync(OUT, { recursive: true })
  let base = name
  for (let i = 2; existsSync(join(OUT, `${base}.json`)); i++) base = `${name}-${i}`
  writeFileSync(join(OUT, `${base}.json`), JSON.stringify(data, null, 1), { flag: 'wx' })
  if (pngBase64)
    writeFileSync(join(OUT, `${base}.png`), Buffer.from(pngBase64, 'base64'), { flag: 'wx' })
  return join(OUT, `${base}.json`)
}

function startSampler(name) {
  mkdirSync(OUT, { recursive: true })
  const file = join(OUT, `mem-${name}.jsonl`)
  const stop = `${file}.stop`
  const p = spawn(
    'powershell',
    [
      '-NoProfile',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      join(HERE, 'sampler.ps1'),
      '-Out',
      file,
      '-StopFile',
      stop,
      '-Mark',
      appIdentifier(),
    ],
    { stdio: 'ignore' },
  )
  return {
    async stop() {
      writeFileSync(stop, '')
      await new Promise((r) => p.on('exit', r))
      if (!existsSync(file)) return []
      return readFileSync(file, 'utf8')
        .trim()
        .split(/\r?\n/)
        .filter(Boolean)
        .map((l) => JSON.parse(l))
    },
  }
}

const MiB = (b) => b / 2 ** 20
function memSummary(samples, from = 0, to = Infinity) {
  const s = samples.filter((x) => x.t >= from && x.t <= to)
  const max = (f) => (s.length ? Math.max(...s.map(f)) : NaN)
  const last = s.at(-1)
  return {
    samples: s.length,
    totalMax: MiB(max((x) => x.total)),
    gpuProcMax: MiB(max((x) => x.types['gpu-process'] ?? 0)),
    rendererMax: MiB(max((x) => x.types.renderer ?? 0)),
    gpuDedicatedMax: MiB(max((x) => x.gpuDedicated)),
    gpuSharedMax: MiB(max((x) => x.gpuShared)),
    last: last
      ? {
          total: MiB(last.total),
          gpuProc: MiB(last.types['gpu-process'] ?? 0),
          renderer: MiB(last.types.renderer ?? 0),
          gpuDedicated: MiB(last.gpuDedicated),
          gpuShared: MiB(last.gpuShared),
        }
      : null,
  }
}

const lab = (page, expr, timeout) =>
  page.evaluate(`(async () => { const L = window.mapLibreLab; return ${expr} })()`, timeout)

/**
 * Starts the app and opens the lab with request logging, emulated 1280 × 900 CSS px at `dpr`.
 * B1.5.1 (defect B): staged and bounded (openlab.mjs); a failure throws `OpenLabError` with the
 * stage, the original error and the diagnostics file of every attempt.
 */
function openLab(dpr = 1, label = 'lab') {
  return openLabStaged(
    {
      launch: () => launchApp({ flags: FLAGS, confirmed: CONFIRMED, busyExtra: BUSY }),
      close: (app) => closeApp(app),
      processes: () => processInfo(),
      listTargets: (port) => listTargets(port),
      connect: (url) => connect(url),
      instrument: (page) => instrument(page),
      devServer: () => devServerStatus(LAB),
      save: saveDiagnostics,
      now: () => Date.now(),
      sleep,
      setTimeout: (fn, ms) => setTimeout(fn, ms),
      clearTimeout: (id) => clearTimeout(id),
    },
    {
      labUrl: LAB,
      devOrigin: PAGE_ORIGIN,
      dpr,
      label: `${label}-${TAG}`,
      attempts: ATTEMPTS,
      // B1.5.4E: the session's dev server serves the placeholder at `/` (devserver.mjs).
      // B1.5.4G: a negative control has no placeholder; it waits for the real app page instead.
      ...(NEGATIVE_CONTROL
        ? { negativeControl: true }
        : { appPlaceholderMarker: PLACEHOLDER_MARKER }),
    },
  )
}

/**
 * B1.5.4E: evidence for report.mjs `appPageIsolation`: the outgoing-page probe and EVERY logged
 * request and console entry of the run (not only those after the lab navigation). `null` when the
 * lab never opened (the criterion is then INVALID).
 */
function isolationInput(opened) {
  if (!opened) return null
  return {
    expectedMarker: PLACEHOLDER_MARKER,
    pageOrigin: PAGE_ORIGIN,
    navT: opened.navT,
    probe: opened.appProbe ?? null,
    requests: opened.inst.log.requests
      .filter((r) => r.url)
      .map((r) => ({ url: String(r.url).slice(0, 400), t: r.t, session: r.session, type: r.type })),
    console: opened.inst.log.console.map((c) => ({
      type: c.type,
      session: c.session,
      text: String(c.text ?? '').slice(0, 300),
    })),
  }
}

/** What a failed lab opening leaves in a result file. */
const openLabFailure = (e) => ({
  error: errorText(e),
  stage: e?.stage ?? null,
  attempts: Array.isArray(e?.attempts) ? e.attempts : null,
})

function networkInput(inst, navT, labState) {
  return {
    requests: inst.log.requests.filter((r) => r.url && r.t >= navT),
    pageOrigin: PAGE_ORIGIN,
    cspViolations: labState
      ? [...(labState.requests?.cspViolations ?? []), ...cspLogEntries(inst.log)]
      : null,
    maplibreRequests: labState?.requests?.maplibre ?? null,
  }
}

/**
 * B1.5.4B (defect A): screenshots of one run, named `<test>-<seq>-<scenario>-<view>-<tag>.png`
 * (evidence.mjs). A capture never throws into the step around it; its record goes into the result
 * (`screenshots`) and report.mjs judges it separately.
 */
function screenshotRecorder(test) {
  return createScreenshotRecorder({
    test,
    adapter: TAG,
    exists: (name) => existsSync(join(OUT, name)),
    write: (name, png) => {
      mkdirSync(OUT, { recursive: true })
      writeFileSync(join(OUT, name), png, { flag: 'wx' })
    },
    decode: (b64) => Buffer.from(b64, 'base64'),
  })
}
const grabber = (page) => async () =>
  (await page.send('Page.captureScreenshot', { format: 'png' }))?.data

// ---------------------------------------------------------------- functional

async function functional() {
  refuseExisting([`functional-${TAG}.json`])
  const res = { tag: TAG, env: {}, steps: {}, failedSteps: [], screenshots: [] }
  let opened
  try {
    opened = await openLab(1, 'functional')
  } catch (e) {
    // B1.5.1: a lab that never opened is an INVALID functional run, not a crash without a record.
    res.failedSteps.push({ name: 'openLab', ...openLabFailure(e) })
    res.network = null
    res.appPageIsolation = null
    save(`functional-${TAG}.json`, res)
    return { functional: res }
  }
  const { app, page, inst, navT, initial } = opened
  const shots = screenshotRecorder('functional')
  const shot = (scenario, view) => shots.capture({ scenario, view }, grabber(page))
  res.env.openLab = {
    attempt: opened.attempt,
    failedAttempts: opened.failedAttempts,
    stages: opened.stages,
  }
  /** Runs one step; a failure is recorded (the criterion becomes INVALID) and the run continues. */
  const step = async (name, fn) => {
    try {
      return await fn()
    } catch (e) {
      res.failedSteps.push({ name, error: errorText(e) })
      return undefined
    }
  }
  try {
    res.env.version = app.version
    res.env.initialError = initial.error ?? null
    res.env.gpu = await step('gpuInfo', () => lab(page, 'L.gpuInfo()'))
    res.env.screen = await step('screen', () =>
      page.evaluate(
        '({w: screen.width, h: screen.height, dpr: devicePixelRatio, ua: navigator.userAgent})',
      ),
    )
    await shot('basic', 'initial-whole')

    const accuracy = async (key, cfg, sizes) => {
      await lab(page, `L.configure(${JSON.stringify(cfg)})`)
      const acc = await lab(page, `L.accuracy({sizes: ${JSON.stringify(sizes)}})`)
      save(`accuracy-${key}-${TAG}.json`, acc)
      const summary = { ...(acc ?? {}) }
      delete summary.results
      return { ...summary, worst: worstProbe(acc) }
    }
    const basic = {
      renderer: 'maplibre',
      scenario: 'basic',
      crs: 'scs',
      labels: true,
      probes: true,
    }
    res.steps.accuracyScs = await step('accuracyScs', () =>
      accuracy('scs', basic, [
        [0, 0],
        [600, 600],
        [1620, 1080],
      ]),
    )
    res.steps.apiScs = await step('apiScs', () => lab(page, 'L.apiChecks()'))

    res.steps.labels = []
    for (const [name, x, z, zoom] of [
      ['whole', null, null, null],
      ['hub-z5', -100000, -70000, 5],
      ['hub-z8', -100000, -70000, 8],
      ['hub-z10', -100000, -70000, 10],
    ])
      await step(`labels-${name}`, async () => {
        if (x === null) await lab(page, 'L.whole()')
        else await lab(page, `L.setCamera({center:{x:${x},z:${z}},zoom:${zoom}})`)
        res.steps.labels.push({ name, ...(await lab(page, 'L.labelStats()')) })
        await shot('basic', `labels-${name}`)
      })

    // 100 pan and zoom steps (ADR-003 criterion 1), then context loss and restore.
    await step('panZoomSteps', async () => {
      for (let i = 0; i < 50; i++) {
        await lab(
          page,
          `L.setCamera({center:{x:${-100000 + i * 37},z:${-70000 - i * 21}},zoom:${4 + (i % 10) * 0.7}})`,
        )
        await sleep(16)
      }
      for (let i = 0; i < 50; i++) {
        await lab(
          page,
          `L.setCamera({center:{x:${-60000 + i * 900},z:${-30000 + i * 500}},zoom:${2 + (i % 12) * 0.8}})`,
        )
        await sleep(16)
      }
      await lab(page, 'L.settle()')
    })
    res.steps.contextLoss = await step('contextLoss', () => lab(page, 'L.contextLoss()'))
    await shot('basic', 'after-context-loss')

    res.steps.releaseRemount = await step('releaseRemount', async () => ({
      release: await lab(page, 'L.release()'),
      afterRelease: await lab(page, 'L.state()'),
      remount: await lab(page, 'L.remount()'),
    }))

    res.steps.accuracyIdentity = await step('accuracyIdentity', () =>
      accuracy('identity', { ...basic, crs: 'identity' }, [[0, 0]]),
    )
    res.steps.apiIdentity = await step('apiIdentity', () => lab(page, 'L.apiChecks()'))

    await step('thin', async () => {
      await lab(
        page,
        `L.configure({renderer:'maplibre', scenario:'thin', crs:'scs', labels:false, probes:false})`,
      )
      for (const zoom of [7, 9, 11, 13]) {
        await lab(page, `L.setCamera({center:{x:-98700,z:-68900},zoom:${zoom}})`)
        await lab(page, 'L.settle()')
        await sleep(150)
        await shot('thin', `maplibre-z${zoom}`)
      }
      await lab(page, `L.configure({renderer:'m3', scenario:'thin'})`)
      for (const zoom of [9, 11, 13]) {
        await lab(page, `L.setCamera({center:{x:-98700,z:-68900},zoom:${zoom}})`)
        await sleep(150)
        await shot('thin', `m3-z${zoom}`)
      }
    })

    await step('urban', async () => {
      await lab(
        page,
        `L.configure({renderer:'maplibre', scenario:'urban', segments:100000, crs:'scs', labels:true, probes:false})`,
      )
      await shot('urban', 'whole')
      await lab(page, `L.setCamera({center:{x:-100000,z:-70000},zoom:10})`)
      await lab(page, 'L.settle()')
      await sleep(400)
      res.steps.urbanLabelsZ10 = await lab(page, 'L.labelStats()')
      await shot('urban', 'labels-z10')
    })

    res.steps.accuracyScsDpr15 = await step('accuracyScsDpr15', async () => {
      await page.send('Emulation.setDeviceMetricsOverride', {
        width: 1280,
        height: 900,
        deviceScaleFactor: 1.5,
        mobile: false,
      })
      await sleep(300)
      return accuracy('scs-dpr15', basic, [[0, 0]])
    })
    res.steps.finalState = await step('finalState', () => lab(page, 'L.state()'))
  } finally {
    res.network = networkInput(inst, navT, res.steps.finalState)
    res.appPageIsolation = isolationInput(opened)
    res.console = inst.log.console
    res.exceptions = inst.log.exceptions
    res.workers = inst.log.workers
    res.screenshots = shots.records()
    res.close = await closeApp(app)
    save(`functional-${TAG}.json`, res)
  }
  return { functional: res }
}

// ---------------------------------------------------------------- negative control (B1.5.4G)

/**
 * One negative-control session (negativecontrol.mjs): opens the lab after the REAL app page has
 * rendered, holds it for CONTROL_HOLD_MS and records the isolation evidence. Runs no test step and
 * takes no screenshot; report.mjs judges the result only with `evaluateNegativeControl`.
 */
async function negativeControl() {
  const file = `${CONTROL_KIND}-${TAG}.json`
  refuseExisting([file])
  const res = {
    tag: TAG,
    control: {
      kind: CONTROL_KIND,
      placeholder: false,
      waitForAppRender: true,
      holdMs: CONTROL_HOLD_MS,
      note: 'Deliberately NOT isolated. Never a valid measurement.',
    },
    env: {},
    failedSteps: [],
  }
  let opened
  try {
    opened = await openLab(1, CONTROL_KIND)
  } catch (e) {
    res.failedSteps.push({ name: 'openLab', ...openLabFailure(e) })
    res.appRender = e?.attempts?.[0]?.appRender ?? null
    res.appPageIsolation = null
    save(file, res)
    return { negativeControl: res }
  }
  const { app, page, inst, navT } = opened
  try {
    res.env.version = app.version
    res.env.openLab = {
      attempt: opened.attempt,
      failedAttempts: opened.failedAttempts,
      stages: opened.stages,
    }
    res.appRender = opened.appRender
    res.env.gpu = await lab(page, 'L.gpuInfo()').catch((e) => ({ error: errorText(e) }))
    // Several `control:status` emissions (every 200 ms) reach the lab in this time.
    await sleep(CONTROL_HOLD_MS)
    res.finalState = await lab(page, 'L.state()').catch((e) => {
      res.failedSteps.push({ name: 'finalState', error: errorText(e) })
      return null
    })
  } finally {
    res.appPageIsolation = isolationInput(opened)
    res.network = networkInput(inst, navT, res.finalState ?? null)
    res.console = inst.log.console
    res.exceptions = inst.log.exceptions
    res.workers = inst.log.workers
    res.close = await closeApp(app)
    save(file, res)
  }
  return { negativeControl: res }
}

// ---------------------------------------------------------------- perf

const CONFIGS = {
  maplibre: { renderer: 'maplibre', labels: true },
  'maplibre-nolabels': { renderer: 'maplibre', labels: false },
  m3: { renderer: 'm3', labels: false },
}

async function perfRun(kind, scenario, run) {
  const out = { tag: TAG, kind, scenario, run }
  let opened = null
  let sampler = null
  const marks = {}
  try {
    if (!CONFIGS[kind]) throw new Error(`unknown kind ${kind}`)
    try {
      opened = await openLab(1, `perf-${kind}-${scenario}-${run}`)
    } catch (e) {
      out.openLab = openLabFailure(e)
      throw e
    }
    out.openLabAttempt = { attempt: opened.attempt, failedAttempts: opened.failedAttempts }
    const { page } = opened
    sampler = startSampler(`${kind}-${scenario}-${run}-${TAG}`)
    out.gpu = (await lab(page, 'L.gpuInfo()'))?.renderer ?? null
    const cfg = {
      ...CONFIGS[kind],
      scenario,
      segments: SCENARIO_SEGMENTS[scenario],
      crs: 'scs',
      probes: false,
    }
    marks.load0 = Date.now()
    const cold = await lab(page, `L.configure(${JSON.stringify(cfg)})`)
    out.cold = cold?.load ?? null
    out.datasetSegments = cold?.dataset?.segments ?? null
    marks.load1 = Date.now()
    const warm = await lab(page, `L.configure(${JSON.stringify(cfg)})`) // warm: same data, new renderer
    out.warm = warm?.load ?? null
    await lab(page, `L.run('pan', {ms: 1000})`) // warm-up, not evaluated
    marks.pan0 = Date.now()
    out.pan = await lab(page, `L.run('pan', {ms: 3000})`)
    out.zoom = []
    for (let c = 0; c < 3; c++) out.zoom.push(await lab(page, `L.run('zoom', {cycles: 1})`))
    await sleep(1200)
    out.heap = await heaps(page, opened.inst.sessions)
    out.state = await lab(page, 'L.state()')
  } catch (e) {
    out.error = errorText(e)
  } finally {
    const samples = sampler ? await sampler.stop() : []
    out.memory = memSummary(samples)
    out.memoryAfterLoad = memSummary(samples, marks.load1 ?? 0, marks.pan0 ?? Infinity)
    out.appPageIsolation = isolationInput(opened)
    if (opened) {
      out.network = networkInput(opened.inst, opened.navT, out.state ?? null)
      out.exceptions = opened.inst.log.exceptions
      out.errors = opened.inst.log.console.filter((c) => /error/.test(c.type))
      // B1.5.1: warnings too; MapLibre reports a missing worker projection handler as a warning.
      out.warnings = opened.inst.log.console.filter((c) => /warn/.test(c.type))
      out.close = await closeApp(opened.app)
    }
    save(`perf-${kind}-${scenario}-${run}-${TAG}.json`, { ...out, samples })
  }
  const zoomP95 =
    Array.isArray(out.zoom) && out.zoom.length
      ? Math.max(...out.zoom.map((z) => z?.p95 ?? NaN))
      : NaN
  console.log(
    `${kind} ${scenario} #${run}: ${out.error ? `ERROR ${out.error}` : `first ${out.cold?.firstMs} ms, pan p95 ${out.pan?.p95} max ${out.pan?.max}, zoom p95 ${zoomP95}`}`,
  )
  return out
}

/** [kind, scenario, run] of every perf run, in run order. */
function perfPlan() {
  const scenarios = ONLY ? [ONLY] : Object.keys(THRESHOLDS)
  const kinds = opt('kinds', 'maplibre,m3').split(',').filter(Boolean)
  const plan = []
  for (const scenario of scenarios) {
    if (!THRESHOLDS[scenario]) throw new Error(`unknown scenario ${scenario}`)
    // A B B A A B … : the order alternates per round (extra kinds follow the first).
    const order = []
    for (let r = 0; r < RUNS; r++) order.push(...(r % 2 === 0 ? kinds : [...kinds].reverse()))
    const counts = {}
    for (const k of order) {
      counts[k] = (counts[k] ?? 0) + 1
      plan.push([k, scenario, counts[k]])
    }
  }
  return plan
}
const perfFiles = () => perfPlan().map(([k, s, n]) => `perf-${k}-${s}-${n}-${TAG}.json`)

async function perf() {
  const plan = perfPlan()
  refuseExisting(perfFiles())
  const all = []
  for (const [k, s, n] of plan) all.push(await perfRun(k, s, n))
  return { perf: all }
}

// ---------------------------------------------------------------- cycles

const cyclesFiles = () => [`cycles-${opt('kind', 'maplibre')}-${ONLY ?? 'stress'}-${TAG}.json`]

async function cycles() {
  const scenario = ONLY ?? 'stress'
  const kind = opt('kind', 'maplibre')
  const n = 8
  refuseExisting(cyclesFiles())
  const out = { tag: TAG, kind, scenario, cycles: [] }
  let opened = null
  let sampler = null
  try {
    if (!CONFIGS[kind] || !THRESHOLDS[scenario]) throw new Error(`unknown kind or scenario`)
    try {
      opened = await openLab(1, `cycles-${kind}-${scenario}`)
    } catch (e) {
      out.openLab = openLabFailure(e)
      throw e
    }
    out.openLabAttempt = { attempt: opened.attempt, failedAttempts: opened.failedAttempts }
    const { page } = opened
    sampler = startSampler(`cycles-${kind}-${scenario}-${TAG}`)
    await lab(
      page,
      `L.configure(${JSON.stringify({ ...CONFIGS[kind], scenario, segments: SCENARIO_SEGMENTS[scenario], crs: 'scs', probes: false })})`,
    )
    await lab(page, `L.run('zoom', {cycles: 1})`) // warm-up, not evaluated
    for (let c = 0; c < n; c++) {
      const t0 = Date.now()
      const r = await lab(page, `L.run('zoom', {cycles: 1})`)
      await sleep(2500)
      out.cycles.push({
        c: c + 1,
        t0,
        t1: Date.now(),
        p95: r?.p95,
        max: r?.max,
        heap: await heaps(page, opened.inst.sessions),
      })
    }
  } catch (e) {
    out.error = errorText(e)
  } finally {
    const samples = sampler ? await sampler.stop() : []
    for (const c of out.cycles) c.mem = memSummary(samples, c.t1 - 2000, c.t1).last
    out.appPageIsolation = isolationInput(opened)
    if (opened) {
      out.exceptions = opened.inst.log.exceptions
      out.warnings = opened.inst.log.console.filter((c) => /warn/.test(c.type))
      out.state = await lab(opened.page, 'L.state()').catch(() => null)
      out.close = await closeApp(opened.app)
    }
    save(`cycles-${kind}-${scenario}-${TAG}.json`, { ...out, samples })
  }
  return { cycles: [out] }
}

// ---------------------------------------------------------------- report

/** Builds report-<tag>.json from the files saved in --out. Starts nothing. */
function report() {
  if (!opt('session', null) && !opt('out', null))
    throw new Error('report needs --session=<name> or --out=<dir>')
  if (!existsSync(OUT)) throw new Error(`no results in ${OUT}`)
  const tags = opt('tag', null) ? [opt('tag')] : ['amd', 'nv']
  for (const tag of tags) {
    const files = readdirSync(OUT).filter((f) => f.endsWith(`-${tag}.json`))
    if (files.length === 0) continue
    const read = (f) => JSON.parse(readFileSync(join(OUT, f), 'utf8'))
    const functionalFile = files.find((f) => f === `functional-${tag}.json`)
    const strip = (data) => {
      const rest = { ...data }
      delete rest.samples
      return rest
    }
    const lifecycles = files.filter((f) => f.startsWith('session-lifecycle-')).map(read)
    const controlFile = files.find((f) => f === `${CONTROL_KIND}-${tag}.json`)
    const rep = buildReport({
      // B1.5.4G: a negative control is judged only as a control.
      negativeControl: controlFile ? read(controlFile) : undefined,
      functional: functionalFile ? read(functionalFile) : undefined,
      perf: files.filter((f) => f.startsWith('perf-')).map((f) => strip(read(f))),
      cycles: files.filter((f) => f.startsWith('cycles-')).map((f) => strip(read(f))),
      // B1.5.4B session records (older sessions have none: no lifecycle criterion then).
      lifecycle: lifecycles.length ? lifecycles : undefined,
    })
    console.log(saveReport(`report-${tag}.json`, { tag, files, ...rep }))
    printReport(rep)
  }
}

function printReport(rep) {
  for (const [name, c] of Object.entries(rep.criteria))
    console.log(`${c.verdict.padEnd(10)} ${name} (${c.reason})`)
  console.log(`${rep.overall.padEnd(10)} OVERALL`)
}

function plan() {
  console.log(`Mode "${mode}" starts RoadPilot (${TAG}) and loads the GPU. Nothing was started.`)
  console.log(
    'Re-run with --confirm-runtime once runtime validation is approved and the desktop is idle.',
  )
  process.exitCode = 2
}

const RUNTIME = {
  functional: { run: functional, files: () => [`functional-${TAG}.json`] },
  perf: { run: perf, files: perfFiles },
  // B1.5.4G: reachable only with --negative-control (validateRunArgs).
  [CONTROL_MODE]: { run: negativeControl, files: () => [`${CONTROL_KIND}-${TAG}.json`] },
  cycles: { run: cycles, files: cyclesFiles },
}

/**
 * B1.5.4B: one runtime mode as one session (lifecycle.mjs) with the script's own dev server.
 * Result files are refused before anything starts; the session record, the dev server log and
 * any failure diagnostics go into the same session folder.
 */
async function session(name) {
  // B1.5.4G: a control's files are named `negative-control-*`, never like a measurement.
  const label = `${name === CONTROL_MODE ? CONTROL_KIND : name}-${TAG}`
  const logName = `vite-dev-${label}.log`
  // B1.5.4G: a control gets its own, new evidence folder; it never joins a measurement folder.
  if (NEGATIVE_CONTROL && existsSync(OUT) && readdirSync(OUT).length)
    throw new Error(
      `negative control needs a new, empty session folder; ${OUT} is not empty. Nothing was started.`,
    )
  refuseExisting([...RUNTIME[name].files(), `session-lifecycle-${label}.json`, logName])
  mkdirSync(OUT, { recursive: true })
  const saveJson = (n, data) => {
    save(`${n}.json`, data)
    return join(OUT, `${n}.json`)
  }
  const devDeps = nodeDevServerDeps({
    script: join(HERE, 'viteserver.mjs'),
    args: [REPO, DEV_URL.hostname, DEV_URL.port],
    cwd: REPO,
    logFile: join(OUT, logName),
    save: (n, data) => saveDiagnostics(n, data, null),
  })
  const devOptions = {
    origin: PAGE_ORIGIN,
    appPath: '/',
    labPath: LAB_PATH,
    labMarker: LAB_MARKER,
    requiredModules: [WORKER_ENTRY],
    label,
    // B1.5.4E: after readiness, `/` becomes the placeholder before RoadPilot starts.
    // B1.5.4G: except in a negative control, which needs the real app page.
    placeholder: !NEGATIVE_CONTROL,
  }
  const rec = await runSession(
    {
      preflight: async () => {
        const checks = { resultFiles: 'free' }
        try {
          assertDesktopIdle(BUSY)
          checks.desktop = 'idle'
        } catch (e) {
          return { ok: false, checks: { ...checks, desktop: errorText(e) } }
        }
        const running = appPids()
        checks.roadpilot = running.length ? `running (PID ${running.join(', ')})` : 'not running'
        return { ok: running.length === 0, checks }
      },
      startDevServer: () => startDevServer(devDeps, devOptions),
      stopDevServer: (server) => stopDevServer(devDeps, server),
      appProcesses: () => processInfo(),
      save: saveJson,
      now: () => Date.now(),
    },
    { label },
    () => RUNTIME[name].run(),
  )
  for (const s of rec.stages)
    console.log(
      `${s.verdict.padEnd(10)} session:${s.stage}${s.error ? ` (${s.error})` : s.reason ? ` (${s.reason})` : ''}`,
    )
  const rep = buildReport({ ...(rec.bodyResult ?? {}), lifecycle: rec })
  printReport(rep)
  if (NEGATIVE_CONTROL) {
    // A control whose body never ran (dev server failed) has no result: inconclusive as well.
    const nc = rep.criteria.negativeControl ?? {
      outcome: 'inconclusive',
      reason: 'no_control_record',
    }
    console.log(`NEGATIVE CONTROL outcome: ${nc.outcome} (${nc.reason}). Not a measurement.`)
    if (nc.outcome !== 'detected') {
      console.log('NEGATIVE CONTROL NOT DETECTED: stop; this proves nothing about the detector.')
      process.exitCode = 4
    }
  }
  if (rec.verdict === 'FAIL') {
    console.log(
      `CLEANUP FAIL: ${JSON.stringify(rec.cleanup)}. Nothing was force-terminated; check the processes above before the next session.`,
    )
    process.exitCode = 3
  }
}

if (!ARGS_CHECK.ok) {
  // B1.5.4G: refused before any file, process or server is touched.
  console.log(`REFUSED: ${ARGS_CHECK.error}. Nothing was started.`)
  process.exitCode = 2
} else if (mode === 'report') report()
else if (RUNTIME[mode]) {
  if (CONFIRMED) await session(mode)
  else plan()
} else {
  console.log(
    'usage: node tools/maplibre-validation/run.mjs <functional|perf|cycles|report> [--confirm-runtime] [--out=dir] [--nv] [--only=urban|stress] [--kinds=a,b] [--runs=3] [--kind=k] [--busy=a,b] [--tag=amd|nv]\n       node tools/maplibre-validation/run.mjs control --negative-control [--confirm-runtime] [--session=name] [--nv]',
  )
  process.exitCode = 1
}
