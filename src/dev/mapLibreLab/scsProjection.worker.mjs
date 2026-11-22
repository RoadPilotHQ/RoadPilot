/* global self */
/**
 * DEVELOPMENT ONLY (Phase 2.4D B1): the projection handler of MapLibre's workers for the lab's
 * registered planar CRS `roadpilot:scs`. GeoJSON is tiled in the workers, where the main
 * thread's converter cannot go, so the workers rebuild it from the CRS `definition` string.
 *
 * Loaded with `importScriptInWorkers`. The file name must end in `.mjs`: MapLibre then imports
 * it as a same-origin module, which the production CSP (`script-src 'self'`) allows. Any other
 * file type is fetched and evaluated, which needs `connect-src 'self'` and `'unsafe-eval'`.
 *
 * The conversion must match `scsConversion` in `coordinates.ts` (checked by a unit test).
 *
 * B1.5.1 (defect A): the worker also answers the status message `PROJECTION_STATUS_MESSAGE` of
 * `workerProjection.ts`, so the main thread can verify the handler in every worker instead of
 * assuming it. The answer exists only once `setProjectionHandler` was really called; a worker
 * without this script, or one whose MapLibre lacks `setProjectionHandler`, answers `null`.
 *
 * Justification for `self.worker.actor`: MapLibre documents registering worker message handlers
 * through the actor as an extension point (`importScriptInWorkers`, option 3, "using
 * `self.actor.registerMessageHandler`"). In 6.19.0 the worker exposes its actor as
 * `self.worker.actor` (`maplibre-gl-worker-dev.mjs`: `self.worker = new Worker(self)`, whose
 * constructor sets `this.actor`); `self.actor` does not exist there. Both are tried. The handler
 * only reports state and changes nothing in MapLibre. If neither exists, no status is answered
 * and the main thread reports the registration as failed (never as a silent pass).
 */
const PATTERN = /^roadpilot:scs;carrier=(\d+)$/

/** Must equal `PROJECTION_STATUS_MESSAGE` and `PROJECTION_CRS` in `workerProjection.ts` (unit test). */
export const STATUS_MESSAGE = 'roadpilot:scsProjectionStatus'
export const STATUS_CRS = 'roadpilot:scs'

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
 * Installs the handler in a worker scope and registers the status answer. Returns what was done
 * (also for the unit tests, which pass a fake scope).
 */
export function installScsProjection(scope) {
  const result = { handler: false, status: false }
  if (!scope || typeof scope.setProjectionHandler !== 'function') return result
  scope.setProjectionHandler(scsProjectionHandler)
  result.handler = true
  const actor = scope.worker?.actor ?? scope.actor
  if (actor && typeof actor.registerMessageHandler === 'function') {
    actor.registerMessageHandler(STATUS_MESSAGE, async () => ({ crs: STATUS_CRS, handler: true }))
    result.status = true
  }
  return result
}

if (typeof self !== 'undefined') installScsProjection(self)
