import { invoke, isTauri } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import type { CommandReply, ControlStatus, OperatorCommand } from '@/domain/control'

/** Names shared with `src-tauri/src/control_app.rs`. */
export const CONTROL_STATUS_EVENT = 'control:status'
export const CONTROL_COMMANDS = {
  status: 'control_status',
  log: 'control_log',
  arm: 'control_arm',
  activate: 'control_activate',
  disarm: 'control_disarm',
  resetFault: 'control_reset_fault',
} as const

/** The Tauri functions this source needs; injectable for tests. */
export interface ControlBridge {
  listen(handler: (status: ControlStatus) => void): Promise<() => void>
  getStatus(): Promise<ControlStatus>
  send(command: OperatorCommand): Promise<CommandReply>
}

const tauriBridge: ControlBridge = {
  listen: (handler) => listen<ControlStatus>(CONTROL_STATUS_EVENT, (e) => handler(e.payload)),
  getStatus: () => invoke<ControlStatus>(CONTROL_COMMANDS.status),
  send: (command) => invoke<CommandReply>(CONTROL_COMMANDS[command]),
}

export interface ControlSnapshot {
  /** `null` until the backend has reported anything, and outside the desktop app. */
  status: ControlStatus | null
  /** The answer to the most recent operator request. */
  lastReply: CommandReply | null
  /** A request that has not been answered yet. */
  pending: OperatorCommand | null
}

export interface ControlSource {
  getSnapshot(): ControlSnapshot
  subscribe(listener: () => void): () => void
  /**
   * Sends an operator request. Never throws and never refuses locally: the backend
   * supervisor decides. A disarm is sent even while another request is pending.
   */
  request(command: OperatorCommand): Promise<CommandReply>
  dispose(): void
}

const unavailableReply = (command: OperatorCommand): CommandReply => ({
  command,
  outcome: 'unavailable',
  rejection: null,
  state: null,
})

export function createControlSource(bridge: ControlBridge = tauriBridge): ControlSource {
  let snapshot: ControlSnapshot = { status: null, lastReply: null, pending: null }
  let disposed = false
  let unlisten: (() => void) | null = null
  const listeners = new Set<() => void>()

  const set = (next: Partial<ControlSnapshot>) => {
    if (disposed) return
    snapshot = { ...snapshot, ...next }
    listeners.forEach((listener) => listener())
  }

  const applyStatus = (status: ControlStatus) => {
    // Ignore a status older than the one shown (an initial snapshot that arrives late).
    const shown = snapshot.status
    if (shown && shown.runtime === status.runtime && status.nowMs < shown.nowMs) return
    set({ status })
  }

  bridge
    .listen(applyStatus)
    .then((stop) => {
      if (disposed) stop()
      else unlisten = stop
    })
    .catch(() => {})

  bridge
    .getStatus()
    .then(applyStatus)
    .catch(() => {})

  return {
    getSnapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    async request(command) {
      set({ pending: command })
      let reply: CommandReply
      try {
        reply = await bridge.send(command)
      } catch {
        reply = unavailableReply(command)
      }
      set({
        lastReply: reply,
        pending: snapshot.pending === command ? null : snapshot.pending,
      })
      return reply
    },
    dispose() {
      disposed = true
      listeners.clear()
      unlisten?.()
      unlisten = null
    },
  }
}

/** Outside the desktop app there is no control runtime; every request is unavailable. */
export const unavailableControlSource: ControlSource = {
  getSnapshot: (() => {
    const snapshot: ControlSnapshot = { status: null, lastReply: null, pending: null }
    return () => snapshot
  })(),
  subscribe: () => () => {},
  request: (command) => Promise.resolve(unavailableReply(command)),
  dispose: () => {},
}

export function createDefaultControlSource(): ControlSource {
  return isTauri() ? createControlSource() : unavailableControlSource
}
