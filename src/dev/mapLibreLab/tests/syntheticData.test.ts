import { describe, expect, it } from 'vitest'
import { ScenarioTiles } from '../../syntheticScenarios'
import { CARRIER_SCALE } from '../coordinates'
import {
  buildDataset,
  citiesGeoJSON,
  LAB_CLASSES,
  roadsGeoJSON,
  THIN_WIDTHS,
  toM3Scenario,
  WORLD_LIMIT,
  type LabDataset,
} from '../syntheticData'

function inWorld(ds: LabDataset) {
  const [minX, minZ, maxX, maxZ] = ds.bounds
  return [minX, minZ, maxX, maxZ].every((v) => v > WORLD_LIMIT[0] && v < WORLD_LIMIT[1])
}

const classesOf = (ds: LabDataset) => new Set(ds.roads.map((r) => r.cls))

describe('scenario A – basic', () => {
  const ds = buildDataset('basic')

  it('is reproducible', () => {
    expect(buildDataset('basic').hash).toBe(ds.hash)
    expect(buildDataset('basic').segments).toBe(ds.segments)
  })

  it('has every road class, both signs on both axes and SCS-like magnitudes', () => {
    expect(classesOf(ds)).toEqual(new Set(LAB_CLASSES))
    const [minX, minZ, maxX, maxZ] = ds.bounds
    expect(minX).toBeLessThan(-100_000)
    expect(minZ).toBeLessThan(-70_000)
    expect(maxX).toBeGreaterThan(50_000)
    expect(maxZ).toBeGreaterThan(30_000)
    expect(inWorld(ds)).toBe(true)
    expect(ds.cities.length).toBeGreaterThan(0)
    expect(ds.roads.some((r) => r.name === 'M 1')).toBe(true)
  })
})

describe('scenario B – dense urban', () => {
  const ds = buildDataset('urban')

  it('has exactly 100,000 segments, reproducibly, around (−100,000, −70,000)', () => {
    expect(ds.segments).toBe(100_000)
    expect(ds.roads.reduce((n, r) => n + r.points.length / 2 - 1, 0)).toBe(100_000)
    expect(buildDataset('urban').hash).toBe(ds.hash)
    const [minX, minZ, maxX, maxZ] = ds.bounds
    expect((minX + maxX) / 2).toBeGreaterThan(-115_000)
    expect((minX + maxX) / 2).toBeLessThan(-85_000)
    expect((minZ + maxZ) / 2).toBeGreaterThan(-85_000)
    expect((minZ + maxZ) / 2).toBeLessThan(-55_000)
    expect(inWorld(ds)).toBe(true)
    expect(classesOf(ds)).toEqual(new Set(LAB_CLASSES))
  })

  it('contains short connectors (1–3 segments under 100 units)', () => {
    const short = ds.roads.filter((r) => {
      const segs = r.points.length / 2 - 1
      let len = 0
      for (let i = 0; i + 3 < r.points.length; i += 2)
        len += Math.hypot(r.points[i + 2]! - r.points[i]!, r.points[i + 3]! - r.points[i + 1]!)
      return segs <= 3 && len < 100
    })
    expect(short.length).toBeGreaterThan(100)
  })

  it('a different size is a different, still exact dataset', () => {
    const small = buildDataset('urban', 20_000)
    expect(small.segments).toBe(20_000)
    expect(small.hash).not.toBe(ds.hash)
  })
})

describe('scenario C – stress', () => {
  it('has exactly 1,000,000 segments, reproducibly, inside the world square', () => {
    const a = buildDataset('stress')
    expect(a.segments).toBe(1_000_000)
    expect(inWorld(a)).toBe(true)
    expect(a.bounds[0]).toBeLessThan(-100_000)
    expect(a.bounds[1]).toBeLessThan(-70_000)
    const b = buildDataset('stress')
    expect(b.hash).toBe(a.hash)
  }, 60_000)
})

describe('scenario D – thin roads', () => {
  it('draws every road with an explicit width of 0.5–3 px, in every row', () => {
    const ds = buildDataset('thin')
    const widths = new Set(ds.roads.map((r) => r.width))
    expect(widths).toEqual(new Set(THIN_WIDTHS))
    expect(ds.roads.every((r) => r.width! >= 0.5 && r.width! <= 3)).toBe(true)
    expect(buildDataset('thin').hash).toBe(ds.hash)
  })
})

/** Every road: a valid class, at least one segment, finite in-world points, no zero-length segment. */
function geometryIssues(ds: LabDataset) {
  const classes = new Set<string>(LAB_CLASSES)
  let zeroLength = 0
  let invalidPoints = 0
  let invalidClasses = 0
  let tooShort = 0
  let counted = 0
  for (const r of ds.roads) {
    if (!classes.has(r.cls)) invalidClasses++
    const p = r.points
    if (p.length < 4 || p.length % 2 !== 0) tooShort++
    counted += p.length / 2 - 1
    for (let i = 0; i < p.length; i++) {
      const v = p[i]!
      if (!Number.isFinite(v) || v <= WORLD_LIMIT[0] || v >= WORLD_LIMIT[1]) invalidPoints++
    }
    for (let i = 0; i + 3 < p.length; i += 2)
      if (p[i] === p[i + 2] && p[i + 1] === p[i + 3]) zeroLength++
  }
  return { zeroLength, invalidPoints, invalidClasses, tooShort, counted }
}

describe('B1.2 F6: valid geometry in every scenario', () => {
  const clean = { zeroLength: 0, invalidPoints: 0, invalidClasses: 0, tooShort: 0 }

  for (const id of ['basic', 'urban', 'thin'] as const) {
    it(`${id}: no zero-length segment, valid points and classes, exact count, deterministic`, () => {
      const ds = buildDataset(id)
      const issues = geometryIssues(ds)
      expect(issues).toMatchObject(clean)
      expect(issues.counted).toBe(ds.segments)
      if (id === 'urban') expect(ds.segments).toBe(100_000)
      expect(buildDataset(id).hash).toBe(ds.hash)
    })
  }

  it('stress: no zero-length segment, valid points and classes, exactly 1,000,000', () => {
    const ds = buildDataset('stress')
    const issues = geometryIssues(ds)
    expect(issues).toMatchObject(clean)
    expect(issues.counted).toBe(1_000_000)
    expect(ds.segments).toBe(1_000_000)
    expect(new Set(ds.roads.map((r) => r.cls))).toEqual(new Set(LAB_CLASSES))
  }, 60_000)

  it('small urban sizes stay exact and clean (motorways reach the area edge more often)', () => {
    for (const n of [1000, 5000, 20_000]) {
      const ds = buildDataset('urban', n)
      expect(ds.segments).toBe(n)
      expect(geometryIssues(ds)).toMatchObject({ ...clean, counted: n })
    }
  })

  it('motorway segments are exactly 250 units long (reflected, never clamped)', () => {
    for (const ds of [buildDataset('urban', 5000), buildDataset('urban')]) {
      const motorways = ds.roads.filter((r) => r.cls === 'motorway')
      expect(motorways.length).toBeGreaterThan(0)
      for (const r of motorways)
        for (let i = 0; i + 3 < r.points.length; i += 2) {
          const len = Math.hypot(
            r.points[i + 2]! - r.points[i]!,
            r.points[i + 3]! - r.points[i + 1]!,
          )
          expect(len).toBeCloseTo(250, 6)
        }
    }
  })
})

describe('conversions', () => {
  const ds = buildDataset('basic')

  it('GeoJSON carries the native coordinates as display / 2¹¹, unchanged otherwise', () => {
    const fc = roadsGeoJSON(ds)
    expect(fc.features.length).toBe(ds.roads.length)
    fc.features.forEach((f, i) => {
      const p = ds.roads[i]!.points
      f.geometry.coordinates.forEach(([lng, lat], k) => {
        expect(lng! * CARRIER_SCALE).toBe(p[k * 2])
        expect(-lat! * CARRIER_SCALE + 0).toBe(p[k * 2 + 1]! + 0)
      })
      expect(f.properties.c).toBe(ds.roads[i]!.cls)
    })
    expect(citiesGeoJSON(ds).features.length).toBe(ds.cities.length)
  })

  it('the M3 scenario holds the identical geometry and segment count', () => {
    const urban = buildDataset('urban', 20_000)
    const sc = toM3Scenario(urban)
    expect(sc.segments).toBe(urban.segments)
    expect(sc.roads.length).toBe(urban.roads.length)
    sc.roads.forEach((r, i) => expect(r.points).toBe(urban.roads[i]!.points))
    // The unchanged M3 tiler builds tiles from it.
    const tiles = new ScenarioTiles(sc).visible(
      'full',
      { cx: (sc.bounds[0] + sc.bounds[2]) / 2, cz: (sc.bounds[1] + sc.bounds[3]) / 2, scale: 0.02 },
      { width: 980, height: 900 },
    ).tiles
    expect(tiles.length).toBeGreaterThan(0)
  })
})
