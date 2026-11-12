/**
 * Control status as reported by the Rust control runtime (`src-tauri/src/control/status.rs`).
 *
 * Read-only: the UI displays these values and sends operator requests; the backend supervisor
 * decides. Dry run is the only operating mode, and a message is never reported as delivered.
 */

export type ControlStateCode = 'disabled' | 'armed' | 'active' | 'fault'
export type RuntimeCode = 'running' | 'stopped' | 'unavailable'
export type ModeCode = 'dryRun'
export type GameCode = 'ets2' | 'ats'

export type FreshnessCode =
  'fresh' | 'noFrame' | 'invalid' | 'stale' | 'paused' | 'simulationStalled' | 'settling'

export type SafetyEventCode =
  | 'telemetryUnavailable'
  | 'paused'
  | 'staleTelemetry'
  | 'simulationStalled'
  | 'notSettled'
  | 'invalidVehicleState'
  | 'epochChanged'
  | 'sessionChanged'
  | 'gameChanged'
  | 'speedCapExceeded'
  | 'supervisorTimeout'
  | 'senderTiming'
  | 'invalidControlRequest'

export interface SafetyEvent {
  code: SafetyEventCode
  ageMs?: number
  stalledMs?: number
  reason?: string
  armed?: number | GameCode
  current?: number | GameCode
  speedMps?: number
  capMps?: number
  silentMs?: number
  gapMs?: number
}

export type ManualReasonCode =
  'manualArm' | 'manualActivate' | 'manualDisarm' | 'faultReset' | 'shutdown'

export type Reason = { code: ManualReasonCode } | { code: 'safety'; event: SafetyEvent }

export type RejectionCode =
  | 'notReady'
  | 'speedCapExceeded'
  | 'alreadyArmed'
  | 'notArmed'
  | 'faultNotReset'
  | 'notInFault'
  | 'safety'

export interface Rejection {
  code: RejectionCode
  freshness?: FreshnessCode
  speedMps?: number
  capMps?: number
  event?: SafetyEvent
}

export type WithheldCode = 'outputNotPermitted' | 'nonFiniteRequest' | 'outOfLimits'

export interface Withheld {
  code: WithheldCode
  state?: ControlStateCode
  field?: 'steering' | 'throttle' | 'brake'
}

export type VerdictCode = 'onTime' | 'late' | 'deadlinesMissed' | 'gapViolation'

export type TickOutcome =
  { code: 'idle' | 'commandEncoded' | 'disarmEncoded' } | { code: 'withheld'; reason: Withheld }

export interface Tick {
  sequence: number
  atMs: number
  verdict: VerdictCode
  latenessMs: number
  gapMs: number | null
  missed: number
  outcome: TickOutcome
}

export interface ControlValues {
  steering: number | null
  throttle: number
  brake: number
}

/** One encoded message. `delivery` can only be `notTransmitted`: dry run sends nothing. */
export interface EncodedMessage {
  kind: 'command' | 'disarm'
  generated: boolean
  encoded: boolean
  delivery: 'notTransmitted'
  bytesHex: string
  requested: ControlValues | null
  bounded: ControlValues | null
  adjustments: {
    limited: boolean
    brakeOverrodeThrottle: boolean
    steeringRateLimited: boolean
  }
}

export type DecisionEventCode =
  | 'transition'
  | 'epoch'
  | 'frameInvalid'
  | 'withheld'
  | 'commandRejected'
  | 'watchdogTripped'
  | 'feedLost'
  | 'feedRestored'
  | 'shutdown'

export type DiscontinuityCode =
  | 'firstFrame'
  | 'sessionChanged'
  | 'gameChanged'
  | 'paused'
  | 'gap'
  | 'simulationTimeRestarted'
  | 'backlog'
  | 'invalidFrame'

export type OperatorCommand = 'arm' | 'activate' | 'disarm' | 'resetFault'

/** A log entry. Fields beyond the common ones depend on `event`. */
export interface LogEntry {
  n: number
  atMs: number
  category: 'decision' | 'timing' | 'message'
  event: DecisionEventCode | 'late' | 'deadlinesMissed' | 'gapViolation' | 'message'
  from?: ControlStateCode
  to?: ControlStateCode
  reason?: Reason | Withheld | string
  epoch?: number
  cause?: DiscontinuityCode
  command?: OperatorCommand
  rejection?: Rejection
  silentMs?: number
  disarm?: 'notRequired' | 'encodedNotTransmitted'
  message?: EncodedMessage
}

export interface ControlStatus {
  runtime: RuntimeCode
  mode: ModeCode
  state: ControlStateCode
  permitsOutput: boolean
  /** Time since the control runtime started; every `atMs` uses the same origin. */
  nowMs: number
  telemetry: {
    feedConnected: boolean
    freshness: FreshnessCode
    invalidReason: string | null
    frameAgeMs: number | null
    epoch: number
    game: GameCode | null
    speedMps: number | null
  }
  lastTransition: {
    from: ControlStateCode
    to: ControlStateCode
    reason: Reason
    atMs: number
  } | null
  lastSafetyEvent: (SafetyEvent & { atMs: number }) | null
  lastTick: Tick | null
  lastMessage: (EncodedMessage & { atMs: number }) | null
  watchdog: {
    tripPending: boolean
    trips: number
    lastTripAtMs: number | null
    lastSilentMs: number | null
    loopSilentMs: number
    timeoutMs: number
  }
  counters: {
    ticks: number
    framesAccepted: number
    framesRejected: number
    framesInvalid: number
    commandsEncoded: number
    disarmsEncoded: number
  }
  /** Newest first. */
  recentDecisions: LogEntry[]
}

export type CommandOutcome = 'accepted' | 'rejected' | 'pending' | 'unavailable'

export interface CommandReply {
  command: OperatorCommand
  outcome: CommandOutcome
  rejection: Rejection | null
  state: ControlStateCode | null
}
