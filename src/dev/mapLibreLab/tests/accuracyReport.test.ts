/** B1.2 F5: accuracy evaluation separates infrastructure errors from rendering results. */
import { describe, expect, it } from 'vitest'
import {
  ACCURACY_TOLERANCE_PX,
  checkProbeInfrastructure,
  summarizeAccuracy,
  type AccuracyCase,
  type ProbeResult,
} from '../accuracyReport'

function probe(overrides: Partial<ProbeResult> = {}): ProbeResult {
  return {
    id: 'g0,0',
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
    expect(r.tolerancePx).toBe(ACCURACY_TOLERANCE_PX)
    expect(r.cases).toBe(1)
    expect(r.probes).toBe(2)
    expect(r.missingDots).toBe(0)
    expect(r.maxRenderedError).toBeCloseTo(Math.hypot(0.1, 0.05), 12)
  })

  it('an error above 0.5 px is measured and not within tolerance', () => {
    const r = summarizeAccuracy([
      makeCase([probe({ rendered: { x: 491, y: 450 }, renderedError: 1 })]),
    ])
    expect(r).toMatchObject({ status: 'measured', withinTolerance: false, maxRenderedError: 1 })
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
    expect(Number.isNaN(r.maxRenderedError)).toBe(true)
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
