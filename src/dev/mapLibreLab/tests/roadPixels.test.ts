/** B1.4 O3: first visible geometry counts road-layer pixels only. */
import { describe, expect, it } from 'vitest'
import { seededRandom } from '../../syntheticScenarios'
import { buildStyle, COLORS } from '../mapStyle'
import {
  countRoadPixels,
  detectableRoadColours,
  distanceToHull,
  hexToRgb,
  isRoadPixel,
  nonRoadPalette,
  ROAD_FILL,
  ROAD_LAYER_COLOURS,
  ROAD_PIXEL_TOLERANCE,
  type CanvasContent,
  type Rgb,
} from '../roadPixels'

const CONFIGS: CanvasContent[] = [
  { labels: true, probes: true },
  { labels: true, probes: false },
  { labels: false, probes: true },
  { labels: false, probes: false },
]

/** A random convex combination of the given colours, rounded as a framebuffer stores it. */
function mix(colours: readonly Rgb[], rnd: () => number): Rgb {
  const w = colours.map(() => -Math.log(1 - rnd() * 0.999999))
  const sum = w.reduce((a, b) => a + b, 0)
  const c = [0, 1, 2].map((k) => colours.reduce((acc, col, i) => acc + col[k]! * w[i]!, 0) / sum)
  return [Math.round(c[0]!), Math.round(c[1]!), Math.round(c[2]!)]
}

function frame(pixels: readonly Rgb[]): Uint8Array {
  const out = new Uint8Array(pixels.length * 4)
  pixels.forEach((p, i) => out.set([p[0], p[1], p[2], 255], i * 4))
  return out
}

describe('colours come from the configured style', () => {
  it('road fills are the style line colours, the palette the non-road colours', () => {
    const style = buildStyle({ crs: 'scs', thin: false, labels: true, probes: true })
    for (const l of style.layers) {
      if (l.type !== 'line' || !('paint' in l) || !l.paint) continue
      const colour = (l.paint as Record<string, unknown>)['line-color'] as string
      const known = ROAD_LAYER_COLOURS.find((c) => c.layer === l.id)
      expect(known, l.id).toBeDefined()
      expect(known!.rgb).toEqual(hexToRgb(colour))
    }
    expect(ROAD_FILL.motorway).toEqual(hexToRgb(COLORS.motorway))
    expect(nonRoadPalette({ labels: false, probes: false }).map((p) => p.name)).toEqual([
      'background',
    ])
    expect(nonRoadPalette({ labels: true, probes: true }).map((p) => p.name)).toEqual([
      'background',
      'halo',
      'text',
      'textMuted',
      'motorwayLabel',
      'probe',
    ])
  })

  it('hexToRgb', () => {
    expect(hexToRgb('#e8792e')).toEqual([0xe8, 0x79, 0x2e])
    expect(() => hexToRgb('red')).toThrow()
  })
})

describe('distanceToHull', () => {
  const tri: Rgb[] = [
    [0, 0, 0],
    [100, 0, 0],
    [0, 100, 0],
  ]
  it('is zero at vertices and inside, exact outside', () => {
    expect(distanceToHull([0, 0, 0], tri)).toBe(0)
    expect(distanceToHull([20, 20, 0], tri)).toBeCloseTo(0, 9)
    expect(distanceToHull([20, 20, 7], tri)).toBeCloseTo(7, 9)
    expect(distanceToHull([50, -10, 0], tri)).toBeCloseTo(10, 9)
    expect(distanceToHull([-3, -4, 0], tri)).toBeCloseTo(5, 9)
    expect(distanceToHull([5, 5, 5], [[1, 2, 3]])).toBeCloseTo(Math.hypot(4, 3, 2), 9)
  })
})

describe('detectable road layers per configuration', () => {
  it('with labels only the motorway fill is unambiguous; without labels every road layer', () => {
    const layers = (c: CanvasContent) => detectableRoadColours(c).map((d) => d.layer)
    expect(layers({ labels: true, probes: true })).toEqual(['road-motorway'])
    expect(layers({ labels: true, probes: false })).toEqual(['road-motorway'])
    expect(layers({ labels: false, probes: false })).toEqual(ROAD_LAYER_COLOURS.map((c) => c.layer))
    expect(layers({ labels: false, probes: true })).toEqual(ROAD_LAYER_COLOURS.map((c) => c.layer))
  })

  it('no mix of non-road colours is ever classified as road (random mixes, edges, triangles)', () => {
    for (const content of CONFIGS) {
      const colours = detectableRoadColours(content)
      const palette = nonRoadPalette(content).map((p) => p.rgb)
      const rnd = seededRandom(0xb14)
      // Random convex combinations of the whole palette and of random subsets.
      for (let i = 0; i < 20_000; i++) {
        const subset = palette.filter(() => rnd() < 0.6)
        const m = mix(subset.length ? subset : palette, rnd)
        expect(isRoadPixel(m[0], m[1], m[2], colours), `${JSON.stringify(content)} ${m}`).toBe(
          false,
        )
      }
      // Every pair of palette colours, in 1/255 steps (antialiased edges, halos).
      for (const a of palette)
        for (const b of palette)
          for (let k = 0; k <= 255; k++) {
            const t = k / 255
            const p = [0, 1, 2].map((c) => Math.round(a[c]! * (1 - t) + b[c]! * t))
            expect(isRoadPixel(p[0]!, p[1]!, p[2]!, colours)).toBe(false)
          }
    }
  })

  it('detects exact and slightly shaded road colours, not beyond the tolerance', () => {
    for (const content of CONFIGS)
      for (const { rgb } of detectableRoadColours(content)) {
        const colours = detectableRoadColours(content)
        expect(isRoadPixel(rgb[0], rgb[1], rgb[2], colours)).toBe(true)
        const t = ROAD_PIXEL_TOLERANCE
        expect(isRoadPixel(rgb[0] + t, rgb[1] - t, rgb[2] + t, colours)).toBe(true)
        expect(isRoadPixel(rgb[0] + t + 1, rgb[1], rgb[2], colours)).toBe(false)
      }
  })
})

describe('countRoadPixels', () => {
  const content = { labels: true, probes: false }
  const colours = detectableRoadColours(content)
  const bg = hexToRgb(COLORS.background)
  const text = hexToRgb(COLORS.textMuted)
  const halo = hexToRgb(COLORS.halo)
  const casing = hexToRgb(COLORS.motorwayCasing)

  it('a frame of background and label pixels has no road pixel', () => {
    const rnd = seededRandom(7)
    const pixels: Rgb[] = [bg, text, halo, casing]
    for (let i = 0; i < 1000; i++) pixels.push(mix([bg, text, halo, casing], rnd))
    expect(countRoadPixels(frame(pixels), colours)).toBe(0)
  })

  it('counts motorway pixels among labels and minor roads (minor is not detectable with labels)', () => {
    const pixels: Rgb[] = [bg, text, ROAD_FILL.motorway, halo, ROAD_FILL.minor, ROAD_FILL.motorway]
    expect(countRoadPixels(frame(pixels), colours)).toBe(2)
    const noLabels = detectableRoadColours({ labels: false, probes: false })
    expect(countRoadPixels(frame(pixels), noLabels)).toBe(3)
  })

  it('an empty or background-only buffer has no road pixel', () => {
    expect(countRoadPixels(new Uint8Array(0), colours)).toBe(0)
    expect(countRoadPixels(frame([bg, bg, bg]), colours)).toBe(0)
  })
})
