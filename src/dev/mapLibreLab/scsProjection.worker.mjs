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
 */
const PATTERN = /^roadpilot:scs;carrier=(\d+)$/

export function scsProjectionHandler(definition) {
  const match = PATTERN.exec(definition)
  if (!match) throw new Error(`Unknown CRS definition: ${definition}`)
  const scale = Number(match[1])
  return {
    forward: (p) => [p[0] * scale, p[1] * scale],
    inverse: (p) => [p[0] / scale, p[1] / scale],
  }
}

if (typeof self !== 'undefined' && typeof self.setProjectionHandler === 'function') {
  self.setProjectionHandler(scsProjectionHandler)
}
