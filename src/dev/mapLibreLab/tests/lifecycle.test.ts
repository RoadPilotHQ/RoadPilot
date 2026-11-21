/** B1.2 F2–F4: load lifecycle and worker initialisation, with fake emitters and fake timers. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createRetryableInit,
  LoadSession,
  LoadTimeoutError,
  ReleasedError,
  type Emitter,
  type Listener,
} from '../lifecycle'

/** A minimal evented object, like MapLibre's `Map`, that counts its listeners. */
class FakeEmitter implements Emitter {
  private readonly listeners = new Map<string, Set<Listener>>()
  on(type: string, l: Listener) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set())
    this.listeners.get(type)!.add(l)
  }
  off(type: string, l: Listener) {
    this.listeners.get(type)?.delete(l)
  }
  fire(type: string, event: unknown = {}) {
    for (const l of [...(this.listeners.get(type) ?? [])]) l(event)
  }
  count(type?: string): number {
    if (type) return this.listeners.get(type)?.size ?? 0
    let n = 0
    for (const s of this.listeners.values()) n += s.size
    return n
  }
}

/** A promise settled from outside, for controlled asynchronous steps. */
function controlled<T = void>() {
  let resolve!: (v: T) => void
  let reject!: (e: Error) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

const opts = (timeoutMs = 1000) => ({ label: 'style load', timeoutMs })

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

describe('LoadSession: successful initialisation', () => {
  it('resolves with the event and removes its listener', async () => {
    const em = new FakeEmitter()
    const s = new LoadSession()
    const p = s.wait(em, 'load', opts())
    expect(em.count('load')).toBe(1)
    em.fire('load', { ok: true })
    await expect(p).resolves.toEqual({ ok: true })
    expect(em.count('load')).toBe(0)
    expect(s.pendingCount).toBe(0)
    expect(s.listenerCount).toBe(0)
  })

  it('waits for the event that satisfies `until` and ignores the others', async () => {
    const em = new FakeEmitter()
    const s = new LoadSession()
    let frames = 0
    const p = s.wait(em, 'render', { ...opts(), until: () => ++frames === 3 })
    em.fire('render')
    em.fire('render')
    expect(s.pendingCount).toBe(1)
    em.fire('render')
    await p
    em.fire('render')
    expect(frames).toBe(3)
    expect(em.count()).toBe(0)
  })

  it('a timer that would have expired after success changes nothing', async () => {
    const em = new FakeEmitter()
    const s = new LoadSession()
    const p = s.wait(em, 'load', opts(500))
    em.fire('load')
    await p
    vi.advanceTimersByTime(10_000)
    await expect(p).resolves.toBeDefined()
  })

  it('guard passes a successful promise through', async () => {
    const s = new LoadSession()
    await expect(s.guard(Promise.resolve(42), opts())).resolves.toBe(42)
    expect(s.pendingCount).toBe(0)
  })
})

describe('LoadSession: timeout', () => {
  it('rejects with LoadTimeoutError, carries details, and removes the listener', async () => {
    const em = new FakeEmitter()
    const s = new LoadSession()
    const p = s.wait(em, 'load', { ...opts(1000), details: () => ['worker blocked'] })
    const check = expect(p).rejects.toMatchObject({
      name: 'LoadTimeoutError',
      label: 'style load',
      timeoutMs: 1000,
      details: ['worker blocked'],
    })
    vi.advanceTimersByTime(999)
    expect(s.pendingCount).toBe(1)
    vi.advanceTimersByTime(1)
    await check
    await expect(p).rejects.toBeInstanceOf(LoadTimeoutError)
    expect(em.count()).toBe(0)
    expect(s.pendingCount).toBe(0)
  })

  it('an event after the timeout does nothing', async () => {
    const em = new FakeEmitter()
    const s = new LoadSession()
    const p = s.wait(em, 'load', opts(100))
    vi.advanceTimersByTime(100)
    await expect(p).rejects.toBeInstanceOf(LoadTimeoutError)
    em.fire('load')
    await expect(p).rejects.toBeInstanceOf(LoadTimeoutError)
  })

  it('guard times out a promise that never settles', async () => {
    const s = new LoadSession()
    const never = new Promise<void>(() => {})
    const p = s.guard(never, opts(200))
    vi.advanceTimersByTime(200)
    await expect(p).rejects.toBeInstanceOf(LoadTimeoutError)
  })

  it('an error thrown by `until` rejects the wait', async () => {
    const em = new FakeEmitter()
    const s = new LoadSession()
    const p = s.wait(em, 'render', {
      ...opts(),
      until: () => {
        throw new Error('readPixels failed')
      },
    })
    em.fire('render')
    await expect(p).rejects.toThrow('readPixels failed')
    expect(em.count()).toBe(0)
  })
})

describe('LoadSession: release during initialisation', () => {
  it('rejects every pending wait with ReleasedError and removes every listener', async () => {
    const em = new FakeEmitter()
    const s = new LoadSession()
    s.on(em, 'error', () => {})
    s.on(em, 'moveend', () => {})
    const load = s.wait(em, 'load', opts())
    const idle = s.wait(em, 'idle', opts())
    const guarded = s.guard(controlled().promise, opts())
    expect(em.count()).toBe(4)
    s.release()
    await expect(load).rejects.toBeInstanceOf(ReleasedError)
    await expect(idle).rejects.toBeInstanceOf(ReleasedError)
    await expect(guarded).rejects.toBeInstanceOf(ReleasedError)
    await expect(load).rejects.toThrow('style load cancelled')
    expect(em.count()).toBe(0)
    expect(s.listenerCount).toBe(0)
    expect(s.pendingCount).toBe(0)
    expect(s.released).toBe(true)
  })

  it('settles deterministically: the timer of a released wait never fires', async () => {
    const em = new FakeEmitter()
    const s = new LoadSession()
    const p = s.wait(em, 'load', opts(100))
    s.release()
    vi.advanceTimersByTime(1000)
    await expect(p).rejects.toBeInstanceOf(ReleasedError)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('nothing can be started or attached after release', async () => {
    const em = new FakeEmitter()
    const s = new LoadSession()
    s.release()
    await expect(s.wait(em, 'load', opts())).rejects.toBeInstanceOf(ReleasedError)
    await expect(s.guard(Promise.resolve(1), opts())).rejects.toBeInstanceOf(ReleasedError)
    s.on(em, 'render', () => {})
    expect(em.count()).toBe(0)
    expect(() => s.throwIfReleased('configure')).toThrow(ReleasedError)
  })
})

describe('LoadSession: late completion after release', () => {
  it('an event after release reaches no listener', async () => {
    const em = new FakeEmitter()
    const s = new LoadSession()
    let calls = 0
    s.on(em, 'render', () => calls++)
    const p = s.wait(em, 'render', { ...opts(), until: () => (calls++, false) })
    s.release()
    em.fire('render')
    expect(calls).toBe(0)
    await expect(p).rejects.toBeInstanceOf(ReleasedError)
  })

  it('a guarded promise resolving after release is ignored', async () => {
    const s = new LoadSession()
    const late = controlled<string>()
    const p = s.guard(late.promise, opts())
    s.release()
    late.resolve('late data')
    await expect(p).rejects.toBeInstanceOf(ReleasedError)
  })

  it('a guarded promise rejecting after release is ignored (no unhandled rejection)', async () => {
    const s = new LoadSession()
    const late = controlled<void>()
    const p = s.guard(late.promise, opts())
    s.release()
    late.reject(new Error('worker error'))
    await expect(p).rejects.toBeInstanceOf(ReleasedError)
  })
})

describe('LoadSession: repeated release and listener cleanup', () => {
  it('release is idempotent', async () => {
    const em = new FakeEmitter()
    const s = new LoadSession()
    const p = s.wait(em, 'load', opts())
    s.release()
    s.release()
    s.release()
    await expect(p).rejects.toBeInstanceOf(ReleasedError)
    expect(em.count()).toBe(0)
  })

  it('a remover can be called before and after release without double removal', () => {
    const em = new FakeEmitter()
    const s = new LoadSession()
    const a = vi.fn()
    const b = vi.fn()
    const stopA = s.on(em, 'data', a)
    s.on(em, 'data', b)
    stopA()
    stopA()
    expect(em.count('data')).toBe(1)
    expect(s.listenerCount).toBe(1)
    s.release()
    stopA()
    expect(em.count('data')).toBe(0)
    em.fire('data')
    expect(a).not.toHaveBeenCalled()
    expect(b).not.toHaveBeenCalled()
  })

  it('a synchronously settled wait leaves no listener behind', async () => {
    // An emitter that fires immediately when a listener is attached.
    const em: Emitter & { n: number } = {
      n: 0,
      on(_t, l) {
        this.n++
        l({})
      },
      off() {
        this.n--
      },
    }
    const s = new LoadSession()
    await s.wait(em, 'load', opts())
    expect(em.n).toBe(0)
    expect(s.listenerCount).toBe(0)
  })
})

describe('createRetryableInit (F4)', () => {
  function steps(failImportTimes = 0) {
    const calls = { workerUrl: 0, projection: 0, handler: 0 }
    let failures = failImportTimes
    const gate = { current: controlled<void>() }
    const init = createRetryableInit([
      { name: 'workerUrl', run: () => void calls.workerUrl++ },
      {
        name: 'projection',
        run: () => {
          calls.projection++
          if (calls.projection > 1)
            throw new Error('A projection called "roadpilot:scs" already exists.')
        },
      },
      {
        name: 'projectionHandler',
        run: async () => {
          calls.handler++
          await gate.current.promise
          if (failures-- > 0) throw new Error('importScriptInWorkers failed')
        },
      },
    ])
    return { init, calls, gate }
  }

  it('first initialisation succeeds and later calls reuse it', async () => {
    const { init, calls, gate } = steps()
    const p = init()
    gate.current.resolve()
    await p
    await init()
    await init()
    expect(calls).toEqual({ workerUrl: 1, projection: 1, handler: 1 })
    expect([...init.done]).toEqual(['workerUrl', 'projection', 'projectionHandler'])
  })

  it('a failed first attempt is not cached; the retry succeeds without duplicate registration', async () => {
    const { init, calls, gate } = steps(1)
    const first = init()
    gate.current.resolve()
    await expect(first).rejects.toThrow('importScriptInWorkers failed')
    expect(init.done.has('projectionHandler')).toBe(false)
    gate.current = controlled()
    const second = init()
    expect(second).not.toBe(first)
    gate.current.resolve()
    await second
    // Worker URL and CRS once each (a second addProjection would throw); handler retried once.
    expect(calls).toEqual({ workerUrl: 1, projection: 1, handler: 2 })
    await init()
    expect(calls.handler).toBe(2)
  })

  it('concurrent requests share one attempt', async () => {
    const { init, calls, gate } = steps()
    const a = init()
    const b = init()
    const c = init()
    expect(b).toBe(a)
    expect(c).toBe(a)
    gate.current.resolve()
    await Promise.all([a, b, c])
    expect(calls).toEqual({ workerUrl: 1, projection: 1, handler: 1 })
  })

  it('concurrent requests during a failing attempt all see the failure, then one retry', async () => {
    const { init, calls, gate } = steps(1)
    const a = init()
    const b = init()
    gate.current.resolve()
    await expect(a).rejects.toThrow()
    await expect(b).rejects.toThrow()
    gate.current = controlled()
    const c = init()
    const d = init()
    expect(d).toBe(c)
    gate.current.resolve()
    await Promise.all([c, d])
    expect(calls).toEqual({ workerUrl: 1, projection: 1, handler: 2 })
  })
})
