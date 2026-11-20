import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FakeWebGL2, type FakeGlOptions } from '@/test/fakeWebGL2'
import { tileOf } from '@/test/renderTiles'
import { Canvas2DRoadRenderer } from './Canvas2DRoadRenderer'
import { createRoadRenderer, RoadRendererHost } from './createRoadRenderer'
import { WebGL2RoadRenderer } from './WebGL2RoadRenderer'

/** A minimal 2D context: the production painter's calls, and nothing drawn. */
function fake2d() {
  return {
    clearRect() {},
    beginPath() {},
    moveTo() {},
    lineTo() {},
    stroke() {},
    setLineDash() {},
    setTransform() {},
    strokeStyle: '',
    lineWidth: 1,
    lineJoin: 'round',
    lineCap: 'round',
    globalAlpha: 1,
  }
}

/**
 * Canvases that support exactly one context type each, like real ones: WebGL 2 (a fake) when
 * `webgl` is given, and always 2D. Records every canvas made.
 */
function canvasFactory(webgl: FakeGlOptions | null = {}) {
  const made: HTMLCanvasElement[] = []
  const gls: FakeWebGL2[] = []
  const create = () => {
    const c = document.createElement('canvas')
    let mode: string | null = null
    let gl: FakeWebGL2 | null = null
    const ctx2d = fake2d()
    c.getContext = ((type: string) => {
      if (mode && mode !== type) return null
      if (type === 'webgl2') {
        if (webgl === null) return null
        gl ??= new FakeWebGL2(c, webgl)
        if (!gls.includes(gl)) gls.push(gl)
        mode = type
        return gl
      }
      if (type === '2d') {
        mode = type
        return ctx2d
      }
      return null
    }) as never
    made.push(c)
    return c
  }
  return { create, made, gls }
}

const tiles = [{ ...tileOf([{ points: [0, 0, 10, 0] }]), contentId: '0123456789abcdef' }]

/** Frames run only when the test says so. */
function manualFrames() {
  let queue: ((t: number) => void)[] = []
  return {
    schedule: (cb: (t: number) => void) => {
      queue.push(cb)
      return queue.length
    },
    cancel: () => {
      queue = []
    },
    pending: () => queue.length,
    run: () => {
      const q = queue
      queue = []
      q.forEach((cb) => cb(performance.now()))
    },
  }
}

beforeEach(() => {
  vi.stubGlobal('WebGL2RenderingContext', class {})
})
afterEach(() => {
  vi.unstubAllGlobals()
})

describe('createRoadRenderer', () => {
  it('creates WebGL 2 when available', () => {
    const f = canvasFactory()
    const created = createRoadRenderer('webgl2', f.create)!
    expect(created.renderer).toBeInstanceOf(WebGL2RoadRenderer)
    expect(created.fallback).toBeNull()
    expect(f.made).toHaveLength(1)
  })

  it('falls back to Canvas 2D on a new canvas when WebGL 2 does not exist', () => {
    vi.unstubAllGlobals()
    const f = canvasFactory()
    const created = createRoadRenderer('webgl2', f.create)!
    expect(created.renderer).toBeInstanceOf(Canvas2DRoadRenderer)
    expect(created.fallback).toEqual({ from: 'webgl2', reason: 'webgl2_unavailable' })
    expect(f.made).toHaveLength(2)
    expect(created.canvas).toBe(f.made[1])
  })

  it('falls back when no context is created, or the shaders fail', () => {
    const none = createRoadRenderer('webgl2', canvasFactory(null).create)!
    expect(none.fallback?.reason).toBe('context_creation_failed')
    const shader = createRoadRenderer('webgl2', canvasFactory({ failCompile: 'vertex' }).create)!
    expect(shader.renderer.kind).toBe('canvas2d')
    expect(shader.fallback?.reason).toBe('shader_compile')
    const link = createRoadRenderer('webgl2', canvasFactory({ failLink: true }).create)!
    expect(link.fallback?.reason).toBe('program_link')
  })

  it('creates Canvas 2D directly when asked for it', () => {
    const f = canvasFactory()
    const created = createRoadRenderer('canvas2d', f.create)!
    expect(created.renderer.kind).toBe('canvas2d')
    expect(created.fallback).toBeNull()
    expect(f.gls).toHaveLength(0)
  })
})

describe('RoadRendererHost', () => {
  function host(webgl: FakeGlOptions | null = {}) {
    const container = document.createElement('div')
    const f = canvasFactory(webgl)
    const frames = manualFrames()
    const fallbacks: unknown[] = []
    const rendered: string[] = []
    const h = new RoadRendererHost(container, {
      createCanvas: f.create,
      schedule: frames.schedule,
      cancel: frames.cancel,
      onFallback: (fb) => fallbacks.push(fb),
      onFrame: (info) => rendered.push(info.kind),
    })
    return { h, container, f, frames, fallbacks, rendered }
  }

  it('renders at most once per frame however many changes come before it', () => {
    const { h, frames, rendered } = host()
    h.mount('webgl2')
    h.resize(800, 600, 1)
    for (let i = 0; i < 10; i++) h.setView({ cx: i, cz: 0, scale: 1 })
    h.setTiles(tiles)
    expect(frames.pending()).toBe(1)
    frames.run()
    expect(rendered).toEqual(['webgl2'])
    // Nothing changed: no frame requested.
    expect(frames.pending()).toBe(0)
  })

  it('replaces the canvas on every renderer switch and keeps only one in the container', () => {
    const { h, container, f } = host()
    h.mount('webgl2')
    const first = h.renderer!
    h.mount('canvas2d')
    expect(container.querySelectorAll('canvas')).toHaveLength(1)
    expect(container.querySelector('canvas')).toBe(f.made[1])
    expect(f.made[0]!.isConnected).toBe(false)
    // The previous renderer was disposed: its GL objects are gone.
    expect(f.gls[0]!.liveCount('program')).toBe(0)
    expect(first.render().drawCalls).toBe(0)
  })

  it('hands size, view and tiles to a newly mounted renderer', () => {
    const { h, f, frames } = host()
    h.resize(640, 480, 1.5)
    h.setView({ cx: 0, cz: 0, scale: 1 })
    h.setTiles(tiles)
    h.mount('webgl2')
    expect(f.made[0]!.width).toBe(960)
    expect(f.gls[0]!.bufferDataCalls).toBe(1)
    frames.run()
  })

  it('switches to Canvas 2D on a new canvas when WebGL fails at run time', async () => {
    const { h, container, f, fallbacks } = host()
    h.mount('webgl2')
    h.setTiles(tiles)
    const gl = f.gls[0]!
    // Three losses in a row exceed the default limit.
    for (let i = 0; i < 3; i++) {
      gl.loseContext()
      gl.restoreContext()
    }
    await Promise.resolve()
    expect(h.renderer!.kind).toBe('canvas2d')
    expect(fallbacks).toEqual([{ from: 'webgl2', reason: 'context_lost_repeatedly' }])
    expect(h.fallback?.reason).toBe('context_lost_repeatedly')
    expect(container.querySelectorAll('canvas')).toHaveLength(1)
    expect(container.querySelector('canvas')).not.toBe(f.made[0])
  })

  it('falls back at mount when WebGL 2 is unavailable', () => {
    const { h, fallbacks } = host(null)
    h.mount('webgl2')
    expect(h.renderer!.kind).toBe('canvas2d')
    expect(fallbacks).toEqual([{ from: 'webgl2', reason: 'context_creation_failed' }])
  })

  it('release and dispose free the renderer and remove the canvas; dispose is idempotent', () => {
    const { h, container, frames } = host()
    h.mount('webgl2')
    h.setTiles(tiles)
    h.release()
    expect(container.children).toHaveLength(0)
    expect(frames.pending()).toBe(0)
    h.mount('canvas2d')
    h.dispose()
    h.dispose()
    expect(container.children).toHaveLength(0)
    expect(h.mount('webgl2')).toBeNull()
  })
})
