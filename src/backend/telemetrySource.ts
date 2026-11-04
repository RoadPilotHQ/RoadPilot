import { invoke, isTauri } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import type { TelemetryUpdate } from '@/domain/telemetry'
import type { DashboardSnapshot } from '@/domain/types'
import { offlineDemoSource, snapshotFromTelemetry, type DashboardSource } from './dashboardSource'

/** Names shared with `src-tauri/src/lib.rs`. */
export const TELEMETRY_EVENT = 'telemetry:update'
export const TELEMETRY_SNAPSHOT_COMMAND = 'telemetry_snapshot'

/** The Tauri functions this source needs; injectable for tests. */
export interface TelemetryBridge {
  listen(event: string, handler: (payload: TelemetryUpdate) => void): Promise<() => void>
  getSnapshot(): Promise<TelemetryUpdate>
}

const tauriBridge: TelemetryBridge = {
  listen: (event, handler) => listen<TelemetryUpdate>(event, (e) => handler(e.payload)),
  getSnapshot: () => invoke<TelemetryUpdate>(TELEMETRY_SNAPSHOT_COMMAND),
}

export interface TelemetrySource extends DashboardSource {
  /** Stops listening for backend events. */
  dispose(): void
}

/**
 * Dashboard source backed by the Rust telemetry engine. Until the first backend state
 * arrives, it shows demo data with a disconnected status.
 */
export function createTelemetrySource(bridge: TelemetryBridge = tauriBridge): TelemetrySource {
  let snapshot: DashboardSnapshot = snapshotFromTelemetry(null)
  let receivedEvent = false
  let disposed = false
  let unlisten: (() => void) | null = null
  const listeners = new Set<() => void>()

  const apply = (update: TelemetryUpdate) => {
    if (disposed) return
    snapshot = snapshotFromTelemetry(update)
    listeners.forEach((listener) => listener())
  }

  bridge
    .listen(TELEMETRY_EVENT, (update) => {
      receivedEvent = true
      apply(update)
    })
    .then((stop) => {
      if (disposed) stop()
      else unlisten = stop
    })
    .catch(() => {
      // No backend events: the dashboard stays in labelled demo mode.
    })

  bridge
    .getSnapshot()
    .then((update) => {
      // An event that already arrived is newer than this initial snapshot.
      if (!receivedEvent) apply(update)
    })
    .catch(() => {})

  return {
    getSnapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    dispose() {
      disposed = true
      listeners.clear()
      unlisten?.()
      unlisten = null
    },
  }
}

/** Live telemetry inside the desktop app, static demo data in a plain browser. */
export function createDefaultSource(): DashboardSource {
  return isTauri() ? createTelemetrySource() : offlineDemoSource
}
