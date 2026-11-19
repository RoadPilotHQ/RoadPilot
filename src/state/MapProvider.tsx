import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useSyncExternalStore,
  type ReactNode,
} from 'react'
import { unavailableMapSource, type MapSnapshot, type MapSource } from '@/backend/mapSource'
import type { GameId } from '@/domain/types'
import { useDashboard } from './DashboardProvider'

interface MapContextValue {
  map: MapSnapshot
  /** The game whose map is shown: the connected game, otherwise the last one chosen. */
  game: GameId
  /** Whether `game` comes from telemetry (then the user cannot switch it). */
  gameFromTelemetry: boolean
  /** The package folder configured for `game`. */
  folder: string | null
  /** Loads the configured package again, for example after regenerating it. */
  reload: () => void
  source: MapSource
}

const MapContext = createContext<MapContextValue | null>(null)

/**
 * Keeps the backend map in step with the game: whenever the game or its configured folder
 * changes, the backend releases the previous map and loads the new one (or none).
 */
export function MapProvider({
  source = unavailableMapSource,
  children,
}: {
  source?: MapSource
  children: ReactNode
}) {
  const map = useSyncExternalStore(source.subscribe, source.getSnapshot)
  const { snapshot, preferences, setMapGame } = useDashboard()
  const game: GameId = snapshot.game ?? preferences.mapGame
  const folder = preferences.mapPackages[game]

  // Remember the connected game, so its map stays on screen after the game exits.
  useEffect(() => {
    if (snapshot.game) setMapGame(snapshot.game)
  }, [snapshot.game, setMapGame])

  useEffect(() => {
    void source.select(game, folder)
  }, [source, game, folder])

  const value = useMemo<MapContextValue>(
    () => ({
      map,
      game,
      gameFromTelemetry: snapshot.game !== null,
      folder,
      reload: () => void source.select(game, folder, true),
      source,
    }),
    [map, game, snapshot.game, folder, source],
  )
  return <MapContext.Provider value={value}>{children}</MapContext.Provider>
}

export function useMap(): MapContextValue {
  const ctx = useContext(MapContext)
  if (!ctx) throw new Error('useMap must be used inside <MapProvider>')
  return ctx
}
