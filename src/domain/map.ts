/**
 * Road map status (event `map:status`, command `map_status`). Mirrors
 * `src-tauri/src/map/status.rs`; see docs/map.md.
 *
 * The map is for display only. It is drawn in its own coordinates; telemetry positions are
 * never placed on it in this phase.
 */
import type { GameId } from './types'

export const MAP_STATES = [
  'none',
  'selecting',
  'loading',
  'ready',
  'error',
  'game_mismatch',
  'unsupported_version',
] as const
export type MapState = (typeof MAP_STATES)[number]

export type MapLoadPhase = 'manifest' | 'reading' | 'preparing'

export type MapErrorCode =
  | 'not_found'
  | 'unreadable'
  | 'not_a_package'
  | 'invalid_manifest'
  | 'file_mismatch'
  | 'corrupt_geometry'
  | 'inconsistent'
  | 'unusable'

export interface MapStatus {
  state: MapState
  /** The game the map was requested for. */
  game: GameId | null
  /** The game named by the package manifest. */
  packageGame: string | null
  phase: MapLoadPhase | null
  /** Package content id, 16 hexadecimal digits. */
  contentId: string | null
  schema: string | null
  counts: { nodes: number; roads: number; junctions: number } | null
  /** `[minX, minZ, maxX, maxZ]` in map world units (unit unconfirmed). */
  bounds: [number, number, number, number] | null
  error: { code: MapErrorCode | string; detail: string } | null
  loadMs: number | null
  revision: number
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null
const isGame = (v: unknown): v is GameId => v === 'ets2' || v === 'ats'
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
const strOrNull = (v: unknown) => (typeof v === 'string' ? v : null)

/**
 * Checks a status from the backend. Anything malformed is rejected as a whole (`null`), so a
 * defect can never show a map that is not there.
 */
export function parseMapStatus(raw: unknown): MapStatus | null {
  if (!isObject(raw)) return null
  const state = MAP_STATES.find((s) => s === raw.state)
  if (!state || !finite(raw.revision)) return null
  const bounds =
    Array.isArray(raw.bounds) && raw.bounds.length === 4 && raw.bounds.every(finite)
      ? (raw.bounds as [number, number, number, number])
      : null
  const c = raw.counts
  const counts =
    isObject(c) && finite(c.nodes) && finite(c.roads) && finite(c.junctions)
      ? { nodes: c.nodes, roads: c.roads, junctions: c.junctions }
      : null
  const e = raw.error
  const error =
    isObject(e) && typeof e.code === 'string' && typeof e.detail === 'string'
      ? { code: e.code, detail: e.detail }
      : null
  const contentId =
    typeof raw.contentId === 'string' && /^[0-9a-f]{16}$/.test(raw.contentId) ? raw.contentId : null
  if (state === 'ready' && (!contentId || !bounds || !isGame(raw.game))) return null
  return {
    state,
    game: isGame(raw.game) ? raw.game : null,
    packageGame: strOrNull(raw.packageGame),
    phase:
      raw.phase === 'manifest' || raw.phase === 'reading' || raw.phase === 'preparing'
        ? raw.phase
        : null,
    contentId,
    schema: strOrNull(raw.schema),
    counts,
    bounds,
    error,
    loadMs: finite(raw.loadMs) ? raw.loadMs : null,
    revision: raw.revision,
  }
}
