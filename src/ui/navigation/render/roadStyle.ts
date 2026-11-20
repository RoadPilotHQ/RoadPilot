/**
 * PROTOTYPE (M2): road styles for the WebGL renderer, derived from the production
 * `ROAD_STYLES` of `roadPainter.ts`, so colours, widths and the rail dash have one source.
 */
import { ROAD_CLASSES, type RoadClass } from '@/domain/mapTile'
import { ROAD_STYLES } from '../roadPainter'

/** Draw order of the production painter: most important on top. */
export const DRAW_ORDER: readonly RoadClass[] = ['rail', 'minor', 'local', 'primary', 'motorway']

/** Opacity of chords (roads without an estimated curve), as in the production painter. */
export const CHORD_ALPHA = 0.6

/**
 * Extra width in CSS pixels at detailed zoom. The production painter computes this inline in
 * `drawRoads` and does not export it; it is repeated here unchanged because M2 must not touch
 * the production renderer. Keep both in step (covered by `roadStyle.test.ts`).
 */
export function zoomBonus(scale: number): number {
  return scale >= 0.4 ? 1.5 : scale >= 0.05 ? 0.5 : 0
}

/** Line width in CSS pixels, as the production painter strokes it. */
export function lineWidth(roadClass: RoadClass, scale: number): number {
  return ROAD_STYLES[roadClass].width + zoomBonus(scale)
}

export function hexToRgb(hex: string): [number, number, number] {
  const m = /^#([0-9a-f]{6})$/i.exec(hex)
  if (!m) throw new Error(`Unsupported colour ${hex}`)
  const n = parseInt(m[1]!, 16)
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255]
}

/** Dash `[on, off]` in CSS pixels, or null for a solid line. Only two-value dashes exist. */
export function dashOf(roadClass: RoadClass): [number, number] | null {
  const dash = ROAD_STYLES[roadClass].dash
  if (!dash || dash.length === 0) return null
  return [dash[0]!, dash[1] ?? dash[0]!]
}

export const classIndex = (c: RoadClass) => ROAD_CLASSES.indexOf(c)
