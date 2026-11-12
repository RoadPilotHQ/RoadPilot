import { createContext, useContext, useMemo, useSyncExternalStore, type ReactNode } from 'react'
import {
  unavailableControlSource,
  type ControlSnapshot,
  type ControlSource,
} from '@/backend/controlSource'
import type { CommandReply, OperatorCommand } from '@/domain/control'

interface ControlContextValue {
  snapshot: ControlSnapshot
  request: (command: OperatorCommand) => Promise<CommandReply>
}

const ControlContext = createContext<ControlContextValue | null>(null)

export function ControlProvider({
  source = unavailableControlSource,
  children,
}: {
  source?: ControlSource
  children: ReactNode
}) {
  const snapshot = useSyncExternalStore(source.subscribe, source.getSnapshot)
  const value = useMemo<ControlContextValue>(
    () => ({ snapshot, request: (command) => source.request(command) }),
    [snapshot, source],
  )
  return <ControlContext.Provider value={value}>{children}</ControlContext.Provider>
}

export function useControl(): ControlContextValue {
  const ctx = useContext(ControlContext)
  if (!ctx) throw new Error('useControl must be used inside <ControlProvider>')
  return ctx
}
