/**
 * Synthetic map tiles for tests, encoded like `src-tauri/src/map/tiles.rs` (format 1).
 * `GOLDEN_TILE_HEX` is the exact output of the Rust encoder for a fixed synthetic map; both
 * sides test against it.
 */
import type { RoadClass } from '@/domain/mapTile'
import { ROAD_CLASSES } from '@/domain/mapTile'

export const GOLDEN_TILE_HEX =
  '52504d540100000001000000ffffffff0000804400000000000000000000904000000000000090c0' +
  '0200000004000000c804c419ba70ae20' +
  '010000000000000002000001' +
  '000000000200000002000202' +
  '0000d0410000c0410000d04100006043000098420000f84200008a430000f842'

export const GOLDEN_REQUEST = {
  contentId: '20ae70ba19c404c8',
  level: 0,
  x: 1,
  z: -1,
  tileSize: 1024,
}

export function hexToBuffer(hex: string): ArrayBuffer {
  const bytes = new Uint8Array(hex.length / 2)
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  return bytes.buffer
}

export interface SyntheticRoad {
  index?: number
  roadClass?: RoadClass
  flags?: number
  /** World coordinates `[x, z]`. */
  points: [number, number][]
}

/** Encodes a tile; world coordinates are made relative to the tile origin. */
export function encodeTile(
  { contentId, level, x, z, tileSize }: typeof GOLDEN_REQUEST,
  roads: SyntheticRoad[],
  truncated = false,
): ArrayBuffer {
  const pointCount = roads.reduce((n, r) => n + r.points.length, 0)
  const buffer = new ArrayBuffer(56 + roads.length * 12 + pointCount * 8)
  const v = new DataView(buffer)
  'RPMT'.split('').forEach((c, i) => v.setUint8(i, c.charCodeAt(0)))
  v.setUint16(4, 1, true)
  v.setUint8(6, level)
  v.setUint8(7, truncated ? 1 : 0)
  v.setInt32(8, x, true)
  v.setInt32(12, z, true)
  v.setFloat32(16, tileSize, true)
  v.setFloat64(24, x * tileSize, true)
  v.setFloat64(32, z * tileSize, true)
  v.setUint32(40, roads.length, true)
  v.setUint32(44, pointCount, true)
  v.setBigUint64(48, BigInt(`0x${contentId}`), true)
  let first = 0
  let p = 56 + roads.length * 12
  roads.forEach((r, i) => {
    const o = 56 + i * 12
    v.setUint32(o, r.index ?? i, true)
    v.setUint32(o + 4, first, true)
    v.setUint16(o + 8, r.points.length, true)
    v.setUint8(o + 10, ROAD_CLASSES.indexOf(r.roadClass ?? 'local'))
    v.setUint8(o + 11, r.flags ?? 1)
    first += r.points.length
    for (const [px, pz] of r.points) {
      v.setFloat32(p, px - x * tileSize, true)
      v.setFloat32(p + 4, pz - z * tileSize, true)
      p += 8
    }
  })
  return buffer
}
