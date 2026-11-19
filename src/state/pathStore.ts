import type { DashboardSource } from '@/backend/dashboardSource'
import { addToTrace, EMPTY_TRACE, type PathTrace } from '@/domain/path'

/**
 * Records the traveled path from every snapshot of a dashboard source, independent of what
 * is on screen. Compatible with `useSyncExternalStore`.
 */
export interface PathStore {
  getTrace(): PathTrace
  subscribe(listener: () => void): () => void
  /** Starts following the source; returns the function that stops it. */
  attach(): () => void
}

export function createPathStore(
  source: DashboardSource,
  now: () => number = () => Date.now(),
): PathStore {
  let trace = EMPTY_TRACE
  const listeners = new Set<() => void>()
  const record = () => {
    const next = addToTrace(trace, source.getSnapshot(), now())
    if (next === trace) return
    trace = next
    listeners.forEach((l) => l())
  }
  return {
    getTrace: () => trace,
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    attach() {
      record()
      return source.subscribe(record)
    },
  }
}
