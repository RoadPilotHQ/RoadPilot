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
  | 'handoffOverflow'

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
  timing: ControlTiming
  /** Telemetry latency diagnosis (R6). Shadow mode: shown, never used for a decision. */
  latency: ControlLatency
}

export type LatencyClassCode = 'normal' | 'delayed' | 'critical' | 'unusable'

/** One latency measure: class of the newest sample, counts since start, degraded episode. */
export interface LatencyMeasure {
  class: LatencyClassCode | null
  lastMs: number | null
  normal: number
  delayed: number
  critical: number
  unusable: number
  degraded: boolean
  degradedEpisodes: number
}

export interface ControlLatency {
  shadowMode: boolean
  processing: LatencyMeasure
  transport: LatencyMeasure
  ageAtReceive: LatencyMeasure
  ageAtDecision: LatencyMeasure
}

/** One timing distribution in milliseconds; `over40`, `over45` and `over50` are exact counts. */
export interface TimingHistogram {
  count: number
  meanMs: number
  p50Ms: number
  p95Ms: number
  p99Ms: number
  p999Ms: number
  maxMs: number
  over40: number
  over45: number
  over50: number
}

/** Tick timing since the control runtime started. A command interval is between two encoded
 * commands; an encoded command is not a delivered one. */
export interface ControlTiming {
  timer: 'tokio' | 'precise'
  elevatedPriority: boolean
  ticks: number
  intervals: TimingHistogram
  lateness: TimingHistogram
  processing: TimingHistogram
  commandIntervals: TimingHistogram
  missedDeadlines: number
  lateTicks: number
  gapViolations: number
  watchdogTrips: number
}

export type CommandOutcome = 'accepted' | 'rejected' | 'pending' | 'unavailable'

export interface CommandReply {
  command: OperatorCommand
  outcome: CommandOutcome
  rejection: Rejection | null
  state: ControlStateCode | null
}
