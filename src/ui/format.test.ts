import { describe, expect, it } from 'vitest'
import { clampPercent, formatDuration } from './format'

describe('format', () => {
  it('splits minutes into hours and minutes', () => {
    expect(formatDuration(552)).toEqual({ hours: 9, minutes: 12 })
    expect(formatDuration(-5)).toEqual({ hours: 0, minutes: 0 })
  })

  it('clamps percentages', () => {
    expect(clampPercent(140)).toBe(100)
    expect(clampPercent(-3)).toBe(0)
    expect(clampPercent(Number.NaN)).toBe(0)
  })
})
