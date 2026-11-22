/**
 * DEVELOPMENT ONLY (Phase 2.4D B1.5.1, defect A): registration of the `roadpilot:scs` projection
 * handler in every MapLibre worker, including workers created after the first map. Free of
 * MapLibre and of the DOM; `main.ts` passes the MapLibre functions in (`WorkerPoolPort`).
 *
 * What MapLibre 6.19.0 does (source: `dist/maplibre-gl-dev.mjs`, `maplibre-gl-worker-dev.mjs`):
 * - The global worker pool terminates its workers when the last map is removed
 *   (`WorkerPool.release`) and starts new ones for the next map. It may also restart them
 *   (`WorkerPool.restart`, after an unanswered ping on return to the foreground).
 * - `importScriptInWorkers(url)` remembers the url, and the global dispatcher sends it to every new
 *   worker (`GlobalDispatcher.buildActors`), firing `workerscreate`.
 * - In the worker the import is an asynchronous module import (`_importScript`), and other
 *   messages are handled meanwhile. A GeoJSON load that runs before the import has finished finds
 *   no handler: MapLibre warns once ("drawn in the wrong place") and tiles without it.
 *
 * So the replay alone is not enough. This module:
 * 1. calls `keepWorkersAlive` (MapLibre `prewarm()`) once, so removing a map no longer terminates
 *    the workers and the next map reuses workers whose import has finished;
 * 2. awaits `importScript` (resolves after every current worker finished the import) and then
 *    asks every current worker for its status (`PROJECTION_STATUS_MESSAGE`); only a status from
 *    every worker counts. A worker without the handler answers `null` (MapLibre answers unknown
 *    message types with `null`), so a missing handler can never pass as registered;
 * 3. counts worker generations (`workerscreate`). Workers recreated after registration make the
 *    state `stale` and notify `onRecreated`, so the lab registers again and reloads its data.
 *
 * Concurrent callers share one registration; a failure is not cached, so the next call retries.
 * Every attempt is bounded by `attemptTimeoutMs`, and every failure is kept in `status().attempts`.
 */

/** Message type of the status handler that `scsProjection.worker.mjs` registers in each worker. */
export const PROJECTION_STATUS_MESSAGE = 'roadpilot:scsProjectionStatus'

/** CRS name the worker status must report. */
export const PROJECTION_CRS = 'roadpilot:scs'

export const DEFAULT_ATTEMPTS = 3
export const DEFAULT_ATTEMPT_TIMEOUT_MS = 15_000

/** The answer of one worker that has the handler (see `scsProjection.worker.mjs`). */
export interface WorkerProjectionStatus {
  crs: typeof PROJECTION_CRS
  handler: true
}

/** The MapLibre functions the registry uses; `main.ts` binds them, tests fake them. */
export interface WorkerPoolPort {
  /** MapLibre `prewarm()`: keeps the global worker pool when the last map is removed. */
  keepWorkersAlive(): void
  /** MapLibre `importScriptInWorkers(url)`: resolves once every current worker imported it. */
  importScript(url: string): Promise<unknown>
  /** `getGlobalDispatcher().broadcast(type, data)`: one answer per current worker. */
  broadcast(type: string): Promise<unknown[]>
  /** `getGlobalDispatcher().on('workerscreate', fn)`; returns the remover. */
  onWorkersCreated(listener: () => void): () => void
}

export interface Timers {
  setTimeout(fn: () => void, ms: number): unknown
  clearTimeout(id: unknown): void
}

const realTimers: Timers = {
  setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
  clearTimeout: (id) => globalThis.clearTimeout(id as ReturnType<typeof setTimeout>),
}

export type RegistrationStage = 'import' | 'verify' | 'recreated'

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
  return (
    v !== null &&
    typeof v === 'object' &&
    (v as WorkerProjectionStatus).crs === PROJECTION_CRS &&
    (v as WorkerProjectionStatus).handler === true
  )
}

/** Checks the answers of a status broadcast; returns the problem, or null when every worker has it. */
export function checkStatusAnswers(answers: unknown): string | null {
  if (!Array.isArray(answers)) return 'status broadcast returned no list'
  if (answers.length === 0) return 'no worker answered'
  const missing = answers.filter((a) => !isWorkerProjectionStatus(a)).length
  return missing === 0 ? null : `${missing} of ${answers.length} worker(s) without the handler`
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
  scriptUrl: string,
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
  let subscribed = false
  let inflight: Promise<ReadyInfo> | null = null
  const attempts: AttemptRecord[] = []
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
    attempts.push({ attempt, stage, generation, error: text(error) })
    if (attempts.length > 50) attempts.shift()
  }

  const register = async (): Promise<ReadyInfo> => {
    if (!subscribed) {
      // Subscribe before the first workers exist, so every worker set is counted.
      port.onWorkersCreated(onWorkersCreated)
      subscribed = true
    }
    if (!keepAlive) {
      port.keepWorkersAlive()
      keepAlive = true
    }
    const failed: AttemptRecord[] = []
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      let stage: RegistrationStage = 'import'
      try {
        await bounded(port.importScript(scriptUrl), 'import')
        // The import created the workers if there were none, so the generation is read now.
        const gen = generation
        stage = 'verify'
        const answers = await bounded(port.broadcast(PROJECTION_STATUS_MESSAGE), 'verify')
        const problem = checkStatusAnswers(answers)
        if (problem) throw new Error(problem)
        if (generation !== gen) {
          stage = 'recreated'
          throw new Error(`workers were recreated during registration (${gen} → ${generation})`)
        }
        ready = { generation: gen, workers: (answers as unknown[]).length }
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
    }),
    onRecreated(listener) {
      recreatedListeners.add(listener)
      return () => recreatedListeners.delete(listener)
    },
  }
}
