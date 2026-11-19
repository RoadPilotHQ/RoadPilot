import { describe, expect, it } from 'vitest'
import { EMPTY_TRACE, type PathTrace } from '@/domain/path'
import { computeView, drawTrace, FOLLOW_SPAN_M, MIN_SPAN_M, scaleBar, type Ctx } from './pathView'

function trace(points: [number, number][][], headingDeg = 0): PathTrace {
  const segments = points.map((s) => s.map(([x, z]) => ({ x, z })))
  const last = segments.flat().at(-1)!
  return {
    game: 'ets2',
    segments,
    last: { ...last, headingDeg, atUnixMs: 1 },
    points: segments.flat().length,
    rejected: 0,
    version: 1,
  }
}

/** Records the calls a drawing makes. */
function fakeCtx() {
  const calls: string[] = []
  const ctx = new Proxy(
    { strokeStyle: '', fillStyle: '', lineWidth: 0, lineJoin: 'miter', lineCap: 'butt' },
    {
      get(target, prop: string) {
        if (prop in target) return target[prop as keyof typeof target]
        return (...args: unknown[]) => calls.push(`${prop}(${args.map(String).join(',')})`)
      },
      set(target, prop: string, value) {
        ;(target as Record<string, unknown>)[prop] = value
        calls.push(`${prop}=${String(value)}`)
        return true
      },
    },
  ) as unknown as Ctx
  return { ctx, calls }
}

describe('computeView', () => {
  it('has no view without points or without space', () => {
    expect(computeView(EMPTY_TRACE, 400, 300, 'fit')).toBeNull()
    const t = trace([[[0, 0]]])
    expect(computeView(t, 0, 300, 'fit')).toBeNull()
    expect(computeView(t, 400, 0, 'follow')).toBeNull()
  })

  it('shows north up: east to the right, south down', () => {
    const t = trace([
      [
        [0, 0],
        [1000, 0],
        [1000, 1000],
      ],
    ])
    const v = computeView(t, 500, 500, 'fit')!
    const origin = v.toScreen({ x: 0, z: 0 })
    const east = v.toScreen({ x: 1000, z: 0 })
    const south = v.toScreen({ x: 1000, z: 1000 })
    expect(east.x).toBeGreaterThan(origin.x)
    expect(east.y).toBeCloseTo(origin.y)
    expect(south.y).toBeGreaterThan(east.y)
  })

  it('uses one scale for both axes and fits the whole path', () => {
    const t = trace([
      [
        [0, 0],
        [4000, 1000],
      ],
    ])
    const v = computeView(t, 800, 400, 'fit')!
    for (const p of [
      { x: 0, z: 0 },
      { x: 4000, z: 1000 },
    ]) {
      const s = v.toScreen(p)
      expect(s.x).toBeGreaterThanOrEqual(0)
      expect(s.x).toBeLessThanOrEqual(800)
      expect(s.y).toBeGreaterThanOrEqual(0)
      expect(s.y).toBeLessThanOrEqual(400)
    }
    const a = v.toScreen({ x: 0, z: 0 })
    const b = v.toScreen({ x: 100, z: 100 })
    expect(b.x - a.x).toBeCloseTo(b.y - a.y)
  })

  it('does not blow up a single point', () => {
    const v = computeView(trace([[[5, 5]]]), 424, 424, 'fit')!
    expect(v.scale).toBeCloseTo((424 - 48) / MIN_SPAN_M)
  })

  it('centres the truck in follow mode', () => {
    const t = trace([
      [
        [0, 0],
        [50_000, 20_000],
      ],
    ])
    const v = computeView(t, 600, 400, 'follow')!
    expect(v.toScreen({ x: 50_000, z: 20_000 })).toEqual({ x: 300, y: 200 })
    expect(v.scale).toBeCloseTo((400 - 48) / FOLLOW_SPAN_M)
  })

  it('rescales when the canvas is resized', () => {
    const t = trace([
      [
        [0, 0],
        [1000, 0],
      ],
    ])
    const small = computeView(t, 300, 300, 'fit')!
    const large = computeView(t, 1200, 900, 'fit')!
    expect(large.scale).toBeGreaterThan(small.scale)
  })
})

describe('scaleBar', () => {
  it('picks a round length of about a quarter of the width', () => {
    const view = { scale: 0.5, toScreen: () => ({ x: 0, y: 0 }) }
    // A quarter of 800 px is 400 m at 0.5 px/m: the bar is 200 m.
    expect(scaleBar(view, 800, 1)).toEqual({ units: 200, px: 100 })
    expect(scaleBar(view, 800, 1000)).toEqual({ units: 0.2, px: 100 })
  })
})

describe('drawTrace', () => {
  const palette = { path: 'P', start: 'S', current: 'C', stale: 'X', outline: 'O' }
  const size = { width: 400, height: 300 }

  it('draws each segment separately, the start and the heading marker', () => {
    const t = trace(
      [
        [
          [0, 0],
          [100, 0],
        ],
        [
          [5000, 0],
          [5100, 0],
        ],
      ],
      90,
    )
    const { ctx, calls } = fakeCtx()
    drawTrace(ctx, t, computeView(t, 400, 300, 'fit')!, size, palette, false)
    expect(calls[0]).toBe('clearRect(0,0,400,300)')
    expect(calls.filter((c) => c.startsWith('moveTo')).length).toBe(3) // 2 segments + marker
    expect(calls).toContain('strokeStyle=P')
    expect(calls).toContain('fillStyle=C')
    // Heading 90° is west: counterclockwise by a quarter turn.
    expect(calls).toContain(`rotate(${-Math.PI / 2})`)
  })

  it('draws a stale position hollow and grey', () => {
    const t = trace([
      [
        [0, 0],
        [100, 0],
      ],
    ])
    const { ctx, calls } = fakeCtx()
    drawTrace(ctx, t, computeView(t, 400, 300, 'fit')!, size, palette, true)
    expect(calls).toContain('strokeStyle=X')
    expect(calls).not.toContain('fillStyle=C')
    expect(calls).toContain('setLineDash(3,2)')
  })
})
