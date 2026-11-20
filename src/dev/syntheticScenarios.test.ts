import { describe, expect, it } from 'vitest'
import { decodeTile, ROAD_FLAG_CHORD } from '@/domain/mapTile'
import { encodeTile } from '@/test/tileFixtures'
import {
  buildScenario,
  SCENARIOS,
  ScenarioTiles,
  seededRandom,
  type ScenarioId,
} from './syntheticScenarios'

const fingerprint = (id: ScenarioId, n?: number) => {
  const s = buildScenario(id, n)
  let h = 0
  for (const r of s.roads) for (const v of r.points) h = (h * 31 + Math.round(v * 16)) | 0
  return { contentId: s.contentId, segments: s.segments, roads: s.roads.length, h }
}

describe('synthetic scenarios', () => {
  it('are reproducible: same seed, same network, same content id', () => {
    for (const { id } of SCENARIOS.filter((s) => s.id !== 'stress'))
      expect(fingerprint(id, 20_000)).toEqual(fingerprint(id, 20_000))
    const a = seededRandom(7)
    const b = seededRandom(7)
    expect([a(), a(), a()]).toEqual([b(), b(), b()])
  })

  it('give each scenario and size its own content id', () => {
    const ids = new Set(SCENARIOS.map((s) => buildScenario(s.id, 1000).contentId))
    expect(ids.size).toBe(SCENARIOS.length)
    expect(buildScenario('large', 1000).contentId).not.toBe(buildScenario('large', 2000).contentId)
    for (const id of ids) expect(id).toMatch(/^[0-9a-f]{16}$/)
  })

  it('build the large map with exactly 100,000 and the stress test with 1,000,000 segments', () => {
    expect(buildScenario('large').segments).toBe(100_000)
    expect(buildScenario('stress').segments).toBe(1_000_000)
    expect(buildScenario('large', 12_345).segments).toBe(12_345)
  }, 30_000)

  it('cover every road class, chords and rail in the mixed network', () => {
    const s = buildScenario('large', 50_000)
    const classes = new Set(s.roads.map((r) => r.roadClass))
    expect(classes).toEqual(new Set(['motorway', 'primary', 'local', 'minor', 'rail']))
    expect(s.roads.some((r) => r.flags & ROAD_FLAG_CHORD)).toBe(true)
    for (const r of s.roads)
      for (let i = 0; i < r.points.length; i += 2) {
        expect(r.points[i]).toBeGreaterThanOrEqual(s.bounds[0] - 1)
        expect(r.points[i]).toBeLessThanOrEqual(s.bounds[2] + 1)
      }
  })

  it('list a road crossing tile borders in every tile it touches, relative to each origin', () => {
    const s = buildScenario('tileBorders')
    const tiles = new ScenarioTiles(s)
    // The diagonal motorway from (0, 0) to (4096, 4096) passes tiles (0,0) … (3,3).
    const diagonal = s.roads.findIndex((r) => r.roadClass === 'motorway')
    for (let k = 0; k < 4; k++) {
      const t = tiles.tile(0, k, k)
      const road = t.roads.find((r) => r.index === diagonal)!
      expect(road).toBeDefined()
      expect(t.points[road.first * 2]).toBe(0 - k * 1024)
    }
    expect(tiles.tile(0, 3, 0).roads.some((r) => r.index === diagonal)).toBe(false)
  })

  it('make tiles the production decoder accepts', () => {
    const s = buildScenario('crossings')
    const tiles = new ScenarioTiles(s)
    const t = tiles.tile(0, 1, 1)
    expect(t.roads.length).toBeGreaterThan(0)
    const request = { contentId: s.contentId, level: 0, x: 1, z: 1, tileSize: 1024 }
    const encoded = encodeTile(
      request,
      t.roads.map((r) => ({
        index: r.index,
        roadClass: r.roadClass,
        flags: r.flags,
        points: Array.from({ length: r.count }, (_, i) => [
          t.points[(r.first + i) * 2]! + t.originX,
          t.points[(r.first + i) * 2 + 1]! + t.originZ,
        ]) as [number, number][],
      })),
    )
    const decoded = decodeTile(encoded, request)!
    expect(decoded).not.toBeNull()
    expect(decoded.roads.map((r) => r.index)).toEqual(t.roads.map((r) => r.index))
    expect(decoded.byteLength).toBe(t.byteLength)
  })

  it('choose visible tiles like the dashboard in auto mode, and level 0 in full mode', () => {
    const s = buildScenario('large', 20_000)
    const tiles = new ScenarioTiles(s)
    const size = { width: 1280, height: 900 }
    const whole = { cx: 0, cz: 0, scale: 1280 / (s.bounds[2] - s.bounds[0]) }
    const auto = tiles.visible('auto', whole, size)
    const full = tiles.visible('full', whole, size)
    expect(full.level).toBe(0)
    expect(auto.tiles.length).toBeLessThanOrEqual(128)
    // Full detail at the whole map draws every road of the map once or more.
    const drawn = new Set(full.tiles.flatMap((t) => t.roads.map((r) => r.index)))
    expect(drawn.size).toBe(s.roads.length)
  })
})
