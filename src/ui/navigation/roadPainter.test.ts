import { describe, expect, it } from 'vitest'
import { decodeTile } from '@/domain/mapTile'
import { encodeTile, GOLDEN_REQUEST, type SyntheticRoad } from '@/test/tileFixtures'
import { drawRoads, ROAD_STYLES, type RoadCtx } from './roadPainter'

function fakeCtx() {
  const calls: string[] = []
  const state = {
    strokeStyle: '',
    lineWidth: 0,
    lineJoin: 'miter',
    lineCap: 'butt',
    globalAlpha: 1,
  }
  const ctx = new Proxy(state, {
    get(target, prop: string) {
      if (prop in target) return target[prop as keyof typeof target]
      return (...args: unknown[]) => calls.push(`${prop}(${args.map(String).join(',')})`)
    },
    set(target, prop: string, value) {
      ;(target as Record<string, unknown>)[prop] = value
      calls.push(`${prop}=${String(value)}`)
      return true
    },
  }) as unknown as RoadCtx
  return { ctx, calls }
}

const tile = (roads: SyntheticRoad[], x = 1) =>
  decodeTile(encodeTile({ ...GOLDEN_REQUEST, x }, roads), { ...GOLDEN_REQUEST, x })!

const size = { width: 400, height: 300 }
const vp = { cx: 1200, cz: -900, scale: 1 }

describe('drawRoads', () => {
  it('draws classes from minor to motorway, with their styles', () => {
    const { ctx, calls } = fakeCtx()
    const t = tile([
      {
        index: 1,
        roadClass: 'motorway',
        points: [
          [1100, -900],
          [1300, -900],
        ],
      },
      {
        index: 2,
        roadClass: 'local',
        points: [
          [1100, -950],
          [1300, -950],
        ],
      },
      {
        index: 3,
        roadClass: 'rail',
        points: [
          [1100, -980],
          [1300, -980],
        ],
      },
    ])
    const stats = drawRoads(ctx, [t], vp, size)
    expect(stats.roads).toBe(3)
    const order = calls.filter((c) => c.startsWith('strokeStyle='))
    expect(order.indexOf(`strokeStyle=${ROAD_STYLES.rail.color}`)).toBeLessThan(
      order.indexOf(`strokeStyle=${ROAD_STYLES.motorway.color}`),
    )
    expect(calls).toContain('setLineDash(4,3)')
    // World (1100, -900) is 100 units west of the centre: x = 200 - 100.
    expect(calls).toContain('moveTo(100,150)')
    expect(calls).toContain('lineTo(300,150)')
  })

  it('draws a road listed in two tiles once', () => {
    const { ctx, calls } = fakeCtx()
    const road: SyntheticRoad = {
      index: 7,
      points: [
        [1100, -900],
        [1300, -900],
      ],
    }
    const stats = drawRoads(ctx, [tile([road], 1), tile([road], 1)], vp, size)
    expect(stats.roads).toBe(1)
    expect(calls.filter((c) => c === 'stroke()')).toHaveLength(1)
  })

  it('skips roads entirely outside the canvas', () => {
    const { ctx } = fakeCtx()
    const stats = drawRoads(
      ctx,
      [
        tile([
          {
            index: 1,
            points: [
              [1900, -900],
              [1950, -900],
            ],
          },
        ]),
      ],
      vp,
      size,
    )
    expect(stats).toEqual({ roads: 0, offscreen: 1 })
  })

  it('draws chords fainter', () => {
    const { ctx, calls } = fakeCtx()
    drawRoads(
      ctx,
      [
        tile([
          {
            index: 1,
            flags: 2,
            points: [
              [1100, -900],
              [1300, -900],
            ],
          },
        ]),
      ],
      vp,
      size,
    )
    expect(calls).toContain('globalAlpha=0.6')
    expect(calls.at(-2)).toBe('globalAlpha=1')
  })

  it('clears the canvas, also without roads', () => {
    const { ctx, calls } = fakeCtx()
    expect(drawRoads(ctx, [], vp, size)).toEqual({ roads: 0, offscreen: 0 })
    expect(calls[0]).toBe('clearRect(0,0,400,300)')
  })
})
