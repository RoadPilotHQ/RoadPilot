/**
 * B1.2 F5: accuracy evaluation separates infrastructure errors from rendering results.
 * B1.5.5: errors in device pixels; `not_measurable` probes are counted, never measured or passed.
 */
import { describe, expect, it } from 'vitest'
import {
  ACCURACY_ERROR_UNIT,
  ACCURACY_TOLERANCE_DEVICE_PX,
  checkProbeInfrastructure,
  summarizeAccuracy as summarize,
  type AccuracyCase,
  type ProbeResult,
} from '../accuracyReport'

/** DPR 1 unless a test says otherwise (CSS px = device px). */
const summarizeAccuracy = (cases: readonly AccuracyCase[], dpr = 1) => summarize(cases, dpr)

function probe(overrides: Partial<ProbeResult> = {}): ProbeResult {
  return {
    id: 'g0,0',
    measurable: true,
    notMeasurableReason: null,
    edgeDistancePx: 200,
    expected: { x: 490, y: 450 },
    api: { x: 490.01, y: 450 },
    apiError: 0.01,
    rendered: { x: 490.1, y: 450.05 },
    renderedError: Math.hypot(0.1, 0.05),
    unprojectError: 0.001,
    ...overrides,
  }
}

function makeCase(probes: ProbeResult[], constrained = false): AccuracyCase {
  return {
    center: { x: -100_000, z: -70_000 },
    actualCenter: { x: -100_000, z: -70_000 },
    zoom: 9,
    actualZoom: 9,
    size: { width: 980, height: 900 },
    constrained,
    probes,
  }
}

describe('probe infrastructure', () => {
  it('probe layer and source present: no error', () => {
    expect(
      checkProbeInfrastructure(['background', 'road-minor', 'probe'], ['roads', 'probes']),
    ).toBeNull()
  })

  it('probe layer missing: a structured infrastructure error, not missing dots', () => {
    const r = checkProbeInfrastructure(['background', 'road-minor'], ['roads', 'probes'])
    expect(r).toMatchObject({ status: 'infrastructure_error', reason: 'probe_layer_missing' })
  })

  it('probe source missing: a structured infrastructure error', () => {
    const r = checkProbeInfrastructure(['probe'], ['roads'])
    expect(r).toMatchObject({ status: 'infrastructure_error', reason: 'probe_source_missing' })
  })
})

describe('summarizeAccuracy', () => {
  it('a valid result within tolerance is the only pass', () => {
    const r = summarizeAccuracy([makeCase([probe(), probe({ id: 'g0.3,0' })])])
    expect(r.status).toBe('measured')
    if (r.status !== 'measured') return
    expect(r.withinTolerance).toBe(true)
    expect(r.errorUnit).toBe(ACCURACY_ERROR_UNIT)
    expect(r.toleranceDevicePx).toBe(ACCURACY_TOLERANCE_DEVICE_PX)
    expect(ACCURACY_TOLERANCE_DEVICE_PX).toBe(0.5)
    expect(r.cases).toBe(1)
    expect(r.probes).toBe(2)
    expect(r.measurableProbes).toBe(2)
    expect(r.notMeasurable).toEqual({ count: 0, outsideWorld: 0, edgeMargin: 0 })
    expect(r.missingDots).toBe(0)
    expect(r.maxRenderedErrorDevicePx).toBeCloseTo(Math.hypot(0.1, 0.05), 12)
  })

  it('an error above 0.5 px is measured and not within tolerance', () => {
    const r = summarizeAccuracy([
      makeCase([probe({ rendered: { x: 491, y: 450 }, renderedError: 1 })]),
    ])
    expect(r).toMatchObject({
      status: 'measured',
      withinTolerance: false,
      maxRenderedErrorDevicePx: 1,
    })
  })

  it('B1.5.5: errors are judged in device pixels (CSS error × DPR)', () => {
    // 0.4 CSS px is 0.6 device px at DPR 1.5: within 0.5 CSS px, but not within 0.5 device px.
    const p = probe({ renderedError: 0.4 })
    expect(summarizeAccuracy([makeCase([p])], 1)).toMatchObject({ withinTolerance: true })
    const hi = summarizeAccuracy([makeCase([p])], 1.5)
    expect(hi).toMatchObject({ status: 'measured', dpr: 1.5, withinTolerance: false })
    expect(hi.status === 'measured' && hi.maxRenderedErrorDevicePx).toBeCloseTo(0.6, 12)
    // 0.333 CSS px at DPR 1.5 is 0.4995 device px: within.
    expect(summarizeAccuracy([makeCase([probe({ renderedError: 0.333 })])], 1.5)).toMatchObject({
      withinTolerance: true,
    })
  })

  it('B1.5.5: an invalid DPR is an infrastructure error', () => {
    for (const dpr of [0, -1, NaN, Infinity])
      expect(summarizeAccuracy([makeCase([probe()])], dpr)).toMatchObject({
        status: 'infrastructure_error',
        reason: 'invalid_dpr',
      })
  })

  it('B1.5.5: not measurable probes are counted, excluded from the maxima and never measured', () => {
    const outside = probe({
      id: 'g-0.3,0',
      measurable: false,
      notMeasurableReason: 'outside_world',
      edgeDistancePx: -75,
      rendered: null,
      renderedError: NaN,
      apiError: 9, // never reaches a maximum
    })
    const edge = probe({
      id: 'g0,0.3',
      measurable: false,
      notMeasurableReason: 'edge_margin',
      edgeDistancePx: 7.6,
      rendered: null,
      renderedError: NaN,
    })
    const r = summarizeAccuracy([makeCase([probe(), outside, edge])])
    expect(r).toMatchObject({
      status: 'measured',
      probes: 3,
      measurableProbes: 1,
      notMeasurable: { count: 2, outsideWorld: 1, edgeMargin: 1 },
      missingDots: 0,
      maxApiErrorDevicePx: 0.01,
      withinTolerance: true,
    })
  })

  it('B1.5.5: only not measurable probes is an infrastructure error, never a pass', () => {
    const r = summarizeAccuracy([
      makeCase([
        probe({
          measurable: false,
          notMeasurableReason: 'outside_world',
          edgeDistancePx: -5,
          rendered: null,
          renderedError: NaN,
        }),
      ]),
    ])
    expect(r).toMatchObject({ status: 'infrastructure_error', reason: 'no_measurable_probes' })
  })

  it('B1.5.5: a measurable dot that is missing still fails next to skipped probes', () => {
    const r = summarizeAccuracy([
      makeCase([
        probe({ rendered: null, renderedError: NaN }),
        probe({
          id: 'x',
          measurable: false,
          notMeasurableReason: 'outside_world',
          edgeDistancePx: -1,
          rendered: null,
          renderedError: NaN,
        }),
      ]),
    ])
    expect(r).toMatchObject({ status: 'measured', missingDots: 1, withinTolerance: false })
  })

  it('exactly 0.5 px is within tolerance (≤), 0.5000001 is not', () => {
    const at = summarizeAccuracy([makeCase([probe({ renderedError: 0.5 })])])
    const over = summarizeAccuracy([makeCase([probe({ renderedError: 0.5000001 })])])
    expect(at).toMatchObject({ withinTolerance: true })
    expect(over).toMatchObject({ withinTolerance: false })
  })

  it('a dot not found with the probe layer present is a rendering observation, never a pass', () => {
    const r = summarizeAccuracy([
      makeCase([probe(), probe({ id: 'g0.3,0.3', rendered: null, renderedError: NaN })]),
    ])
    expect(r).toMatchObject({ status: 'measured', missingDots: 1, withinTolerance: false })
  })

  it('no dot found at all: measured, NaN rendered error, not within tolerance', () => {
    const r = summarizeAccuracy([makeCase([probe({ rendered: null, renderedError: NaN })])])
    expect(r.status).toBe('measured')
    if (r.status !== 'measured') return
    expect(r.withinTolerance).toBe(false)
    expect(Number.isNaN(r.maxRenderedErrorDevicePx)).toBe(true)
  })

  it('an API error above tolerance fails even when the pixels are right', () => {
    const r = summarizeAccuracy([makeCase([probe({ apiError: 2, api: { x: 492, y: 450 } })])])
    expect(r).toMatchObject({ withinTolerance: false })
  })

  it('invalid probe results are infrastructure errors', () => {
    const invalid: Partial<ProbeResult>[] = [
      { expected: { x: NaN, y: 450 } },
      { api: { x: Infinity, y: 0 }, apiError: Infinity },
      { unprojectError: NaN },
      { rendered: { x: NaN, y: 1 } },
      { rendered: null, renderedError: 0.1 },
      // B1.5.5: measurability must be present and consistent; a skipped probe is never measured.
      { measurable: undefined as unknown as boolean },
      { measurable: false, notMeasurableReason: null },
      { measurable: true, notMeasurableReason: 'outside_world' },
      { edgeDistancePx: NaN },
      { measurable: false, notMeasurableReason: 'edge_margin' }, // still has a rendered centroid
    ]
    for (const o of invalid) {
      const r = summarizeAccuracy([makeCase([probe(o)])])
      expect(r).toMatchObject({ status: 'infrastructure_error', reason: 'invalid_probe_result' })
    }
  })

  it('nothing measured is an infrastructure error, never a pass', () => {
    expect(summarizeAccuracy([])).toMatchObject({
      status: 'infrastructure_error',
      reason: 'no_cases',
    })
    expect(summarizeAccuracy([makeCase([])])).toMatchObject({
      status: 'infrastructure_error',
      reason: 'no_cases',
    })
  })

  it('reports cases whose camera MapLibre constrained', () => {
    const r = summarizeAccuracy([makeCase([probe()], true), makeCase([probe()])])
    expect(r.status === 'measured' && r.constrainedCases.length).toBe(1)
  })
})
