import { describe, expect, it } from 'vitest'
import { fitCanvas } from './canvasSize'

/** A canvas that counts assignments; each one reallocates the real backing store. */
function countingCanvas() {
  const assigned: string[] = []
  let width = 300
  let height = 150
  const el = {
    get width() {
      return width
    },
    set width(v: number) {
      assigned.push(`width=${v}`)
      width = v
    },
    get height() {
      return height
    },
    set height(v: number) {
      assigned.push(`height=${v}`)
      height = v
    },
  } as unknown as HTMLCanvasElement
  return { el, assigned }
}

describe('fitCanvas', () => {
  it('sizes the backing store for the pixel ratio', () => {
    const { el } = countingCanvas()
    expect(fitCanvas(el, 400, 300, 1.5)).toBe(true)
    expect([el.width, el.height]).toEqual([600, 450])
  })

  it('leaves the backing store alone when its size is unchanged', () => {
    const { el, assigned } = countingCanvas()
    fitCanvas(el, 400, 300, 1)
    assigned.length = 0
    expect(fitCanvas(el, 400, 300, 1)).toBe(false)
    expect(assigned).toEqual([])
  })

  it('resizes when the pixel ratio changes', () => {
    const { el } = countingCanvas()
    fitCanvas(el, 400, 300, 1)
    expect(fitCanvas(el, 400, 300, 2)).toBe(true)
    expect([el.width, el.height]).toEqual([800, 600])
  })

  it('never gives an empty backing store', () => {
    const { el } = countingCanvas()
    fitCanvas(el, 0, 0, 1)
    expect([el.width, el.height]).toEqual([1, 1])
  })
})
