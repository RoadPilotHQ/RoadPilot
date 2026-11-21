/**
 * DEVELOPMENT ONLY (Phase 2.4D B1.2): lifecycle helpers of the MapLibre lab, free of MapLibre and
 * of the DOM so that they can be unit-tested with fake emitters and timers.
 *
 * - `LoadSession` (F2, F3): owns every listener and every pending wait of one map load. A wait
 *   settles exactly once: with its event, with a `LoadTimeoutError` after its timeout, or with a
 *   `ReleasedError` when the session is released. Releasing removes every listener the session
 *   added, rejects every pending wait, and is safe to call more than once. Results that arrive
 *   after a release are ignored.
 * - `createRetryableInit` (F4): a shared, retryable one-time initialisation. Concurrent callers
 *   share one promise; a failure is not cached, and steps that already succeeded are not repeated
 *   on retry (so the CRS is registered and the worker handler imported at most once each).
 *
 * MapLibre's worker pool is global and lives as long as the page; nothing here stops it.
 */

/** Default time a map may take to load its style or its data before the lab reports an error. */
export const DEFAULT_LOAD_TIMEOUT_MS = 60_000

export class LoadTimeoutError extends Error {
  constructor(
    readonly label: string,
    readonly timeoutMs: number,
    readonly details: readonly string[] = [],
  ) {
    super(
      `${label} did not finish within ${timeoutMs} ms` +
        (details.length ? ` (${details.join('; ')})` : ''),
    )
    this.name = 'LoadTimeoutError'
  }
}

export class ReleasedError extends Error {
  constructor(readonly label: string) {
    super(`${label} cancelled: the map was released`)
    this.name = 'ReleasedError'
  }
}

export type Listener = (event: unknown) => void

/** The part of MapLibre's `Map` (or any evented object) the session needs. */
export interface Emitter {
  on(type: string, listener: Listener): unknown
  off(type: string, listener: Listener): unknown
}

export interface Timers {
  setTimeout(fn: () => void, ms: number): unknown
  clearTimeout(id: unknown): void
}

const realTimers: Timers = {
  setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
  clearTimeout: (id) => globalThis.clearTimeout(id as ReturnType<typeof setTimeout>),
}

export interface WaitOptions {
  label: string
  /** Milliseconds; `Infinity` waits without a timeout (release still settles it). */
  timeoutMs: number
  /** Extra information for the timeout message, read when the timeout fires. */
  details?: () => string[]
}

export class LoadSession {
  private readonly listeners = new Set<{ emitter: Emitter; type: string; fn: Listener }>()
  private readonly cancels = new Set<(error: Error) => void>()
  private releasedFlag = false

  constructor(private readonly timers: Timers = realTimers) {}

  get released(): boolean {
    return this.releasedFlag
  }

  /** Listeners currently attached through this session. */
  get listenerCount(): number {
    return this.listeners.size
  }

  /** Pending waits and guarded promises. */
  get pendingCount(): number {
    return this.cancels.size
  }

  /**
   * Attaches a listener that the session removes on release. Returns its remover (idempotent).
   * After release nothing is attached.
   */
  on(emitter: Emitter, type: string, fn: Listener): () => void {
    if (this.releasedFlag) return () => {}
    const entry = { emitter, type, fn }
    this.listeners.add(entry)
    emitter.on(type, fn)
    return () => {
      if (!this.listeners.delete(entry)) return
      emitter.off(type, fn)
    }
  }

  /** Throws `ReleasedError` once released; call after every `await` before touching the map. */
  throwIfReleased(label: string): void {
    if (this.releasedFlag) throw new ReleasedError(label)
  }

  /** Resolves with the first `type` event for which `until` holds (every event if none). */
  wait(
    emitter: Emitter,
    type: string,
    options: WaitOptions & { until?: (event: unknown) => boolean },
  ): Promise<unknown> {
    return this.pending(options, (resolve, reject) =>
      this.on(emitter, type, (event) => {
        try {
          if (!options.until || options.until(event)) resolve(event)
        } catch (e) {
          reject(e as Error)
        }
      }),
    )
  }

  /** Settles like `promise`, unless the timeout or a release comes first; later results are ignored. */
  guard<T>(promise: Promise<T>, options: WaitOptions): Promise<T> {
    return this.pending<T>(options, (resolve, reject) => {
      promise.then(resolve, (e: unknown) => reject(e instanceof Error ? e : new Error(String(e))))
      return () => {}
    })
  }

  /** Removes every listener and rejects every pending wait with `ReleasedError`. Idempotent. */
  release(): void {
    if (this.releasedFlag) return
    this.releasedFlag = true
    for (const cancel of [...this.cancels]) cancel(new ReleasedError('load'))
    for (const { emitter, type, fn } of [...this.listeners]) emitter.off(type, fn)
    this.listeners.clear()
  }

  private pending<T>(
    options: WaitOptions,
    start: (resolve: (value: T) => void, reject: (error: Error) => void) => () => void,
  ): Promise<T> {
    if (this.releasedFlag) return Promise.reject(new ReleasedError(options.label))
    return new Promise<T>((resolve, reject) => {
      let settled = false
      let cleanup: (() => void) | null = null
      let timer: unknown = undefined
      const finish = (settle: () => void) => {
        if (settled) return
        settled = true
        if (timer !== undefined) this.timers.clearTimeout(timer)
        this.cancels.delete(cancel)
        cleanup?.()
        settle()
      }
      const cancel = (error: Error) =>
        finish(() =>
          reject(error instanceof ReleasedError ? new ReleasedError(options.label) : error),
        )
      this.cancels.add(cancel)
      if (Number.isFinite(options.timeoutMs))
        timer = this.timers.setTimeout(
          () =>
            finish(() =>
              reject(
                new LoadTimeoutError(options.label, options.timeoutMs, options.details?.() ?? []),
              ),
            ),
          options.timeoutMs,
        )
      const remove = start(
        (value) => finish(() => resolve(value)),
        (error) => finish(() => reject(error)),
      )
      // `start` may already have settled synchronously; remove its listener at once then.
      if (settled) remove()
      else cleanup = remove
    })
  }
}

/**
 * A one-time initialisation made of steps, shared by concurrent callers and retryable after a
 * failure. A step that succeeded is never run again; the first failing step and the ones after it
 * run again on the next call.
 */
export function createRetryableInit(
  steps: readonly { name: string; run: () => void | Promise<void> }[],
): { (): Promise<void>; readonly done: ReadonlySet<string> } {
  const done = new Set<string>()
  let inflight: Promise<void> | null = null
  const init = () => {
    inflight ??= (async () => {
      for (const step of steps) {
        if (done.has(step.name)) continue
        await step.run()
        done.add(step.name)
      }
    })().catch((error: unknown) => {
      inflight = null
      throw error
    })
    return inflight
  }
  return Object.assign(init, { done: done as ReadonlySet<string> })
}
