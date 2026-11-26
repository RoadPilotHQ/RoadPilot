/**
 * B1.5.5: probe measurability and the corrected dot finder (`probeMeasure.ts`). Pure: synthetic
 * RGBA read-back buffers, no WebGL. The buffers reproduce the B1.5.4F situation: an opaque map
 * inside the CRS world and a transparent (cleared) area outside it.
 */
import { describe, expect, it } from 'vitest'
import { pixelsPerUnit } from '../coordinates'
import { buildStyle } from '../mapStyle'
import {
  BACKGROUND_RGB,
  FIND_RADIUS_PX,
  findDot,
  PROBE_EDGE_MARGIN_PX,
  PROBE_RADIUS_PX,
  PROBE_RGB,
  probeMeasurability,
  probePixelWeight,
  worldBoundsOf,
} from '../probeMeasure'

/** A `readPixels`-style RGBA buffer (rows from the bottom) of `w` × `h` device pixels. */
function frame(w: number, h: number) {
  const px = new Uint8Array(w * h * 4)
  const set = (x: number, y: number, rgba: readonly number[]) => {
    const i = ((h - 1 - y) * w + x) * 4
    px.set(rgba, i)
  }
  /** Paints the opaque background over device columns < `worldRight` (the rest stays cleared). */
  const world = (worldRight = w, worldBottom = h) => {
    for (let y = 0; y < Math.min(h, worldBottom); y++)
      for (let x = 0; x < Math.min(w, worldRight); x++) set(x, y, [...BACKGROUND_RGB, 255])
  }
  /** Draws an opaque, unblurred dot of `r` device px around a device-pixel position. */
  const dot = (cx: number, cy: number, r: number) => {
    for (let y = Math.floor(cy - r); y <= Math.ceil(cy + r); y++)
      for (let x = Math.floor(cx - r); x <= Math.ceil(cx + r); x++)
        if (Math.hypot(x + 0.5 - cx, y + 0.5 - cy) <= r) set(x, y, [...PROBE_RGB, 255])
  }
  return { px, set, world, dot }
}

describe('probe measurability (B1.5.5)', () => {
  it('the edge margin covers the search window and the dot, and matches the probe style', () => {
    expect(PROBE_EDGE_MARGIN_PX).toBe(FIND_RADIUS_PX + PROBE_RADIUS_PX)
    // The window reaches ceil(R · dpr) / dpr + 0.5 / dpr CSS px at most: < 11.5 for DPR ≥ 1.
    for (const dpr of [1, 1.25, 1.5, 2, 3])
      expect(Math.ceil(FIND_RADIUS_PX * dpr) / dpr + 0.5 / dpr).toBeLessThan(PROBE_EDGE_MARGIN_PX)
    const probe = buildStyle({ crs: 'scs', thin: false, labels: false, probes: true }).layers.find(
      (l) => l.id === 'probe',
    ) as { paint: Record<string, unknown> } | undefined
    expect(probe?.paint['circle-radius']).toBe(PROBE_RADIUS_PX)
  })

  it('world bounds follow the CRS', () => {
    expect(worldBoundsOf('scs')).toEqual({
      minX: -131072,
      maxX: 131072,
      minZ: -131072,
      maxZ: 131072,
    })
    expect(worldBoundsOf('identity').maxX).toBe(184320)
  })

  it('B1.5.4F zoom 1 probes: outside the world, within the margin, and measurable', () => {
    const s = pixelsPerUnit(1, 'scs') // 1/256 CSS px per unit
    // Centre (−120,000, 60,000), 980 × 900: the left column lies outside the world.
    const left = probeMeasurability({ x: -120_000 - (0.3 * 980) / s + 0.123, z: 60_000 }, 1, 'scs')
    expect(left).toMatchObject({ measurable: false, reason: 'outside_world' })
    expect(left.edgeDistancePx).toBeLessThan(0)
    // The bottom row: 7.6 CSS px inside the world edge, within the 13 px margin.
    const bottom = probeMeasurability(
      { x: -120_000, z: 60_000 + (0.3 * 900) / s - 0.377 },
      1,
      'scs',
    )
    expect(bottom).toMatchObject({ measurable: false, reason: 'edge_margin' })
    expect(bottom.edgeDistancePx).toBeCloseTo(7.6, 1)
    // The centre probe: about 43 CSS px inside.
    expect(probeMeasurability({ x: -120_000 + 0.123, z: 60_000 - 0.377 }, 1, 'scs')).toMatchObject({
      measurable: true,
      reason: null,
    })
  })

  it('the margin is exact at its boundary and scales with the zoom', () => {
    const at = (px: number, zoom: number) => {
      const s = pixelsPerUnit(zoom, 'scs')
      return probeMeasurability({ x: 131072 - px / s, z: 0 }, zoom, 'scs')
    }
    expect(at(PROBE_EDGE_MARGIN_PX, 3).measurable).toBe(true)
    expect(at(PROBE_EDGE_MARGIN_PX - 0.01, 3)).toMatchObject({ reason: 'edge_margin' })
    expect(at(-0.01, 13)).toMatchObject({ reason: 'outside_world' })
    // Deep inside at any zoom: measurable.
    for (const zoom of [1, 5, 9, 13])
      expect(probeMeasurability({ x: -100_000, z: -70_000 }, zoom, 'scs').measurable).toBe(true)
  })

  it('non-finite positions are never measurable', () => {
    expect(probeMeasurability({ x: NaN, z: 0 }, 5, 'scs').measurable).toBe(false)
  })
})

describe('findDot (B1.5.5)', () => {
  it('transparent, cleared pixels are never probe pixels (the B1.5.4F artefact)', () => {
    expect(probePixelWeight(0, 0, 0, 0)).toBe(0)
    expect(probePixelWeight(0, 0, 0, 255)).toBe(0) // opaque black: not on the mix either
    expect(probePixelWeight(...PROBE_RGB, 0)).toBe(0) // probe colour, but not opaque
    expect(probePixelWeight(...PROBE_RGB, 255)).toBe(1)
    expect(probePixelWeight(...BACKGROUND_RGB, 255)).toBe(0)
  })

  it('anti-aliased mixes count with their fraction; foreign colours do not', () => {
    const mix = (t: number) =>
      BACKGROUND_RGB.map((b, i) => Math.round(b + (PROBE_RGB[i]! - b) * t)) as [
        number,
        number,
        number,
      ]
    expect(probePixelWeight(...mix(0.5), 255)).toBeCloseTo(0.5, 1)
    expect(probePixelWeight(...mix(0.25), 255)).toBeCloseTo(0.25, 1)
    // A road colour (motorway orange) and a label colour are not probe pixels.
    expect(probePixelWeight(0xe8, 0x79, 0x2e, 255)).toBe(0)
    expect(probePixelWeight(0x29, 0x27, 0x24, 255)).toBe(0)
  })

  it('a fully cleared window gives null: a missing dot stays missing (before: a false centroid)', () => {
    const f = frame(200, 200) // nothing painted: the cleared area outside the world
    expect(findDot(f.px, 200, 200, 1, { x: 100, y: 100 })).toBeNull()
  })

  it('a world without the dot gives null', () => {
    const f = frame(200, 200)
    f.world()
    expect(findDot(f.px, 200, 200, 1, { x: 100, y: 100 })).toBeNull()
  })

  it('finds a drawn dot at its centre, at DPR 1 and 1.5', () => {
    for (const dpr of [1, 1.5]) {
      const f = frame(300, 300)
      f.world()
      const at = { x: 100.25, y: 80.75 } // CSS px
      f.dot(at.x * dpr, at.y * dpr, PROBE_RADIUS_PX * dpr)
      const found = findDot(f.px, 300, 300, dpr, at)
      expect(found).not.toBeNull()
      expect(Math.hypot(found!.x - at.x, found!.y - at.y) * dpr).toBeLessThan(0.5)
    }
  })

  it('a dot next to the cleared area is not pulled towards it (B1.5.4F edge case)', () => {
    const f = frame(200, 200)
    f.world(105) // world edge 5 px right of the dot centre; the window reaches 10 px
    f.dot(100, 100, PROBE_RADIUS_PX)
    const found = findDot(f.px, 200, 200, 1, { x: 100, y: 100 })
    expect(found).not.toBeNull()
    expect(Math.hypot(found!.x - 100, found!.y - 100)).toBeLessThan(0.1)
  })
})
