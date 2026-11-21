/**
 * DEVELOPMENT ONLY (Phase 2.4D B1.2, F5): evaluation of the lab's positional accuracy run, free of
 * MapLibre and the DOM. It separates three outcomes that must never be confused:
 *
 * - `infrastructure_error`: the test could not measure (probe layer or source missing, no cases,
 *   or a non-finite value). Says nothing about MapLibre's rendering.
 * - `measured` with `withinTolerance: false`: something was measured and it is not good enough,
 *   including probe dots that were not found on screen although the probe layer exists.
 * - `measured` with `withinTolerance: true`: every probe was found and every error is finite and
 *   ≤ the tolerance. This is the only result that may count as a pass.
 */
import type { NativePoint } from './coordinates'

/** B1 acceptance tolerance: maximum positional display error, CSS pixels. */
export const ACCURACY_TOLERANCE_PX = 0.5

export interface ScreenPoint {
  x: number
  y: number
}

export interface ProbeResult {
  id: string
  expected: ScreenPoint
  api: ScreenPoint
  apiError: number
  /** Centroid of the drawn dot, or null when no dot was found near the expected position. */
  rendered: ScreenPoint | null
  renderedError: number
  unprojectError: number
}

export interface AccuracyCase {
  center: NativePoint
  actualCenter: NativePoint
  zoom: number
  actualZoom: number
  size: { width: number; height: number }
  constrained: boolean
  probes: ProbeResult[]
}

export type InfrastructureReason =
  'probe_layer_missing' | 'probe_source_missing' | 'no_cases' | 'invalid_probe_result'

export interface InfrastructureError {
  status: 'infrastructure_error'
  reason: InfrastructureReason
  detail: string
}

export interface MeasuredAccuracy {
  status: 'measured'
  tolerancePx: number
  cases: number
  probes: number
  /** Probe dots not found on screen although the probe layer exists: a rendering observation. */
  missingDots: number
  maxApiError: number
  /** Over the dots that were found; NaN when none was found. */
  maxRenderedError: number
  maxUnprojectError: number
  withinTolerance: boolean
  constrainedCases: {
    center: NativePoint
    actualCenter: NativePoint
    zoom: number
    actualZoom: number
  }[]
}

export type AccuracyReport = InfrastructureError | MeasuredAccuracy

/** The infrastructure the accuracy run needs: the `probe` layer and the `probes` source. */
export function checkProbeInfrastructure(
  layerIds: readonly string[],
  sourceIds: readonly string[],
): InfrastructureError | null {
  if (!layerIds.includes('probe'))
    return {
      status: 'infrastructure_error',
      reason: 'probe_layer_missing',
      detail: 'the style has no "probe" layer; configure the lab with probes: true',
    }
  if (!sourceIds.includes('probes'))
    return {
      status: 'infrastructure_error',
      reason: 'probe_source_missing',
      detail: 'the style has no "probes" source',
    }
  return null
}

const finitePoint = (p: ScreenPoint) => Number.isFinite(p.x) && Number.isFinite(p.y)

function invalidProbe(p: ProbeResult): string | null {
  if (!finitePoint(p.expected)) return 'expected position is not finite'
  if (!finitePoint(p.api) || !Number.isFinite(p.apiError)) return 'project() result is not finite'
  if (!Number.isFinite(p.unprojectError)) return 'unproject() result is not finite'
  if (p.rendered !== null && (!finitePoint(p.rendered) || !Number.isFinite(p.renderedError)))
    return 'rendered centroid is not finite'
  if (p.rendered === null && !Number.isNaN(p.renderedError))
    return 'a missing dot must have a NaN rendered error'
  return null
}

export function summarizeAccuracy(
  cases: readonly AccuracyCase[],
  tolerancePx = ACCURACY_TOLERANCE_PX,
): AccuracyReport {
  const probes = cases.flatMap((c) => c.probes)
  if (cases.length === 0 || probes.length === 0)
    return { status: 'infrastructure_error', reason: 'no_cases', detail: 'nothing was measured' }
  for (const c of cases)
    for (const p of c.probes) {
      const why = invalidProbe(p)
      if (why)
        return {
          status: 'infrastructure_error',
          reason: 'invalid_probe_result',
          detail: `probe ${p.id} at zoom ${c.zoom}: ${why}`,
        }
    }
  const found = probes.filter((p) => p.rendered !== null)
  const max = (v: number[]) => (v.length ? Math.max(...v) : NaN)
  const maxApiError = max(probes.map((p) => p.apiError))
  const maxRenderedError = max(found.map((p) => p.renderedError))
  const maxUnprojectError = max(probes.map((p) => p.unprojectError))
  const missingDots = probes.length - found.length
  return {
    status: 'measured',
    tolerancePx,
    cases: cases.length,
    probes: probes.length,
    missingDots,
    maxApiError,
    maxRenderedError,
    maxUnprojectError,
    withinTolerance:
      missingDots === 0 &&
      maxApiError <= tolerancePx &&
      maxRenderedError <= tolerancePx &&
      maxUnprojectError <= tolerancePx,
    constrainedCases: cases
      .filter((c) => c.constrained)
      .map(({ center, actualCenter, zoom, actualZoom }) => ({
        center,
        actualCenter,
        zoom,
        actualZoom,
      })),
  }
}
