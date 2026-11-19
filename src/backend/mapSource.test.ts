import { describe, expect, it } from 'vitest'
import { parseMapStatus } from '@/domain/map'
import { fakeMapBridge, READY_ATS } from '@/test/fakeMap'
import { createMapSource, unavailableMapSource } from './mapSource'

const flush = () => new Promise((r) => setTimeout(r, 0))

describe('map source', () => {
  it('is unavailable outside the desktop app', async () => {
    expect(unavailableMapSource.getSnapshot()).toEqual({ available: false, status: null })
    await expect(unavailableMapSource.select('ats', 'C:\\maps')).resolves.toBeUndefined()
  })

  it('forwards selections and applies the reply', async () => {
    const fake = fakeMapBridge()
    const source = createMapSource(fake.bridge)
    await flush()
    await source.select('ats', 'C:\\maps\\ats')
    expect(fake.selections).toEqual([{ game: 'ats', path: 'C:\\maps\\ats', reload: false }])
    expect(source.getSnapshot().status?.state).toBe('selecting')
    await source.select('ats', 'C:\\maps\\ats', true)
    expect(fake.selections[1]!.reload).toBe(true)
  })

  it('keeps the newest status when updates arrive out of order', async () => {
    const fake = fakeMapBridge()
    const source = createMapSource(fake.bridge)
    await flush()
    fake.emitRaw(fake.status({ ...READY_ATS, revision: 10 }))
    // An older revision (for example, a late command reply) is ignored.
    fake.emitRaw(fake.status({ state: 'loading', game: 'ats', revision: 9 }))
    expect(source.getSnapshot().status?.state).toBe('ready')
    fake.emitRaw(fake.status({ state: 'none', game: 'ets2', revision: 11 }))
    expect(source.getSnapshot().status?.state).toBe('none')
  })

  it('ignores malformed statuses', async () => {
    const fake = fakeMapBridge()
    const source = createMapSource(fake.bridge)
    await flush()
    fake.emit({ state: 'flying' as never })
    expect(source.getSnapshot().status?.state).toBe('none')
  })
})

describe('parseMapStatus', () => {
  const base = { state: 'none', revision: 1 }

  it('accepts a complete ready status', () => {
    const s = parseMapStatus({ ...READY_ATS, revision: 4 })
    expect(s?.state).toBe('ready')
    expect(s?.bounds).toEqual([-119599, -72101, 40644, 75090])
  })

  it('rejects a ready status without content id, bounds or game', () => {
    expect(parseMapStatus({ ...READY_ATS, revision: 1, contentId: null })).toBeNull()
    expect(parseMapStatus({ ...READY_ATS, revision: 1, bounds: [0, 0, Number.NaN, 1] })).toBeNull()
    expect(parseMapStatus({ ...READY_ATS, revision: 1, game: 'ets3' })).toBeNull()
  })

  it('rejects unknown states and missing revisions', () => {
    expect(parseMapStatus({ state: 'flying', revision: 1 })).toBeNull()
    expect(parseMapStatus({ state: 'none' })).toBeNull()
    expect(parseMapStatus(null)).toBeNull()
  })

  it('drops malformed optional parts instead of trusting them', () => {
    const s = parseMapStatus({ ...base, contentId: 'XYZ', counts: { roads: 'many' } })
    expect(s?.contentId).toBeNull()
    expect(s?.counts).toBeNull()
  })
})
