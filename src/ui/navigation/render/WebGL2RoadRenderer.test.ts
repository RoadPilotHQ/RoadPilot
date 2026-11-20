import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ROAD_FLAG_CHORD } from '@/domain/mapTile'
import { fakeCanvas, type FakeGlOptions } from '@/test/fakeWebGL2'
import { tileOf } from '@/test/renderTiles'
import type { RendererStatus } from './types'
import {
  createWebGL2RoadRenderer,
  DEFAULT_CONTEXT_ATTRIBUTES,
  type WebGL2Options,
  type WebGL2RoadRenderer,
} from './WebGL2RoadRenderer'

const CID = '0123456789abcdef'

/** A tile at (x, z) of level `level` with `n` local roads of two segments each. */
function tile(x: number, z = 0, n = 1, extra: { level?: number; contentId?: string } = {}) {
  const roads = Array.from({ length: n }, (_, i) => ({ points: [0, i, 10, i, 20, i] }))
  return tileOf(roads, {
    x,
    z,
    level: extra.level ?? 0,
    originX: x * 1024,
    originZ: z * 1024,
    contentId: extra.contentId ?? CID,
  })
}

/**
 * A renderer on a fake context. Defaults to the M2 behaviour the first test groups were
 * written for: synchronous uploads in `setTiles` and the `coreFringe` stencil mode. The M3
 * groups below pass their own mode and budget.
 */
function setup(gl: FakeGlOptions = {}, options: WebGL2Options = {}) {
  const { canvas, gl: fake } = fakeCanvas(gl)
  const statuses: RendererStatus[] = []
  const result = createWebGL2RoadRenderer(canvas, {
    onStatus: (s) => statuses.push(s),
    uploadBudgetMs: Infinity,
    stencilMode: 'coreFringe',
    ...options,
  })
  if (!result.ok) throw new Error(`creation failed: ${result.reason}`)
  const r = result.renderer
  r.resize(800, 600, 1)
  r.setView({ cx: 1024, cz: 0, scale: 0.25 })
  return { canvas, gl: fake!, r, statuses }
}

beforeEach(() => {
  vi.stubGlobal('WebGL2RenderingContext', class {})
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('creating the WebGL 2 renderer', () => {
  it('requests the M1 context attributes', () => {
    const { canvas } = fakeCanvas()
    const spy = vi.fn(canvas.getContext)
    canvas.getContext = spy as never
    createWebGL2RoadRenderer(canvas)
    expect(spy).toHaveBeenCalledWith('webgl2', DEFAULT_CONTEXT_ATTRIBUTES)
    expect(DEFAULT_CONTEXT_ATTRIBUTES).toMatchObject({
      antialias: false,
      alpha: true,
      premultipliedAlpha: true,
      preserveDrawingBuffer: false,
      depth: false,
      stencil: true,
      powerPreference: 'default',
      failIfMajorPerformanceCaveat: true,
    })
  })

  it('reports WebGL 2 as unavailable when the browser has no WebGL 2', () => {
    vi.unstubAllGlobals()
    const { canvas } = fakeCanvas()
    expect(createWebGL2RoadRenderer(canvas)).toMatchObject({
      ok: false,
      reason: 'webgl2_unavailable',
      gpu: { gpuClass: 'UNAVAILABLE' },
    })
  })

  it('reports a failed context creation', () => {
    const { canvas } = fakeCanvas(null)
    expect(createWebGL2RoadRenderer(canvas)).toMatchObject({
      ok: false,
      reason: 'context_creation_failed',
    })
  })

  it('reports a shader compile error with its log, and frees what it created', () => {
    for (const failCompile of ['vertex', 'fragment'] as const) {
      const { canvas, gl } = fakeCanvas({ failCompile })
      const result = createWebGL2RoadRenderer(canvas)
      expect(result).toMatchObject({ ok: false, reason: 'shader_compile' })
      expect(!result.ok && result.detail).toContain(failCompile)
      expect(gl!.liveCount('shader')).toBe(0)
    }
  })

  it('reports a link error and frees the program', () => {
    const { canvas, gl } = fakeCanvas({ failLink: true })
    expect(createWebGL2RoadRenderer(canvas)).toMatchObject({
      ok: false,
      reason: 'program_link',
      detail: 'fake link error',
    })
    expect(gl!.liveCount('program')).toBe(0)
    expect(gl!.liveCount('shader')).toBe(0)
  })
})

describe('buffers and vertex arrays', () => {
  it('uploads one buffer per tile with one vertex array per non-empty class', () => {
    const { gl, r } = setup()
    const t = tileOf([
      { roadClass: 'motorway', points: [0, 0, 10, 0] },
      { roadClass: 'rail', points: [0, 5, 10, 5] },
    ])
    r.setTiles([{ ...t, contentId: CID }])
    expect(gl.bufferDataCalls).toBe(1)
    expect(gl.uploadedBytes).toBe(2 * 24)
    expect(gl.liveCount('buffer')).toBe(1)
    expect(gl.liveCount('vao')).toBe(2)
    const stats = r.render()
    expect(stats).toMatchObject({ buffers: 1, vertexArrays: 2, gpuBytes: 48, uploads: 1 })
  })

  it('sets instanced attributes: divisor 1, integer pointer for class and flags', () => {
    const { gl, r } = setup()
    r.setTiles([tile(0)])
    const divisors = gl.calls.filter((c) => c.name === 'vertexAttribDivisor')
    expect(divisors.map((c) => c.args)).toEqual([
      [0, 1],
      [1, 1],
      [2, 1],
      [3, 1],
    ])
    const ip = gl.calls.find((c) => c.name === 'vertexAttribIPointer')!
    expect(ip.args).toEqual([3, 2, gl.UNSIGNED_BYTE, 24, 20])
    const fp = gl.calls.filter((c) => c.name === 'vertexAttribPointer').map((c) => c.args)
    expect(fp).toEqual([
      [0, 2, gl.FLOAT, false, 24, 0],
      [1, 2, gl.FLOAT, false, 24, 8],
      [2, 1, gl.FLOAT, false, 24, 16],
    ])
  })

  it('points each class vertex array at its range of the shared buffer', () => {
    const { gl, r } = setup()
    const t = tileOf([
      { roadClass: 'motorway', points: [0, 0, 10, 0] },
      { roadClass: 'rail', points: [0, 5, 10, 5, 20, 5] },
    ])
    r.setTiles([{ ...t, contentId: CID }])
    const p0 = gl.calls
      .filter((c) => c.name === 'vertexAttribPointer' && c.args[0] === 0)
      .map((c) => c.args[5])
    // rail first (2 instances), then motorway at instance 2.
    expect(p0).toEqual([0, 48])
  })

  it('pan and zoom upload nothing and rebuild nothing', () => {
    const { gl, r } = setup()
    r.setTiles([tile(0), tile(1)])
    r.render()
    const uploads = gl.bufferDataCalls
    for (let i = 0; i < 20; i++) {
      r.setView({ cx: 100 + i * 10, cz: 512, scale: 0.5 + i * 0.1 })
      r.render()
    }
    expect(gl.bufferDataCalls).toBe(uploads)
  })

  it('reuses buffers of known tiles, also when they come back later', () => {
    const { gl, r } = setup()
    r.setTiles([tile(0), tile(1)])
    r.setTiles([tile(1), tile(2)])
    r.setTiles([tile(0), tile(1), tile(2)])
    expect(gl.bufferDataCalls).toBe(3)
    expect(gl.liveCount('buffer')).toBe(3)
    // Another tile object with the same key is the same tile.
    r.setTiles([tile(0)])
    expect(gl.bufferDataCalls).toBe(3)
  })

  it('separates levels of detail in the cache', () => {
    const { gl, r } = setup()
    r.setTiles([tile(0, 0, 1, { level: 0 }), tile(0, 0, 1, { level: 1 })])
    expect(gl.bufferDataCalls).toBe(2)
  })

  it('evicts least recently used invisible tiles over budget, deleting buffer and vertex arrays', () => {
    // One road of two segments: 48 bytes per tile; budget for two tiles.
    const { gl, r } = setup({}, { budgetBytes: 96 })
    r.setTiles([tile(0)])
    r.setTiles([tile(1)])
    r.setTiles([tile(2)])
    expect(gl.liveCount('buffer')).toBe(2)
    expect(gl.deletedBuffers).toBe(1)
    expect(gl.deletedVaos).toBe(1)
    // tile 0 was evicted: needed again, it is uploaded again.
    r.setTiles([tile(0)])
    expect(gl.bufferDataCalls).toBe(4)
  })

  it('never evicts visible tiles; a visible set over budget is drawn in full and reported', () => {
    const { gl, r } = setup({}, { budgetBytes: 50 })
    r.setTiles([tile(0), tile(1), tile(2)])
    const stats = r.render()
    expect(gl.liveCount('buffer')).toBe(3)
    expect(stats.overBudget).toBe(true)
    expect(stats.budgetBytes).toBe(50)
    expect(stats.segments).toBe(6)
  })

  it('releases every buffer of the previous package when the content id changes', () => {
    const { gl, r } = setup()
    r.setTiles([tile(0), tile(1)])
    r.setTiles([tile(0, 0, 1, { contentId: 'ffffffffffffffff' })])
    expect(gl.deletedBuffers).toBe(2)
    expect(gl.liveCount('buffer')).toBe(1)
    expect(r.render().gpuBytes).toBe(48)
  })

  it('ignores tiles of another package mixed into one call', () => {
    const { gl, r } = setup()
    r.setTiles([tile(0), tile(1, 0, 1, { contentId: 'ffffffffffffffff' })])
    expect(gl.bufferDataCalls).toBe(1)
  })

  it('keeps an empty tile without a buffer', () => {
    const { gl, r } = setup()
    r.setTiles([{ ...tileOf([]), contentId: CID }])
    expect(gl.bufferDataCalls).toBe(0)
    expect(r.render()).toMatchObject({ drawCalls: 0, buffers: 0 })
  })

  it('reports out of memory', () => {
    const { r, statuses } = setup({ outOfMemoryAfter: 0 })
    r.setTiles([tile(0)])
    expect(statuses.at(-1)).toEqual({ state: 'failed', reason: 'out_of_memory' })
  })
})

describe('drawing', () => {
  it('draws per class in draw order, one stencil group per class, core then fringe', () => {
    const { gl, r } = setup()
    const t = tileOf([
      { roadClass: 'motorway', points: [0, 0, 10, 0] },
      { roadClass: 'local', points: [0, 5, 10, 5] },
      { roadClass: 'local', flags: ROAD_FLAG_CHORD, points: [0, 9, 10, 9] },
      { roadClass: 'rail', points: [0, 7, 10, 7] },
    ])
    r.setTiles([
      { ...t, contentId: CID },
      { ...t, contentId: CID, x: 1, originX: 1024 },
    ])
    r.setView({ cx: 512, cz: 0, scale: 0.5 })
    gl.draws = []
    const stats = r.render()
    // 3 classes Ã— 2 passes Ã— 2 tiles.
    expect(stats.drawCalls).toBe(12)
    expect(gl.draws.map((d) => [d.stencilRef, d.pass, d.count])).toEqual([
      [1, 0, 1], // rail
      [1, 0, 1],
      [1, 1, 1],
      [1, 1, 1],
      [3, 0, 2], // local (solid + chord in one group)
      [3, 0, 2],
      [3, 1, 2],
      [3, 1, 2],
      [5, 0, 1], // motorway
      [5, 0, 1],
      [5, 1, 1],
      [5, 1, 1],
    ])
    expect(stats.segments).toBe(8)
    expect(stats.roads).toBe(8)
  })

  it('draws one pass per class in the single-pass mode of M1', () => {
    const { gl, r } = setup({}, { stencilMode: 'single' })
    r.setTiles([tile(0)])
    gl.draws = []
    expect(r.render().drawCalls).toBe(1)
    expect(gl.draws[0]!.pass).toBe(2)
  })

  it('falls back to one unstencilled pass without a stencil buffer', () => {
    const { gl, r } = setup({ stencil: false })
    r.setTiles([tile(0)])
    gl.draws = []
    expect(r.render().drawCalls).toBe(1)
    expect(r.diagnostics().stencil).toBe(false)
  })

  it('skips tiles entirely off screen', () => {
    const { r } = setup()
    r.setTiles([tile(0), tile(50)])
    r.setView({ cx: 10, cz: 0, scale: 1 })
    const stats = r.render()
    expect(stats.segments).toBe(2)
    expect(r.diagnostics().culledTiles).toBe(1)
  })

  it('ignores a non-finite view', () => {
    const { r } = setup()
    r.setTiles([tile(0)])
    r.setView({ cx: NaN, cz: 0, scale: 1 })
    expect(r.render().segments).toBe(2)
  })
})

describe('context loss', () => {
  it('prevents the default, reports lost and draws nothing until restored', () => {
    const { canvas, gl, r, statuses } = setup()
    r.setTiles([tile(0)])
    let prevented = false
    canvas.addEventListener('webglcontextlost', (e) => (prevented = e.defaultPrevented))
    gl.loseContext()
    expect(prevented).toBe(true)
    expect(statuses.at(-1)).toEqual({ state: 'lost' })
    gl.draws = []
    expect(r.render()).toMatchObject({ drawCalls: 0, buffers: 0, gpuBytes: 0 })
    expect(gl.draws).toEqual([])
    r.dispose()
  })

  it('rebuilds program, buffers and vertex arrays from the CPU-side tiles on restore', () => {
    const { gl, r, statuses } = setup()
    r.setTiles([tile(0), tile(1)])
    gl.loseContext()
    gl.restoreContext()
    expect(statuses.at(-1)).toEqual({ state: 'ready' })
    expect(gl.liveCount('program')).toBe(1)
    expect(gl.liveCount('buffer')).toBe(2)
    expect(gl.liveCount('vao')).toBe(2)
    expect(r.render().segments).toBe(4)
  })

  it('keeps tiles handed over while lost and uploads them on restore', () => {
    const { gl, r } = setup()
    gl.loseContext()
    r.setTiles([tile(3)])
    expect(gl.bufferDataCalls).toBe(0)
    gl.restoreContext()
    expect(gl.bufferDataCalls).toBe(1)
  })

  it('fails after repeated losses so that the host can fall back', () => {
    const { gl, r, statuses } = setup({}, { maxLosses: 3 })
    r.setTiles([tile(0)])
    for (let i = 0; i < 3; i++) {
      gl.loseContext()
      gl.restoreContext()
    }
    expect(statuses.at(-1)).toEqual({ state: 'failed', reason: 'context_lost_repeatedly' })
    expect(r.render().drawCalls).toBe(0)
  })

  it('forgets losses outside the window', () => {
    let t = 0
    const { gl, statuses } = setup({}, { maxLosses: 2, lossWindowMs: 1000, now: () => t })
    gl.loseContext()
    gl.restoreContext()
    t = 5000
    gl.loseContext()
    gl.restoreContext()
    expect(statuses.at(-1)).toEqual({ state: 'ready' })
  })

  it('fails when the context is not restored in time', () => {
    vi.useFakeTimers()
    const { gl, statuses } = setup({}, { restoreTimeoutMs: 1000 })
    gl.loseContext()
    vi.advanceTimersByTime(999)
    expect(statuses.at(-1)).toEqual({ state: 'lost' })
    vi.advanceTimersByTime(1)
    expect(statuses.at(-1)).toEqual({ state: 'failed', reason: 'context_restore_failed' })
  })

  it('fails when the program cannot be rebuilt after a restore', () => {
    const { gl, statuses } = setup({ failCompileAfterRestore: true })
    gl.loseContext()
    gl.restoreContext()
    expect(statuses.at(-1)).toMatchObject({ state: 'failed', reason: 'shader_compile' })
  })

  it('can be disposed while lost: no GL calls on dead objects, no timer, no later restore', () => {
    vi.useFakeTimers()
    const { gl, r, statuses } = setup()
    r.setTiles([tile(0)])
    gl.loseContext()
    r.dispose()
    expect(vi.getTimerCount()).toBe(0)
    const before = statuses.length
    gl.restoreContext()
    expect(statuses.length).toBe(before)
    expect(gl.bufferDataCalls).toBe(1)
  })
})

describe('dispose', () => {
  it('deletes every buffer, vertex array and the program, and is idempotent', () => {
    const { gl, r } = setup({}, { loseContextOnDispose: false })
    r.setTiles([tile(0), tile(1), tile(2)])
    r.dispose()
    r.dispose()
    expect(gl.liveCount('buffer')).toBe(0)
    expect(gl.liveCount('vao')).toBe(0)
    expect(gl.liveCount('program')).toBe(0)
    expect(gl.deletedBuffers).toBe(3)
    expect(r.render().drawCalls).toBe(0)
    r.setTiles([tile(4)])
    expect(gl.bufferDataCalls).toBe(3)
  })

  it('drops the context on dispose by default', () => {
    const { gl, r } = setup()
    r.dispose()
    expect(gl.isContextLost()).toBe(true)
  })

  it('removes its context listeners', () => {
    const { canvas, r, statuses } = setup()
    r.dispose()
    canvas.dispatchEvent(new Event('webglcontextlost', { cancelable: true }))
    expect(statuses).toEqual([])
  })

  it('is a renderer of kind webgl2', () => {
    const { r } = setup()
    expect((r as WebGL2RoadRenderer).kind).toBe('webgl2')
  })
})

describe('coverage mode (M3)', () => {
  const coverage = (gl: FakeGlOptions = {}, options: WebGL2Options = {}) =>
    setup(gl, { stencilMode: 'coverage', ...options })

  it('is the default mode, and uploads are incremental by default', () => {
    const { canvas, gl } = fakeCanvas()
    const result = createWebGL2RoadRenderer(canvas)
    if (!result.ok) throw new Error('creation failed')
    expect(result.renderer.diagnostics().stencilMode).toBe('coverage')
    result.renderer.setTiles([tile(0)])
    expect(gl!.bufferDataCalls).toBe(0)
  })

  it('draws every tile once into the coverage target with MAX, then composites once', () => {
    const { gl, r } = coverage()
    const t = tileOf([
      { roadClass: 'motorway', points: [0, 0, 10, 0] },
      { roadClass: 'local', points: [0, 5, 10, 5, 20, 5] },
      { roadClass: 'rail', points: [0, 7, 10, 7] },
    ])
    r.setTiles([
      { ...t, contentId: CID },
      { ...t, contentId: CID, x: 1, originX: 1024 },
    ])
    r.setView({ cx: 512, cz: 0, scale: 0.5 })
    gl.draws = []
    gl.fullScreenDraws = []
    const stats = r.render()
    expect(stats.drawCalls).toBe(3)
    expect(stats.segments).toBe(8)
    expect(gl.draws.map((d) => d.count)).toEqual([4, 4])
    expect(gl.draws.every((d) => d.framebuffer !== null && d.blendEquation === gl.MAX)).toBe(true)
    // The composite pass draws onto the canvas, unblended.
    expect(gl.fullScreenDraws).toEqual([{ framebuffer: null, blend: false }])
  })

  it('uses one vertex array per tile over the whole buffer, and no stencil', () => {
    const { gl, r } = coverage()
    r.setTiles([tile(0), tile(1)])
    expect(gl.liveCount('vao')).toBe(2)
    expect(r.diagnostics().stencil).toBe(false)
    const p0 = gl.calls
      .filter((c) => c.name === 'vertexAttribPointer' && c.args[0] === 0)
      .map((c) => c.args[5])
    expect(p0).toEqual([0, 0])
  })

  it('sizes the target to the drawing buffer: RGBA8 for four classes, R8 for the fifth', () => {
    const { gl, r } = coverage()
    r.setTiles([tile(0)])
    r.render()
    expect(gl.textureStorage.slice(-2)).toEqual([
      { format: gl.RGBA8, width: 800, height: 600 },
      { format: gl.R8, width: 800, height: 600 },
    ])
    expect(r.diagnostics().targetBytes).toBe(800 * 600 * 5)
    // A resize replaces the target and deletes the old one.
    r.resize(400, 300, 1)
    r.render()
    expect(gl.textureStorage).toHaveLength(6) // 1×1 check, 800×600, 400×300
    expect(gl.liveCount('texture')).toBe(2)
    expect(gl.liveCount('framebuffer')).toBe(1)
    expect(r.diagnostics().targetBytes).toBe(400 * 300 * 5)
  })

  it('clears the canvas and draws nothing else without visible tiles', () => {
    const { gl, r } = coverage()
    gl.draws = []
    expect(r.render().drawCalls).toBe(0)
    expect(gl.fullScreenDraws).toEqual([])
  })

  it('falls back to core + fringe when the coverage target is incomplete', () => {
    const { gl, r } = coverage({ incompleteFramebuffer: true })
    expect(r.diagnostics()).toMatchObject({
      requestedMode: 'coverage',
      stencilMode: 'coreFringe',
      coverageFallback: 'coverage target incomplete',
      stencil: true,
    })
    r.setTiles([tile(0)])
    gl.draws = []
    expect(r.render().drawCalls).toBe(2)
    expect(gl.liveCount('framebuffer')).toBe(0)
    expect(gl.liveCount('texture')).toBe(0)
  })

  it('falls back to core + fringe when the coverage shader does not compile', () => {
    const { r } = coverage({ failCompileMatching: 'outHigh' })
    const d = r.diagnostics()
    expect(d.stencilMode).toBe('coreFringe')
    expect(d.coverageFallback).toContain('shader_compile')
  })

  it('rebuilds programs and target after a context restore', () => {
    const { gl, r, statuses } = coverage()
    r.setTiles([tile(0), tile(1)])
    r.render()
    gl.loseContext()
    gl.restoreContext()
    expect(statuses.at(-1)).toEqual({ state: 'ready' })
    expect(gl.liveCount('program')).toBe(2)
    expect(gl.liveCount('buffer')).toBe(2)
    expect(r.render()).toMatchObject({ segments: 4, drawCalls: 3 })
    expect(gl.liveCount('framebuffer')).toBe(1)
  })

  it('waits for the loss event: a frame between loss and event neither fails nor creates', () => {
    // Found in WebView2: `loseContext()` loses the context at once, the event comes later. A
    // frame in between once tried a new target, then the stencil program, on the dead
    // context and reported a shader error instead of a loss.
    const { gl, r, statuses } = coverage({ deferLossEvent: true })
    r.setTiles([tile(0)])
    r.render()
    gl.loseContext()
    r.resize(400, 300, 1) // the next frame would need a new target
    r.setView({ cx: 10, cz: 0, scale: 1 })
    gl.draws = []
    expect(r.render()).toMatchObject({ drawCalls: 0 })
    expect(statuses).toEqual([])
    expect(gl.draws).toEqual([])
    expect(gl.liveCount('texture')).toBe(0)
    gl.dispatchPendingLoss()
    expect(statuses.at(-1)).toEqual({ state: 'lost' })
    gl.restoreContext()
    expect(statuses.at(-1)).toEqual({ state: 'ready' })
    expect(r.render()).toMatchObject({ segments: 2, drawCalls: 2 })
    expect(r.diagnostics().stencilMode).toBe('coverage')
  })

  it('reports a context lost during creation as a failed context, not a shader error', () => {
    const { canvas, gl } = fakeCanvas({ deferLossEvent: true })
    gl!.loseContext()
    expect(createWebGL2RoadRenderer(canvas)).toMatchObject({
      ok: false,
      reason: 'context_creation_failed',
      detail: 'context lost during setup',
    })
  })

  it('deletes target, programs, buffers and vertex arrays on dispose', () => {
    const { gl, r } = coverage({}, { loseContextOnDispose: false })
    r.setTiles([tile(0), tile(1)])
    r.render()
    r.dispose()
    for (const kind of ['buffer', 'vao', 'program', 'framebuffer', 'texture'] as const)
      expect(gl.liveCount(kind)).toBe(0)
  })
})

describe('incremental uploads (M3)', () => {
  /** A renderer whose uploads take 5 ms each on a fake clock. */
  function timed(budget: number, options: WebGL2Options = {}) {
    let t = 0
    const s = setup({}, { uploadBudgetMs: budget, now: () => t, ...options })
    const bufferData = s.gl.bufferData.bind(s.gl)
    s.gl.bufferData = ((target: number, data: ArrayBuffer) => {
      t += 5
      bufferData(target, data)
    }) as typeof s.gl.bufferData
    return s
  }

  it('uploads nothing in setTiles; each frame uploads within its budget, at least one tile', () => {
    const { gl, r } = timed(6)
    r.setView({ cx: 2048, cz: 0, scale: 0.1 })
    r.setTiles([tile(0), tile(1), tile(2), tile(3), tile(4)])
    expect(gl.bufferDataCalls).toBe(0)
    // 5 ms per tile, budget 6 ms: the second tile starts at 5 ms, a third would start at 10.
    expect(r.render()).toMatchObject({ pending: 3, segments: 4 })
    expect(r.render()).toMatchObject({ pending: 1, segments: 8 })
    expect(r.render()).toMatchObject({ pending: 0, segments: 10 })
    expect(r.diagnostics()).toMatchObject({ lastNewTiles: 5, pendingTiles: 0 })
  })

  it('handles one tile per frame with a zero budget', () => {
    const { r } = timed(0)
    r.setTiles([tile(0), tile(1), tile(2)])
    expect([r.render().pending, r.render().pending, r.render().pending]).toEqual([2, 1, 0])
  })

  it('loads tiles on screen first, nearest the view centre first', () => {
    const { gl, r } = timed(0)
    // Centre at x = 2560; the screen (800 × 600 CSS px at scale 0.25) spans x 960 to 4160.
    r.setView({ cx: 2560, cz: 512, scale: 0.25 })
    // n roads per tile, so each upload's size names its tile: 48 bytes per road.
    r.setTiles([tile(0, 0, 1), tile(9, 0, 5), tile(1, 0, 2), tile(2, 0, 3), tile(3, 0, 4)])
    const order: number[] = []
    for (let i = 0; i < 5; i++) {
      const before = gl.uploadedBytes
      r.render()
      order.push((gl.uploadedBytes - before) / 48)
    }
    // Tile 2 (centre), tiles 1 and 3 (equally near, in the order given), tile 0, off-screen tile 9.
    expect(order).toEqual([3, 2, 4, 1, 5])
  })

  it('drops queued tiles that are no longer wanted, and never draws a tile in part', () => {
    const { gl, r } = timed(0)
    r.setTiles([tile(0), tile(1), tile(2)])
    r.render()
    r.setTiles([tile(1)])
    const stats = r.render()
    expect(stats.pending).toBe(0)
    expect(gl.bufferDataCalls).toBe(2)
    expect(stats.segments).toBe(2)
  })

  it('re-queues the visible tiles after a context restore', () => {
    const { gl, r } = timed(0)
    r.setTiles([tile(0), tile(1)])
    r.render()
    r.render()
    gl.loseContext()
    gl.restoreContext()
    expect(r.diagnostics().pendingTiles).toBe(2)
    expect(r.render().pending).toBe(1)
    expect(r.render()).toMatchObject({ pending: 0, segments: 4 })
  })

  it('reports out of memory from an upload slice', () => {
    const { r, statuses } = setup({ outOfMemoryAfter: 0 }, { uploadBudgetMs: 6 })
    r.setTiles([tile(0)])
    expect(statuses).toEqual([])
    r.render()
    expect(statuses.at(-1)).toEqual({ state: 'failed', reason: 'out_of_memory' })
  })
})

describe('GPU classification (M3)', () => {
  it('refuses a software renderer and drops its context', () => {
    const { canvas, gl } = fakeCanvas({
      unmasked: {
        renderer:
          'ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero) (0x0000C0DE)), SwiftShader driver)',
        vendor: 'Google Inc. (Google)',
      },
    })
    expect(createWebGL2RoadRenderer(canvas)).toMatchObject({
      ok: false,
      reason: 'software_renderer',
      gpu: { gpuClass: 'SOFTWARE', evidence: 'software_renderer_string', unmasked: true },
    })
    expect(gl!.isContextLost()).toBe(true)
  })

  it('refuses WARP (Microsoft Basic Render Driver)', () => {
    const { canvas } = fakeCanvas({
      unmasked: {
        renderer:
          'ANGLE (Microsoft, Microsoft Basic Render Driver (0x0000008C) Direct3D11 vs_5_0 ps_5_0, D3D11)',
        vendor: 'Google Inc. (Microsoft)',
      },
    })
    expect(createWebGL2RoadRenderer(canvas)).toMatchObject({
      ok: false,
      reason: 'software_renderer',
    })
  })

  it('uses a software renderer when explicitly allowed (lab comparisons)', () => {
    const { canvas } = fakeCanvas({
      unmasked: { renderer: 'llvmpipe (LLVM 17.0.6, 256 bits)', vendor: 'Mesa' },
    })
    const result = createWebGL2RoadRenderer(canvas, { allowSoftwareRenderer: true })
    expect(result.ok && result.renderer.diagnostics().gpuInfo.gpuClass).toBe('SOFTWARE')
  })

  it('reports a hardware renderer', () => {
    const { canvas } = fakeCanvas({
      unmasked: {
        renderer:
          'ANGLE (NVIDIA, NVIDIA GeForce RTX 3080 Laptop GPU (0x0000249C) Direct3D11 vs_5_0 ps_5_0, D3D11)',
        vendor: 'Google Inc. (NVIDIA)',
      },
    })
    const result = createWebGL2RoadRenderer(canvas)
    expect(result.ok && result.renderer.diagnostics().gpuInfo).toMatchObject({
      gpuClass: 'HARDWARE',
      unmasked: true,
    })
  })

  it('keeps WebGL 2 with an unknown renderer: a missing extension is not software', () => {
    const { canvas } = fakeCanvas({ unmasked: null, renderer: 'WebKit WebGL', vendor: 'WebKit' })
    const result = createWebGL2RoadRenderer(canvas)
    expect(result.ok).toBe(true)
    expect(result.ok && result.renderer.diagnostics().gpuInfo).toMatchObject({
      gpuClass: 'UNKNOWN',
      evidence: 'masked_renderer_string',
      unmasked: false,
    })
  })

  it('classifies the plain renderer string when the extension is missing', () => {
    const { canvas } = fakeCanvas({
      unmasked: null,
      renderer: 'Mesa Intel(R) HD Graphics 530 (SKL GT2)',
    })
    const result = createWebGL2RoadRenderer(canvas)
    expect(result.ok && result.renderer.diagnostics().gpuInfo.gpuClass).toBe('HARDWARE')
  })

  describe('when only a context with a performance caveat exists', () => {
    /** The main canvas refuses a context; the probe canvas gets one with these strings. */
    function caveatOnly(probe: FakeGlOptions) {
      const { canvas } = fakeCanvas(null)
      const probeCanvas = fakeCanvas(probe).canvas
      const create = document.createElement.bind(document)
      vi.spyOn(document, 'createElement').mockImplementation(((tag: string) =>
        tag === 'canvas' ? probeCanvas : create(tag)) as typeof document.createElement)
      return canvas
    }
    afterEach(() => vi.restoreAllMocks())

    it('reports software when the probe context names a software renderer', () => {
      const canvas = caveatOnly({ unmasked: { renderer: 'Google SwiftShader', vendor: 'Google' } })
      expect(createWebGL2RoadRenderer(canvas)).toMatchObject({
        ok: false,
        reason: 'software_renderer',
        gpu: { gpuClass: 'SOFTWARE' },
      })
    })

    it('reports an unknown cause otherwise', () => {
      const canvas = caveatOnly({ unmasked: null, renderer: 'WebKit WebGL' })
      expect(createWebGL2RoadRenderer(canvas)).toMatchObject({
        ok: false,
        reason: 'context_creation_failed',
        detail: 'major_performance_caveat',
        gpu: { gpuClass: 'UNKNOWN', evidence: 'major_performance_caveat' },
      })
    })
  })

  it('reports unavailable when no context exists at all', () => {
    const { canvas } = fakeCanvas(null)
    expect(createWebGL2RoadRenderer(canvas)).toMatchObject({
      ok: false,
      reason: 'context_creation_failed',
      gpu: { gpuClass: 'UNAVAILABLE', evidence: 'no_context' },
    })
  })
})
