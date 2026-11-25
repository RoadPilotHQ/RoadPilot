/* global URL */
/**
 * B1 runtime validation: pure evaluation of raw harness results (no I/O, no browser, no app).
 * Every threshold of the B1 brief and ADR-003 lives here; `run.mjs` only collects data.
 *
 * Verdicts:
 * - PASS: recorded evidence meets the criterion.
 * - FAIL: recorded evidence violates the criterion.
 * - INVALID: the run cannot decide the criterion (missing or malformed data, an infrastructure
 *   error, too few runs, a step that threw). Never counts as a pass; the run must be repeated.
 * - NOT_TESTED: no data for the criterion in this report.
 *
 * Nothing here relaxes a threshold. A criterion over several runs passes only if every valid run
 * passes and at least `MIN_RUNS` runs are valid; any invalid run makes the criterion INVALID.
 */

import { CONTROL_KIND } from './negativecontrol.mjs'
import { PLACEHOLDER_MARKER } from './placeholder.mjs'

export const VERDICTS = Object.freeze(['PASS', 'FAIL', 'INVALID', 'NOT_TESTED'])

/** B1 brief, section 9 (acceptance targets), unchanged. */
export const THRESHOLDS = Object.freeze({
  urban: Object.freeze({ segments: 100_000, firstVisibleMs: 100, gapP95Ms: 20, gapMaxMs: 50 }),
  stress: Object.freeze({ segments: 1_000_000, firstVisibleMs: 500, gapP95Ms: 33, gapMaxMs: 75 }),
})

/** B1 brief, section 10: maximum positional display error, CSS pixels. */
export const ACCURACY_TOLERANCE_PX = 0.5

/** B1 brief: at least three measurements per scenario after warm-up. */
export const MIN_RUNS = 3

/**
 * Memory growth: PROVISIONAL DIAGNOSTIC THRESHOLD (B1.4.1). Not an approved acceptance criterion:
 * the B1 brief asks for "no continuous memory growth" without a number. Cycles 1–4 of 8 are
 * treated as settling (M3 saw memory settle within 3–5 cycles); the diagnostic flags any series
 * that grows by more than 5 % from cycle 5 to cycle 8 (the ±5 % memory target of M2).
 *
 * Because it is not approved, `evaluateMemoryCycles` never returns PASS or FAIL from this number:
 * the criterion stays NOT_TESTED and the calculation is reported as `diagnostic`. Using it as an
 * acceptance criterion needs an explicit approval and a change to that function.
 */
export const MEMORY = Object.freeze({
  status: 'provisional',
  cycles: 8,
  steadyFrom: 5,
  growthLimit: 0.05,
})

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)
const finite = (v) => typeof v === 'number' && Number.isFinite(v)
const verdict = (v, reason, extra = {}) => ({ verdict: v, reason, ...extra })

/** Combines verdicts: any FAIL → FAIL; else any INVALID → INVALID; else any NOT_TESTED → NOT_TESTED. */
export function combine(verdicts) {
  if (!Array.isArray(verdicts) || verdicts.length === 0) return 'NOT_TESTED'
  for (const v of ['FAIL', 'INVALID', 'NOT_TESTED']) if (verdicts.includes(v)) return v
  return verdicts.every((v) => v === 'PASS') ? 'PASS' : 'INVALID'
}

// ---------------------------------------------------------------- accuracy

/**
 * The lab's `accuracy()` result (B1.2 format, `accuracyReport.ts`). An infrastructure error or a
 * malformed result is INVALID, never a rendering failure and never a pass.
 */
export function evaluateAccuracy(acc) {
  if (!isObj(acc)) return verdict('INVALID', 'no_result')
  if (acc.status === 'infrastructure_error')
    return verdict('INVALID', `infrastructure_error:${acc.reason ?? 'unknown'}`, {
      detail: acc.detail,
    })
  if (acc.status !== 'measured') return verdict('INVALID', 'unknown_status')
  const ints = ['cases', 'probes', 'missingDots']
  if (
    !ints.every((k) => Number.isInteger(acc[k]) && acc[k] >= 0) ||
    acc.cases === 0 ||
    acc.probes === 0
  )
    return verdict('INVALID', 'malformed_result')
  if (acc.tolerancePx !== ACCURACY_TOLERANCE_PX) return verdict('INVALID', 'tolerance_mismatch')
  if (typeof acc.withinTolerance !== 'boolean') return verdict('INVALID', 'malformed_result')
  const metrics = {
    cases: acc.cases,
    probes: acc.probes,
    missingDots: acc.missingDots,
    maxApiError: acc.maxApiError,
    maxRenderedError: acc.maxRenderedError,
    maxUnprojectError: acc.maxUnprojectError,
    constrainedCases: Array.isArray(acc.constrainedCases) ? acc.constrainedCases.length : null,
  }
  // Re-check independently of the lab's own flag.
  const errorsOk =
    finite(acc.maxApiError) &&
    finite(acc.maxRenderedError) &&
    finite(acc.maxUnprojectError) &&
    acc.maxApiError <= ACCURACY_TOLERANCE_PX &&
    acc.maxRenderedError <= ACCURACY_TOLERANCE_PX &&
    acc.maxUnprojectError <= ACCURACY_TOLERANCE_PX
  const recheck = acc.missingDots === 0 && errorsOk
  if (acc.withinTolerance !== recheck) return verdict('INVALID', 'inconsistent_result', { metrics })
  if (recheck) return verdict('PASS', 'within_tolerance', { metrics })
  return verdict('FAIL', acc.missingDots > 0 ? 'missing_dots' : 'error_above_tolerance', {
    metrics,
  })
}

/** The probe with the largest rendered error, or null; never assumes `acc.results` exists. */
export function worstProbe(acc) {
  if (!isObj(acc) || !Array.isArray(acc.results)) return null
  let worst = null
  for (const r of acc.results) {
    if (!isObj(r) || !Array.isArray(r.probes)) continue
    for (const p of r.probes)
      if (isObj(p) && finite(p.renderedError) && (!worst || p.renderedError > worst.renderedError))
        worst = { center: r.center, zoom: r.zoom, size: r.size, ...p }
  }
  return worst
}

// ---------------------------------------------------------------- network and CSP

const LOCAL_SCHEMES = ['data:', 'blob:', 'ipc:']

/**
 * Requests logged over DevTools (page and every worker session) after the lab was opened.
 * PASS needs: requests were logged at all, including the lab's own page (else the logging did
 * not work: INVALID), no request outside the dev-server origin and RoadPilot's IPC, no CSP
 * violation, and no MapLibre request (`transformRequest` log) to an external host.
 */
export function evaluateNetwork({ requests, pageOrigin, cspViolations, maplibreRequests } = {}) {
  if (!Array.isArray(requests) || typeof pageOrigin !== 'string')
    return verdict('INVALID', 'no_request_log')
  const origin = new URL(pageOrigin)
  const isLocal = (url) => {
    if (typeof url !== 'string') return false
    if (LOCAL_SCHEMES.some((s) => url.startsWith(s))) return true
    let u
    try {
      u = new URL(url)
    } catch {
      return false
    }
    if (u.origin === origin.origin) return true
    if ((u.protocol === 'ws:' || u.protocol === 'wss:') && u.host === origin.host) return true
    return u.origin === 'http://ipc.localhost'
  }
  const withUrl = requests.filter((r) => isObj(r) && typeof r.url === 'string')
  const labSeen = withUrl.some((r) => r.url.startsWith(`${origin.origin}/src/dev/mapLibreLab/`))
  if (!labSeen) return verdict('INVALID', 'instrumentation_saw_no_lab_request')
  const external = withUrl.filter((r) => !isLocal(r.url)).map((r) => r.url)
  const mlExternal = (Array.isArray(maplibreRequests) ? maplibreRequests : [])
    .map((r) => r?.url)
    .filter((u) => !isLocal(u))
  const csp = Array.isArray(cspViolations) ? cspViolations : null
  const metrics = {
    requests: withUrl.length,
    workerRequests: withUrl.filter((r) => r.session !== 'page').length,
    blobRequests: withUrl.filter((r) => r.url.startsWith('blob:')).length,
    external: [...new Set([...external, ...mlExternal])],
    cspViolations: csp,
  }
  if (csp === null) return verdict('INVALID', 'no_csp_log', { metrics })
  if (metrics.external.length > 0) return verdict('FAIL', 'external_requests', { metrics })
  if (csp.length > 0) return verdict('FAIL', 'csp_violations', { metrics })
  return verdict('PASS', 'offline', { metrics })
}

// ---------------------------------------------------------------- context loss, release

export function evaluateContextLoss(r) {
  if (!isObj(r)) return verdict('INVALID', 'no_result')
  if (r.error) return verdict('INVALID', 'step_failed', { detail: r.error })
  if (!finite(r.pixelsBefore) || !finite(r.pixelsAfter))
    return verdict('INVALID', 'malformed_result')
  if (r.pixelsBefore <= 0) return verdict('INVALID', 'nothing_drawn_before_loss')
  const metrics = {
    lostMs: r.lostMs,
    restoreMs: r.restoreMs,
    pixelsBefore: r.pixelsBefore,
    pixelsAfter: r.pixelsAfter,
  }
  if (r.pixelsAfter <= 0) return verdict('FAIL', 'blank_after_restore', { metrics })
  if (Array.isArray(r.errors) && r.errors.length > 0)
    return verdict('FAIL', 'map_errors', { metrics, detail: r.errors.slice(0, 5) })
  return verdict('PASS', 'restored', { metrics })
}

/** `release()` must leave no canvas, listener or pending wait; `remount()` exactly one canvas. */
export function evaluateRelease(r) {
  if (!isObj(r) || !isObj(r.release) || !isObj(r.afterRelease) || !isObj(r.remount))
    return verdict('INVALID', 'no_result')
  if (r.error) return verdict('INVALID', 'step_failed', { detail: r.error })
  const metrics = {
    canvasesAfterRelease: r.release.canvases,
    listenersAfterRelease: r.afterRelease.listeners,
    pendingAfterRelease: r.afterRelease.pendingWaits,
    canvasesAfterRemount: r.remount.canvases,
  }
  if (!Object.values(metrics).every((v) => Number.isInteger(v)))
    return verdict('INVALID', 'malformed_result', { metrics })
  const ok =
    metrics.canvasesAfterRelease === 0 &&
    metrics.listenersAfterRelease === 0 &&
    metrics.pendingAfterRelease === 0 &&
    metrics.canvasesAfterRemount === 1
  return verdict(ok ? 'PASS' : 'FAIL', ok ? 'clean' : 'leftovers', { metrics })
}

// ---------------------------------------------------------------- worker projection (B1.5.1)

/** MapLibre's own warning when a worker tiles GeoJSON without the projection handler. */
export const NO_HANDLER_WARNING = /no projection handler is set in the workers/i

const hasNoHandlerWarning = (entries) =>
  Array.isArray(entries) && entries.some((c) => NO_HANDLER_WARNING.test(String(c?.text ?? '')))

/**
 * B1.5.1 (defect A): the lab's worker projection state (`state().workerProjection`) and the
 * console of the same run. MapLibre's warning is a FAIL (geometry was tiled without the
 * handler); a missing or unfinished registration, or workers recreated during the run, is
 * INVALID (the run cannot show where the geometry was drawn).
 */
export function evaluateWorkerProjection(wp, consoleEntries) {
  if (hasNoHandlerWarning(consoleEntries)) return verdict('FAIL', 'worker_warned_no_handler')
  if (!isObj(wp)) return verdict('INVALID', 'no_worker_projection_state')
  const metrics = {
    state: wp.state,
    generation: wp.generation,
    recreations: wp.recreations,
    keepAlive: wp.keepAlive,
    failedAttempts: Array.isArray(wp.attempts) ? wp.attempts.length : null,
  }
  if (wp.state === 'failed') return verdict('FAIL', 'registration_failed', { metrics })
  if (wp.state !== 'ready') return verdict('INVALID', `not_ready:${wp.state}`, { metrics })
  if (wp.keepAlive !== true) return verdict('INVALID', 'worker_pool_not_kept', { metrics })
  if (!Number.isInteger(wp.recreations)) return verdict('INVALID', 'malformed_result', { metrics })
  if (wp.recreations > 0) return verdict('INVALID', 'workers_recreated', { metrics })
  return verdict('PASS', 'verified', { metrics })
}

// ---------------------------------------------------------------- performance

/**
 * One perf run (fresh app) of one renderer on one scenario. Acceptance values:
 * - first visible: the cold load's `firstMs` (first frame with road-layer pixels for MapLibre,
 *   first frame with drawn segments for M3), against `firstVisibleMs`;
 * - frame gap p95 and max: the worst of the pan run and the three zoom cycles.
 * Everything else (warm load, complete, idle, render CPU time, FPS, settle) is diagnostic.
 *
 * Each renderer is judged against the thresholds on its own. The two first-visible measurements
 * are not equivalent (pixel classification vs. submitted segments, different timed work), so
 * this module makes no MapLibre-versus-M3 comparison; see docs/maplibre-validation.md.
 */
export function evaluatePerfRun(run, scenario) {
  const th = THRESHOLDS[scenario]
  if (!th) return verdict('INVALID', 'unknown_scenario')
  if (!isObj(run)) return verdict('INVALID', 'no_result')
  if (run.error) return verdict('INVALID', 'step_failed', { detail: run.error })
  const iso = isolationOfRun(run)
  if (iso) return iso
  if (run.datasetSegments !== th.segments) return verdict('INVALID', 'wrong_dataset')
  const cold = run.cold
  if (!isObj(cold) || !finite(cold.firstMs)) return verdict('INVALID', 'no_first_visible')
  if (run.kind === 'm3' ? !(cold.firstSegments > 0) : !(cold.firstRoadPixels > 0))
    return verdict('INVALID', run.kind === 'm3' ? 'no_segments_drawn' : 'no_road_pixels_detected')
  // B1.5.1 (defect A): MapLibre numbers count only for geometry tiled with the projection handler.
  if (run.kind !== 'm3') {
    if (hasNoHandlerWarning(run.warnings)) return verdict('INVALID', 'worker_projection_warning')
    const wp = cold.workerProjection
    if (!isObj(wp) || wp.verified !== true)
      return verdict('INVALID', 'worker_projection_unverified')
    if (wp.recreatedDuringLoad !== false) return verdict('INVALID', 'workers_recreated_during_load')
    const recreations = run.state?.workerProjection?.recreations
    if (recreations !== undefined && recreations !== 0)
      return verdict('INVALID', 'workers_recreated')
  }
  const phases = [run.pan, ...(Array.isArray(run.zoom) ? run.zoom : [])]
  if (!isObj(run.pan) || !Array.isArray(run.zoom) || run.zoom.length !== 3)
    return verdict('INVALID', 'incomplete_phases')
  if (!phases.every((p) => isObj(p) && p.frames >= 2 && finite(p.p95) && finite(p.max)))
    return verdict('INVALID', 'too_few_frames')
  if (phases.some((p) => p.glError !== undefined && p.glError !== 0))
    return verdict('FAIL', 'webgl_error', { detail: phases.map((p) => p.glError) })
  const metrics = {
    firstVisibleMs: cold.firstMs,
    gapP95Ms: Math.max(...phases.map((p) => p.p95)),
    gapMaxMs: Math.max(...phases.map((p) => p.max)),
    panFps: run.pan.fps,
    completeMs: cold.completeMs,
    warmFirstVisibleMs: run.warm?.firstMs,
    settleMaxMs: Math.max(...run.zoom.map((p) => (finite(p.settleMs) ? p.settleMs : -1))),
  }
  const checks = {
    firstVisible: metrics.firstVisibleMs <= th.firstVisibleMs ? 'PASS' : 'FAIL',
    gapP95: metrics.gapP95Ms <= th.gapP95Ms ? 'PASS' : 'FAIL',
    gapMax: metrics.gapMaxMs <= th.gapMaxMs ? 'PASS' : 'FAIL',
  }
  return { verdict: combine(Object.values(checks)), reason: 'evaluated', checks, metrics }
}

const median = (v) => {
  const s = v.filter(finite).sort((a, b) => a - b)
  if (s.length === 0) return NaN
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2
}

/** All runs of one renderer on one scenario: every run valid, at least MIN_RUNS, each passing. */
export function aggregatePerf(runs, scenario) {
  if (!Array.isArray(runs) || runs.length === 0) return verdict('NOT_TESTED', 'no_runs')
  const evaluated = runs.map((r) => evaluatePerfRun(r, scenario))
  const invalid = evaluated.filter((e) => e.verdict === 'INVALID').length
  const valid = evaluated.filter((e) => e.verdict !== 'INVALID')
  const per = (key) => combine(valid.map((e) => e.checks?.[key] ?? 'FAIL'))
  const medians = {}
  for (const k of ['firstVisibleMs', 'gapP95Ms', 'gapMaxMs', 'panFps', 'completeMs'])
    medians[k] = median(valid.map((e) => e.metrics?.[k]))
  const extra = { runs: runs.length, invalidRuns: invalid, medians, perRun: evaluated }
  if (invalid > 0) return verdict('INVALID', 'invalid_runs', extra)
  if (valid.length < MIN_RUNS) return verdict('INVALID', 'too_few_runs', extra)
  const checks = { firstVisible: per('firstVisible'), gapP95: per('gapP95'), gapMax: per('gapMax') }
  return { verdict: combine(Object.values(checks)), reason: 'evaluated', checks, ...extra }
}

// ---------------------------------------------------------------- memory

const SERIES = Object.freeze({
  total: (c) => c?.mem?.total,
  gpuProcess: (c) => c?.mem?.gpuProc,
  renderer: (c) => c?.mem?.renderer,
  gpuDedicated: (c) => c?.mem?.gpuDedicated,
  heapMain: (c) => c?.heap?.main,
  heapWorkers: (c) => c?.heap?.workersTotal,
})

/**
 * Repeated zoom cycles in one app session (after one warm-up cycle).
 *
 * Missing or broken data is INVALID (the run must be repeated). Otherwise the growth over cycles
 * 5–8 is computed against the provisional `MEMORY.growthLimit` and returned as `diagnostic`
 * (`verdict` 'within_provisional_limit' or 'above_provisional_limit', `growth`, `over`); the
 * criterion's own verdict stays NOT_TESTED, so this number can never produce a PASS or a FAIL.
 */
export function evaluateMemoryCycles(result) {
  if (!isObj(result) || !Array.isArray(result.cycles)) return verdict('NOT_TESTED', 'no_cycles')
  if (result.error) return verdict('INVALID', 'step_failed', { detail: result.error })
  const iso = isolationOfRun(result)
  if (iso) return iso
  const cycles = result.cycles
  if (cycles.length < MEMORY.cycles) return verdict('INVALID', 'too_few_cycles')
  const from = cycles[MEMORY.steadyFrom - 1]
  const to = cycles[MEMORY.cycles - 1]
  const growth = {}
  for (const [name, get] of Object.entries(SERIES)) {
    const a = get(from)
    const b = get(to)
    if (!finite(a) || !finite(b) || a <= 0) return verdict('INVALID', `missing_series:${name}`)
    growth[name] = (b - a) / a
  }
  const over = Object.entries(growth)
    .filter(([, g]) => g > MEMORY.growthLimit)
    .map(([n]) => n)
  return verdict('NOT_TESTED', 'provisional_threshold_not_approved', {
    diagnostic: {
      threshold: 'provisional',
      growthLimit: MEMORY.growthLimit,
      verdict: over.length ? 'above_provisional_limit' : 'within_provisional_limit',
      growth,
      over,
    },
  })
}

// ---------------------------------------------------------------- harness evidence (B1.5.4B)

/**
 * Screenshot records of one run (evidence.mjs). Judged on their own: a missing screenshot is
 * missing evidence (INVALID), never a failure of the functional step it was taken in, and it does
 * not touch any measured criterion.
 */
export function evaluateScreenshots(records) {
  if (!Array.isArray(records)) return verdict('INVALID', 'no_screenshot_records')
  if (records.length === 0) return verdict('NOT_TESTED', 'no_screenshots')
  const missing = records.filter((r) => !isObj(r) || r.status !== 'saved')
  const names = records.filter(isObj).map((r) => r.name)
  const duplicates = names.filter((n, i) => n !== null && names.indexOf(n) !== i)
  const metrics = { planned: records.length, saved: records.length - missing.length }
  if (duplicates.length)
    return verdict('INVALID', 'duplicate_screenshot_names', { metrics, detail: duplicates })
  if (missing.length)
    return verdict('INVALID', 'screenshots_missing', {
      metrics,
      detail: missing.map((r) => ({
        seq: r?.seq,
        name: r?.name ?? null,
        stage: r?.stage ?? null,
        error: r?.error ?? null,
      })),
    })
  return verdict('PASS', 'all_saved', { metrics })
}

/**
 * Lab openings of the runs (openlab.mjs). Each run must open the lab at its first attempt: a
 * failed attempt is never hidden by a later successful one (INVALID `failed_attempt_before_success`),
 * and a lab that never opened is INVALID (`lab_not_opened`).
 * Input per run: { attempt, failedAttempts } or { failed: true, stage, error }.
 */
export function evaluateStartup(runs) {
  if (!Array.isArray(runs) || runs.length === 0) return verdict('NOT_TESTED', 'no_runs')
  const per = runs.map((r) => {
    if (!isObj(r)) return verdict('INVALID', 'no_record')
    if (r.failed) return verdict('INVALID', 'lab_not_opened', { detail: r })
    if (!Number.isInteger(r.attempt) || !Array.isArray(r.failedAttempts))
      return verdict('INVALID', 'malformed_record')
    if (r.failedAttempts.length > 0 || r.attempt !== 1)
      return verdict('INVALID', 'failed_attempt_before_success', {
        detail: r.failedAttempts.map((a) => ({
          attempt: a?.attempt,
          stage: a?.stage,
          error: a?.error,
        })),
      })
    return verdict('PASS', 'first_attempt')
  })
  const v = combine(per.map((p) => p.verdict))
  return verdict(v, v === 'PASS' ? 'first_attempt' : 'per_run', { perRun: per })
}

/**
 * The session record of lifecycle.mjs: dev server readiness, RoadPilot closed, dev server
 * stopped. FAIL when cleanup failed; INVALID when the session could not run completely.
 */
export function evaluateLifecycle(rec) {
  if (!isObj(rec) || !Array.isArray(rec.stages)) return verdict('INVALID', 'no_lifecycle_record')
  const stages = Object.fromEntries(rec.stages.map((s) => [s?.stage, s?.verdict]))
  const failed = rec.stages.filter((s) => s?.verdict === 'FAIL').map((s) => s.stage)
  const detail = { stages, cleanup: rec.cleanup ?? null }
  if (stages.appClosed === 'FAIL' || stages.stopDevServer === 'FAIL')
    return verdict('FAIL', 'cleanup_failed', detail)
  if (failed.length) return verdict('INVALID', `stage_failed:${failed.join(',')}`, detail)
  if (rec.stages.some((s) => s?.verdict !== 'PASS'))
    return verdict('INVALID', 'stages_not_run', detail)
  return verdict('PASS', 'complete', detail)
}

/** B1.5.4E: paths only the RoadPilot app page loads; the lab never requests them (B1.5.4C). */
export const APP_ONLY_PATHS = Object.freeze(['/src/app/', '/src/backend/'])
/** Tauri's IPC endpoint on Windows (`http://ipc.localhost`); the lab makes no IPC call. */
export const IPC_ORIGIN = 'http://ipc.localhost'
/** Tauri's warning when Rust calls a callback that the current document does not know. */
export const CALLBACK_WARNING = "Couldn't find callback id"

const originOf = (url) => {
  try {
    return new URL(url).origin
  } catch {
    return null
  }
}
const pathnameOf = (url) => {
  try {
    return new URL(url).pathname
  } catch {
    return ''
  }
}
const isIpcUrl = (url) =>
  typeof url === 'string' && (url.startsWith('ipc:') || originOf(url) === IPC_ORIGIN)

/**
 * B1.5.4E (B1.5.4D race): was the measurement webview free of the RoadPilot app page?
 *
 * Input (run.mjs): { expectedMarker, pageOrigin, probe: { marker, resources }, requests, console }
 * - `requests`: every request DevTools logged in the session (page and workers, before and after
 *   the lab navigation); `console`: every console entry; `probe`: the outgoing app page right
 *   before the lab navigation (openlab.mjs).
 *
 * INVALID (the run must be repeated) when the evidence is missing or incomplete, or when any of:
 * - `placeholder_not_confirmed`: the probe did not find the placeholder marker;
 * - `ipc_requests`: any request to Tauri's IPC endpoint in the session (the lab and the
 *   placeholder make none, so every one came from the app page);
 * - `app_resources_requested`: any request for an app-only module (`APP_ONLY_PATHS`);
 * - `ipc_in_app_page_resources` / `app_resources_in_app_page`: the outgoing page's resource list
 *   has IPC entries or ANY same-origin resource (the placeholder loads none);
 * - `callback_warnings`: Tauri's "Couldn't find callback id" in the console. A corroborating
 *   signal only: the request and probe checks decide without it.
 * PASS (`isolated`) only when none applies. The `network` criterion is unaffected (it allows
 * RoadPilot's IPC by design).
 */
export function evaluateAppPageIsolation(iso) {
  if (!isObj(iso)) return verdict('INVALID', 'no_isolation_evidence')
  if (typeof iso.expectedMarker !== 'string' || iso.expectedMarker !== PLACEHOLDER_MARKER)
    return verdict('INVALID', 'incomplete_evidence:expectedMarker')
  const origin = typeof iso.pageOrigin === 'string' ? originOf(iso.pageOrigin) : null
  if (!origin) return verdict('INVALID', 'incomplete_evidence:pageOrigin')
  if (!Array.isArray(iso.requests)) return verdict('INVALID', 'no_request_log')
  if (!Array.isArray(iso.console)) return verdict('INVALID', 'no_console_log')
  if (!isObj(iso.probe)) return verdict('INVALID', 'no_app_probe')
  if (!Array.isArray(iso.probe.resources)) return verdict('INVALID', 'no_resource_list')
  const urls = iso.requests.filter((r) => isObj(r) && typeof r.url === 'string').map((r) => r.url)
  if (!urls.some((u) => u.startsWith(`${origin}/src/dev/mapLibreLab/`)))
    return verdict('INVALID', 'instrumentation_saw_no_lab_request')
  const resources = iso.probe.resources.filter((u) => typeof u === 'string')
  const appOnly = (u) =>
    originOf(u) === origin && APP_ONLY_PATHS.some((p) => pathnameOf(u).startsWith(p))
  const found = {
    ipcRequests: urls.filter(isIpcUrl),
    appRequests: urls.filter(appOnly),
    probeIpcResources: resources.filter(isIpcUrl),
    probeAppResources: resources.filter((u) => originOf(u) === origin),
  }
  const callbackWarnings = iso.console.filter(
    (c) => isObj(c) && String(c.text ?? '').includes(CALLBACK_WARNING),
  ).length
  const metrics = {
    marker: iso.probe.marker ?? null,
    requests: urls.length,
    callbackWarnings,
    ...Object.fromEntries(
      Object.entries(found).map(([k, v]) => [k, { count: v.length, first: v.slice(0, 10) }]),
    ),
  }
  const reasons = []
  if (iso.probe.marker !== iso.expectedMarker) reasons.push('placeholder_not_confirmed')
  if (found.ipcRequests.length) reasons.push('ipc_requests')
  if (found.appRequests.length) reasons.push('app_resources_requested')
  if (found.probeIpcResources.length) reasons.push('ipc_in_app_page_resources')
  if (found.probeAppResources.length) reasons.push('app_resources_in_app_page')
  if (callbackWarnings) reasons.push('callback_warnings')
  if (reasons.length) return verdict('INVALID', reasons[0], { reasons, metrics })
  return verdict('PASS', 'isolated', { metrics })
}

/**
 * B1.5.4E: a perf or cycles run that recorded isolation evidence counts only when it is isolated;
 * returns the INVALID verdict for such a run, or null (no evidence field: older results, or
 * isolated).
 */
function isolationOfRun(run) {
  if (run.appPageIsolation === undefined) return null
  const iso = evaluateAppPageIsolation(run.appPageIsolation)
  if (iso.verdict === 'PASS') return null
  return verdict('INVALID', 'app_page_not_isolated', { detail: iso.reason, reasons: iso.reasons })
}

/** B1.5.4G: `appPageIsolation` reasons that are contamination (not missing evidence or marker). */
export const CONTAMINATION_REASONS = Object.freeze([
  'ipc_requests',
  'app_resources_requested',
  'ipc_in_app_page_resources',
  'app_resources_in_app_page',
  'callback_warnings',
])

/**
 * B1.5.4G: the result of a negative-control session (run.mjs `control --negative-control`).
 *
 * A control is never a measurement, so its verdict is always INVALID. What it shows is in
 * `outcome`:
 * - `detected`: the app page demonstrably rendered (`appRender.rendered`, so `main.tsx` ran) AND
 *   `appPageIsolation` is INVALID with at least one contamination reason. Only this outcome shows
 *   that the detector works at runtime.
 * - `inconclusive`: anything else: no control record, the placeholder was active, the lab never
 *   opened, the render was not confirmed, the isolation evidence is incomplete, or no contamination
 *   was found. A clean control proves nothing; the test stops there.
 * - `detector_failed`: the render was confirmed but `appPageIsolation` is PASS.
 */
export function evaluateNegativeControl(result) {
  const out = (reason, outcome, extra = {}) => ({
    verdict: 'INVALID',
    reason,
    control: true,
    outcome,
    ...extra,
  })
  if (!isObj(result) || !isObj(result.control) || result.control.kind !== CONTROL_KIND)
    return out('no_control_record', 'inconclusive')
  if (result.control.placeholder !== false) return out('control_was_isolated', 'inconclusive')
  if (!Array.isArray(result.failedSteps)) return out('incomplete_control_record', 'inconclusive')
  const openFail = result.failedSteps.find((s) => s?.name === 'openLab')
  if (openFail)
    return out('control_lab_not_opened', 'inconclusive', {
      detail: { stage: openFail.stage ?? null, error: openFail.error ?? null },
    })
  if (!isObj(result.appRender) || result.appRender.rendered !== true)
    return out('app_render_not_confirmed', 'inconclusive')
  const isolation = evaluateAppPageIsolation(result.appPageIsolation)
  if (isolation.verdict === 'PASS')
    return out('detector_missed_contamination', 'detector_failed', { isolation })
  if (!Array.isArray(isolation.reasons))
    return out('control_evidence_incomplete', 'inconclusive', { isolation })
  const contamination = isolation.reasons.filter((r) => CONTAMINATION_REASONS.includes(r))
  if (contamination.length === 0)
    return out('contamination_not_reproduced', 'inconclusive', { isolation })
  return out('contamination_detected', 'detected', { isolation, contamination })
}

/** Lab-opening records of the runs in one report (older results without them are skipped). */
function startupRecords(f, functional, perfRuns, cycleList) {
  const out = []
  const from = (ok, failed) => {
    if (isObj(ok)) out.push({ attempt: ok.attempt, failedAttempts: ok.failedAttempts })
    else if (isObj(failed)) out.push({ failed: true, stage: failed.stage, error: failed.error })
  }
  if (functional)
    from(
      f.env?.openLab,
      (Array.isArray(f.failedSteps) ? f.failedSteps : []).find((s) => s?.name === 'openLab'),
    )
  for (const r of perfRuns) if (isObj(r)) from(r.openLabAttempt, r.openLab)
  for (const c of cycleList) if (isObj(c)) from(c.openLabAttempt, c.openLab)
  return out
}

// ---------------------------------------------------------------- whole report

/** The report of one or more harness outputs; every criterion separately, plus an overall verdict. */
export function buildReport({ functional, perf, cycles, lifecycle, negativeControl } = {}) {
  const f = isObj(functional) ? functional : {}
  const steps = isObj(f.steps) ? f.steps : {}
  const criteria = {
    network: functional ? evaluateNetwork(f.network) : verdict('NOT_TESTED', 'no_functional_run'),
    accuracyScs: functional
      ? evaluateAccuracy(steps.accuracyScs)
      : verdict('NOT_TESTED', 'no_functional_run'),
    accuracyIdentity: functional
      ? evaluateAccuracy(steps.accuracyIdentity)
      : verdict('NOT_TESTED', 'no_functional_run'),
    accuracyScsDpr15: functional
      ? evaluateAccuracy(steps.accuracyScsDpr15)
      : verdict('NOT_TESTED', 'no_functional_run'),
    contextLoss: functional
      ? evaluateContextLoss(steps.contextLoss)
      : verdict('NOT_TESTED', 'no_functional_run'),
    releaseRemount: functional
      ? evaluateRelease(steps.releaseRemount)
      : verdict('NOT_TESTED', 'no_functional_run'),
    workerProjection: functional
      ? evaluateWorkerProjection(steps.finalState?.workerProjection, f.console)
      : verdict('NOT_TESTED', 'no_functional_run'),
    // Labels, styling and thin roads need a visual review of the screenshots.
    labels: verdict('NOT_TESTED', 'visual_review_required', {
      detail: Array.isArray(steps.labels) ? steps.labels : null,
    }),
  }
  if (functional && Array.isArray(f.failedSteps) && f.failedSteps.length)
    criteria.functionalSteps = verdict('INVALID', 'steps_failed', { detail: f.failedSteps })
  const perfRuns = Array.isArray(perf) ? perf : []
  for (const scenario of Object.keys(THRESHOLDS))
    for (const kind of [...new Set(perfRuns.map((r) => r?.kind).filter(Boolean))]) {
      const runs = perfRuns.filter((r) => r?.kind === kind && r?.scenario === scenario)
      criteria[`perf:${kind}:${scenario}`] = aggregatePerf(runs, scenario)
    }
  if (perfRuns.length === 0) criteria.perf = verdict('NOT_TESTED', 'no_perf_runs')
  else {
    // Every perf run is a fresh app with its own request log: each must be offline as well.
    const nets = perfRuns.map((r) => evaluateNetwork(r?.network))
    criteria['network:perfRuns'] = {
      verdict: combine(nets.map((n) => n.verdict)),
      reason: 'per_run',
      perRun: nets,
    }
  }
  const cycleList = Array.isArray(cycles) ? cycles : []
  for (const c of cycleList) criteria[`memory:${c?.kind}:${c?.scenario}`] = evaluateMemoryCycles(c)
  if (cycleList.length === 0) criteria.memory = verdict('NOT_TESTED', 'no_cycles')
  // B1.5.4B: harness evidence, each only when the results carry it (older results stay as they were).
  if (functional && f.screenshots !== undefined)
    criteria.screenshots = evaluateScreenshots(f.screenshots)
  const starts = startupRecords(f, functional, perfRuns, cycleList)
  if (starts.length) criteria.startup = evaluateStartup(starts)
  // B1.5.4E: every run of a session (lifecycle record) or with isolation evidence is judged; a run
  // of such a report without the evidence is INVALID. Pre-B1.5.4B results carry neither.
  const judged = (r) => isObj(r) && (r.appPageIsolation !== undefined || lifecycle !== undefined)
  const isoRuns = [
    ...(functional && judged(f) ? [f] : []),
    ...perfRuns.filter(judged),
    ...cycleList.filter(judged),
  ].map((r) => evaluateAppPageIsolation(r.appPageIsolation))
  if (isoRuns.length === 1) criteria.appPageIsolation = isoRuns[0]
  else if (isoRuns.length > 1)
    criteria.appPageIsolation = verdict(combine(isoRuns.map((r) => r.verdict)), 'per_run', {
      perRun: isoRuns,
    })
  // B1.5.4G: a negative control is judged only as a control (always INVALID as a measurement).
  if (negativeControl !== undefined) {
    criteria.negativeControl = evaluateNegativeControl(negativeControl)
    criteria.appPageIsolation ??= evaluateAppPageIsolation(
      isObj(negativeControl) ? negativeControl.appPageIsolation : undefined,
    )
  }
  // Any measurement result that carries a control marker can never count.
  const controlled = [...(functional ? [f] : []), ...perfRuns, ...cycleList].filter(
    (r) => isObj(r) && r.control !== undefined,
  )
  if (controlled.length)
    criteria.controlSession = verdict('INVALID', 'negative_control_result_in_measurement')
  // One session record (a run) or several (`report` over a folder): one criterion per session.
  if (Array.isArray(lifecycle))
    for (const [i, rec] of lifecycle.entries())
      criteria[`sessionLifecycle:${isObj(rec) && rec.label ? rec.label : i + 1}`] =
        evaluateLifecycle(rec)
  else if (lifecycle !== undefined) criteria.sessionLifecycle = evaluateLifecycle(lifecycle)
  return {
    thresholds: THRESHOLDS,
    accuracyTolerancePx: ACCURACY_TOLERANCE_PX,
    minRuns: MIN_RUNS,
    memoryRule: MEMORY,
    criteria,
    // B1.5.4G: marks a report that contains a negative control (never a validation result).
    ...(negativeControl !== undefined || controlled.length ? { control: true } : {}),
    overall: combine(Object.values(criteria).map((c) => c.verdict)),
  }
}
