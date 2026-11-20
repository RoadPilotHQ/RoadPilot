/** Tiles for the renderer tests: roads in tile-local coordinates. */
import type { MapTile, RoadClass } from '@/domain/mapTile'
import { ROAD_FLAG_ESTIMATED } from '@/domain/mapTile'

export interface R {
  roadClass?: RoadClass
  flags?: number
  points: number[]
  /** Override for malformed entries. */
  first?: number
  count?: number
}

export function tileOf(roads: R[], extra: Partial<MapTile> = {}): MapTile {
  const all: number[] = []
  const entries = roads.map((r, index) => {
    const first = all.length / 2
    all.push(...r.points)
    return {
      index,
      first: r.first ?? first,
      count: r.count ?? r.points.length / 2,
      roadClass: r.roadClass ?? 'local',
      flags: r.flags ?? ROAD_FLAG_ESTIMATED,
    }
  })
  return {
    level: 0,
    x: 0,
    z: 0,
    tileSize: 1024,
    originX: 0,
    originZ: 0,
    truncated: false,
    contentId: 'aaaaaaaaaaaaaaaa',
    roads: entries,
    points: new Float32Array(all),
    byteLength: 0,
    ...extra,
  }
}
