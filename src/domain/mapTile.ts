/**
 * Decoder of the binary map tiles of `map_tile` (format version 1, specified in
 * `src-tauri/src/map/tiles.rs`). Every field is checked; anything malformed or unexpected is
 * rejected as a whole (`null`) and never drawn.
 */

export const TILE_MAGIC = 'RPMT'
export const TILE_FORMAT_VERSION = 1
export const TILE_HEADER_BYTES = 56
export const TILE_ROAD_BYTES = 12
/** Upper bounds of the backend; a larger tile is rejected. */
export const MAX_TILE_ROADS = 30_000
export const MAX_TILE_POINTS = 120_000

/** Road classes of the backend (display heuristic from lane types). */
export const ROAD_CLASSES = ['motorway', 'primary', 'local', 'minor', 'rail'] as const
export type RoadClass = (typeof ROAD_CLASSES)[number]

export const ROAD_FLAG_ESTIMATED = 1
export const ROAD_FLAG_CHORD = 2
export const ROAD_FLAG_LENGTH_INCONSISTENT = 4

export interface TileRoad {
  /** Position of the road in the package. */
  index: number
  /** Index of the first point in `MapTile.points` (pairs). */
  first: number
  count: number
  roadClass: RoadClass
  flags: number
}

export interface MapTile {
  level: number
  x: number
  z: number
  tileSize: number
  /** World coordinates of the tile corner; points are relative to it. */
  originX: number
  originZ: number
  truncated: boolean
  contentId: string
  roads: TileRoad[]
  /** x, z pairs relative to the origin (map world units). */
  points: Float32Array
  byteLength: number
}

export interface TileRequest {
  contentId: string
  level: number
  x: number
  z: number
  tileSize: number
}

export function decodeTile(buffer: ArrayBuffer, expected: TileRequest): MapTile | null {
  if (!(buffer instanceof ArrayBuffer) || buffer.byteLength < TILE_HEADER_BYTES) return null
  const view = new DataView(buffer)
  const magic = String.fromCharCode(...new Uint8Array(buffer, 0, 4))
  if (magic !== TILE_MAGIC || view.getUint16(4, true) !== TILE_FORMAT_VERSION) return null
  const level = view.getUint8(6)
  const flags = view.getUint8(7)
  const x = view.getInt32(8, true)
  const z = view.getInt32(12, true)
  const tileSize = view.getFloat32(16, true)
  const originX = view.getFloat64(24, true)
  const originZ = view.getFloat64(32, true)
  const roadCount = view.getUint32(40, true)
  const pointCount = view.getUint32(44, true)
  const contentId = view.getBigUint64(48, true).toString(16).padStart(16, '0')

  // The tile must be exactly the one requested, of the expected package.
  if (
    level !== expected.level ||
    x !== expected.x ||
    z !== expected.z ||
    tileSize !== expected.tileSize ||
    contentId !== expected.contentId ||
    originX !== x * tileSize ||
    originZ !== z * tileSize ||
    (flags & ~1) !== 0
  )
    return null
  if (roadCount > MAX_TILE_ROADS || pointCount > MAX_TILE_POINTS) return null
  const pointsOffset = TILE_HEADER_BYTES + roadCount * TILE_ROAD_BYTES
  if (buffer.byteLength !== pointsOffset + pointCount * 8) return null

  const roads: TileRoad[] = []
  let expectedFirst = 0
  for (let i = 0; i < roadCount; i++) {
    const o = TILE_HEADER_BYTES + i * TILE_ROAD_BYTES
    const first = view.getUint32(o + 4, true)
    const count = view.getUint16(o + 8, true)
    const roadClass = ROAD_CLASSES[view.getUint8(o + 10)]
    const roadFlags = view.getUint8(o + 11)
    // Roads are stored back to back; anything else is a malformed tile.
    if (!roadClass || first !== expectedFirst || count < 2 || (roadFlags & ~7) !== 0) return null
    expectedFirst += count
    roads.push({ index: view.getUint32(o, true), first, count, roadClass, flags: roadFlags })
  }
  if (expectedFirst !== pointCount) return null
  const points = new Float32Array(buffer, pointsOffset, pointCount * 2)
  for (const v of points) if (!Number.isFinite(v)) return null
  return {
    level,
    x,
    z,
    tileSize,
    originX,
    originZ,
    truncated: (flags & 1) !== 0,
    contentId,
    roads,
    points,
    byteLength: buffer.byteLength,
  }
}
