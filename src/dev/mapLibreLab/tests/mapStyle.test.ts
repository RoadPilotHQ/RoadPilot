import { describe, expect, it } from 'vitest'
import { lineWidth } from '@/ui/navigation/render/roadStyle'
import { pixelsPerUnit } from '../coordinates'
import { buildStyle, DRAW_ORDER, widthExpression } from '../mapStyle'
import { LAB_CLASSES } from '../syntheticData'

const VARIANTS = [
  { crs: 'scs', thin: false, labels: true, probes: true },
  { crs: 'identity', thin: false, labels: true, probes: false },
  { crs: 'scs', thin: true, labels: false, probes: false },
] as const

/** Evaluates a `['step', ['zoom'], v0, z1, v1, ...]` expression. */
function step(expr: unknown[], zoom: number): number {
  let v = expr[2] as number
  for (let i = 3; i < expr.length; i += 2)
    if (zoom >= (expr[i] as number)) v = expr[i + 1] as number
  return v
}

describe('lab style', () => {
  it('contains no URL of any kind: no glyphs, no sprite, inline sources only', () => {
    for (const v of VARIANTS) {
      const style = buildStyle(v)
      const text = JSON.stringify(style)
      expect(text).not.toMatch(/:\/\//)
      expect(text).not.toMatch(/https?:/i)
      expect(style).not.toHaveProperty('glyphs')
      expect(style).not.toHaveProperty('sprite')
      for (const s of Object.values(style.sources)) {
        expect(s.type).toBe('geojson')
        expect(typeof (s as { data: unknown }).data).toBe('object')
      }
    }
  })

  it('uses the planar CRS chosen, never mercator or globe', () => {
    expect(buildStyle(VARIANTS[0]).projection).toEqual({ type: 'roadpilot:scs' })
    expect(buildStyle(VARIANTS[1]).projection).toEqual({ type: 'identity' })
  })

  it('has a line layer per road class, in the production draw order', () => {
    const ids = buildStyle(VARIANTS[0]).layers.map((l) => l.id)
    expect(new Set(DRAW_ORDER)).toEqual(new Set(LAB_CLASSES))
    const order = DRAW_ORDER.map((c) => ids.indexOf(`road-${c}`))
    expect(order.every((i) => i > 0)).toBe(true)
    expect([...order].sort((a, b) => a - b)).toEqual(order)
  })

  it('road widths equal the production widths (with zoom bonus) at every scale', () => {
    for (const cls of ['motorway', 'primary', 'local', 'minor'] as const)
      for (const scale of [0.001, 0.0499, 0.05, 0.2, 0.3999, 0.4, 2])
        for (const crs of ['scs', 'identity'] as const) {
          const zoom = Math.log2((scale * (crs === 'scs' ? 262_144 : 368_640)) / 512)
          expect(pixelsPerUnit(zoom, crs)).toBeCloseTo(scale, 12)
          // A hair above the threshold, as floating point rounding can land either side.
          const z = scale === 0.05 || scale === 0.4 ? zoom + 1e-9 : zoom
          expect(step(widthExpression(cls, crs) as unknown[], z)).toBe(lineWidth(cls, scale))
        }
  })

  it('draws labels with locally rendered fonts and lets symbols collide (no overlap)', () => {
    const labels = buildStyle(VARIANTS[0]).layers.filter((l) => l.type === 'symbol')
    expect(labels.length).toBeGreaterThan(0)
    for (const l of labels) {
      const layout = (l as { layout: Record<string, unknown> }).layout
      expect(layout['text-font']).toBeDefined()
      expect(layout['text-allow-overlap']).toBeUndefined()
      expect(layout['icon-image']).toBeUndefined()
    }
    expect(buildStyle(VARIANTS[2]).layers.some((l) => l.type === 'symbol')).toBe(false)
  })
})
