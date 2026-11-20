/**
 * DEVELOPMENT ONLY (M2 render lab): reproducible synthetic road networks and their tiles.
 * Generated from simple formulas and a seeded random generator; no game data, nothing derived
 * from map packages. Tiles are complete `MapTile` objects built like the backend lists roads:
 * a road appears, with all its points, in every tile its segments touch.
 */
import type { MapTile, RoadClass, TileRoad } from '@/domain/mapTile'
import { ROAD_FLAG_CHORD, ROAD_FLAG_ESTIMATED } from '@/domain/mapTile'
import {
  chooseLevel,
  tilesFor,
  visibleBounds,
  type Bounds,
  type Size,
  type TileId,
  type Viewport,
} from '@/domain/mapViewport'
import { BOUNDS, generate, LEVEL_CLASSES, TILE_SIZES } from './syntheticMap'

export const SEED = 0x2c45

export type ScenarioId =
  | 'small'
  | 'city'
  | 'motorway'
  | 'crossings'
  | 'parallel'
  | 'rail'
  | 'chords'
  | 'tileBorders'
  | 'large'
  | 'stress'

export const SCENARIOS: readonly {
  id: ScenarioId
  label: string
  /** Scenarios with a segment count chosen by the user. */
  defaultSegments?: number
}[] = [
  { id: 'small', label: 'Small map, few roads' },
  { id: 'city', label: 'City network' },
  { id: 'motorway', label: 'Motorway network' },
  { id: 'crossings', label: 'Crossings' },
  { id: 'parallel', label: 'Parallel and overlapping roads' },
  { id: 'rail', label: 'Rail' },
  { id: 'chords', label: 'Chords' },
  { id: 'tileBorders', label: 'Roads across tile borders' },
  { id: 'large', label: 'Large map', defaultSegments: 100_000 },
  { id: 'stress', label: 'Stress test', defaultSegments: 1_000_000 },
]

export interface ScenarioRoad {
  roadClass: RoadClass
  flags: number
  /** World x, z pairs. */
  points: Float64Array
}

export interface Scenario {
  id: ScenarioId
  contentId: string
  bounds: Bounds
  tileSizes: number[]
  roads: ScenarioRoad[]
  segments: number
}

/** mulberry32: small, fast, reproducible. */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function hash32(s: string, seed: number): number {
  let h = (0x811c9dc5 ^ seed) >>> 0
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193) >>> 0
  return h
}

/** A 16-hex-digit content id from the scenario parameters (never a real package id). */
export function contentIdOf(id: string, segments: number): string {
  const key = `${id}:${segments}:${SEED}`
  return hash32(key, 1).toString(16).padStart(8, '0') + hash32(key, 2).toString(16).padStart(8, '0')
}

type Pt = [number, number]

class Builder {
  readonly roads: ScenarioRoad[] = []
  segments = 0
  add(roadClass: RoadClass, pts: readonly Pt[], flags = ROAD_FLAG_ESTIMATED): void {
    if (pts.length < 2) return
    const points = new Float64Array(pts.length * 2)
    pts.forEach(([x, z], i) => {
      points[i * 2] = x
      points[i * 2 + 1] = z
    })
    this.roads.push({ roadClass, flags, points })
    this.segments += pts.length - 1
  }
  chord(roadClass: RoadClass, a: Pt, b: Pt): void {
    this.add(roadClass, [a, b], ROAD_FLAG_CHORD)
  }
}

/** Points from `a` to `b` every `step` units (both ends included). */
function sampled(a: Pt, b: Pt, step: number, wobble: (t: number) => number = () => 0): Pt[] {
  const len = Math.hypot(b[0] - a[0], b[1] - a[1])
  const n = Math.max(1, Math.round(len / step))
  const nx = -(b[1] - a[1]) / (len || 1)
  const nz = (b[0] - a[0]) / (len || 1)
  const pts: Pt[] = []
  for (let i = 0; i <= n; i++) {
    const t = i / n
    const w = wobble(t)
    pts.push([a[0] + (b[0] - a[0]) * t + nx * w, a[1] + (b[1] - a[1]) * t + nz * w])
  }
  return pts
}

function arc(cx: number, cz: number, r: number, a0: number, a1: number, step: number): Pt[] {
  const n = Math.max(2, Math.ceil((Math.abs(a1 - a0) * r) / step))
  const pts: Pt[] = []
  for (let i = 0; i <= n; i++) {
    const a = a0 + ((a1 - a0) * i) / n
    pts.push([cx + Math.cos(a) * r, cz + Math.sin(a) * r])
  }
  return pts
}

function small(b: Builder): void {
  for (const r of generate()) {
    b.add(
      r.roadClass,
      r.points.map(([x, z]) => [x, z]),
    )
  }
}

function town(b: Builder, rnd: () => number, cx: number, cz: number, n: number, gap: number): void {
  const angle = rnd() * Math.PI
  const [c, s] = [Math.cos(angle), Math.sin(angle)]
  const rot = ([x, z]: Pt): Pt => [cx + x * c - z * s, cz + x * s + z * c]
  const half = (n * gap) / 2
  for (let i = 0; i <= n; i++) {
    const o = -half + i * gap
    const j = () => (rnd() - 0.5) * gap * 0.15
    b.add('local', sampled([-half, o + j()], [half, o + j()], gap / 2).map(rot))
    b.add('local', sampled([o + j(), -half], [o + j(), half], gap / 2).map(rot))
  }
  for (let i = 0; i < n; i++) {
    const x = -half + rnd() * 2 * half
    const z = -half + rnd() * 2 * half
    b.add(
      'minor',
      sampled([x, z], [x + (rnd() - 0.5) * gap * 3, z + (rnd() - 0.5) * gap * 3], gap / 4).map(rot),
    )
  }
}

function city(b: Builder): void {
  const rnd = seededRandom(SEED + 1)
  const centres: Pt[] = [
    [-7000, -4000],
    [6000, -5000],
    [-6000, 5000],
    [7000, 4500],
    [0, 0],
    [-1000, -7000],
  ]
  for (const [cx, cz] of centres) town(b, rnd, cx, cz, 14 + Math.floor(rnd() * 10), 110)
  // Avenues between the towns and a ring road.
  for (let i = 0; i < centres.length; i++)
    for (let j = i + 1; j < centres.length; j++)
      if (rnd() < 0.5)
        b.add(
          'primary',
          sampled(centres[i]!, centres[j]!, 120, (t) => Math.sin(t * Math.PI) * 600),
        )
  b.add('primary', arc(0, 0, 9500, 0, Math.PI * 2, 150))
}

function motorway(b: Builder): void {
  const rnd = seededRandom(SEED + 2)
  const nodes: Pt[] = []
  for (let i = 0; i < 14; i++) nodes.push([(rnd() - 0.5) * 70000, (rnd() - 0.5) * 50000])
  const dist = (a: Pt, c: Pt) => Math.hypot(a[0] - c[0], a[1] - c[1])
  const done = new Set<string>()
  nodes.forEach((a, i) => {
    const near = nodes
      .map((c, j) => ({ j, d: dist(a, c) }))
      .filter((x) => x.j !== i)
      .sort((x, y) => x.d - y.d)
      .slice(0, 3)
    for (const { j } of near) {
      const key = [i, j].sort().join('-')
      if (done.has(key)) continue
      done.add(key)
      const bend = (rnd() - 0.5) * 6000
      b.add(
        'motorway',
        sampled(a, nodes[j]!, 250, (t) => Math.sin(t * Math.PI) * bend),
      )
    }
    // Interchange loops and feeders.
    for (let q = 0; q < 4; q++) {
      const a0 = (q * Math.PI) / 2
      b.add('primary', arc(a[0] + Math.cos(a0) * 220, a[1] + Math.sin(a0) * 220, 160, 0, 5, 30))
    }
    b.add(
      'primary',
      sampled(a, [a[0] + 4000, a[1] + 3000], 150, (t) => Math.sin(t * 6) * 200),
    )
  })
}

function crossings(b: Builder): void {
  // Same class at right angles and at 30 degrees.
  b.add('local', sampled([200, 500], [1800, 500], 100))
  b.add('local', sampled([1000, 100], [1000, 900], 100))
  b.add('local', sampled([200, 1300], [1800, 1300], 100))
  b.add('local', sampled([300, 1700], [1700, 900], 100))
  // Different classes.
  b.add('motorway', sampled([2200, 500], [3800, 500], 100))
  b.add('local', sampled([3000, 100], [3000, 900], 100))
  b.add('rail', sampled([2200, 100], [3800, 900], 100))
  // A star junction and a T junction.
  for (let k = 0; k < 6; k++) {
    const a = (k * Math.PI) / 3
    b.add(
      'primary',
      sampled([1000, 2500], [1000 + Math.cos(a) * 700, 2500 + Math.sin(a) * 700], 80),
    )
  }
  b.add('local', sampled([2200, 2500], [3800, 2500], 100))
  b.add('local', sampled([3000, 2500], [3000, 3300], 100))
  // Chords crossing chords and solids of the same class (alpha 0.6 must not darken).
  b.chord('local', [200, 3200], [1800, 3800])
  b.chord('local', [200, 3800], [1800, 3200])
  b.add('local', sampled([1000, 3000], [1000, 4000], 100))
  // Sharp zig-zag: many joins.
  const zig: Pt[] = []
  for (let i = 0; i <= 16; i++) zig.push([2200 + i * 100, i % 2 ? 3300 : 3700])
  b.add('primary', zig)
  // A crossing exactly on a tile corner (level 0 tiles are 1024 units).
  b.add('local', sampled([1648, 1648], [2448, 2448], 100))
  b.add('local', sampled([1648, 2448], [2448, 1648], 100))
}

function parallel(b: Builder): void {
  const classes: RoadClass[] = ['motorway', 'primary', 'local', 'minor', 'rail']
  classes.forEach((c, ci) => {
    let z = 200 + ci * 700
    for (const gap of [1, 2, 4, 8, 16, 32]) {
      b.add(
        c,
        sampled([200, z], [3800, z], 200, (t) => Math.sin(t * 9) * 40),
      )
      b.add(
        c,
        sampled([200, z + gap], [3800, z + gap], 200, (t) => Math.sin(t * 9) * 40),
      )
      z += gap + 60
    }
  })
  // Identical duplicates (different road index) and collinear overlaps.
  b.add('local', sampled([200, 3800], [3800, 3800], 150))
  b.add('local', sampled([200, 3800], [3800, 3800], 150))
  b.add('primary', sampled([200, 3950], [2600, 3950], 150))
  b.add('primary', sampled([1400, 3950], [3800, 3950], 150))
  b.chord('minor', [200, 4100], [3800, 4100])
  b.chord('minor', [1000, 4100], [3000, 4100])
  b.chord('minor', [200, 4106], [3800, 4106])
}

function rail(b: Builder): void {
  b.add('rail', sampled([100, 300], [3900, 300], 50))
  b.add('rail', arc(2000, 2000, 1500, 0, Math.PI * 1.5, 20))
  b.add(
    'rail',
    sampled([100, 3700], [3900, 3200], 30, (t) => Math.sin(t * 20) * 120),
  )
  b.add('rail', sampled([100, 1000], [3900, 3000], 60))
  b.add('rail', sampled([100, 3000], [3900, 1000], 60))
  b.add('local', sampled([2000, 100], [2000, 3900], 100))
  // Parallel tracks.
  for (let i = 0; i < 4; i++) b.add('rail', sampled([500, 600 + i * 6], [3500, 600 + i * 6], 80))
}

function chords(b: Builder): void {
  const classes: RoadClass[] = ['motorway', 'primary', 'local', 'minor', 'rail']
  // A fan of chords crossing each other, per class.
  classes.forEach((c, ci) => {
    const x = 400 + ci * 800
    for (let k = 0; k < 7; k++) b.chord(c, [x - 300, 300 + k * 100], [x + 300, 900 - k * 100])
  })
  // A star of chords meeting in one point, overlapping near it.
  for (let k = 0; k < 12; k++) {
    const a = (k * Math.PI) / 6
    b.chord('primary', [2000, 2500], [2000 + Math.cos(a) * 900, 2500 + Math.sin(a) * 900])
  }
  // Long chords spanning several tiles: listed (and uploaded) in each tile.
  b.chord('local', [100, 1500], [4000, 1600])
  b.chord('motorway', [100, 4000], [4000, 3400])
  b.chord('minor', [3500, 100], [3600, 4000])
}

function tileBorders(b: Builder): void {
  // Exactly on tile border lines (level 0 tiles: 1024 units).
  b.add('local', sampled([1024, 100], [1024, 4000], 100))
  b.add('primary', sampled([100, 2048], [4000, 2048], 100))
  // Diagonal through tile corners.
  b.add('motorway', sampled([0, 0], [4096, 4096], 128))
  // Zig-zag across a border many times.
  const zig: Pt[] = []
  for (let i = 0; i <= 40; i++) zig.push([3072 + (i % 2 ? 60 : -60), 100 + i * 95])
  b.add('local', zig)
  // A road spanning many tiles; a circle around a tile corner; a long chord; a rail.
  b.add(
    'primary',
    sampled([-4000, 3500], [8000, 3600], 200, (t) => Math.sin(t * 12) * 150),
  )
  b.add('local', arc(2048, 1024, 300, 0, Math.PI * 2, 30))
  b.chord('local', [200, 600], [3900, 1700])
  b.add('rail', sampled([100, 3000], [4000, 2700], 50))
}

/** A mixed network of exactly `target` segments. */
function mixed(b: Builder, target: number, seed: number, width: number, height: number): void {
  const rnd = seededRandom(seed)
  const quota = (f: number) => Math.round(target * f)
  const left = {
    motorway: quota(0.08),
    primary: quota(0.12),
    rail: quota(0.07),
    chord: quota(0.05),
  }
  const minorQ = quota(0.18)
  const localQ = target - left.motorway - left.primary - left.rail - left.chord - minorQ
  const inside = (x: number, z: number) =>
    x > -width / 2 && x < width / 2 && z > -height / 2 && z < height / 2
  /** A random point at least `margin` units inside the map. */
  const randomPt = (margin = 0): Pt => [
    (rnd() - 0.5) * Math.max(0, width * 0.95 - 2 * margin),
    (rnd() - 0.5) * Math.max(0, height * 0.95 - 2 * margin),
  ]
  const clampPt = ([x, z]: Pt): Pt => [
    Math.min(width / 2, Math.max(-width / 2, x)),
    Math.min(height / 2, Math.max(-height / 2, z)),
  ]

  const walk = (c: RoadClass, budget: number, step: number, maxSeg: number, turn: number) => {
    while (budget > 0) {
      let [x, z] = randomPt()
      let h = rnd() * Math.PI * 2
      const n = Math.min(budget, 20 + Math.floor(rnd() * maxSeg))
      const pts: Pt[] = [[x, z]]
      for (let i = 0; i < n; i++) {
        h += (rnd() - 0.5) * turn
        let nx = x + Math.cos(h) * step
        let nz = z + Math.sin(h) * step
        if (!inside(nx, nz)) {
          h += Math.PI
          nx = x + Math.cos(h) * step
          nz = z + Math.sin(h) * step
        }
        x = nx
        z = nz
        pts.push([x, z])
      }
      b.add(c, pts)
      budget -= n
    }
  }
  walk('motorway', left.motorway, 300, 180, 0.15)
  walk('primary', left.primary, 150, 120, 0.3)
  walk('rail', left.rail, 200, 120, 0.1)

  let chordsLeft = left.chord
  while (chordsLeft > 0) {
    const [x, z] = randomPt()
    const a = rnd() * Math.PI * 2
    const len = 200 + rnd() * 1800
    const end = clampPt([x + Math.cos(a) * len, z + Math.sin(a) * len])
    b.chord(rnd() < 0.5 ? 'local' : 'minor', [x, z], end)
    chordsLeft--
  }

  // Towns until the local quota is used; minor roads around them.
  let localLeft = localQ
  let minorLeft = minorQ
  while (localLeft > 0) {
    const n = 6 + Math.floor(rnd() * 10)
    const gap = 80 + rnd() * 60
    // Towns and their minor roads stay inside the map: a reach of 1.5 town radii + 16 × 40.
    const [cx, cz] = randomPt(((n * gap) / 2) * 1.5 * Math.SQRT2 + 700)
    const angle = rnd() * Math.PI
    const [c, s] = [Math.cos(angle), Math.sin(angle)]
    const rot = ([x, z]: Pt): Pt => [cx + x * c - z * s, cz + x * s + z * c]
    const half = (n * gap) / 2
    for (let i = 0; i <= n && localLeft > 0; i++) {
      for (const vertical of [false, true]) {
        if (localLeft <= 0) break
        const o = -half + i * gap
        let pts = vertical
          ? sampled([o, -half], [o, half], gap / 2)
          : sampled([-half, o], [half, o], gap / 2)
        if (pts.length - 1 > localLeft) pts = pts.slice(0, localLeft + 1)
        b.add('local', pts.map(rot))
        localLeft -= pts.length - 1
      }
    }
    for (let i = 0; i < n && minorLeft > 0; i++) {
      const x = -half * 1.5 + rnd() * 3 * half
      const z = -half * 1.5 + rnd() * 3 * half
      const segs = Math.min(minorLeft, 4 + Math.floor(rnd() * 12))
      const pts: Pt[] = [[x, z]]
      let h = rnd() * Math.PI * 2
      for (let k = 0; k < segs; k++) {
        h += (rnd() - 0.5) * 0.8
        const [px, pz] = pts[pts.length - 1]!
        pts.push([px + Math.cos(h) * 40, pz + Math.sin(h) * 40])
      }
      b.add('minor', pts.map(rot))
      minorLeft -= segs
    }
  }
  // Minor roads left over (few towns): wiggly roads anywhere.
  if (minorLeft > 0) walk('minor', minorLeft, 40, 16, 0.8)
}

const pow2 = (v: number) => 2 ** Math.round(Math.log2(Math.max(v, 256)))

export function buildScenario(id: ScenarioId, requestedSegments?: number): Scenario {
  const b = new Builder()
  let bounds: Bounds = [0, 0, 4096, 4300]
  let tileSizes = TILE_SIZES.slice()
  const def = SCENARIOS.find((s) => s.id === id)!
  const target = Math.max(10, Math.round(requestedSegments ?? def.defaultSegments ?? 0))
  switch (id) {
    case 'small':
      small(b)
      bounds = BOUNDS
      break
    case 'city':
      city(b)
      bounds = [-10000, -9000, 10000, 9000]
      break
    case 'motorway':
      motorway(b)
      bounds = [-40000, -30000, 40000, 30000]
      break
    case 'crossings':
      crossings(b)
      break
    case 'parallel':
      parallel(b)
      break
    case 'rail':
      rail(b)
      break
    case 'chords':
      chords(b)
      break
    case 'tileBorders':
      tileBorders(b)
      bounds = [-4000, 0, 8000, 4096]
      break
    case 'large':
    case 'stress': {
      const width = Math.round(Math.sqrt(target) * 160)
      const height = Math.round(width * 0.75)
      mixed(b, target, SEED + (id === 'large' ? 10 : 11), width, height)
      bounds = [-width / 2, -height / 2, width / 2, height / 2]
      const t0 = pow2(width / 10)
      tileSizes = [t0, t0 * 4, t0 * 16, t0 * 64]
      break
    }
  }
  const segments = b.segments
  return {
    id,
    contentId: contentIdOf(id, def.defaultSegments !== undefined ? target : segments),
    bounds,
    tileSizes,
    roads: b.roads,
    segments,
  }
}

export type LodMode = 'auto' | 'full'

/** Tiles of a scenario, built on first use and kept. */
export class ScenarioTiles {
  private readonly index = new Map<number, Map<number, number[]>>()
  private readonly built = new Map<string, MapTile>()

  constructor(readonly scenario: Scenario) {}

  private cellKey(x: number, z: number): number {
    return (x + 32768) * 65536 + (z + 32768)
  }

  private levelIndex(level: number): Map<number, number[]> {
    let cells = this.index.get(level)
    if (cells) return cells
    cells = new Map()
    const size = this.scenario.tileSizes[level]!
    const classes = LEVEL_CLASSES[level] ?? []
    const last = new Map<number, number>()
    this.scenario.roads.forEach((road, r) => {
      if (!classes.includes(road.roadClass)) return
      const p = road.points
      for (let i = 0; i + 3 < p.length; i += 2) {
        const x0 = Math.floor(Math.min(p[i]!, p[i + 2]!) / size)
        const x1 = Math.floor(Math.max(p[i]!, p[i + 2]!) / size)
        const z0 = Math.floor(Math.min(p[i + 1]!, p[i + 3]!) / size)
        const z1 = Math.floor(Math.max(p[i + 1]!, p[i + 3]!) / size)
        for (let x = x0; x <= x1; x++)
          for (let z = z0; z <= z1; z++) {
            const k = this.cellKey(x, z)
            if (last.get(k) === r) continue
            last.set(k, r)
            let list = cells!.get(k)
            if (!list) cells!.set(k, (list = []))
            list.push(r)
          }
      }
    })
    this.index.set(level, cells)
    return cells
  }

  tile(level: number, x: number, z: number): MapTile {
    const key = `${level}/${x}/${z}`
    const cached = this.built.get(key)
    if (cached) return cached
    const size = this.scenario.tileSizes[level]!
    const ids = this.levelIndex(level).get(this.cellKey(x, z)) ?? []
    const ox = x * size
    const oz = z * size
    let pointCount = 0
    for (const r of ids) pointCount += this.scenario.roads[r]!.points.length / 2
    const points = new Float32Array(pointCount * 2)
    const roads: TileRoad[] = []
    let first = 0
    for (const r of ids) {
      const road = this.scenario.roads[r]!
      const n = road.points.length / 2
      for (let i = 0; i < n; i++) {
        points[(first + i) * 2] = road.points[i * 2]! - ox
        points[(first + i) * 2 + 1] = road.points[i * 2 + 1]! - oz
      }
      roads.push({ index: r, first, count: n, roadClass: road.roadClass, flags: road.flags })
      first += n
    }
    const tile: MapTile = {
      level,
      x,
      z,
      tileSize: size,
      originX: ox,
      originZ: oz,
      truncated: false,
      contentId: this.scenario.contentId,
      roads,
      points,
      byteLength: 56 + roads.length * 12 + pointCount * 8,
    }
    this.built.set(key, tile)
    return tile
  }

  /**
   * The tiles to draw. `auto` chooses the level like the dashboard (at most 64 tiles, coarser
   * levels show fewer classes); `full` always draws level 0, every tile in view, all classes.
   */
  visible(mode: LodMode, vp: Viewport, size: Size): { level: number; tiles: MapTile[] } {
    const { bounds, tileSizes } = this.scenario
    let level: number
    let ids: TileId[]
    if (mode === 'auto') ({ level, tiles: ids } = chooseLevel(vp, size, tileSizes, bounds))
    else {
      level = 0
      const t = tileSizes[0]!
      const [minX, minZ, maxX, maxZ] = visibleBounds(vp, size)
      const clipped: Bounds = [
        Math.max(minX, bounds[0]),
        Math.max(minZ, bounds[1]),
        Math.min(maxX, bounds[2]),
        Math.min(maxZ, bounds[3]),
      ]
      ids = clipped[0] > clipped[2] || clipped[1] > clipped[3] ? [] : tilesFor(clipped, t, 0)
    }
    const tiles = ids.map((id) => this.tile(level, id.x, id.z)).filter((t) => t.roads.length > 0)
    return { level, tiles }
  }
}
