/**
 * PROTOTYPE (M2, M3): builds the per-tile instance buffer of the WebGL renderer. Pure, no GL.
 *
 * One instance per road segment, 24 bytes, little endian (the M1 layout):
 *
 * | Offset | Field             | Type      |
 * | ------ | ----------------- | --------- |
 * | 0      | x0, z0            | 2 × f32   |
 * | 8      | x1, z1            | 2 × f32   |
 * | 16     | dist0             | f32       |
 * | 20     | road class        | u8        |
 * | 21     | road flags        | u8        |
 * | 22     | padding           | 2 bytes   |
 *
 * Coordinates stay relative to the tile origin. `dist0` is the length of the road from its
 * first point to the segment start, in world units, so a rail dash continues across joints.
 * Instances are sorted by draw group (class in draw order, solid roads before chords), so
 * each class is one contiguous range of the buffer.
 */
import { ROAD_CLASSES, ROAD_FLAG_CHORD, type RoadClass } from '@/domain/mapTile'
import type { SyntheticTile } from './types'
import { DRAW_ORDER } from './roadStyle'

export const INSTANCE_BYTES = 24
export const INSTANCE_FLOATS = INSTANCE_BYTES / 4
export const OFFSET_P0 = 0
export const OFFSET_P1 = 8
export const OFFSET_DIST0 = 16
export const OFFSET_META = 20

/** A contiguous range of instances of one road class. */
export interface GroupRange {
  roadClass: RoadClass
  /** First instance and instance count. */
  first: number
  count: number
  /** Instances of chords at the end of the range (drawn after the solid ones). */
  chords: number
}

export interface TileGeometry {
  /** Exactly `instances × 24` bytes. */
  data: ArrayBuffer
  instances: number
  /** One range per class in `DRAW_ORDER`, empty classes included (count 0). */
  groups: GroupRange[]
  /** Roads with at least one segment. */
  roads: number
  /** Roads or segments left out: too few points, out of range, non-finite coordinates. */
  skippedRoads: number
  skippedSegments: number
  /** Bounds of the geometry in tile-local coordinates, or null when empty. */
  bounds: [number, number, number, number] | null
}

const finite = Number.isFinite

/** Index of each class in `ROAD_CLASSES` (stored per instance) and its draw-order slot. */
const CLASS_INDEX = new Map<RoadClass, number>(ROAD_CLASSES.map((c, i) => [c, i]))
const DRAW_SLOT = new Map<RoadClass, number>(DRAW_ORDER.map((c, i) => [c, i]))

/**
 * Drawable segments of a road (both ends finite, not zero length); a road of only one
 * repeated point counts as one dot, as a round cap would draw it.
 */
function countSegments(pts: Float32Array, first: number, count: number): number {
  let emitted = 0
  let zero = false
  const end = (first + count - 1) * 2
  for (let i = first * 2; i < end; i += 2) {
    const x0 = pts[i]!
    const z0 = pts[i + 1]!
    const x1 = pts[i + 2]!
    const z1 = pts[i + 3]!
    if (!finite(x0) || !finite(z0) || !finite(x1) || !finite(z1)) continue
    // For finite values the length is zero exactly when both differences are.
    if (x1 === x0 && z1 === z0) zero = true
    else emitted++
  }
  return emitted > 0 ? emitted : zero ? 1 : 0
}

/**
 * M3: one pass to count, one to fill, without a closure or a `hypot` call per segment and
 * without searching the class lists per road. Same instances, order, groups and bounds as
 * M2; `dist0` sums `sqrt(dx² + dz²)` instead of `hypot`, equal up to float rounding.
 */
export function buildTileGeometry(tile: SyntheticTile): TileGeometry {
  const pts = tile.points
  const pointPairs = Math.floor(pts.length / 2)
  const list = tile.roads
  const n = list.length
  let skippedRoads = 0

  // Pass 1: instances per slot (class in draw order × solid/chord).
  const perSlot = new Array<number>(DRAW_ORDER.length * 2).fill(0)
  const roadSlot = new Int8Array(n)
  for (let r = 0; r < n; r++) {
    const road = list[r]!
    const slot = DRAW_SLOT.get(road.roadClass)
    const { first, count } = road
    const valid =
      count >= 2 &&
      first >= 0 &&
      first + count <= pointPairs &&
      slot !== undefined &&
      Number.isInteger(first) &&
      Number.isInteger(count)
    const emitted = valid ? countSegments(pts, first, count) : 0
    if (emitted === 0) {
      skippedRoads++
      roadSlot[r] = -1
      continue
    }
    const s = slot! * 2 + ((road.flags & ROAD_FLAG_CHORD) !== 0 ? 1 : 0)
    roadSlot[r] = s
    perSlot[s]! += emitted
  }

  const offsets: number[] = []
  let total = 0
  for (const c of perSlot) {
    offsets.push(total)
    total += c
  }
  const groups: GroupRange[] = DRAW_ORDER.map((roadClass, k) => ({
    roadClass,
    first: offsets[k * 2]!,
    count: perSlot[k * 2]! + perSlot[k * 2 + 1]!,
    chords: perSlot[k * 2 + 1]!,
  }))

  // Pass 2: fill.
  const data = new ArrayBuffer(total * INSTANCE_BYTES)
  const f32 = new Float32Array(data)
  const u8 = new Uint8Array(data)
  const cursor = offsets.slice()
  let minX = Infinity
  let minZ = Infinity
  let maxX = -Infinity
  let maxZ = -Infinity
  let skippedSegments = 0
  let roads = 0
  for (let r = 0; r < n; r++) {
    const s = roadSlot[r]!
    if (s < 0) continue
    const road = list[r]!
    roads++
    const cls = CLASS_INDEX.get(road.roadClass)!
    const flags = road.flags & 0xff
    const write = (i: number, dist0: number) => {
      const k = cursor[s]!++
      const f = k * INSTANCE_FLOATS
      // A dot (zero-length road) has p1 = p0.
      const x0 = pts[i]!
      const z0 = pts[i + 1]!
      const x1 = pts[i + 2]!
      const z1 = pts[i + 3]!
      f32[f] = x0
      f32[f + 1] = z0
      f32[f + 2] = x1
      f32[f + 3] = z1
      f32[f + 4] = dist0
      u8[k * INSTANCE_BYTES + OFFSET_META] = cls
      u8[k * INSTANCE_BYTES + OFFSET_META + 1] = flags
      if (x0 < minX) minX = x0
      if (x0 > maxX) maxX = x0
      if (x1 < minX) minX = x1
      if (x1 > maxX) maxX = x1
      if (z0 < minZ) minZ = z0
      if (z0 > maxZ) maxZ = z0
      if (z1 < minZ) minZ = z1
      if (z1 > maxZ) maxZ = z1
    }
    let dist = 0
    let emitted = 0
    let zeroAt = -1
    const end = (road.first + road.count - 1) * 2
    for (let i = road.first * 2; i < end; i += 2) {
      const x0 = pts[i]!
      const z0 = pts[i + 1]!
      const x1 = pts[i + 2]!
      const z1 = pts[i + 3]!
      if (!finite(x0) || !finite(z0) || !finite(x1) || !finite(z1)) {
        skippedSegments++
        continue
      }
      const dx = x1 - x0
      const dz = z1 - z0
      if (dx === 0 && dz === 0) {
        if (zeroAt < 0) zeroAt = i
        continue
      }
      write(i, dist)
      dist += Math.sqrt(dx * dx + dz * dz)
      emitted++
    }
    if (emitted === 0 && zeroAt >= 0) write(zeroAt, 0)
  }

  return {
    data,
    instances: total,
    groups,
    roads,
    skippedRoads,
    skippedSegments,
    bounds: total > 0 ? [minX, minZ, maxX, maxZ] : null,
  }
}
