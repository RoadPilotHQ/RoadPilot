import { describe, expect, it } from 'vitest'
import { DEFAULT_GPU_BUDGET_BYTES, GpuBufferCache, tileKey } from './gpuBufferCache'

const entry = (key: string, bytes: number) => ({ key, bytes })

function cache(budget: number) {
  const released: string[] = []
  const c = new GpuBufferCache<{ key: string; bytes: number }>(budget, (e) => released.push(e.key))
  return { c, released }
}

describe('tileKey', () => {
  it('separates content id, level and tile', () => {
    const keys = new Set([
      tileKey('a', 0, 1, 2),
      tileKey('b', 0, 1, 2),
      tileKey('a', 1, 1, 2),
      tileKey('a', 0, 2, 1),
      tileKey('a', 0, -1, 2),
      tileKey('a', 0, 12, 3),
      tileKey('a', 0, 1, 23),
    ])
    expect(keys.size).toBe(7)
  })
})

describe('GpuBufferCache', () => {
  it('defaults to 64 MiB', () => {
    expect(DEFAULT_GPU_BUDGET_BYTES).toBe(64 * 1024 * 1024)
  })

  it('counts bytes and evicts the least recently used invisible entries first', () => {
    const { c, released } = cache(300)
    c.put(entry('a', 100))
    c.put(entry('b', 100))
    c.put(entry('c', 100))
    c.get('a') // a is now the most recently used
    c.put(entry('d', 100))
    c.setVisible(['d'])
    expect(c.bytes).toBe(400)
    expect(c.evict()).toBe(1)
    expect(released).toEqual(['b'])
    expect(c.bytes).toBe(300)
    expect(c.has('a') && c.has('c') && c.has('d')).toBe(true)
  })

  it('never evicts visible entries and reports the budget overrun', () => {
    const { c, released } = cache(150)
    c.put(entry('a', 100))
    c.put(entry('b', 100))
    c.put(entry('old', 10))
    c.setVisible(['a', 'b'])
    c.evict()
    expect(released).toEqual(['old'])
    expect(c.size).toBe(2)
    expect(c.overBudget).toBe(true)
    // A second call terminates and changes nothing.
    expect(c.evict()).toBe(0)
    expect(c.size).toBe(2)
  })

  it('does nothing within budget', () => {
    const { c, released } = cache(1000)
    c.put(entry('a', 100))
    expect(c.evict()).toBe(0)
    expect(released).toEqual([])
    expect(c.overBudget).toBe(false)
  })

  it('replacing an entry releases the old one and keeps the byte count right', () => {
    const { c, released } = cache(1000)
    c.put(entry('a', 100))
    c.put(entry('a', 40))
    expect(released).toEqual(['a'])
    expect(c.bytes).toBe(40)
    expect(c.size).toBe(1)
  })

  it('clear releases everything; forget releases nothing', () => {
    const { c, released } = cache(1000)
    c.put(entry('a', 1))
    c.put(entry('b', 2))
    c.clear()
    expect(released).toEqual(['a', 'b'])
    expect(c.bytes).toBe(0)
    c.put(entry('c', 3))
    c.forget()
    expect(released).toEqual(['a', 'b'])
    expect(c.size).toBe(0)
    expect(c.bytes).toBe(0)
  })

  it('a zero budget keeps only visible entries', () => {
    const { c } = cache(0)
    c.put(entry('a', 5))
    c.put(entry('b', 5))
    c.setVisible(['b'])
    c.evict()
    expect([...c.values()].map((e) => e.key)).toEqual(['b'])
  })
})
