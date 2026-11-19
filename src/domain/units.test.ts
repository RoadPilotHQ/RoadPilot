import { describe, expect, it } from 'vitest'
import {
  consumption,
  distance,
  pressure,
  resolveUnitSystem,
  speed,
  temperature,
  volume,
} from './units'

const close = (actual: number, expected: number) => expect(actual).toBeCloseTo(expected, 3)

describe('resolveUnitSystem', () => {
  it('follows the game automatically', () => {
    expect(resolveUnitSystem('auto', 'ats')).toBe('imperial')
    expect(resolveUnitSystem('auto', 'ets2')).toBe('metric')
    expect(resolveUnitSystem('auto', null)).toBe('metric')
  })

  it('keeps an explicit choice for both games', () => {
    expect(resolveUnitSystem('metric', 'ats')).toBe('metric')
    expect(resolveUnitSystem('imperial', 'ets2')).toBe('imperial')
  })
})

describe('conversions', () => {
  it('leaves metric values unchanged', () => {
    expect(speed(88, 'metric')).toEqual({ value: 88, unit: 'unit.kmh' })
    expect(distance(12.5, 'metric')).toEqual({ value: 12.5, unit: 'unit.km' })
    expect(volume(400, 'metric')).toEqual({ value: 400, unit: 'unit.litre' })
    expect(consumption(33, 'metric')).toEqual({ value: 33, unit: 'unit.lPer100km' })
    expect(temperature(90, 'metric')).toEqual({ value: 90, unit: 'unit.celsius' })
  })

  it('converts to US customary units', () => {
    close(speed(100, 'imperial').value, 62.137)
    expect(speed(100, 'imperial').unit).toBe('unit.mph')
    close(speed(-16.09344, 'imperial').value, -10)
    close(distance(160.9344, 'imperial').value, 100)
    close(volume(3.785411784, 'imperial').value, 1)
    expect(volume(1, 'imperial').unit).toBe('unit.gallon')
    close(consumption(23.5214583, 'imperial')!.value, 10)
    close(temperature(100, 'imperial').value, 212)
    close(temperature(-40, 'imperial').value, -40)
  })

  it('has no mpg value for zero consumption', () => {
    expect(consumption(0, 'imperial')).toBeNull()
    expect(consumption(0, 'metric')).toEqual({ value: 0, unit: 'unit.lPer100km' })
  })

  it('shows pressures in bar (metric) and psi (imperial)', () => {
    close(pressure(120, 'metric').value, 8.274)
    expect(pressure(120, 'metric').unit).toBe('unit.bar')
    expect(pressure(120, 'imperial')).toEqual({ value: 120, unit: 'unit.psi' })
  })
})
