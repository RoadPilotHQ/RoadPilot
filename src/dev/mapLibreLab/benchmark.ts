/**
 * DEVELOPMENT ONLY (Phase 2.4D B1): measurement helpers shared by both renderers of the MapLibre
 * lab. The camera paths are the ones of the M2/M3 render lab (`src/dev/renderLab/main.ts`), so the
 * numbers of both labs are taken the same way:
 *
 * - pan: a circle of 300 CSS pixels radius, one turn per 1.5 s, for 3 s by default;
 * - zoom: cycles of 3 s, in ×64 and back out (6 zoom levels), 3 cycles by default.
 *
 * Frame gaps are the times between consecutive rendered frames (`requestAnimationFrame`
 * timestamps; every frame renders during an animation).
 */
import { pixelsPerUnit, type CrsChoice, type NativePoint } from './coordinates'

/** Nearest-rank quantile, the same definition as the render lab's. */
export function quantile(values: readonly number[], q: number): number {
  if (values.length === 0) return NaN
  const s = [...values].sort((a, b) => a - b)
  return s[Math.min(s.length - 1, Math.floor(q * (s.length - 1) + 0.5))]!
}

export interface GapStats {
  frames: number
  durationMs: number
  fps: number
  p50: number
  p95: number
  max: number
}

/** Frame gap statistics of `requestAnimationFrame` timestamps (ms) of rendered frames. */
export function frameGapStats(times: readonly number[]): GapStats {
  const gaps: number[] = []
  for (let i = 1; i < times.length; i++) gaps.push(times[i]! - times[i - 1]!)
  const span = times.length > 1 ? times[times.length - 1]! - times[0]! : 0
  return {
    frames: times.length,
    durationMs: span,
    fps: span > 0 ? ((times.length - 1) * 1000) / span : 0,
    p50: quantile(gaps, 0.5),
    p95: quantile(gaps, 0.95),
    max: gaps.length ? Math.max(...gaps) : NaN,
  }
}

export interface Camera {
  center: NativePoint
  zoom: number
}

export const PAN_RADIUS_PX = 300
export const PAN_TURN_MS = 1500
export const ZOOM_CYCLE_MS = 3000
/** ×64 = 6 zoom levels. */
export const ZOOM_RANGE = 6

/** The pan path of the render lab at time `t` (ms): a circle through the start position. */
export function panCamera(start: Camera, t: number, crs: CrsChoice = 'scs'): Camera {
  const a = (t / PAN_TURN_MS) * Math.PI * 2
  const r = PAN_RADIUS_PX / pixelsPerUnit(start.zoom, crs)
  return {
    zoom: start.zoom,
    center: { x: start.center.x + Math.cos(a) * r - r, z: start.center.z + Math.sin(a) * r },
  }
}

/** The zoom path of the render lab at time `t` (ms): in ×64 and back out per cycle. */
export function zoomCamera(start: Camera, t: number): Camera {
  const c = (t % ZOOM_CYCLE_MS) / (ZOOM_CYCLE_MS / 2)
  const f = c <= 1 ? c : 2 - c
  return { center: start.center, zoom: start.zoom + ZOOM_RANGE * f }
}

export interface PhaseSummary extends GapStats {
  phase: 'pan' | 'zoom'
  /** CPU time of the render call per frame (MapLibre `redraw()`, M3 `render()`), ms. */
  renderP50: number
  renderP95: number
  renderMax: number
  /** Frames with a gap above 50 ms. */
  gapsOver50: number
}

export function summarizePhase(
  phase: 'pan' | 'zoom',
  times: readonly number[],
  renderMs: readonly number[],
): PhaseSummary {
  const g = frameGapStats(times)
  let over = 0
  for (let i = 1; i < times.length; i++) if (times[i]! - times[i - 1]! > 50) over++
  return {
    phase,
    ...g,
    renderP50: quantile(renderMs, 0.5),
    renderP95: quantile(renderMs, 0.95),
    renderMax: renderMs.length ? Math.max(...renderMs) : NaN,
    gapsOver50: over,
  }
}
