import type { MapBridge } from '@/backend/mapSource'
import type { MapStatus } from '@/domain/map'
import type { GameId } from '@/domain/types'

/** A synthetic map backend: records selections and answers with test statuses. */
export function fakeMapBridge(answer?: (game: GameId | null, path: string | null) => MapStatus) {
  let handler: ((s: unknown) => void) | null = null
  let revision = 0
  const selections: { game: GameId | null; path: string | null; reload: boolean }[] = []
  const status = (overrides: Partial<MapStatus>): MapStatus => ({
    state: 'none',
    game: null,
    packageGame: null,
    phase: null,
    contentId: null,
    schema: null,
    counts: null,
    bounds: null,
    error: null,
    loadMs: null,
    tileSizes: null,
    skippedRoads: null,
    revision: ++revision,
    ...overrides,
  })
  const bridge: MapBridge = {
    listen: async (h) => {
      handler = h
      return () => {}
    },
    getStatus: async () => status({}),
    tile: async () => {
      throw 'not_ready'
    },
    select: async (game, path, reload) => {
      selections.push({ game, path, reload })
      if (answer) return { ...answer(game, path), revision: ++revision }
      return status({ state: path ? 'selecting' : 'none', game })
    },
  }
  return {
    bridge,
    selections,
    status,
    /** Pushes a status as the backend's `map:status` event would. */
    emit: (s: Partial<MapStatus>) => handler?.(status(s)),
    /** Pushes a status exactly as given, including its revision. */
    emitRaw: (s: unknown) => handler?.(s),
  }
}

export const READY_ATS: Partial<MapStatus> = {
  state: 'ready',
  game: 'ats',
  packageGame: 'ats',
  contentId: 'cba63760bde5b3a1',
  schema: '1.0',
  counts: { nodes: 902347, roads: 224870, junctions: 84855 },
  bounds: [-119599, -72101, 40644, 75090],
  loadMs: 5300,
  tileSizes: [1024, 4096, 16384, 65536],
}
