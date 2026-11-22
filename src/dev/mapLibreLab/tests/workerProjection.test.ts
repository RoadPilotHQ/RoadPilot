/**
 * B1.5.1 (defect A): registration of the projection handler in MapLibre's workers.
 *
 * The fake pool models what MapLibre 6.19.0's source does (see `workerProjection.ts`): workers are
 * created on first use, `importScript` replays every known url into new workers, a worker's
 * import is asynchronous, terminating workers aborts messages in flight, and a worker answers an
 * unknown message type with `null`. These tests check the registry's logic against that model;
 * they do NOT verify real MapLibre worker behaviour, which needs a runtime run.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  AttemptTimeoutError,
  checkStatusAnswers,
  createWorkerProjection,
  PROJECTION_CRS,
  PROJECTION_STATUS_MESSAGE,
  WorkerProjectionError,
  type Timers,
  type WorkerPoolPort,
} from '../workerProjection'
import {
  installScsProjection,
  scsProjectionHandler,
  STATUS_CRS,
  STATUS_MESSAGE,
} from '../scsProjection.worker.mjs'

interface Deferred {
  promise: Promise<void>
  resolve: () => void
  reject: (e: Error) => void
}
const deferred = (): Deferred => {
  let resolve!: () => void
  let reject!: (e: Error) => void
  const promise = new Promise<void>((res, rej) => {
    resolve = res
    reject = rej
  })
  promise.catch(() => undefined)
  return { promise, resolve, reject }
}

const abortError = () => {
  const e = new Error('The workers were terminated while a message was in flight.')
  e.name = 'AbortError'
  return e
}

/** One fake worker: an asynchronous, deduplicated import per url (like `_importScript`). */
class FakeWorker {
  handler = false
  readonly imports = new Map<string, Deferred>()
  constructor(
    readonly id: number,
    readonly canSetHandler: boolean,
  ) {}
  import(url: string): Promise<void> {
    let d = this.imports.get(url)
    if (!d) {
      d = deferred()
      this.imports.set(url, d)
      d.promise.then(
        () => (this.handler = this.canSetHandler),
        () => this.imports.delete(url),
      )
    }
    return d.promise
  }
}

/** The global pool and dispatcher as seen through `WorkerPoolPort`. */
class FakePool {
  workers: FakeWorker[] = []
  private nextId = 1
  private readonly createListeners = new Set<() => void>()
  readonly urls = new Set<string>()
  keepAlive = 0
  importCalls = 0
  /** Imports finish only when the test resolves them, unless `autoImport` is set. */
  autoImport = true
  workerCount = 1
  /** Workers created from now on lack `setProjectionHandler`. */
  brokenWorkers = false
  failImports = 0

  readonly port: WorkerPoolPort = {
    keepWorkersAlive: () => {
      this.keepAlive++
      this.ensureWorkers()
    },
    importScript: (url) => {
      this.importCalls++
      this.urls.add(url)
      this.ensureWorkers()
      if (this.failImports > 0) {
        this.failImports--
        return Promise.reject(new Error('Failed to fetch dynamically imported module'))
      }
      const all = Promise.all(this.workers.map((w) => w.import(url)))
      if (this.autoImport) this.finishImports()
      return all
    },
    broadcast: async (type) => {
      this.ensureWorkers()
      return this.workers.map((w) =>
        type === PROJECTION_STATUS_MESSAGE && w.handler
          ? { crs: PROJECTION_CRS, handler: true }
          : null,
      )
    },
    onWorkersCreated: (l) => {
      this.createListeners.add(l)
      return () => this.createListeners.delete(l)
    },
  }

  ensureWorkers() {
    if (this.workers.length === 0) this.createWorkers()
  }

  private createWorkers() {
    this.workers = Array.from(
      { length: this.workerCount },
      () => new FakeWorker(this.nextId++, !this.brokenWorkers),
    )
    // MapLibre replays every imported url into new workers, asynchronously.
    for (const url of this.urls) for (const w of this.workers) void w.import(url).catch(() => {})
    for (const l of [...this.createListeners]) l()
  }

  /** `WorkerPool.restart` / release of the last unprewarmed map: abort in-flight, new workers. */
  recreate() {
    for (const w of this.workers) for (const d of w.imports.values()) d.reject(abortError())
    this.workers = []
    this.createWorkers()
  }

  finishImports() {
    for (const w of this.workers) for (const d of w.imports.values()) d.resolve()
  }
}

/** Timers that never fire on their own (timeouts are tested separately). */
const idleTimers: Timers = { setTimeout: () => 0, clearTimeout: () => undefined }
const flush = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve()
}
const URL_ = 'http://127.0.0.1:1420/src/dev/mapLibreLab/scsProjection.worker.mjs'

describe('workerProjection', () => {
  afterEach(() => vi.useRealTimers())

  it('initial worker creation: keeps the pool, imports, verifies every worker', async () => {
    const pool = new FakePool()
    const wp = createWorkerProjection(pool.port, URL_, { timers: idleTimers })
    expect(wp.isReady()).toBe(false)
    await expect(wp.ensureReady()).resolves.toEqual({ generation: 1, workers: 1 })
    expect(pool.keepAlive).toBe(1)
    expect(pool.importCalls).toBe(1)
    expect(wp.isReady()).toBe(true)
    expect(wp.status()).toMatchObject({
      state: 'ready',
      generation: 1,
      attempts: [],
      keepAlive: true,
    })
    // Ready: further calls neither import nor prewarm again.
    await wp.ensureReady()
    expect(pool.importCalls).toBe(1)
    expect(pool.keepAlive).toBe(1)
  })

  it('multiple workers: every one must report the handler', async () => {
    const pool = new FakePool()
    pool.workerCount = 3
    const wp = createWorkerProjection(pool.port, URL_, { timers: idleTimers })
    await expect(wp.ensureReady()).resolves.toEqual({ generation: 1, workers: 3 })
  })

  it('a worker without setProjectionHandler is a failure, never a silent pass', async () => {
    const pool = new FakePool()
    pool.workerCount = 2
    pool.brokenWorkers = true
    const wp = createWorkerProjection(pool.port, URL_, { timers: idleTimers, attempts: 2 })
    const err = await wp.ensureReady().catch((e: unknown) => e)
    expect(err).toBeInstanceOf(WorkerProjectionError)
    expect((err as WorkerProjectionError).attempts).toHaveLength(2)
    expect((err as WorkerProjectionError).attempts[0]).toMatchObject({
      stage: 'verify',
      error: expect.stringContaining('2 of 2 worker(s) without the handler'),
    })
    expect(wp.status().state).toBe('failed')
    expect(wp.isReady()).toBe(false)
  })

  it('worker pool recreation after registration: stale, listener, registers again', async () => {
    const pool = new FakePool()
    const wp = createWorkerProjection(pool.port, URL_, { timers: idleTimers })
    await wp.ensureReady()
    const seen: number[] = []
    wp.onRecreated((g) => seen.push(g))
    pool.autoImport = false
    pool.recreate()
    expect(seen).toEqual([2])
    expect(wp.status()).toMatchObject({
      state: 'stale',
      generation: 2,
      recreations: 1,
      ready: null,
    })
    expect(wp.isReady()).toBe(false)
    const again = wp.ensureReady()
    await flush()
    pool.finishImports()
    await expect(again).resolves.toEqual({ generation: 2, workers: 1 })
    expect(pool.keepAlive).toBe(1) // prewarm only once
  })

  it('late worker creation after the first load: waits for the replayed import', async () => {
    const pool = new FakePool()
    const wp = createWorkerProjection(pool.port, URL_, { timers: idleTimers })
    await wp.ensureReady()
    pool.autoImport = false
    pool.recreate() // new worker, replayed import still running
    expect(await pool.port.broadcast(PROJECTION_STATUS_MESSAGE)).toEqual([null])
    let settled = false
    const p = wp.ensureReady().then((r) => {
      settled = true
      return r
    })
    await flush()
    expect(settled).toBe(false) // never ready while the worker's import is pending
    pool.finishImports()
    await expect(p).resolves.toMatchObject({ generation: 2 })
  })

  it('worker termination during registration: the abort is recorded and retried', async () => {
    const pool = new FakePool()
    pool.autoImport = false
    const wp = createWorkerProjection(pool.port, URL_, { timers: idleTimers })
    const p = wp.ensureReady()
    await flush()
    pool.autoImport = true
    pool.recreate() // aborts the first import
    await expect(p).resolves.toEqual({ generation: 2, workers: 1 })
    expect(wp.status().attempts).toEqual([
      expect.objectContaining({
        attempt: 1,
        stage: 'import',
        error: expect.stringContaining('AbortError'),
      }),
    ])
  })

  it('workers recreated between import and verification are not counted as ready', async () => {
    const pool = new FakePool()
    const wp = createWorkerProjection(pool.port, URL_, { timers: idleTimers })
    const realBroadcast = pool.port.broadcast
    let once = true
    pool.port.broadcast = async (type) => {
      const answers = await realBroadcast(type)
      if (once) {
        once = false
        pool.recreate() // new generation after the old workers answered
      }
      return answers
    }
    await expect(wp.ensureReady()).resolves.toMatchObject({ generation: 2 })
    expect(wp.status().attempts[0]).toMatchObject({ stage: 'recreated' })
  })

  it('concurrent initialisation shares one registration', async () => {
    const pool = new FakePool()
    pool.autoImport = false
    const wp = createWorkerProjection(pool.port, URL_, { timers: idleTimers })
    const calls = [wp.ensureReady(), wp.ensureReady(), wp.ensureReady()]
    expect(calls[1]).toBe(calls[0])
    expect(calls[2]).toBe(calls[0])
    await flush()
    pool.finishImports()
    const results = await Promise.all(calls)
    expect(results.every((r) => r === results[0])).toBe(true)
    expect(pool.importCalls).toBe(1)
    expect(pool.keepAlive).toBe(1)
  })

  it('registration failure is not cached: the next call retries and succeeds', async () => {
    const pool = new FakePool()
    pool.failImports = 3
    const wp = createWorkerProjection(pool.port, URL_, { timers: idleTimers, attempts: 3 })
    const err = await wp.ensureReady().catch((e: unknown) => e)
    expect(err).toBeInstanceOf(WorkerProjectionError)
    expect((err as Error).message).toContain('Failed to fetch dynamically imported module')
    expect(wp.status()).toMatchObject({ state: 'failed' })
    expect(wp.status().attempts.map((a) => a.attempt)).toEqual([1, 2, 3])
    await expect(wp.ensureReady()).resolves.toMatchObject({ generation: 1 })
    expect(wp.status().state).toBe('ready')
    expect(wp.status().attempts).toHaveLength(3) // diagnostics of the failed call are kept
  })

  it('a hanging import is bounded by the attempt timeout', async () => {
    vi.useFakeTimers()
    const pool = new FakePool()
    pool.autoImport = false
    const wp = createWorkerProjection(pool.port, URL_, { attempts: 2, attemptTimeoutMs: 1000 })
    const p = wp.ensureReady().catch((e: unknown) => e)
    await vi.advanceTimersByTimeAsync(1000)
    await vi.advanceTimersByTimeAsync(1000)
    const err = await p
    expect(err).toBeInstanceOf(WorkerProjectionError)
    expect((err as WorkerProjectionError).attempts.map((a) => a.error)).toEqual([
      expect.stringContaining('AttemptTimeoutError'),
      expect.stringContaining('AttemptTimeoutError'),
    ])
    expect(new AttemptTimeoutError('import', 5).message).toContain('5 ms')
  })

  it('checkStatusAnswers accepts only a status from every worker', () => {
    const ok = { crs: PROJECTION_CRS, handler: true }
    expect(checkStatusAnswers([ok, ok])).toBeNull()
    expect(checkStatusAnswers([])).toBe('no worker answered')
    expect(checkStatusAnswers([ok, null])).toBe('1 of 2 worker(s) without the handler')
    expect(checkStatusAnswers([{ crs: 'EPSG:3857', handler: true }])).not.toBeNull()
    expect(checkStatusAnswers(undefined)).not.toBeNull()
  })
})

describe('scsProjection.worker.mjs', () => {
  it('uses the same message and CRS as the registry', () => {
    expect(STATUS_MESSAGE).toBe(PROJECTION_STATUS_MESSAGE)
    expect(STATUS_CRS).toBe(PROJECTION_CRS)
  })

  it('installs the handler and the status answer through the worker actor', async () => {
    const handlers = new Map<string, () => Promise<unknown>>()
    let installed: unknown = null
    const scope = {
      setProjectionHandler: (h: unknown) => (installed = h),
      worker: {
        actor: {
          registerMessageHandler: (t: string, h: () => Promise<unknown>) => handlers.set(t, h),
        },
      },
    }
    expect(installScsProjection(scope)).toEqual({ handler: true, status: true })
    expect(installed).toBe(scsProjectionHandler)
    await expect(handlers.get(STATUS_MESSAGE)!()).resolves.toEqual({
      crs: PROJECTION_CRS,
      handler: true,
    })
  })

  it('without setProjectionHandler it registers nothing, so verification fails', () => {
    const handlers = new Map<string, unknown>()
    const scope = {
      worker: { actor: { registerMessageHandler: (t: string, h: unknown) => handlers.set(t, h) } },
    }
    expect(installScsProjection(scope)).toEqual({ handler: false, status: false })
    expect(handlers.size).toBe(0)
    expect(installScsProjection(undefined)).toEqual({ handler: false, status: false })
  })

  it('falls back to self.actor; without any actor there is no status answer', () => {
    const handlers = new Map<string, unknown>()
    expect(
      installScsProjection({
        setProjectionHandler: () => undefined,
        actor: {
          registerMessageHandler: (t: string, h: () => Promise<unknown>) => handlers.set(t, h),
        },
      }),
    ).toEqual({ handler: true, status: true })
    expect(installScsProjection({ setProjectionHandler: () => undefined })).toEqual({
      handler: true,
      status: false,
    })
  })
})
