import { invoke, isTauri } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { parseMapStatus, type MapStatus } from '@/domain/map'
import { decodeTile, type MapTile, type TileRequest } from '@/domain/mapTile'
import type { GameId } from '@/domain/types'

/** Names shared with `src-tauri/src/map/mod.rs`. */
export const MAP_STATUS_EVENT = 'map:status'
export const MAP_COMMANDS = {
  select: 'map_select',
  status: 'map_status',
  tile: 'map_tile',
} as const

/** The Tauri functions the map source needs; injectable for tests. */
export interface MapBridge {
  listen(handler: (status: unknown) => void): Promise<() => void>
  getStatus(): Promise<unknown>
  select(game: GameId | null, path: string | null, reload: boolean): Promise<unknown>
  /** Raw tile bytes (`map_tile` answers with binary data, not JSON). */
  tile(game: GameId, contentId: string, level: number, x: number, z: number): Promise<unknown>
}

const tauriBridge: MapBridge = {
  listen: (handler) => listen<unknown>(MAP_STATUS_EVENT, (e) => handler(e.payload)),
  getStatus: () => invoke<unknown>(MAP_COMMANDS.status),
  select: (game, path, reload) => invoke<unknown>(MAP_COMMANDS.select, { game, path, reload }),
  tile: (game, contentId, level, x, z) =>
    invoke<unknown>(MAP_COMMANDS.tile, { game, contentId, level, x, z }),
}

export interface MapSnapshot {
  /** `false` outside the desktop app: there is no backend that can read packages. */
  available: boolean
  /** `null` until the backend has reported anything. */
  status: MapStatus | null
  /** A synthetic test map (development only); always labelled as such. */
  synthetic?: boolean
}

/** Why a tile is not available. */
export type TileFailure =
  'not_ready' | 'wrong_map' | 'invalid_request' | 'malformed' | 'unavailable'

export type TileResult = { tile: MapTile } | { failure: TileFailure }

export interface MapSource {
  getSnapshot(): MapSnapshot
  subscribe(listener: () => void): () => void
  /** Selects the package folder for a game; `null` releases the map. Never throws. */
  select(game: GameId | null, path: string | null, reload?: boolean): Promise<void>
  /** One tile of the loaded map, checked against the request. Never throws. */
  fetchTile(game: GameId, request: TileRequest): Promise<TileResult>
  dispose(): void
}

const FAILURES: readonly TileFailure[] = ['not_ready', 'wrong_map', 'invalid_request']

export function createMapSource(bridge: MapBridge = tauriBridge): MapSource {
  let snapshot: MapSnapshot = { available: true, status: null }
  let disposed = false
  let unlisten: (() => void) | null = null
  const listeners = new Set<() => void>()

  // Status updates may arrive out of order (event and command reply); the newest revision wins.
  const apply = (raw: unknown) => {
    if (disposed) return
    const status = parseMapStatus(raw)
    if (!status) return
    if (snapshot.status && status.revision < snapshot.status.revision) return
    snapshot = { ...snapshot, status }
    listeners.forEach((l) => l())
  }

  bridge
    .listen(apply)
    .then((stop) => {
      if (disposed) stop()
      else unlisten = stop
    })
    .catch(() => {})
  bridge
    .getStatus()
    .then(apply)
    .catch(() => {})

  return {
    getSnapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    async select(game, path, reload = false) {
      try {
        apply(await bridge.select(game, path, reload))
      } catch {
        // The backend refused the request (for example, an unknown game); the status stays.
      }
    },
    async fetchTile(game, request) {
      try {
        const raw = await bridge.tile(game, request.contentId, request.level, request.x, request.z)
        const buffer = raw instanceof Uint8Array ? raw.slice().buffer : raw
        const tile = buffer instanceof ArrayBuffer ? decodeTile(buffer, request) : null
        return tile ? { tile } : { failure: 'malformed' }
      } catch (error) {
        const code = FAILURES.find((f) => f === error)
        return { failure: code ?? 'unavailable' }
      }
    },
    dispose() {
      disposed = true
      listeners.clear()
      unlisten?.()
      unlisten = null
    },
  }
}

/** Outside the desktop app (browser, tests): no map can be loaded. */
export const unavailableMapSource: MapSource = {
  getSnapshot: () => UNAVAILABLE,
  subscribe: () => () => {},
  select: async () => {},
  fetchTile: async () => ({ failure: 'unavailable' }),
  dispose: () => {},
}
const UNAVAILABLE: MapSnapshot = { available: false, status: null }

export function createDefaultMapSource(): MapSource {
  return isTauri() ? createMapSource() : unavailableMapSource
}
