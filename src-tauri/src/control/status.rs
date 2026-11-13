//! Read-only status and log views for the application and its UI.
//!
//! Everything here is a serializable copy of internal state with stable camelCase codes, so the
//! frontend can localize it. Nothing here is ever read back by the control code: the UI is
//! never the safety authority.
//!
//! Every mapping is an exhaustive `match` without wildcards, so adding a state, a safety event
//! or a log event elsewhere fails to compile until its display form is defined here.
//!
//! Delivery is reported as `notTransmitted`, the only value [`Delivery`] can hold; there is no
//! way for this module to say that a message reached the game.

use super::command::{Adjustments, CommandError, ControlRequest, Field, Withheld};
use super::freshness::{Assessment, Discontinuity, Unusable};
use super::log::{
    Bounded, DecisionEvent, DisarmStatus, Entry, LogSnapshot, MessageKind, MessageRecord,
    TimingEvent,
};
use super::schedule::{Timing, Verdict};
use super::sender::{CoreStats, TickOutcome};
use super::sink::{Delivery, OperatingMode};
use super::supervisor::{Command, Reason, Rejection, SafetyEvent, State, Transition};
use super::timing::{Histogram, TimerKind, TimingStats};
use super::vehicle::InvalidFrame;
use roadpilot_telemetry_client::GameId;
use serde::Serialize;
use std::time::{Duration, Instant};

/// Number of recent decisions included in every status snapshot.
pub const RECENT_DECISIONS: usize = 8;
/// Upper bound for one log request.
pub const MAX_LOG_ENTRIES: usize = 200;

fn millis(d: Duration) -> u64 {
    u64::try_from(d.as_millis()).unwrap_or(u64::MAX)
}

/// Fractional milliseconds, for timing values below one millisecond.
fn millis_f64(d: Duration) -> f64 {
    d.as_secs_f64() * 1_000.0
}

// ---- codes ----

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum RuntimeCode {
    Running,
    /// The control task ended (shutdown or failure).
    Stopped,
    /// The control runtime could not be started.
    Unavailable,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ModeCode {
    DryRun,
}

impl From<OperatingMode> for ModeCode {
    fn from(mode: OperatingMode) -> Self {
        match mode {
            OperatingMode::DryRun => ModeCode::DryRun,
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum StateCode {
    Disabled,
    Armed,
    Active,
    Fault,
}

impl From<State> for StateCode {
    fn from(state: State) -> Self {
        match state {
            State::Disabled => StateCode::Disabled,
            State::Armed => StateCode::Armed,
            State::Active => StateCode::Active,
            State::Fault => StateCode::Fault,
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum GameCode {
    Ets2,
    Ats,
}

impl From<GameId> for GameCode {
    fn from(game: GameId) -> Self {
        match game {
            GameId::Ets2 => GameCode::Ets2,
            GameId::Ats => GameCode::Ats,
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum DeliveryCode {
    NotTransmitted,
}

impl From<Delivery> for DeliveryCode {
    fn from(delivery: Delivery) -> Self {
        match delivery {
            Delivery::NotTransmitted => DeliveryCode::NotTransmitted,
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum CommandCode {
    Arm,
    Activate,
    Disarm,
    ResetFault,
}

impl From<Command> for CommandCode {
    fn from(command: Command) -> Self {
        match command {
            Command::Arm => CommandCode::Arm,
            Command::Activate => CommandCode::Activate,
            Command::Disarm => CommandCode::Disarm,
            Command::ResetFault => CommandCode::ResetFault,
        }
    }
}

/// A frame rejection reason as a stable code, e.g. `missingField:truck.speedMps`.
pub fn invalid_frame_code(reason: InvalidFrame) -> String {
    match reason {
        InvalidFrame::UnsupportedSchema(v) => format!("unsupportedSchema:{v}"),
        InvalidFrame::MissingSession => "missingSession".into(),
        InvalidFrame::MissingSimulationTime => "missingSimulationTime".into(),
        InvalidFrame::NotRunning => "notRunning".into(),
        InvalidFrame::MissingField(path) => format!("missingField:{path}"),
        InvalidFrame::NonFiniteValue(path) => format!("nonFiniteValue:{path}"),
    }
}

// ---- safety events, reasons, rejections ----

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(
    tag = "code",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum SafetyEventDto {
    TelemetryUnavailable,
    Paused,
    StaleTelemetry { age_ms: u64 },
    SimulationStalled { stalled_ms: u64 },
    NotSettled,
    InvalidVehicleState { reason: String },
    EpochChanged { armed: u64, current: u64 },
    SessionChanged { armed: u64, current: u64 },
    GameChanged { armed: GameCode, current: GameCode },
    SpeedCapExceeded { speed_mps: f32, cap_mps: f32 },
    SupervisorTimeout { silent_ms: u64 },
    SenderTiming { gap_ms: u64 },
    InvalidControlRequest,
}

impl From<SafetyEvent> for SafetyEventDto {
    fn from(event: SafetyEvent) -> Self {
        match event {
            SafetyEvent::TelemetryUnavailable => Self::TelemetryUnavailable,
            SafetyEvent::Paused => Self::Paused,
            SafetyEvent::StaleTelemetry { age } => Self::StaleTelemetry {
                age_ms: millis(age),
            },
            SafetyEvent::SimulationStalled { stalled_for } => Self::SimulationStalled {
                stalled_ms: millis(stalled_for),
            },
            SafetyEvent::NotSettled => Self::NotSettled,
            SafetyEvent::InvalidVehicleState(reason) => Self::InvalidVehicleState {
                reason: invalid_frame_code(reason),
            },
            SafetyEvent::EpochChanged { armed, current } => Self::EpochChanged { armed, current },
            SafetyEvent::SessionChanged { armed, current } => {
                Self::SessionChanged { armed, current }
            }
            SafetyEvent::GameChanged { armed, current } => Self::GameChanged {
                armed: armed.into(),
                current: current.into(),
            },
            SafetyEvent::SpeedCapExceeded { speed_mps, cap_mps } => {
                Self::SpeedCapExceeded { speed_mps, cap_mps }
            }
            SafetyEvent::SupervisorTimeout { silent_for } => Self::SupervisorTimeout {
                silent_ms: millis(silent_for),
            },
            SafetyEvent::SenderTiming { gap } => Self::SenderTiming {
                gap_ms: millis(gap),
            },
            SafetyEvent::InvalidControlRequest => Self::InvalidControlRequest,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(
    tag = "code",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum ReasonDto {
    ManualArm,
    ManualActivate,
    ManualDisarm,
    FaultReset,
    Shutdown,
    Safety { event: SafetyEventDto },
}

impl From<Reason> for ReasonDto {
    fn from(reason: Reason) -> Self {
        match reason {
            Reason::ManualArm => Self::ManualArm,
            Reason::ManualActivate => Self::ManualActivate,
            Reason::ManualDisarm => Self::ManualDisarm,
            Reason::FaultReset => Self::FaultReset,
            Reason::Shutdown => Self::Shutdown,
            Reason::Safety(event) => Self::Safety {
                event: event.into(),
            },
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum FreshnessCode {
    Fresh,
    NoFrame,
    Invalid,
    Stale,
    Paused,
    SimulationStalled,
    Settling,
}

/// The display code of an assessment and, for an invalid frame, its reason.
pub fn freshness(assessment: &Assessment) -> (FreshnessCode, Option<String>) {
    match assessment {
        Assessment::Usable(_) => (FreshnessCode::Fresh, None),
        Assessment::Unusable(u) => match *u {
            Unusable::NoFrame => (FreshnessCode::NoFrame, None),
            Unusable::Invalid(reason) => (FreshnessCode::Invalid, Some(invalid_frame_code(reason))),
            Unusable::Stale { .. } => (FreshnessCode::Stale, None),
            Unusable::Paused => (FreshnessCode::Paused, None),
            Unusable::SimulationStalled { .. } => (FreshnessCode::SimulationStalled, None),
            Unusable::Settling => (FreshnessCode::Settling, None),
        },
    }
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(
    tag = "code",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum RejectionDto {
    NotReady { freshness: FreshnessCode },
    SpeedCapExceeded { speed_mps: f32, cap_mps: f32 },
    AlreadyArmed,
    NotArmed,
    FaultNotReset,
    NotInFault,
    Safety { event: SafetyEventDto },
}

impl From<Rejection> for RejectionDto {
    fn from(rejection: Rejection) -> Self {
        match rejection {
            Rejection::NotReady(u) => Self::NotReady {
                freshness: freshness(&Assessment::Unusable(u)).0,
            },
            Rejection::SpeedCapExceeded { speed_mps, cap_mps } => {
                Self::SpeedCapExceeded { speed_mps, cap_mps }
            }
            Rejection::AlreadyArmed => Self::AlreadyArmed,
            Rejection::NotArmed => Self::NotArmed,
            Rejection::FaultNotReset => Self::FaultNotReset,
            Rejection::NotInFault => Self::NotInFault,
            Rejection::Safety(event) => Self::Safety {
                event: event.into(),
            },
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum FieldCode {
    Steering,
    Throttle,
    Brake,
}

impl From<Field> for FieldCode {
    fn from(field: Field) -> Self {
        match field {
            Field::Steering => Self::Steering,
            Field::Throttle => Self::Throttle,
            Field::Brake => Self::Brake,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(
    tag = "code",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum WithheldDto {
    OutputNotPermitted { state: StateCode },
    NonFiniteRequest { field: FieldCode },
    OutOfLimits { field: FieldCode },
}

impl From<Withheld> for WithheldDto {
    fn from(reason: Withheld) -> Self {
        match reason {
            Withheld::OutputNotPermitted(state) => Self::OutputNotPermitted {
                state: state.into(),
            },
            Withheld::InvalidRequest(CommandError::NonFinite(field)) => Self::NonFiniteRequest {
                field: field.into(),
            },
            Withheld::InvalidRequest(CommandError::OutOfLimits { field, .. }) => {
                Self::OutOfLimits {
                    field: field.into(),
                }
            }
        }
    }
}

// ---- status ----

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TelemetryStatus {
    /// Whether control has a frame channel to read.
    pub feed_connected: bool,
    pub freshness: FreshnessCode,
    /// Why the newest frame was refused, as a code.
    pub invalid_reason: Option<String>,
    /// Local time since the newest accepted frame.
    pub frame_age_ms: Option<u64>,
    pub epoch: u64,
    /// Only while the state is usable.
    pub game: Option<GameCode>,
    pub speed_mps: Option<f32>,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TransitionDto {
    pub from: StateCode,
    pub to: StateCode,
    pub reason: ReasonDto,
    pub at_ms: u64,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SafetyEventStatus {
    #[serde(flatten)]
    pub event: SafetyEventDto,
    pub at_ms: u64,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum VerdictCode {
    OnTime,
    Late,
    DeadlinesMissed,
    GapViolation,
}

impl From<Verdict> for VerdictCode {
    fn from(verdict: Verdict) -> Self {
        match verdict {
            Verdict::OnTime => Self::OnTime,
            Verdict::Late => Self::Late,
            Verdict::DeadlinesMissed => Self::DeadlinesMissed,
            Verdict::GapViolation => Self::GapViolation,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(
    tag = "code",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum TickOutcomeDto {
    Idle,
    CommandEncoded,
    DisarmEncoded,
    Withheld { reason: WithheldDto },
}

impl From<TickOutcome> for TickOutcomeDto {
    fn from(outcome: TickOutcome) -> Self {
        match outcome {
            TickOutcome::Idle => Self::Idle,
            TickOutcome::CommandEncoded => Self::CommandEncoded,
            TickOutcome::DisarmEncoded => Self::DisarmEncoded,
            TickOutcome::Withheld(reason) => Self::Withheld {
                reason: reason.into(),
            },
        }
    }
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TickDto {
    pub sequence: u64,
    pub at_ms: u64,
    pub verdict: VerdictCode,
    pub lateness_ms: f64,
    pub gap_ms: Option<f64>,
    pub missed: u32,
    pub outcome: TickOutcomeDto,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WatchdogDto {
    /// A trip the control loop has not consumed yet.
    pub trip_pending: bool,
    /// Trips the control loop has consumed (each one disarmed or faulted control).
    pub trips: u64,
    pub last_trip_at_ms: Option<u64>,
    pub last_silent_ms: Option<u64>,
    /// Time since the control loop last updated the supervisor. The application refreshes
    /// this independently of the loop when it serves a status request.
    pub loop_silent_ms: u64,
    pub timeout_ms: u64,
}

#[derive(Clone, Copy, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RequestDto {
    pub steering: Option<f32>,
    pub throttle: f32,
    pub brake: f32,
}

impl From<ControlRequest> for RequestDto {
    fn from(r: ControlRequest) -> Self {
        Self {
            steering: r.steering,
            throttle: r.throttle,
            brake: r.brake,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BoundedDto {
    pub steering: Option<f32>,
    pub throttle: f32,
    pub brake: f32,
}

impl From<Bounded> for BoundedDto {
    fn from(b: Bounded) -> Self {
        Self {
            steering: b.steering,
            throttle: b.throttle,
            brake: b.brake,
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AdjustmentsDto {
    pub limited: bool,
    pub brake_overrode_throttle: bool,
    pub steering_rate_limited: bool,
}

impl From<Adjustments> for AdjustmentsDto {
    fn from(a: Adjustments) -> Self {
        Self {
            limited: a.limited,
            brake_overrode_throttle: a.brake_overrode_throttle,
            steering_rate_limited: a.steering_rate_limited,
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum MessageKindCode {
    Command,
    Disarm,
}

impl From<MessageKind> for MessageKindCode {
    fn from(kind: MessageKind) -> Self {
        match kind {
            MessageKind::Command => Self::Command,
            MessageKind::Disarm => Self::Disarm,
        }
    }
}

/// One encoded message. `generated` is true for a command built from a controller request;
/// `encoded` is always true (the bytes exist); `delivery` says what happened to the bytes.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MessageDto {
    pub kind: MessageKindCode,
    pub generated: bool,
    pub encoded: bool,
    pub delivery: DeliveryCode,
    pub bytes_hex: String,
    pub requested: Option<RequestDto>,
    pub bounded: Option<BoundedDto>,
    pub adjustments: AdjustmentsDto,
}

impl From<MessageRecord> for MessageDto {
    fn from(m: MessageRecord) -> Self {
        Self {
            kind: m.kind.into(),
            generated: m.kind == MessageKind::Command,
            encoded: true,
            delivery: m.delivery.into(),
            bytes_hex: m.bytes.iter().map(|b| format!("{b:02x}")).collect(),
            requested: m.requested.map(Into::into),
            bounded: m.bounded.map(Into::into),
            adjustments: m.adjustments.into(),
        }
    }
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LastMessageDto {
    #[serde(flatten)]
    pub message: MessageDto,
    pub at_ms: u64,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CountersDto {
    pub ticks: u64,
    pub frames_accepted: u64,
    pub frames_rejected: u64,
    pub frames_invalid: u64,
    pub commands_encoded: u64,
    pub disarms_encoded: u64,
}

impl From<CoreStats> for CountersDto {
    fn from(s: CoreStats) -> Self {
        Self {
            ticks: s.ticks,
            frames_accepted: s.frames_accepted,
            frames_rejected: s.frames_rejected,
            frames_invalid: s.frames_invalid,
            commands_encoded: s.commands_encoded,
            disarms_encoded: s.disarms_encoded,
        }
    }
}

/// Everything the UI shows about control.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ControlStatus {
    pub runtime: RuntimeCode,
    pub mode: ModeCode,
    pub state: StateCode,
    pub permits_output: bool,
    /// Time since the control runtime started; all `atMs` values use the same origin.
    pub now_ms: u64,
    pub telemetry: TelemetryStatus,
    pub last_transition: Option<TransitionDto>,
    pub last_safety_event: Option<SafetyEventStatus>,
    pub last_tick: Option<TickDto>,
    pub last_message: Option<LastMessageDto>,
    pub watchdog: WatchdogDto,
    pub counters: CountersDto,
    pub recent_decisions: Vec<LogEntryDto>,
    pub timing: TimingDto,
}

impl ControlStatus {
    /// Shown when the control runtime is not running at all. Disarmed by definition.
    pub fn unavailable() -> Self {
        Self {
            runtime: RuntimeCode::Unavailable,
            mode: ModeCode::DryRun,
            state: StateCode::Disabled,
            permits_output: false,
            now_ms: 0,
            telemetry: TelemetryStatus {
                feed_connected: false,
                freshness: FreshnessCode::NoFrame,
                invalid_reason: None,
                frame_age_ms: None,
                epoch: 0,
                game: None,
                speed_mps: None,
            },
            last_transition: None,
            last_safety_event: None,
            last_tick: None,
            last_message: None,
            watchdog: WatchdogDto {
                trip_pending: false,
                trips: 0,
                last_trip_at_ms: None,
                last_silent_ms: None,
                loop_silent_ms: 0,
                timeout_ms: millis(super::watchdog::SUPERVISOR_TIMEOUT),
            },
            counters: CountersDto::from(CoreStats::default()),
            recent_decisions: Vec::new(),
            timing: TimingDto::from_stats(&TimingStats::default(), 0),
        }
    }
}

/// The internal values a status snapshot is built from (see `ControlCore::status`).
pub struct StatusInput<'a> {
    pub now: Instant,
    pub start: Instant,
    pub mode: OperatingMode,
    pub state: State,
    pub permits_output: bool,
    pub assessment: Assessment,
    pub epoch: u64,
    pub frame_age: Option<Duration>,
    pub feed_lost: bool,
    pub last_transition: Option<(Transition, Instant)>,
    pub last_safety_event: Option<(SafetyEvent, Instant)>,
    pub last_tick: Option<(Timing, TickOutcome, Instant)>,
    pub last_message: Option<(MessageRecord, Instant)>,
    pub watchdog_pending: bool,
    pub watchdog_trips: u64,
    pub last_watchdog_trip: Option<(Duration, Instant)>,
    pub loop_silent: Duration,
    pub stats: CoreStats,
    pub recent_decisions: Vec<Entry<DecisionEvent>>,
    pub timing: &'a TimingStats,
}

pub fn build(input: &StatusInput<'_>) -> ControlStatus {
    let at = |instant: Instant| millis(instant.saturating_duration_since(input.start));
    let (freshness_code, invalid_reason) = freshness(&input.assessment);
    let sample = input.assessment.usable();
    ControlStatus {
        runtime: RuntimeCode::Running,
        mode: input.mode.into(),
        state: input.state.into(),
        permits_output: input.permits_output,
        now_ms: at(input.now),
        telemetry: TelemetryStatus {
            feed_connected: !input.feed_lost,
            freshness: freshness_code,
            invalid_reason,
            frame_age_ms: input.frame_age.map(millis),
            epoch: input.epoch,
            game: sample.map(|s| s.state.identity.game.into()),
            speed_mps: sample.map(|s| s.state.speed_mps),
        },
        last_transition: input.last_transition.map(|(t, when)| TransitionDto {
            from: t.from.into(),
            to: t.to.into(),
            reason: t.reason.into(),
            at_ms: at(when),
        }),
        last_safety_event: input
            .last_safety_event
            .map(|(event, when)| SafetyEventStatus {
                event: event.into(),
                at_ms: at(when),
            }),
        last_tick: input.last_tick.map(|(timing, outcome, when)| TickDto {
            sequence: timing.sequence,
            at_ms: at(when),
            verdict: timing.verdict.into(),
            lateness_ms: millis_f64(timing.lateness),
            gap_ms: timing.gap.map(millis_f64),
            missed: timing.missed,
            outcome: outcome.into(),
        }),
        last_message: input.last_message.map(|(m, when)| LastMessageDto {
            message: m.into(),
            at_ms: at(when),
        }),
        watchdog: WatchdogDto {
            trip_pending: input.watchdog_pending,
            trips: input.watchdog_trips,
            last_trip_at_ms: input.last_watchdog_trip.map(|(_, when)| at(when)),
            last_silent_ms: input.last_watchdog_trip.map(|(silent, _)| millis(silent)),
            loop_silent_ms: millis(input.loop_silent),
            timeout_ms: millis(super::watchdog::SUPERVISOR_TIMEOUT),
        },
        counters: input.stats.into(),
        recent_decisions: input
            .recent_decisions
            .iter()
            .rev()
            .map(LogEntryDto::decision)
            .collect(),
        timing: TimingDto::from_stats(input.timing, input.watchdog_trips),
    }
}

// ---- timing ----

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum TimerCode {
    Tokio,
    Precise,
}

impl From<TimerKind> for TimerCode {
    fn from(kind: TimerKind) -> Self {
        match kind {
            TimerKind::Tokio => Self::Tokio,
            TimerKind::Precise => Self::Precise,
        }
    }
}

/// One distribution in milliseconds. `over40`, `over45` and `over50` are exact counts.
#[derive(Clone, Copy, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HistogramDto {
    pub count: u64,
    pub mean_ms: f64,
    pub p50_ms: f64,
    pub p95_ms: f64,
    pub p99_ms: f64,
    pub p999_ms: f64,
    pub max_ms: f64,
    pub over_40: u64,
    pub over_45: u64,
    pub over_50: u64,
}

impl From<&Histogram> for HistogramDto {
    fn from(h: &Histogram) -> Self {
        let s = h.summary();
        Self {
            count: s.count,
            mean_ms: s.mean_ms,
            p50_ms: s.p50_ms,
            p95_ms: s.p95_ms,
            p99_ms: s.p99_ms,
            p999_ms: s.p999_ms,
            max_ms: s.max_ms,
            over_40: s.over_40,
            over_45: s.over_45,
            over_50: s.over_50,
        }
    }
}

/// Tick timing since the control runtime started.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TimingDto {
    pub timer: TimerCode,
    /// Whether the control threads run at elevated thread priority. Set by the application.
    pub elevated_priority: bool,
    pub ticks: u64,
    /// Start of one tick to the start of the next.
    pub intervals: HistogramDto,
    /// Tick start after its scheduled deadline (scheduler wake-up).
    pub lateness: HistogramDto,
    /// Tick start to the end of its work.
    pub processing: HistogramDto,
    /// Between two consecutive ticks that both encoded a command (generated, not delivered).
    pub command_intervals: HistogramDto,
    pub missed_deadlines: u64,
    pub late_ticks: u64,
    pub gap_violations: u64,
    pub watchdog_trips: u64,
}

impl TimingDto {
    pub fn from_stats(stats: &TimingStats, watchdog_trips: u64) -> Self {
        Self {
            timer: stats.timer.into(),
            elevated_priority: false,
            ticks: stats.ticks,
            intervals: (&stats.intervals).into(),
            lateness: (&stats.lateness).into(),
            processing: (&stats.processing).into(),
            command_intervals: (&stats.command_intervals).into(),
            missed_deadlines: stats.missed_deadlines,
            late_ticks: stats.late_ticks,
            gap_violations: stats.gap_violations,
            watchdog_trips,
        }
    }
}

// ---- log ----

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum DiscontinuityCode {
    FirstFrame,
    SessionChanged,
    GameChanged,
    Paused,
    Gap,
    SimulationTimeRestarted,
    Backlog,
    InvalidFrame,
}

impl From<Discontinuity> for DiscontinuityCode {
    fn from(d: Discontinuity) -> Self {
        match d {
            Discontinuity::FirstFrame => Self::FirstFrame,
            Discontinuity::SessionChanged => Self::SessionChanged,
            Discontinuity::GameChanged => Self::GameChanged,
            Discontinuity::Paused => Self::Paused,
            Discontinuity::Gap => Self::Gap,
            Discontinuity::SimulationTimeRestarted => Self::SimulationTimeRestarted,
            Discontinuity::Backlog => Self::Backlog,
            Discontinuity::InvalidFrame => Self::InvalidFrame,
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum DisarmCode {
    NotRequired,
    EncodedNotTransmitted,
}

impl From<DisarmStatus> for DisarmCode {
    fn from(d: DisarmStatus) -> Self {
        match d {
            DisarmStatus::NotRequired => Self::NotRequired,
            DisarmStatus::EncodedNotTransmitted => Self::EncodedNotTransmitted,
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum LogCategory {
    Decision,
    Timing,
    Message,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(
    tag = "event",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum LogEventDto {
    Transition {
        from: StateCode,
        to: StateCode,
        reason: ReasonDto,
    },
    Epoch {
        epoch: u64,
        cause: DiscontinuityCode,
    },
    FrameInvalid {
        reason: String,
    },
    Withheld {
        reason: WithheldDto,
    },
    CommandRejected {
        command: CommandCode,
        rejection: RejectionDto,
    },
    WatchdogTripped {
        silent_ms: u64,
    },
    FeedLost,
    FeedRestored,
    Shutdown {
        disarm: DisarmCode,
    },
    Late {
        lateness_ms: f64,
    },
    DeadlinesMissed {
        missed: u32,
        lateness_ms: f64,
    },
    GapViolation {
        gap_ms: f64,
        missed: u32,
    },
    Message {
        message: MessageDto,
    },
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LogEntryDto {
    pub n: u64,
    pub at_ms: u64,
    pub category: LogCategory,
    #[serde(flatten)]
    pub event: LogEventDto,
}

impl LogEntryDto {
    pub fn decision(entry: &Entry<DecisionEvent>) -> Self {
        let event = match entry.event {
            DecisionEvent::Transition(t) => LogEventDto::Transition {
                from: t.from.into(),
                to: t.to.into(),
                reason: t.reason.into(),
            },
            DecisionEvent::Epoch { epoch, cause } => LogEventDto::Epoch {
                epoch,
                cause: cause.into(),
            },
            DecisionEvent::FrameInvalid(reason) => LogEventDto::FrameInvalid {
                reason: invalid_frame_code(reason),
            },
            DecisionEvent::Withheld(reason) => LogEventDto::Withheld {
                reason: reason.into(),
            },
            DecisionEvent::CommandRejected { command, rejection } => LogEventDto::CommandRejected {
                command: command.into(),
                rejection: rejection.into(),
            },
            DecisionEvent::WatchdogTripped { silent_for } => LogEventDto::WatchdogTripped {
                silent_ms: millis(silent_for),
            },
            DecisionEvent::FeedLost => LogEventDto::FeedLost,
            DecisionEvent::FeedRestored => LogEventDto::FeedRestored,
            DecisionEvent::Shutdown { disarm } => LogEventDto::Shutdown {
                disarm: disarm.into(),
            },
        };
        Self {
            n: entry.n,
            at_ms: millis(entry.at),
            category: LogCategory::Decision,
            event,
        }
    }

    pub fn timing(entry: &Entry<TimingEvent>) -> Self {
        let event = match entry.event {
            TimingEvent::Late { lateness } => LogEventDto::Late {
                lateness_ms: millis_f64(lateness),
            },
            TimingEvent::DeadlinesMissed { missed, lateness } => LogEventDto::DeadlinesMissed {
                missed,
                lateness_ms: millis_f64(lateness),
            },
            TimingEvent::GapViolation { gap, missed } => LogEventDto::GapViolation {
                gap_ms: millis_f64(gap),
                missed,
            },
        };
        Self {
            n: entry.n,
            at_ms: millis(entry.at),
            category: LogCategory::Timing,
            event,
        }
    }

    pub fn message(entry: &Entry<MessageRecord>) -> Self {
        Self {
            n: entry.n,
            at_ms: millis(entry.at),
            category: LogCategory::Message,
            event: LogEventDto::Message {
                message: entry.event.into(),
            },
        }
    }
}

/// The newest `limit` entries of all three rings, newest first. `limit` is capped at
/// [`MAX_LOG_ENTRIES`].
pub fn recent_log(snapshot: &LogSnapshot, limit: usize) -> Vec<LogEntryDto> {
    let limit = limit.min(MAX_LOG_ENTRIES);
    let mut all: Vec<LogEntryDto> = snapshot
        .decisions
        .iter()
        .map(LogEntryDto::decision)
        .chain(snapshot.timing.iter().map(LogEntryDto::timing))
        .chain(snapshot.messages.iter().map(LogEntryDto::message))
        .collect();
    all.sort_by_key(|e| std::cmp::Reverse(e.n));
    all.truncate(limit);
    all
}

#[cfg(test)]
mod tests {
    use super::super::log::ControlLog;
    use super::*;
    use serde_json::{Value, json};

    fn ms(n: u64) -> Duration {
        Duration::from_millis(n)
    }

    #[test]
    fn codes_serialize_as_stable_camel_case_strings() {
        assert_eq!(json!(StateCode::Fault), json!("fault"));
        assert_eq!(json!(ModeCode::DryRun), json!("dryRun"));
        assert_eq!(json!(RuntimeCode::Unavailable), json!("unavailable"));
        assert_eq!(json!(DeliveryCode::NotTransmitted), json!("notTransmitted"));
        assert_eq!(json!(CommandCode::ResetFault), json!("resetFault"));
        assert_eq!(json!(VerdictCode::GapViolation), json!("gapViolation"));
        assert_eq!(
            json!(FreshnessCode::SimulationStalled),
            json!("simulationStalled")
        );
    }

    #[test]
    fn safety_events_carry_their_code_and_values() {
        assert_eq!(
            json!(SafetyEventDto::from(SafetyEvent::StaleTelemetry {
                age: ms(412)
            })),
            json!({"code": "staleTelemetry", "ageMs": 412})
        );
        assert_eq!(
            json!(SafetyEventDto::from(SafetyEvent::SpeedCapExceeded {
                speed_mps: 5.5,
                cap_mps: 5.0
            })),
            json!({"code": "speedCapExceeded", "speedMps": 5.5, "capMps": 5.0})
        );
        assert_eq!(
            json!(SafetyEventDto::from(SafetyEvent::InvalidVehicleState(
                InvalidFrame::MissingField("truck.speedMps")
            ))),
            json!({"code": "invalidVehicleState", "reason": "missingField:truck.speedMps"})
        );
        assert_eq!(
            json!(ReasonDto::from(Reason::Safety(SafetyEvent::Paused))),
            json!({"code": "safety", "event": {"code": "paused"}})
        );
    }

    #[test]
    fn a_message_is_reported_as_encoded_and_not_transmitted() {
        let record = MessageRecord {
            kind: MessageKind::Command,
            bytes: [0xab; 20],
            requested: Some(ControlRequest {
                steering: Some(0.9),
                throttle: 0.2,
                brake: 0.0,
            }),
            bounded: Some(Bounded {
                steering: Some(0.15),
                throttle: 0.1,
                brake: 0.0,
            }),
            adjustments: Adjustments {
                limited: true,
                ..Adjustments::default()
            },
            delivery: Delivery::NotTransmitted,
        };
        let v = json!(MessageDto::from(record));
        assert_eq!(v["kind"], "command");
        assert_eq!(v["generated"], true);
        assert_eq!(v["encoded"], true);
        assert_eq!(v["delivery"], "notTransmitted");
        assert_eq!(v["bytesHex"], "ab".repeat(20));
        assert_eq!(v["bounded"]["throttle"].as_f64().unwrap() as f32, 0.1);
        assert_eq!(v["adjustments"]["limited"], true);
        let disarm = json!(MessageDto::from(MessageRecord {
            kind: MessageKind::Disarm,
            requested: None,
            bounded: None,
            ..record
        }));
        assert_eq!(
            disarm["generated"], false,
            "a disarm is not a generated command"
        );
        assert_eq!(disarm["encoded"], true);
        assert_eq!(disarm["delivery"], "notTransmitted");
    }

    #[test]
    fn the_unavailable_status_is_disarmed_dry_run() {
        let s = ControlStatus::unavailable();
        assert_eq!(s.runtime, RuntimeCode::Unavailable);
        assert_eq!(s.state, StateCode::Disabled);
        assert_eq!(s.mode, ModeCode::DryRun);
        assert!(!s.permits_output);
        let v = json!(s);
        assert_eq!(v["telemetry"]["freshness"], "noFrame");
        assert_eq!(v["watchdog"]["timeoutMs"], 100);
    }

    fn contains_key(value: &Value, key: &str) -> bool {
        match value {
            Value::Object(map) => map.iter().any(|(k, v)| k == key || contains_key(v, key)),
            Value::Array(items) => items.iter().any(|v| contains_key(v, key)),
            _ => false,
        }
    }

    fn contains_string(value: &Value, needle: &str) -> bool {
        match value {
            Value::String(s) => s.to_lowercase().contains(needle),
            Value::Object(map) => map.values().any(|v| contains_string(v, needle)),
            Value::Array(items) => items.iter().any(|v| contains_string(v, needle)),
            _ => false,
        }
    }

    #[test]
    fn the_log_merges_rings_newest_first_and_caps_the_limit() {
        let t0 = Instant::now();
        let log = ControlLog::new(t0);
        log.decision(t0 + ms(1), DecisionEvent::FeedLost);
        log.timing(t0 + ms(2), TimingEvent::Late { lateness: ms(12) });
        log.message(
            t0 + ms(3),
            MessageRecord {
                kind: MessageKind::Disarm,
                bytes: [0; 20],
                requested: None,
                bounded: None,
                adjustments: Adjustments::default(),
                delivery: Delivery::NotTransmitted,
            },
        );
        log.decision(t0 + ms(4), DecisionEvent::FeedRestored);
        let entries = recent_log(&log.snapshot(), 10);
        let ns: Vec<u64> = entries.iter().map(|e| e.n).collect();
        assert_eq!(ns, vec![3, 2, 1, 0]);
        assert_eq!(entries[1].category, LogCategory::Message);
        assert_eq!(entries[0].at_ms, 4);
        assert_eq!(recent_log(&log.snapshot(), 2).len(), 2);
        for _ in 0..500 {
            log.decision(t0, DecisionEvent::FeedLost);
        }
        assert_eq!(recent_log(&log.snapshot(), 10_000).len(), MAX_LOG_ENTRIES);

        let v = json!(entries);
        assert_eq!(v[0]["event"], "feedRestored");
        assert_eq!(v[1]["event"], "message");
        assert_eq!(v[1]["message"]["delivery"], "notTransmitted");
        assert_eq!(v[2]["event"], "late");
        assert!(!contains_key(&v, "delivered"));
        assert!(!contains_string(&v, "delivered"));
    }
}
