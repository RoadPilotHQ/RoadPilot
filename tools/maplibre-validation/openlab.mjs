/**
 * B1.5.1 (defect B): opens the MapLibre lab in a freshly started RoadPilot, in separate, bounded
 * stages, and saves diagnostics for every failed attempt. Pure orchestration: every side effect
 * (app start and close, DevTools, dev server probe, files, clock) comes in through `deps`, so the
 * logic is unit-tested with fakes (`src/dev/mapLibreLab/tests/openLab.test.ts`).
 *
 * Stages, in order:
 * 1. `startup`       launch the app (confirmation, busy-desktop guard and debugging port: cdp.mjs).
 * 2. `target`        a DevTools `page` target exists; connect to it and start the request log.
 * 3. `appNavigation` the page's own first navigation has committed to the dev server.
 *                    Source (wry 0.57.1, `webview2/mod.rs`): the WebView2 environment (browser
 *                    process, debugging port) and the controller (the page target, `about:blank`)
 *                    exist before wry calls `webview.Navigate(devUrl)` at the end of `init_webview`.
 *                    A lab navigation sent in that window is replaced by wry's own navigation. B1.5
 *                    did not record the final URL of its failed starts, so it is not proven that
 *                    this caused them; waiting here removes the window either way.
 * 4. `navigation`    `Page.navigate` to the lab; the main frame commits the lab URL.
 * 5. `labReady`      the lab page is complete and exposes `window.mapLibreLab`, on the lab URL.
 * 6. `initialConfig` the page's own first configuration finished (result or error).
 *
 * Every wait polls a condition with a short interval and a stage deadline (no fixed sleep decides
 * anything). A failure keeps its original error and stage; diagnostics are captured afterwards and
 * a capture problem is only added to the diagnostics, never thrown. A retry (only when `attempts`
 * > 1 is passed; the default is one attempt) happens only after the app was closed and none of its
 * processes is left, so retries cannot create a second instance or leave orphans. Refusals (no
 * confirmation, busy desktop, app already running) are never retried.
 *
 * B1.5.4B: the dev server is no longer this module's assumption. lifecycle.mjs starts it and
 * proves it ready (devserver.mjs) before `openLab` runs, so the `startup` stage never begins
 * against a cold or foreign server.
 */

export const STAGES = Object.freeze([
  'startup',
  'target',
  'appNavigation',
  'navigation',
  'labReady',
  'initialConfig',
])

export const DEFAULT_TIMEOUTS = Object.freeze({
  target: 15_000,
  appNavigation: 30_000,
  navigation: 20_000,
  labReady: 30_000,
  initialConfig: 80_000,
  /** One DevTools command (frame tree, evaluate, screenshot) during the stages and the capture. */
  command: 5_000,
  /** Poll interval of every stage. */
  poll: 100,
})

/**
 * B1.5.4B: one attempt unless a caller asks for more. A retry is a diagnostic tool only: every
 * failed attempt stays in `failedAttempts`, and report.mjs (`startup`) makes a run with a failed
 * attempt INVALID even when a later attempt opened the lab.
 */
export const DEFAULT_ATTEMPTS = 1

/** Errors from `launch` that a retry cannot change. */
const REFUSAL = /not confirmed|DESKTOP BUSY|already running|still running/i

export class StageError extends Error {
  constructor(stage, message, detail = undefined) {
    super(`${stage}: ${message}`)
    this.name = 'StageError'
    this.stage = stage
    this.detail = detail
  }
}

export class OpenLabError extends Error {
  /** `attempts`: [{ attempt, stage, error, diagnosticsFile, cleanup }], first failure first. */
  constructor(attempts, reason = 'all attempts failed') {
    const first = attempts[0]
    super(
      `lab page did not open (${reason}): ` +
        attempts.map((a) => `#${a.attempt} ${a.stage}: ${a.error}`).join(' | '),
    )
    this.name = 'OpenLabError'
    this.stage = first?.stage ?? null
    this.attempts = attempts
  }
}

const errorText = (e) => (e instanceof Error ? `${e.name}: ${e.message}` : String(e))

/**
 * Bounded promise: rejects with a StageError after `ms`. Such a timeout is `transient`: inside a
 * polling stage one unanswered command is retried until the stage deadline.
 */
export function withTimeout(promise, ms, stage, what, deps) {
  return new Promise((resolve, reject) => {
    const timer = deps.setTimeout(() => {
      const e = new StageError(stage, `${what} did not answer within ${ms} ms`)
      e.transient = true
      reject(e)
    }, ms)
    Promise.resolve(promise).then(
      (v) => {
        deps.clearTimeout(timer)
        resolve(v)
      },
      (e) => {
        deps.clearTimeout(timer)
        reject(e)
      },
    )
  })
}

/**
 * Polls `check` until it returns a value other than `undefined`, or fails the stage at its
 * deadline. `check` may throw `StageError` to fail at once; other errors are transient (e.g. an
 * evaluation during a navigation) and are reported only if the deadline passes.
 */
async function waitFor(stage, timeoutMs, check, deps, poll) {
  const t0 = deps.now()
  let last = null
  for (;;) {
    try {
      const v = await check()
      if (v !== undefined) return v
    } catch (e) {
      if ((e instanceof StageError && !e.transient) || e?.name === 'TargetClosedError') throw e
      last = e
    }
    if (deps.now() - t0 >= timeoutMs)
      throw new StageError(
        stage,
        `not reached within ${timeoutMs} ms${last ? ` (last error: ${errorText(last)})` : ''}`,
      )
    await deps.sleep(poll)
  }
}

/**
 * @param {object} deps    launch(), close(app), processes(), listTargets(port), connect(wsUrl),
 *                         instrument(page), devServer(), save(name, data, pngBase64) â†’ path,
 *                         now(), sleep(ms), setTimeout(fn, ms), clearTimeout(id)
 * @param {object} options labUrl, devOrigin, dpr, label, attempts, timeouts
 */
export async function openLab(deps, options) {
  const timeouts = { ...DEFAULT_TIMEOUTS, ...(options.timeouts ?? {}) }
  const attempts = options.attempts ?? DEFAULT_ATTEMPTS
  const failures = []
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const r = await openOnce(deps, options, timeouts, attempt)
    if (r.ok) return { ...r.value, attempt, failedAttempts: failures }
    failures.push(r.failure)
    if (r.failure.refusal) throw new OpenLabError(failures, 'start refused')
    if (!r.failure.cleanup?.clean)
      throw new OpenLabError(failures, 'cleanup incomplete, not retried')
  }
  throw new OpenLabError(failures)
}

async function openOnce(deps, options, timeouts, attempt) {
  const t = timeouts
  const log = { events: [], console: [], exceptions: [], stages: [] }
  const mark = (event, extra = {}) => log.events.push({ t: deps.now(), event, ...extra })
  let stage = 'startup'
  let stageT0 = deps.now()
  const enter = (next) => {
    log.stages.push({ stage, ms: deps.now() - stageT0 })
    stage = next
    stageT0 = deps.now()
    mark(`stage:${next}`)
  }
  let app = null
  let page = null
  let inst
  let target = null
  const cmd = (method, params = {}) =>
    withTimeout(page.send(method, params), t.command, stage, method, deps)
  const frameUrl = async () => (await cmd('Page.getFrameTree')).frameTree.frame.url

  try {
    mark('stage:startup')
    try {
      app = await deps.launch()
    } catch (e) {
      e.refusal = REFUSAL.test(String(e?.message ?? e))
      throw e
    }
    mark('app-started', { port: app.port, startMs: app.startMs })

    enter('target')
    target = await waitFor(
      'target',
      t.target,
      async () => {
        if (app.exited() !== null)
          throw new StageError(
            'target',
            `app exited (${app.exited()}) before a page target existed`,
          )
        const list = await deps.listTargets(app.port)
        return list.find((x) => x.type === 'page') ?? undefined
      },
      deps,
      t.poll,
    )
    mark('target', { url: target.url, id: target.id })
    page = await withTimeout(
      deps.connect(target.webSocketDebuggerUrl),
      t.command,
      stage,
      'connect',
      deps,
    )
    page.onClose?.(() => mark('target-closed'))
    page.on((msg) => {
      const p = msg.params ?? {}
      if (msg.sessionId) return // workers: logged by the instrumentation
      if (msg.method === 'Page.frameNavigated' && !p.frame?.parentId)
        mark('frameNavigated', { url: p.frame?.url })
      else if (msg.method === 'Page.frameStartedLoading') mark('frameStartedLoading')
      else if (msg.method === 'Page.navigatedWithinDocument')
        mark('navigatedWithinDocument', { url: p.url })
      else if (msg.method === 'Page.domContentEventFired') mark('domContentEventFired')
      else if (msg.method === 'Page.loadEventFired') mark('loadEventFired')
      else if (msg.method === 'Inspector.detached') mark('inspectorDetached', { reason: p.reason })
      else if (msg.method === 'Inspector.targetCrashed') mark('targetCrashed')
      else if (msg.method === 'Runtime.consoleAPICalled')
        log.console.push({
          t: deps.now(),
          type: p.type,
          text: (p.args ?? [])
            .map((a) => a.value ?? a.description ?? '')
            .join(' ')
            .slice(0, 400),
        })
      else if (msg.method === 'Runtime.exceptionThrown')
        log.exceptions.push({
          t: deps.now(),
          text: String(
            p.exceptionDetails?.exception?.description ?? p.exceptionDetails?.text,
          ).slice(0, 400),
        })
      else if (msg.method === 'Log.entryAdded')
        log.console.push({
          t: deps.now(),
          type: `log-${p.entry?.level}`,
          text: String(p.entry?.text).slice(0, 400),
          url: p.entry?.url,
        })
    })
    await cmd('Page.enable')
    inst = await withTimeout(deps.instrument(page), t.command, stage, 'instrumentation', deps)
    await cmd('Emulation.setDeviceMetricsOverride', {
      width: 1280,
      height: 900,
      deviceScaleFactor: options.dpr ?? 1,
      mobile: false,
    })

    enter('appNavigation')
    const appUrl = await waitFor(
      'appNavigation',
      t.appNavigation,
      async () => {
        const url = await frameUrl()
        return url.startsWith(`${options.devOrigin}/`) ? url : undefined
      },
      deps,
      t.poll,
    )
    mark('app-navigation-committed', { url: appUrl })

    enter('navigation')
    const navT = deps.now()
    const nav = await cmd('Page.navigate', { url: options.labUrl })
    mark('navigate-sent', { loaderId: nav?.loaderId, errorText: nav?.errorText })
    if (nav?.errorText) throw new StageError('navigation', `Page.navigate failed: ${nav.errorText}`)
    await waitFor(
      'navigation',
      t.navigation,
      async () => ((await frameUrl()) === options.labUrl ? true : undefined),
      deps,
      t.poll,
    )

    enter('labReady')
    await waitFor(
      'labReady',
      t.labReady,
      async () => {
        const s = await cmd('Runtime.evaluate', {
          expression:
            '({href: location.href, ready: document.readyState, lab: typeof window.mapLibreLab === "object" && window.mapLibreLab !== null})',
          returnByValue: true,
        })
        const v = s?.result?.value
        if (v && v.href !== options.labUrl)
          throw new StageError('labReady', `page left the lab (now at ${v.href})`)
        return v && v.ready === 'complete' && v.lab ? true : undefined
      },
      deps,
      t.poll,
    )

    enter('initialConfig')
    const initial = await waitFor(
      'initialConfig',
      t.initialConfig,
      async () => {
        const s = await cmd('Runtime.evaluate', {
          expression:
            '(() => { const s = window.mapLibreLab.state(); return s.load || s.error ? JSON.parse(JSON.stringify(s)) : null })()',
          returnByValue: true,
        })
        return s?.result?.value ?? undefined
      },
      deps,
      t.poll,
    )
    enter('done')
    return {
      ok: true,
      value: { app, page, inst, navT, initial, stages: log.stages, events: log.events },
    }
  } catch (error) {
    // The original failure, kept as it is; everything below only adds to the diagnostics.
    const failure = {
      attempt,
      stage: error instanceof StageError ? error.stage : stage,
      error: errorText(error),
      refusal: error?.refusal === true,
      diagnosticsFile: null,
      cleanup: null,
    }
    if (failure.refusal) {
      failure.cleanup = { clean: true, note: 'nothing was started' }
      return { ok: false, failure }
    }
    const diag = await captureDiagnostics(deps, options, t, { failure, log, app, page, target })
    try {
      failure.diagnosticsFile = deps.save(
        `openlab-failure-${options.label ?? 'lab'}-a${attempt}`,
        diag.data,
        diag.png,
      )
    } catch (e) {
      failure.diagnosticsSaveError = errorText(e)
    }
    failure.cleanup = await cleanup(deps, app, page)
    return { ok: false, failure }
  }
}

/** Everything that can be read after a failure; each part separately bounded and optional. */
async function captureDiagnostics(deps, options, t, { failure, log, app, page, target }) {
  const captureErrors = []
  const part = async (name, fn) => {
    try {
      return await withTimeout(fn(), t.command, 'diagnostics', name, deps)
    } catch (e) {
      captureErrors.push({ part: name, error: errorText(e) })
      return null
    }
  }
  const data = {
    failure: { attempt: failure.attempt, stage: failure.stage, error: failure.error },
    labUrl: options.labUrl,
    devOrigin: options.devOrigin,
    capturedAt: deps.now(),
    stages: log.stages,
    events: log.events,
    console: log.console,
    exceptions: log.exceptions,
    initialTarget: target ? { url: target.url, id: target.id } : null,
    app: app
      ? { port: app.port, startMs: app.startMs, pid: app.proc?.pid ?? null, exited: app.exited() }
      : null,
  }
  data.processes = await part('processes', async () => deps.processes())
  data.devServer = await part('devServer', () => deps.devServer())
  data.targets = app ? await part('targets', () => deps.listTargets(app.port)) : null
  let png = null
  if (page) {
    data.frameUrl = await part(
      'frameUrl',
      async () => (await page.send('Page.getFrameTree')).frameTree.frame.url,
    )
    data.page = await part('pageState', async () => {
      const r = await page.send('Runtime.evaluate', {
        expression:
          '({href: location.href, ready: document.readyState, title: document.title, lab: typeof window.mapLibreLab, body: (document.body && document.body.innerText || "").slice(0, 400)})',
        returnByValue: true,
      })
      return r?.result?.value ?? null
    })
    data.history = await part('history', () => page.send('Page.getNavigationHistory'))
    png =
      (await part('screenshot', () => page.send('Page.captureScreenshot', { format: 'png' })))
        ?.data ?? null
  }
  data.finalUrl =
    data.page?.href ?? data.frameUrl ?? data.targets?.find?.((x) => x.type === 'page')?.url ?? null
  data.screenshot = png !== null
  data.captureErrors = captureErrors
  return { data, png }
}

/** Closes the page and the app, then checks that none of the app's processes is left. */
async function cleanup(deps, app, page) {
  const result = { clean: false, close: null, processes: null, error: null }
  try {
    page?.close()
  } catch {
    // The connection may already be gone.
  }
  try {
    if (app) result.close = await deps.close(app)
    result.processes = deps.processes()
    result.clean = result.processes.app.length === 0 && result.processes.webview.length === 0
  } catch (e) {
    result.error = errorText(e)
  }
  return result
}
