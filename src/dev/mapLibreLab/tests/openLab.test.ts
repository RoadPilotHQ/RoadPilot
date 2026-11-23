/**
 * B1.5.1 (defect B): the harness's staged lab opening (tools/maplibre-validation/openlab.mjs),
 * against a fake app and WebView on fake timers. Nothing here starts RoadPilot or a browser; the
 * tests check the orchestration only, not the real WebView2 timing.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  OpenLabError,
  openLab,
  STAGES,
  type CdpMessage,
  type OpenLabDeps,
} from '../../../../tools/maplibre-validation/openlab.mjs'

const DEV = 'http://127.0.0.1:1420'
const LAB = `${DEV}/src/dev/mapLibreLab/index.html`

class TargetClosedError extends Error {
  constructor() {
    super('DevTools connection closed')
    this.name = 'TargetClosedError'
  }
}

interface Scenario {
  /** ms after launch until `launch()` resolves. */
  launchMs: number
  /** ms after launch until the page target exists. */
  targetMs: number
  /** ms after launch until wry's own navigation to the dev server has committed. */
  appNavMs: number
  /** ms after Page.navigate until the lab URL commits; Infinity: never. */
  labCommitMs: number
  /** ms after the commit until `window.mapLibreLab` exists; Infinity: never. */
  labReadyMs: number
  /** ms after lab ready until the initial configuration finished. */
  initialMs: number
  /** The page goes back to the dev server this many ms after the lab committed. */
  leaveLabMs: number
  /** The DevTools connection closes this many ms after connecting. */
  closeAfterMs: number
  navigateError: string | null
  /** Errors thrown by successive launches (null: launch succeeds). */
  launchErrors: (string | null)[]
  /** Processes still listed after close. */
  leftoverAfterClose: boolean
  /** The app exits on its own this many ms after launch. */
  exitAfterMs: number
  /** Commands that never answer. */
  hang: string[]
}

const base: Scenario = {
  launchMs: 300,
  targetMs: 200,
  appNavMs: 600,
  labCommitMs: 150,
  labReadyMs: 400,
  initialMs: 500,
  leaveLabMs: Infinity,
  closeAfterMs: Infinity,
  navigateError: null,
  launchErrors: [],
  leftoverAfterClose: false,
  exitAfterMs: Infinity,
  hang: [],
}

class World {
  launches = 0
  closes = 0
  running = false
  saved: { name: string; data: Record<string, unknown>; png: string | null }[] = []
  navigateAt: number[] = []
  appNavCommittedAt: number[] = []
  private launchedAt = 0
  private labNavAt = Infinity
  private closed = false
  private closeListeners: ((e: Error) => void)[] = []
  private listeners: ((m: CdpMessage) => void)[] = []
  private lastUrl = 'about:blank'

  constructor(readonly s: Scenario) {}

  private since() {
    return Date.now() - this.launchedAt
  }

  url(): string {
    const t = this.since()
    if (t < this.s.appNavMs) return 'about:blank'
    if (this.labNavAt === Infinity) return `${DEV}/`
    const sinceNav = Date.now() - this.labNavAt
    if (sinceNav < this.s.labCommitMs) return `${DEV}/`
    if (sinceNav - this.s.labCommitMs >= this.s.leaveLabMs) return `${DEV}/`
    return LAB
  }

  private emit(url: string) {
    if (url === this.lastUrl) return
    this.lastUrl = url
    if (url === `${DEV}/`) this.appNavCommittedAt.push(Date.now())
    for (const l of this.listeners) l({ method: 'Page.frameNavigated', params: { frame: { url } } })
  }

  private labState() {
    const url = this.url()
    this.emit(url)
    const sinceCommit = Date.now() - this.labNavAt - this.s.labCommitMs
    const lab = url === LAB && sinceCommit >= this.s.labReadyMs
    return { href: url, ready: 'complete', lab, sinceCommit }
  }

  deps(): OpenLabDeps {
    return {
      launch: async () => {
        const err = this.s.launchErrors[this.launches]
        this.launches++
        this.launchedAt = Date.now()
        this.labNavAt = Infinity
        this.closed = false
        this.lastUrl = 'about:blank'
        this.listeners = []
        this.closeListeners = []
        await new Promise((r) => setTimeout(r, this.s.launchMs))
        if (err) throw new Error(err)
        this.running = true
        return {
          port: 9445,
          startMs: this.s.launchMs,
          proc: { pid: 4242 },
          exited: () => (this.since() >= this.s.exitAfterMs ? 1 : null),
        }
      },
      close: async () => {
        this.closes++
        this.running = this.s.leftoverAfterClose
        return { graceful: true }
      },
      processes: () =>
        this.running ? { app: [4242], webview: [5000, 5001] } : { app: [], webview: [] },
      listTargets: async () =>
        this.since() >= this.s.targetMs
          ? [
              {
                type: 'page',
                id: 'P1',
                url: this.url(),
                webSocketDebuggerUrl: 'ws://127.0.0.1:9445/p',
              },
            ]
          : [],
      connect: async () => {
        if (this.s.closeAfterMs !== Infinity)
          setTimeout(() => {
            this.closed = true
            for (const l of this.closeListeners) l(new TargetClosedError())
          }, this.s.closeAfterMs)
        return {
          send: (method: string, params: Record<string, unknown> = {}) => {
            if (this.closed) return Promise.reject(new TargetClosedError())
            if (this.s.hang.includes(method)) return new Promise(() => undefined)
            return Promise.resolve(this.answer(method, params))
          },
          on: (l: (m: CdpMessage) => void) => this.listeners.push(l),
          onClose: (l: (e: Error) => void) => this.closeListeners.push(l),
          close: () => undefined,
        }
      },
      instrument: async () => ({ log: { requests: [] } }),
      devServer: async () => ({ url: LAB, ok: true, status: 200, ms: 3 }),
      save: (name, data, png) => {
        this.saved.push({ name, data, png })
        return `out/${name}.json`
      },
      now: () => Date.now(),
      sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
      setTimeout: (fn, ms) => setTimeout(fn, ms),
      clearTimeout: (id) => clearTimeout(id as ReturnType<typeof setTimeout>),
    }
  }

  private answer(method: string, params: Record<string, unknown>): unknown {
    switch (method) {
      case 'Page.getFrameTree': {
        const url = this.url()
        this.emit(url)
        return { frameTree: { frame: { url } } }
      }
      case 'Page.navigate':
        this.navigateAt.push(this.since())
        if (this.s.navigateError) return { errorText: this.s.navigateError }
        this.labNavAt = Date.now()
        return { loaderId: 'L1' }
      case 'Runtime.evaluate': {
        const st = this.labState()
        if (String(params.expression).includes('state()'))
          return {
            result: {
              value:
                st.lab && st.sinceCommit - this.s.labReadyMs >= this.s.initialMs
                  ? { load: { ok: 1 } }
                  : null,
            },
          }
        return {
          result: { value: { href: st.href, ready: st.ready, lab: st.lab, body: 'RoadPilot' } },
        }
      }
      case 'Page.captureScreenshot':
        return { data: 'iVBORw0KGgo=' }
      default:
        return {}
    }
  }
}

const options = { labUrl: LAB, devOrigin: DEV, dpr: 1, label: 'test' }

/** Runs `openLab` to completion on fake timers; returns its result or its error. */
async function run(world: World, extra: Record<string, unknown> = {}) {
  const p = openLab(world.deps(), { ...options, ...extra }).then(
    (value) => ({ value, error: null as unknown }),
    (error: unknown) => ({ value: null, error }),
  )
  await vi.runAllTimersAsync()
  return p
}

describe('openLab (staged, bounded)', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(0)
  })
  afterEach(() => vi.useRealTimers())

  it('successful startup passes every stage in order, navigating only after the app committed', async () => {
    const w = new World(base)
    const { value, error } = await run(w)
    expect(error).toBeNull()
    expect(value!.attempt).toBe(1)
    expect(value!.failedAttempts).toEqual([])
    expect(value!.initial).toEqual({ load: { ok: 1 } })
    expect(value!.stages.map((s) => s.stage)).toEqual(STAGES)
    expect(w.launches).toBe(1)
    expect(w.navigateAt).toHaveLength(1)
    expect(w.navigateAt[0]).toBeGreaterThanOrEqual(base.appNavMs)
    expect(value!.events.map((e) => e.event)).toContain('app-navigation-committed')
  })

  it('delayed application startup (slow launch, late page target) still succeeds', async () => {
    const w = new World({ ...base, launchMs: 9_000, targetMs: 12_000, appNavMs: 14_000 })
    const { value, error } = await run(w)
    expect(error).toBeNull()
    expect(value!.attempt).toBe(1)
  })

  it('delayed app navigation: the lab navigation waits for the app own navigation', async () => {
    const w = new World({ ...base, appNavMs: 25_000 })
    const { error } = await run(w)
    expect(error).toBeNull()
    expect(w.navigateAt[0]).toBeGreaterThanOrEqual(25_000)
  })

  it('navigation timeout: both attempts fail at "navigation", each with diagnostics and cleanup', async () => {
    const w = new World({ ...base, labCommitMs: Infinity })
    const { error } = await run(w, { attempts: 2 }) // B1.5.4B: retries only when asked for
    expect(error).toBeInstanceOf(OpenLabError)
    const e = error as OpenLabError
    expect(e.stage).toBe('navigation')
    expect(e.attempts.map((a) => [a.attempt, a.stage])).toEqual([
      [1, 'navigation'],
      [2, 'navigation'],
    ])
    expect(e.attempts[0]!.error).toContain('not reached within 20000 ms')
    expect(w.saved.map((s) => s.name)).toEqual([
      'openlab-failure-test-a1',
      'openlab-failure-test-a2',
    ])
    expect(e.attempts.every((a) => a.cleanup?.clean === true)).toBe(true)
    expect(w.launches).toBe(2)
    expect(w.closes).toBe(2)
    expect(w.running).toBe(false)
  })

  it('Page.navigate error fails the navigation stage with the browser error text', async () => {
    const w = new World({ ...base, navigateError: 'net::ERR_CONNECTION_REFUSED' })
    const { error } = await run(w, { attempts: 1 })
    expect((error as OpenLabError).attempts[0]!.error).toContain('net::ERR_CONNECTION_REFUSED')
  })

  it('lab page not reached: full diagnostics are saved even though the lab never loaded', async () => {
    const w = new World({ ...base, labReadyMs: Infinity })
    const { error } = await run(w, { attempts: 1 })
    const e = error as OpenLabError
    expect(e.stage).toBe('labReady')
    const d = w.saved[0]!.data as Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any
    expect(d.failure).toMatchObject({ attempt: 1, stage: 'labReady' })
    expect(d.finalUrl).toBe(LAB)
    expect(d.page).toMatchObject({ href: LAB, lab: false })
    expect(d.events.map((x: { event: string }) => x.event)).toEqual(
      expect.arrayContaining(['stage:labReady', 'navigate-sent', 'frameNavigated']),
    )
    expect(d.devServer).toMatchObject({ ok: true, status: 200 })
    expect(d.processes).toEqual({ app: [4242], webview: [5000, 5001] }) // before cleanup
    expect(d.app).toMatchObject({ port: 9445, pid: 4242, exited: null })
    expect(d.screenshot).toBe(true)
    expect(w.saved[0]!.png).toBe('iVBORw0KGgo=')
    expect(Array.isArray(d.console)).toBe(true)
    expect(Array.isArray(d.exceptions)).toBe(true)
    expect(d.stages.map((s: { stage: string }) => s.stage)).toEqual([
      'startup',
      'target',
      'appNavigation',
      'navigation',
    ])
  })

  it('a page that leaves the lab after the commit is reported, not waited out', async () => {
    // The lab URL is visible longer than one poll interval, then the page goes back.
    const w = new World({ ...base, leaveLabMs: 150, labReadyMs: 400 })
    const { error } = await run(w, { attempts: 1 })
    const a = (error as OpenLabError).attempts[0]!
    expect(a.stage).toBe('labReady')
    expect(a.error).toContain(`page left the lab (now at ${DEV}/)`)
  })

  it('browser target disappearing: the original TargetClosedError is kept, capture errors are only recorded', async () => {
    const w = new World({ ...base, appNavMs: 5_000, closeAfterMs: 1_000 })
    const { error } = await run(w, { attempts: 1 })
    const e = error as OpenLabError
    expect(e.stage).toBe('appNavigation')
    expect(e.attempts[0]!.error).toContain('TargetClosedError')
    const d = w.saved[0]!.data as Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any
    expect(d.events.map((x: { event: string }) => x.event)).toContain('target-closed')
    expect(d.captureErrors.map((c: { part: string }) => c.part)).toEqual(
      expect.arrayContaining(['frameUrl', 'pageState', 'screenshot']),
    )
    expect(d.failure.error).toContain('TargetClosedError') // not replaced by a later error
    expect(e.attempts[0]!.cleanup?.clean).toBe(true)
  })

  it('a hanging capture command is bounded and does not replace the original failure', async () => {
    const w = new World({ ...base, labReadyMs: Infinity, hang: ['Page.captureScreenshot'] })
    const { error } = await run(w, { attempts: 1 })
    const e = error as OpenLabError
    expect(e.stage).toBe('labReady')
    const d = w.saved[0]!.data as Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any
    expect(d.captureErrors).toEqual([
      expect.objectContaining({ part: 'screenshot', error: expect.stringContaining('5000 ms') }),
    ])
    expect(d.screenshot).toBe(false)
  })

  it('default: one attempt; a failed startup is not retried', async () => {
    const w = new World({ ...base, launchErrors: ['WebView2 did not open the debugging port'] })
    const { error } = await run(w)
    expect((error as OpenLabError).attempts).toHaveLength(1)
    expect(w.launches).toBe(1)
  })

  it('retry after a failed startup (explicit attempts: 2): second launch only after cleanup, then success', async () => {
    const w = new World({ ...base, launchErrors: ['WebView2 did not open the debugging port'] })
    const { value, error } = await run(w, { attempts: 2 })
    expect(error).toBeNull()
    expect(value!.attempt).toBe(2)
    expect(value!.failedAttempts).toEqual([
      expect.objectContaining({
        attempt: 1,
        stage: 'startup',
        error: expect.stringContaining('debugging port'),
      }),
    ])
    expect(w.launches).toBe(2)
  })

  it('an app that exits before its page target exists fails the target stage', async () => {
    const w = new World({ ...base, targetMs: 5_000, exitAfterMs: 1_000 })
    const { error } = await run(w, { attempts: 1 })
    expect((error as OpenLabError).attempts[0]!.error).toMatch(/target: app exited/)
  })

  it('refusals (busy desktop, no confirmation) are never retried and save nothing', async () => {
    for (const msg of [
      'DESKTOP BUSY: NVIDIA utilisation 80 %',
      'launchApp: runtime validation not confirmed',
    ]) {
      const w = new World({ ...base, launchErrors: [msg, null] })
      const { error } = await run(w, { attempts: 2 }) // a refusal is not retried even when allowed
      const e = error as OpenLabError
      expect(e.message).toContain('start refused')
      expect(e.attempts).toHaveLength(1)
      expect(w.launches).toBe(1)
      expect(w.saved).toEqual([])
    }
  })

  it('cleanup after failure: leftover processes stop any retry (no second instance)', async () => {
    const w = new World({ ...base, labReadyMs: Infinity, leftoverAfterClose: true })
    const { error } = await run(w, { attempts: 2 })
    const e = error as OpenLabError
    expect(e.message).toContain('cleanup incomplete')
    expect(e.attempts).toHaveLength(1)
    expect(e.attempts[0]!.cleanup).toMatchObject({
      clean: false,
      processes: { app: [4242], webview: [5000, 5001] },
    })
    expect(w.launches).toBe(1)
  })
})
