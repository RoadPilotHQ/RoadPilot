/**
 * DEVELOPMENT ONLY (Phase 2.4D B1.5.5): which accuracy probes can be measured, and how a drawn
 * probe dot is found in a WebGL read-back. Pure (no MapLibre, no DOM), so the unit tests run
 * without WebGL.
 *
 * B1.5.5 static analysis of the B1.5.4F evidence: at low zoom the probe grid reaches outside the
 * CRS world. MapLibre clears the frame to transparent and draws the background only over the
 * world's tiles, so those pixels read back as RGBA (0, 0, 0, 0). The former finder counted such
 * pixels as full-weight probe pixels: probes outside the world were "found" at the centre of the
 * search window, and probes near the edge were pulled towards it. Two corrections:
 *
 * 1. `probeMeasurability`: a probe outside the world, or closer to its edge than
 *    `PROBE_EDGE_MARGIN_PX`, is `not_measurable`. It is reported and counted, never measured and
 *    never a pass (`accuracyReport.ts`).
 * 2. `findDot`: only opaque pixels whose colour lies on the mix between the background and the
 *    probe colour count. A cleared (transparent) pixel or a foreign colour is never a probe pixel,
 *    so a dot that is not drawn stays missing (null), which fails the accuracy criterion.
 */
import { pixelsPerUnit, worldExtentOf, type CrsChoice, type NativePoint } from './coordinates'
import { COLORS } from './mapStyle'

/** Radius of a probe dot, CSS px (`circle-radius` of the `probe` layer in `mapStyle.ts`). */
export const PROBE_RADIUS_PX = 3

/** Half-width of the square `findDot` searches around the expected position, CSS px. */
export const FIND_RADIUS_PX = 10

/**
 * Minimum distance between a probe and the CRS world edge, CSS px, for the probe to be measurable.
 * The search window reaches at most `ceil(FIND_RADIUS_PX · dpr) / dpr` plus half a device pixel of
 * centre rounding from the expected position (< 11.5 CSS px for DPR ≥ 1); the dot itself reaches
 * `PROBE_RADIUS_PX`. Their sum (13 CSS px) keeps the whole window and the whole dot inside the
 * world, with slack for the edge's anti-aliasing.
 */
export const PROBE_EDGE_MARGIN_PX = FIND_RADIUS_PX + PROBE_RADIUS_PX

export type NotMeasurableReason = 'outside_world' | 'edge_margin'

export interface Measurability {
  measurable: boolean
  /** null when measurable. */
  reason: NotMeasurableReason | null
  /** Distance to the nearest world edge, CSS px; negative outside the world. */
  edgeDistancePx: number
}

/**
 * The CRS world in native units. `scs`: tile 0/0/0 spans ±2¹⁷ on both axes (`scsCrs`). `identity`:
 * tile 0 spans −90..90 carrier units on both axes, i.e. ±90 · 2¹¹ native units (`worldExtentOf`).
 */
export function worldBoundsOf(crs: CrsChoice) {
  const half = worldExtentOf(crs) / 2
  return { minX: -half, maxX: half, minZ: -half, maxZ: half }
}

/** Whether a probe at native `p` can be measured at `zoom` in `crs`. */
export function probeMeasurability(p: NativePoint, zoom: number, crs: CrsChoice): Measurability {
  const b = worldBoundsOf(crs)
  const units = Math.min(p.x - b.minX, b.maxX - p.x, p.z - b.minZ, b.maxZ - p.z)
  const edgeDistancePx = units * pixelsPerUnit(zoom, crs)
  if (!(edgeDistancePx >= 0)) return { measurable: false, reason: 'outside_world', edgeDistancePx }
  if (edgeDistancePx < PROBE_EDGE_MARGIN_PX)
    return { measurable: false, reason: 'edge_margin', edgeDistancePx }
  return { measurable: true, reason: null, edgeDistancePx }
}

const rgb = (hex: string): [number, number, number] => [
  parseInt(hex.slice(1, 3), 16),
  parseInt(hex.slice(3, 5), 16),
  parseInt(hex.slice(5, 7), 16),
]

/** Background and probe colour of the lab style (the accuracy run hides every other layer). */
export const BACKGROUND_RGB = rgb(COLORS.background)
export const PROBE_RGB = rgb(COLORS.probe)

/**
 * How far an RGB value may leave the background → probe mix, as a fraction of each channel's
 * span. 8-bit rounding of an anti-aliased edge is at most 1/41 on the narrowest channel (red).
 */
export const MIX_TOLERANCE = 0.1

/**
 * Probe weight of one read-back pixel in [0, 1], or 0 when it is not a probe pixel: it must be
 * fully opaque (the map inside the world is; the cleared area outside is not) and its colour must
 * lie on the mix between background and probe colour in every channel, consistently.
 */
export function probePixelWeight(r: number, g: number, b: number, a: number): number {
  if (a !== 255) return 0
  const t = [r, g, b].map((v, i) => (BACKGROUND_RGB[i]! - v) / (BACKGROUND_RGB[i]! - PROBE_RGB[i]!))
  if (t.some((x) => x < -MIX_TOLERANCE || x > 1 + MIX_TOLERANCE)) return 0
  if (Math.max(...t) - Math.min(...t) > 2 * MIX_TOLERANCE) return 0
  // Weight as before B1.5.5: the mean of the red and green fractions, clamped.
  const w = Math.max(0, Math.min(1, (t[0]! + t[1]!) / 2))
  return w <= 0.02 ? 0 : w
}

/**
 * Centroid of probe pixels around a CSS position, in CSS pixels; null when none was found.
 * `px` is a `readPixels` RGBA buffer of `w` × `h` device pixels (rows start at the bottom).
 */
export function findDot(
  px: Uint8Array,
  w: number,
  h: number,
  dpr: number,
  at: { x: number; y: number },
): { x: number; y: number } | null {
  const R = Math.ceil(FIND_RADIUS_PX * dpr)
  const cx = Math.round(at.x * dpr)
  const cy = Math.round(at.y * dpr)
  let sx = 0
  let sy = 0
  let sw = 0
  for (let y = cy - R; y <= cy + R; y++) {
    if (y < 0 || y >= h) continue
    for (let x = cx - R; x <= cx + R; x++) {
      if (x < 0 || x >= w) continue
      const i = ((h - 1 - y) * w + x) * 4
      const wgt = probePixelWeight(px[i]!, px[i + 1]!, px[i + 2]!, px[i + 3]!)
      if (wgt === 0) continue
      sx += (x + 0.5) * wgt
      sy += (y + 0.5) * wgt
      sw += wgt
    }
  }
  return sw > 0 ? { x: sx / sw / dpr, y: sy / sw / dpr } : null
}
