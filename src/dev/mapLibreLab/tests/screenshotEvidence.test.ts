/**
 * B1.5.4B (defect A): screenshot evidence of the validation harness
 * (tools/maplibre-validation/evidence.mjs, run.mjs, report.mjs). No browser: captures are fakes,
 * the session folder is an in-memory file set that refuses existing names like `wx` does.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createScreenshotRecorder,
  screenshotName,
} from '../../../../tools/maplibre-validation/evidence.mjs'
import { buildReport, evaluateScreenshots } from '../../../../tools/maplibre-validation/report.mjs'
import runSource from '../../../../tools/maplibre-validation/run.mjs?raw'

/** The functional sequence's captures in run order (run.mjs `functional`). */
const FUNCTIONAL_CAPTURES: [string, string][] = [
  ['basic', 'initial-whole'],
  ['basic', 'labels-whole'],
  ['basic', 'labels-hub-z5'],
  ['basic', 'labels-hub-z8'],
  ['basic', 'labels-hub-z10'],
  ['basic', 'after-context-loss'],
  ['thin', 'maplibre-z7'],
  ['thin', 'maplibre-z9'],
  ['thin', 'maplibre-z11'],
  ['thin', 'maplibre-z13'],
  ['thin', 'm3-z9'],
  ['thin', 'm3-z11'],
  ['thin', 'm3-z13'],
  ['urban', 'whole'],
  ['urban', 'labels-z10'],
]

/** B1.5.4's names (run.mjs at 00f9df6): `A-basic-whole-<tag>` and then `A-basic-<label view>-<tag>`. */
const LEGACY_B154 = [
  'A-basic-whole-amd',
  ...['whole', 'hub-z5', 'hub-z8', 'hub-z10'].map((v) => `A-basic-${v}-amd`),
  'A-basic-after-context-loss-amd',
]

class SessionFolder {
  files = new Map<string, Uint8Array>()
  writes: string[] = []
  constructor(existing: string[] = []) {
    for (const f of existing) this.files.set(f, new Uint8Array([1]))
  }
  exists = (name: string) => this.files.has(name)
  /** Like writeFileSync(..., { flag: 'wx' }). */
  write = (name: string, png: Uint8Array) => {
    if (this.files.has(name)) throw new Error(`EEXIST: file already exists, open '${name}'`)
    this.files.set(name, png)
    this.writes.push(name)
  }
}

const decode = (b64: string) => new Uint8Array(atob(b64).length)
const PNG = 'iVBORw0KGgo='

function recorder(folder: SessionFolder, extra: Record<string, unknown> = {}) {
  return createScreenshotRecorder({
    test: 'functional',
    adapter: 'amd',
    exists: folder.exists,
    write: folder.write,
    decode,
    ...extra,
  })
}

describe('screenshot naming (defect A)', () => {
  afterEach(() => vi.useRealTimers())

  it('reproduces the B1.5.4 collision with the old naming rule', () => {
    const dup = LEGACY_B154.filter((n, i) => LEGACY_B154.indexOf(n) !== i)
    expect(dup).toEqual(['A-basic-whole-amd'])
    const folder = new SessionFolder()
    const errors: string[] = []
    for (const n of LEGACY_B154) {
      try {
        folder.write(`${n}.png`, new Uint8Array([1]))
      } catch (e) {
        errors.push(String(e))
      }
    }
    expect(errors).toEqual([expect.stringContaining('EEXIST')])
  })

  it('the corrected sequence gives every capture its own deterministic name, all saved', async () => {
    const folder = new SessionFolder()
    const r = recorder(folder)
    for (const [scenario, view] of FUNCTIONAL_CAPTURES)
      await r.capture({ scenario, view }, () => PNG)
    const recs = r.records()
    const names = recs.map((x) => x.name)
    expect(new Set(names).size).toBe(FUNCTIONAL_CAPTURES.length)
    expect(recs.every((x) => x.status === 'saved')).toBe(true)
    expect(names.slice(0, 3)).toEqual([
      'functional-001-basic-initial-whole-amd.png',
      'functional-002-basic-labels-whole-amd.png',
      'functional-003-basic-labels-hub-z5-amd.png',
    ])
    expect(names.at(-1)).toBe('functional-015-urban-labels-z10-amd.png')
    // Deterministic: a second run in another folder gives the same names in the same order.
    const again = recorder(new SessionFolder())
    for (const [scenario, view] of FUNCTIONAL_CAPTURES)
      await again.capture({ scenario, view }, () => PNG)
    expect(again.records().map((x) => x.name)).toEqual(names)
    expect(evaluateScreenshots(recs)).toMatchObject({ verdict: 'PASS', metrics: { saved: 15 } })
  })

  it('the same view captured twice (the B1.5.4 case) no longer collides', async () => {
    const folder = new SessionFolder()
    const r = recorder(folder)
    const a = await r.capture({ scenario: 'basic', view: 'whole' }, () => PNG)
    const b = await r.capture({ scenario: 'basic', view: 'whole' }, () => PNG)
    expect([a.status, b.status]).toEqual(['saved', 'saved'])
    expect(a.name).not.toBe(b.name)
  })

  it('names carry test, sequence, scenario, view and adapter; ambiguous parts are refused', () => {
    expect(
      screenshotName({
        test: 'functional',
        seq: 7,
        scenario: 'thin',
        view: 'm3-z9',
        adapter: 'nv',
      }),
    ).toBe('functional-007-thin-m3-z9-nv.png')
    for (const bad of [
      { view: 'a/b' },
      { view: '' },
      { scenario: 'x y' },
      { adapter: '../amd' },
      { seq: 0 },
      { seq: 1000 },
    ])
      expect(() =>
        screenshotName({
          test: 'functional',
          seq: 1,
          scenario: 's',
          view: 'v',
          adapter: 'amd',
          ...bad,
        }),
      ).toThrow()
  })

  it('never overwrites: a name already in the session folder is not written and is reported', async () => {
    const folder = new SessionFolder(['functional-001-basic-initial-whole-amd.png'])
    const r = recorder(folder)
    const rec = await r.capture({ scenario: 'basic', view: 'initial-whole' }, () => PNG)
    expect(rec).toMatchObject({ status: 'failed', stage: 'name' })
    expect(rec.error).toContain('exists')
    expect(folder.writes).toEqual([])
    expect(folder.files.get('functional-001-basic-initial-whole-amd.png')).toEqual(
      new Uint8Array([1]),
    )
  })

  it('the B1.5.4 evidence names can never be produced again (no overwrite of old evidence)', async () => {
    const old = [...new Set(LEGACY_B154)].map((n) => `${n}.png`)
    const folder = new SessionFolder(old)
    const r = recorder(folder)
    for (const [scenario, view] of FUNCTIONAL_CAPTURES)
      await r.capture({ scenario, view }, () => PNG)
    expect(r.records().every((x) => x.status === 'saved')).toBe(true)
    expect(folder.writes.filter((w) => old.includes(w))).toEqual([])
  })

  it('a write refused by the file system (wx) is recorded, not thrown', async () => {
    const folder = new SessionFolder()
    const r = recorder(folder, {
      exists: () => false, // a race: the file appeared after the check
      write: () => {
        throw new Error('EEXIST: file already exists')
      },
    })
    const rec = await r.capture({ scenario: 'basic', view: 'whole' }, () => PNG)
    expect(rec).toMatchObject({ status: 'failed', stage: 'write' })
    expect(rec.error).toContain('EEXIST')
  })

  it('failed, empty and hanging captures are recorded; the run goes on', async () => {
    vi.useFakeTimers()
    const folder = new SessionFolder()
    const r = recorder(folder, { timeoutMs: 1000 })
    const failed = await r.capture({ scenario: 'basic', view: 'a' }, () =>
      Promise.reject(new Error('TargetClosedError: DevTools connection closed')),
    )
    const empty = await r.capture({ scenario: 'basic', view: 'b' }, () => undefined)
    const hanging = r.capture({ scenario: 'basic', view: 'c' }, () => new Promise<string>(() => {}))
    await vi.advanceTimersByTimeAsync(1000)
    const hung = await hanging
    const ok = await r.capture({ scenario: 'basic', view: 'd' }, () => PNG)
    expect([failed, empty, hung].map((x) => [x.status, x.stage])).toEqual([
      ['failed', 'capture'],
      ['failed', 'capture'],
      ['failed', 'capture'],
    ])
    expect(hung.error).toContain('1000 ms')
    expect(ok).toMatchObject({ status: 'saved', seq: 4 })
    expect(folder.writes).toEqual(['functional-004-basic-d-amd.png'])
    const v = evaluateScreenshots(r.records())
    expect(v).toMatchObject({ verdict: 'INVALID', reason: 'screenshots_missing' })
    expect((v.detail as { seq: number }[]).map((d) => d.seq)).toEqual([1, 2, 3])
  })
})

describe('screenshot failures in the report (defect A)', () => {
  const steps = { finalState: { workerProjection: undefined } }

  it('a missing screenshot is its own INVALID criterion, not a failed functional step', () => {
    const rep = buildReport({
      functional: {
        steps,
        failedSteps: [],
        screenshots: [
          { seq: 1, name: 'functional-001-basic-initial-whole-amd.png', status: 'saved' },
          {
            seq: 2,
            name: 'functional-002-basic-labels-whole-amd.png',
            status: 'failed',
            stage: 'write',
            error: 'EEXIST',
          },
        ],
      },
    })
    expect(rep.criteria.screenshots).toMatchObject({
      verdict: 'INVALID',
      reason: 'screenshots_missing',
    })
    expect(rep.criteria.functionalSteps).toBeUndefined()
  })

  it('duplicate names in the records are flagged even if both claim to be saved', () => {
    const v = evaluateScreenshots([
      { seq: 1, name: 'x.png', status: 'saved' },
      { seq: 2, name: 'x.png', status: 'saved' },
    ])
    expect(v).toMatchObject({ verdict: 'INVALID', reason: 'duplicate_screenshot_names' })
  })

  it('records missing in a new run are INVALID; older results without records add no criterion', () => {
    expect(evaluateScreenshots(undefined).verdict).toBe('INVALID')
    expect(evaluateScreenshots([]).verdict).toBe('NOT_TESTED')
    expect(
      buildReport({ functional: { steps, failedSteps: [] } }).criteria.screenshots,
    ).toBeUndefined()
  })
})

describe('run.mjs uses the recorder for every screenshot (defect A)', () => {
  it('builds no screenshot file name itself and calls no screenshot helper of its own', () => {
    expect(runSource).not.toMatch(/screenshot\(page,/)
    expect(runSource).not.toMatch(/`[A-D]-[a-z]/)
    expect(runSource).toMatch(/createScreenshotRecorder\(/)
    const shots = [...runSource.matchAll(/\bshot\('([a-z0-9-]+)', [`']([^`']+)[`']\)/g)].map(
      (m) => `${m[1]}:${m[2]}`,
    )
    // 7 call sites; the label and thin-road loops make them the 15 captures above.
    expect(shots).toEqual([
      'basic:initial-whole',
      'basic:labels-${name}',
      'basic:after-context-loss',
      'thin:maplibre-z${zoom}',
      'thin:m3-z${zoom}',
      'urban:whole',
      'urban:labels-z10',
    ])
    expect(runSource).toContain("{ flag: 'wx' }")
  })
})
