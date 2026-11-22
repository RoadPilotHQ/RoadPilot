/* global process, fetch, WebSocket, setTimeout, AbortSignal */
/**
 * B1 runtime validation harness: starts RoadPilot's debug build (its own WebView2) with
 * per-process WebView2 arguments and talks to its page over the DevTools protocol. No input
 * simulation and no system setting: the arguments live only in the child process's environment.
 * Flat auto-attached sessions make MapLibre's workers visible (their requests and heaps).
 *
 * Windows only (PowerShell, taskkill, WebView2). Paths are derived from this repository.
 * Nothing here runs on import; `launchApp` refuses to start unless explicitly confirmed.
 */
import { execFileSync, spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
export const APP = join(REPO, 'src-tauri', 'target', 'debug', 'roadpilot.exe')
export const APP_CWD = join(REPO, 'src-tauri')

/** RoadPilot's bundle identifier; its WebView2 user data folder path contains it. */
export function appIdentifier() {
  return JSON.parse(readFileSync(join(REPO, 'src-tauri', 'tauri.conf.json'), 'utf8')).identifier
}

/** Processes that must not run during a measurement: the games RoadPilot supports. */
export const BUSY_PROCESSES = Object.freeze(['amtrucks', 'eurotrucks2'])
/** NVIDIA utilisation (%) above which the desktop counts as busy. */
export const BUSY_GPU_PERCENT = 25

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

export function ps(cmd) {
  try {
    return execFileSync('powershell', ['-NoProfile', '-Command', cmd], { encoding: 'utf8' }).trim()
  } catch {
    return ''
  }
}

export function appWebViewPids(mark = appIdentifier()) {
  const out = ps(
    `Get-CimInstance Win32_Process -Filter "Name='msedgewebview2.exe'" | Where-Object { $_.CommandLine -like '*${mark}*' } | ForEach-Object { $_.ProcessId }`,
  )
  return out ? out.split(/\s+/).map(Number) : []
}

export function appPids() {
  const out = ps(`Get-Process roadpilot -ErrorAction SilentlyContinue | ForEach-Object { $_.Id }`)
  return out ? out.split(/\s+/).map(Number) : []
}

export async function waitGone(timeoutMs = 20000) {
  const t0 = Date.now()
  while (Date.now() - t0 < timeoutMs) {
    if (appPids().length === 0 && appWebViewPids().length === 0) return Date.now() - t0
    await sleep(300)
  }
  return -1
}

/**
 * Refuses to measure on a busy desktop: NVIDIA utilisation above `BUSY_GPU_PERCENT` (when
 * `nvidia-smi` exists) or one of `BUSY_PROCESSES` plus `extra` running. Never stops anything.
 */
export function assertDesktopIdle(extra = []) {
  let util = 0
  try {
    util = Number(
      execFileSync('nvidia-smi', ['--query-gpu=utilization.gpu', '--format=csv,noheader,nounits'], {
        encoding: 'utf8',
      }).trim(),
    )
  } catch {
    // No NVIDIA GPU or no nvidia-smi: only the process check applies.
  }
  const names = [...BUSY_PROCESSES, ...extra].filter((n) => /^[\w.-]+$/.test(n))
  const busy = ps(
    `Get-Process ${names.join(',')} -ErrorAction SilentlyContinue | ForEach-Object { $_.ProcessName }`,
  )
  if (util > BUSY_GPU_PERCENT || busy)
    throw new Error(`DESKTOP BUSY: NVIDIA utilisation ${util} %${busy ? `, running: ${busy}` : ''}`)
}

export async function launchApp({
  port = 9445,
  flags = [],
  confirmed = false,
  busyExtra = [],
} = {}) {
  if (confirmed !== true)
    throw new Error('launchApp: runtime validation not confirmed (pass --confirm-runtime)')
  assertDesktopIdle(busyExtra)
  if (appPids().length) throw new Error('RoadPilot is already running; not starting a second one')
  const gone = await waitGone(15000)
  if (gone < 0) throw new Error('WebView2 processes of RoadPilot still running')
  const env = {
    ...process.env,
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: [`--remote-debugging-port=${port}`, ...flags].join(' '),
  }
  const t0 = Date.now()
  const proc = spawn(APP, [], { cwd: APP_CWD, env, stdio: 'ignore', detached: false })
  let exited = null
  proc.on('exit', (code) => (exited = code))
  for (let i = 0; i < 150; i++) {
    if (exited !== null) throw new Error(`RoadPilot exited during start (${exited})`)
    try {
      const r = await fetch(`http://127.0.0.1:${port}/json/version`)
      if (r.ok) {
        const version = await r.json()
        return { proc, port, version, startMs: Date.now() - t0, exited: () => exited }
      }
    } catch {
      // Not listening yet.
    }
    await sleep(200)
  }
  proc.kill()
  throw new Error('WebView2 did not open the debugging port')
}

/** Asks the window to close (WM_CLOSE, as the user closing it) and waits for every process. */
export async function closeApp(app) {
  const t0 = Date.now()
  try {
    execFileSync('taskkill', ['/PID', String(app.proc.pid)], { stdio: 'ignore' })
  } catch {
    // Already gone.
  }
  for (let i = 0; i < 50 && app.exited() === null; i++) await sleep(200)
  const graceful = app.exited() !== null
  if (!graceful) {
    try {
      app.proc.kill()
    } catch {
      // Already gone.
    }
  }
  const gone = await waitGone(20000)
  return { graceful, exitCode: app.exited(), closeMs: Date.now() - t0, webviewGoneMs: gone }
}

/** DevTools targets of the app's WebView2 (`/json/list`), bounded. */
export async function listTargets(port, timeoutMs = 3000) {
  const r = await fetch(`http://127.0.0.1:${port}/json/list`, {
    signal: AbortSignal.timeout(timeoutMs),
  })
  if (!r.ok) throw new Error(`/json/list answered ${r.status}`)
  return r.json()
}

/** Whether the dev server serves `url` (status and time), bounded; never throws. */
export async function devServerStatus(url, timeoutMs = 3000) {
  const t0 = Date.now()
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) })
    return { url, ok: r.ok, status: r.status, ms: Date.now() - t0 }
  } catch (e) {
    return { url, ok: false, status: null, ms: Date.now() - t0, error: String(e) }
  }
}

/** RoadPilot's own processes: the app and the WebView2 processes of its user data folder. */
export function processInfo() {
  return { app: appPids(), webview: appWebViewPids() }
}

/** Raised for every pending and later command once the DevTools connection is gone. */
export class TargetClosedError extends Error {
  constructor(detail = '') {
    super(`DevTools connection closed${detail ? ` (${detail})` : ''}`)
    this.name = 'TargetClosedError'
  }
}

export async function connect(url) {
  const ws = new WebSocket(url)
  await new Promise((res, rej) => {
    ws.onopen = res
    ws.onerror = rej
  })
  let id = 0
  const pending = new Map()
  const listeners = []
  const closeListeners = []
  let closed = null
  // B1.5.1: a target that disappears must not leave commands waiting forever.
  ws.onclose = (e) => {
    closed = new TargetClosedError(`code ${e?.code ?? '?'}`)
    for (const { reject } of pending.values()) reject(closed)
    pending.clear()
    for (const l of closeListeners) l(closed)
  }
  ws.onmessage = (e) => {
    const msg = JSON.parse(e.data)
    if (msg.id && pending.has(msg.id)) {
      const { resolve: ok, reject } = pending.get(msg.id)
      pending.delete(msg.id)
      if (msg.error) reject(new Error(JSON.stringify(msg.error)))
      else ok(msg.result)
    } else if (msg.method) for (const l of listeners) l(msg)
  }
  const send = (method, params = {}, sessionId) =>
    new Promise((ok, reject) => {
      if (closed) return reject(closed)
      const i = ++id
      pending.set(i, { resolve: ok, reject })
      const m = { id: i, method, params }
      if (sessionId) m.sessionId = sessionId
      ws.send(JSON.stringify(m))
    })
  const evaluate = async (expression, timeout = 900000) => {
    const r = await send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
      timeout,
    })
    if (r.exceptionDetails)
      throw new Error(
        `${r.exceptionDetails.text} ${r.exceptionDetails.exception?.description ?? ''}`,
      )
    return r.result.value
  }
  return {
    send,
    evaluate,
    on: (l) => listeners.push(l),
    onClose: (l) => closeListeners.push(l),
    close: () => ws.close(),
  }
}

/**
 * Logs every request of the page and of every worker (flat auto-attached sessions), every console
 * message, log entry and exception, from the moment it is called.
 */
export async function instrument(page) {
  const log = { requests: [], console: [], exceptions: [], workers: [] }
  const sessions = new Set()
  page.on((msg) => {
    const sid = msg.sessionId ?? 'page'
    if (msg.method === 'Network.requestWillBeSent')
      log.requests.push({
        session: sid,
        url: msg.params.request.url,
        method: msg.params.request.method,
        type: msg.params.type,
        t: Date.now(),
      })
    else if (msg.method === 'Network.loadingFailed')
      log.requests.push({
        session: sid,
        failed: msg.params.errorText,
        blocked: msg.params.blockedReason,
        id: msg.params.requestId,
        t: Date.now(),
      })
    else if (msg.method === 'Runtime.consoleAPICalled')
      log.console.push({
        session: sid,
        type: msg.params.type,
        text: msg.params.args
          .map((a) => a.value ?? a.description ?? '')
          .join(' ')
          .slice(0, 400),
      })
    else if (msg.method === 'Runtime.exceptionThrown')
      log.exceptions.push({
        session: sid,
        text: (
          msg.params.exceptionDetails.exception?.description ?? msg.params.exceptionDetails.text
        ).slice(0, 400),
      })
    else if (msg.method === 'Log.entryAdded')
      log.console.push({
        session: sid,
        type: `log-${msg.params.entry.level}`,
        source: msg.params.entry.source,
        text: `${msg.params.entry.source}: ${msg.params.entry.text}`.slice(0, 400),
        url: msg.params.entry.url,
      })
    else if (msg.method === 'Target.attachedToTarget') {
      const s = msg.params.sessionId
      sessions.add(s)
      log.workers.push({
        session: s,
        type: msg.params.targetInfo.type,
        url: msg.params.targetInfo.url,
      })
      Promise.all([
        page.send('Network.enable', {}, s),
        page.send('Runtime.enable', {}, s),
        page.send('Log.enable', {}, s),
      ]).catch(() => {})
    } else if (msg.method === 'Target.detachedFromTarget') sessions.delete(msg.params.sessionId)
  })
  await page.send('Network.enable')
  await page.send('Runtime.enable')
  await page.send('Log.enable')
  await page.send('Target.setAutoAttach', {
    autoAttach: true,
    waitForDebuggerOnStart: false,
    flatten: true,
  })
  return { log, sessions }
}

/** CSP violations reported to DevTools by the page or a worker (DevTools log entries). */
export function cspLogEntries(log) {
  return log.console.filter(
    (c) => /content security policy/i.test(c.text) || c.source === 'violation',
  )
}

/** Heap after GC of the page and of every attached worker session (MiB). */
export async function heaps(page, sessions) {
  await page.send('HeapProfiler.collectGarbage').catch(() => {})
  const main = await page.send('Runtime.getHeapUsage')
  const workers = []
  for (const s of sessions) {
    try {
      await page.send('HeapProfiler.collectGarbage', {}, s).catch(() => {})
      const h = await page.send('Runtime.getHeapUsage', {}, s)
      workers.push(h.usedSize / 2 ** 20)
    } catch {
      // Worker gone.
    }
  }
  return {
    main: main.usedSize / 2 ** 20,
    workers,
    workersTotal: workers.reduce((a, b) => a + b, 0),
  }
}
