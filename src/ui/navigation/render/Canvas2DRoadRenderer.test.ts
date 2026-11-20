import { describe, expect, it } from 'vitest'
import { tileOf } from '@/test/renderTiles'
import { createCanvas2DRoadRenderer } from './Canvas2DRoadRenderer'

function canvasWith2d() {
  const calls: string[] = []
  const ctx = {
    clearRect: () => calls.push('clearRect'),
    beginPath: () => calls.push('beginPath'),
    moveTo: () => {},
    lineTo: () => {},
    stroke: () => calls.push('stroke'),
    setLineDash: () => {},
    setTransform: (...a: number[]) => calls.push(`setTransform ${a.join(',')}`),
    strokeStyle: '',
    lineWidth: 1,
    lineJoin: 'round',
    lineCap: 'round',
    globalAlpha: 1,
  }
  const canvas = document.createElement('canvas')
  canvas.getContext = ((t: string) => (t === '2d' ? ctx : null)) as never
  return { canvas, ctx, calls }
}

describe('Canvas2DRoadRenderer', () => {
  it('draws with the production painter at the device pixel ratio, counting strokes', () => {
    const { canvas, calls } = canvasWith2d()
    const created = createCanvas2DRoadRenderer(canvas)
    if (!created.ok) throw new Error('no renderer')
    const r = created.renderer
    r.resize(400, 300, 1.5)
    r.setView({ cx: 0, cz: 0, scale: 1 })
    const t = tileOf([
      { roadClass: 'motorway', points: [0, 0, 10, 0, 20, 0] },
      { roadClass: 'local', points: [0, 5, 10, 5] },
    ])
    // The same road in two tiles is drawn and counted once.
    r.setTiles([t, { ...t, x: 1 }])
    const stats = r.render()
    expect(canvas.width).toBe(600)
    expect(calls[0]).toBe('setTransform 1.5,0,0,1.5,0,0')
    expect(stats).toMatchObject({ roads: 2, segments: 3, drawCalls: 2, uploads: 0, gpuBytes: 0 })
  })

  it('reports no renderer without a 2D context', () => {
    const canvas = document.createElement('canvas')
    expect(createCanvas2DRoadRenderer(canvas)).toEqual({
      ok: false,
      reason: 'context_creation_failed',
    })
  })

  it('dispose restores the context, frees the backing store and is idempotent', () => {
    const { canvas, ctx } = canvasWith2d()
    const original = ctx.stroke
    const created = createCanvas2DRoadRenderer(canvas)
    if (!created.ok) throw new Error('no renderer')
    created.renderer.resize(100, 100, 1)
    created.renderer.dispose()
    created.renderer.dispose()
    expect(ctx.stroke).toBe(original)
    expect(canvas.width).toBe(0)
    expect(created.renderer.render().drawCalls).toBe(0)
  })
})
