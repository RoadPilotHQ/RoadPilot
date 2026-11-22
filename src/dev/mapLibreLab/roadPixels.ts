/**
 * DEVELOPMENT ONLY (Phase 2.4D B1.4, O3): detection of road-geometry pixels in a read-back frame,
 * for the "first visible geometry" measurement. Pure; no MapLibre, no DOM.
 *
 * Definition: first visible geometry is the first rendered frame that contains at least one
 * pixel belonging to the road line layers. A pixel belongs to them when its colour is within
 * `ROAD_PIXEL_TOLERANCE` (per channel) of the fill colour of a road class that is *detectable*.
 *
 * A road class is detectable only when no pixel that is not road geometry can have its colour.
 * Every non-road pixel of the map canvas is a mix (antialiasing, SDF text edges, halos, alpha
 * blending) of the colours in `NON_ROAD_PALETTE`: background, label text, label halo, the
 * motorway label colour (which equals the motorway casing colour, so the casing is never
 * detected) and the probe colour. Such mixes lie in the convex hull of that palette in RGB. A
 * road fill colour counts only if its distance to that hull exceeds the whole tolerance box
 * (Euclidean distance > tolerance · √3), so a label, halo or background pixel can never match it.
 * Controls, overlays and the attribution are DOM elements outside the WebGL drawing buffer.
 *
 * Classes whose fill colour is too close to the hull are not detected. First visible geometry is
 * then reported when a detectable class appears, which can only make it later, never earlier.
 */
import { COLORS, DRAW_ORDER } from './mapStyle'
import type { LabRoadClass } from './syntheticData'

export type Rgb = readonly [number, number, number]

/** Per-channel tolerance for a road pixel (opaque line interior; edges are not needed). */
export const ROAD_PIXEL_TOLERANCE = 4

export function hexToRgb(hex: string): Rgb {
  const m = /^#([0-9a-f]{6})$/i.exec(hex)
  if (!m) throw new Error(`Unsupported colour ${hex}`)
  const n = parseInt(m[1]!, 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}

/** Colours of the road line layers' interiors, by class. */
export const ROAD_FILL: Readonly<Record<LabRoadClass, Rgb>> = {
  motorway: hexToRgb(COLORS.motorway),
  primary: hexToRgb(COLORS.primary),
  secondary: hexToRgb(COLORS.secondary),
  local: hexToRgb(COLORS.local),
  minor: hexToRgb(COLORS.minor),
}

/** Which non-road layers the configured style draws (`buildStyle` options). */
export interface CanvasContent {
  labels: boolean
  probes: boolean
}

/** Every colour of the map canvas that is not road geometry, for the configured style. */
export function nonRoadPalette(content: CanvasContent): { name: string; rgb: Rgb }[] {
  const palette = [{ name: 'background', rgb: hexToRgb(COLORS.background) }]
  if (content.labels)
    palette.push(
      { name: 'halo', rgb: hexToRgb(COLORS.halo) },
      { name: 'text', rgb: hexToRgb(COLORS.text) },
      { name: 'textMuted', rgb: hexToRgb(COLORS.textMuted) },
      { name: 'motorwayLabel', rgb: hexToRgb(COLORS.motorwayCasing) },
    )
  if (content.probes) palette.push({ name: 'probe', rgb: hexToRgb(COLORS.probe) })
  return palette
}

/** The palette of the fullest configuration (labels and probes on). */
export const NON_ROAD_PALETTE = nonRoadPalette({ labels: true, probes: true })

type Vec = [number, number, number]
const sub = (a: Rgb, b: Rgb): Vec => [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
const dot = (a: Vec, b: Vec) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]

/** Solves a small dense linear system; null when singular. */
function solve(m: number[][], v: number[]): number[] | null {
  const n = v.length
  const a = m.map((row, i) => [...row, v[i]!])
  for (let c = 0; c < n; c++) {
    let p = c
    for (let r = c + 1; r < n; r++) if (Math.abs(a[r]![c]!) > Math.abs(a[p]![c]!)) p = r
    if (Math.abs(a[p]![c]!) < 1e-9) return null
    ;[a[c], a[p]] = [a[p]!, a[c]!]
    for (let r = 0; r < n; r++) {
      if (r === c) continue
      const f = a[r]![c]! / a[c]![c]!
      for (let k = c; k <= n; k++) a[r]![k]! -= f * a[c]![k]!
    }
  }
  return a.map((row, i) => row[n]! / row[i]!)
}

function subsets<T>(items: readonly T[], maxSize: number): T[][] {
  const out: T[][] = []
  const walk = (start: number, cur: T[]) => {
    if (cur.length > 0) out.push(cur.slice())
    if (cur.length === maxSize) return
    for (let i = start; i < items.length; i++) {
      cur.push(items[i]!)
      walk(i + 1, cur)
      cur.pop()
    }
  }
  walk(0, [])
  return out
}

/**
 * Exact Euclidean distance from `c` to the convex hull of `points` in RGB. In three dimensions the
 * nearest hull point lies in the relative interior of a simplex of at most four points, so every
 * subset of up to four points is tried: project `c` onto its affine hull and keep the projection
 * when all barycentric weights are non-negative.
 */
export function distanceToHull(c: Rgb, points: readonly Rgb[]): number {
  let best = Infinity
  for (const s of subsets(points, 4)) {
    const p0 = s[0]!
    const dirs = s.slice(1).map((p) => sub(p, p0))
    const target = sub(c, p0)
    let mu: number[] = []
    if (dirs.length > 0) {
      const sol = solve(
        dirs.map((a) => dirs.map((b) => dot(a, b))),
        dirs.map((a) => dot(a, target)),
      )
      if (!sol) continue
      mu = sol
    }
    const w0 = 1 - mu.reduce((x, y) => x + y, 0)
    if (w0 < -1e-9 || mu.some((m) => m < -1e-9)) continue
    const q: Vec = [p0[0], p0[1], p0[2]]
    dirs.forEach((d, i) => {
      q[0] += d[0] * mu[i]!
      q[1] += d[1] * mu[i]!
      q[2] += d[2] * mu[i]!
    })
    best = Math.min(best, Math.hypot(c[0] - q[0], c[1] - q[1], c[2] - q[2]))
  }
  return best
}

/**
 * Every road-layer colour that can be detected: the fills in draw order, then the motorway casing
 * (also road geometry; it shares its colour with the motorway labels, so it is detectable only
 * when labels are off).
 */
export const ROAD_LAYER_COLOURS: readonly { layer: string; rgb: Rgb }[] = [
  ...DRAW_ORDER.map((cls) => ({ layer: `road-${cls}`, rgb: ROAD_FILL[cls] })),
  { layer: 'road-motorway-casing', rgb: hexToRgb(COLORS.motorwayCasing) },
]

export interface DetectableColour {
  /** Style layer id the colour belongs to. */
  layer: string
  rgb: Rgb
  /** Euclidean RGB distance to the convex hull of the non-road palette. */
  hullDistance: number
}

/**
 * The road fill colours that no non-road pixel of the configured style can match within
 * `tolerance`, in draw order. Defaults to the fullest configuration (labels and probes on).
 */
export function detectableRoadColours(
  content: CanvasContent = { labels: true, probes: true },
  tolerance = ROAD_PIXEL_TOLERANCE,
): DetectableColour[] {
  const hull = nonRoadPalette(content).map((p) => p.rgb)
  return ROAD_LAYER_COLOURS.map(({ layer, rgb }) => ({
    layer,
    rgb,
    hullDistance: distanceToHull(rgb, hull),
  })).filter((c) => c.hullDistance > tolerance * Math.sqrt(3))
}

/** Whether one RGB value matches a detectable road colour within the tolerance. */
export function isRoadPixel(
  r: number,
  g: number,
  b: number,
  colours: readonly DetectableColour[],
  tolerance = ROAD_PIXEL_TOLERANCE,
): boolean {
  for (const { rgb } of colours)
    if (
      Math.abs(r - rgb[0]) <= tolerance &&
      Math.abs(g - rgb[1]) <= tolerance &&
      Math.abs(b - rgb[2]) <= tolerance
    )
      return true
  return false
}

/** Road-geometry pixels in an RGBA buffer (`readPixels` layout; every pixel is examined). */
export function countRoadPixels(
  rgba: Uint8Array,
  colours: readonly DetectableColour[],
  tolerance = ROAD_PIXEL_TOLERANCE,
): number {
  let n = 0
  for (let i = 0; i + 3 < rgba.length; i += 4)
    if (isRoadPixel(rgba[i]!, rgba[i + 1]!, rgba[i + 2]!, colours, tolerance)) n++
  return n
}
