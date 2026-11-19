/**
 * Projection and drawing of the traveled path. Pure functions over a minimal canvas
 * interface, so they are testable without a browser canvas.
 *
 * North is up: telemetry X (east) goes right, telemetry Z (south) goes down. One scale for
 * both axes, so shapes are not distorted. Distances are telemetry metres.
 */
import { traceBounds, type PathPoint, type PathTrace } from '@/domain/path'

export type ViewMode = 'follow' | 'fit'

export interface View {
  /** Pixels per metre. */
  scale: number
  toScreen(p: PathPoint): { x: number; y: number }
}

/** Smallest area shown, so a short trace or a single point is not blown up (metres). */
export const MIN_SPAN_M = 200
/** Area shown around the truck in follow mode (metres). */
export const FOLLOW_SPAN_M = 1500
const PADDING_PX = 24

export function computeView(
  trace: PathTrace,
  width: number,
  height: number,
  mode: ViewMode,
): View | null {
  const bounds = traceBounds(trace)
  if (!bounds || !trace.last || width <= 0 || height <= 0) return null
  let cx: number, cz: number, spanX: number, spanZ: number
  if (mode === 'follow') {
    cx = trace.last.x
    cz = trace.last.z
    spanX = spanZ = FOLLOW_SPAN_M
  } else {
    cx = (bounds.minX + bounds.maxX) / 2
    cz = (bounds.minZ + bounds.maxZ) / 2
    spanX = Math.max(bounds.maxX - bounds.minX, MIN_SPAN_M)
    spanZ = Math.max(bounds.maxZ - bounds.minZ, MIN_SPAN_M)
  }
  const usableW = Math.max(width - 2 * PADDING_PX, 1)
  const usableH = Math.max(height - 2 * PADDING_PX, 1)
  const scale = Math.min(usableW / spanX, usableH / spanZ)
  return {
    scale,
    toScreen: (p) => ({ x: width / 2 + (p.x - cx) * scale, y: height / 2 + (p.z - cz) * scale }),
  }
}

/**
 * A round length for a scale bar of about a quarter of the width: 1, 2 or 5 × 10^n, in the
 * unit `metresPerUnit` describes (1 for metres, 0.3048 for feet, 1000 for km …).
 */
export function scaleBar(
  view: View,
  width: number,
  metresPerUnit: number,
): { units: number; px: number } {
  const target = width / 4 / view.scale / metresPerUnit
  const magnitude = 10 ** Math.floor(Math.log10(target))
  const units = [5, 2, 1].map((m) => m * magnitude).find((v) => v <= target) ?? magnitude
  return { units, px: units * metresPerUnit * view.scale }
}

/** The subset of `CanvasRenderingContext2D` the drawing uses. */
export type Ctx = Pick<
  CanvasRenderingContext2D,
  | 'clearRect'
  | 'beginPath'
  | 'moveTo'
  | 'lineTo'
  | 'stroke'
  | 'fill'
  | 'arc'
  | 'closePath'
  | 'save'
  | 'restore'
  | 'translate'
  | 'rotate'
  | 'setLineDash'
> & {
  strokeStyle: string | CanvasGradient | CanvasPattern
  fillStyle: string | CanvasGradient | CanvasPattern
  lineWidth: number
  lineJoin: CanvasLineJoin
  lineCap: CanvasLineCap
}

export interface Palette {
  path: string
  start: string
  current: string
  stale: string
  outline: string
}

/** Draws the trace. The marker is hollow and grey when the position is not current. */
export function drawTrace(
  ctx: Ctx,
  trace: PathTrace,
  view: View,
  size: { width: number; height: number },
  palette: Palette,
  stale: boolean,
): void {
  ctx.clearRect(0, 0, size.width, size.height)
  ctx.lineJoin = 'round'
  ctx.lineCap = 'round'
  ctx.lineWidth = 3
  ctx.strokeStyle = stale ? palette.stale : palette.path
  ctx.setLineDash([])
  for (const segment of trace.segments) {
    if (segment.length < 2) continue
    ctx.beginPath()
    segment.forEach((p, i) => {
      const s = view.toScreen(p)
      if (i === 0) ctx.moveTo(s.x, s.y)
      else ctx.lineTo(s.x, s.y)
    })
    ctx.stroke()
  }

  const first = trace.segments[0]?.[0]
  if (first) {
    const s = view.toScreen(first)
    ctx.beginPath()
    ctx.arc(s.x, s.y, 5, 0, Math.PI * 2)
    ctx.fillStyle = palette.start
    ctx.fill()
  }

  if (trace.last) {
    const s = view.toScreen(trace.last)
    // Heading is counterclockwise from north; on screen north is up.
    const angle = (-trace.last.headingDeg * Math.PI) / 180
    ctx.save()
    ctx.translate(s.x, s.y)
    ctx.rotate(angle)
    ctx.beginPath()
    ctx.moveTo(0, -11)
    ctx.lineTo(8, 9)
    ctx.lineTo(0, 4)
    ctx.lineTo(-8, 9)
    ctx.closePath()
    ctx.lineWidth = 2
    ctx.strokeStyle = palette.outline
    if (stale) ctx.setLineDash([3, 2])
    ctx.stroke()
    if (!stale) {
      ctx.fillStyle = palette.current
      ctx.fill()
    }
    ctx.restore()
  }
}
