/**
 * DEVELOPMENT ONLY (Phase 2.4D B1, MapLibre lab): reproducible synthetic road networks at
 * SCS-like coordinate magnitudes (around X ≈ −100,000, Z ≈ −70,000).
 *
 * Generated from simple formulas and a seeded random generator (mulberry32, `LAB_SEED`). No game
 * data, nothing extracted from SCS files or map packages, nothing derived from real places;
 * names are made up from syllables. Coordinates are native world units (X east, Z south).
 *
 * Scenarios: A `basic`, B `urban` (exactly 100,000 segments by default), C `stress` (exactly
 * 1,000,000 by default), D `thin` (roads with explicit 0.5–3 px widths).
 */
import { ROAD_FLAG_ESTIMATED, type RoadClass } from '@/domain/mapTile'
import { contentIdOf, seededRandom, type Scenario } from '../syntheticScenarios'
import { toCarrier, WORLD_ORIGIN } from './coordinates'

export const LAB_SEED = 0xb1a5

export const LAB_CLASSES = ['motorway', 'primary', 'secondary', 'local', 'minor'] as const
export type LabRoadClass = (typeof LAB_CLASSES)[number]

export type LabScenarioId = 'basic' | 'urban' | 'stress' | 'thin'

export const LAB_SCENARIOS: readonly {
  id: LabScenarioId
  label: string
  defaultSegments?: number
}[] = [
  { id: 'basic', label: 'A – Basic' },
  { id: 'urban', label: 'B – Dense urban', defaultSegments: 100_000 },
  { id: 'stress', label: 'C – Stress', defaultSegments: 1_000_000 },
  { id: 'thin', label: 'D – Thin roads' },
]

export interface LabRoad {
  cls: LabRoadClass
  /** Native x, z pairs. */
  points: Float64Array
  name?: string
  /** Scenario D only: the intended visual width in CSS pixels. */
  width?: number
}

export interface LabCity {
  name: string
  x: number
  z: number
  /** 1 = largest; smaller ranks are shown from lower zoom levels. */
  rank: 1 | 2 | 3
}

/** A known native position, drawn as a small dot in accuracy mode. */
export interface LabProbe {
  id: string
  x: number
  z: number
}

export interface LabDataset {
  id: LabScenarioId
  seed: number
  /** Native bounds of all road points: minX, minZ, maxX, maxZ. */
  bounds: [number, number, number, number]
  roads: LabRoad[]
  cities: LabCity[]
  probes: LabProbe[]
  segments: number
  /** FNV-1a over classes, widths and the bit patterns of every coordinate. */
  hash: string
}

type Pt = [number, number]

/** Minimal GeoJSON shapes (RFC 7946) used by the lab; avoids a dependency on `@types/geojson`. */
export interface LineString {
  type: 'LineString'
  coordinates: number[][]
}
export interface Point {
  type: 'Point'
  coordinates: number[]
}
export interface Feature<G, P> {
  type: 'Feature'
  id: number
  geometry: G
  properties: P
}
export interface FeatureCollection<G, P> {
  type: 'FeatureCollection'
  features: Feature<G, P>[]
}

/** Probe positions: origin, both signs on both axes, and the SCS-like magnitudes. */
export const PROBES: readonly LabProbe[] = [
  { id: 'origin', x: 0, z: 0 },
  { id: 'scs', x: -100_000, z: -70_000 },
  { id: 'scs-near', x: -100_000 + 37.25, z: -70_000 - 12.5 },
  { id: 'pos-pos', x: 100_000, z: 70_000 },
  { id: 'neg-pos', x: -120_000, z: 60_000 },
  { id: 'pos-neg', x: 120_000, z: -60_000 },
  { id: 'east', x: 50_000, z: 0 },
  { id: 'south', x: 0, z: 50_000 },
]

class Builder {
  readonly roads: LabRoad[] = []
  segments = 0
  constructor(private readonly limit = Infinity) {}

  get left(): number {
    return this.limit - this.segments
  }

  /**
   * Adds a road, truncated to the remaining segment budget. Returns the segments added.
   * B1.2 (F6): consecutive identical points are dropped first, so no zero-length segment is ever
   * stored or counted; the scenarios' exact totals are reached by the budget, not by such segments.
   */
  add(cls: LabRoadClass, pts: readonly Pt[], name?: string, width?: number): number {
    let p = pts.filter((q, i) => i === 0 || q[0] !== pts[i - 1]![0] || q[1] !== pts[i - 1]![1])
    if (p.length - 1 > this.left) p = p.slice(0, Math.max(0, this.left) + 1)
    if (p.length < 2) return 0
    const points = new Float64Array(p.length * 2)
    p.forEach(([x, z], i) => {
      points[i * 2] = x
      points[i * 2 + 1] = z
    })
    const road: LabRoad = { cls, points }
    if (name !== undefined) road.name = name
    if (width !== undefined) road.width = width
    this.roads.push(road)
    this.segments += p.length - 1
    return p.length - 1
  }
}

/** Points from a to b, at most `step` apart (both ends included). */
function sampled(a: Pt, b: Pt, step: number): Pt[] {
  const n = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / step))
  const pts: Pt[] = []
  for (let i = 0; i <= n; i++)
    pts.push([a[0] + ((b[0] - a[0]) * i) / n, a[1] + ((b[1] - a[1]) * i) / n])
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

/** The polyline moved sideways by `d` (left of the direction of travel). */
function offsetLine(pts: readonly Pt[], d: number): Pt[] {
  return pts.map((p, i) => {
    const a = pts[Math.max(0, i - 1)]!
    const b = pts[Math.min(pts.length - 1, i + 1)]!
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1
    return [p[0] - ((b[1] - a[1]) / len) * d, p[1] + ((b[0] - a[0]) / len) * d]
  })
}

const SYLLABLES = ['ka', 'lo', 'ver', 'mi', 'dan', 'sor', 'te', 'bru', 'nel', 'ost', 'ra', 'quin']
const STREET_WORDS = ['Mill', 'Cedar', 'Harbor', 'Quarry', 'Ridge', 'Market', 'Station', 'Meadow']

function nameMaker(rnd: () => number) {
  const city = () => {
    const n = 2 + Math.floor(rnd() * 2)
    let s = ''
    for (let i = 0; i < n; i++) s += SYLLABLES[Math.floor(rnd() * SYLLABLES.length)]
    return s[0]!.toUpperCase() + s.slice(1)
  }
  const street = (suffix: string) =>
    `${STREET_WORDS[Math.floor(rnd() * STREET_WORDS.length)]} ${suffix}`
  return { city, street }
}

// ---------------------------------------------------------------- scenario A

function basic(b: Builder, rnd: () => number, cities: LabCity[]): void {
  const names = nameMaker(rnd)
  const hubs: { x: number; z: number; rank: 1 | 2 | 3 }[] = [
    { x: -100_000, z: -70_000, rank: 1 },
    { x: 0, z: 0, rank: 1 },
    { x: 60_000, z: 40_000, rank: 2 },
    { x: -60_000, z: 30_000, rank: 2 },
    { x: 40_000, z: -50_000, rank: 2 },
  ]
  // Straight motorways between hubs, one curved motorway, a ring around the SCS-like hub.
  b.add('motorway', sampled([-100_000, -70_000], [0, 0], 500), 'M 1')
  b.add('motorway', arc(30_000, 0, 50_000, Math.PI, Math.PI * 1.75, 500).reverse(), 'M 2')
  b.add('motorway', sampled([0, 0], [60_000, 40_000], 500), 'M 3')
  b.add('motorway', arc(-100_000, -70_000, 6_000, 0, Math.PI * 2, 300), 'M 10 Ring')
  // Primary roads: straight crossings through every hub and a sine curve.
  for (const [i, h] of hubs.entries()) {
    b.add('primary', sampled([h.x - 15_000, h.z], [h.x + 15_000, h.z], 250), `Route ${10 + i}`)
    b.add('primary', sampled([h.x, h.z - 15_000], [h.x, h.z + 15_000], 250), `Route ${20 + i}`)
  }
  const sine: Pt[] = []
  for (let x = -60_000; x <= 40_000; x += 400) sine.push([x, -50_000 + Math.sin(x / 9000) * 8000])
  b.add('primary', sine, 'Route 30')
  // Secondary radials, local grids and minor wiggles at every hub.
  for (const h of hubs) {
    for (let k = 0; k < 6; k++) {
      const a = (k / 6) * Math.PI * 2 + 0.3
      b.add(
        'secondary',
        sampled([h.x, h.z], [h.x + Math.cos(a) * 9000, h.z + Math.sin(a) * 9000], 150),
        names.street('Road'),
      )
    }
    for (let i = -5; i <= 5; i++) {
      b.add('local', sampled([h.x - 1000, h.z + i * 200], [h.x + 1000, h.z + i * 200], 100))
      b.add('local', sampled([h.x + i * 200, h.z - 1000], [h.x + i * 200, h.z + 1000], 100))
    }
    for (let k = 0; k < 8; k++) {
      const pts: Pt[] = [[h.x + (rnd() - 0.5) * 6000, h.z + (rnd() - 0.5) * 6000]]
      let heading = rnd() * Math.PI * 2
      for (let s = 0; s < 20; s++) {
        heading += (rnd() - 0.5) * 0.9
        const [px, pz] = pts[pts.length - 1]!
        pts.push([px + Math.cos(heading) * 60, pz + Math.sin(heading) * 60])
      }
      b.add('minor', pts)
    }
    cities.push({ name: names.city(), x: h.x + 600, z: h.z - 600, rank: h.rank })
  }
}

// ---------------------------------------------------------------- scenarios B and C

/**
 * A dense urban network of exactly `target` segments in a `width` × `height` area around
 * (cx, cz): motorways, primaries between towns, secondary radials, closely spaced parallel
 * pairs (4–12 units apart), rotated town grids (25–60 units), minor roads and short connectors.
 */
function urban(
  b: Builder,
  rnd: () => number,
  cities: LabCity[],
  cx: number,
  cz: number,
  width: number,
  height: number,
): void {
  const names = nameMaker(rnd)
  const target = b.left
  const quota = (f: number) => Math.round(target * f)
  const randomPt = (margin = 0): Pt => [
    cx - width / 2 + margin + rnd() * (width - 2 * margin),
    cz - height / 2 + margin + rnd() * (height - 2 * margin),
  ]
  const towns: { x: number; z: number; r: number }[] = []
  const townCount = Math.max(4, Math.round(target / 6000))
  for (let i = 0; i < townCount; i++) {
    const r = 300 + rnd() * 900
    const [x, z] = randomPt(r * 1.6 + 200)
    towns.push({ x, z, r })
    cities.push({ name: names.city(), x, z, rank: r > 1000 ? 1 : r > 650 ? 2 : 3 })
  }

  // Motorways: gently curving walks across the area, exactly 250 units per segment. B1.2 (F6): at
  // the edge of the area the walk turns back (the heading is reflected) instead of being clamped,
  // which used to repeat the clamped point and create zero-length segments. The area is always
  // wider and higher than one step, so the reflected step lands inside it.
  const [minX, maxX] = [cx - width / 2, cx + width / 2]
  const [minZ, maxZ] = [cz - height / 2, cz + height / 2]
  let left = quota(0.03)
  for (let m = 1; left > 0; m++) {
    const start = randomPt()
    let heading = rnd() * Math.PI * 2
    const pts: Pt[] = [start]
    const n = Math.min(left, 60 + Math.floor(rnd() * 120))
    for (let s = 0; s < n; s++) {
      heading += (rnd() - 0.5) * 0.12
      const [px, pz] = pts[pts.length - 1]!
      let nx = px + Math.cos(heading) * 250
      if (nx < minX || nx > maxX) heading = Math.PI - heading
      let nz = pz + Math.sin(heading) * 250
      if (nz < minZ || nz > maxZ) heading = -heading
      nx = px + Math.cos(heading) * 250
      nz = pz + Math.sin(heading) * 250
      pts.push([nx, nz])
    }
    left -= b.add('motorway', pts, `M ${m}`)
  }
  // Primary roads between neighbouring towns, 120 units per segment, with a slight bend.
  left = quota(0.07)
  for (let i = 0; left > 0; i++) {
    const a = towns[i % towns.length]!
    const c = towns[(i * 7 + 3) % towns.length]!
    const mid: Pt = [(a.x + c.x) / 2 + (rnd() - 0.5) * 800, (a.z + c.z) / 2 + (rnd() - 0.5) * 800]
    left -= b.add(
      'primary',
      [...sampled([a.x, a.z], mid, 120), ...sampled(mid, [c.x, c.z], 120).slice(1)],
      `Route ${100 + i}`,
    )
  }
  // Secondary radials out of every town.
  left = quota(0.1)
  for (let i = 0; left > 0; i++) {
    const t = towns[i % towns.length]!
    const a = rnd() * Math.PI * 2
    const len = t.r * (1.2 + rnd())
    left -= b.add(
      'secondary',
      sampled([t.x, t.z], [t.x + Math.cos(a) * len, t.z + Math.sin(a) * len], 60),
      names.street('Road'),
    )
  }
  // Closely spaced parallel pairs: 4–12 units apart, straight or curved, secondary or local.
  left = quota(0.08)
  while (left > 0) {
    const t = towns[Math.floor(rnd() * towns.length)]!
    const a = rnd() * Math.PI
    const len = 400 + rnd() * 1600
    const start: Pt = [t.x - Math.cos(a) * len * 0.5, t.z - Math.sin(a) * len * 0.5]
    const bend = (rnd() - 0.5) * 0.002
    const base: Pt[] = []
    for (let d = 0; d <= len; d += 40) {
      const h = a + bend * d
      base.push([start[0] + Math.cos(h) * d, start[1] + Math.sin(h) * d])
    }
    const cls: LabRoadClass = rnd() < 0.5 ? 'secondary' : 'local'
    left -= b.add(cls, base)
    if (left > 0) left -= b.add(cls, offsetLine(base, 4 + rnd() * 8))
  }
  // Short connectors: 1–3 segments of 10–30 units.
  left = quota(0.04)
  while (left > 0) {
    const t = towns[Math.floor(rnd() * towns.length)]!
    const p: Pt[] = [[t.x + (rnd() - 0.5) * t.r * 2, t.z + (rnd() - 0.5) * t.r * 2]]
    const n = 1 + Math.floor(rnd() * 3)
    let h = rnd() * Math.PI * 2
    for (let s = 0; s < n; s++) {
      h += (rnd() - 0.5) * 1.6
      const [px, pz] = p[p.length - 1]!
      const l = 10 + rnd() * 20
      p.push([px + Math.cos(h) * l, pz + Math.sin(h) * l])
    }
    left -= b.add('minor', p)
  }
  // Minor wiggly roads around towns.
  left = quota(0.18)
  while (left > 0) {
    const t = towns[Math.floor(rnd() * towns.length)]!
    const p: Pt[] = [[t.x + (rnd() - 0.5) * t.r * 3, t.z + (rnd() - 0.5) * t.r * 3]]
    let h = rnd() * Math.PI * 2
    const n = 4 + Math.floor(rnd() * 16)
    for (let s = 0; s < n; s++) {
      h += (rnd() - 0.5) * 0.8
      const [px, pz] = p[p.length - 1]!
      p.push([px + Math.cos(h) * 35, pz + Math.sin(h) * 35])
    }
    left -= b.add('minor', p)
  }
  // Town grids (local) until the budget is used exactly.
  for (let i = 0; b.left > 0; i++) {
    const t = towns[i % towns.length]!
    const gap = 25 + rnd() * 35
    const n = Math.max(4, Math.round((t.r * 2) / gap))
    const half = (n * gap) / 2
    const ox = t.x + (rnd() - 0.5) * t.r
    const oz = t.z + (rnd() - 0.5) * t.r
    const angle = rnd() * Math.PI
    const [c, s] = [Math.cos(angle), Math.sin(angle)]
    const rot = ([x, z]: Pt): Pt => [ox + x * c - z * s, oz + x * s + z * c]
    for (let k = 0; k <= n && b.left > 0; k++) {
      const o = -half + k * gap
      const name = k % 3 === 0 ? names.street('Street') : undefined
      b.add('local', sampled([-half, o], [half, o], gap).map(rot), name)
      if (b.left > 0) b.add('local', sampled([o, -half], [o, half], gap).map(rot))
    }
  }
}

// ---------------------------------------------------------------- scenario D

/** Widths in CSS pixels drawn by scenario D, one row each. */
export const THIN_WIDTHS = [0.5, 0.75, 1, 1.5, 2, 3] as const

function thin(b: Builder): void {
  const ox = -100_000
  const oz = -70_000
  THIN_WIDTHS.forEach((w, row) => {
    const z = oz + row * 400
    const cls: LabRoadClass = w >= 2 ? 'primary' : w >= 1 ? 'local' : 'minor'
    // Straight road, a circle arc, and a zig-zag with sharp (about 20°) joins.
    b.add(cls, sampled([ox, z], [ox + 600, z], 50), undefined, w)
    b.add(cls, arc(ox + 900, z + 150, 150, Math.PI, Math.PI * 2, 10), undefined, w)
    const zig: Pt[] = []
    for (let i = 0; i <= 10; i++) zig.push([ox + 1200 + i * 30, z + (i % 2 === 0 ? 0 : 160)])
    b.add(cls, zig, undefined, w)
    // Star intersection: six roads through one point.
    for (let k = 0; k < 6; k++) {
      const a = (k / 6) * Math.PI
      const [c, s] = [Math.cos(a) * 140, Math.sin(a) * 140]
      b.add(
        cls,
        [
          [ox + 1800 - c, z + 150 - s],
          [ox + 1800 + c, z + 150 + s],
        ],
        undefined,
        w,
      )
    }
    // Closely spaced parallels (1, 2, 4, 8 units), an identical duplicate and a collinear overlap.
    const base = sampled([ox + 2100, z], [ox + 2700, z + 120], 40)
    b.add(cls, base, undefined, w)
    for (const d of [1, 2, 4, 8]) b.add(cls, offsetLine(base, d), undefined, w)
    b.add(cls, base, undefined, w)
    b.add(cls, sampled([ox + 2300, z + 40], [ox + 2500, z + 80], 40), undefined, w)
  })
}

// ---------------------------------------------------------------- build

function fnv(hash: number, value: number): number {
  hash ^= value
  return Math.imul(hash, 0x01000193) >>> 0
}

function hashOf(roads: readonly LabRoad[]): string {
  let h = 0x811c9dc5
  for (const r of roads) {
    h = fnv(h, LAB_CLASSES.indexOf(r.cls))
    h = fnv(h, Math.round((r.width ?? 0) * 100))
    const words = new Uint32Array(r.points.buffer, r.points.byteOffset, r.points.length * 2)
    for (let i = 0; i < words.length; i++) h = fnv(h, words[i]!)
  }
  return h.toString(16).padStart(8, '0')
}

function boundsOf(roads: readonly LabRoad[]): [number, number, number, number] {
  let [minX, minZ, maxX, maxZ] = [Infinity, Infinity, -Infinity, -Infinity]
  for (const r of roads) {
    const p = r.points
    for (let i = 0; i < p.length; i += 2) {
      minX = Math.min(minX, p[i]!)
      maxX = Math.max(maxX, p[i]!)
      minZ = Math.min(minZ, p[i + 1]!)
      maxZ = Math.max(maxZ, p[i + 1]!)
    }
  }
  return [minX, minZ, maxX, maxZ]
}

export function buildDataset(id: LabScenarioId, requestedSegments?: number): LabDataset {
  const def = LAB_SCENARIOS.find((s) => s.id === id)!
  const target =
    def.defaultSegments !== undefined
      ? Math.max(1000, Math.round(requestedSegments ?? def.defaultSegments))
      : Infinity
  const seed = LAB_SEED + LAB_SCENARIOS.indexOf(def)
  const rnd = seededRandom(seed)
  const b = new Builder(target)
  const cities: LabCity[] = []
  switch (id) {
    case 'basic':
      basic(b, rnd, cities)
      break
    case 'urban': {
      const w = Math.round(Math.sqrt(target) * 75)
      urban(b, rnd, cities, -100_000, -70_000, w, Math.round(w * 0.75))
      break
    }
    case 'stress': {
      const w = Math.round(Math.sqrt(target) * 75)
      urban(b, rnd, cities, -80_000, -60_000, w, Math.round(w * 0.75))
      break
    }
    case 'thin':
      thin(b)
      break
  }
  return {
    id,
    seed,
    bounds: boundsOf(b.roads),
    roads: b.roads,
    cities,
    probes: PROBES.slice(),
    segments: b.segments,
    hash: hashOf(b.roads),
  }
}

/** The world square of the CRS in native units, for range checks: [min, max] on both axes. */
export const WORLD_LIMIT: readonly [number, number] = [WORLD_ORIGIN[0], WORLD_ORIGIN[1]]

// ---------------------------------------------------------------- conversions

export interface RoadProps {
  /** Road class. */
  c: LabRoadClass
  /** Name, for labels. */
  n?: string
  /** Scenario D: width in CSS pixels. */
  w?: number
}

/** Roads as GeoJSON in carrier coordinates (`toCarrier`), one LineString per road. */
export function roadsGeoJSON(ds: LabDataset): FeatureCollection<LineString, RoadProps> {
  const features: Feature<LineString, RoadProps>[] = ds.roads.map((r, i) => {
    const coordinates: number[][] = []
    for (let k = 0; k < r.points.length; k += 2)
      coordinates.push(toCarrier({ x: r.points[k]!, z: r.points[k + 1]! }))
    const properties: RoadProps = { c: r.cls }
    if (r.name !== undefined) properties.n = r.name
    if (r.width !== undefined) properties.w = r.width
    return { type: 'Feature', id: i, geometry: { type: 'LineString', coordinates }, properties }
  })
  return { type: 'FeatureCollection', features }
}

export function citiesGeoJSON(ds: LabDataset): FeatureCollection<Point, { n: string; r: number }> {
  return {
    type: 'FeatureCollection',
    features: ds.cities.map((c, i) => ({
      type: 'Feature',
      id: i,
      geometry: { type: 'Point', coordinates: toCarrier(c) },
      properties: { n: c.name, r: c.rank },
    })),
  }
}

export function probesGeoJSON(
  probes: readonly LabProbe[],
): FeatureCollection<Point, { id: string }> {
  return {
    type: 'FeatureCollection',
    features: probes.map((p, i) => ({
      type: 'Feature',
      id: i,
      geometry: { type: 'Point', coordinates: toCarrier(p) },
      properties: { id: p.id },
    })),
  }
}

/**
 * The M3 renderer's road class for a lab class. The production classes have no `secondary`;
 * it is drawn as `primary` there. Geometry and segment counts are unchanged.
 */
export const M3_CLASS: Record<LabRoadClass, RoadClass> = {
  motorway: 'motorway',
  primary: 'primary',
  secondary: 'primary',
  local: 'local',
  minor: 'minor',
}

const pow2 = (v: number) => 2 ** Math.round(Math.log2(Math.max(v, 256)))

/**
 * The same dataset as a scenario of the M3 WebGL 2 prototype (`syntheticScenarios.ts`), so the
 * unchanged `ScenarioTiles` and `WebGL2RoadRenderer` draw identical geometry. Tile sizes follow
 * the M3 rule for its `large` and `stress` scenarios (a tenth of the width, power of two).
 */
export function toM3Scenario(ds: LabDataset): Scenario {
  const [minX, minZ, maxX, maxZ] = ds.bounds
  const t0 = pow2((maxX - minX) / 10)
  return {
    id: ds.id === 'stress' ? 'stress' : 'large',
    contentId: contentIdOf(`maplibre-${ds.id}-${ds.hash}`, ds.segments),
    bounds: [minX, minZ, maxX, maxZ],
    tileSizes: [t0, t0 * 4, t0 * 16, t0 * 64],
    roads: ds.roads.map((r) => ({
      roadClass: M3_CLASS[r.cls],
      flags: ROAD_FLAG_ESTIMATED,
      points: r.points,
    })),
    segments: ds.segments,
  }
}
