import { describe, expect, it } from 'vitest'
import { buildScenario, ScenarioTiles } from '@/dev/syntheticScenarios'
import {
  ROAD_CLASSES,
  ROAD_FLAG_CHORD,
  ROAD_FLAG_ESTIMATED,
  type MapTile,
  type RoadClass,
} from '@/domain/mapTile'
import { fitBounds } from '@/domain/mapViewport'
import { tileOf } from '@/test/renderTiles'
import {
  buildTileGeometry,
  INSTANCE_BYTES,
  OFFSET_DIST0,
  OFFSET_META,
  OFFSET_P0,
  OFFSET_P1,
} from './geometryBuilder'
import { DRAW_ORDER } from './roadStyle'

const view = (data: ArrayBuffer) => new DataView(data)

describe('buildTileGeometry', () => {
  it('writes 24 bytes per segment in the M1 layout, little endian', () => {
    const g = buildTileGeometry(
      tileOf([{ roadClass: 'primary', flags: 1, points: [1, 2, 4, 6, 4, 16] }]),
    )
    expect(INSTANCE_BYTES).toBe(24)
    expect(g.instances).toBe(2)
    expect(g.data.byteLength).toBe(48)
    const v = view(g.data)
    expect(v.getFloat32(OFFSET_P0, true)).toBe(1)
    expect(v.getFloat32(OFFSET_P0 + 4, true)).toBe(2)
    expect(v.getFloat32(OFFSET_P1, true)).toBe(4)
    expect(v.getFloat32(OFFSET_P1 + 4, true)).toBe(6)
    expect(v.getFloat32(OFFSET_DIST0, true)).toBe(0)
    expect(v.getUint8(OFFSET_META)).toBe(ROAD_CLASSES.indexOf('primary'))
    expect(v.getUint8(OFFSET_META + 1)).toBe(1)
    expect(v.getUint16(22, true)).toBe(0) // padding
    // Second segment starts where the first ended; dist0 = length of the first (5).
    expect(v.getFloat32(24 + OFFSET_P0, true)).toBe(4)
    expect(v.getFloat32(24 + OFFSET_DIST0, true)).toBe(5)
  })

  it('accumulates dist0 along a road and restarts it for the next road', () => {
    const g = buildTileGeometry(
      tileOf([{ points: [0, 0, 3, 4, 3, 14, 3, 24] }, { points: [100, 0, 110, 0] }]),
    )
    const v = view(g.data)
    const dist = [0, 1, 2, 3].map((i) => v.getFloat32(i * 24 + OFFSET_DIST0, true))
    expect(dist).toEqual([0, 5, 15, 0])
  })

  it('stores road class and flags per instance', () => {
    const g = buildTileGeometry(
      tileOf(
        ROAD_CLASSES.map((roadClass, i) => ({
          roadClass,
          flags: i % 2 ? ROAD_FLAG_CHORD : ROAD_FLAG_ESTIMATED | 4,
          points: [i, 0, i, 10],
        })),
      ),
    )
    const v = view(g.data)
    const metas = Array.from({ length: g.instances }, (_, i) => [
      ROAD_CLASSES[v.getUint8(i * 24 + OFFSET_META)],
      v.getUint8(i * 24 + OFFSET_META + 1),
    ])
    expect(metas).toEqual(
      DRAW_ORDER.map((c) => {
        const i = ROAD_CLASSES.indexOf(c)
        return [c, i % 2 ? ROAD_FLAG_CHORD : 5]
      }),
    )
  })

  it('sorts instances into one contiguous range per class in draw order, chords last', () => {
    const g = buildTileGeometry(
      tileOf([
        { roadClass: 'motorway', points: [0, 0, 1, 0, 2, 0] },
        { roadClass: 'rail', points: [0, 1, 1, 1] },
        { roadClass: 'local', flags: ROAD_FLAG_CHORD, points: [0, 2, 9, 2] },
        { roadClass: 'local', points: [0, 3, 1, 3, 2, 3] },
        { roadClass: 'motorway', points: [0, 4, 1, 4] },
      ]),
    )
    expect(g.groups.map((r) => r.roadClass)).toEqual(DRAW_ORDER)
    const byClass = Object.fromEntries(g.groups.map((r) => [r.roadClass, r]))
    expect(byClass.rail).toEqual({ roadClass: 'rail', first: 0, count: 1, chords: 0 })
    expect(byClass.minor).toMatchObject({ first: 1, count: 0 })
    expect(byClass.local).toEqual({ roadClass: 'local', first: 1, count: 3, chords: 1 })
    expect(byClass.primary).toMatchObject({ first: 4, count: 0 })
    expect(byClass.motorway).toEqual({ roadClass: 'motorway', first: 4, count: 3, chords: 0 })
    // The chord is the last instance of the local range.
    expect(view(g.data).getFloat32(3 * 24 + OFFSET_P1, true)).toBe(9)
    let covered = 0
    for (const r of g.groups) {
      expect(r.first).toBe(covered)
      covered += r.count
    }
    expect(covered).toBe(g.instances)
  })

  it('keeps coordinates relative to the tile origin', () => {
    const g = buildTileGeometry(
      tileOf([{ points: [10, 20, 30, 40] }], { originX: 4096, originZ: -2048, x: 4, z: -2 }),
    )
    expect(view(g.data).getFloat32(0, true)).toBe(10)
    expect(g.bounds).toEqual([10, 20, 30, 40])
  })

  it('returns an empty geometry for an empty tile', () => {
    const g = buildTileGeometry(tileOf([]))
    expect(g.instances).toBe(0)
    expect(g.data.byteLength).toBe(0)
    expect(g.bounds).toBeNull()
    expect(g.groups.every((r) => r.count === 0)).toBe(true)
  })

  it('skips malformed roads and non-finite segments instead of drawing made-up geometry', () => {
    const t = tileOf([
      { points: [0, 0] }, // one point
      { points: [0, 0, 1, 1], first: 100, count: 2 }, // out of range
      { points: [0, 0, NaN, 1, 2, 2, 3, 3] }, // two segments touch the NaN
      { points: [Infinity, 0, 1, 0] },
      { points: [0, 0, 5, 0] },
    ])
    const g = buildTileGeometry(t)
    expect(g.instances).toBe(2)
    expect(g.roads).toBe(2)
    expect(g.skippedRoads).toBe(3)
    expect(g.skippedSegments).toBe(2)
    const v = view(g.data)
    for (let i = 0; i < g.instances * 6; i++)
      expect(Number.isFinite(v.getFloat32(i * 4, true))).toBe(true)
  })

  it('drops zero-length segments but keeps a road of one repeated point as a dot', () => {
    const g = buildTileGeometry(
      tileOf([{ points: [0, 0, 0, 0, 3, 4, 3, 4] }, { points: [7, 7, 7, 7] }]),
    )
    expect(g.instances).toBe(2)
    const v = view(g.data)
    expect(v.getFloat32(24 + OFFSET_P0, true)).toBe(7)
    expect(v.getFloat32(24 + OFFSET_P1, true)).toBe(7)
  })

  it('rejects an unknown road class', () => {
    const t = tileOf([{ points: [0, 0, 1, 1] }])
    ;(t.roads[0] as { roadClass: string }).roadClass = 'river'
    expect(buildTileGeometry(t).instances).toBe(0)
  })

  it('matches the straightforward M2 builder on synthetic tiles and malformed input (M3)', () => {
    const tiles: MapTile[] = []
    for (const id of ['city', 'crossings', 'rail', 'chords', 'thin'] as const) {
      const s = buildScenario(id)
      const tiler = new ScenarioTiles(s)
      tiles.push(
        ...tiler.visible('full', fitBounds(s.bounds, { width: 900, height: 900 })!, {
          width: 900,
          height: 900,
        }).tiles,
      )
    }
    tiles.push(
      tileOf([
        { points: [0, 0, NaN, 1, 2, 2, 3, 3] },
        { points: [5, 5, 5, 5, 5, 5] },
        { points: [1, 1, 1, 1, 4, 5] },
        { points: [0, 0, 1, 1], count: 9 },
        { points: [0, 0, 1, 1], first: -1 },
        { points: [0, 0], count: 1 },
        { roadClass: 'rail', flags: ROAD_FLAG_CHORD, points: [0, 0, 3, 4, 3, 4, 6, 8] },
      ]),
    )
    for (const t of tiles) {
      const a = buildTileGeometry(t)
      const b = referenceBuild(t)
      expect({ ...a, data: undefined }).toEqual({ ...b, data: undefined })
      const fa = new Float32Array(a.data)
      const fb = new Float32Array(b.data)
      const ua = new Uint8Array(a.data)
      const ub = new Uint8Array(b.data)
      // Counted in plain loops (one expect per instance would take seconds).
      let mismatches = 0
      for (let k = 0; k < a.instances; k++) {
        for (let f = 0; f < 4; f++) if (fa[k * 6 + f] !== fb[k * 6 + f]) mismatches++
        if (Math.abs(fa[k * 6 + 4]! - fb[k * 6 + 4]!) > Math.abs(fb[k * 6 + 4]!) * 1e-6)
          mismatches++
        if (ua[k * 24 + 20] !== ub[k * 24 + 20] || ua[k * 24 + 21] !== ub[k * 24 + 21]) mismatches++
      }
      expect(mismatches).toBe(0)
    }
  })
})

/** The M2 builder as first written (closure per segment, `hypot`), kept as the reference. */
function referenceBuild(tile: MapTile) {
  const pts = tile.points
  const pointPairs = Math.floor(pts.length / 2)
  const slot = (c: RoadClass, chord: boolean) => DRAW_ORDER.indexOf(c) * 2 + (chord ? 1 : 0)
  const each = (first: number, count: number, emit: (i: number, d: number) => void) => {
    let dist = 0
    let emitted = 0
    let skipped = 0
    let zero = -1
    for (let s = 0; s < count - 1; s++) {
      const i = (first + s) * 2
      const [x0, z0, x1, z1] = [pts[i]!, pts[i + 1]!, pts[i + 2]!, pts[i + 3]!]
      if (![x0, z0, x1, z1].every(Number.isFinite)) {
        skipped++
        continue
      }
      const len = Math.hypot(x1 - x0, z1 - z0)
      if (len === 0) {
        if (zero < 0) zero = i
        continue
      }
      emit(i, dist)
      dist += len
      emitted++
    }
    if (emitted === 0 && zero >= 0) {
      emit(zero, 0)
      emitted = 1
    }
    return { emitted, skipped }
  }
  const valid = (r: MapTile['roads'][number]) =>
    r.count >= 2 &&
    r.first >= 0 &&
    r.first + r.count <= pointPairs &&
    ROAD_CLASSES.includes(r.roadClass) &&
    Number.isInteger(r.first) &&
    Number.isInteger(r.count)
  const perSlot = new Array<number>(10).fill(0)
  const slots: number[] = []
  let skippedRoads = 0
  for (const r of tile.roads) {
    const emitted = valid(r) ? each(r.first, r.count, () => {}).emitted : 0
    if (emitted === 0) {
      skippedRoads++
      slots.push(-1)
      continue
    }
    const s = slot(r.roadClass, (r.flags & ROAD_FLAG_CHORD) !== 0)
    slots.push(s)
    perSlot[s]! += emitted
  }
  const offsets: number[] = []
  let total = 0
  for (const c of perSlot) {
    offsets.push(total)
    total += c
  }
  const groups = DRAW_ORDER.map((roadClass, k) => ({
    roadClass,
    first: offsets[k * 2]!,
    count: perSlot[k * 2]! + perSlot[k * 2 + 1]!,
    chords: perSlot[k * 2 + 1]!,
  }))
  const data = new ArrayBuffer(total * 24)
  const f32 = new Float32Array(data)
  const u8 = new Uint8Array(data)
  const cursor = offsets.slice()
  const b = [Infinity, Infinity, -Infinity, -Infinity]
  let skippedSegments = 0
  let roads = 0
  tile.roads.forEach((r, k) => {
    const s = slots[k]!
    if (s < 0) return
    roads++
    skippedSegments += each(r.first, r.count, (i, dist0) => {
      const m = cursor[s]!++
      for (let j = 0; j < 4; j++) f32[m * 6 + j] = pts[i + j]!
      f32[m * 6 + 4] = dist0
      u8[m * 24 + 20] = ROAD_CLASSES.indexOf(r.roadClass)
      u8[m * 24 + 21] = r.flags & 0xff
      b[0] = Math.min(b[0]!, pts[i]!, pts[i + 2]!)
      b[1] = Math.min(b[1]!, pts[i + 1]!, pts[i + 3]!)
      b[2] = Math.max(b[2]!, pts[i]!, pts[i + 2]!)
      b[3] = Math.max(b[3]!, pts[i + 1]!, pts[i + 3]!)
    }).skipped
  })
  return {
    data,
    instances: total,
    groups,
    roads,
    skippedRoads,
    skippedSegments,
    bounds: total > 0 ? (b as [number, number, number, number]) : null,
  }
}
