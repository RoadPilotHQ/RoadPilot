/* global process, console, fetch, AbortSignal, URL */
/**
 * DEVELOPMENT ONLY (Phase 2.4D B1.5.3): synthetic worker-ordering check in a real Chromium
 * browser. NOT the B1.5.4 runtime validation: it does not start RoadPilot or WebView2, only a
 * headless Microsoft Edge with a throwaway profile, against the Vite dev server's lab page (which
 * carries the production CSP). No input simulation, no game, no telemetry.
 *
 *   npm run dev                                   (in another terminal; serves 127.0.0.1:1420)
 *   node tools/maplibre-validation/workerorder.mjs [--cycles=10] [--session=<name>]
 *
 * Checks (all must hold for PASS):
 * - every MapLibre worker is started from the lab's entry `scsWorkerEntry.mjs`;
 * - restart: MapLibre's own `WorkerPool.restart()` (the B1.5.2 failure path), and in the same
 *   synchronous turn a status broadcast (reaches the brand-new workers before their module script
 *   is even loaded) and a concurrent lab reconfiguration; every worker must answer the
 *   entry-installed status with `messagesBeforeInstall: 0`;
 * - release/remount and the M3 → MapLibre round trip keep the verified workers;
 * - no MapLibre "no projection handler" warning, no CSP violation, no request to another origin,
 *   no exception, in the page or any worker.
 * Results: tools/maplibre-validation/out/<session>/worker-order.json (git-ignored, never overwritten).
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { connect, cspLogEntries, devServerStatus, instrument, REPO, sleep } from './cdp.mjs'
import { NO_HANDLER_WARNING } from './report.mjs'

const arg = (name, fallback) =>
  process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback
const CYCLES = Number(arg('cycles', '10'))
const SESSION = arg(
  'session',
  `b153-order-${new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)}`,
)
if (!/^[\w.-]+$/.test(SESSION) || !(CYCLES >= 1 && CYCLES <= 100)) throw new Error('bad arguments')

const DEV = 'http://127.0.0.1:1420'
const LAB = `${DEV}/src/dev/mapLibreLab/index.html`
const ENTRY_PATH = '/src/dev/mapLibreLab/scsWorkerEntry.mjs'
const PORT = 9339
// Microsoft Edge from the standard install folders (no machine-specific path in the source);
// `--edge=<path>` overrides.
const EDGE = [
  arg('edge', null),
  ...['ProgramFiles(x86)', 'ProgramFiles'].map(
    (v) => process.env[v] && join(process.env[v], 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
  ),
].find((p) => p && existsSync(p))
const OUT = join(REPO, 'tools/maplibre-validation/out', SESSION)

const rec = { session: SESSION, started: new Date().toISOString(), cycles: [], checks: {} }

async function waitFor(what, ms, fn) {
  const t0 = Date.now()
  for (;;) {
    const v = await fn().catch(() => undefined)
    if (v !== undefined) return v
    if (Date.now() - t0 > ms) throw new Error(`timeout: ${what}`)
    await sleep(100)
  }
}

let browser = null
let profile = null
let page = null
try {
  if (!EDGE) throw new Error('Microsoft Edge not found')
  const dev = await devServerStatus(LAB)
  if (!dev.ok) throw new Error(`dev server not serving the lab: ${JSON.stringify(dev)}`)
  mkdirSync(OUT, { recursive: true })

  profile = mkdtempSync(join(tmpdir(), 'rp-b153-edge-'))
  browser = spawn(
    EDGE,
    [
      '--headless=new',
      `--remote-debugging-port=${PORT}`,
      `--user-data-dir=${profile}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-extensions',
      '--disable-sync',
      '--disable-background-networking',
      '--disable-component-update',
      'about:blank',
    ],
    { stdio: 'ignore' },
  )
  const version = await waitFor('DevTools endpoint', 20000, async () => {
    const r = await fetch(`http://127.0.0.1:${PORT}/json/version`, {
      signal: AbortSignal.timeout(1000),
    })
    return r.ok ? r.json() : undefined
  })
  rec.browser = { product: version.Browser, userAgent: version['User-Agent'], headless: true }
  const target = await waitFor('page target', 10000, async () => {
    const r = await fetch(`http://127.0.0.1:${PORT}/json/list`, {
      signal: AbortSignal.timeout(1000),
    })
    return (await r.json()).find((t) => t.type === 'page')
  })
  page = await connect(target.webSocketDebuggerUrl)
  const inst = await instrument(page)
  await page.send('Page.enable')
  await page.send('Emulation.setDeviceMetricsOverride', {
    width: 1280,
    height: 900,
    deviceScaleFactor: 1,
    mobile: false,
  })
  await page.send('Page.navigate', { url: LAB })

  const L = (expr, timeout = 120000) =>
    page.evaluate(`(async () => { const L = window.mapLibreLab; return ${expr} })()`, timeout)
  const initial = await waitFor('lab initial configuration', 120000, async () =>
    page.evaluate(
      '(() => { const L = window.mapLibreLab; if (!L) return undefined; const s = L.state(); return s.load || s.error ? JSON.parse(JSON.stringify(s)) : undefined })()',
      5000,
    ),
  )
  rec.initial = {
    error: initial.error,
    load: initial.load?.workerProjection,
    renderer: initial.load?.renderer,
    firstRoadPixels: initial.load?.firstRoadPixels,
    workerProjection: initial.workerProjection,
  }
  if (initial.error)
    throw new Error(`lab initial configuration failed: ${JSON.stringify(initial.error)}`)

  // The lab's own MapLibre module (same Vite URL, same instance), for the dispatcher.
  const MOD = `(performance.getEntriesByType('resource').map(e => e.name).find(n => n.includes('/node_modules/.vite/deps/maplibre-gl.js')))`
  const STATUS = `'roadpilot:scsProjectionStatus'`
  const direct = () =>
    page.evaluate(
      `(async () => { const m = await import(${MOD}); return m.getGlobalDispatcher().broadcast(${STATUS}, null) })()`,
      30000,
    )
  const okStatus = (answers) =>
    Array.isArray(answers) &&
    answers.length > 0 &&
    answers.every(
      (a) =>
        a &&
        a.crs === 'roadpilot:scs' &&
        a.handler === true &&
        a.source === 'worker-entry' &&
        a.messagesBeforeInstall === 0,
    )
  const warnings = () => inst.log.console.filter((c) => NO_HANDLER_WARNING.test(String(c.text)))

  rec.checks.initialStatus = await direct()
  rec.checks.initialStatusOk = okStatus(rec.checks.initialStatus)

  // Lifecycle: release/remount and the renderer round trip keep the verified workers.
  await L('L.release()')
  await L('L.remount()')
  await L(`L.configure({renderer:'m3', scenario:'basic', crs:'scs'})`)
  await L(
    `L.configure({renderer:'maplibre', scenario:'basic', crs:'scs', labels:true, probes:true})`,
  )
  const afterLifecycle = await L('JSON.parse(JSON.stringify(L.state().workerProjection))')
  rec.checks.lifecycle = {
    state: afterLifecycle.state,
    generation: afterLifecycle.generation,
    recreations: afterLifecycle.recreations,
  }

  for (let i = 1; i <= CYCLES; i++) {
    const before = await L('L.state().workerProjection.generation')
    const r = await page.evaluate(
      `(async () => {
        const m = await import(${MOD});
        const d = m.getGlobalDispatcher();
        const t0 = performance.now();
        const restart = d.workerPool.restart();                 // new Worker() runs synchronously in here
        const early = d.broadcast(${STATUS}, null);             // posted before the new module is loaded
        const configure = window.mapLibreLab.configure({renderer:'maplibre', scenario:'basic', crs:'scs', labels:true, probes:true})
          .then(() => 'ok', (e) => 'error: ' + e.message);
        const answers = await early;
        const answeredMs = performance.now() - t0;
        await restart;
        return { answers, answeredMs, configure: await configure };
      })()`,
      120000,
    )
    await L('L.settle()').catch(() => undefined)
    await sleep(500) // let worker console entries arrive
    const wp = await L('JSON.parse(JSON.stringify(L.state().workerProjection))')
    const after = await direct()
    const c = {
      cycle: i,
      generationBefore: before,
      generationAfter: wp.generation,
      earlyAnswers: r.answers,
      earlyAnsweredMs: Math.round(r.answeredMs),
      earlyOk: okStatus(r.answers),
      configure: r.configure,
      registry: { state: wp.state, attempts: wp.attempts.length, workerErrors: wp.workerErrors },
      afterOk: okStatus(after),
      noHandlerWarningsTotal: warnings().length,
      load: await L('L.state().load && L.state().load.workerProjection'),
    }
    rec.cycles.push(c)
    console.log(JSON.stringify(c))
  }

  const workerUrls = inst.log.workers.filter((w) => w.type === 'worker').map((w) => w.url)
  const foreign = inst.log.requests.filter(
    (q) =>
      q.url &&
      !q.url.startsWith(`${DEV}/`) &&
      !/^(data|blob|about|chrome|edge):/.test(q.url) &&
      !q.url.startsWith('ws://127.0.0.1:1420'),
  )
  rec.checks.workers = {
    count: workerUrls.length,
    allFromEntry:
      workerUrls.length > 0 && workerUrls.every((u) => new URL(u).pathname === ENTRY_PATH),
    urls: [...new Set(workerUrls)],
  }
  rec.checks.noHandlerWarnings = warnings()
  rec.checks.cspViolations = cspLogEntries(inst.log)
  rec.checks.foreignRequests = foreign
  rec.checks.exceptions = inst.log.exceptions
  rec.checks.blobOrDataWorkers = workerUrls.filter((u) => /^(blob|data):/.test(u))
  const cyclesOk = rec.cycles.every(
    (c) =>
      c.earlyOk &&
      c.afterOk &&
      c.configure === 'ok' &&
      c.registry.state === 'ready' &&
      c.generationAfter === c.generationBefore + 1,
  )
  const pass =
    rec.checks.initialStatusOk &&
    afterLifecycle.state === 'ready' &&
    afterLifecycle.generation === 1 &&
    afterLifecycle.recreations === 0 &&
    cyclesOk &&
    rec.checks.workers.allFromEntry &&
    rec.checks.workers.count === CYCLES + 1 &&
    rec.checks.noHandlerWarnings.length === 0 &&
    rec.checks.cspViolations.length === 0 &&
    foreign.length === 0 &&
    inst.log.exceptions.length === 0 &&
    rec.checks.blobOrDataWorkers.length === 0
  rec.verdict = pass ? 'PASS' : 'FAIL'
} catch (e) {
  rec.verdict = 'ERROR'
  rec.error = String(e?.stack ?? e)
} finally {
  try {
    page?.close()
  } catch {
    /* already closed */
  }
  if (browser && browser.exitCode === null) browser.kill()
  await sleep(1500)
  if (profile) rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 })
  rec.finished = new Date().toISOString()
  if (existsSync(OUT))
    writeFileSync(join(OUT, 'worker-order.json'), JSON.stringify(rec, null, 1), { flag: 'wx' })
  console.log(
    JSON.stringify(
      {
        verdict: rec.verdict,
        error: rec.error,
        checks: { ...rec.checks, initialStatus: undefined },
        out: join(OUT, 'worker-order.json'),
      },
      null,
      1,
    ),
  )
  process.exitCode = rec.verdict === 'PASS' ? 0 : 1
}
