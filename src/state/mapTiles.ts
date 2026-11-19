import { useEffect, useMemo, useSyncExternalStore } from 'react'
import type { MapSource, TileFailure } from '@/backend/mapSource'
import type { MapTile } from '@/domain/mapTile'
import type { TileId } from '@/domain/mapViewport'
import type { GameId } from '@/domain/types'
import { useMap } from './MapProvider'

/** Decoded tiles kept in the WebView. */
export const TILE_CACHE_BYTES = 48 * 1024 * 1024
/** Requests are bundled: view changes within this time join one request round. */
export const TILE_REQUEST_DELAY_MS = 40

type Entry =
  | { state: 'loading' }
  | { state: 'ready'; tile: MapTile }
  | { state: 'failed'; failure: TileFailure }

export interface TileView {
  tiles: MapTile[]
  loading: number
  failed: number
  truncated: boolean
}

export interface TileTarget {
  game: GameId
  contentId: string
  level: number
  tileSize: number
  tiles: readonly TileId[]
}

const keyOf = (contentId: string, level: number, t: TileId) => `${contentId}/${level}/${t.x}/${t.z}`

/**
 * Decoded tiles of one package, least recently used first out, bounded by bytes. A different
 * content id clears everything, and a response for an earlier package is ignored, so tiles of
 * another package (or the other game) can never be drawn.
 */
export class TileStore {
  private cache = new Map<string, Entry>()
  private bytes = 0
  private contentId: string | null = null
  private version = 0
  private listeners = new Set<() => void>()
  private readonly source: MapSource
  private readonly budget: number

  constructor(source: MapSource, budget = TILE_CACHE_BYTES) {
    this.source = source
    this.budget = budget
  }

  subscribe = (listener: () => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  getVersion = () => this.version

  private notify() {
    this.version++
    this.listeners.forEach((l) => l())
  }

  /** Drops everything, for example when the map is released. */
  reset() {
    if (this.contentId === null && this.cache.size === 0) return
    this.cache = new Map()
    this.bytes = 0
    this.contentId = null
    this.notify()
  }

  /** Requests the tiles of `target` that are not cached or on their way. */
  request(target: TileTarget) {
    if (this.contentId !== target.contentId) {
      this.cache = new Map()
      this.bytes = 0
      this.contentId = target.contentId
    }
    const { game, contentId, level, tileSize } = target
    for (const t of target.tiles) {
      const key = keyOf(contentId, level, t)
      const entry = this.cache.get(key)
      if (entry) {
        // Recently used: to the end of the eviction order.
        this.cache.delete(key)
        this.cache.set(key, entry)
        continue
      }
      this.cache.set(key, { state: 'loading' })
      void this.source.fetchTile(game, { contentId, level, x: t.x, z: t.z, tileSize }).then((r) => {
        // Obsolete: the package changed while this tile was on its way.
        if (this.contentId !== contentId || !this.cache.has(key)) return
        if ('tile' in r) {
          this.cache.set(key, { state: 'ready', tile: r.tile })
          this.bytes += r.tile.byteLength
          this.evict(key)
        } else {
          this.cache.set(key, { state: 'failed', failure: r.failure })
        }
        this.notify()
      })
    }
  }

  private evict(keep: string) {
    for (const [key, entry] of this.cache) {
      if (this.bytes <= this.budget) return
      if (key === keep || entry.state !== 'ready') continue
      this.cache.delete(key)
      this.bytes -= entry.tile.byteLength
    }
  }

  /** The cached part of `target`; reading only. */
  view(target: TileTarget | null): TileView {
    const view: TileView = { tiles: [], loading: 0, failed: 0, truncated: false }
    if (!target) return view
    for (const t of target.tiles) {
      const entry =
        this.contentId === target.contentId
          ? this.cache.get(keyOf(target.contentId, target.level, t))
          : undefined
      if (!entry || entry.state === 'loading') view.loading++
      else if (entry.state === 'failed') view.failed++
      else {
        view.tiles.push(entry.tile)
        view.truncated ||= entry.tile.truncated
      }
    }
    return view
  }

  /** Bytes of decoded tiles held (tests and diagnostics). */
  heldBytes() {
    return this.bytes
  }
}

const tileListKey = (tiles: readonly TileId[]) => tiles.map((t) => `${t.x},${t.z}`).join(';')
const parseTileList = (key: string): TileId[] =>
  key === ''
    ? []
    : key.split(';').map((p) => {
        const [x, z] = p.split(',').map(Number)
        return { x: x!, z: z! }
      })

/** The tiles of the current view, loaded through a `TileStore` of the map source. */
export function useMapTiles(target: TileTarget | null): TileView {
  const { source } = useMap()
  const store = useMemo(() => new TileStore(source), [source])
  useSyncExternalStore(store.subscribe, store.getVersion)
  const game = target?.game
  const contentId = target?.contentId
  const level = target?.level
  const tileSize = target?.tileSize
  const list = target ? tileListKey(target.tiles) : ''

  useEffect(() => {
    if (!game || !contentId || level === undefined || tileSize === undefined) {
      store.reset()
      return
    }
    const timer = setTimeout(
      () => store.request({ game, contentId, level, tileSize, tiles: parseTileList(list) }),
      TILE_REQUEST_DELAY_MS,
    )
    return () => clearTimeout(timer)
  }, [store, game, contentId, level, tileSize, list])

  return store.view(target)
}
