import { describe, expect, it } from 'vitest'
import { ROAD_CLASSES } from '@/domain/mapTile'
import { drawRoads, ROAD_STYLES, type RoadCtx } from '../roadPainter'
import { tileOf } from '@/test/renderTiles'
import { dashOf, DRAW_ORDER, hexToRgb, lineWidth, zoomBonus } from './roadStyle'

/** Line widths the production painter strokes, per class, at a scale. */
function productionWidths(scale: number) {
  const widths: Record<string, number> = {}
  let width = 0
  const ctx = {
    clearRect() {},
    beginPath() {},
    moveTo() {},
    lineTo() {},
    setLineDash() {},
    strokeStyle: '',
    get lineWidth() {
      return width
    },
    set lineWidth(v: number) {
      width = v
    },
    lineJoin: 'round',
    lineCap: 'round',
    globalAlpha: 1,
    stroke() {
      const cls = ROAD_CLASSES.find((c) => ROAD_STYLES[c].color === ctx.strokeStyle)!
      widths[cls] = width
    },
  } as unknown as RoadCtx
  const tile = tileOf(ROAD_CLASSES.map((roadClass) => ({ roadClass, points: [0, 0, 1, 1] })))
  drawRoads(ctx, [tile], { cx: 0, cz: 0, scale }, { width: 100, height: 100 })
  return widths
}

describe('road styles of the WebGL prototype', () => {
  it('match the widths the production painter strokes at every zoom band', () => {
    for (const scale of [0.001, 0.05, 0.2, 0.4, 2]) {
      const widths = productionWidths(scale)
      for (const c of ROAD_CLASSES) expect(lineWidth(c, scale)).toBe(widths[c])
    }
    expect([0.001, 0.05, 0.4].map(zoomBonus)).toEqual([0, 0.5, 1.5])
  })

  it('use the production colours and rail dash', () => {
    expect(hexToRgb('#a8927a')).toEqual([0xa8 / 255, 0x92 / 255, 0x7a / 255])
    expect(dashOf('rail')).toEqual([4, 3])
    expect(dashOf('motorway')).toBeNull()
    expect(() => hexToRgb('red')).toThrow()
  })

  it('draw in the production order, motorways on top', () => {
    expect(DRAW_ORDER).toEqual(['rail', 'minor', 'local', 'primary', 'motorway'])
    expect([...DRAW_ORDER].sort()).toEqual([...ROAD_CLASSES].sort())
  })
})
