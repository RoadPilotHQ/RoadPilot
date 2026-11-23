/**
 * DEVELOPMENT ONLY (Phase 2.4D B1): the projection handler of MapLibre's workers for the lab's
 * registered planar CRS `roadpilot:scs`. GeoJSON is tiled in the workers, where the main
 * thread's converter cannot go, so the workers rebuild it from the CRS `definition` string.
 *
 * The conversion must match `scsConversion` in `coordinates.ts` (checked by a unit test).
 *
 * B1.5.3: this module has no side effect any more. It is imported by the lab's own worker entry
 * `scsWorkerEntry.mjs`, which MapLibre starts as the worker script (`setWorkerUrl`), and which
 * calls `bootstrapScsWorker(self, probe)` in the same synchronous module evaluation that creates
 * MapLibre's worker. B1.5.1 loaded this file with `importScriptInWorkers` instead; that import is
 * asynchronous in the worker, and B1.5.2 showed a new worker tiling GeoJSON before it finished.
 *
 * The worker answers the status message `PROJECTION_STATUS_MESSAGE` of `workerProjection.ts`, so
 * the main thread can verify every worker (secondary check). The answer exists only once
 * `setProjectionHandler` was really called by the entry; a worker without it answers `null`.
 *
 * Justification for `self.worker.actor`: MapLibre documents registering worker message handlers
 * through the actor as an extension point (`importScriptInWorkers`, option 3, "using
 * `self.actor.registerMessageHandler`"). In 6.19.0 the worker exposes its actor as
 * `self.worker.actor` (`maplibre-gl-worker-dev.mjs`: `self.worker = new Worker(self)`, whose
 * constructor sets `this.actor`); `self.actor` does not exist there. Both are tried.
 */
const PATTERN = /^roadpilot:scs;carrier=(\d+)$/

/** Must equal `PROJECTION_STATUS_MESSAGE` and `PROJECTION_CRS` in `workerProjection.ts` (unit test). */
export const STATUS_MESSAGE = 'roadpilot:scsProjectionStatus'
export const STATUS_CRS = 'roadpilot:scs'
/** How the handler was installed; must equal `PROJECTION_SOURCE` in `workerProjection.ts`. */
export const STATUS_SOURCE = 'worker-entry'

/** Marks a scope whose handler is installed, so a second call installs nothing. */
const INSTALLED = Symbol.for('roadpilot.scsProjection.installed')

export function scsProjectionHandler(definition) {
  const match = PATTERN.exec(definition)
  if (!match) throw new Error(`Unknown CRS definition: ${definition}`)
  const scale = Number(match[1])
  return {
    forward: (p) => [p[0] * scale, p[1] * scale],
    inverse: (p) => [p[0] / scale, p[1] / scale],
  }
}

/**
 * Installs the handler in a worker scope and registers the status answer. Idempotent: a scope
 * that already has it is left unchanged (`duplicate: true`). `messagesBeforeInstall` is reported
 * in the status answer (see `scsWorkerProbe.mjs`).
 */
export function installScsProjection(scope, { messagesBeforeInstall = 0 } = {}) {
  const result = { handler: false, status: false, duplicate: false }
  if (!scope) return result
  if (scope[INSTALLED]) return { ...scope[INSTALLED], duplicate: true }
  if (typeof scope.setProjectionHandler !== 'function') return result
  scope.setProjectionHandler(scsProjectionHandler)
  result.handler = true
  const actor = scope.worker?.actor ?? scope.actor
  if (actor && typeof actor.registerMessageHandler === 'function') {
    const answer = Object.freeze({
      crs: STATUS_CRS,
      handler: true,
      source: STATUS_SOURCE,
      messagesBeforeInstall,
    })
    actor.registerMessageHandler(STATUS_MESSAGE, async () => ({ ...answer }))
    result.status = true
  }
  scope[INSTALLED] = { handler: result.handler, status: result.status }
  return result
}

export class ScsWorkerBootstrapError extends Error {
  constructor(message) {
    super(`RoadPilot SCS worker entry: ${message}`)
    this.name = 'ScsWorkerBootstrapError'
  }
}

/**
 * Called by `scsWorkerEntry.mjs` right after MapLibre's worker module was evaluated. Installs the
 * handler; when that is impossible it closes the worker before throwing, so the worker can never
 * tile geometry without the handler (no silent Mercator fallback). The main thread then gets no
 * status answer and fails its verification; the thrown error is reported as a worker error.
 */
export function bootstrapScsWorker(scope, probe) {
  const result = installScsProjection(scope, { messagesBeforeInstall: probe?.messages ?? 0 })
  if (probe) probe.installed = true
  if (result.handler && result.status) return result
  const what = !result.handler
    ? 'MapLibre worker scope has no setProjectionHandler'
    : 'MapLibre worker actor has no registerMessageHandler'
  if (scope && typeof scope.close === 'function') scope.close()
  throw new ScsWorkerBootstrapError(`${what}; worker closed`)
}
