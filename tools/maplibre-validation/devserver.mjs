/* global URL */
/**
 * B1.5.4B (defects B and C): the harness's own Vite dev server, started, checked and stopped in
 * bounded stages. Pure orchestration: process start, HTTP, port owners, process table, files and
 * the clock come in through `deps` (real ones: `devserver-node.mjs`), so every path is
 * unit-tested with fakes (`src/dev/mapLibreLab/tests/devServer.test.ts`).
 *
 * Root causes (B1.5.4A):
 * - B: the server was started by hand (`npm run dev`) seconds before the app; nothing checked that
 *   it served the app and lab modules yet. Its first requests ran into Vite's cold start (the
 *   lab URL did not answer within 3 s at the failure), and `Page.navigate` timed out.
 * - C: `npm run dev` on Windows is a tree (npm-cli node → cmd.exe → vite node). Stopping the
 *   wrapper stops none of them (measured: all three survived), and Windows has no signal that
 *   asks a console process tree to exit gracefully.
 *
 * Correction: the harness forks ONE Node process (`viteserver.mjs`) that runs Vite through its
 * documented JS API (`createServer`, `listen`, `close`) with the repository's `vite.config.ts`.
 * There is no wrapper; the forked PID is the server. It reports `listening` over the IPC channel
 * and closes itself on the IPC message `shutdown` (`server.close()`, then a natural exit).
 *
 * Readiness stages, in order (each with its own deadline; a later stage never starts early):
 * 1. `preflight`  nothing listens on the port and nothing answers at the origin (else another
 *                 server would be tested: wrong process or port).
 * 2. `spawn`      the server process starts; its PID is recorded.
 * 3. `listening`  the server's own `listening` message, from that PID, for exactly the origin.
 *                 A console line such as Vite's "ready" is not used.
 * 4. `ownership`  the port's listening socket belongs to that PID (and to no other process).
 * 5. `http`       the app page (`/`) answers 200 with an HTML module page.
 * 6. `labRoute`   the lab page answers 200 and IS the lab (content marker); Vite's SPA fallback
 *                 answers unknown routes with the app page, so a status alone proves nothing.
 * 7. `modules`    every module of both pages (static and literal dynamic imports, same origin,
 *                 transitively) plus the required extra URLs (the worker entry) answers 200 with
 *                 JavaScript, in two consecutive complete passes with the same URL set. Vite's
 *                 dependency optimiser can change `?v=` URLs or answer 504 while it re-optimises
 *                 on a cold start; a stable second pass shows it has settled. Bounded passes.
 * The server process exiting at any point fails the current stage at once.
 *
 * B1.5.4E (app-page isolation, `options.placeholder`): one more stage after readiness:
 * 8. `placeholder` the server switches `/` to the empty, marked placeholder (placeholder.mjs):
 *                 IPC `placeholder`, acknowledged by `placeholder-active` from the server's own
 *                 PID with the expected marker; then over HTTP `/` must be the placeholder (marker,
 *                 no script), the lab page must still be the lab with the same module scripts, and
 *                 one pass over the lab's modules and the required URLs must answer 200 with
 *                 JavaScript, every URL from the stable readiness set. RoadPilot starts only after
 *                 this stage. It is refused (`activatePlaceholder`) unless readiness passed, and it
 *                 is not retried; a failure stops the server like any failed start.
 *
 * A failed start saves diagnostics, stops the server it started (gracefully, as below) and
 * throws `DevServerError`. Nothing is retried here.
 *
 * Shutdown (`stopDevServer`): IPC `shutdown`, then wait (bounded) for the process to exit, then
 * check: the HTTP endpoint stops answering, no socket of that PID listens on the port, and every
 * child process recorded at readiness has exited. There is no kill: on a timeout the result is
 * cleanup FAIL with the process identities, and the session stops. Processes that the harness did
 * not start are never looked up by name and never touched.
 */

import { PLACEHOLDER_MARKER, PLACEHOLDER_META } from './placeholder.mjs'

export const DEV_STAGES = Object.freeze([
  'preflight',
  'spawn',
  'listening',
  'ownership',
  'http',
  'labRoute',
  'modules',
])

/** B1.5.4E: the stage after `modules` when `options.placeholder` is set. */
export const PLACEHOLDER_STAGE = 'placeholder'

export const DEV_TIMEOUTS = Object.freeze({
  preflight: 10_000,
  listening: 30_000,
  ownership: 10_000,
  http: 15_000,
  labRoute: 15_000,
  modules: 120_000,
  /** IPC `placeholder` until `placeholder-active` (B1.5.4E). */
  placeholder: 5_000,
  /** One HTTP request. */
  request: 10_000,
  /** IPC shutdown until the process has exited (measured: 0.1-0.9 s). */
  shutdown: 20_000,
  /** Process exit until the endpoint refuses connections. */
  endpointDown: 5_000,
  poll: 200,
})

export const DEV_LIMITS = Object.freeze({ maxModules: 800, maxPasses: 3 })

export class DevServerError extends Error {
  constructor(stage, message, detail = {}) {
    super(`dev server ${stage}: ${message}`)
    this.name = 'DevServerError'
    this.stage = stage
    Object.assign(this, detail)
  }
}

class StageFail extends Error {
  constructor(stage, message, transient = false) {
    super(message)
    this.stage = stage
    this.transient = transient
  }
}

const errorText = (e) => (e instanceof Error ? `${e.name}: ${e.message}` : String(e))
const isJs = (ct) => /javascript/i.test(String(ct ?? ''))
const isHtml = (ct) => /text\/html/i.test(String(ct ?? ''))

/** Module script URLs of an HTML page, absolute. */
export function moduleScripts(html, pageUrl) {
  const out = []
  const re = /<script\b[^>]*\btype=["']module["'][^>]*\bsrc=["']([^"']+)["'][^>]*>/gi
  for (const m of String(html).matchAll(re)) out.push(new URL(m[1], pageUrl).href)
  return out
}

/**
 * Same-origin import URLs of a served (transformed) module: static `import`/`export … from`,
 * side-effect imports and literal `import("…")`. Comments are dropped first. Only specifiers that
 * the browser resolves as URLs (`/`, `./`, `../`) are followed.
 */
export function moduleImports(code, moduleUrl) {
  const src = String(code)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
  const specs = []
  for (const m of src.matchAll(
    /\b(?:import|export)\s*(?:[\w$*{}\s,]+?\s*from\s*)?["']([^"'\n]+)["']/g,
  ))
    specs.push(m[1])
  for (const m of src.matchAll(/\bimport\(\s*["']([^"'\n]+)["']\s*\)/g)) specs.push(m[1])
  const origin = new URL(moduleUrl).origin
  const out = []
  for (const s of specs) {
    if (!/^(\/|\.\/|\.\.\/)/.test(s) || s.startsWith('//')) continue
    const u = new URL(s, moduleUrl)
    if (u.origin === origin) out.push(u.href)
  }
  return [...new Set(out)]
}

async function waitFor(stage, timeoutMs, check, deps, ctx) {
  const t0 = deps.now()
  let last = null
  for (;;) {
    ctx.assertAlive(stage)
    try {
      const v = await check()
      if (v !== undefined) return v
    } catch (e) {
      if (e instanceof StageFail && !e.transient) throw e
      last = e
    }
    if (deps.now() - t0 >= timeoutMs)
      throw new StageFail(
        stage,
        `not reached within ${timeoutMs} ms${last ? ` (last: ${last.message ?? errorText(last)})` : ''}`,
      )
    await deps.sleep(ctx.poll)
  }
}

/** One crawl pass over the module graph; never throws (failures are listed). */
async function crawl(entries, deps, t, limits) {
  const seen = new Set()
  const queue = [...entries]
  const failures = []
  while (queue.length) {
    const url = queue.shift()
    if (seen.has(url)) continue
    if (seen.size >= limits.maxModules) {
      failures.push({ url, error: `more than ${limits.maxModules} modules` })
      break
    }
    seen.add(url)
    let r
    try {
      r = await deps.fetch(url, t.request)
    } catch (e) {
      failures.push({ url, error: errorText(e) })
      continue
    }
    if (r.status !== 200 || !isJs(r.contentType)) {
      failures.push({ url, status: r.status, contentType: r.contentType ?? null })
      continue
    }
    // Pre-bundled and raw package files are fetched, not parsed (huge, and not app code).
    if (new URL(url).pathname.startsWith('/node_modules/')) continue
    for (const next of moduleImports(r.text, url)) if (!seen.has(next)) queue.push(next)
  }
  return { urls: [...seen].sort(), failures }
}

const placeholderMetaRe = new RegExp(
  `<meta\\s+name=["']${PLACEHOLDER_META}["']\\s+content=["']([^"']*)["']`,
  'i',
)

/**
 * B1.5.4E: the `placeholder` stage (see the header). Throws StageFail; never retries.
 * Needs a server that passed readiness (`server.ready`), its recorded lab scripts and modules.
 */
async function placeholderStage(deps, server, t, limits, labMarker) {
  const stage = PLACEHOLDER_STAGE
  if (server?.ready !== true)
    throw new StageFail(stage, 'refused: the dev server has not passed readiness')
  const h = server.handle
  if (typeof h?.requestPlaceholder !== 'function')
    throw new StageFail(stage, 'refused: the server handle cannot switch the app page')
  if (h.exitInfo()) throw new StageFail(stage, 'refused: the server process has exited')
  const t0 = deps.now()
  if (!h.requestPlaceholder()) throw new StageFail(stage, 'IPC channel closed; not switched')
  let ack
  for (;;) {
    const msgs = h.messages()
    ack = msgs.find((m) => m?.type === 'placeholder-active' || m?.type === 'placeholder-refused')
    if (ack) break
    const x = h.exitInfo()
    if (x) throw new StageFail(stage, `server process exited (code ${x.code}) before acknowledging`)
    if (deps.now() - t0 >= t.placeholder)
      throw new StageFail(stage, `no placeholder acknowledgement within ${t.placeholder} ms`)
    await deps.sleep(t.poll)
  }
  const ackMs = deps.now() - t0
  if (ack.type === 'placeholder-refused')
    throw new StageFail(stage, `server refused the switch (${ack.reason ?? 'no reason'})`)
  if (ack.pid !== server.pid)
    throw new StageFail(stage, `acknowledgement from PID ${ack.pid}, not ${server.pid}`)
  if (ack.marker !== PLACEHOLDER_MARKER)
    throw new StageFail(stage, `acknowledged marker ${JSON.stringify(ack.marker)} is not expected`)

  // One request each, no retry: the switch either took effect or the session stops.
  const app = await deps.fetch(server.appUrl, t.request)
  const appMarker = String(app.text ?? '').match(placeholderMetaRe)?.[1] ?? null
  if (app.status !== 200 || !isHtml(app.contentType))
    throw new StageFail(stage, `${server.appUrl} answered ${app.status} ${app.contentType ?? ''}`)
  if (appMarker !== PLACEHOLDER_MARKER)
    throw new StageFail(stage, `${server.appUrl} is not the placeholder (marker missing)`)
  if (/<script\b/i.test(app.text))
    throw new StageFail(stage, `${server.appUrl} placeholder contains a script`)

  const lab = await deps.fetch(server.labUrl, t.request)
  if (lab.status !== 200 || !isHtml(lab.contentType) || !String(lab.text).includes(labMarker))
    throw new StageFail(stage, `${server.labUrl} is no longer the lab page after the switch`)
  const labScripts = moduleScripts(lab.text, server.labUrl)
  if (labScripts.join('\n') !== (server.labScripts ?? []).join('\n'))
    throw new StageFail(stage, `${server.labUrl} module scripts changed after the switch`)
  const pass = await crawl(
    [...new Set([...labScripts, ...(server.requiredModuleUrls ?? [])])],
    deps,
    t,
    limits,
  )
  const known = new Set(server.modules?.urls ?? [])
  const unknown = pass.urls.filter((u) => !known.has(u))
  if (pass.failures.length)
    throw new StageFail(
      stage,
      `lab modules not served after the switch (${pass.failures.length} failed: ${pass.failures
        .slice(0, 3)
        .map((f) => f.url)
        .join(', ')})`,
    )
  if (unknown.length)
    throw new StageFail(stage, `lab modules changed after the switch (${unknown.slice(0, 3)})`)
  return {
    active: true,
    marker: ack.marker,
    ackMs,
    ms: deps.now() - t0,
    app: { status: app.status, marker: appMarker, scripts: 0 },
    lab: { scripts: labScripts.length, modules: pass.urls.length },
  }
}

/**
 * B1.5.4E: switches a running, READY server's `/` to the placeholder. Refused (DevServerError,
 * stage `placeholder`, `refused: true`, nothing sent) unless `startDevServer` completed readiness
 * for this server. `startDevServer` with `options.placeholder` runs it as its last stage; this
 * export exists for callers and tests that hold a server object. Does not stop the server.
 */
export async function activatePlaceholder(deps, server, options = {}) {
  const t = { ...DEV_TIMEOUTS, ...(options.timeouts ?? {}) }
  const limits = { ...DEV_LIMITS, ...(options.limits ?? {}) }
  try {
    server.placeholder = await placeholderStage(deps, server, t, limits, options.labMarker ?? '')
    return server.placeholder
  } catch (e) {
    if (!(e instanceof StageFail)) throw e
    throw new DevServerError(e.stage, e.message, { refused: /^refused:/.test(e.message) })
  }
}

/**
 * @param {object} deps    spawn(), fetch(url, ms) → {status, contentType, text}, portOwners(port),
 *                         descendants(pid), isAlive(pid), save(name, data) → path, now(), sleep(ms)
 * @param {object} options origin, appPath, labPath, labMarker, requiredModules, label, timeouts,
 *                         limits, placeholder (B1.5.4E: switch `/` to the placeholder after
 *                         readiness)
 * @returns the running server ({ pid, origin, handle, stages, events, descendants, modules,
 *          ready, placeholder })
 */
export async function startDevServer(deps, options) {
  const t = { ...DEV_TIMEOUTS, ...(options.timeouts ?? {}) }
  const limits = { ...DEV_LIMITS, ...(options.limits ?? {}) }
  const origin = new URL(options.origin).origin
  const port = Number(new URL(origin).port)
  const appUrl = new URL(options.appPath ?? '/', origin).href
  const labUrl = new URL(options.labPath, origin).href
  const log = { stages: [], events: [] }
  const mark = (event, extra = {}) => log.events.push({ t: deps.now(), event, ...extra })
  let stage = 'preflight'
  let stageT0 = deps.now()
  const enter = (next) => {
    log.stages.push({ stage, ms: deps.now() - stageT0 })
    stage = next
    stageT0 = deps.now()
    mark(`stage:${next}`)
  }
  let handle = null
  const ctx = {
    poll: t.poll,
    assertAlive(s) {
      const x = handle?.exitInfo()
      if (x)
        throw new StageFail(
          s,
          `server process exited (code ${x.code}, signal ${x.signal}) during readiness`,
        )
    },
  }
  const server = { pid: null, origin, labUrl, appUrl, handle: null }
  try {
    mark('stage:preflight')
    const owners = await deps.portOwners(port)
    if (owners.length)
      throw new StageFail('preflight', `port ${port} already in use by PID ${owners.join(', ')}`)
    const answered = await deps.fetch(appUrl, t.request).then(
      (r) => r.status,
      () => null,
    )
    if (answered !== null)
      throw new StageFail('preflight', `something already answers at ${origin} (${answered})`)

    enter('spawn')
    handle = await deps.spawn()
    server.handle = handle
    server.pid = handle.pid
    mark('spawned', { pid: handle.pid })

    enter('listening')
    const listening = await waitFor(
      'listening',
      t.listening,
      async () => {
        const msgs = handle.messages()
        const err = msgs.find((m) => m?.type === 'error')
        if (err) throw new StageFail('listening', `server reported: ${err.error}`)
        const m = msgs.find((x) => x?.type === 'listening')
        if (!m) return undefined
        if (m.pid !== handle.pid)
          throw new StageFail('listening', `listening message from PID ${m.pid}, not ${handle.pid}`)
        const local = (m.urls?.local ?? []).map((u) => new URL(u).origin)
        if (!local.includes(origin))
          throw new StageFail(
            'listening',
            `server listens on ${local.join(', ') || '?'}, not ${origin}`,
          )
        return m
      },
      deps,
      ctx,
    )
    mark('listening', { urls: listening.urls?.local ?? null, vite: listening.vite ?? null })

    enter('ownership')
    await waitFor(
      'ownership',
      t.ownership,
      async () => {
        const o = await deps.portOwners(port)
        const foreign = o.filter((p) => p !== handle.pid)
        if (foreign.length)
          throw new StageFail('ownership', `port ${port} also owned by PID ${foreign.join(', ')}`)
        return o.includes(handle.pid) ? true : undefined
      },
      deps,
      ctx,
    )
    server.descendants = await deps.descendants(handle.pid)
    mark('ownership', { pid: handle.pid, descendants: server.descendants })

    enter('http')
    const appHtml = await waitFor(
      'http',
      t.http,
      async () => {
        const r = await deps.fetch(appUrl, t.request)
        if (r.status !== 200 || !isHtml(r.contentType))
          throw new StageFail('http', `${appUrl} answered ${r.status} ${r.contentType ?? ''}`, true)
        if (moduleScripts(r.text, appUrl).length === 0)
          throw new StageFail('http', `${appUrl} has no module script`)
        return r.text
      },
      deps,
      ctx,
    )

    enter('labRoute')
    const labHtml = await waitFor(
      'labRoute',
      t.labRoute,
      async () => {
        const r = await deps.fetch(labUrl, t.request)
        if (r.status !== 200 || !isHtml(r.contentType))
          throw new StageFail('labRoute', `${labUrl} answered ${r.status}`, true)
        if (!String(r.text).includes(options.labMarker))
          throw new StageFail(
            'labRoute',
            `${labUrl} is not the lab page (marker ${JSON.stringify(options.labMarker)} missing; SPA fallback?)`,
          )
        return r.text
      },
      deps,
      ctx,
    )

    enter('modules')
    const entries = [
      ...moduleScripts(appHtml, appUrl),
      ...moduleScripts(labHtml, labUrl),
      ...(options.requiredModules ?? []).map((p) => new URL(p, origin).href),
    ]
    const passes = []
    const deadline = deps.now() + t.modules
    let stable = null
    for (let i = 1; i <= limits.maxPasses && !stable; i++) {
      ctx.assertAlive('modules')
      const p0 = deps.now()
      const pass = await crawl([...new Set(entries)], deps, t, limits)
      passes.push({
        pass: i,
        ms: deps.now() - p0,
        modules: pass.urls.length,
        failures: pass.failures,
      })
      mark('modules-pass', { pass: i, modules: pass.urls.length, failures: pass.failures.length })
      const prev = passes.length > 1 ? passes[passes.length - 2] : null
      if (
        pass.failures.length === 0 &&
        prev &&
        prev.failures.length === 0 &&
        prev.urls.join('\n') === pass.urls.join('\n')
      )
        stable = pass
      passes[passes.length - 1].urls = pass.urls
      if (deps.now() >= deadline) break
    }
    ctx.assertAlive('modules')
    if (!stable)
      throw new StageFail(
        'modules',
        `module graph not served completely and stably after ${passes.length} passes (${passes
          .map((p) => `${p.modules} modules, ${p.failures.length} failed`)
          .join('; ')})`,
      )
    server.modules = {
      count: stable.urls.length,
      passes: passes.map((p) => ({
        pass: p.pass,
        ms: p.ms,
        modules: p.modules,
        failures: p.failures,
      })),
      urls: stable.urls,
    }
    server.labScripts = moduleScripts(labHtml, labUrl)
    server.requiredModuleUrls = (options.requiredModules ?? []).map((p) => new URL(p, origin).href)
    server.ready = true
    if (options.placeholder) {
      enter(PLACEHOLDER_STAGE)
      server.placeholder = await placeholderStage(deps, server, t, limits, options.labMarker)
      mark('placeholder', { marker: server.placeholder.marker, ackMs: server.placeholder.ackMs })
    }
    enter('ready')
    server.stages = log.stages
    server.events = log.events
    return server
  } catch (error) {
    const failStage = error instanceof StageFail ? error.stage : stage
    const failure = {
      stage: failStage,
      error: error instanceof StageFail ? error.message : errorText(error),
    }
    log.stages.push({ stage, ms: deps.now() - stageT0, failed: true })
    const diag = {
      failure,
      origin,
      labUrl,
      stages: log.stages,
      events: log.events,
      pid: handle?.pid ?? null,
      exit: handle?.exitInfo() ?? null,
      messages: handle ? handle.messages() : [],
      output: handle ? handle.output() : null,
    }
    diag.portOwners = await deps.portOwners(port).catch((e) => ({ error: errorText(e) }))
    diag.descendants = handle
      ? await deps.descendants(handle.pid).catch((e) => ({ error: errorText(e) }))
      : null
    let diagnosticsFile = null
    let diagnosticsSaveError = null
    try {
      diagnosticsFile = deps.save(`devserver-failure-${options.label ?? 'session'}`, diag)
    } catch (e) {
      diagnosticsSaveError = errorText(e)
    }
    server.descendants ??= Array.isArray(diag.descendants) ? diag.descendants : []
    const cleanup = handle ? await stopDevServer(deps, server, { timeouts: t }) : null
    throw new DevServerError(failStage, failure.error, {
      diagnosticsFile,
      diagnosticsSaveError,
      cleanup,
      pid: handle?.pid ?? null,
    })
  }
}

/**
 * Stops a server started by `startDevServer`: IPC `shutdown` only, bounded, then verifies the
 * endpoint, the port and the recorded child processes. Never kills; never throws.
 * Result `verdict`: PASS (exited and everything verified) or FAIL (with `reason`).
 */
export async function stopDevServer(deps, server, options = {}) {
  const t = { ...DEV_TIMEOUTS, ...(options.timeouts ?? {}) }
  const h = server.handle
  const port = Number(new URL(server.origin).port)
  const t0 = deps.now()
  const r = {
    pid: server.pid,
    alreadyExited: false,
    shutdownRequested: false,
    exit: null,
    closedMessage: false,
    graceful: false,
    httpDown: null,
    portFree: null,
    descendants: server.descendants ?? [],
    leftoverDescendants: [],
    verdict: 'FAIL',
    reason: null,
    ms: null,
  }
  const done = (reason) => {
    r.reason = reason
    r.ms = deps.now() - t0
    return r
  }
  try {
    if (h.exitInfo()) {
      r.alreadyExited = true
    } else {
      r.shutdownRequested = h.requestShutdown()
      if (!r.shutdownRequested) {
        r.processAlive = deps.isAlive(server.pid)
        return done('ipc_channel_closed')
      }
      const end = deps.now() + t.shutdown
      while (!h.exitInfo() && deps.now() < end) await deps.sleep(t.poll)
      if (!h.exitInfo()) {
        // Not killed: the identities go into the report and the session stops.
        r.processAlive = deps.isAlive(server.pid)
        r.descendantsNow = await deps
          .descendants(server.pid)
          .catch((e) => ({ error: errorText(e) }))
        return done('shutdown_timeout')
      }
    }
    r.exit = h.exitInfo()
    r.closedMessage = h.messages().some((m) => m?.type === 'closed')
    r.graceful = !r.alreadyExited && r.exit.code === 0 && r.closedMessage
    const end = deps.now() + t.endpointDown
    for (;;) {
      const up = await deps.fetch(server.appUrl ?? `${server.origin}/`, t.request).then(
        () => true,
        () => false,
      )
      if (!up) {
        r.httpDown = true
        break
      }
      if (deps.now() >= end) {
        r.httpDown = false
        break
      }
      await deps.sleep(t.poll)
    }
    const owners = await deps.portOwners(port)
    r.portOwnersAfter = owners
    r.portFree = !owners.includes(server.pid)
    // Children (e.g. Windows' conhost.exe) may need a moment after their parent; bounded wait.
    const childEnd = deps.now() + t.endpointDown
    r.leftoverDescendants = r.descendants.filter((d) => deps.isAlive(d.pid))
    while (r.leftoverDescendants.length && deps.now() < childEnd) {
      await deps.sleep(t.poll)
      r.leftoverDescendants = r.leftoverDescendants.filter((d) => deps.isAlive(d.pid))
    }
    if (!r.httpDown) return done('endpoint_still_answers')
    if (!r.portFree) return done('port_still_owned')
    if (r.leftoverDescendants.length) return done('child_processes_left')
    if (r.alreadyExited) {
      r.verdict = 'PASS'
      return done('already_exited')
    }
    if (!r.graceful) return done('not_graceful')
    r.verdict = 'PASS'
    return done('graceful')
  } catch (e) {
    r.error = errorText(e)
    return done('cleanup_error')
  }
}
