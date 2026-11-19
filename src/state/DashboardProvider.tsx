import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from 'react'
import { offlineDemoSource, type DashboardSource } from '@/backend/dashboardSource'
import type {
  AssistanceSystem,
  AutopilotFeature,
  DashboardSnapshot,
  DrivingDistance,
  Preferences,
  UnitPreference,
} from '@/domain/types'
import type { PathTrace } from '@/domain/path'
import { createPathStore } from './pathStore'
import { loadPreferences, savePreferences } from './preferences'

const PathContext = createContext<PathTrace | null>(null)

/** The truck's traveled path in the current game (see `domain/path.ts`). */
export function usePathTrace(): PathTrace {
  const trace = useContext(PathContext)
  if (!trace) throw new Error('usePathTrace must be used inside <DashboardProvider>')
  return trace
}

interface DashboardContextValue {
  snapshot: DashboardSnapshot
  preferences: Preferences
  setAutopilotFeature: (feature: AutopilotFeature, enabled: boolean) => void
  setAssistanceSystem: (system: AssistanceSystem, enabled: boolean) => void
  setDrivingDistance: (distance: DrivingDistance) => void
  setUnits: (units: UnitPreference) => void
}

const DashboardContext = createContext<DashboardContextValue | null>(null)

export function DashboardProvider({
  source = offlineDemoSource,
  children,
}: {
  source?: DashboardSource
  children: ReactNode
}) {
  const snapshot = useSyncExternalStore(source.subscribe, source.getSnapshot)
  const [preferences, setPreferences] = useState(() => loadPreferences())
  // The traveled path is recorded from every snapshot of this source, whatever is on screen.
  const pathStore = useMemo(() => createPathStore(source), [source])
  useEffect(() => pathStore.attach(), [pathStore])
  const path = useSyncExternalStore(pathStore.subscribe, pathStore.getTrace)

  const update = useCallback((change: (prev: Preferences) => Preferences) => {
    setPreferences((prev) => {
      const next = change(prev)
      savePreferences(next)
      return next
    })
  }, [])

  const value = useMemo<DashboardContextValue>(
    () => ({
      snapshot,
      preferences,
      setAutopilotFeature: (feature, enabled) =>
        update((p) => ({ ...p, autopilot: { ...p.autopilot, [feature]: enabled } })),
      setAssistanceSystem: (system, enabled) =>
        update((p) => ({ ...p, assistance: { ...p.assistance, [system]: enabled } })),
      setDrivingDistance: (drivingDistance) => update((p) => ({ ...p, drivingDistance })),
      setUnits: (units) => update((p) => ({ ...p, units })),
    }),
    [snapshot, preferences, update],
  )

  return (
    <DashboardContext.Provider value={value}>
      <PathContext.Provider value={path}>{children}</PathContext.Provider>
    </DashboardContext.Provider>
  )
}

export function useDashboard(): DashboardContextValue {
  const ctx = useContext(DashboardContext)
  if (!ctx) throw new Error('useDashboard must be used inside <DashboardProvider>')
  return ctx
}
