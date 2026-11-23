/**
 * B1.5.3: RoadPilot's MapLibre worker entry (`scsWorkerEntry.mjs`).
 *
 * Three levels:
 * 1. structure: import order and a synchronous body, and the MapLibre worker bundle pinned to the
 *    exact file whose source was inspected (no imports, no top-level `await`, worker set up by its
 *    last statement); a different file must be inspected again before this test is updated;
 * 2. the real MapLibre 6.19.0 worker bundle evaluated through the entry in a simulated worker
 *    scope (jsdom window posing as `WorkerGlobalScope`), answering through MapLibre's own actor;
 * 3. the worker-side install and bootstrap logic against fake scopes.
 * None of this proves the behaviour of a real browser worker; see docs/maplibre-validation.md.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import entrySource from '../scsWorkerEntry.mjs?raw'
import packageWorkerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?url'
import packageWorkerSource from 'maplibre-gl/dist/maplibre-gl-worker.mjs?raw'
import { CARRIER_SCALE, SCS_DEFINITION, scsConversion, toCarrier, toDisplay } from '../coordinates'
import {
  bootstrapScsWorker,
  installScsProjection,
  ScsWorkerBootstrapError,
  scsProjectionHandler,
  STATUS_CRS,
  STATUS_MESSAGE,
  STATUS_SOURCE,
} from '../scsProjection.worker.mjs'
import {
  checkStatusAnswers,
  PROJECTION_CRS,
  PROJECTION_SOURCE,
  PROJECTION_STATUS_MESSAGE,
} from '../workerProjection'

const MAPLIBRE_WORKER = '/node_modules/maplibre-gl/dist/maplibre-gl-worker.mjs'
/** SHA-256 of maplibre-gl@6.19.0 `dist/maplibre-gl-worker.mjs`, the file inspected in B1.5.3. */
const INSPECTED_WORKER_SHA256 = 'c8564c4a4147326a587c9cc4c2a871c4b02a6c37c3f1ea51da55be3220d4b112'

const code = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

describe('scsWorkerEntry.mjs structure', () => {
  const body = code(entrySource)
  const imports = [...body.matchAll(/^import\s+(?:\{[^}]*\}\s+from\s+)?'([^']+)'/gm)].map(
    (m) => m[1],
  )

  it('imports the probe, then MapLibre’s worker, then the projection module, in that order', () => {
    expect(imports).toEqual(['./scsWorkerProbe.mjs', MAPLIBRE_WORKER, './scsProjection.worker.mjs'])
  })

  it('installs synchronously: one bootstrap call, no await, no dynamic import, no other code', () => {
    const statements = body
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith('import '))
    expect(statements).toEqual(['bootstrapScsWorker(self, probe)'])
    expect(body).not.toMatch(/\bawait\b|\bimport\s*\(|\bthen\s*\(|setTimeout|queueMicrotask/)
  })

  it('imports the package’s own worker file by the URL the dev server serves it under', () => {
    expect(packageWorkerUrl).toBe(MAPLIBRE_WORKER)
  })

  it('MapLibre’s worker bundle is the inspected file (no imports, no top-level await)', async () => {
    const src = packageWorkerSource
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(src))
    const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
    expect(hex).toBe(INSPECTED_WORKER_SHA256)
    // The facts the ordering relies on, re-checked cheaply on the pinned file:
    expect(src.trimEnd()).toMatch(
      /Oe\(self\)&&\(self\.worker=new yT\(self\)\);export\{yT as default\};\n\/\/# sourceMappingURL=maplibre-gl-worker\.mjs\.map$/,
    )
    expect(src).toMatch(/this\.self\.setProjectionHandler=/)
    expect(src).not.toMatch(/^import[\s{"'*]/m)
  })
})

describe('scsWorkerEntry.mjs with the real MapLibre worker bundle (simulated worker scope)', () => {
  afterEach(() => {
    const scope = self as unknown as Record<string, unknown> & {
      worker?: { actor?: { remove(): void } }
    }
    scope.worker?.actor?.remove()
    for (const k of ['worker', 'setProjectionHandler', 'registerWorkerSource', 'addProtocol'])
      delete scope[k]
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('a message dispatched right after the worker starts is answered by the installed handler', async () => {
    // MapLibre's isWorker(): `self instanceof WorkerGlobalScope`.
    vi.stubGlobal(
      'WorkerGlobalScope',
      class {
        static [Symbol.hasInstance](v: unknown) {
          return v === globalThis
        }
      },
    )
    // MapLibre's serialize() tests `instanceof ImageData`, which jsdom lacks.
    vi.stubGlobal('ImageData', class {})
    const posted: { id?: string; type?: string; error?: unknown; data?: unknown }[] = []
    vi.spyOn(window, 'postMessage').mockImplementation((m: unknown) => {
      posted.push(m as (typeof posted)[number])
    })
    const setHandler = vi.fn()
    vi.resetModules()
    const { probe } = await import('../scsWorkerProbe.mjs')
    // MapLibre assigns `self.setProjectionHandler` while its module is evaluated; the entry body
    // then calls it. The accessor keeps MapLibre's function and lets the test count the calls.
    let real: unknown = null
    Object.defineProperty(self, 'setProjectionHandler', {
      configurable: true,
      get: () => (real ? setHandler : undefined),
      set: (v: unknown) => {
        real = v
        setHandler.mockImplementation(v as () => void)
      },
    })
    await import('../scsWorkerEntry.mjs')
    // The module instance the entry imported (modules were reset above).
    const used = await import('../scsProjection.worker.mjs')

    const scope = self as unknown as { worker?: { actor?: unknown } }
    expect(scope.worker?.actor).toBeTruthy() // MapLibre's worker set itself up
    expect(setHandler).toHaveBeenCalledTimes(1) // installed once, during the evaluation
    expect(setHandler).toHaveBeenCalledWith(used.scsProjectionHandler)
    expect(probe).toEqual({ messages: 0, installed: true })

    // First message after the start, through MapLibre's own Actor (queued, handled in a later task).
    window.dispatchEvent(
      new MessageEvent('message', {
        data: { id: 'm1', type: STATUS_MESSAGE, origin: location.origin, data: null },
      }),
    )
    await vi.waitFor(() => expect(posted.some((m) => m.id === 'm1')).toBe(true))
    const answer = posted.find((m) => m.id === 'm1')!
    expect(answer.type).toBe('<response>')
    expect(answer.error ?? null).toBeNull()
    expect(answer.data).toMatchObject({
      crs: PROJECTION_CRS,
      handler: true,
      source: PROJECTION_SOURCE,
      messagesBeforeInstall: 0,
    })
    expect(checkStatusAnswers([answer.data])).toBeNull()
    // The probe counted the message only after the installation.
    expect(probe.messages).toBe(0)
  })
})

describe('worker install and bootstrap', () => {
  const fakeScope = () => {
    const handlers = new Map<string, () => Promise<unknown>>()
    const scope = {
      setProjectionHandler: vi.fn(),
      close: vi.fn(),
      worker: {
        actor: {
          registerMessageHandler: vi.fn((t: string, h: () => Promise<unknown>) =>
            handlers.set(t, h),
          ),
        },
      },
    }
    return { scope, handlers }
  }

  it('uses the registry’s message, CRS and source names', () => {
    expect(STATUS_MESSAGE).toBe(PROJECTION_STATUS_MESSAGE)
    expect(STATUS_CRS).toBe(PROJECTION_CRS)
    expect(STATUS_SOURCE).toBe(PROJECTION_SOURCE)
    expect(STATUS_CRS).toBe('roadpilot:scs')
  })

  it('bootstrap installs the handler and a status answer the registry accepts', async () => {
    const { scope, handlers } = fakeScope()
    const probe = { messages: 0, installed: false }
    expect(bootstrapScsWorker(scope, probe)).toEqual({
      handler: true,
      status: true,
      duplicate: false,
    })
    expect(probe.installed).toBe(true)
    expect(scope.setProjectionHandler).toHaveBeenCalledWith(scsProjectionHandler)
    expect(scope.close).not.toHaveBeenCalled()
    const status = await handlers.get(STATUS_MESSAGE)!()
    expect(status).toEqual({
      crs: PROJECTION_CRS,
      handler: true,
      source: PROJECTION_SOURCE,
      messagesBeforeInstall: 0,
    })
    expect(checkStatusAnswers([status])).toBeNull()
  })

  it('no duplicate registration: a second install changes nothing', () => {
    const { scope } = fakeScope()
    bootstrapScsWorker(scope, { messages: 0, installed: false })
    expect(installScsProjection(scope)).toEqual({ handler: true, status: true, duplicate: true })
    expect(bootstrapScsWorker(scope)).toMatchObject({ duplicate: true })
    expect(scope.setProjectionHandler).toHaveBeenCalledTimes(1)
    expect(scope.worker.actor.registerMessageHandler).toHaveBeenCalledTimes(1)
  })

  it('messages seen before the install are reported, and the registry rejects that worker', async () => {
    const { scope, handlers } = fakeScope()
    bootstrapScsWorker(scope, { messages: 2, installed: false })
    const status = await handlers.get(STATUS_MESSAGE)!()
    expect(status).toMatchObject({ messagesBeforeInstall: 2 })
    expect(checkStatusAnswers([status])).toBe(
      '1 worker(s) received messages before the handler was installed',
    )
  })

  it('registration failure: no setProjectionHandler closes the worker and throws loudly', () => {
    const { scope } = fakeScope()
    const broken = { ...scope, setProjectionHandler: undefined }
    expect(() => bootstrapScsWorker(broken, { messages: 0, installed: false })).toThrow(
      ScsWorkerBootstrapError,
    )
    expect(scope.close).toHaveBeenCalledTimes(1)
    expect(scope.worker.actor.registerMessageHandler).not.toHaveBeenCalled()
  })

  it('registration failure: no actor (no status answer possible) also closes and throws', () => {
    const scope = { setProjectionHandler: vi.fn(), close: vi.fn() }
    expect(() => bootstrapScsWorker(scope)).toThrow(/no registerMessageHandler; worker closed/)
    expect(scope.close).toHaveBeenCalledTimes(1)
  })

  it('install falls back to self.actor and reports a missing scope', () => {
    const handlers = new Map<string, unknown>()
    expect(
      installScsProjection({
        setProjectionHandler: () => undefined,
        actor: {
          registerMessageHandler: (t: string, h: () => Promise<unknown>) => handlers.set(t, h),
        },
      }),
    ).toEqual({ handler: true, status: true, duplicate: false })
    expect(handlers.has(STATUS_MESSAGE)).toBe(true)
    expect(installScsProjection(undefined)).toEqual({
      handler: false,
      status: false,
      duplicate: false,
    })
  })

  it('the handler is the (X, −Z) display plane through the /2048 API carrier', () => {
    expect(CARRIER_SCALE).toBe(2048)
    expect(SCS_DEFINITION).toBe('roadpilot:scs;carrier=2048')
    const h = scsProjectionHandler(SCS_DEFINITION)
    for (const p of [
      { x: 0, z: 0 },
      { x: 12_345.5, z: -70_000.25 },
      { x: -131_072, z: 131_072 },
    ]) {
      const carrier = toCarrier(p)
      expect(carrier).toEqual([p.x / 2048, -p.z / 2048])
      expect(h.forward(carrier)).toEqual(toDisplay(p)) // [X, −Z], exact
      expect(h.forward(carrier)).toEqual(scsConversion.forward(carrier))
      expect(h.inverse(h.forward(carrier))).toEqual(carrier)
    }
    expect(() => scsProjectionHandler('roadpilot:scs;carrier=abc')).toThrow()
  })
})
