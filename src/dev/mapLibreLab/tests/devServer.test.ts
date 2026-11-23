/**
 * B1.5.4B (defects B and C): the harness's own dev server (tools/maplibre-validation/devserver.mjs)
 * against a fake process table and HTTP server on fake timers. Nothing here starts Vite, a
 * process or a socket; `devServerProcess.test.ts` covers the real process handling.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  DEV_STAGES,
  DevServerError,
  moduleImports,
  moduleScripts,
  startDevServer,
  stopDevServer,
  type DevServerDeps,
  type HttpAnswer,
  type ServerHandle,
} from '../../../../tools/maplibre-validation/devserver.mjs'

const ORIGIN = 'http://127.0.0.1:1420'
const LAB_PATH = '/src/dev/mapLibreLab/index.html'
const MARKER = 'RoadPilot MapLibre lab'
const PID = 7001
const UNRELATED = [15076, 15077] // e.g. other Node processes on the machine

interface Scenario {
  /** Foreign PIDs listening on the port before the harness starts anything. */
  preOwners: number[]
  /** Something answers HTTP at the origin before the harness starts anything. */
  preAnswer: boolean
  /** ms after spawn until the server's `listening` message; Infinity: never. */
  listeningMs: number
  listenOrigin: string
  listenPid: number
  /** The server reports an error over IPC (e.g. port taken) instead of listening. */
  ipcError: string | null
  /** A foreign PID also owns the port after the spawn. */
  foreignOwner: number | null
  /** ms after spawn until HTTP answers; Infinity: never. */
  httpMs: number
  /** The lab URL answers with the app page (Vite SPA fallback for a wrong route). */
  labFallback: boolean
  labStatus: number
  /** Cold start: the first request of an optimised dependency answers 504 and changes `?v=`. */
  cold: boolean
  /** Every request of an optimised dependency answers 504 (never settles). */
  depsBroken: boolean
  /** The process exits on its own this many ms after spawn. */
  exitMs: number
  exitCode: number
  /** Child processes of the server. */
  children: number[]
  childrenExitWithServer: boolean
  /** ms after the shutdown request until the process exits; Infinity: never. */
  shutdownMs: number
  sendsClosed: boolean
  shutdownExitCode: number
  /** The endpoint keeps answering after the process exited (another server on the port). */
  endpointStaysUp: boolean
}

const base: Scenario = {
  preOwners: [],
  preAnswer: false,
  listeningMs: 800,
  listenOrigin: ORIGIN,
  listenPid: PID,
  ipcError: null,
  foreignOwner: null,
  httpMs: 900,
  labFallback: false,
  labStatus: 200,
  cold: false,
  depsBroken: false,
  exitMs: Infinity,
  exitCode: 1,
  children: [],
  childrenExitWithServer: true,
  shutdownMs: 300,
  sendsClosed: true,
  shutdownExitCode: 0,
  endpointStaysUp: false,
}

const APP_HTML =
  '<!doctype html><html><head><script type="module" src="/@vite/client"></script></head><body><div id="root"></div><script type="module" src="/src/app/main.tsx"></script></body></html>'
const LAB_HTML = `<!doctype html><html><head><title>${MARKER} (B1 prototype)</title><script type="module" src="/@vite/client"></script></head><body><script type="module" src="./main.ts"></script></body></html>`

class World {
  spawnedAt = Infinity
  shutdownAt = Infinity
  hash = 'a1'
  spawns = 0
  requests: string[] = []
  saved: { name: string; data: Record<string, unknown> }[] = []
  descendantCalls: number[] = []
  isAliveCalls: number[] = []
  readonly unrelatedAlive = new Set(UNRELATED)
  readonly s: Scenario

  constructor(s: Scenario) {
    this.s = { ...s } // own copy: a test may change its world's scenario
  }

  private since() {
    return Date.now() - this.spawnedAt
  }
  exitAt(): number {
    const own = this.spawnedAt + this.s.exitMs
    const req = this.shutdownAt + this.s.shutdownMs
    return Math.min(own, req)
  }
  exited() {
    return Date.now() >= this.exitAt()
  }
  private listening() {
    return !this.exited() && this.since() >= this.s.listeningMs && !this.s.ipcError
  }

  module(path: string): HttpAnswer | null {
    const js = (text: string): HttpAnswer => ({ status: 200, contentType: 'text/javascript', text })
    const [p, q] = path.split('?')
    if (p!.startsWith('/node_modules/.vite/deps/')) {
      if (this.s.depsBroken)
        return { status: 504, contentType: 'text/plain', text: 'Outdated Optimize Dep' }
      if (this.s.cold && this.hash === 'a1') {
        this.hash = 'b2' // the optimiser found a new dependency and re-optimised
        return { status: 504, contentType: 'text/plain', text: 'Outdated Optimize Dep' }
      }
      return q === `v=${this.hash}`
        ? js('export default {}')
        : { status: 404, contentType: 'text/plain', text: '' }
    }
    const v = `?v=${this.hash}`
    const table: Record<string, string> = {
      '/@vite/client': 'import "/@vite/env";\nexport const x = 1',
      '/@vite/env': '',
      '/src/app/main.tsx': `import React from "/node_modules/.vite/deps/react.js${v}";\nimport App from "./App.tsx";\nimport "/src/theme/theme.css";`,
      '/src/app/App.tsx':
        '// import "/src/never-requested.ts"\n/* import "/nor/this.ts" */\nexport default 1',
      '/src/theme/theme.css': 'const css = ""; export default css',
      '/src/dev/mapLibreLab/main.ts': `import maplibre from "/node_modules/.vite/deps/maplibre-gl.js${v}";\nimport workerEntryUrl from "/src/dev/mapLibreLab/scsWorkerEntry.mjs?import&url";\nconst lazy = () => import("./lazy.ts");\nconst ext = "https://example.invalid/x.js";`,
      '/src/dev/mapLibreLab/lazy.ts': 'export {}',
      '/src/dev/mapLibreLab/scsWorkerEntry.mjs':
        'import "/node_modules/maplibre-gl/dist/maplibre-gl-worker.mjs"',
    }
    if (p === '/src/dev/mapLibreLab/scsWorkerEntry.mjs' && q === 'import&url')
      return js('export default "/src/dev/mapLibreLab/scsWorkerEntry.mjs"')
    if (p === '/node_modules/maplibre-gl/dist/maplibre-gl-worker.mjs') return js('self.worker = 1')
    return table[p!] !== undefined ? js(table[p!]!) : null
  }

  answer(url: string): HttpAnswer {
    const u = new URL(url)
    const path = u.pathname + u.search
    if (u.pathname === '/' || u.pathname === '/index.html')
      return { status: 200, contentType: 'text/html', text: APP_HTML }
    if (u.pathname === LAB_PATH) {
      if (this.s.labFallback) return { status: 200, contentType: 'text/html', text: APP_HTML }
      return {
        status: this.s.labStatus,
        contentType: 'text/html',
        text: this.s.labStatus === 200 ? LAB_HTML : '',
      }
    }
    return this.module(path) ?? { status: 404, contentType: 'text/plain', text: 'not found' }
  }

  handle(): ServerHandle {
    return {
      pid: PID,
      messages: () => {
        const m: { type: string; [k: string]: unknown }[] = []
        if (this.s.ipcError && this.since() >= 100)
          m.push({ type: 'error', stage: 'listen', error: this.s.ipcError })
        if (this.since() >= this.s.listeningMs && !this.s.ipcError && this.since() < this.s.exitMs)
          m.push({
            type: 'listening',
            pid: this.s.listenPid,
            urls: { local: [`${this.s.listenOrigin}/`] },
          })
        if (
          this.shutdownAt !== Infinity &&
          this.exited() &&
          this.s.sendsClosed &&
          this.exitAt() === this.shutdownAt + this.s.shutdownMs
        )
          m.push({ type: 'closed', reason: 'ipc' })
        return m
      },
      output: () => 'VITE ready',
      exitInfo: () => {
        if (!this.exited()) return null
        const byShutdown = this.exitAt() === this.shutdownAt + this.s.shutdownMs
        return { code: byShutdown ? this.s.shutdownExitCode : this.s.exitCode, signal: null }
      },
      requestShutdown: () => {
        if (this.exited()) return false
        this.shutdownAt = Date.now()
        return true
      },
    }
  }

  childAlive(pid: number) {
    return this.s.children.includes(pid) && (!this.exited() || !this.s.childrenExitWithServer)
  }

  deps(): DevServerDeps {
    return {
      spawn: async () => {
        this.spawns++
        this.spawnedAt = Date.now()
        return this.handle()
      },
      fetch: async (url) => {
        this.requests.push(url)
        const spawned = this.spawnedAt !== Infinity
        const up = spawned
          ? (this.listening() && this.since() >= this.s.httpMs) ||
            (this.exited() && this.s.endpointStaysUp)
          : this.s.preAnswer
        if (!up) throw new Error('connect ECONNREFUSED 127.0.0.1:1420')
        return this.answer(url)
      },
      portOwners: async () => {
        if (this.spawnedAt === Infinity) return [...this.s.preOwners]
        const o = this.listening() ? [this.s.listenPid === PID ? PID : this.s.listenPid] : []
        if (this.s.foreignOwner !== null) o.push(this.s.foreignOwner)
        return o
      },
      descendants: async (pid) => {
        this.descendantCalls.push(pid)
        return this.s.children
          .filter((c) => this.childAlive(c))
          .map((c) => ({ pid: c, ppid: PID, name: 'esbuild.exe' }))
      },
      isAlive: (pid) => {
        this.isAliveCalls.push(pid)
        if (pid === PID) return !this.exited()
        if (this.unrelatedAlive.has(pid)) return true
        return this.childAlive(pid)
      },
      save: (name, data) => {
        this.saved.push({ name, data })
        return `out/${name}.json`
      },
      now: () => Date.now(),
      sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    }
  }
}

const options = {
  origin: ORIGIN,
  appPath: '/',
  labPath: LAB_PATH,
  labMarker: MARKER,
  requiredModules: ['/src/dev/mapLibreLab/scsWorkerEntry.mjs'],
  label: 'functional-amd',
}

async function start(world: World, extra: Record<string, unknown> = {}) {
  const p = startDevServer(world.deps(), { ...options, ...extra }).then(
    (value) => ({ value, error: null as unknown }),
    (error: unknown) => ({ value: null, error }),
  )
  await vi.runAllTimersAsync()
  return p
}

async function startAndStop(world: World) {
  const { value } = await start(world)
  expect(value).not.toBeNull()
  const p = stopDevServer(world.deps(), value!)
  await vi.runAllTimersAsync()
  return { server: value!, stop: await p }
}

describe('module discovery', () => {
  it('finds module scripts of a page, absolute', () => {
    expect(moduleScripts(LAB_HTML, `${ORIGIN}${LAB_PATH}`)).toEqual([
      `${ORIGIN}/@vite/client`,
      `${ORIGIN}/src/dev/mapLibreLab/main.ts`,
    ])
  })

  it('follows static, side-effect and literal dynamic imports; skips comments, bare and foreign specifiers', () => {
    const code = `
      // import "/commented-out.ts"
      /* import "/block-commented.ts" */
      import a, { b as c } from "./a.ts";
      import {
        d,
      } from "../d.ts";
      import "/side-effect.css";
      export * from "/re-export.ts";
      export { e } from './e.ts';
      const lazy = () => import("./lazy.ts");
      import bare from "react";
      import far from "https://example.invalid/x.js";
      import.meta.hot;
      const s = "export default thing";`
    expect(moduleImports(code, `${ORIGIN}/src/x/m.ts`).sort()).toEqual(
      [
        `${ORIGIN}/src/x/a.ts`,
        `${ORIGIN}/src/d.ts`,
        `${ORIGIN}/side-effect.css`,
        `${ORIGIN}/re-export.ts`,
        `${ORIGIN}/src/x/e.ts`,
        `${ORIGIN}/src/x/lazy.ts`,
      ].sort(),
    )
  })
})

describe('dev server readiness (defect B)', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(0)
  })
  afterEach(() => vi.useRealTimers())

  it('normal start passes every stage in order and serves the app, lab and worker-entry modules', async () => {
    const w = new World(base)
    const { value, error } = await start(w)
    expect(error).toBeNull()
    expect(value!.pid).toBe(PID)
    expect(value!.stages.map((s) => s.stage)).toEqual(DEV_STAGES)
    expect(value!.modules.passes.map((p) => p.failures.length)).toEqual([0, 0])
    expect(value!.modules.urls).toEqual(
      expect.arrayContaining([
        `${ORIGIN}/src/app/main.tsx`,
        `${ORIGIN}/src/dev/mapLibreLab/main.ts`,
        `${ORIGIN}/src/dev/mapLibreLab/lazy.ts`,
        `${ORIGIN}/src/dev/mapLibreLab/scsWorkerEntry.mjs`,
        `${ORIGIN}/node_modules/maplibre-gl/dist/maplibre-gl-worker.mjs`,
        `${ORIGIN}/node_modules/.vite/deps/maplibre-gl.js?v=a1`,
      ]),
    )
    expect(
      value!.modules.urls.some((u) => u.includes('never-requested') || u.includes('nor/this')),
    ).toBe(false)
    expect(w.requests.some((u) => u.startsWith('https://'))).toBe(false)
    expect(w.spawns).toBe(1)
  })

  it('cold start: a re-optimising dependency (504, new ?v=) is waited out by complete, stable passes', async () => {
    const w = new World({ ...base, cold: true })
    const { value, error } = await start(w)
    expect(error).toBeNull()
    const passes = value!.modules.passes
    expect(passes).toHaveLength(3)
    // Pass 1: the 504 of the re-optimisation, and the stale `?v=a1` URL of the other dependency.
    expect(passes[0]!.failures).toEqual(
      expect.arrayContaining([expect.objectContaining({ status: 504 })]),
    )
    expect(passes.slice(1).map((p) => p.failures.length)).toEqual([0, 0])
    expect(value!.modules.urls).toContain(`${ORIGIN}/node_modules/.vite/deps/maplibre-gl.js?v=b2`)
  })

  it('delayed readiness (late listening, late HTTP) still succeeds within the stage deadlines', async () => {
    const w = new World({ ...base, listeningMs: 12_000, httpMs: 20_000 })
    const { value, error } = await start(w)
    expect(error).toBeNull()
    expect(value!.stages.find((s) => s.stage === 'http')!.ms).toBeGreaterThanOrEqual(7_000)
  })

  it('a listening message alone is not enough: no HTTP answer fails the http stage', async () => {
    const w = new World({ ...base, httpMs: Infinity })
    const { error } = await start(w)
    const e = error as DevServerError
    expect(e).toBeInstanceOf(DevServerError)
    expect(e.stage).toBe('http')
    expect(e.message).toMatch(/not reached within 15000 ms.*ECONNREFUSED/)
    // Diagnostics saved, and the server this start created was stopped gracefully.
    expect(w.saved.map((s) => s.name)).toEqual(['devserver-failure-functional-amd'])
    const d = w.saved[0]!.data as Record<string, unknown>
    expect(d).toMatchObject({ failure: { stage: 'http' }, pid: PID, output: 'VITE ready' })
    expect(e.cleanup).toMatchObject({
      verdict: 'PASS',
      reason: 'graceful',
      shutdownRequested: true,
    })
  })

  it('startup timeout: no listening message within the deadline', async () => {
    const w = new World({ ...base, listeningMs: Infinity })
    const { error } = await start(w)
    const e = error as DevServerError
    expect(e.stage).toBe('listening')
    expect(e.message).toContain('not reached within 30000 ms')
    expect(e.diagnosticsFile).toBe('out/devserver-failure-functional-amd.json')
    expect(e.cleanup?.verdict).toBe('PASS')
  })

  it('server process exit during readiness fails at once with the exit code', async () => {
    const w = new World({ ...base, listeningMs: 5_000, exitMs: 2_000, exitCode: 1 })
    const { error } = await start(w)
    const e = error as DevServerError
    expect(e.stage).toBe('listening')
    expect(e.message).toContain('server process exited (code 1')
    expect(Date.now()).toBeLessThan(10_000) // not waited out to the deadline
    expect(e.cleanup).toMatchObject({
      verdict: 'PASS',
      reason: 'already_exited',
      shutdownRequested: false,
    })
  })

  it('server process exit after listening (during the module checks) fails that stage', async () => {
    const w = new World({ ...base, exitMs: 1_000 })
    const { error } = await start(w)
    const e = error as DevServerError
    expect(['ownership', 'http', 'labRoute', 'modules']).toContain(e.stage)
    expect(e.message).toContain('exited')
  })

  it('a server error over IPC (port taken) fails the listening stage', async () => {
    const w = new World({ ...base, ipcError: 'Port 1420 is already in use' })
    const { error } = await start(w)
    expect((error as DevServerError).message).toContain('Port 1420 is already in use')
  })

  it('wrong process: a port already owned by another PID is refused before anything starts', async () => {
    const w = new World({ ...base, preOwners: [4242] })
    const { error } = await start(w)
    const e = error as DevServerError
    expect(e.stage).toBe('preflight')
    expect(e.message).toContain('already in use by PID 4242')
    expect(w.spawns).toBe(0)
    expect(e.cleanup).toBeNull()
  })

  it('wrong process: something already answering at the origin is refused', async () => {
    const w = new World({ ...base, preAnswer: true })
    const { error } = await start(w)
    expect((error as DevServerError).stage).toBe('preflight')
    expect(w.spawns).toBe(0)
  })

  it('wrong port: a server listening on another origin fails the listening stage', async () => {
    const w = new World({ ...base, listenOrigin: 'http://127.0.0.1:1421' })
    const { error } = await start(w)
    const e = error as DevServerError
    expect(e.stage).toBe('listening')
    expect(e.message).toContain('listens on http://127.0.0.1:1421, not http://127.0.0.1:1420')
  })

  it('wrong process: a listening message from another PID fails', async () => {
    const w = new World({ ...base, listenPid: 9999 })
    const { error } = await start(w)
    expect((error as DevServerError).message).toContain('from PID 9999, not 7001')
  })

  it('wrong process: a foreign PID sharing the port fails the ownership stage', async () => {
    const w = new World({ ...base, foreignOwner: 5555 })
    const { error } = await start(w)
    const e = error as DevServerError
    expect(e.stage).toBe('ownership')
    expect(e.message).toContain('also owned by PID 5555')
  })

  it('invalid lab route: the SPA fallback (app page with status 200) is recognised at once', async () => {
    const w = new World({ ...base, labFallback: true })
    const { error } = await start(w)
    const e = error as DevServerError
    expect(e.stage).toBe('labRoute')
    expect(e.message).toContain('is not the lab page')
    expect(Date.now()).toBeLessThan(15_000)
  })

  it('invalid lab route: a lab URL that never answers 200 fails after the stage deadline', async () => {
    const w = new World({ ...base, labStatus: 404 })
    const { error } = await start(w)
    const e = error as DevServerError
    expect(e.stage).toBe('labRoute')
    expect(e.message).toContain('answered 404')
  })

  it('modules that never settle fail after the bounded number of passes', async () => {
    const w = new World({ ...base, depsBroken: true })
    const { error } = await start(w)
    const e = error as DevServerError
    expect(e.stage).toBe('modules')
    expect(e.message).toMatch(/after 3 passes/)
  })
})

describe('dev server shutdown (defect C)', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(0)
  })
  afterEach(() => vi.useRealTimers())

  it('normal shutdown: IPC shutdown, graceful exit, endpoint down, port free', async () => {
    const w = new World(base)
    const { stop } = await startAndStop(w)
    expect(stop).toMatchObject({
      verdict: 'PASS',
      reason: 'graceful',
      shutdownRequested: true,
      graceful: true,
      closedMessage: true,
      exit: { code: 0, signal: null },
      httpDown: true,
      portFree: true,
      leftoverDescendants: [],
    })
  })

  it('child processes recorded at readiness must exit with the server', async () => {
    const w = new World({ ...base, children: [7002, 7003] })
    const { server, stop } = await startAndStop(w)
    expect(server.descendants.map((d) => d.pid)).toEqual([7002, 7003])
    expect(stop).toMatchObject({ verdict: 'PASS', leftoverDescendants: [] })
  })

  it('a child process left behind is a cleanup FAIL with its identity; it is not killed', async () => {
    const w = new World({ ...base, children: [7002], childrenExitWithServer: false })
    const { stop } = await startAndStop(w)
    expect(stop).toMatchObject({ verdict: 'FAIL', reason: 'child_processes_left' })
    expect(stop.leftoverDescendants.map((d) => d.pid)).toEqual([7002])
    expect(w.childAlive(7002)).toBe(true)
  })

  it('delayed shutdown within the bound passes', async () => {
    const w = new World({ ...base, shutdownMs: 12_000 })
    const { stop } = await startAndStop(w)
    expect(stop).toMatchObject({ verdict: 'PASS', reason: 'graceful' })
    expect(stop.ms).toBeGreaterThanOrEqual(12_000)
  })

  it('an already exited server is reported as such, without a shutdown request', async () => {
    const w = new World(base)
    const { value } = await start(w)
    w.s.exitMs = Date.now() - w.spawnedAt // the server dies on its own, before the stop
    const p = stopDevServer(w.deps(), value!)
    await vi.runAllTimersAsync()
    const stop = await p
    expect(stop).toMatchObject({
      verdict: 'PASS',
      reason: 'already_exited',
      alreadyExited: true,
      shutdownRequested: false,
      graceful: false,
    })
  })

  it('shutdown timeout: cleanup FAIL with the process identity, and the process is NOT killed', async () => {
    const w = new World({ ...base, shutdownMs: Infinity, children: [7002] })
    const { stop } = await startAndStop(w)
    expect(stop).toMatchObject({
      verdict: 'FAIL',
      reason: 'shutdown_timeout',
      pid: PID,
      processAlive: true,
    })
    expect(stop.descendantsNow).toEqual([expect.objectContaining({ pid: 7002 })])
    expect(stop.ms).toBeGreaterThanOrEqual(20_000)
    expect(w.exited()).toBe(false) // still running: the harness has no kill path
  })

  it('a non-zero exit without the closed message is not graceful', async () => {
    const w = new World({ ...base, sendsClosed: false, shutdownExitCode: 1 })
    const { stop } = await startAndStop(w)
    expect(stop).toMatchObject({ verdict: 'FAIL', reason: 'not_graceful' })
  })

  it('an endpoint that still answers after the exit is reported (another server on the port)', async () => {
    const w = new World({ ...base, endpointStaysUp: true })
    const { stop } = await startAndStop(w)
    expect(stop).toMatchObject({
      verdict: 'FAIL',
      reason: 'endpoint_still_answers',
      httpDown: false,
    })
  })

  it('unrelated Node processes are never looked up or touched', async () => {
    const w = new World({ ...base, children: [7002] })
    await startAndStop(w)
    expect(new Set(w.descendantCalls)).toEqual(new Set([PID]))
    expect(w.isAliveCalls.every((p) => p === PID || p === 7002)).toBe(true)
    expect([...w.unrelatedAlive]).toEqual(UNRELATED)
    // The dependency surface has no way to terminate anything.
    expect(Object.keys(w.deps()).some((k) => /kill|terminate|stop/i.test(k))).toBe(false)
  })
})
