/**
 * DEVELOPMENT ONLY (Phase 2.4D B1.5.1, corrected in B1.5.3): the `roadpilot:scs` projection
 * handler in every MapLibre worker, including workers created after the first map. Free of
 * MapLibre and of the DOM; `main.ts` passes the MapLibre functions in (`WorkerPoolPort`).
 *
 * What MapLibre 6.19.0 does (source: `dist/maplibre-gl-dev.mjs`, `maplibre-gl-worker-dev.mjs`):
 * - The global worker pool terminates its workers when the last map is removed
 *   (`WorkerPool.release`) and starts new ones for the next map. It also restarts them
 *   (`WorkerPool.restart`, after an unanswered ping on return to the foreground), and every map
 *   then reloads its sources into the new workers on its own (`Map._handleWorkersRestarted`).
 * - Every worker is started from `config.WORKER_URL` (`setWorkerUrl`) by `workerFactory`, as a
 *   same-origin module worker unless the URL ends in `.cjs`.
 *
 * B1.5.1 sent the handler with `importScriptInWorkers`, an asynchronous import in the worker.
 * B1.5.2 showed MapLibre's own reload after `WorkerPool.restart` reaching a new worker before
 * that import had finished (one "no projection handler" warning). The lab cannot hold that
 * reload back, so waiting on the main thread cannot close the race.
 *
 * B1.5.3, primary mechanism: MapLibre starts every worker from the lab's own entry module
 * (`scsWorkerEntry.mjs`, set here through `setWorkerUrl` before any worker exists). The entry
 * evaluates MapLibre's worker module and installs the handler in one synchronous module
 * evaluation, so a worker has the handler before it can handle any message, in every generation.
 *
 * Secondary verification (kept from B1.5.1):
 * 1. `keepWorkersAlive` (MapLibre `prewarm()`) once, so removing a map does not end the workers;
 * 2. every current worker is asked for its status (`PROJECTION_STATUS_MESSAGE`); only a status
 *    from every worker counts, and only one the entry installed before any message arrived
 *    (`source`, `messagesBeforeInstall`). A worker without the handler answers `null` (MapLibre
 *    answers unknown message types with `null`), so a missing handler never passes;
 * 3. worker generations are counted (`workerscreate`). Workers recreated after a verification make
 *    the state `stale` and notify `onRecreated`; the lab verifies again and reloads its data.
 *
 * Concurrent callers share one verification; a failure is not cached, so the next call retries.
 * Every attempt is bounded by `attemptTimeoutMs`, and every failure is kept in `status().attempts`.
 */

/** Message type of the status handler that `scsProjection.worker.mjs` registers in each worker. */
export const PROJECTION_STATUS_MESSAGE = 'roadpilot:scsProjectionStatus'

/** CRS name the worker status must report. */
export const PROJECTION_CRS = 'roadpilot:scs'

/** How the handler must have been installed: by the worker entry, during worker start. */
export const PROJECTION_SOURCE = 'worker-entry'

export const DEFAULT_ATTEMPTS = 3
export const DEFAULT_ATTEMPT_TIMEOUT_MS = 15_000

/** The answer of one worker that has the handler (see `scsProjection.worker.mjs`). */
export interface WorkerProjectionStatus {
  crs: typeof PROJECTION_CRS
  handler: true
  source: typeof PROJECTION_SOURCE
  /** Message events the worker received before the handler was installed; must be 0. */
  messagesBeforeInstall: 0
}

/** The MapLibre functions the registry uses; `main.ts` binds them, tests fake them. */
export interface WorkerPoolPort {
  /** MapLibre `setWorkerUrl(url)`: the script every new worker is started from. */
  setWorkerUrl(url: string): void
  /** MapLibre `getWorkerUrl()`. */
  getWorkerUrl(): string | undefined
  /** MapLibre `prewarm()`: keeps the global worker pool when the last map is removed. */
  keepWorkersAlive(): void
  /** `getGlobalDispatcher().broadcast(type, data)`: one answer per current worker. */
  broadcast(type: string): Promise<unknown[]>
  /** `getGlobalDispatcher().on('workerscreate', fn)`; returns the remover. */
  onWorkersCreated(listener: () => void): () => void
  /** `getGlobalDispatcher().on('error', fn)` (MapLibre: "Worker failed to load"); optional. */
  onWorkerError?(listener: (message: string) => void): () => void
}

export interface Timers {
  setTimeout(fn: () => void, ms: number): unknown
  clearTimeout(id: unknown): void
}

const realTimers: Timers = {
  setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
  clearTimeout: (id) => globalThis.clearTimeout(id as ReturnType<typeof setTimeout>),
}

export type RegistrationStage = 'entry' | 'verify' | 'recreated'

export interface AttemptRecord {
  attempt: number
  stage: RegistrationStage
  generation: number
  error: string
}

export type RegistrationState = 'idle' | 'registering' | 'ready' | 'stale' | 'failed'

export interface ReadyInfo {
  /** Worker generation the registration was verified for. */
  generation: number
  /** Number of workers that reported the handler. */
  workers: number
}

export interface WorkerProjectionSnapshot {
  state: RegistrationState
  /** Increases with every `workerscreate` (the first set of workers is generation 1). */
  generation: number
  ready: ReadyInfo | null
  /** Failed attempts, oldest first (kept across calls, at most 50). */
  attempts: AttemptRecord[]
  /** Worker sets created after a successful registration. */
  recreations: number
  keepAlive: boolean
  /** The worker entry MapLibre starts workers from, once configured (B1.5.3). */
  workerUrl: string | null
  /** Worker errors MapLibre reported (e.g. a worker that failed to load), oldest first, at most 20. */
  workerErrors: string[]
}

export class WorkerProjectionError extends Error {
  constructor(readonly attempts: readonly AttemptRecord[]) {
    super(
      `MapLibre workers have no verified roadpilot:scs projection handler after ${attempts.length} attempt(s)` +
        (attempts.length
          ? `: ${attempts.map((a) => `#${a.attempt} ${a.stage} (generation ${a.generation}): ${a.error}`).join('; ')}`
          : ''),
    )
    this.name = 'WorkerProjectionError'
  }
}

export class AttemptTimeoutError extends Error {
  constructor(stage: RegistrationStage, ms: number) {
    super(`${stage} did not finish within ${ms} ms`)
    this.name = 'AttemptTimeoutError'
  }
}

export function isWorkerProjectionStatus(v: unknown): v is WorkerProjectionStatus {
  if (v === null || typeof v !== 'object') return false
  const s = v as Partial<WorkerProjectionStatus>
  return (
    s.crs === PROJECTION_CRS &&
    s.handler === true &&
    s.source === PROJECTION_SOURCE &&
    s.messagesBeforeInstall === 0
  )
}

/** Checks the answers of a status broadcast; returns the problem, or null when every worker has it. */
export function checkStatusAnswers(answers: unknown): string | null {
  if (!Array.isArray(answers)) return 'status broadcast returned no list'
  if (answers.length === 0) return 'no worker answered'
  let without = 0
  let notEntry = 0
  let late = 0
  for (const a of answers) {
    if (isWorkerProjectionStatus(a)) continue
    const s = (a ?? {}) as Partial<Record<keyof WorkerProjectionStatus, unknown>>
    if (typeof a !== 'object' || s.crs !== PROJECTION_CRS || s.handler !== true) without++
    else if (s.source !== PROJECTION_SOURCE) notEntry++
    else late++
  }
  const problems = [
    without && `${without} of ${answers.length} worker(s) without the handler`,
    notEntry && `${notEntry} worker(s) whose handler was not installed by the worker entry`,
    late && `${late} worker(s) received messages before the handler was installed`,
  ].filter(Boolean)
  return problems.length ? problems.join('; ') : null
}

const text = (e: unknown) => (e instanceof Error ? `${e.name}: ${e.message}` : String(e))

export interface WorkerProjection {
  /** Resolves once every current worker reported the handler; rejects with `WorkerProjectionError`. */
  ensureReady(): Promise<ReadyInfo>
  /** Whether the handler is verified for the current worker generation. */
  isReady(): boolean
  status(): WorkerProjectionSnapshot
  /** Called with the new generation when workers are recreated after a registration. */
  onRecreated(listener: (generation: number) => void): () => void
}

export function createWorkerProjection(
  port: WorkerPoolPort,
  entryUrl: string,
  options: { attempts?: number; attemptTimeoutMs?: number; timers?: Timers } = {},
): WorkerProjection {
  const maxAttempts = options.attempts ?? DEFAULT_ATTEMPTS
  const timeoutMs = options.attemptTimeoutMs ?? DEFAULT_ATTEMPT_TIMEOUT_MS
  const timers = options.timers ?? realTimers
  let state: RegistrationState = 'idle'
  let generation = 0
  let ready: ReadyInfo | null = null
  let recreations = 0
  let keepAlive = false
  let workerUrl: string | null = null
  let subscribed = false
  let inflight: Promise<ReadyInfo> | null = null
  const attempts: AttemptRecord[] = []
  const workerErrors: string[] = []
  const recreatedListeners = new Set<(generation: number) => void>()

  const onWorkersCreated = () => {
    generation++
    if (ready && ready.generation !== generation) {
      ready = null
      recreations++
      if (state === 'ready') state = 'stale'
      for (const l of [...recreatedListeners]) l(generation)
    }
  }

  const onWorkerError = (message: string) => {
    workerErrors.push(message)
    if (workerErrors.length > 20) workerErrors.shift()
  }

  const bounded = <T>(promise: Promise<T>, stage: RegistrationStage): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      const timer = timers.setTimeout(
        () => reject(new AttemptTimeoutError(stage, timeoutMs)),
        timeoutMs,
      )
      promise.then(
        (v) => {
          timers.clearTimeout(timer)
          resolve(v)
        },
        (e: unknown) => {
          timers.clearTimeout(timer)
          reject(e)
        },
      )
    })

  const record = (attempt: number, stage: RegistrationStage, error: unknown) => {
    const errors = workerErrors.length ? ` (worker errors: ${workerErrors.join(' | ')})` : ''
    attempts.push({ attempt, stage, generation, error: text(error) + errors })
    if (attempts.length > 50) attempts.shift()
  }

  /**
   * The worker entry must be MapLibre's worker URL before the first worker starts (`prewarm()`
   * starts them). Workers that already run another script cannot get the handler from it; the
   * verification below finds them (no status answer) and fails.
   */
  const configureEntry = () => {
    if (workerUrl === entryUrl && port.getWorkerUrl() === entryUrl) return
    if (port.getWorkerUrl() !== entryUrl) port.setWorkerUrl(entryUrl)
    const actual = port.getWorkerUrl()
    if (actual !== entryUrl)
      throw new Error(`MapLibre worker URL is ${String(actual)}, expected the entry ${entryUrl}`)
    workerUrl = entryUrl
  }

  const register = async (): Promise<ReadyInfo> => {
    if (!subscribed) {
      // Subscribe before the first workers exist, so every worker set is counted.
      port.onWorkersCreated(onWorkersCreated)
      port.onWorkerError?.(onWorkerError)
      subscribed = true
    }
    const failed: AttemptRecord[] = []
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      let stage: RegistrationStage = 'entry'
      try {
        configureEntry()
        if (!keepAlive) {
          port.keepWorkersAlive()
          keepAlive = true
        }
        stage = 'verify'
        const before = generation
        const answers = await bounded(port.broadcast(PROJECTION_STATUS_MESSAGE), 'verify')
        const problem = checkStatusAnswers(answers)
        if (problem) throw new Error(problem)
        if (generation === 0) throw new Error('no workerscreate event was observed')
        if (before !== 0 && generation !== before) {
          stage = 'recreated'
          throw new Error(`workers were recreated during verification (${before} → ${generation})`)
        }
        ready = { generation, workers: (answers as unknown[]).length }
        state = 'ready'
        return ready
      } catch (e) {
        record(attempt, stage, e)
        failed.push(attempts[attempts.length - 1]!)
      }
    }
    state = 'failed'
    throw new WorkerProjectionError(failed)
  }

  return {
    ensureReady() {
      if (state === 'ready' && ready && ready.generation === generation)
        return Promise.resolve(ready)
      if (!inflight) {
        state = 'registering'
        inflight = register().finally(() => {
          inflight = null
        })
      }
      return inflight
    },
    isReady: () => state === 'ready' && ready !== null && ready.generation === generation,
    status: () => ({
      state,
      generation,
      ready: ready && { ...ready },
      attempts: attempts.map((a) => ({ ...a })),
      recreations,
      keepAlive,
      workerUrl,
      workerErrors: workerErrors.slice(),
    }),
    onRecreated(listener) {
      recreatedListeners.add(listener)
      return () => recreatedListeners.delete(listener)
    },
  }
}
