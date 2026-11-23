/**
 * B1.5.1 / B1.5.3: the projection handler in MapLibre's workers, main-thread side.
 *
 * The fake pool models what MapLibre 6.19.0's source does (see `workerProjection.ts`): workers are
 * started from the configured worker URL on first use (`prewarm()` or the first message), new
 * workers fire `workerscreate`, terminating workers aborts messages in flight, and a worker answers
 * an unknown message type with `null`. A worker started from the lab's entry has the handler from
 * its start (B1.5.3); one started from any other URL never gets it; one whose entry failed closed
 * itself and never answers. These tests check the registry's logic against that model; they do
 * NOT verify real MapLibre worker behaviour (see `scsWorkerEntry.test.ts` and the runtime runs).
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  AttemptTimeoutError,
  checkStatusAnswers,
  createWorkerProjection,
  isWorkerProjectionStatus,
  PROJECTION_CRS,
  PROJECTION_SOURCE,
  PROJECTION_STATUS_MESSAGE,
  WorkerProjectionError,
  type Timers,
  type WorkerPoolPort,
} from '../workerProjection'

const ENTRY = 'http://127.0.0.1:1420/src/dev/mapLibreLab/scsWorkerEntry.mjs'
const PACKAGE_WORKER = 'http://127.0.0.1:1420/node_modules/maplibre-gl/dist/maplibre-gl-worker.mjs'
const OK = Object.freeze({
  crs: PROJECTION_CRS,
  handler: true,
  source: PROJECTION_SOURCE,
  messagesBeforeInstall: 0,
})

const abortError = () => {
  const e = new Error('The workers were terminated while a message was in flight.')
  e.name = 'AbortError'
  return e
}

type WorkerKind = 'entry' | 'other-url' | 'entry-failed' | 'late-install'

/** One fake worker; what it answers depends on the script it was started from. */
class FakeWorker {
  constructor(
    readonly id: number,
    readonly kind: WorkerKind,
  ) {}
  answer(type: string): Promise<unknown> | 'never' {
    if (this.kind === 'entry-failed') return 'never' // closed by bootstrapScsWorker
    if (type !== PROJECTION_STATUS_MESSAGE || this.kind === 'other-url')
      return Promise.resolve(null)
    return Promise.resolve(this.kind === 'late-install' ? { ...OK, messagesBeforeInstall: 1 } : OK)
  }
}

/** The global pool and dispatcher as seen through `WorkerPoolPort`. */
class FakePool {
  workers: FakeWorker[] = []
  url: string | undefined = undefined
  private nextId = 1
  private readonly createListeners = new Set<() => void>()
  private readonly errorListeners = new Set<(m: string) => void>()
  private inflight: { reject: (e: Error) => void }[] = []
  readonly calls: string[] = []
  keepAlive = 0
  broadcasts = 0
  workerCount = 1
  /** Kind of the workers created from now on when started from the entry. */
  entryKind: WorkerKind = 'entry'
  /** `setWorkerUrl` is ignored (models a worker URL that cannot be set). */
  ignoreSetUrl = false
  failBroadcasts = 0

  readonly port: WorkerPoolPort = {
    setWorkerUrl: (url) => {
      this.calls.push('setWorkerUrl')
      if (!this.ignoreSetUrl) this.url = url
    },
    getWorkerUrl: () => this.url,
    keepWorkersAlive: () => {
      this.calls.push('keepWorkersAlive')
      this.keepAlive++
      this.ensureWorkers()
    },
    broadcast: (type) => {
      this.calls.push('broadcast')
      this.broadcasts++
      this.ensureWorkers()
      if (this.failBroadcasts > 0) {
        this.failBroadcasts--
        return Promise.reject(new Error('broadcast failed'))
      }
      const answers = this.workers.map((w) => w.answer(type))
      if (answers.includes('never'))
        return new Promise((_, reject) => this.inflight.push({ reject })) // until terminated
      return Promise.all(answers as Promise<unknown>[])
    },
    onWorkersCreated: (l) => {
      this.createListeners.add(l)
      return () => this.createListeners.delete(l)
    },
    onWorkerError: (l) => {
      this.errorListeners.add(l)
      return () => this.errorListeners.delete(l)
    },
  }

  ensureWorkers() {
    if (this.workers.length === 0) this.createWorkers()
  }

  private createWorkers() {
    const kind: WorkerKind = this.url === ENTRY ? this.entryKind : 'other-url'
    this.workers = Array.from(
      { length: this.workerCount },
      () => new FakeWorker(this.nextId++, kind),
    )
    if (kind === 'entry-failed')
      for (const l of this.errorListeners)
        l('Worker failed to load. Check that the worker URL is correct.')
    for (const l of [...this.createListeners]) l()
  }

  /** `WorkerPool.restart`, or a release of the last map while no `prewarm()` holds the pool. */
  recreate() {
    for (const f of this.inflight) f.reject(abortError())
    this.inflight = []
    this.workers = []
    this.createWorkers()
  }

  /** Removing the last map: terminates the workers only if nothing keeps them (MapLibre). */
  releaseLastMap() {
    if (this.keepAlive === 0) {
      this.workers = []
    }
  }
}

/** Timers that never fire on their own (timeouts are tested separately). */
const idleTimers: Timers = { setTimeout: () => 0, clearTimeout: () => undefined }
const flush = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve()
}

describe('workerProjection (B1.5.3 worker entry, secondary verification)', () => {
  afterEach(() => vi.useRealTimers())

  it('initial worker creation: entry URL first, then prewarm, then verification', async () => {
    const pool = new FakePool()
    const wp = createWorkerProjection(pool.port, ENTRY, { timers: idleTimers })
    expect(wp.isReady()).toBe(false)
    await expect(wp.ensureReady()).resolves.toEqual({ generation: 1, workers: 1 })
    // The worker URL is set before prewarm() starts the first worker.
    expect(pool.calls).toEqual(['setWorkerUrl', 'keepWorkersAlive', 'broadcast'])
    expect(pool.url).toBe(ENTRY)
    expect(wp.isReady()).toBe(true)
    expect(wp.status()).toMatchObject({
      state: 'ready',
      generation: 1,
      attempts: [],
      keepAlive: true,
      workerUrl: ENTRY,
      workerErrors: [],
    })
    // Ready: further calls neither verify nor prewarm again.
    await wp.ensureReady()
    expect(pool.broadcasts).toBe(1)
    expect(pool.keepAlive).toBe(1)
  })

  it('multiple workers: every one must report the handler', async () => {
    const pool = new FakePool()
    pool.workerCount = 3
    const wp = createWorkerProjection(pool.port, ENTRY, { timers: idleTimers })
    await expect(wp.ensureReady()).resolves.toEqual({ generation: 1, workers: 3 })
  })

  it('workers started from another script are a failure, never a silent (Mercator) pass', async () => {
    const pool = new FakePool()
    pool.workerCount = 2
    pool.url = PACKAGE_WORKER
    pool.ensureWorkers() // workers existed before the registry ran
    const wp = createWorkerProjection(pool.port, ENTRY, { timers: idleTimers, attempts: 2 })
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

  it('a worker URL that cannot be set fails in the entry stage, before any worker starts', async () => {
    const pool = new FakePool()
    pool.ignoreSetUrl = true
    const wp = createWorkerProjection(pool.port, ENTRY, { timers: idleTimers, attempts: 2 })
    const err = await wp.ensureReady().catch((e: unknown) => e)
    expect(err).toBeInstanceOf(WorkerProjectionError)
    expect(wp.status().attempts.map((a) => a.stage)).toEqual(['entry', 'entry'])
    expect(pool.keepAlive).toBe(0)
    expect(pool.workers).toHaveLength(0)
  })

  it('failed registration in the worker: the closed worker never answers; bounded and loud', async () => {
    vi.useFakeTimers()
    const pool = new FakePool()
    pool.entryKind = 'entry-failed'
    const wp = createWorkerProjection(pool.port, ENTRY, { attempts: 2, attemptTimeoutMs: 1000 })
    const p = wp.ensureReady().catch((e: unknown) => e)
    await vi.advanceTimersByTimeAsync(2000)
    const err = await p
    expect(err).toBeInstanceOf(WorkerProjectionError)
    const attempts = (err as WorkerProjectionError).attempts
    expect(attempts.map((a) => a.error)).toEqual([
      expect.stringContaining('AttemptTimeoutError'),
      expect.stringContaining('AttemptTimeoutError'),
    ])
    expect(attempts[0]!.error).toContain('worker errors: Worker failed to load')
    expect(wp.status().workerErrors).toEqual([
      'Worker failed to load. Check that the worker URL is correct.',
    ])
    expect(wp.status().state).toBe('failed')
  })

  it('a worker that received messages before its handler was installed is rejected', async () => {
    const pool = new FakePool()
    pool.entryKind = 'late-install'
    const wp = createWorkerProjection(pool.port, ENTRY, { timers: idleTimers, attempts: 1 })
    await expect(wp.ensureReady()).rejects.toThrow(
      '1 worker(s) received messages before the handler was installed',
    )
  })

  it('worker termination and recreation after registration: stale, listener, verified again', async () => {
    const pool = new FakePool()
    const wp = createWorkerProjection(pool.port, ENTRY, { timers: idleTimers })
    await wp.ensureReady()
    const seen: number[] = []
    wp.onRecreated((g) => seen.push(g))
    pool.recreate()
    expect(seen).toEqual([2])
    expect(wp.status()).toMatchObject({
      state: 'stale',
      generation: 2,
      recreations: 1,
      ready: null,
    })
    expect(wp.isReady()).toBe(false)
    // The new worker started from the entry: it has the handler before anything else.
    expect(await pool.port.broadcast(PROJECTION_STATUS_MESSAGE)).toEqual([OK])
    await expect(wp.ensureReady()).resolves.toEqual({ generation: 2, workers: 1 })
    expect(pool.keepAlive).toBe(1) // prewarm only once
    expect(pool.calls.filter((c) => c === 'setWorkerUrl')).toHaveLength(1)
  })

  it('repeated worker generations: every one is verified, the entry is set once', async () => {
    const pool = new FakePool()
    pool.workerCount = 2
    const wp = createWorkerProjection(pool.port, ENTRY, { timers: idleTimers })
    await wp.ensureReady()
    for (let g = 2; g <= 6; g++) {
      pool.recreate()
      await expect(wp.ensureReady()).resolves.toEqual({ generation: g, workers: 2 })
    }
    expect(wp.status()).toMatchObject({ state: 'ready', generation: 6, recreations: 5 })
    expect(pool.calls.filter((c) => c === 'setWorkerUrl')).toHaveLength(1)
    expect(pool.keepAlive).toBe(1)
  })

  it('late worker creation (no map yet, workers started later) gets the handler at start', async () => {
    const pool = new FakePool()
    const wp = createWorkerProjection(pool.port, ENTRY, { timers: idleTimers })
    // Nothing started yet: the first broadcast starts the workers (after prewarm, from the entry).
    expect(pool.workers).toHaveLength(0)
    await wp.ensureReady()
    expect(pool.workers.map((w) => w.kind)).toEqual(['entry'])
  })

  it('map removal and remount, reconfiguration, renderer switch: the kept pool stays verified', async () => {
    const pool = new FakePool()
    const wp = createWorkerProjection(pool.port, ENTRY, { timers: idleTimers })
    await wp.ensureReady() // mount
    pool.releaseLastMap() // release (prewarm keeps the workers)
    await wp.ensureReady() // remount
    await wp.ensureReady() // reconfiguration (new map, same pool)
    pool.releaseLastMap() // switch to M3 removes the MapLibre map
    await wp.ensureReady() // back to MapLibre
    expect(wp.status()).toMatchObject({ state: 'ready', generation: 1, recreations: 0 })
    expect(pool.broadcasts).toBe(1)
  })

  it('without prewarm, a release would end the workers; the registry always keeps them', async () => {
    const pool = new FakePool()
    pool.ensureWorkers()
    pool.releaseLastMap()
    expect(pool.workers).toHaveLength(0) // MapLibre's default (the B1.5 defect A trigger)
    const wp = createWorkerProjection(pool.port, ENTRY, { timers: idleTimers })
    await wp.ensureReady()
    pool.releaseLastMap()
    expect(pool.workers).toHaveLength(1)
  })

  it('worker termination during verification: the abort is recorded and retried', async () => {
    const pool = new FakePool()
    pool.entryKind = 'entry-failed' // the first workers never answer
    const wp = createWorkerProjection(pool.port, ENTRY, { timers: idleTimers })
    const p = wp.ensureReady()
    await flush()
    pool.entryKind = 'entry'
    pool.recreate() // aborts the pending broadcast; new, healthy workers
    await expect(p).resolves.toEqual({ generation: 2, workers: 1 })
    expect(wp.status().attempts).toEqual([
      expect.objectContaining({
        attempt: 1,
        stage: 'verify',
        error: expect.stringContaining('AbortError'),
      }),
    ])
  })

  it('workers recreated while the old ones answered are not counted as ready', async () => {
    const pool = new FakePool()
    const wp = createWorkerProjection(pool.port, ENTRY, { timers: idleTimers })
    await wp.ensureReady()
    pool.recreate() // generation 2, stale
    const realBroadcast = pool.port.broadcast
    let once = true
    pool.port.broadcast = async (type) => {
      const answers = await realBroadcast(type)
      if (once) {
        once = false
        pool.recreate() // generation 3 after the generation-2 workers answered
      }
      return answers
    }
    await expect(wp.ensureReady()).resolves.toMatchObject({ generation: 3 })
    expect(wp.status().attempts[0]).toMatchObject({ stage: 'recreated' })
  })

  it('concurrent initialisation shares one verification', async () => {
    const pool = new FakePool()
    const wp = createWorkerProjection(pool.port, ENTRY, { timers: idleTimers })
    const calls = [wp.ensureReady(), wp.ensureReady(), wp.ensureReady()]
    expect(calls[1]).toBe(calls[0])
    expect(calls[2]).toBe(calls[0])
    const results = await Promise.all(calls)
    expect(results.every((r) => r === results[0])).toBe(true)
    expect(pool.broadcasts).toBe(1)
    expect(pool.keepAlive).toBe(1)
    expect(pool.calls.filter((c) => c === 'setWorkerUrl')).toHaveLength(1)
  })

  it('registration failure is not cached: the next call retries and succeeds', async () => {
    const pool = new FakePool()
    pool.failBroadcasts = 3
    const wp = createWorkerProjection(pool.port, ENTRY, { timers: idleTimers, attempts: 3 })
    const err = await wp.ensureReady().catch((e: unknown) => e)
    expect(err).toBeInstanceOf(WorkerProjectionError)
    expect((err as Error).message).toContain('broadcast failed')
    expect(wp.status()).toMatchObject({ state: 'failed' })
    expect(wp.status().attempts.map((a) => a.attempt)).toEqual([1, 2, 3])
    await expect(wp.ensureReady()).resolves.toMatchObject({ generation: 1 })
    expect(wp.status().state).toBe('ready')
    expect(wp.status().attempts).toHaveLength(3) // diagnostics of the failed call are kept
  })

  it('a hanging verification is bounded by the attempt timeout', async () => {
    vi.useFakeTimers()
    const pool = new FakePool()
    const wp = createWorkerProjection(pool.port, ENTRY, { attempts: 2, attemptTimeoutMs: 1000 })
    pool.port.broadcast = () => new Promise(() => undefined)
    const p = wp.ensureReady().catch((e: unknown) => e)
    await vi.advanceTimersByTimeAsync(2000)
    const err = await p
    expect(err).toBeInstanceOf(WorkerProjectionError)
    expect((err as WorkerProjectionError).attempts.map((a) => a.stage)).toEqual([
      'verify',
      'verify',
    ])
    expect(new AttemptTimeoutError('verify', 5).message).toContain('5 ms')
  })

  it('checkStatusAnswers accepts only an entry-installed status from every worker', () => {
    expect(checkStatusAnswers([OK, OK])).toBeNull()
    expect(checkStatusAnswers([])).toBe('no worker answered')
    expect(checkStatusAnswers([OK, null])).toBe('1 of 2 worker(s) without the handler')
    expect(checkStatusAnswers([{ ...OK, crs: 'EPSG:3857' }])).not.toBeNull()
    expect(checkStatusAnswers(undefined)).not.toBeNull()
    // The B1.5.1 answer (handler installed by a later import) no longer passes.
    expect(checkStatusAnswers([{ crs: PROJECTION_CRS, handler: true }])).toBe(
      '1 worker(s) whose handler was not installed by the worker entry',
    )
    expect(checkStatusAnswers([OK, { ...OK, messagesBeforeInstall: 3 }, null])).toBe(
      '1 of 3 worker(s) without the handler; 1 worker(s) received messages before the handler was installed',
    )
    expect(isWorkerProjectionStatus(OK)).toBe(true)
    expect(isWorkerProjectionStatus({ ...OK, handler: 'yes' })).toBe(false)
  })
})
