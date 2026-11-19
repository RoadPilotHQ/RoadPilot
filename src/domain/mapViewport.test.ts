import { describe, expect, it } from 'vitest'
import {
  chooseLevel,
  fitBounds,
  MAX_SCALE,
  MAX_VISIBLE_TILES,
  MIN_SCALE,
  panBy,
  scaleBarUnits,
  tilesFor,
  toScreen,
  toWorld,
  visibleBounds,
  zoomAt,
  type Bounds,
} from './mapViewport'

const SIZES = [1024, 4096, 16384, 65536]
const size = { width: 800, height: 400 }
const ATS: Bounds = [-119599, -72101, 40644, 75090]

describe('map viewport', () => {
  it('fits the whole map with one scale for both axes', () => {
    const vp = fitBounds(ATS, size)!
    const [minX, minZ, maxX, maxZ] = visibleBounds(vp, size)
    expect(minX).toBeLessThanOrEqual(ATS[0])
    expect(maxX).toBeGreaterThanOrEqual(ATS[2])
    expect(minZ).toBeLessThanOrEqual(ATS[1])
    expect(maxZ).toBeGreaterThanOrEqual(ATS[3])
    expect(fitBounds(ATS, { width: 0, height: 400 })).toBeNull()
    expect(fitBounds([0, 0, Number.NaN, 1], size)).toBeNull()
  })

  it('draws north up: east to the right, south down', () => {
    const vp = { cx: 0, cz: 0, scale: 1 }
    expect(toScreen(vp, size, 0, 0)).toEqual({ x: 400, y: 200 })
    expect(toScreen(vp, size, 100, 0).x).toBeGreaterThan(400)
    expect(toScreen(vp, size, 0, 100).y).toBeGreaterThan(200)
    const back = toWorld(vp, size, 450, 180)
    expect(back).toEqual({ x: 50, z: -20 })
  })

  it('pans with the pointer and zooms about the pointer', () => {
    const vp = { cx: 1000, cz: 2000, scale: 0.5 }
    const moved = panBy(vp, 100, -50)
    // Dragging right moves the map right: the centre moves west.
    expect(moved).toEqual({ cx: 800, cz: 2100, scale: 0.5 })
    const anchor = toWorld(vp, size, 600, 100)
    const zoomed = zoomAt(vp, size, 2, 600, 100)
    expect(zoomed.scale).toBe(1)
    const after = toWorld(zoomed, size, 600, 100)
    expect(after.x).toBeCloseTo(anchor.x)
    expect(after.z).toBeCloseTo(anchor.z)
  })

  it('keeps the zoom within its limits', () => {
    expect(zoomAt({ cx: 0, cz: 0, scale: MAX_SCALE }, size, 4, 0, 0).scale).toBe(MAX_SCALE)
    expect(zoomAt({ cx: 0, cz: 0, scale: MIN_SCALE }, size, 0.1, 0, 0).scale).toBe(MIN_SCALE)
  })

  it('lists the tiles of the view with a margin, nearest to the centre first', () => {
    const tiles = tilesFor([0, 0, 2047, 1023], 1024)
    expect(tiles).toHaveLength(4 * 3)
    expect(tiles.some((t) => t.x === -1 && t.z === -1)).toBe(true)
    expect(tiles.some((t) => t.x === 2 && t.z === 1)).toBe(true)
    const first = tiles[0]!
    expect(Math.abs(first.x - 0.5)).toBeLessThanOrEqual(1)
  })

  it('chooses a detailed level when zoomed in and a coarse one when zoomed out', () => {
    expect(chooseLevel({ cx: 0, cz: 0, scale: 1 }, size, SIZES).level).toBe(0)
    expect(chooseLevel({ cx: 0, cz: 0, scale: 0.1 }, size, SIZES).level).toBe(1)
    expect(chooseLevel({ cx: 0, cz: 0, scale: 0.01 }, size, SIZES).level).toBe(2)
    const whole = chooseLevel(fitBounds(ATS, size)!, size, SIZES, ATS)
    expect(whole.level).toBe(3)
    expect(whole.tiles.length).toBeLessThanOrEqual(MAX_VISIBLE_TILES)
  })

  it('never asks for more than its limit, even in a very large window', () => {
    const big = { width: 7680, height: 4320 }
    for (const scale of [2, 0.5, 0.1, 0.02, 0.004]) {
      const c = chooseLevel({ cx: -40000, cz: 0, scale }, big, SIZES, ATS)
      expect(c.tiles.length).toBeLessThanOrEqual(MAX_VISIBLE_TILES * 2)
    }
  })

  it('asks for nothing outside the map', () => {
    const c = chooseLevel({ cx: 5_000_000, cz: 0, scale: 1 }, size, SIZES, ATS)
    expect(c.tiles).toEqual([])
  })

  it('picks a round scale bar in map units', () => {
    expect(scaleBarUnits({ cx: 0, cz: 0, scale: 0.5 }, 800)).toEqual({ units: 200, px: 100 })
    expect(scaleBarUnits({ cx: 0, cz: 0, scale: 0.001 }, 800).units).toBe(200_000)
  })
})
