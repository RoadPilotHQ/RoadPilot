import { describe, expect, it } from 'vitest'
import { createMapSource } from '@/backend/mapSource'
import { fakeMapBridge } from '@/test/fakeMap'
import { encodeTile, GOLDEN_REQUEST } from '@/test/tileFixtures'
import { TileStore, type TileTarget } from './mapTiles'

const flush = () => new Promise((r) => setTimeout(r, 0))

/** A map source whose backend answers every tile request with a synthetic tile. */
function setup(answer?: (x: number, z: number, contentId: string) => Promise<unknown>) {
  const fake = fakeMapBridge()
  const requests: string[] = []
  fake.bridge.tile = async (_game, contentId, level, x, z) => {
    requests.push(`${contentId}/${level}/${x}/${z}`)
    if (answer) return answer(x, z, contentId)
    return encodeTile({ ...GOLDEN_REQUEST, contentId, level, x, z }, [
      {
        points: [
          [x * 1024 + 10, z * 1024 + 10],
          [x * 1024 + 20, z * 1024 + 10],
        ],
      },
    ])
  }
  return { source: createMapSource(fake.bridge), requests }
}

const target = (
  tiles: { x: number; z: number }[],
  contentId = GOLDEN_REQUEST.contentId,
): TileTarget => ({
  game: 'ets2',
  contentId,
  level: 0,
  tileSize: 1024,
  tiles,
})

describe('TileStore', () => {
  it('loads the requested tiles and serves repeats from the cache', async () => {
    const { source, requests } = setup()
    const store = new TileStore(source)
    const t = target([
      { x: 0, z: 0 },
      { x: 1, z: 0 },
    ])
    store.request(t)
    expect(store.view(t).loading).toBe(2)
    await flush()
    expect(store.view(t).tiles).toHaveLength(2)
    store.request(t)
    store.request(t)
    expect(requests).toHaveLength(2)
  })

  it('never shows tiles of another package', async () => {
    const { source } = setup()
    const store = new TileStore(source)
    store.request(target([{ x: 0, z: 0 }]))
    await flush()
    const other = target([{ x: 0, z: 0 }], 'cba63760bde5b3a1')
    expect(store.view(other).tiles).toHaveLength(0)
    store.request(other)
    expect(store.view(target([{ x: 0, z: 0 }])).tiles).toHaveLength(0)
  })

  it('ignores a response for an earlier package', async () => {
    let release: (v: unknown) => void = () => {}
    const { source } = setup(
      (x, z, contentId) =>
        new Promise((r) => {
          release = () =>
            r(
              encodeTile({ ...GOLDEN_REQUEST, contentId, x, z }, [
                {
                  points: [
                    [x * 1024, z * 1024],
                    [x * 1024 + 5, z * 1024],
                  ],
                },
              ]),
            )
        }),
    )
    const store = new TileStore(source)
    store.request(target([{ x: 0, z: 0 }]))
    store.reset()
    release(null)
    await flush()
    expect(store.view(target([{ x: 0, z: 0 }])).tiles).toHaveLength(0)
  })

  it('counts failed and malformed tiles without drawing them', async () => {
    const { source } = setup(async (x) =>
      x === 0 ? Promise.reject('not_ready') : new ArrayBuffer(8),
    )
    const store = new TileStore(source)
    const t = target([
      { x: 0, z: 0 },
      { x: 1, z: 0 },
    ])
    store.request(t)
    await flush()
    expect(store.view(t)).toMatchObject({ tiles: [], failed: 2, loading: 0 })
  })

  it('evicts the least recently used tiles beyond its budget', async () => {
    const { source } = setup()
    const one = encodeTile({ ...GOLDEN_REQUEST, x: 0, z: 0 }, [
      {
        points: [
          [10, 10],
          [20, 10],
        ],
      },
    ]).byteLength
    const store = new TileStore(source, one * 2)
    for (const x of [0, 1, 2]) {
      store.request(target([{ x, z: 0 }]))
      await flush()
    }
    expect(store.heldBytes()).toBeLessThanOrEqual(one * 2)
    expect(store.view(target([{ x: 0, z: 0 }])).loading).toBe(1)
    expect(store.view(target([{ x: 2, z: 0 }])).tiles).toHaveLength(1)
  })

  it('marks truncated tiles', async () => {
    const { source } = setup(async (x, z, contentId) =>
      encodeTile(
        { ...GOLDEN_REQUEST, contentId, x, z },
        [
          {
            points: [
              [x * 1024, z * 1024],
              [x * 1024 + 1, z * 1024],
            ],
          },
        ],
        true,
      ),
    )
    const store = new TileStore(source)
    const t = target([{ x: 0, z: 0 }])
    store.request(t)
    await flush()
    expect(store.view(t).truncated).toBe(true)
  })
})
