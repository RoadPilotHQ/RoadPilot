/**
 * DEVELOPMENT ONLY: a synthetic road map for checking the map view in a plain browser (for
 * example headless screenshots), where no Tauri backend can read packages. It is loaded only
 * by the Vite dev server with `?syntheticMap` (see `src/app/main.tsx`), is not part of the
 * production build, and the dashboard labels it "Synthetic test map". It contains no game data:
 * the network is generated from simple formulas.
 */
import type { MapSnapshot, MapSource, TileResult } from '@/backend/mapSource'
import type { MapStatus } from '@/domain/map'
import { decodeTile, ROAD_CLASSES, type RoadClass } from '@/domain/mapTile'
import type { GameId } from '@/domain/types'

const CONTENT_ID = '5e17e7105e17e710'
export const TILE_SIZES = [1024, 4096, 16384, 65536]
export const BOUNDS: [number, number, number, number] = [-20000, -15000, 20000, 15000]
export const LEVEL_CLASSES: readonly RoadClass[][] = [
  ['motorway', 'primary', 'local', 'minor', 'rail'],
  ['motorway', 'primary', 'local'],
  ['motorway', 'primary'],
  ['motorway'],
]

export interface Road {
  index: number
  roadClass: RoadClass
  points: [number, number][]
  box: [number, number, number, number]
}

/** The generated network (also the small scenario of the render lab, `syntheticScenarios.ts`). */
export function generate(): Road[] {
  const roads: Road[] = []
  const add = (roadClass: RoadClass, points: [number, number][]) => {
    const xs = points.map((p) => p[0])
    const zs = points.map((p) => p[1])
    roads.push({
      index: roads.length,
      roadClass,
      points,
      box: [Math.min(...xs), Math.min(...zs), Math.max(...xs), Math.max(...zs)],
    })
  }
  // A motorway ring and two crossing motorways.
  const ring: [number, number][] = []
  for (let a = 0; a <= 360; a += 5) {
    const r = (a * Math.PI) / 180
    ring.push([Math.cos(r) * 14000, Math.sin(r) * 10000])
  }
  add('motorway', ring)
  add('motorway', [
    [-20000, -2000],
    [-6000, -500],
    [6000, 500],
    [20000, 2500],
  ])
  add('motorway', [
    [3000, -15000],
    [1500, -4000],
    [-1000, 6000],
    [-2500, 15000],
  ])
  // Curved major roads.
  for (let k = -2; k <= 2; k++) {
    const pts: [number, number][] = []
    for (let x = -18000; x <= 18000; x += 600)
      pts.push([x, k * 5000 + Math.sin(x / 3000 + k) * 1200])
    add('primary', pts)
  }
  // Town grids around four centres.
  for (const [cx, cz] of [
    [-9000, -5000],
    [8000, -6000],
    [-7000, 6000],
    [9000, 5500],
  ]) {
    for (let i = -6; i <= 6; i++) {
      add('local', [
        [cx! - 1800, cz! + i * 300],
        [cx! + 1800, cz! + i * 300 + 40],
      ])
      add('local', [
        [cx! + i * 300, cz! - 1800],
        [cx! + i * 300 + 40, cz! + 1800],
      ])
    }
    add('minor', [
      [cx! - 2400, cz! - 2400],
      [cx! - 1900, cz! - 2100],
      [cx! - 1700, cz! - 1700],
    ])
  }
  add('rail', [
    [-20000, 9000],
    [-5000, 7500],
    [5000, 8000],
    [20000, 6000],
  ])
  return roads
}

function encode(roads: Road[], level: number, x: number, z: number): ArrayBuffer {
  const size = TILE_SIZES[level]!
  const [ox, oz] = [x * size, z * size]
  const inTile = roads.filter(
    (r) =>
      LEVEL_CLASSES[level]!.includes(r.roadClass) &&
      r.box[0] <= ox + size &&
      r.box[2] >= ox &&
      r.box[1] <= oz + size &&
      r.box[3] >= oz,
  )
  const points = inTile.reduce((n, r) => n + r.points.length, 0)
  const buffer = new ArrayBuffer(56 + inTile.length * 12 + points * 8)
  const v = new DataView(buffer)
  'RPMT'.split('').forEach((c, i) => v.setUint8(i, c.charCodeAt(0)))
  v.setUint16(4, 1, true)
  v.setUint8(6, level)
  v.setInt32(8, x, true)
  v.setInt32(12, z, true)
  v.setFloat32(16, size, true)
  v.setFloat64(24, ox, true)
  v.setFloat64(32, oz, true)
  v.setUint32(40, inTile.length, true)
  v.setUint32(44, points, true)
  v.setBigUint64(48, BigInt(`0x${CONTENT_ID}`), true)
  let first = 0
  let p = 56 + inTile.length * 12
  inTile.forEach((r, i) => {
    const o = 56 + i * 12
    v.setUint32(o, r.index, true)
    v.setUint32(o + 4, first, true)
    v.setUint16(o + 8, r.points.length, true)
    v.setUint8(o + 10, ROAD_CLASSES.indexOf(r.roadClass))
    v.setUint8(o + 11, 1)
    first += r.points.length
    for (const [px, pz] of r.points) {
      v.setFloat32(p, px - ox, true)
      v.setFloat32(p + 4, pz - oz, true)
      p += 8
    }
  })
  return buffer
}

export function createSyntheticMapSource(): MapSource {
  const roads = generate()
  let revision = 0
  const status = (game: GameId | null): MapStatus => ({
    state: 'ready',
    game,
    packageGame: game,
    phase: null,
    contentId: CONTENT_ID,
    schema: '1.0',
    counts: { nodes: roads.length * 2, roads: roads.length, junctions: 0 },
    bounds: BOUNDS,
    error: null,
    loadMs: 0,
    tileSizes: TILE_SIZES,
    skippedRoads: 0,
    revision: ++revision,
  })
  let snapshot: MapSnapshot = { available: true, synthetic: true, status: status('ets2') }
  const listeners = new Set<() => void>()
  return {
    getSnapshot: () => snapshot,
    subscribe(l) {
      listeners.add(l)
      return () => listeners.delete(l)
    },
    async select(game) {
      snapshot = { ...snapshot, status: status(game) }
      listeners.forEach((l) => l())
    },
    async fetchTile(_game, request): Promise<TileResult> {
      const tile = decodeTile(encode(roads, request.level, request.x, request.z), request)
      return tile ? { tile } : { failure: 'malformed' }
    },
    dispose() {},
  }
}
