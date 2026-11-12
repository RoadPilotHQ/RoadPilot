import { act } from '@testing-library/react'
import type { ControlBridge } from '@/backend/controlSource'
import type {
  CommandReply,
  ControlStatus,
  OperatorCommand,
  TimingHistogram,
} from '@/domain/control'

/** A narrow distribution around `centerMs`. */
export function histogram(centerMs: number): TimingHistogram {
  return {
    count: 249,
    meanMs: centerMs,
    p50Ms: centerMs,
    p95Ms: centerMs + 0.3,
    p99Ms: centerMs + 0.5,
    p999Ms: centerMs + 0.6,
    maxMs: centerMs + 0.7,
    over40: 0,
    over45: 0,
    over50: 0,
  }
}

/** A running, disabled, dry-run status with fresh ETS2 telemetry. */
export function controlStatus(overrides: Partial<ControlStatus> = {}): ControlStatus {
  return {
    runtime: 'running',
    mode: 'dryRun',
    state: 'disabled',
    permitsOutput: false,
    nowMs: 10_000,
    telemetry: {
      feedConnected: true,
      freshness: 'fresh',
      invalidReason: null,
      frameAgeMs: 12,
      epoch: 1,
      game: 'ets2',
      speedMps: 3,
    },
    lastTransition: null,
    lastSafetyEvent: null,
    lastTick: {
      sequence: 250,
      atMs: 9_990,
      verdict: 'onTime',
      latenessMs: 0.4,
      gapMs: 40,
      missed: 0,
      outcome: { code: 'idle' },
    },
    lastMessage: null,
    watchdog: {
      tripPending: false,
      trips: 0,
      lastTripAtMs: null,
      lastSilentMs: null,
      loopSilentMs: 12,
      timeoutMs: 100,
    },
    counters: {
      ticks: 250,
      framesAccepted: 600,
      framesRejected: 0,
      framesInvalid: 0,
      commandsEncoded: 0,
      disarmsEncoded: 0,
    },
    recentDecisions: [],
    timing: {
      timer: 'precise',
      elevatedPriority: true,
      ticks: 250,
      intervals: histogram(40.0),
      lateness: histogram(0.3),
      processing: histogram(0.1),
      commandIntervals: histogram(40.0),
      missedDeadlines: 0,
      lateTicks: 0,
      gapViolations: 0,
      watchdogTrips: 0,
    },
    ...overrides,
  }
}

export const accepted = (command: OperatorCommand, state: CommandReply['state']): CommandReply => ({
  command,
  outcome: 'accepted',
  rejection: null,
  state,
})

/** A control bridge driven by the test instead of the Rust backend. */
export function fakeControlBridge() {
  let handler: ((status: ControlStatus) => void) | null = null
  const sent: OperatorCommand[] = []
  let answer: (command: OperatorCommand) => Promise<CommandReply> = (command) =>
    Promise.resolve(accepted(command, 'disabled'))
  const bridge: ControlBridge = {
    listen: async (h) => {
      handler = h
      return () => {
        handler = null
      }
    },
    getStatus: () => new Promise(() => {}),
    send: (command) => {
      sent.push(command)
      return answer(command)
    },
  }
  return {
    bridge,
    sent,
    answerWith(fn: (command: OperatorCommand) => Promise<CommandReply>) {
      answer = fn
    },
    async push(status: ControlStatus) {
      await act(async () => {
        await Promise.resolve()
        handler?.(status)
      })
    },
    get listening() {
      return handler !== null
    },
  }
}
