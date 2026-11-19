import { useEffect, useState } from 'react'

/**
 * Gives the canvas the backing store for `cssWidth` × `cssHeight` CSS pixels at `ratio` device
 * pixels per CSS pixel, but only when that pixel size differs from the current one. Assigning
 * `width` or `height` always discards and reallocates the backing store, even with the same
 * value, so it must not happen on every draw. Returns whether the size changed.
 */
export function fitCanvas(
  el: HTMLCanvasElement,
  cssWidth: number,
  cssHeight: number,
  ratio: number,
): boolean {
  const width = Math.max(1, Math.round(cssWidth * ratio))
  const height = Math.max(1, Math.round(cssHeight * ratio))
  if (el.width === width && el.height === height) return false
  el.width = width
  el.height = height
  return true
}

const currentRatio = () =>
  typeof window !== 'undefined' && window.devicePixelRatio > 0 ? window.devicePixelRatio : 1

/**
 * The device pixel ratio, updated when it changes: browser zoom, or the window moving to a
 * monitor with other scaling. Without `matchMedia` (tests) it is read once.
 */
export function useDevicePixelRatio(): number {
  const [ratio, setRatio] = useState(currentRatio)
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return
    // A query for the current ratio stops matching as soon as the ratio changes.
    const query = window.matchMedia(`(resolution: ${ratio}dppx)`)
    const update = () => setRatio(currentRatio())
    query.addEventListener?.('change', update)
    return () => query.removeEventListener?.('change', update)
  }, [ratio])
  return ratio
}
