/**
 * B1.5.4G: the harness's explicit negative-control mode (tools/maplibre-validation/
 * negativecontrol.mjs, report.mjs `evaluateNegativeControl`, run.mjs wiring). Pure: nothing here
 * starts RoadPilot, a browser, Vite or any process.
 */
import { describe, expect, it } from 'vitest'
import {
  CONTROL_HOLD_MS,
  CONTROL_KIND,
  CONTROL_MODE,
  controlSessionName,
  NEGATIVE_CONTROL_FLAG,
  validateRunArgs,
} from '../../../../tools/maplibre-validation/negativecontrol.mjs'
import { PLACEHOLDER_MARKER } from '../../../../tools/maplibre-validation/placeholder.mjs'
import {
  buildReport,
  CONTAMINATION_REASONS,
  evaluateAppPageIsolation,
  evaluateNegativeControl,
  evaluateNetwork,
} from '../../../../tools/maplibre-validation/report.mjs'
import runSource from '../../../../tools/maplibre-validation/run.mjs?raw'

const origin = 'http://127.0.0.1:1420'
const page = (url: string, session = 'page') => ({ url, session })
const labRequests = [
  page(`${origin}/src/dev/mapLibreLab/index.html`),
  page(`${origin}/src/dev/mapLibreLab/main.ts`),
  page(`${origin}/node_modules/maplibre-gl/dist/maplibre-gl-worker.mjs`, 'w1'),
]
const ipc = ['telemetry_snapshot', 'control_status', 'map_status'].map((c) =>
  page(`http://ipc.localhost/${c}`),
)
const callbackWarnings = Array.from({ length: 10 }, () => ({
  type: 'warning',
  text: "[TAURI] Couldn't find callback id 1970318621. This might happen when the app is reloaded while Rust is running an asynchronous operation.",
}))

/** Isolation evidence as run.mjs records it in a control (no placeholder: marker null). */
const evidence = (o: Record<string, unknown> = {}) => ({
  expectedMarker: PLACEHOLDER_MARKER,
  pageOrigin: origin,
  navT: 1000,
  probe: {
    href: `${origin}/`,
    ready: 'complete',
    marker: null,
    scripts: 2,
    resources: [`${origin}/@vite/client`, `${origin}/src/app/main.tsx`, ...ipc.map((r) => r.url)],
  },
  requests: [...labRequests, ...ipc],
  console: callbackWarnings,
  ...o,
})
/** A negative-control result as run.mjs saves it (`negative-control-<tag>.json`). */
const controlResult = (o: Record<string, unknown> = {}) => ({
  tag: 'amd',
  control: {
    kind: CONTROL_KIND,
    placeholder: false,
    waitForAppRender: true,
    holdMs: CONTROL_HOLD_MS,
  },
  env: {},
  failedSteps: [],
  appRender: { rendered: true, ms: 900, rootChildren: 1 },
  appPageIsolation: evidence(),
  network: { requests: labRequests, pageOrigin: origin, cspViolations: [], maplibreRequests: [] },
  ...o,
})
/** The same evidence with nothing from the app page. */
const clean = () =>
  evidence({
    probe: { href: `${origin}/`, ready: 'complete', marker: null, scripts: 0, resources: [] },
    requests: labRequests,
    console: [],
  })

describe('negative-control command line (B1.5.4G)', () => {
  it('accepts exactly `control --negative-control`, with session, GPU and confirmation options', () => {
    expect(validateRunArgs(CONTROL_MODE, [CONTROL_MODE, NEGATIVE_CONTROL_FLAG])).toEqual({
      ok: true,
      negativeControl: true,
    })
    expect(
      validateRunArgs('control', [
        'control',
        '--negative-control',
        '--confirm-runtime',
        '--session=b154f-nc',
        '--nv',
        '--attempts=1',
      ]),
    ).toEqual({ ok: true, negativeControl: true })
    expect(controlSessionName('20261125-170000')).toBe('negative-control-20261125-170000')
  })

  it('leaves the default modes unchanged', () => {
    for (const mode of ['functional', 'perf', 'cycles', 'report'])
      expect(validateRunArgs(mode, [mode, '--confirm-runtime', '--kinds=m3'])).toEqual({
        ok: true,
        negativeControl: false,
      })
  })

  it.each([
    ['functional (labels)', ['functional', '--negative-control']],
    ['perf', ['perf', '--negative-control']],
    ['cycles (memory)', ['cycles', '--negative-control']],
    ['report', ['report', '--negative-control']],
    ['no mode', ['--negative-control']],
  ])('refuses the flag with %s before anything starts', (_name, args) => {
    const r = validateRunArgs(args[0]?.startsWith('--') ? undefined : args[0], args)
    expect(r.ok).toBe(false)
    expect(r.ok === false && r.error).toMatch(/only allowed with mode "control"/)
  })

  it.each([
    ['--kinds=maplibre'],
    ['--only=urban'],
    ['--runs=3'],
    ['--kind=maplibre'],
    ['--out=elsewhere'],
    ['--attempts=2'],
  ])('refuses measurement or retry option %s with the flag', (opt) => {
    const r = validateRunArgs('control', ['control', '--negative-control', opt])
    expect(r.ok).toBe(false)
  })

  it('mode `control` alone (without the explicit flag) is refused', () => {
    const r = validateRunArgs('control', ['control', '--confirm-runtime'])
    expect(r).toMatchObject({ ok: false })
    expect(r.ok === false && r.error).toMatch(/explicit --negative-control/)
  })
})

describe('evaluateNegativeControl (B1.5.4G)', () => {
  it('contamination after a confirmed render is detected, and the control is still INVALID', () => {
    const e = evaluateNegativeControl(controlResult())
    expect(e).toMatchObject({
      verdict: 'INVALID',
      control: true,
      outcome: 'detected',
      reason: 'contamination_detected',
    })
    expect(e.contamination).toEqual(
      expect.arrayContaining(['ipc_requests', 'app_resources_in_app_page', 'callback_warnings']),
    )
    expect(e.isolation).toMatchObject({ verdict: 'INVALID' })
  })

  it('IPC in the probe alone (requests missed before the instrumentation) is still detected', () => {
    const e = evaluateNegativeControl(
      controlResult({ appPageIsolation: evidence({ requests: labRequests, console: [] }) }),
    )
    expect(e.outcome).toBe('detected')
  })

  it.each([
    ['no record', undefined, 'no_control_record'],
    ['not a control', { tag: 'amd', failedSteps: [] }, 'no_control_record'],
    [
      'placeholder was active',
      controlResult({ control: { kind: CONTROL_KIND, placeholder: true } }),
      'control_was_isolated',
    ],
    ['no step list', controlResult({ failedSteps: undefined }), 'incomplete_control_record'],
    [
      'lab never opened',
      controlResult({
        failedSteps: [{ name: 'openLab', stage: 'appNavigation', error: 'did not render' }],
      }),
      'control_lab_not_opened',
    ],
    ['render not confirmed', controlResult({ appRender: null }), 'app_render_not_confirmed'],
    [
      'render failed',
      controlResult({ appRender: { rendered: false, ms: 30000 } }),
      'app_render_not_confirmed',
    ],
    [
      'isolation evidence missing',
      controlResult({ appPageIsolation: null }),
      'control_evidence_incomplete',
    ],
    [
      'isolation evidence incomplete',
      controlResult({ appPageIsolation: evidence({ requests: undefined }) }),
      'control_evidence_incomplete',
    ],
    [
      'clean (race not reproduced)',
      controlResult({ appPageIsolation: clean() }),
      'contamination_not_reproduced',
    ],
  ])('%s: inconclusive and INVALID, never a proof', (_name, input, reason) => {
    expect(evaluateNegativeControl(input)).toMatchObject({
      verdict: 'INVALID',
      control: true,
      outcome: 'inconclusive',
      reason,
    })
  })

  it('a clean control is inconclusive although its isolation is INVALID (missing marker only)', () => {
    const e = evaluateNegativeControl(controlResult({ appPageIsolation: clean() }))
    expect(e.isolation).toMatchObject({ verdict: 'INVALID', reason: 'placeholder_not_confirmed' })
    expect(CONTAMINATION_REASONS).not.toContain('placeholder_not_confirmed')
  })
})

describe('a control never counts as a measurement (B1.5.4G)', () => {
  it('the report of a control is INVALID overall and marked as a control', () => {
    const lifecycle = { label: 'negative-control-amd', stages: [] }
    for (const result of [controlResult(), controlResult({ appPageIsolation: clean() })]) {
      const r = buildReport({ negativeControl: result, lifecycle })
      expect(r.control).toBe(true)
      expect(r.criteria.negativeControl!.verdict).toBe('INVALID')
      expect(r.criteria.appPageIsolation!.verdict).toBe('INVALID')
      expect(r.overall).toBe('INVALID')
      expect(Object.values(r.criteria).some((c) => c.verdict === 'PASS' && c.control)).toBe(false)
    }
  })

  it('a control result passed as a measurement is flagged and cannot pass', () => {
    const r = buildReport({ functional: { ...controlResult(), steps: {} } })
    expect(r.criteria.controlSession).toMatchObject({
      verdict: 'INVALID',
      reason: 'negative_control_result_in_measurement',
    })
    expect(r.overall).not.toBe('PASS')
    const perf = buildReport({ perf: [{ kind: 'maplibre', scenario: 'urban', control: {} }] })
    expect(perf.criteria.controlSession!.verdict).toBe('INVALID')
  })

  it('reports without a control are unchanged (no control flag, no control criteria)', () => {
    const r = buildReport({})
    expect(r.control).toBeUndefined()
    expect(r.criteria.negativeControl).toBeUndefined()
    expect(r.criteria.controlSession).toBeUndefined()
  })

  it('appPageIsolation and network semantics are unchanged', () => {
    const isolated = evidence({
      probe: {
        href: `${origin}/`,
        ready: 'complete',
        marker: PLACEHOLDER_MARKER,
        scripts: 0,
        resources: [],
      },
      requests: labRequests,
      console: [],
    })
    expect(evaluateAppPageIsolation(isolated)).toMatchObject({
      verdict: 'PASS',
      reason: 'isolated',
    })
    expect(evaluateAppPageIsolation(evidence()).verdict).toBe('INVALID')
    const net = { requests: [...labRequests, ...ipc], pageOrigin: origin, cspViolations: [] }
    expect(evaluateNetwork({ ...net, maplibreRequests: [] })).toMatchObject({
      verdict: 'PASS',
      reason: 'offline',
    })
  })
})

describe('run.mjs wiring (B1.5.4G)', () => {
  it('checks the command line before anything else and refuses with exit code 2', () => {
    expect(runSource).toMatch(/const ARGS_CHECK = validateRunArgs\(mode, args\)/)
    const refuse = runSource.indexOf('if (!ARGS_CHECK.ok)')
    expect(refuse).toBeGreaterThan(0)
    // The refusal is the first branch of the dispatch, before report and every session.
    expect(runSource.indexOf("else if (mode === 'report') report()")).toBeGreaterThan(refuse)
    expect(runSource.indexOf('if (CONFIRMED) await session(mode)')).toBeGreaterThan(refuse)
    expect(runSource).toMatch(/REFUSED: \$\{ARGS_CHECK\.error\}\. Nothing was started\./)
  })

  it('default runs keep the placeholder and the marker check; only a control drops both', () => {
    expect(runSource).toMatch(/placeholder: !NEGATIVE_CONTROL,/)
    expect(runSource).toMatch(
      /\.\.\.\(NEGATIVE_CONTROL\s*\?\s*\{ negativeControl: true \}\s*:\s*\{ appPlaceholderMarker: PLACEHOLDER_MARKER \}\)/,
    )
    expect(runSource).toMatch(
      /const NEGATIVE_CONTROL = ARGS_CHECK\.ok && ARGS_CHECK\.negativeControl/,
    )
  })

  it('a control has its own files, its own new folder, collects evidence and runs no measurement', () => {
    expect(runSource).toMatch(
      /\[CONTROL_MODE\]: \{ run: negativeControl, files: \(\) => \[`\$\{CONTROL_KIND\}-\$\{TAG\}\.json`\] \}/,
    )
    expect(runSource).toMatch(/name === CONTROL_MODE \? CONTROL_KIND : name/)
    expect(runSource).toMatch(/negative control needs a new, empty session folder/)
    const body = runSource.slice(
      runSource.indexOf('async function negativeControl()'),
      runSource.indexOf('// ---------------------------------------------------------------- perf'),
    )
    expect(body).toMatch(/res\.appPageIsolation = isolationInput\(opened\)/)
    expect(body).toMatch(/res\.network = networkInput\(/)
    expect(body).toMatch(/res\.console = inst\.log\.console/)
    expect(body).toMatch(/placeholder: false/)
    expect(body).not.toMatch(/accuracy\(|labelStats|L\.run\(|startSampler|shot\(|heaps\(/)
    expect(runSource).toMatch(/process\.exitCode = 4/)
  })
})
