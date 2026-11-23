/**
 * B1.5.4B: one validation session start to cleanup (tools/maplibre-validation/lifecycle.mjs) and
 * its verdicts in report.mjs. Fakes only; nothing starts RoadPilot, Vite or a browser.
 */
import { describe, expect, it } from 'vitest'
import { DEFAULT_ATTEMPTS } from '../../../../tools/maplibre-validation/openlab.mjs'
import { runSession, SESSION_STAGES } from '../../../../tools/maplibre-validation/lifecycle.mjs'
import {
  buildReport,
  evaluateLifecycle,
  evaluateStartup,
} from '../../../../tools/maplibre-validation/report.mjs'

interface Options {
  preflightOk?: boolean
  preflightThrows?: boolean
  devFails?: boolean
  devCleanup?: { verdict: string; reason: string } | null
  bodyThrows?: boolean
  appLeft?: boolean
  stop?: { verdict: string; reason: string }
  saveThrows?: boolean
}

function harness(o: Options = {}) {
  const calls: string[] = []
  let t = 0
  const saved: { name: string; data: Record<string, unknown> }[] = []
  const deps = {
    preflight: async () => {
      calls.push('preflight')
      if (o.preflightThrows) throw new Error('DESKTOP BUSY: running: eurotrucks2')
      return { ok: o.preflightOk ?? true, checks: { roadpilot: 'not running' } }
    },
    startDevServer: async () => {
      calls.push('startDevServer')
      t += 1500
      if (o.devFails)
        throw Object.assign(new Error('dev server http: not reached within 15000 ms'), {
          name: 'DevServerError',
          stage: 'http',
          diagnosticsFile: 'out/devserver-failure-functional-amd.json',
          cleanup:
            o.devCleanup === undefined
              ? { verdict: 'PASS', reason: 'graceful', ms: 300 }
              : o.devCleanup,
          pid: 7001,
        })
      return {
        pid: 7001,
        origin: 'http://127.0.0.1:1420',
        stages: [],
        descendants: [],
        modules: { count: 120, passes: [] },
      }
    },
    stopDevServer: async () => {
      calls.push('stopDevServer')
      return { ms: 400, ...(o.stop ?? { verdict: 'PASS', reason: 'graceful' }) }
    },
    appProcesses: () => {
      calls.push('appProcesses')
      return o.appLeft ? { app: [4242], webview: [5000] } : { app: [], webview: [] }
    },
    save: (name: string, data: Record<string, unknown>) => {
      if (o.saveThrows) throw new Error('EEXIST')
      saved.push({ name, data })
      return `out/${name}.json`
    },
    now: () => t,
  }
  const body = async ({ server }: { server: { pid: number } }) => {
    calls.push(`body(server ${server.pid})`) // the app starts in here, after readiness
    if (o.bodyThrows) throw new Error('functional: lab state unreadable')
    return { functional: { steps: {}, failedSteps: [] } }
  }
  return { deps, body, calls, saved }
}

describe('validation session lifecycle', () => {
  it('runs every stage in order; the app (body) starts only after dev server readiness', async () => {
    const h = harness()
    const rec = await runSession(h.deps, { label: 'functional-amd' }, h.body)
    expect(h.calls).toEqual([
      'preflight',
      'startDevServer',
      'body(server 7001)',
      'appProcesses',
      'stopDevServer',
    ])
    expect(rec.stages.map((s) => [s.stage, s.verdict])).toEqual(
      SESSION_STAGES.map((s) => [s, 'PASS']),
    )
    expect(rec.verdict).toBe('PASS')
    expect(rec.devServer).toMatchObject({ pid: 7001, modules: { count: 120 } })
    expect(h.saved.map((s) => s.name)).toEqual(['session-lifecycle-functional-amd'])
    expect(rec.file).toBe('out/session-lifecycle-functional-amd.json')
  })

  it('a refused preflight blocks everything; nothing is started', async () => {
    for (const o of [{ preflightOk: false }, { preflightThrows: true }]) {
      const h = harness(o)
      const rec = await runSession(h.deps, { label: 'x' }, h.body)
      expect(h.calls).toEqual(['preflight'])
      expect(
        rec.stages.slice(1).every((s) => s.verdict === 'NOT_TESTED' && s.blockedBy === 'preflight'),
      ).toBe(true)
      expect(rec.verdict).toBe('INVALID')
    }
  })

  it('a failed dev server start blocks RoadPilot; its diagnostics and cleanup are kept', async () => {
    const h = harness({ devFails: true })
    const rec = await runSession(h.deps, { label: 'functional-amd' }, h.body)
    expect(h.calls).toEqual(['preflight', 'startDevServer'])
    const dev = rec.stages.find((s) => s.stage === 'devServer')!
    expect(dev).toMatchObject({
      verdict: 'FAIL',
      failedStage: 'http',
      diagnosticsFile: 'out/devserver-failure-functional-amd.json',
      pid: 7001,
    })
    expect(rec.stages.find((s) => s.stage === 'body')).toMatchObject({
      verdict: 'NOT_TESTED',
      blockedBy: 'devServer',
    })
    expect(rec.stages.find((s) => s.stage === 'stopDevServer')).toMatchObject({
      verdict: 'PASS',
      reason: 'graceful',
    })
    expect(rec.verdict).toBe('INVALID')
    expect(evaluateLifecycle(rec)).toMatchObject({
      verdict: 'INVALID',
      reason: 'stage_failed:devServer',
    })
  })

  it('a failed start whose own cleanup failed makes the session FAIL', async () => {
    const h = harness({
      devFails: true,
      devCleanup: { verdict: 'FAIL', reason: 'shutdown_timeout' },
    })
    const rec = await runSession(h.deps, { label: 'x' }, h.body)
    expect(rec.verdict).toBe('FAIL')
    expect(evaluateLifecycle(rec)).toMatchObject({ verdict: 'FAIL', reason: 'cleanup_failed' })
  })

  it('a failed body still closes everything: the dev server is stopped, the failure is kept', async () => {
    const h = harness({ bodyThrows: true })
    const rec = await runSession(h.deps, { label: 'x' }, h.body)
    expect(h.calls.slice(-2)).toEqual(['appProcesses', 'stopDevServer'])
    expect(rec.stages.find((s) => s.stage === 'body')).toMatchObject({
      verdict: 'FAIL',
      error: 'Error: functional: lab state unreadable',
    })
    expect(rec.verdict).toBe('INVALID')
  })

  it('RoadPilot still running after the body is a cleanup FAIL (not killed here)', async () => {
    const h = harness({ appLeft: true })
    const rec = await runSession(h.deps, { label: 'x' }, h.body)
    expect(rec.stages.find((s) => s.stage === 'appClosed')).toMatchObject({
      verdict: 'FAIL',
      processes: { app: [4242], webview: [5000] },
    })
    expect(rec.verdict).toBe('FAIL')
  })

  it('a dev server that does not stop gracefully is a cleanup FAIL', async () => {
    const h = harness({ stop: { verdict: 'FAIL', reason: 'shutdown_timeout' } })
    const rec = await runSession(h.deps, { label: 'x' }, h.body)
    expect(rec.stages.find((s) => s.stage === 'stopDevServer')).toMatchObject({
      verdict: 'FAIL',
      reason: 'shutdown_timeout',
    })
    expect(rec.verdict).toBe('FAIL')
  })

  it('nothing is retried: one start of everything per session', async () => {
    const h = harness({ devFails: true })
    await runSession(h.deps, { label: 'x' }, h.body)
    expect(h.calls.filter((c) => c === 'startDevServer')).toHaveLength(1)
    const h2 = harness({ bodyThrows: true })
    await runSession(h2.deps, { label: 'x' }, h2.body)
    expect(h2.calls.filter((c) => c.startsWith('body'))).toHaveLength(1)
  })

  it('a session record that cannot be saved (would overwrite) is reported, not swallowed', async () => {
    const h = harness({ saveThrows: true })
    const rec = await runSession(h.deps, { label: 'x' }, h.body)
    expect(rec.saveError).toContain('EEXIST')
  })
})

describe('startup verdicts: no retry hides a failure', () => {
  it('the lab opening defaults to one attempt', () => {
    expect(DEFAULT_ATTEMPTS).toBe(1)
  })

  it('first attempt: PASS; a failed attempt before a success: INVALID; never opened: INVALID', () => {
    expect(evaluateStartup([{ attempt: 1, failedAttempts: [] }]).verdict).toBe('PASS')
    const retried = evaluateStartup([
      {
        attempt: 2,
        failedAttempts: [
          { attempt: 1, stage: 'navigation', error: 'Page.navigate did not answer within 5000 ms' },
        ],
      },
    ])
    expect(retried.verdict).toBe('INVALID')
    expect((retried.perRun as { reason: string }[])[0]!.reason).toBe(
      'failed_attempt_before_success',
    )
    expect(evaluateStartup([{ failed: true, stage: 'navigation' }]).verdict).toBe('INVALID')
    expect(evaluateStartup([]).verdict).toBe('NOT_TESTED')
  })

  it('buildReport takes the lab openings of functional, perf and cycles runs', () => {
    const rep = buildReport({
      functional: {
        steps: {},
        failedSteps: [],
        env: { openLab: { attempt: 1, failedAttempts: [] } },
      },
      perf: [
        { kind: 'maplibre', scenario: 'urban', openLabAttempt: { attempt: 1, failedAttempts: [] } },
        { kind: 'maplibre', scenario: 'urban', openLab: { stage: 'labReady', error: 'x' } },
      ],
    })
    expect(rep.criteria.startup).toMatchObject({ verdict: 'INVALID' })
    expect(rep.overall).not.toBe('PASS')
  })

  it('the session record becomes a report criterion; one per session when several are read', () => {
    const ok = {
      label: 'functional-amd',
      stages: SESSION_STAGES.map((stage) => ({ stage, verdict: 'PASS' })),
      cleanup: { verdict: 'PASS' },
    }
    expect(buildReport({ lifecycle: ok }).criteria.sessionLifecycle).toMatchObject({
      verdict: 'PASS',
    })
    const many = buildReport({ lifecycle: [ok, { ...ok, label: 'perf-amd' }] }).criteria
    expect(Object.keys(many)).toEqual(
      expect.arrayContaining(['sessionLifecycle:functional-amd', 'sessionLifecycle:perf-amd']),
    )
    expect(evaluateLifecycle(undefined).verdict).toBe('INVALID')
    expect(buildReport({}).criteria.sessionLifecycle).toBeUndefined()
  })
})
