/**
 * B1.5.4B: one validation session, start to cleanup. Pure orchestration (deps injected; tests:
 * `src/dev/mapLibreLab/tests/sessionLifecycle.test.ts`).
 *
 *   preflight → devServer (start + readiness, devserver.mjs) → body → appClosed → stopDevServer
 *
 * `body` is the measurement: it starts RoadPilot, opens the lab (openlab.mjs: startup, target,
 * appNavigation, navigation, labReady, initialConfig), runs the tests and closes RoadPilot. It
 * runs only after the dev server passed every readiness stage, so RoadPilot never starts against
 * a server that is not ready. B1.5.4E: run.mjs's dev server stage also includes the switch of
 * `/` to the app-page placeholder, so RoadPilot never starts against the real app page.
 *
 * Rules:
 * - a failed stage stops every dependent stage (recorded NOT_TESTED with the blocking stage);
 * - nothing is retried here, and a later success can never replace an earlier failure;
 * - the dev server this session started is always stopped (also after a failed body), gracefully
 *   (devserver.mjs `stopDevServer`); its result is the `stopDevServer` stage;
 * - RoadPilot still running after the body is a FAIL of `appClosed`; it is not killed here;
 * - the record is written once (`session-lifecycle-<label>.json`, never overwritten).
 *
 * Session verdict: PASS when every stage passed; FAIL when cleanup failed (`appClosed` or
 * `stopDevServer`); otherwise INVALID (the session could not run its measurement completely).
 * The measurement itself is judged by report.mjs, not here.
 */

export const SESSION_STAGES = Object.freeze([
  'preflight',
  'devServer',
  'body',
  'appClosed',
  'stopDevServer',
])

const errorText = (e) => (e instanceof Error ? `${e.name}: ${e.message}` : String(e))

/**
 * @param {object} deps  preflight() → { ok, checks }, startDevServer() → server,
 *                       stopDevServer(server) → { verdict, reason, … }, appProcesses() →
 *                       { app: number[], webview: number[] }, save(name, data) → path, now()
 * @param {object} options label
 * @param {(ctx: { server: object }) => Promise<unknown>} body
 */
export async function runSession(deps, options, body) {
  const rec = {
    label: options.label,
    t0: deps.now(),
    stages: [],
    devServer: null,
    cleanup: null,
    bodyResult: undefined,
    verdict: 'INVALID',
  }
  const stage = (name, verdict, extra = {}) => {
    const s = { stage: name, verdict, ...extra }
    rec.stages.push(s)
    return s
  }
  const skip = (names, blockedBy) => {
    for (const n of names) stage(n, 'NOT_TESTED', { blockedBy })
  }
  const timed = async (fn) => {
    const t0 = deps.now()
    try {
      return { value: await fn(), ms: deps.now() - t0 }
    } catch (error) {
      return { error, ms: deps.now() - t0 }
    }
  }

  const pre = await timed(() => deps.preflight())
  if (pre.error || !pre.value?.ok) {
    stage('preflight', 'FAIL', {
      ms: pre.ms,
      error: pre.error ? errorText(pre.error) : 'preflight refused',
      checks: pre.value?.checks ?? null,
    })
    skip(['devServer', 'body', 'appClosed', 'stopDevServer'], 'preflight')
    return finish(deps, rec)
  }
  stage('preflight', 'PASS', { ms: pre.ms, checks: pre.value.checks })

  const dev = await timed(() => deps.startDevServer())
  if (dev.error) {
    const e = dev.error
    stage('devServer', 'FAIL', {
      ms: dev.ms,
      error: errorText(e),
      failedStage: e?.stage ?? null,
      diagnosticsFile: e?.diagnosticsFile ?? null,
      pid: e?.pid ?? null,
    })
    skip(['body', 'appClosed'], 'devServer')
    // The failed start already stopped what it started; its cleanup is this session's cleanup.
    rec.cleanup = e?.cleanup ?? null
    if (rec.cleanup)
      stage('stopDevServer', rec.cleanup.verdict, {
        reason: rec.cleanup.reason,
        ms: rec.cleanup.ms,
      })
    else skip(['stopDevServer'], 'devServer')
    return finish(deps, rec)
  }
  const server = dev.value
  rec.devServer = {
    pid: server.pid,
    origin: server.origin,
    stages: server.stages,
    descendants: server.descendants,
    modules: server.modules && { count: server.modules.count, passes: server.modules.passes },
    // B1.5.4E: the app-page placeholder switch (devserver.mjs stage `placeholder`), if requested.
    placeholder: server.placeholder ?? null,
  }
  stage('devServer', 'PASS', { ms: dev.ms, pid: server.pid })

  const run = await timed(() => body({ server }))
  rec.bodyResult = run.value
  stage('body', run.error ? 'FAIL' : 'PASS', {
    ms: run.ms,
    ...(run.error ? { error: errorText(run.error) } : {}),
  })

  const procs = await timed(async () => deps.appProcesses())
  const left = procs.value ? [...procs.value.app, ...procs.value.webview] : null
  stage('appClosed', left && left.length === 0 ? 'PASS' : 'FAIL', {
    ms: procs.ms,
    processes: procs.value ?? null,
    ...(procs.error ? { error: errorText(procs.error) } : {}),
  })

  const stop = await timed(() => deps.stopDevServer(server))
  rec.cleanup = stop.value ?? {
    verdict: 'FAIL',
    reason: 'stop_threw',
    error: errorText(stop.error),
  }
  stage('stopDevServer', rec.cleanup.verdict === 'PASS' ? 'PASS' : 'FAIL', {
    ms: stop.ms,
    reason: rec.cleanup.reason,
  })
  return finish(deps, rec)
}

function finish(deps, rec) {
  const v = Object.fromEntries(rec.stages.map((s) => [s.stage, s.verdict]))
  if (v.appClosed === 'FAIL' || v.stopDevServer === 'FAIL') rec.verdict = 'FAIL'
  else if (rec.stages.every((s) => s.verdict === 'PASS')) rec.verdict = 'PASS'
  else rec.verdict = 'INVALID'
  rec.t1 = deps.now()
  try {
    rec.file = deps.save(`session-lifecycle-${rec.label}`, { ...rec, bodyResult: undefined })
  } catch (e) {
    rec.saveError = errorText(e)
  }
  return rec
}
