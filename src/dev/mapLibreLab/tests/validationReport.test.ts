/** B1.4: the validation harness's pure evaluation (tools/maplibre-validation/report.mjs). */
import { describe, expect, it } from 'vitest'
import {
  ACCURACY_TOLERANCE_PX,
  aggregatePerf,
  buildReport,
  CALLBACK_WARNING,
  combine,
  evaluateAccuracy,
  evaluateAppPageIsolation,
  evaluateContextLoss,
  evaluateMemoryCycles,
  evaluateNetwork,
  evaluatePerfRun,
  evaluateRelease,
  evaluateWorkerProjection,
  MEMORY,
  MIN_RUNS,
  THRESHOLDS,
  worstProbe,
} from '../../../../tools/maplibre-validation/report.mjs'
import { PLACEHOLDER_MARKER } from '../../../../tools/maplibre-validation/placeholder.mjs'

import gitignore from '../../../../tools/maplibre-validation/.gitignore?raw'

/** The harness files (`*` does not match dotfiles; `.gitignore` is imported separately). */
const harness: Record<string, string> = {
  ...import.meta.glob<string>('/tools/maplibre-validation/*', {
    query: '?raw',
    import: 'default',
    eager: true,
  }),
  '/tools/maplibre-validation/.gitignore': gitignore,
}

describe('thresholds are the B1 brief values, unchanged', () => {
  it('100k and 1M targets, 0.5 px, three runs', () => {
    expect(THRESHOLDS.urban).toEqual({
      segments: 100_000,
      firstVisibleMs: 100,
      gapP95Ms: 20,
      gapMaxMs: 50,
    })
    expect(THRESHOLDS.stress).toEqual({
      segments: 1_000_000,
      firstVisibleMs: 500,
      gapP95Ms: 33,
      gapMaxMs: 75,
    })
    expect(ACCURACY_TOLERANCE_PX).toBe(0.5)
    expect(MIN_RUNS).toBe(3)
    expect(MEMORY).toEqual({ status: 'provisional', cycles: 8, steadyFrom: 5, growthLimit: 0.05 })
    expect(Object.isFrozen(THRESHOLDS.urban)).toBe(true)
  })

  it('combine: FAIL before INVALID before NOT_TESTED; PASS only when all pass', () => {
    expect(combine([])).toBe('NOT_TESTED')
    expect(combine(['PASS', 'PASS'])).toBe('PASS')
    expect(combine(['PASS', 'NOT_TESTED'])).toBe('NOT_TESTED')
    expect(combine(['PASS', 'INVALID', 'NOT_TESTED'])).toBe('INVALID')
    expect(combine(['INVALID', 'FAIL'])).toBe('FAIL')
  })
})

// ---------------------------------------------------------------- accuracy

const measured = (o: Record<string, unknown> = {}) => ({
  status: 'measured',
  tolerancePx: 0.5,
  cases: 35,
  probes: 315,
  missingDots: 0,
  maxApiError: 0.01,
  maxRenderedError: 0.2,
  maxUnprojectError: 0.001,
  withinTolerance: true,
  constrainedCases: [],
  ...o,
})

describe('evaluateAccuracy (B1.2 result format)', () => {
  it('a valid result within tolerance passes', () => {
    expect(evaluateAccuracy(measured())).toMatchObject({
      verdict: 'PASS',
      reason: 'within_tolerance',
    })
  })

  it('missing probe infrastructure is an invalid run, not a rendering failure', () => {
    const r = evaluateAccuracy({
      status: 'infrastructure_error',
      reason: 'probe_layer_missing',
      detail: 'x',
    })
    expect(r).toMatchObject({
      verdict: 'INVALID',
      reason: 'infrastructure_error:probe_layer_missing',
    })
  })

  it('missing dots and errors above 0.5 px fail', () => {
    expect(evaluateAccuracy(measured({ missingDots: 2, withinTolerance: false }))).toMatchObject({
      verdict: 'FAIL',
      reason: 'missing_dots',
    })
    expect(
      evaluateAccuracy(measured({ maxRenderedError: 0.51, withinTolerance: false })),
    ).toMatchObject({ verdict: 'FAIL', reason: 'error_above_tolerance' })
  })

  it('no result, unknown status, malformed, relaxed tolerance or inconsistent flags are invalid', () => {
    for (const bad of [
      undefined,
      null,
      [],
      { status: 'ok' },
      measured({ cases: 0 }),
      measured({ missingDots: -1 }),
      measured({ tolerancePx: 0.6 }),
      measured({ withinTolerance: 'yes' }),
      measured({ maxRenderedError: 2 }), // flag says within tolerance, the numbers do not
      measured({ maxApiError: NaN }),
    ])
      expect(evaluateAccuracy(bad).verdict, JSON.stringify(bad)).toBe('INVALID')
  })

  it('worstProbe never assumes `results` exists', () => {
    expect(worstProbe(undefined)).toBeNull()
    expect(worstProbe({ status: 'infrastructure_error' })).toBeNull()
    expect(worstProbe({ results: 'x' })).toBeNull()
    const w = worstProbe({
      results: [
        {
          zoom: 3,
          probes: [
            { id: 'a', renderedError: 0.1 },
            { id: 'b', renderedError: NaN },
          ],
        },
        { zoom: 9, probes: [{ id: 'c', renderedError: 0.3 }] },
        { zoom: 11 },
      ],
    })
    expect(w).toMatchObject({ id: 'c', zoom: 9 })
  })
})

// ---------------------------------------------------------------- network

const origin = 'http://127.0.0.1:1420'
const page = (url: string, session = 'page') => ({ url, session })
const labRequests = [
  page(`${origin}/src/dev/mapLibreLab/index.html`),
  page(`${origin}/src/dev/mapLibreLab/main.ts`),
  page(`${origin}/node_modules/maplibre-gl/dist/maplibre-gl-worker.mjs`, 'w1'),
  page('ws://127.0.0.1:1420/?token=x'),
  page('data:image/svg+xml,abc'),
]
const net = (o: Record<string, unknown> = {}) => ({
  requests: labRequests,
  pageOrigin: origin,
  cspViolations: [],
  maplibreRequests: [],
  ...o,
})

describe('evaluateNetwork', () => {
  it('only dev-server, data and IPC requests: offline', () => {
    const r = evaluateNetwork(net({ requests: [...labRequests, page('http://ipc.localhost/x')] }))
    expect(r).toMatchObject({ verdict: 'PASS', metrics: { workerRequests: 1, external: [] } })
  })

  it('any external request fails, from the page, a worker or MapLibre', () => {
    expect(
      evaluateNetwork(
        net({ requests: [...labRequests, page('https://tiles.example/0.pbf', 'w2')] }),
      ),
    ).toMatchObject({ verdict: 'FAIL', reason: 'external_requests' })
    expect(
      evaluateNetwork(net({ maplibreRequests: [{ url: 'https://fonts.example/a.pbf' }] })),
    ).toMatchObject({
      verdict: 'FAIL',
    })
    expect(
      evaluateNetwork(net({ requests: [...labRequests, page('http://127.0.0.1:9999/x')] })),
    ).toMatchObject({
      verdict: 'FAIL',
    })
  })

  it('a CSP violation fails', () => {
    expect(evaluateNetwork(net({ cspViolations: [{ blocked: 'blob' }] }))).toMatchObject({
      verdict: 'FAIL',
      reason: 'csp_violations',
    })
  })

  it('an empty or broken log can never pass', () => {
    expect(evaluateNetwork(undefined).verdict).toBe('INVALID')
    expect(evaluateNetwork(net({ requests: [] }))).toMatchObject({
      verdict: 'INVALID',
      reason: 'instrumentation_saw_no_lab_request',
    })
    expect(evaluateNetwork(net({ cspViolations: null }))).toMatchObject({
      verdict: 'INVALID',
      reason: 'no_csp_log',
    })
  })
})

// ---------------------------------------------------------------- context loss, release

describe('evaluateContextLoss and evaluateRelease', () => {
  it('context loss', () => {
    const ok = { lostMs: 3, restoreMs: 20, pixelsBefore: 5000, pixelsAfter: 4990, errors: [] }
    expect(evaluateContextLoss(ok).verdict).toBe('PASS')
    expect(evaluateContextLoss({ ...ok, pixelsAfter: 0 })).toMatchObject({
      verdict: 'FAIL',
      reason: 'blank_after_restore',
    })
    expect(evaluateContextLoss({ ...ok, errors: ['x'] }).verdict).toBe('FAIL')
    expect(evaluateContextLoss({ ...ok, pixelsBefore: 0 }).verdict).toBe('INVALID')
    expect(evaluateContextLoss(undefined).verdict).toBe('INVALID')
  })

  it('release and remount', () => {
    const ok = {
      release: { canvases: 0 },
      afterRelease: { listeners: 0, pendingWaits: 0 },
      remount: { canvases: 1 },
    }
    expect(evaluateRelease(ok).verdict).toBe('PASS')
    expect(
      evaluateRelease({ ...ok, afterRelease: { listeners: 2, pendingWaits: 0 } }).verdict,
    ).toBe('FAIL')
    expect(evaluateRelease({ ...ok, release: { canvases: 1 } }).verdict).toBe('FAIL')
    expect(evaluateRelease({ ...ok, remount: { canvases: 2 } }).verdict).toBe('FAIL')
    expect(evaluateRelease({ ...ok, afterRelease: {} }).verdict).toBe('INVALID')
    expect(evaluateRelease(undefined).verdict).toBe('INVALID')
  })
})

// ---------------------------------------------------------------- performance

const phase = (p95: number, max: number, o: Record<string, unknown> = {}) => ({
  frames: 300,
  p95,
  max,
  fps: 120,
  glError: 0,
  settleMs: 40,
  ...o,
})
/** B1.5.1: a MapLibre load verified the worker projection handler before `setData`. */
const verifiedProjection = { verified: true, generation: 1, workers: 1, recreatedDuringLoad: false }
const perfRun = (o: Record<string, unknown> = {}) => ({
  kind: 'maplibre',
  scenario: 'urban',
  datasetSegments: 100_000,
  warm: { firstMs: 60 },
  pan: phase(12, 30),
  zoom: [phase(15, 40), phase(16, 41), phase(14, 39)],
  ...o,
  // `cold` overrides are merged so that runs keep their verified projection; `null` stays null.
  cold:
    o.cold === null
      ? null
      : {
          firstMs: 80,
          firstRoadPixels: 1200,
          completeMs: 150,
          workerProjection: verifiedProjection,
          ...(o.cold as Record<string, unknown> | undefined),
        },
})

describe('evaluatePerfRun', () => {
  it('a run inside every 100k target passes; the boundary values pass (≤)', () => {
    expect(evaluatePerfRun(perfRun(), 'urban').verdict).toBe('PASS')
    const edge = perfRun({ cold: { firstMs: 100, firstRoadPixels: 1 }, pan: phase(20, 50) })
    expect(evaluatePerfRun(edge, 'urban').verdict).toBe('PASS')
  })

  it('each threshold fails on its own', () => {
    const cases: [Record<string, unknown>, string][] = [
      [{ cold: { firstMs: 100.1, firstRoadPixels: 9 } }, 'firstVisible'],
      [{ zoom: [phase(15, 40), phase(20.1, 41), phase(14, 39)] }, 'gapP95'],
      [{ pan: phase(12, 50.1) }, 'gapMax'],
    ]
    for (const [o, key] of cases) {
      const r = evaluatePerfRun(perfRun(o), 'urban')
      expect(r.verdict).toBe('FAIL')
      expect(r.checks?.[key]).toBe('FAIL')
    }
  })

  it('1M uses the 1M targets', () => {
    const run = perfRun({
      datasetSegments: 1_000_000,
      cold: { firstMs: 450, firstRoadPixels: 5 },
      pan: phase(30, 70),
    })
    expect(evaluatePerfRun(run, 'stress').verdict).toBe('PASS')
    expect(evaluatePerfRun(run, 'urban').verdict).toBe('INVALID') // wrong dataset for 100k
  })

  it('incomplete or failed runs are invalid, never a pass', () => {
    const bad: Record<string, unknown>[] = [
      { error: 'LoadTimeoutError: MapLibre style load did not finish' },
      { datasetSegments: 99_999 },
      { cold: null },
      { cold: { firstMs: 50, firstRoadPixels: 0 } }, // nothing classified as road
      { zoom: [phase(1, 2), phase(1, 2)] },
      { pan: phase(1, 2, { frames: 1 }) },
      { pan: phase(NaN, 2) },
    ]
    for (const o of bad)
      expect(evaluatePerfRun(perfRun(o), 'urban').verdict, JSON.stringify(o)).toBe('INVALID')
    expect(evaluatePerfRun(perfRun(), 'other').verdict).toBe('INVALID')
  })

  it('M3 must have drawn segments; a WebGL error fails', () => {
    const m3 = perfRun({ kind: 'm3', cold: { firstMs: 20, firstSegments: 293_468 } })
    expect(evaluatePerfRun(m3, 'urban').verdict).toBe('PASS')
    expect(
      evaluatePerfRun({ ...m3, cold: { firstMs: 20, firstSegments: 0 } }, 'urban').verdict,
    ).toBe('INVALID')
    expect(
      evaluatePerfRun(perfRun({ pan: phase(1, 2, { glError: 1282 }) }), 'urban'),
    ).toMatchObject({
      verdict: 'FAIL',
      reason: 'webgl_error',
    })
  })
})

describe('worker projection (B1.5.1, defect A)', () => {
  const warning = {
    type: 'warning',
    text: 'GeoJSON sources are drawn in the wrong place: no projection handler is set in the workers, see `setProjectionHandler` in the custom CRS guide.',
  }

  it('a MapLibre run without a verified handler, or with the MapLibre warning, is invalid', () => {
    const cases: [Record<string, unknown>, string][] = [
      [{ cold: { workerProjection: undefined } }, 'worker_projection_unverified'],
      [{ cold: { workerProjection: { verified: false } } }, 'worker_projection_unverified'],
      [
        { cold: { workerProjection: { ...verifiedProjection, recreatedDuringLoad: true } } },
        'workers_recreated_during_load',
      ],
      [{ warnings: [warning] }, 'worker_projection_warning'],
      [{ state: { workerProjection: { recreations: 1 } } }, 'workers_recreated'],
    ]
    for (const [o, reason] of cases)
      expect(evaluatePerfRun(perfRun(o), 'urban'), reason).toMatchObject({
        verdict: 'INVALID',
        reason,
      })
    // The B1.5 MapLibre run format (no workerProjection field) can no longer pass.
    expect(
      evaluatePerfRun(
        perfRun({ kind: 'maplibre-nolabels', cold: { workerProjection: null } }),
        'urban',
      ).verdict,
    ).toBe('INVALID')
  })

  it('M3 runs do not use MapLibre workers and need no handler', () => {
    const m3 = perfRun({
      kind: 'm3',
      cold: { firstMs: 20, firstSegments: 10, workerProjection: undefined },
    })
    expect(evaluatePerfRun(m3, 'urban').verdict).toBe('PASS')
  })

  it('functional state: verified passes; failure, missing state, recreation and the warning do not', () => {
    const ready = { state: 'ready', generation: 1, recreations: 0, keepAlive: true, attempts: [] }
    expect(evaluateWorkerProjection(ready, []).verdict).toBe('PASS')
    expect(evaluateWorkerProjection(ready, [warning])).toMatchObject({
      verdict: 'FAIL',
      reason: 'worker_warned_no_handler',
    })
    expect(evaluateWorkerProjection({ ...ready, state: 'failed' }, []).verdict).toBe('FAIL')
    expect(evaluateWorkerProjection(undefined, []).verdict).toBe('INVALID')
    expect(evaluateWorkerProjection({ ...ready, state: 'stale' }, []).reason).toBe(
      'not_ready:stale',
    )
    expect(evaluateWorkerProjection({ ...ready, recreations: 2 }, []).reason).toBe(
      'workers_recreated',
    )
    expect(evaluateWorkerProjection({ ...ready, keepAlive: false }, []).reason).toBe(
      'worker_pool_not_kept',
    )
  })
})

describe('aggregatePerf', () => {
  it('three passing runs pass; medians are diagnostic', () => {
    const r = aggregatePerf(
      [perfRun(), perfRun(), perfRun({ cold: { firstMs: 90, firstRoadPixels: 3 } })],
      'urban',
    )
    expect(r).toMatchObject({ verdict: 'PASS', runs: 3, invalidRuns: 0 })
    expect((r.medians as Record<string, number>).firstVisibleMs).toBe(80)
  })

  it('every run must pass: one failing run fails the criterion', () => {
    const r = aggregatePerf([perfRun(), perfRun(), perfRun({ pan: phase(12, 80) })], 'urban')
    expect(r).toMatchObject({ verdict: 'FAIL', checks: { gapMax: 'FAIL', firstVisible: 'PASS' } })
  })

  it('too few runs, or any invalid run, is invalid; no runs is not tested', () => {
    expect(aggregatePerf([perfRun(), perfRun()], 'urban')).toMatchObject({
      verdict: 'INVALID',
      reason: 'too_few_runs',
    })
    expect(
      aggregatePerf([perfRun(), perfRun(), perfRun(), perfRun({ error: 'x' })], 'urban'),
    ).toMatchObject({
      verdict: 'INVALID',
      reason: 'invalid_runs',
    })
    expect(aggregatePerf([], 'urban').verdict).toBe('NOT_TESTED')
  })
})

// ---------------------------------------------------------------- memory

const cycle = (total: number) => ({
  mem: { total, gpuProc: 300, renderer: 200, gpuDedicated: 100 },
  heap: { main: 20, workersTotal: 30 },
})

describe('evaluateMemoryCycles (provisional diagnostic threshold)', () => {
  it('steady over cycles 5–8 is within the provisional limit but never a PASS', () => {
    const cycles = [500, 520, 540, 560, 570, 572, 575, 580].map(cycle)
    expect(evaluateMemoryCycles({ cycles })).toMatchObject({
      verdict: 'NOT_TESTED',
      reason: 'provisional_threshold_not_approved',
      diagnostic: { threshold: 'provisional', verdict: 'within_provisional_limit', over: [] },
    })
  })

  it('more than 5 % growth from cycle 5 to 8 is flagged as a diagnostic, not a FAIL', () => {
    const cycles = [500, 500, 500, 500, 500, 510, 520, 530].map(cycle)
    const e = evaluateMemoryCycles({ cycles })
    expect(e).toMatchObject({
      verdict: 'NOT_TESTED',
      diagnostic: { verdict: 'above_provisional_limit', over: ['total'] },
    })
    expect((e.diagnostic as { growth: { total: number } }).growth.total).toBeCloseTo(0.06)
  })

  it('a steady memory series cannot turn a report into PASS', () => {
    const cycles = [500, 500, 500, 500, 500, 500, 500, 500].map(cycle)
    const r = buildReport({ cycles: [{ kind: 'maplibre', scenario: 'stress', cycles }] })
    expect(r.criteria['memory:maplibre:stress']!.verdict).toBe('NOT_TESTED')
    expect(r.memoryRule.status).toBe('provisional')
    expect(r.overall).not.toBe('PASS')
  })

  it('too few cycles or a missing series is invalid; none is not tested', () => {
    expect(evaluateMemoryCycles({ cycles: [1, 2, 3, 4, 5, 6, 7].map(cycle) }).verdict).toBe(
      'INVALID',
    )
    const broken = [500, 500, 500, 500, 500, 500, 500, 500].map(cycle)
    broken[7] = {
      mem: { total: 500, gpuProc: 300, renderer: 200, gpuDedicated: 100 },
      heap: {} as never,
    }
    expect(evaluateMemoryCycles({ cycles: broken }).verdict).toBe('INVALID')
    expect(evaluateMemoryCycles({ cycles: [], error: 'x' }).verdict).toBe('INVALID')
    expect(evaluateMemoryCycles(undefined).verdict).toBe('NOT_TESTED')
  })
})

// ---------------------------------------------------------------- whole report

describe('buildReport', () => {
  it('nothing collected: every criterion NOT_TESTED, overall NOT_TESTED', () => {
    const r = buildReport({})
    expect(r.overall).toBe('NOT_TESTED')
    expect(Object.values(r.criteria).every((c) => c.verdict === 'NOT_TESTED')).toBe(true)
  })

  it('a functional run with failed steps or a missing CSP log cannot pass', () => {
    const r = buildReport({
      functional: { steps: {}, failedSteps: [{ name: 'accuracyScs', error: 'x' }], network: net() },
    })
    expect(r.criteria.functionalSteps!.verdict).toBe('INVALID')
    expect(r.criteria.accuracyScs!.verdict).toBe('INVALID')
    expect(r.overall).not.toBe('PASS')
  })

  it('labels always need a visual review, so the overall verdict is never an automatic PASS', () => {
    const good = {
      steps: {
        accuracyScs: measured(),
        accuracyIdentity: measured(),
        accuracyScsDpr15: measured(),
        contextLoss: { pixelsBefore: 10, pixelsAfter: 10, errors: [] },
        releaseRemount: {
          release: { canvases: 0 },
          afterRelease: { listeners: 0, pendingWaits: 0 },
          remount: { canvases: 1 },
        },
        finalState: {
          workerProjection: {
            state: 'ready',
            generation: 1,
            recreations: 0,
            keepAlive: true,
            attempts: [],
          },
        },
      },
      failedSteps: [],
      network: net(),
      console: [],
    }
    const r = buildReport({ functional: good })
    expect(r.criteria.accuracyScs!.verdict).toBe('PASS')
    expect(r.criteria.network!.verdict).toBe('PASS')
    expect(r.criteria.workerProjection!.verdict).toBe('PASS')
    expect(r.criteria.labels!.verdict).toBe('NOT_TESTED')
    expect(r.overall).toBe('NOT_TESTED')
  })

  it('groups perf runs by renderer and scenario and checks every run offline', () => {
    const runs = [perfRun(), perfRun(), perfRun()].map((r) => ({ ...r, network: net() }))
    const m3 = [1, 2, 3].map(() => ({
      ...perfRun({ kind: 'm3', cold: { firstMs: 20, firstSegments: 10 } }),
      network: net({ requests: [] }),
    }))
    const r = buildReport({ perf: [...runs, ...m3] })
    expect(r.criteria['perf:maplibre:urban']!.verdict).toBe('PASS')
    expect(r.criteria['perf:m3:urban']!.verdict).toBe('PASS')
    expect(r.criteria['perf:maplibre:stress']!.verdict).toBe('NOT_TESTED')
    expect(r.criteria['network:perfRuns']!.verdict).toBe('INVALID') // m3 runs logged nothing
  })
})

// ---------------------------------------------------------------- harness sources

describe('harness sources', () => {
  const files = Object.keys(harness)

  it('the harness is stored in the repository with all its parts', () => {
    for (const f of [
      'run.mjs',
      'report.mjs',
      'report.d.mts',
      'openlab.mjs',
      'openlab.d.mts',
      'placeholder.mjs',
      'placeholder.d.mts',
      'cdp.mjs',
      'workerorder.mjs',
      'sampler.ps1',
      'README.md',
      '.gitignore',
    ])
      expect(files).toContain(`/tools/maplibre-validation/${f}`)
  })

  it('contains no machine-specific absolute path and no external host', () => {
    for (const f of files) {
      const text = harness[f]!
      expect(text, f).not.toMatch(/\b[A-Za-z]:[\\/]/)
      expect(text, f).not.toMatch(/[\\/]Users[\\/]/i)
      const hosts = [...text.matchAll(/(?:https?|wss?):\/\/([^/'"`\s:]+)/g)].map((m) => m[1])
      for (const h of hosts)
        expect(['127.0.0.1', 'ipc.localhost', 'tiles.example'], `${f}: ${h}`).toContain(h)
    }
  })

  it('never starts the app without explicit confirmation', () => {
    expect(harness['/tools/maplibre-validation/cdp.mjs']).toMatch(
      /if \(confirmed !== true\)\s*\n?\s*throw/,
    )
    const run = harness['/tools/maplibre-validation/run.mjs']!
    // B1.5.4B: a confirmed runtime mode runs as one session (own dev server, then the mode).
    expect(run).toMatch(/if \(CONFIRMED\) await session\(mode\)/)
    expect(run).toMatch(/\(\) => RUNTIME\[name\]\.run\(\)/)
    expect(run).toMatch(/confirmed: CONFIRMED/)
    expect(run).toContain('args.includes(`--${name}`)')
  })

  it('B1.5.1: opens the lab through the staged openlab.mjs and never overwrites results', () => {
    const run = harness['/tools/maplibre-validation/run.mjs']!
    expect(run).toContain("from './openlab.mjs'")
    expect(run).not.toContain('connectPage')
    expect(run).not.toContain("'lab page did not load'")
    // Raw results, screenshots and diagnostics are written with `wx` (fail instead of replace).
    expect(run.match(/flag: 'wx'/g)?.length).toBeGreaterThanOrEqual(5)
    expect(run).toMatch(/refuseExisting\(\[`functional-\$\{TAG\}\.json`\]\)/)
    expect(run).toMatch(/refuseExisting\(perfFiles\(\)\)/)
    expect(run).toMatch(/refuseExisting\(cyclesFiles\(\)\)/)
    // B1.5.4B: the session refuses every file it would write before it starts anything.
    expect(run).toMatch(
      /refuseExisting\(\[\.\.\.RUNTIME\[name\]\.files\(\), `session-lifecycle-\$\{label\}\.json`, logName\]\)/,
    )
    // New runs go into a session folder, never into the out/ root that holds the B1.5 evidence.
    expect(run).toMatch(/join\(HERE, 'out', SESSION\)/)
    expect(run).toContain('report needs --session=<name> or --out=<dir>')
    // A closed DevTools connection rejects pending commands.
    expect(harness['/tools/maplibre-validation/cdp.mjs']).toMatch(/ws\.onclose = /)
  })

  it('opens the lab page that exists in the repository', () => {
    expect(harness['/tools/maplibre-validation/run.mjs']).toContain(
      '/src/dev/mapLibreLab/index.html',
    )
    expect(harness['/tools/maplibre-validation/.gitignore']).toMatch(/^out\/$/m)
  })
})

// ---------------------------------------------------------------- app-page isolation (B1.5.4E)

/** The six IPC calls of the outgoing app page in B1.5.4C session 5 (src/app/main.tsx). */
const S5_IPC = [
  'plugin%3Aevent%7Clisten',
  'telemetry_snapshot',
  'plugin%3Aevent%7Clisten',
  'control_status',
  'plugin%3Aevent%7Clisten',
  'map_status',
].map((c) => page(`http://ipc.localhost/${c}`))
const s5Console = [
  ...Array.from({ length: 6 }, () => ({
    type: 'warning',
    text: 'IPC custom protocol failed, Tauri will now use the postMessage interface instead',
  })),
  ...Array.from({ length: 144 }, (_, i) => ({
    type: 'warning',
    text: `[TAURI] ${CALLBACK_WARNING} ${i < 6 ? 900 + i : 1970318621}. This might happen when the app is reloaded while Rust is running an asynchronous operation.`,
  })),
]
const probe = (o: Record<string, unknown> = {}) => ({
  href: `${origin}/`,
  ready: 'complete',
  marker: PLACEHOLDER_MARKER,
  scripts: 0,
  resources: [],
  ...o,
})
/** B1.5.4C session 1: clean (only Vite's messages and the favicon 404). */
const iso = (o: Record<string, unknown> = {}) => ({
  expectedMarker: PLACEHOLDER_MARKER,
  pageOrigin: origin,
  navT: 1000,
  probe: probe(),
  requests: labRequests,
  console: [
    { type: 'debug', text: '[vite] connected.' },
    { type: 'log-error', text: 'network: Failed to load resource: 404 (Not Found)' },
  ],
  ...o,
})
const s5 = () =>
  iso({ requests: [labRequests[0], ...S5_IPC, ...labRequests.slice(1)], console: s5Console })
const withRequests = (...extra: { url: string; session: string }[]) =>
  iso({ requests: [...labRequests, ...extra] })
const withResources = (...resources: string[]) => iso({ probe: probe({ resources }) })

describe('appPageIsolation (B1.5.4E)', () => {
  it('a clean session (s1-like) is isolated', () => {
    expect(evaluateAppPageIsolation(iso())).toMatchObject({
      verdict: 'PASS',
      reason: 'isolated',
      metrics: { marker: PLACEHOLDER_MARKER, callbackWarnings: 0, ipcRequests: { count: 0 } },
    })
  })

  it('an s5-like session (IPC calls and callback warnings) is INVALID', () => {
    const e = evaluateAppPageIsolation(s5())
    expect(e.verdict).toBe('INVALID')
    expect(e.reasons).toEqual(['ipc_requests', 'callback_warnings'])
    expect(e.metrics).toMatchObject({ callbackWarnings: 144, ipcRequests: { count: 6 } })
  })

  it('IPC requests without any console warning are INVALID (not console-dependent)', () => {
    const e = evaluateAppPageIsolation(withRequests(S5_IPC[1]!))
    expect(e).toMatchObject({ verdict: 'INVALID', reason: 'ipc_requests' })
    expect(e.metrics).toMatchObject({ callbackWarnings: 0 })
    expect(evaluateAppPageIsolation(withRequests(page('ipc://localhost/x'))).reason).toBe(
      'ipc_requests',
    )
  })

  it('app resources in the outgoing page resource list are INVALID', () => {
    expect(evaluateAppPageIsolation(withResources(`${origin}/src/app/main.tsx`))).toMatchObject({
      verdict: 'INVALID',
      reason: 'app_resources_in_app_page',
    })
    // The placeholder loads nothing: any same-origin resource there is foreign.
    expect(evaluateAppPageIsolation(withResources(`${origin}/@vite/client`)).reason).toBe(
      'app_resources_in_app_page',
    )
    expect(evaluateAppPageIsolation(withResources('http://ipc.localhost/map_status')).reason).toBe(
      'ipc_in_app_page_resources',
    )
  })

  it('app-only modules in the request log are INVALID; lab modules from shared folders are not', () => {
    for (const p of ['/src/app/main.tsx', '/src/backend/controlSource.ts'])
      expect(evaluateAppPageIsolation(withRequests(page(`${origin}${p}`))).reason).toBe(
        'app_resources_requested',
      )
    const shared = [
      '/src/state/x.ts',
      '/src/i18n/x.ts',
      '/src/ui/navigation/roadPainter.ts',
      '/src/domain/mapTile.ts',
    ].map((p) => page(`${origin}${p}`))
    expect(evaluateAppPageIsolation(withRequests(...shared)).verdict).toBe('PASS')
  })

  it('a missing or wrong placeholder marker is INVALID', () => {
    for (const marker of [null, 'other'])
      expect(evaluateAppPageIsolation(iso({ probe: probe({ marker }) })).reason).toBe(
        'placeholder_not_confirmed',
      )
  })

  it('the callback warning alone is INVALID too (corroborating signal)', () => {
    expect(evaluateAppPageIsolation(iso({ console: [s5Console[10]] }))).toMatchObject({
      verdict: 'INVALID',
      reason: 'callback_warnings',
    })
  })

  it.each([
    ['undefined', undefined, 'no_isolation_evidence'],
    ['null (lab never opened)', null, 'no_isolation_evidence'],
    [
      'no expected marker',
      iso({ expectedMarker: undefined }),
      'incomplete_evidence:expectedMarker',
    ],
    ['another expected marker', iso({ expectedMarker: 'x' }), 'incomplete_evidence:expectedMarker'],
    ['no page origin', iso({ pageOrigin: undefined }), 'incomplete_evidence:pageOrigin'],
    ['no request log', iso({ requests: undefined }), 'no_request_log'],
    ['no console log', iso({ console: undefined }), 'no_console_log'],
    ['no probe', iso({ probe: null }), 'no_app_probe'],
    ['no resource list', iso({ probe: probe({ resources: undefined }) }), 'no_resource_list'],
    ['no lab request', iso({ requests: [] }), 'instrumentation_saw_no_lab_request'],
  ])('missing or incomplete evidence (%s) is INVALID', (_name, input, reason) => {
    expect(evaluateAppPageIsolation(input)).toMatchObject({ verdict: 'INVALID', reason })
  })

  it('the network criterion is unchanged: RoadPilot IPC stays allowed there', () => {
    const requests = [labRequests[0], ...S5_IPC, ...labRequests.slice(1)]
    expect(evaluateNetwork(net({ requests }))).toMatchObject({ verdict: 'PASS', reason: 'offline' })
    const r = buildReport({
      functional: {
        steps: {},
        failedSteps: [],
        network: net({ requests }),
        appPageIsolation: s5(),
      },
    })
    expect(r.criteria.network!.verdict).toBe('PASS')
    expect(r.criteria.appPageIsolation).toMatchObject({
      verdict: 'INVALID',
      reason: 'ipc_requests',
    })
    expect(r.overall).not.toBe('PASS')
  })

  it('a contaminated perf run is INVALID; an isolated one is judged as before', () => {
    expect(evaluatePerfRun(perfRun({ appPageIsolation: iso() }), 'urban').verdict).toBe('PASS')
    expect(evaluatePerfRun(perfRun(), 'urban').verdict).toBe('PASS') // older results: unchanged
    expect(evaluatePerfRun(perfRun({ appPageIsolation: s5() }), 'urban')).toMatchObject({
      verdict: 'INVALID',
      reason: 'app_page_not_isolated',
      detail: 'ipc_requests',
    })
    expect(evaluatePerfRun(perfRun({ appPageIsolation: null }), 'urban').reason).toBe(
      'app_page_not_isolated',
    )
    const runs = [iso(), s5(), iso()].map((e) => perfRun({ appPageIsolation: e }))
    expect(aggregatePerf(runs, 'urban')).toMatchObject({
      verdict: 'INVALID',
      reason: 'invalid_runs',
      invalidRuns: 1,
    })
  })

  it('a contaminated cycles run is INVALID; an isolated one keeps its NOT_TESTED diagnostic', () => {
    const cycles = [500, 500, 500, 500, 500, 500, 500, 500].map(cycle)
    expect(evaluateMemoryCycles({ cycles, appPageIsolation: iso() })).toMatchObject({
      verdict: 'NOT_TESTED',
      reason: 'provisional_threshold_not_approved',
    })
    expect(evaluateMemoryCycles({ cycles, appPageIsolation: s5() })).toMatchObject({
      verdict: 'INVALID',
      reason: 'app_page_not_isolated',
    })
    const r = buildReport({
      cycles: [{ kind: 'maplibre', scenario: 'stress', cycles, appPageIsolation: s5() }],
    })
    expect(r.criteria['memory:maplibre:stress']!.verdict).toBe('INVALID')
    expect(r.criteria.appPageIsolation!.verdict).toBe('INVALID')
  })

  it('buildReport: per run over perf runs; a session run without evidence is INVALID; older results get no criterion', () => {
    const perf = [iso(), iso()].map((e) => perfRun({ appPageIsolation: e }))
    expect(buildReport({ perf }).criteria.appPageIsolation).toMatchObject({
      verdict: 'PASS',
      reason: 'per_run',
    })
    const mixed = buildReport({ perf: [...perf, perfRun({ appPageIsolation: s5() })] })
    expect(mixed.criteria.appPageIsolation!.verdict).toBe('INVALID')
    const functional = { steps: {}, failedSteps: [], network: net() }
    const lifecycle = { stages: [{ stage: 'preflight', verdict: 'PASS' }] }
    expect(buildReport({ functional, lifecycle }).criteria.appPageIsolation).toMatchObject({
      verdict: 'INVALID',
      reason: 'no_isolation_evidence',
    })
    expect(buildReport({ functional }).criteria.appPageIsolation).toBeUndefined()
    const isolated = { ...functional, appPageIsolation: iso() }
    expect(buildReport({ functional: isolated }).criteria.appPageIsolation!.verdict).toBe('PASS')
  })
})
