import { describe, expect, it } from 'vitest'
import { encodeTile, GOLDEN_REQUEST, GOLDEN_TILE_HEX, hexToBuffer } from '@/test/tileFixtures'
import { decodeTile, MAX_TILE_POINTS, ROAD_FLAG_CHORD, ROAD_FLAG_ESTIMATED } from './mapTile'

const golden = () => hexToBuffer(GOLDEN_TILE_HEX)

/** Changes one byte range of the golden tile. */
function patched(at: number, write: (v: DataView) => void): ArrayBuffer {
  const b = golden()
  write(new DataView(b, at))
  return b
}

describe('decodeTile', () => {
  it('reads the golden tile produced by the Rust encoder', () => {
    const tile = decodeTile(golden(), GOLDEN_REQUEST)!
    expect(tile).not.toBeNull()
    expect(tile.originX).toBe(1024)
    expect(tile.originZ).toBe(-1024)
    expect(tile.truncated).toBe(false)
    expect(tile.contentId).toBe('20ae70ba19c404c8')
    expect(tile.roads).toEqual([
      { index: 1, first: 0, count: 2, roadClass: 'motorway', flags: ROAD_FLAG_ESTIMATED },
      { index: 0, first: 2, count: 2, roadClass: 'local', flags: ROAD_FLAG_CHORD },
    ])
    // Relative points plus the origin give the original world coordinates.
    const world = Array.from(tile.points, (v, i) => v + (i % 2 === 0 ? 1024 : -1024))
    expect(world).toEqual([1050, -1000, 1050, -800, 1100, -900, 1300, -900])
  })

  it('round-trips synthetic tiles, empty and truncated ones included', () => {
    const empty = decodeTile(encodeTile(GOLDEN_REQUEST, []), GOLDEN_REQUEST)!
    expect(empty.roads).toEqual([])
    expect(empty.points.length).toBe(0)
    const truncated = encodeTile(
      GOLDEN_REQUEST,
      [
        {
          points: [
            [1030, -1000],
            [1040, -990],
          ],
        },
      ],
      true,
    )
    expect(decodeTile(truncated, GOLDEN_REQUEST)!.truncated).toBe(true)
  })

  it('accepts the largest tile the backend sends', () => {
    const roads = Array.from({ length: MAX_TILE_POINTS / 4 }, (_, i) => ({
      points: Array.from(
        { length: 4 },
        (_, k) => [1024 + (i % 1000), -1024 + k] as [number, number],
      ),
    }))
    const tile = decodeTile(encodeTile(GOLDEN_REQUEST, roads), GOLDEN_REQUEST)!
    expect(tile.points.length).toBe(MAX_TILE_POINTS * 2)
  })

  it('rejects a tile other than the one requested', () => {
    for (const other of [
      { ...GOLDEN_REQUEST, x: 2 },
      { ...GOLDEN_REQUEST, z: 0 },
      { ...GOLDEN_REQUEST, level: 1 },
      { ...GOLDEN_REQUEST, tileSize: 4096 },
      { ...GOLDEN_REQUEST, contentId: 'cba63760bde5b3a1' },
    ])
      expect(decodeTile(golden(), other)).toBeNull()
  })

  it('rejects malformed tiles', () => {
    const cases: [string, ArrayBuffer][] = [
      ['too short', golden().slice(0, 40)],
      ['missing bytes', golden().slice(0, golden().byteLength - 4)],
      ['extra bytes', encodeTile(GOLDEN_REQUEST, []).slice(0, 56)], // valid empty, baseline
      ['magic', patched(0, (v) => v.setUint8(0, 0x58))],
      ['version', patched(4, (v) => v.setUint16(0, 2, true))],
      ['unknown header flag', patched(7, (v) => v.setUint8(0, 2))],
      ['origin', patched(24, (v) => v.setFloat64(0, 0, true))],
      ['road count', patched(40, (v) => v.setUint32(0, 3, true))],
      ['huge road count', patched(40, (v) => v.setUint32(0, 0xffffffff, true))],
      ['point count', patched(44, (v) => v.setUint32(0, 5, true))],
      ['roads not back to back', patched(56 + 12 + 4, (v) => v.setUint32(0, 1, true))],
      ['road of one point', patched(56 + 8, (v) => v.setUint16(0, 1, true))],
      ['unknown class', patched(56 + 10, (v) => v.setUint8(0, 9))],
      ['unknown road flag', patched(56 + 11, (v) => v.setUint8(0, 8))],
      ['NaN point', patched(80, (v) => v.setFloat32(0, Number.NaN, true))],
      ['infinite point', patched(84, (v) => v.setFloat32(0, Number.POSITIVE_INFINITY, true))],
    ]
    for (const [name, buffer] of cases) {
      const result = decodeTile(buffer, GOLDEN_REQUEST)
      if (name === 'extra bytes') expect(result, name).not.toBeNull()
      else expect(result, name).toBeNull()
    }
    const padded = new Uint8Array(golden().byteLength + 8)
    padded.set(new Uint8Array(golden()))
    expect(decodeTile(padded.buffer, GOLDEN_REQUEST)).toBeNull()
    expect(decodeTile('RPMT' as unknown as ArrayBuffer, GOLDEN_REQUEST)).toBeNull()
  })
})
