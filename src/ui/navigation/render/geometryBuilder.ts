/**
 * PROTOTYPE (M2): builds the per-tile instance buffer of the WebGL renderer. Pure, no GL.
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

/** Segments of a road that are drawable (both ends finite, not zero length). */
function forEachSegment(
  pts: Float32Array,
  first: number,
  count: number,
  emit: (i: number, dist0: number) => void,
): { emitted: number; skipped: number } {
  let dist = 0
  let emitted = 0
  let skipped = 0
  let zeroLength = -1
  for (let s = 0; s < count - 1; s++) {
    const i = (first + s) * 2
    const x0 = pts[i]!
    const z0 = pts[i + 1]!
    const x1 = pts[i + 2]!
    const z1 = pts[i + 3]!
    if (!finite(x0) || !finite(z0) || !finite(x1) || !finite(z1)) {
      skipped++
      continue
    }
    const len = Math.hypot(x1 - x0, z1 - z0)
    if (len === 0) {
      if (zeroLength < 0) zeroLength = i
      continue
    }
    emit(i, dist)
    dist += len
    emitted++
  }
  // A road of only one repeated point is kept as a dot, as a round cap would draw it.
  if (emitted === 0 && zeroLength >= 0) {
    emit(zeroLength, 0)
    emitted = 1
  }
  return { emitted, skipped }
}

export function buildTileGeometry(tile: SyntheticTile): TileGeometry {
  const pts = tile.points
  const pointPairs = Math.floor(pts.length / 2)
  const order = DRAW_ORDER
  const slot = (c: RoadClass, chord: boolean) => order.indexOf(c) * 2 + (chord ? 1 : 0)
  let skippedRoads = 0

  const valid = (r: SyntheticTile['roads'][number]) =>
    r.count >= 2 &&
    r.first >= 0 &&
    r.first + r.count <= pointPairs &&
    ROAD_CLASSES.includes(r.roadClass) &&
    Number.isInteger(r.first) &&
    Number.isInteger(r.count)

  // Pass 1: instances per slot.
  const perSlot = new Array<number>(order.length * 2).fill(0)
  const roadSlots: number[] = []
  const roadInstances: number[] = []
  for (const road of tile.roads) {
    if (!valid(road)) {
      skippedRoads++
      roadSlots.push(-1)
      roadInstances.push(0)
      continue
    }
    const { emitted } = forEachSegment(pts, road.first, road.count, () => {})
    const s = slot(road.roadClass, (road.flags & ROAD_FLAG_CHORD) !== 0)
    if (emitted === 0) skippedRoads++
    roadSlots.push(emitted === 0 ? -1 : s)
    roadInstances.push(emitted)
    perSlot[s]! += emitted
  }

  const offsets: number[] = []
  let total = 0
  for (const n of perSlot) {
    offsets.push(total)
    total += n
  }
  const groups: GroupRange[] = order.map((roadClass, k) => ({
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
  tile.roads.forEach((road, r) => {
    const s = roadSlots[r]!
    if (s < 0) return
    roads++
    const cls = ROAD_CLASSES.indexOf(road.roadClass)
    const flags = road.flags & 0xff
    const { skipped } = forEachSegment(pts, road.first, road.count, (i, dist0) => {
      const n = cursor[s]!++
      const f = n * INSTANCE_FLOATS
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
      u8[n * INSTANCE_BYTES + OFFSET_META] = cls
      u8[n * INSTANCE_BYTES + OFFSET_META + 1] = flags
      minX = Math.min(minX, x0, x1)
      maxX = Math.max(maxX, x0, x1)
      minZ = Math.min(minZ, z0, z1)
      maxZ = Math.max(maxZ, z0, z1)
    })
    skippedSegments += skipped
  })

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
