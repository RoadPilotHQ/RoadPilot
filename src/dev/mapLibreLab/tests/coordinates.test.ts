import { describe, expect, it } from 'vitest'
import { fitBounds, toScreen } from '@/domain/mapViewport'
import {
  cameraOf,
  CARRIER_SCALE,
  expectedScreen,
  fromCarrier,
  pixelsPerUnit,
  SCS_DEFINITION,
  scsConversion,
  scsCrs,
  toCarrier,
  toDisplay,
  viewportOf,
  WORLD_EXTENT,
  WORLD_ORIGIN,
  zoomForScale,
} from '../coordinates'
import { scsProjectionHandler } from '../scsProjection.worker.mjs'

const POINTS = [
  { x: 0, z: 0 },
  { x: 12_345.678, z: 0 },
  { x: -12_345.678, z: 0 },
  { x: 0, z: 54_321.125 },
  { x: 0, z: -54_321.125 },
  { x: -100_000, z: -70_000 },
  { x: -100_000.0001, z: -69_999.9999 },
  { x: 131_071.99, z: -131_071.99 },
  { x: -131_072, z: 131_072 },
  { x: 0.1, z: -0.3 },
]

describe('display convention', () => {
  it('maps source (X, Z) to display (X, −Z) with no scale or offset', () => {
    for (const p of POINTS) {
      const [x, y] = toDisplay(p)
      expect(x).toBe(p.x)
      expect(y === -p.z || (y === 0 && p.z === 0)).toBe(true)
    }
  })

  it('crosses the MapLibre API as display / 2¹¹, bit-exactly in both directions', () => {
    for (const p of POINTS) {
      const [lng, lat] = toCarrier(p)
      expect(Math.abs(lat)).toBeLessThanOrEqual(90)
      expect(lng * CARRIER_SCALE).toBe(p.x)
      const back = fromCarrier(lng, lat)
      expect(back.x).toBe(p.x)
      expect(back.z === p.z || (back.z === 0 && p.z === 0)).toBe(true)
    }
  })

  it('the CRS converter turns carriers into display coordinates in native units', () => {
    for (const p of POINTS) {
      const crsXY = scsConversion.forward(toCarrier(p))
      expect(crsXY[0]).toBe(toDisplay(p)[0])
      expect(crsXY[1]).toBe(toDisplay(p)[1])
      expect(scsConversion.inverse(crsXY)).toEqual(toCarrier(p))
    }
  })

  it('is linear: no Mercator stretch towards high carrier latitudes', () => {
    const near = scsConversion.forward([0, 1])[1]! - scsConversion.forward([0, 0])[1]!
    const far = scsConversion.forward([0, 64])[1]! - scsConversion.forward([0, 63])[1]!
    expect(far).toBe(near)
  })

  it('the workers rebuild exactly the same converter from the definition string', () => {
    const worker = scsProjectionHandler(SCS_DEFINITION)
    for (const p of POINTS) {
      const c = toCarrier(p)
      expect(worker.forward(c)).toEqual(scsConversion.forward(c))
      expect(worker.inverse(scsConversion.forward(c))).toEqual(c)
    }
    expect(() => scsProjectionHandler('EPSG:3857')).toThrow()
  })
})

describe('tile matrix set', () => {
  it('is a 2¹⁸ square centred on the origin, covering the SCS-like magnitudes', () => {
    expect(WORLD_EXTENT).toBe(262_144)
    expect(scsCrs.tileMatrixSet.origin).toEqual([-131_072, 131_072])
    expect(scsCrs.tileMatrixSet.extentAtZoom0).toBe(WORLD_EXTENT)
    expect(scsCrs.name).toContain(':')
    expect(WORLD_ORIGIN[0] + WORLD_EXTENT).toBe(131_072)
  })
})

describe('expected screen positions', () => {
  const size = { width: 980, height: 900 }
  const center = { x: -100_000, z: -70_000 }

  it('puts east to the right and south (+Z) down, with equal scale on both axes', () => {
    for (const zoom of [0, 4.5, 9, 13]) {
      const o = expectedScreen(center, zoom, size, center)
      expect(o).toEqual({ x: 490, y: 450 })
      const east = expectedScreen(center, zoom, size, { x: center.x + 10, z: center.z })
      const south = expectedScreen(center, zoom, size, { x: center.x, z: center.z + 10 })
      expect(east.x - o.x).toBeCloseTo(10 * pixelsPerUnit(zoom), 12)
      expect(east.y).toBe(o.y)
      expect(south.y - o.y).toBeCloseTo(east.x - o.x, 12)
      expect(south.x).toBe(o.x)
    }
  })

  it('matches the production viewport transform (`toScreen`) at the same scale', () => {
    for (const zoom of [1, 5, 9, 11.3])
      for (const p of POINTS) {
        const vp = { cx: center.x, cz: center.z, scale: pixelsPerUnit(zoom) }
        const a = expectedScreen(center, zoom, size, p)
        const b = toScreen(vp, size, p.x, p.z)
        expect(a.x).toBeCloseTo(b.x, 6)
        expect(a.y).toBeCloseTo(b.y, 6)
      }
  })

  it('B1.2 F1: camera and viewport agree for both CRS selections', () => {
    const size = { width: 980, height: 900 }
    const bounds: [number, number, number, number] = [-130_000, -90_000, -70_000, -50_000]
    const fitted = fitBounds(bounds, size)!
    for (const crs of ['scs', 'identity'] as const) {
      // Whole-map camera (as the lab builds it) handed to the M3 viewport: same scale back.
      const camera = cameraOf(fitted, crs)
      const vp = viewportOf(camera, crs)
      expect(vp.cx).toBe(fitted.cx)
      expect(vp.cz).toBe(fitted.cz)
      expect(vp.scale).toBeCloseTo(fitted.scale, 12)
      expect(vp.scale).toBe(pixelsPerUnit(camera.zoom, crs))
      // A point lands on the same screen position through MapLibre's math and through M3's.
      const p = { x: -100_000, z: -70_000 }
      const a = expectedScreen(camera.center, camera.zoom, size, p, crs)
      const b = toScreen(vp, size, p.x, p.z)
      expect(a.x).toBeCloseTo(b.x, 6)
      expect(a.y).toBeCloseTo(b.y, 6)
    }
    // The same scale needs different zoom levels in the two CRSs (368,640 / 262,144 units).
    const zs = cameraOf(fitted, 'scs').zoom
    const zi = cameraOf(fitted, 'identity').zoom
    expect(zi - zs).toBeCloseTo(Math.log2(368_640 / 262_144), 12)
    // The B1 defect: reading an identity zoom with the scs scale gave 368,640 / 262,144 ≈ 1.41 ×
    // the intended scale (M3 zoomed in), not 0.71 × as the B1.1 audit first stated.
    expect(pixelsPerUnit(zi, 'scs') / fitted.scale).toBeCloseTo(368_640 / 262_144, 12)
  })

  it('zoom 9 is one CSS pixel per unit in roadpilot:scs; zoomForScale inverts it', () => {
    expect(pixelsPerUnit(9)).toBe(1)
    for (const s of [1 / 16_384, 0.05, 0.4, 1, 5])
      expect(pixelsPerUnit(zoomForScale(s))).toBeCloseTo(s, 12)
    // The built-in identity CRS spans 180 carrier units = 368,640 native units.
    expect(pixelsPerUnit(0, 'identity')).toBeCloseTo(512 / 368_640, 15)
  })
})
