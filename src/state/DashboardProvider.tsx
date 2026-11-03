import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react'
import { offlineDemoSource, type DashboardSource } from '@/backend/dashboardSource'
import type {
  AssistanceSystem,
  AutopilotFeature,
  DashboardSnapshot,
  DrivingDistance,
  Preferences,
} from '@/domain/types'
import { loadPreferences, savePreferences } from './preferences'

interface DashboardContextValue {
  snapshot: DashboardSnapshot
  preferences: Preferences
  setAutopilotFeature: (feature: AutopilotFeature, enabled: boolean) => void
  setAssistanceSystem: (system: AssistanceSystem, enabled: boolean) => void
  setDrivingDistance: (distance: DrivingDistance) => void
}

const DashboardContext = createContext<DashboardContextValue | null>(null)

export function DashboardProvider({
  source = offlineDemoSource,
  children,
}: {
  source?: DashboardSource
  children: ReactNode
}) {
  const [snapshot] = useState(() => source.getSnapshot())
  const [preferences, setPreferences] = useState(() => loadPreferences())

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
    }),
    [snapshot, preferences, update],
  )

  return <DashboardContext.Provider value={value}>{children}</DashboardContext.Provider>
}

export function useDashboard(): DashboardContextValue {
  const ctx = useContext(DashboardContext)
  if (!ctx) throw new Error('useDashboard must be used inside <DashboardProvider>')
  return ctx
}
