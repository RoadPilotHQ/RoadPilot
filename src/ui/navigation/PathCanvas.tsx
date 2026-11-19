import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { PathTrace } from '@/domain/path'
import { fitCanvas, useDevicePixelRatio } from './canvasSize'
import { computeView, drawTrace, type Palette, type View, type ViewMode } from './pathView'

/** Theme colours; canvas drawing cannot read CSS variables cheaply on every frame. */
export const PATH_PALETTE: Palette = {
  path: '#e8792e',
  start: '#438b50',
  current: '#e8792e',
  stale: '#b8ab98',
  outline: '#292724',
}

export interface CanvasSize {
  width: number
  height: number
}

/** Follows the size of an element; falls back to window resizes without `ResizeObserver`. */
export function useElementSize(ref: React.RefObject<HTMLElement | null>): CanvasSize {
  const [size, setSize] = useState<CanvasSize>({ width: 0, height: 0 })
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const measure = () => {
      const rect = el.getBoundingClientRect()
      const next = { width: Math.floor(rect.width), height: Math.floor(rect.height) }
      setSize((prev) => (prev.width === next.width && prev.height === next.height ? prev : next))
    }
    measure()
    if (typeof ResizeObserver !== 'undefined') {
      const observer = new ResizeObserver(measure)
      observer.observe(el)
      return () => observer.disconnect()
    }
    window.addEventListener('resize', measure)
    return () => window.removeEventListener('resize', measure)
  }, [ref])
  return size
}

/**
 * The traveled path on a canvas sized to its container, sharp on high-density screens.
 * Draws only when the trace, the size, the view or the staleness changes.
 */
export function PathCanvas({
  trace,
  mode,
  stale,
  label,
  overlay,
}: {
  trace: PathTrace
  mode: ViewMode
  stale: boolean
  label: string
  /** Drawn over the canvas with the current projection, e.g. a scale bar. */
  overlay?: (view: View, size: CanvasSize) => ReactNode
}) {
  const box = useRef<HTMLDivElement>(null)
  const canvas = useRef<HTMLCanvasElement>(null)
  const size = useElementSize(box)
  const ratio = useDevicePixelRatio()
  const view = useMemo(() => computeView(trace, size.width, size.height, mode), [trace, size, mode])

  useEffect(() => {
    const el = canvas.current
    if (!el) return
    // The backing store is reallocated only when its pixel size changes.
    fitCanvas(el, size.width, size.height, ratio)
    const ctx = el.getContext?.('2d')
    if (!ctx) return
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0)
    if (!view) {
      ctx.clearRect(0, 0, size.width, size.height)
      return
    }
    drawTrace(ctx, trace, view, size, PATH_PALETTE, stale)
  }, [trace, size, view, stale, ratio])

  return (
    <div ref={box} className="path-canvas-box">
      <canvas ref={canvas} className="path-canvas" role="img" aria-label={label} />
      {view && overlay ? overlay(view, size) : null}
    </div>
  )
}
