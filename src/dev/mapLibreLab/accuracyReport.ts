/**
 * DEVELOPMENT ONLY (Phase 2.4D B1.2, F5; B1.5.5): evaluation of the lab's positional accuracy run,
 * free of MapLibre and the DOM. It separates outcomes that must never be confused:
 *
 * - `infrastructure_error`: the test could not measure (probe layer or source missing, no cases,
 *   no measurable probe, an invalid DPR or a non-finite value). Says nothing about MapLibre's
 *   rendering.
 * - `measured` with `withinTolerance: false`: something was measured and it is not good enough,
 *   including measurable probe dots that were not found on screen although the probe layer exists.
 * - `measured` with `withinTolerance: true`: every measurable probe was found and every error is
 *   finite and ≤ the tolerance. This is the only result that may count as a pass.
 *
 * B1.5.5 (user decision, 2026-11-26): the acceptance matrix of `docs/maplibre-prototype.md` governs
 * B1; errors are judged in **device pixels**, over all zooms, sizes and magnitudes, as far as a
 * probe is measurable inside the CRS world. Probes outside the world or within the edge margin are
 * `not_measurable` (`probeMeasure.ts`): reported and counted, excluded from every error maximum,
 * and never a pass on their own.
 */
import type { NativePoint } from './coordinates'
import type { NotMeasurableReason } from './probeMeasure'

/** B1 acceptance tolerance: maximum positional display error, DEVICE pixels (B1.5.5 decision). */
export const ACCURACY_TOLERANCE_DEVICE_PX = 0.5

/** Unit of every error maximum and of the tolerance in a measured summary. */
export const ACCURACY_ERROR_UNIT = 'device_px'

export interface ScreenPoint {
  x: number
  y: number
}

/** One probe. Positions and the per-probe errors are CSS pixels, as measured by the lab. */
export interface ProbeResult {
  id: string
  /** B1.5.5: false for a probe outside the CRS world or within the edge margin. */
  measurable: boolean
  /** Why the probe is not measurable; null when it is. */
  notMeasurableReason: NotMeasurableReason | null
  /** Distance to the nearest world edge, CSS px; negative outside the world. */
  edgeDistancePx: number
  expected: ScreenPoint
  api: ScreenPoint
  apiError: number
  /** Centroid of the drawn dot, or null when no dot was found (or the probe is not measurable). */
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
  | 'probe_layer_missing'
  | 'probe_source_missing'
  | 'no_cases'
  | 'no_measurable_probes'
  | 'invalid_dpr'
  | 'invalid_probe_result'

export interface InfrastructureError {
  status: 'infrastructure_error'
  reason: InfrastructureReason
  detail: string
}

export interface MeasuredAccuracy {
  status: 'measured'
  errorUnit: typeof ACCURACY_ERROR_UNIT
  toleranceDevicePx: number
  dpr: number
  cases: number
  /** Every probe placed, measurable or not. */
  probes: number
  measurableProbes: number
  /** Probes skipped as `not_measurable`, by reason. Never counted as a pass. */
  notMeasurable: { count: number; outsideWorld: number; edgeMargin: number }
  /** Measurable probe dots not found on screen although the probe layer exists. */
  missingDots: number
  maxApiErrorDevicePx: number
  /** Over the measurable dots that were found; NaN when none was found. */
  maxRenderedErrorDevicePx: number
  maxUnprojectErrorDevicePx: number
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
  if (typeof p.measurable !== 'boolean') return 'measurability is missing'
  if (p.measurable !== (p.notMeasurableReason === null))
    return 'measurability and its reason disagree'
  if (!Number.isFinite(p.edgeDistancePx)) return 'edge distance is not finite'
  if (!finitePoint(p.expected)) return 'expected position is not finite'
  if (!finitePoint(p.api) || !Number.isFinite(p.apiError)) return 'project() result is not finite'
  if (!Number.isFinite(p.unprojectError)) return 'unproject() result is not finite'
  if (!p.measurable && p.rendered !== null) return 'a not measurable probe must not be measured'
  if (p.rendered !== null && (!finitePoint(p.rendered) || !Number.isFinite(p.renderedError)))
    return 'rendered centroid is not finite'
  if (p.rendered === null && !Number.isNaN(p.renderedError))
    return 'a missing dot must have a NaN rendered error'
  return null
}

export function summarizeAccuracy(
  cases: readonly AccuracyCase[],
  dpr: number,
  toleranceDevicePx = ACCURACY_TOLERANCE_DEVICE_PX,
): AccuracyReport {
  const probes = cases.flatMap((c) => c.probes)
  if (cases.length === 0 || probes.length === 0)
    return { status: 'infrastructure_error', reason: 'no_cases', detail: 'nothing was measured' }
  if (!(Number.isFinite(dpr) && dpr > 0))
    return {
      status: 'infrastructure_error',
      reason: 'invalid_dpr',
      detail: `device pixel ratio ${dpr}`,
    }
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
  const measurable = probes.filter((p) => p.measurable)
  const skipped = probes.filter((p) => !p.measurable)
  if (measurable.length === 0)
    return {
      status: 'infrastructure_error',
      reason: 'no_measurable_probes',
      detail: `all ${probes.length} probes are outside the CRS world or within its edge margin`,
    }
  const found = measurable.filter((p) => p.rendered !== null)
  const max = (v: number[]) => (v.length ? Math.max(...v) * dpr : NaN)
  const maxApiErrorDevicePx = max(measurable.map((p) => p.apiError))
  const maxRenderedErrorDevicePx = max(found.map((p) => p.renderedError))
  const maxUnprojectErrorDevicePx = max(measurable.map((p) => p.unprojectError))
  const missingDots = measurable.length - found.length
  return {
    status: 'measured',
    errorUnit: ACCURACY_ERROR_UNIT,
    toleranceDevicePx,
    dpr,
    cases: cases.length,
    probes: probes.length,
    measurableProbes: measurable.length,
    notMeasurable: {
      count: skipped.length,
      outsideWorld: skipped.filter((p) => p.notMeasurableReason === 'outside_world').length,
      edgeMargin: skipped.filter((p) => p.notMeasurableReason === 'edge_margin').length,
    },
    missingDots,
    maxApiErrorDevicePx,
    maxRenderedErrorDevicePx,
    maxUnprojectErrorDevicePx,
    withinTolerance:
      missingDots === 0 &&
      maxApiErrorDevicePx <= toleranceDevicePx &&
      maxRenderedErrorDevicePx <= toleranceDevicePx &&
      maxUnprojectErrorDevicePx <= toleranceDevicePx,
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
