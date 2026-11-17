//! Freshness and continuity of the telemetry a controller acts on.
//!
//! Pure logic: frames and the current time are passed in, so every rule is unit-testable
//! without a game, a pipe or a real clock.
//!
//! # What the telemetry guarantees (verified in RoadPilot-Telemetry and the SCS SDK 1.16)
//!
//! * `sequence` counts game frames and strictly increases within a `session`, across pipe
//!   reconnects. The plugin replaces unsent frames by newer ones, so gaps are normal.
//! * `session` is a random id created when the game initializes the plugin. A new value means
//!   the game or the plugin restarted; the sequence then starts over.
//! * `simulationTimeUs` is the SDK physics clock. It keeps advancing while the game is
//!   paused, can restart from zero when the game restarts its timers (the plugin does not
//!   forward the SDK restart flag), and is not guaranteed to run at wall-clock speed. It is
//!   absent when the plugin could not register for the SDK frame start event.
//! * While paused, the SDK stops updating the vehicle values; frames may still arrive.
//! * The plugin sends frames only when the game produces them (no heartbeat), drops a frame
//!   whose pipe write failed, and reconnects after 250 ms to 1 s. The pipe carries no explicit
//!   disconnect signal: a disconnect or reconnect is visible only as a gap in received frames,
//!   possibly with an unchanged session.
//!
//! # Rules implemented here
//!
//! * **Age** is the frame's absolute age: the time since the game produced it (`FRAME_END`),
//!   from the plugin's QPC stamp converted to the local monotonic clock when the frame is
//!   received ([`FrameDigest`]); never simulation time. It includes the time the frame spent in
//!   the plugin and the pipe, so it is never less than the time since it was received. Data
//!   older than the limit (default 150 ms, at most 200 ms) is unusable. A running frame
//!   without a valid QPC timing has no known age and is rejected as invalid (`ClockMissing`,
//!   `ClockInvalid`); paused frames are not usable anyway and are accepted without one.
//! * **Retired sessions.** A session (per game) that was replaced by another is never
//!   accepted again ([`RETIRED_SESSIONS`] are remembered), so a late frame of a finished game
//!   cannot pass as a new session.
//! * **Ordering** uses `(session, sequence)` only. Repeated and older frames, and frames whose
//!   receive time goes backwards, are rejected and do **not** refresh freshness.
//! * **Latency backlog** (replaces the former simulation-time backlog check, R7): a frame with
//!   a verified QPC timing, running or paused, whose transport latency (`received - sent`) or
//!   age at receive (`received - produced`) exceeds 50 ms waited in the plugin or the pipe.
//!   The limits are the critical limits of the latency diagnosis
//!   (`latency::TRANSPORT_CRITICAL`, `latency::AGE_AT_RECEIVE_CRITICAL`), their single
//!   definition. The first frame of a run of such frames starts one epoch
//!   (`LatencyBacklog`); every frame of the run resets settling, so the state stays unusable
//!   however long the run lasts, without an epoch per frame. The run ends only with a frame
//!   with a verified timing within both limits. A frame without a verified timing is not
//!   checked: it neither starts nor ends a run (a running one is invalid anyway, see Age).
//! * **Simulation time** is a cross-check, never an ordering or age source: a clock that
//!   stops while frames keep arriving means a frozen game. A clock that runs more than 100 ms
//!   ahead of the local clock within one second is only counted
//!   ([`FreshnessMonitor::sim_ahead_hits`], shadow diagnosis): ATS advances it in fixed steps
//!   and delivers frames in clusters, so it runs ahead without any delay (Phase 4.5: 46 hits
//!   in 75,609 recorded frames, none of them older than 40 ms on arrival).
//! * **Epochs.** Every event after which control must not continue unchanged increments the
//!   epoch counter: first frame, new session, game change, entering pause, a gap longer than
//!   the age limit (which is how a reconnect looks), a simulation clock restart, the start of
//!   a latency backlog, an invalid frame and a hand-off loss. A frame changes the epoch at
//!   most once; first frame, session, game, gap and clock restart take priority over a latency
//!   backlog, which takes priority over entering pause. A controller arms for one specific
//!   epoch. Because the counter can only grow, a reconnect or a pause can never silently
//!   restore control, even if the caller was not looking at the moment of the interruption.
//! * **Settling.** After any epoch change, and after a pause, an invalid frame or a late
//!   frame, a few consecutive good frames over a short time are required before the state is
//!   usable.
//!
//! The thresholds are conservative and have **not** been tuned against a live game. They may
//! only make the system stricter; they must not be loosened without live measurements.

use super::latency::{AGE_AT_RECEIVE_CRITICAL, TRANSPORT_CRITICAL};
use super::vehicle::{FrameIdentity, InvalidFrame, VehicleState};
use roadpilot_telemetry_client::qpc::{self, Stamp, Stamps, TimingError};
use roadpilot_telemetry_client::{GameId, PluginState, ReceivedTelemetryFrame};
use std::time::{Duration, Instant};

/// Default maximum age of the newest accepted frame. A healthy plugin delivers a frame about
/// every 16 ms, so this tolerates several missed frames but not a real interruption.
pub const DEFAULT_MAX_AGE: Duration = Duration::from_millis(150);
/// Configurable range of the age limit. Values outside are refused, not clamped.
pub const MIN_MAX_AGE: Duration = Duration::from_millis(50);
pub const MAX_MAX_AGE: Duration = Duration::from_millis(200);

/// Replaced sessions remembered and refused.
pub const RETIRED_SESSIONS: usize = 8;

/// Good consecutive frames and local time span required after any epoch change.
const SETTLE_FRAMES: u32 = 3;
const SETTLE_TIME: Duration = Duration::from_millis(50);
/// The simulation clock may run ahead of the local clock by this much within one window
/// before the shadow diagnosis (R7) counts a hit. Diagnostic only, no epoch.
const BACKLOG_TOLERANCE: Duration = Duration::from_millis(100);
const BACKLOG_WINDOW: Duration = Duration::from_secs(1);

/// The age limit was outside [`MIN_MAX_AGE`]..=[`MAX_MAX_AGE`].
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct InvalidConfig;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct FreshnessConfig {
    max_age: Duration,
}

impl FreshnessConfig {
    pub fn new(max_age: Duration) -> Result<Self, InvalidConfig> {
        if (MIN_MAX_AGE..=MAX_MAX_AGE).contains(&max_age) {
            Ok(Self { max_age })
        } else {
            Err(InvalidConfig)
        }
    }

    pub fn max_age(&self) -> Duration {
        self.max_age
    }
}

impl Default for FreshnessConfig {
    fn default() -> Self {
        Self {
            max_age: DEFAULT_MAX_AGE,
        }
    }
}

/// Why the epoch counter was incremented.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Discontinuity {
    FirstFrame,
    SessionChanged,
    GameChanged,
    /// The game started reporting pause.
    Paused,
    /// No frame was accepted for longer than the age limit: a disconnect, a reconnect or a
    /// frozen game.
    Gap,
    /// The simulation clock went backwards.
    SimulationTimeRestarted,
    /// A frame with a verified QPC timing arrived with a transport latency or an age at
    /// receive above the critical limit (`latency::TRANSPORT_CRITICAL`,
    /// `latency::AGE_AT_RECEIVE_CRITICAL`): it waited in the plugin or the pipe. Raised once
    /// per run of such frames (see [`FreshnessMonitor::observe_digest`]).
    LatencyBacklog,
    /// A frame was unusable (see [`Observation::Invalid`]).
    InvalidFrame,
    /// The hand-off from the relay to the control loop lost frames or events (see
    /// `mailbox`): what happened in between is unknown, so continuity is not assumed.
    HandoffOverflow,
}

/// Everything the monitor needs from one received frame, computed where the frame is
/// received (the relay), so the control loop handles a small fixed-size value instead of the
/// frame itself. `Copy`; holds no heap memory.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct FrameDigest {
    /// Local monotonic receive time (`ReceivedTelemetryFrame::received_at`).
    pub received_at: Instant,
    /// The frame's identity, or why it has none.
    pub identity: Result<FrameIdentity, InvalidFrame>,
    pub paused: bool,
    /// Running frames: the vehicle state, or why there is none. `None` while paused.
    pub state: Option<Result<VehicleState, InvalidFrame>>,
    /// When the game produced the frame, on the local monotonic clock:
    /// `received_at - (received_qpc - produced_qpc) / frequency`. `None` unless the clock is
    /// [`ClockStatus::Verified`].
    pub produced_at: Option<Instant>,
    pub clock: ClockStatus,
}

/// The frame's QPC timing, validated by `roadpilot_telemetry_client::qpc::evaluate`.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ClockStatus {
    /// All stamps present, one frequency equal to this process's, `produced <= sent <=
    /// received`, plausible span.
    Verified {
        /// `FRAME_END` to the plugin's send (includes the plugin's ~16 ms send pacing).
        processing: Duration,
        /// Plugin send to receive.
        transport: Duration,
    },
    /// A stamp or a frequency is absent.
    Missing(Stamp),
    /// The stamps do not form one plausible timeline.
    Invalid(TimingError),
}

impl FrameDigest {
    /// The digest of a received frame, judged against this process's QPC frequency.
    pub fn of(received: &ReceivedTelemetryFrame) -> Self {
        Self::with_local_frequency(received, qpc::frequency())
    }

    /// The digest against a given local QPC frequency (`None`: no clock in this process).
    pub fn with_local_frequency(
        received: &ReceivedTelemetryFrame,
        local_frequency: Option<u64>,
    ) -> Self {
        let frame = &received.frame;
        let paused = frame.plugin_state == PluginState::Paused;
        let stamps = Stamps {
            produced: frame.produced_qpc,
            sent: frame.sent_qpc,
            received: received.received_qpc,
            plugin_frequency: frame.qpc_frequency,
        };
        let (produced_at, clock) = match qpc::evaluate(stamps, local_frequency) {
            Ok(timing) => match received.received_at.checked_sub(timing.age_at_receive) {
                Some(produced_at) => (
                    Some(produced_at),
                    ClockStatus::Verified {
                        processing: timing.plugin_processing,
                        transport: timing.transport,
                    },
                ),
                // Older than the monotonic clock itself: cannot be represented, so not trusted.
                None => (
                    None,
                    ClockStatus::Invalid(TimingError::Implausible {
                        span: timing.age_at_receive,
                    }),
                ),
            },
            Err(TimingError::Missing(stamp)) => (None, ClockStatus::Missing(stamp)),
            Err(error) => (None, ClockStatus::Invalid(error)),
        };
        Self {
            received_at: received.received_at,
            identity: FrameIdentity::from_frame(frame),
            paused,
            state: (!paused).then(|| VehicleState::from_frame(frame)),
            produced_at,
            clock,
        }
    }

    /// Why a running frame cannot be trusted for its age, if it cannot.
    pub(super) fn clock_problem(&self) -> Option<InvalidFrame> {
        match self.clock {
            ClockStatus::Verified { .. } => None,
            ClockStatus::Missing(stamp) => Some(InvalidFrame::ClockMissing(stamp)),
            ClockStatus::Invalid(error) => Some(InvalidFrame::ClockInvalid(error)),
        }
    }
}

/// Why a frame was ignored without any effect on freshness or continuity.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Rejection {
    /// Same session and sequence as the newest accepted frame.
    Duplicate,
    /// Same session, lower sequence than the newest accepted frame.
    OutOfOrder,
    /// Higher sequence, but received before the newest accepted frame.
    ReceiveTimeRegressed,
    /// The session was replaced by another one earlier; its frames are never accepted again.
    RetiredSession,
}

/// What [`FreshnessMonitor::observe`] did with a frame.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Observation {
    Accepted {
        epoch: u64,
        /// Set when this frame started a new epoch.
        discontinuity: Option<Discontinuity>,
    },
    Rejected(Rejection),
    /// The frame cannot be used; the state is unusable until a valid frame arrives and
    /// settles, and a new epoch has begun.
    Invalid(InvalidFrame),
}

/// Why the vehicle state cannot be used right now.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Unusable {
    /// No frame was ever accepted.
    NoFrame,
    /// The newest frame was invalid.
    Invalid(InvalidFrame),
    /// The newest accepted frame is older than the age limit.
    Stale { age: Duration },
    /// The game reports pause.
    Paused,
    /// Frames arrive but the simulation clock stopped for longer than the age limit.
    SimulationStalled { stalled_for: Duration },
    /// A new epoch has begun and not enough good frames have been seen yet.
    Settling,
}

/// A usable vehicle state together with what a controller needs to bind itself to it.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Sample {
    pub state: VehicleState,
    /// Epoch the state belongs to. Control armed for another epoch must disarm.
    pub epoch: u64,
    /// The frame's absolute age: time since the game produced it (see the module rules).
    pub age: Duration,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Assessment {
    Usable(Sample),
    Unusable(Unusable),
}

impl Assessment {
    pub fn usable(self) -> Option<Sample> {
        match self {
            Assessment::Usable(sample) => Some(sample),
            Assessment::Unusable(_) => None,
        }
    }
}

/// The newest accepted frame and the reference points of the continuity checks.
#[derive(Clone, Copy, Debug)]
struct Track {
    identity: FrameIdentity,
    received_at: Instant,
    /// When the game produced the frame (verified QPC timing); `None` only for paused frames
    /// without one.
    produced_at: Option<Instant>,
    paused: bool,
    /// Local time at which the simulation clock last advanced.
    sim_advanced_at: Instant,
    /// Reference point of the simulation-time shadow check (R7); renewed every
    /// [`BACKLOG_WINDOW`], at every epoch change and at every hit.
    window_start: Instant,
    window_start_sim_us: u64,
}

#[derive(Clone, Copy, Debug, Default)]
struct Streak {
    frames: u32,
    started_at: Option<Instant>,
}

#[derive(Debug)]
pub struct FreshnessMonitor {
    config: FreshnessConfig,
    epoch: u64,
    last_discontinuity: Option<Discontinuity>,
    track: Option<Track>,
    /// Set by an invalid frame, cleared by the next accepted frame.
    invalid: Option<InvalidFrame>,
    streak: Streak,
    /// State of the newest accepted frame; `None` while paused.
    latest: Option<VehicleState>,
    /// Replaced sessions (ring, most recent at `next_retired - 1`).
    retired: [Option<(GameId, u64)>; RETIRED_SESSIONS],
    next_retired: usize,
    /// Inside a run of frames above a latency limit: set by the first one, cleared only by a
    /// frame with a verified clock within both limits.
    latency_run: bool,
    /// Hits of the simulation-time shadow check (R7); diagnostic only.
    sim_ahead_hits: u64,
}

/// Whether a frame's verified QPC timing exceeds a critical latency limit; `None` when the
/// frame has no verified timing (its latency is unknown).
fn latency_exceeded(digest: &FrameDigest) -> Option<bool> {
    match (digest.clock, digest.produced_at) {
        (ClockStatus::Verified { transport, .. }, Some(produced_at)) => {
            let age_at_receive = digest.received_at.saturating_duration_since(produced_at);
            Some(transport > TRANSPORT_CRITICAL || age_at_receive > AGE_AT_RECEIVE_CRITICAL)
        }
        _ => None,
    }
}

impl FreshnessMonitor {
    pub fn new(config: FreshnessConfig) -> Self {
        Self {
            config,
            epoch: 0,
            last_discontinuity: None,
            track: None,
            invalid: None,
            streak: Streak::default(),
            latest: None,
            retired: [None; RETIRED_SESSIONS],
            next_retired: 0,
            latency_run: false,
            sim_ahead_hits: 0,
        }
    }

    /// Hits of the simulation-time shadow check (R7) so far. Diagnostic only: they start no
    /// epoch and change no assessment.
    pub fn sim_ahead_hits(&self) -> u64 {
        self.sim_ahead_hits
    }

    /// Current epoch; 0 until the first frame. Only ever grows.
    pub fn epoch(&self) -> u64 {
        self.epoch
    }

    /// Cause of the most recent epoch change, for logging.
    pub fn last_discontinuity(&self) -> Option<Discontinuity> {
        self.last_discontinuity
    }

    pub fn config(&self) -> FreshnessConfig {
        self.config
    }

    /// Local time since the newest accepted frame was received; `None` before the first one.
    pub fn last_frame_age(&self, now: Instant) -> Option<Duration> {
        self.track
            .map(|t| now.saturating_duration_since(t.received_at))
    }

    fn retire(&mut self, game: GameId, session: u64) {
        self.retired[self.next_retired] = Some((game, session));
        self.next_retired = (self.next_retired + 1) % RETIRED_SESSIONS;
    }

    fn bump(&mut self, cause: Discontinuity) {
        self.epoch = self.epoch.saturating_add(1);
        self.last_discontinuity = Some(cause);
        self.streak = Streak::default();
    }

    fn reject_invalid(&mut self, reason: InvalidFrame) -> Observation {
        if self.invalid.is_none() {
            self.bump(Discontinuity::InvalidFrame);
        }
        self.invalid = Some(reason);
        self.streak = Streak::default();
        self.latest = None;
        Observation::Invalid(reason)
    }

    /// The epoch change a frame causes, if any, and whether the simulation-time shadow check
    /// (R7) hit. Priority: first frame, session, game, gap, simulation clock restart, then a
    /// new run of frames above a latency limit (`latency_starts`), then entering pause. The
    /// shadow check is evaluated where the former backlog check was, so only when none of the
    /// first five applies; it never causes an epoch change.
    fn classify(
        &self,
        id: &FrameIdentity,
        at: Instant,
        paused: bool,
        latency_starts: bool,
    ) -> (Option<Discontinuity>, bool) {
        let Some(t) = &self.track else {
            return (Some(Discontinuity::FirstFrame), false);
        };
        if t.identity.session != id.session {
            return (Some(Discontinuity::SessionChanged), false);
        }
        if t.identity.game != id.game {
            return (Some(Discontinuity::GameChanged), false);
        }
        if at.saturating_duration_since(t.received_at) > self.config.max_age {
            return (Some(Discontinuity::Gap), false);
        }
        if id.simulation_time_us < t.identity.simulation_time_us {
            return (Some(Discontinuity::SimulationTimeRestarted), false);
        }
        let sim_ahead = backlog(t, id, at);
        let cause = if latency_starts {
            Some(Discontinuity::LatencyBacklog)
        } else if paused && !t.paused {
            Some(Discontinuity::Paused)
        } else {
            None
        };
        (cause, sim_ahead)
    }

    /// Feeds one received frame. Call it for every frame, in receive order.
    pub fn observe(&mut self, received: &ReceivedTelemetryFrame) -> Observation {
        self.observe_digest(&FrameDigest::of(received))
    }

    /// Starts a new epoch for a reason outside the frames themselves (a hand-off loss): the
    /// state must settle again before it is usable. The newest frame stays the reference for
    /// age and continuity checks.
    pub fn force_epoch(&mut self, cause: Discontinuity) {
        self.bump(cause);
    }

    /// Feeds the digest of one received frame. Call it for every frame, in receive order.
    /// Identical to [`FreshnessMonitor::observe`] on the frame itself.
    ///
    /// **Latency backlog.** An accepted frame (running or paused) with a verified QPC timing
    /// whose transport latency or age at receive exceeds its critical limit belongs to a run of
    /// late frames. The first frame of a run starts one epoch (`LatencyBacklog`, unless a
    /// higher-priority cause applies to that frame); every frame of the run resets settling,
    /// so the state stays unusable. The run ends only with a frame with a verified timing
    /// within both limits; a frame without a verified timing neither starts nor ends a run.
    pub fn observe_digest(&mut self, digest: &FrameDigest) -> Observation {
        let at = digest.received_at;

        let identity = match digest.identity {
            Ok(identity) => identity,
            Err(reason) => return self.reject_invalid(reason),
        };
        if self
            .retired
            .contains(&Some((identity.game, identity.session)))
        {
            return Observation::Rejected(Rejection::RetiredSession);
        }

        if let Some(t) = &self.track
            && t.identity.session == identity.session
            && t.identity.game == identity.game
        {
            if identity.sequence == t.identity.sequence {
                return Observation::Rejected(Rejection::Duplicate);
            }
            if identity.sequence < t.identity.sequence {
                return Observation::Rejected(Rejection::OutOfOrder);
            }
            if at < t.received_at {
                return Observation::Rejected(Rejection::ReceiveTimeRegressed);
            }
        }

        let paused = digest.paused;
        let state = match digest.state {
            None => None,
            Some(Ok(state)) => Some(state),
            Some(Err(reason)) => return self.reject_invalid(reason),
        };
        // A running frame must have a known age (see the module rules).
        if !paused && let Some(reason) = digest.clock_problem() {
            return self.reject_invalid(reason);
        }

        let exceeded = latency_exceeded(digest);
        let late = exceeded == Some(true);
        let (discontinuity, sim_ahead) =
            self.classify(&identity, at, paused, late && !self.latency_run);
        if let Some(cause) = discontinuity {
            self.bump(cause);
        }
        if let Some(exceeded) = exceeded {
            self.latency_run = exceeded;
        }
        if sim_ahead {
            self.sim_ahead_hits = self.sim_ahead_hits.saturating_add(1);
        }
        if matches!(
            discontinuity,
            Some(Discontinuity::SessionChanged | Discontinuity::GameChanged)
        ) && let Some(t) = self.track
        {
            self.retire(t.identity.game, t.identity.session);
        }
        self.invalid = None;

        let previous = self.track;
        let sim = identity.simulation_time_us;
        // A shadow hit renews the window like the epoch change it used to cause, so the hits
        // are counted exactly as the former backlog epochs were.
        let renew_window = discontinuity.is_some()
            || sim_ahead
            || previous
                .is_none_or(|t| at.saturating_duration_since(t.window_start) >= BACKLOG_WINDOW);
        let (window_start, window_start_sim_us) = match previous {
            Some(t) if !renew_window => (t.window_start, t.window_start_sim_us),
            _ => (at, sim),
        };
        let sim_advanced_at = match previous {
            Some(t) if discontinuity.is_none() && sim <= t.identity.simulation_time_us => {
                t.sim_advanced_at
            }
            _ => at,
        };

        if paused || late {
            // A late frame never counts towards settling: the state stays unusable for the
            // whole run.
            self.streak = Streak::default();
        } else {
            self.streak.frames = self.streak.frames.saturating_add(1);
            self.streak.started_at.get_or_insert(at);
        }
        self.latest = state;
        self.track = Some(Track {
            identity,
            received_at: at,
            produced_at: digest.produced_at,
            paused,
            sim_advanced_at,
            window_start,
            window_start_sim_us,
        });
        Observation::Accepted {
            epoch: self.epoch,
            discontinuity,
        }
    }

    /// Judges whether the newest state may be used at `now`. Call it at every control
    /// decision; it never changes the monitor.
    pub fn assess(&self, now: Instant) -> Assessment {
        if let Some(reason) = self.invalid {
            return Assessment::Unusable(Unusable::Invalid(reason));
        }
        let Some(t) = &self.track else {
            return Assessment::Unusable(Unusable::NoFrame);
        };
        // The absolute age (since the game produced the frame); it is never less than the time
        // since the frame was received.
        let age = now.saturating_duration_since(t.produced_at.unwrap_or(t.received_at));
        if age > self.config.max_age {
            return Assessment::Unusable(Unusable::Stale { age });
        }
        if t.paused {
            return Assessment::Unusable(Unusable::Paused);
        }
        let stalled_for = now.saturating_duration_since(t.sim_advanced_at);
        if stalled_for > self.config.max_age {
            return Assessment::Unusable(Unusable::SimulationStalled { stalled_for });
        }
        let settled = self.streak.frames >= SETTLE_FRAMES
            && self
                .streak
                .started_at
                .is_some_and(|start| t.received_at.saturating_duration_since(start) >= SETTLE_TIME);
        if !settled {
            return Assessment::Unusable(Unusable::Settling);
        }
        match self.latest {
            Some(state) => Assessment::Usable(Sample {
                state,
                epoch: self.epoch,
                age,
            }),
            None => Assessment::Unusable(Unusable::NoFrame),
        }
    }
}

impl Default for FreshnessMonitor {
    fn default() -> Self {
        Self::new(FreshnessConfig::default())
    }
}

/// The simulation-time shadow check (R7, diagnostic only): true if, since the window started,
/// the simulation clock advanced more than the local clock plus the tolerance. ATS advances
/// the simulation clock in fixed steps and delivers frames in clusters, so this also hits
/// without any delay (Phase 4.5: 46 hits in 75,609 recorded frames, none of them delayed);
/// that is why it no longer starts an epoch.
fn backlog(t: &Track, id: &FrameIdentity, at: Instant) -> bool {
    let local = at.saturating_duration_since(t.window_start);
    let simulated =
        Duration::from_micros(id.simulation_time_us.saturating_sub(t.window_start_sim_us));
    simulated > local + BACKLOG_TOLERANCE
}

#[cfg(test)]
mod tests {
    use super::super::vehicle::test_support::{paused_frame, running_frame};
    use super::*;
    use roadpilot_telemetry_client::{self as proto, GameId, TelemetryFrame};

    const FULL: &str = include_str!("../../tests/fixtures/frame-v2-full.json");

    fn ms(n: u64) -> Duration {
        Duration::from_millis(n)
    }

    /// A monitor plus a fixed origin so tests can speak in milliseconds.
    struct Rig {
        monitor: FreshnessMonitor,
        t0: Instant,
    }

    impl Rig {
        fn new() -> Self {
            Self::with(FreshnessConfig::default())
        }

        fn with(config: FreshnessConfig) -> Self {
            Self {
                monitor: FreshnessMonitor::new(config),
                t0: Instant::now(),
            }
        }

        fn at(&self, millis: u64) -> Instant {
            self.t0 + ms(millis)
        }

        fn feed(&mut self, frame: TelemetryFrame, at_ms: u64) -> Observation {
            // Received the moment it was sent: the frame's own QPC stamps give its age.
            let received_qpc = frame.sent_qpc;
            let received = ReceivedTelemetryFrame {
                frame,
                dropped_fields: Vec::new(),
                received_at: self.at(at_ms),
                received_qpc,
            };
            self.monitor.observe(&received)
        }

        /// Running frame whose simulation clock equals the local clock.
        fn run(&mut self, session: u64, seq: u64, at_ms: u64) -> Observation {
            self.feed(running_frame(session, seq, at_ms * 1_000), at_ms)
        }

        fn assess(&self, at_ms: u64) -> Assessment {
            self.monitor.assess(self.at(at_ms))
        }

        fn unusable(&self, at_ms: u64) -> Unusable {
            match self.assess(at_ms) {
                Assessment::Unusable(u) => u,
                Assessment::Usable(s) => panic!("expected unusable, got {s:?}"),
            }
        }

        fn sample(&self, at_ms: u64) -> Sample {
            self.assess(at_ms)
                .usable()
                .unwrap_or_else(|| panic!("expected usable, got {:?}", self.assess(at_ms)))
        }

        /// Frames 1..=5 of session 7 at 0, 16, ... 64 ms: the first usable moment.
        fn settled() -> Self {
            let mut rig = Self::new();
            for i in 0..5 {
                rig.run(7, i + 1, i * 16);
            }
            assert_eq!(rig.sample(64).epoch, 1);
            rig
        }

        /// Frames after `from_seq`/`from_ms` until the monitor is usable again.
        fn settle_again(&mut self, session: u64, from_seq: u64, from_ms: u64) -> u64 {
            for i in 1..=10 {
                self.run(session, from_seq + i, from_ms + i * 16);
                if self.assess(from_ms + i * 16).usable().is_some() {
                    return from_ms + i * 16;
                }
            }
            panic!("never became usable: {:?}", self.assess(from_ms + 160));
        }
    }

    #[test]
    fn starts_without_frames() {
        let rig = Rig::new();
        assert_eq!(rig.unusable(0), Unusable::NoFrame);
        assert_eq!(rig.monitor.epoch(), 0);
        assert_eq!(rig.monitor.last_discontinuity(), None);
    }

    #[test]
    fn the_first_frame_starts_epoch_one_and_needs_settling() {
        let mut rig = Rig::new();
        assert_eq!(
            rig.run(7, 1, 0),
            Observation::Accepted {
                epoch: 1,
                discontinuity: Some(Discontinuity::FirstFrame)
            }
        );
        assert_eq!(rig.unusable(0), Unusable::Settling);
        rig.run(7, 2, 16);
        rig.run(7, 3, 32);
        assert_eq!(rig.unusable(32), Unusable::Settling, "3 frames, 32 ms");
        rig.run(7, 4, 48);
        assert_eq!(rig.unusable(48), Unusable::Settling, "4 frames, 48 ms");
        rig.run(7, 5, 64);
        let s = rig.sample(64);
        assert_eq!(s.epoch, 1);
        assert_eq!(s.state.identity.sequence, 5);
        assert_eq!(s.state.identity.session, 7);
        assert_eq!(s.age, ms(0));
    }

    #[test]
    fn settling_needs_both_enough_frames_and_enough_time() {
        // Many frames in a burst over a tiny time span are not enough.
        let mut rig = Rig::new();
        for i in 0..10 {
            rig.run(7, i + 1, 10);
        }
        assert_eq!(rig.unusable(10), Unusable::Settling);
        // The same frames spread over time are.
        let mut rig = Rig::new();
        for i in 0..4 {
            rig.run(7, i + 1, i * 20);
        }
        assert!(rig.assess(60).usable().is_some());
    }

    #[test]
    fn a_steady_60_hz_stream_never_leaves_its_epoch() {
        let mut rig = Rig::new();
        let mut at = 0;
        for seq in 1..=3750u64 {
            let observation = rig.run(7, seq, at);
            if seq > 1 {
                assert_eq!(
                    observation,
                    Observation::Accepted {
                        epoch: 1,
                        discontinuity: None
                    },
                    "frame {seq} at {at} ms"
                );
            }
            at += if seq % 2 == 0 { 15 } else { 17 }; // jitter
        }
        assert_eq!(rig.sample(at).epoch, 1);
    }

    #[test]
    fn a_gap_between_the_simulation_and_local_clock_rate_is_tolerated() {
        for permille in [1_005u64, 995] {
            let mut rig = Rig::new();
            for i in 0..1875u64 {
                let at = i * 16;
                let frame = running_frame(7, i + 1, at * permille); // µs = ms * 1000 * rate
                let observation = rig.feed(frame, at);
                assert!(
                    matches!(
                        observation,
                        Observation::Accepted {
                            discontinuity: None | Some(Discontinuity::FirstFrame),
                            ..
                        }
                    ),
                    "rate {permille}: {observation:?} at {at}"
                );
            }
            assert_eq!(rig.monitor.epoch(), 1);
        }
    }

    #[test]
    fn age_is_measured_from_the_local_receive_time_with_a_limit_of_150_ms() {
        let rig = Rig::settled();
        assert!(
            rig.assess(64 + 150).usable().is_some(),
            "exactly at the limit"
        );
        assert_eq!(
            rig.unusable(64 + 151),
            Unusable::Stale { age: ms(151) },
            "just past the limit"
        );
        assert_eq!(rig.sample(64 + 100).age, ms(100));
    }

    #[test]
    fn the_age_limit_is_configurable_within_safe_bounds() {
        assert_eq!(FreshnessConfig::default().max_age(), ms(150));
        assert!(FreshnessConfig::new(ms(50)).is_ok());
        assert!(FreshnessConfig::new(ms(200)).is_ok());
        assert_eq!(FreshnessConfig::new(ms(49)), Err(InvalidConfig));
        assert_eq!(FreshnessConfig::new(ms(201)), Err(InvalidConfig));
        assert_eq!(FreshnessConfig::new(Duration::ZERO), Err(InvalidConfig));
        assert_eq!(FreshnessConfig::new(Duration::MAX), Err(InvalidConfig));

        let mut rig = Rig::with(FreshnessConfig::new(ms(100)).unwrap());
        for i in 0..5 {
            rig.run(7, i + 1, i * 16);
        }
        assert!(rig.assess(64 + 100).usable().is_some());
        assert_eq!(rig.unusable(64 + 101), Unusable::Stale { age: ms(101) });
    }

    #[test]
    fn a_reconnect_gap_in_the_same_session_starts_a_new_epoch_and_never_resumes_control() {
        let mut rig = Rig::settled();
        let armed_epoch = rig.sample(64).epoch;
        // The pipe was down for 300 ms; the same session continues with higher sequences.
        assert_eq!(rig.unusable(64 + 300), Unusable::Stale { age: ms(300) });
        assert_eq!(
            rig.run(7, 20, 364),
            Observation::Accepted {
                epoch: 2,
                discontinuity: Some(Discontinuity::Gap)
            }
        );
        assert_eq!(rig.monitor.last_discontinuity(), Some(Discontinuity::Gap));
        assert_eq!(rig.unusable(364), Unusable::Settling);
        let usable_at = rig.settle_again(7, 20, 364);
        let resumed = rig.sample(usable_at);
        assert_ne!(
            resumed.epoch, armed_epoch,
            "control armed before must not carry over"
        );
        assert_eq!(resumed.epoch, 2);
    }

    #[test]
    fn a_gap_of_exactly_the_limit_is_not_an_interruption() {
        let mut rig = Rig::settled();
        assert_eq!(
            rig.run(7, 6, 64 + 150),
            Observation::Accepted {
                epoch: 1,
                discontinuity: None
            }
        );
        assert_eq!(
            rig.run(7, 7, 64 + 150 + 151),
            Observation::Accepted {
                epoch: 2,
                discontinuity: Some(Discontinuity::Gap)
            }
        );
    }

    #[test]
    fn sequence_gaps_are_normal_because_the_plugin_drops_unsent_frames() {
        let mut rig = Rig::new();
        for (i, seq) in [1u64, 4, 9, 10, 18, 25].into_iter().enumerate() {
            let observation = rig.run(7, seq, i as u64 * 20);
            if i > 0 {
                assert_eq!(
                    observation,
                    Observation::Accepted {
                        epoch: 1,
                        discontinuity: None
                    }
                );
            }
        }
        assert!(rig.assess(100).usable().is_some());
    }

    #[test]
    fn a_repeated_sequence_is_rejected_and_does_not_refresh_freshness() {
        let mut rig = Rig::settled(); // newest accepted: seq 5 at 64 ms
        assert_eq!(
            rig.run(7, 5, 200),
            Observation::Rejected(Rejection::Duplicate)
        );
        assert_eq!(
            rig.unusable(64 + 151),
            Unusable::Stale { age: ms(151) },
            "the replayed frame must not make the data look newer"
        );
        assert_eq!(rig.monitor.epoch(), 1);
    }

    #[test]
    fn an_older_sequence_is_rejected_and_changes_nothing() {
        let mut rig = Rig::settled();
        assert_eq!(
            rig.run(7, 3, 70),
            Observation::Rejected(Rejection::OutOfOrder)
        );
        let s = rig.sample(80);
        assert_eq!(s.state.identity.sequence, 5);
        assert_eq!(s.epoch, 1);
    }

    #[test]
    fn a_frame_received_before_the_newest_accepted_one_is_rejected() {
        let mut rig = Rig::settled();
        let observation = rig.feed(running_frame(7, 6, 80_000), 60);
        assert_eq!(
            observation,
            Observation::Rejected(Rejection::ReceiveTimeRegressed)
        );
        assert_eq!(rig.sample(70).state.identity.sequence, 5);
    }

    #[test]
    fn a_new_session_starts_a_new_epoch_even_with_a_lower_sequence() {
        let mut rig = Rig::new();
        for i in 0..5 {
            rig.run(7, 496 + i, i * 16);
        }
        assert_eq!(rig.sample(64).epoch, 1);
        assert_eq!(
            rig.run(8, 1, 80),
            Observation::Accepted {
                epoch: 2,
                discontinuity: Some(Discontinuity::SessionChanged)
            }
        );
        assert_eq!(rig.unusable(80), Unusable::Settling);
        let usable_at = rig.settle_again(8, 1, 80);
        let s = rig.sample(usable_at);
        assert_eq!(s.epoch, 2);
        assert_eq!(s.state.identity.session, 8);
    }

    #[test]
    fn an_older_session_is_never_accepted_again() {
        // Session 7 was replaced by 8: late frames of 7 are refused for good and change
        // nothing, even with a higher sequence and after a third session.
        let mut rig = Rig::settled();
        rig.run(8, 1, 80);
        let epoch = rig.monitor.epoch();
        assert_eq!(
            rig.run(7, 6, 96),
            Observation::Rejected(Rejection::RetiredSession)
        );
        assert_eq!(rig.monitor.epoch(), epoch);
        rig.run(9, 1, 112);
        assert_eq!(
            rig.run(7, 7, 128),
            Observation::Rejected(Rejection::RetiredSession)
        );
        assert_eq!(
            rig.run(8, 2, 144),
            Observation::Rejected(Rejection::RetiredSession)
        );
        // The current session goes on.
        assert!(matches!(rig.run(9, 2, 160), Observation::Accepted { .. }));
    }

    #[test]
    fn a_game_change_retires_the_previous_session_of_that_game() {
        let mut rig = Rig::settled();
        let mut ats = running_frame(7, 6, 80_000);
        ats.game = GameId::Ats;
        rig.feed(ats, 80);
        assert_eq!(
            rig.run(7, 7, 96),
            Observation::Rejected(Rejection::RetiredSession)
        );
    }

    #[test]
    fn a_game_change_is_a_discontinuity() {
        let mut rig = Rig::settled();
        let mut frame = running_frame(7, 6, 80_000);
        frame.game = GameId::Ats;
        assert_eq!(
            rig.feed(frame, 80),
            Observation::Accepted {
                epoch: 2,
                discontinuity: Some(Discontinuity::GameChanged)
            }
        );
        assert_eq!(rig.unusable(80), Unusable::Settling);
        // A different session with a different game reports the session first.
        let mut frame = running_frame(9, 1, 96_000);
        frame.game = GameId::Ets2;
        assert_eq!(
            rig.feed(frame, 96),
            Observation::Accepted {
                epoch: 3,
                discontinuity: Some(Discontinuity::SessionChanged)
            }
        );
    }

    #[test]
    fn pause_makes_the_state_unusable_and_resuming_does_not_restore_the_epoch() {
        let mut rig = Rig::settled();
        let armed_epoch = rig.sample(64).epoch;

        assert_eq!(
            rig.feed(paused_frame(7, 6, 80_000), 80),
            Observation::Accepted {
                epoch: 2,
                discontinuity: Some(Discontinuity::Paused)
            }
        );
        assert_eq!(rig.unusable(80), Unusable::Paused);
        // More paused frames keep it unusable without further epoch changes.
        assert_eq!(
            rig.feed(paused_frame(7, 7, 96_000), 96),
            Observation::Accepted {
                epoch: 2,
                discontinuity: None
            }
        );
        assert_eq!(rig.unusable(100), Unusable::Paused);

        // Resuming starts a fresh settling period in the new epoch.
        assert_eq!(
            rig.run(7, 8, 112),
            Observation::Accepted {
                epoch: 2,
                discontinuity: None
            }
        );
        assert_eq!(rig.unusable(112), Unusable::Settling);
        let usable_at = rig.settle_again(7, 8, 112);
        let resumed = rig.sample(usable_at);
        assert_ne!(resumed.epoch, armed_epoch);
    }

    #[test]
    fn paused_frames_need_no_vehicle_values() {
        let mut rig = Rig::new();
        let frame = paused_frame(7, 1, 0);
        assert!(frame.truck.is_none() && frame.placement.is_none());
        assert!(matches!(rig.feed(frame, 0), Observation::Accepted { .. }));
        assert_eq!(rig.unusable(0), Unusable::Paused);
    }

    #[test]
    fn a_pause_without_any_frames_looks_stale() {
        // The SDK may stop delivering frames while paused; that must also be unusable.
        let rig = Rig::settled();
        assert_eq!(rig.unusable(2_000), Unusable::Stale { age: ms(1_936) });
    }

    fn invalid_cases() -> Vec<(&'static str, TelemetryFrame, InvalidFrame)> {
        let base = || running_frame(7, 6, 80_000);
        let mut cases = Vec::new();
        let mut f = base();
        f.session = None;
        cases.push(("no session", f, InvalidFrame::MissingSession));
        let mut f = base();
        f.simulation_time_us = None;
        cases.push(("no simulation time", f, InvalidFrame::MissingSimulationTime));
        let mut f = base();
        f.schema_version = 1;
        cases.push(("schema 1", f, InvalidFrame::UnsupportedSchema(1)));
        let mut f = base();
        f.truck.as_mut().unwrap().speed_mps = None;
        cases.push(("no speed", f, InvalidFrame::MissingField("truck.speedMps")));
        let mut f = base();
        f.truck.as_mut().unwrap().speed_mps = Some(f32::NAN);
        cases.push((
            "NaN speed",
            f,
            InvalidFrame::NonFiniteValue("truck.speedMps"),
        ));
        let mut f = base();
        f.placement = None;
        cases.push(("no placement", f, InvalidFrame::MissingField("placement")));
        cases
    }

    #[test]
    fn an_invalid_frame_makes_the_state_unusable_and_does_not_refresh_freshness() {
        for (name, frame, reason) in invalid_cases() {
            let mut rig = Rig::settled();
            assert_eq!(
                rig.feed(frame.clone(), 80),
                Observation::Invalid(reason),
                "{name}"
            );
            assert_eq!(rig.monitor.epoch(), 2, "{name}");
            assert_eq!(
                rig.monitor.last_discontinuity(),
                Some(Discontinuity::InvalidFrame),
                "{name}"
            );
            assert_eq!(rig.unusable(80), Unusable::Invalid(reason), "{name}");

            // A second invalid frame of the same episode does not bump the epoch again.
            let mut second = frame;
            second.sequence = 7;
            assert_eq!(rig.feed(second, 96), Observation::Invalid(reason), "{name}");
            assert_eq!(rig.monitor.epoch(), 2, "{name}");

            // Recovery needs valid frames and a settling period, in the new epoch.
            assert_eq!(
                rig.run(7, 8, 112),
                Observation::Accepted {
                    epoch: 2,
                    discontinuity: None
                },
                "{name}"
            );
            assert_eq!(rig.unusable(112), Unusable::Settling, "{name}");
            let usable_at = rig.settle_again(7, 8, 112);
            assert_eq!(rig.sample(usable_at).epoch, 2, "{name}");
        }
    }

    #[test]
    fn a_single_invalid_frame_between_good_ones_is_visible_as_an_epoch_change() {
        // A control tick that falls between the bad frame and the next good one would see a
        // usable state again; the epoch change still tells it that something happened.
        let mut rig = Rig::settled();
        let before = rig.sample(64).epoch;
        let mut bad = running_frame(7, 6, 80_000);
        bad.truck.as_mut().unwrap().speed_mps = None;
        rig.feed(bad, 80);
        let usable_at = {
            rig.run(7, 7, 96);
            rig.settle_again(7, 7, 96)
        };
        assert_ne!(rig.sample(usable_at).epoch, before);
    }

    #[test]
    fn a_simulation_clock_restart_starts_a_new_epoch() {
        let mut rig = Rig::settled();
        assert_eq!(
            rig.feed(running_frame(7, 6, 5_000), 80),
            Observation::Accepted {
                epoch: 2,
                discontinuity: Some(Discontinuity::SimulationTimeRestarted)
            }
        );
        assert_eq!(rig.unusable(80), Unusable::Settling);
        // From the restart the clock advances again and the monitor settles normally.
        let mut at = 80;
        let mut seq = 6;
        let mut usable = false;
        for _ in 0..10 {
            at += 16;
            seq += 1;
            rig.feed(running_frame(7, seq, 5_000 + (at - 80) * 1_000), at);
            if rig.assess(at).usable().is_some() {
                usable = true;
                break;
            }
        }
        assert!(usable);
        assert_eq!(rig.monitor.epoch(), 2);
    }

    #[test]
    fn an_unchanged_simulation_time_between_frames_is_allowed() {
        // At high render rates several frames can share one physics time.
        let mut rig = Rig::settled();
        let observation = rig.feed(running_frame(7, 6, 64_000), 80);
        assert_eq!(
            observation,
            Observation::Accepted {
                epoch: 1,
                discontinuity: None
            }
        );
        assert!(rig.assess(80).usable().is_some());
    }

    #[test]
    fn a_frozen_simulation_clock_with_arriving_frames_is_unusable() {
        let mut rig = Rig::settled(); // sim clock last advanced at 64 ms
        let mut seq = 5;
        for at in (80..=240).step_by(16) {
            seq += 1;
            rig.feed(running_frame(7, seq, 64_000), at);
        }
        assert!(
            rig.assess(200).usable().is_some(),
            "136 ms stalled is within the limit"
        );
        assert_eq!(
            rig.unusable(240),
            Unusable::SimulationStalled {
                stalled_for: ms(176)
            }
        );
        // The clock moves again: usable again without an epoch change.
        rig.feed(running_frame(7, seq + 1, 250_000), 256);
        assert!(rig.assess(256).usable().is_some());
        assert_eq!(rig.monitor.epoch(), 1);
    }

    // ---- R7: the simulation-time check, now a shadow diagnosis ----

    #[test]
    fn a_simulation_clock_running_ahead_is_counted_but_starts_no_epoch() {
        let mut rig = Rig::settled(); // window starts at 0 ms
        // Twenty frames read back to back at 70 ms, simulation clock 16 ms apart, without any
        // delay (QPC age 0): the former backlog check fired here.
        let mut hit_at = None;
        for k in 1..=20u64 {
            let observation = rig.feed(running_frame(7, 5 + k, (64 + 16 * k) * 1_000), 70);
            assert_eq!(
                observation,
                Observation::Accepted {
                    epoch: 1,
                    discontinuity: None
                },
                "frame {k}"
            );
            if hit_at.is_none() && rig.monitor.sim_ahead_hits() == 1 {
                hit_at = Some(k);
            }
        }
        // The clock must have run more than 170 ms ahead: 64 + 16k > 170, so k = 7. The hit
        // renews the window like the former epoch did: the next hit needs another 100 ms
        // ahead of the local clock (k = 14).
        assert_eq!(hit_at, Some(7));
        assert_eq!(rig.monitor.sim_ahead_hits(), 2);
        assert_eq!(rig.monitor.epoch(), 1);
        assert!(rig.assess(70).usable().is_some(), "no effect on the state");
    }

    #[test]
    fn a_short_normal_burst_is_not_a_shadow_hit() {
        // Three frames delivered together after a brief hiccup stay within the tolerance.
        let mut rig = Rig::settled();
        for k in 1..=3u64 {
            let observation = rig.feed(running_frame(7, 5 + k, (64 + 16 * k) * 1_000), 90);
            assert_eq!(
                observation,
                Observation::Accepted {
                    epoch: 1,
                    discontinuity: None
                }
            );
        }
        assert_eq!(rig.monitor.sim_ahead_hits(), 0);
    }

    #[test]
    fn the_shadow_check_runs_only_where_the_former_backlog_check_ran() {
        // A gap takes priority: the frame after it is not checked (as before).
        // The frame's simulation clock is 536 ms ahead of the local clock.
        let mut rig = Rig::settled();
        rig.feed(running_frame(7, 6, 1_000_000), 64 + 400);
        assert_eq!(rig.monitor.last_discontinuity(), Some(Discontinuity::Gap));
        assert_eq!(rig.monitor.sim_ahead_hits(), 0);
        // Without the gap the same lead is a hit.
        let mut rig = Rig::settled();
        rig.feed(running_frame(7, 6, 1_000_000), 80);
        assert_eq!(rig.monitor.sim_ahead_hits(), 1);
        assert_eq!(rig.monitor.epoch(), 1);
    }

    #[test]
    fn an_old_epoch_can_never_come_back() {
        let mut rig = Rig::settled();
        let mut seen = vec![rig.monitor.epoch()];
        rig.run(8, 1, 80); // session change
        seen.push(rig.monitor.epoch());
        rig.feed(paused_frame(8, 2, 96_000), 96);
        seen.push(rig.monitor.epoch());
        rig.run(8, 3, 700); // gap
        seen.push(rig.monitor.epoch());
        assert!(seen.windows(2).all(|w| w[0] < w[1]), "{seen:?}");
    }

    #[test]
    fn the_shared_fixture_becomes_usable_through_the_real_decode_path() {
        let mut rig = Rig::new();
        let decoded = proto::decode_frame(FULL.as_bytes()).unwrap();
        for i in 0..5u64 {
            let mut frame = decoded.frame.clone();
            frame.sequence += i;
            frame.simulation_time_us = Some(98_765_432 + i * 16_000);
            rig.feed(frame, i * 16);
        }
        let s = rig.sample(64);
        assert_eq!(s.state.speed_mps, 22.5);
        assert_eq!(s.state.identity.session, 4_242_424_242);
        assert_eq!(s.state.identity.sequence, 1238);
        assert_eq!(s.epoch, 1);
    }

    // ---- R2: absolute age from the QPC stamps ----

    fn frequency() -> u64 {
        qpc::frequency().expect("QPC on the test machine")
    }

    /// A running frame produced `delay` before it was sent (and received).
    fn delayed(session: u64, seq: u64, at_ms: u64, delay_ticks: u64) -> TelemetryFrame {
        let mut f = running_frame(session, seq, at_ms * 1_000);
        f.produced_qpc = Some(1_000_000);
        f.sent_qpc = Some(1_000_000 + delay_ticks);
        f
    }

    #[test]
    fn a_running_frame_without_qpc_stamps_is_clock_missing_and_never_usable() {
        let mut rig = Rig::new();
        for i in 0..10 {
            let mut f = running_frame(7, i + 1, i * 16_000);
            f.produced_qpc = None;
            f.sent_qpc = None;
            f.qpc_frequency = None;
            let observation = rig.feed(f, i * 16);
            assert_eq!(
                observation,
                Observation::Invalid(InvalidFrame::ClockMissing(Stamp::Produced))
            );
        }
        assert_eq!(
            rig.unusable(150),
            Unusable::Invalid(InvalidFrame::ClockMissing(Stamp::Produced))
        );
        // A missing receive stamp (no clock in this process) is just as unusable.
        let mut rig = Rig::new();
        let received = ReceivedTelemetryFrame {
            frame: running_frame(7, 1, 0),
            dropped_fields: Vec::new(),
            received_at: rig.at(0),
            received_qpc: None,
        };
        assert_eq!(
            rig.monitor.observe(&received),
            Observation::Invalid(InvalidFrame::ClockMissing(Stamp::Received))
        );
    }

    #[test]
    fn invalid_qpc_stamps_are_clock_invalid_and_never_usable() {
        let mut rig = Rig::new();
        // Sent before it was produced.
        let mut backwards = running_frame(7, 1, 0);
        backwards.produced_qpc = Some(500);
        backwards.sent_qpc = Some(400);
        assert_eq!(
            rig.feed(backwards, 0),
            Observation::Invalid(InvalidFrame::ClockInvalid(TimingError::NotMonotonic {
                earlier: Stamp::Produced,
                later: Stamp::Sent
            }))
        );
        // A different QPC frequency: not one clock.
        let mut foreign = running_frame(7, 2, 16_000);
        foreign.qpc_frequency = Some(frequency() + 1);
        assert!(matches!(
            rig.feed(foreign, 16),
            Observation::Invalid(InvalidFrame::ClockInvalid(
                TimingError::FrequencyMismatch { .. }
            ))
        ));
        assert!(matches!(
            rig.unusable(20),
            Unusable::Invalid(InvalidFrame::ClockInvalid(_))
        ));
    }

    #[test]
    fn frames_200_ms_old_on_arrival_are_never_fresh() {
        // A constant 200 ms delay before the receive (blocked plugin or a full pipe): the
        // receive time alone would look fresh; the absolute age never does.
        let delay = frequency() / 5;
        let mut rig = Rig::new();
        for i in 0..100 {
            rig.feed(delayed(7, i + 1, i * 16, delay), i * 16);
            let unusable = rig.unusable(i * 16);
            assert!(
                matches!(unusable, Unusable::Stale { age } if age >= ms(200)),
                "frame {i}: {unusable:?}"
            );
        }
    }

    #[test]
    fn the_150_ms_limit_applies_to_the_absolute_age_to_the_microsecond() {
        // Frames produced 50 ms before they are received: the limit is reached 100 ms after
        // the newest one was received, not 150 ms after.
        let delay = frequency() / 20;
        let produced_before = ticks_to_age(delay);
        assert_eq!(produced_before, ms(50));
        let mut rig = Rig::new();
        for i in 0..5 {
            rig.feed(delayed(7, i + 1, i * 16, delay), i * 16);
        }
        let newest = rig.at(64);
        let sample = rig
            .monitor
            .assess(newest + ms(100))
            .usable()
            .expect("exactly 150 ms is still usable");
        assert_eq!(sample.age, ms(150));
        assert_eq!(
            rig.monitor
                .assess(newest + ms(100) + Duration::from_micros(1)),
            Assessment::Unusable(Unusable::Stale {
                age: ms(150) + Duration::from_micros(1)
            })
        );
        // The limit itself is unchanged.
        assert_eq!(FreshnessConfig::default().max_age(), ms(150));
        assert_eq!(DEFAULT_MAX_AGE, ms(150));
    }

    fn ticks_to_age(ticks: u64) -> Duration {
        qpc::ticks_to_duration(ticks, frequency()).unwrap()
    }

    #[test]
    fn a_paused_frame_without_stamps_is_still_recognised_as_paused() {
        let mut rig = Rig::settled();
        let mut f = paused_frame(7, 6, 80_000);
        f.produced_qpc = None;
        assert!(matches!(rig.feed(f, 80), Observation::Accepted { .. }));
        assert_eq!(rig.unusable(90), Unusable::Paused);
    }

    // ---- latency backlog: transport or age at receive above 50 ms (replaces R7) ----

    /// QPC value the game "produces" the latency test frames at.
    const PRODUCED_QPC: u64 = 1_000_000_000;

    fn qpc_ticks(d: Duration) -> u64 {
        u64::try_from(d.as_nanos() * u128::from(frequency()) / 1_000_000_000).unwrap()
    }

    impl Rig {
        /// Feeds `frame` received `received_us` after the origin, `processing` after it was
        /// produced and `transport` after it was sent (QPC stamps accordingly).
        fn feed_timed(
            &mut self,
            mut frame: TelemetryFrame,
            received_us: u64,
            processing: Duration,
            transport: Duration,
        ) -> Observation {
            let sent = PRODUCED_QPC + qpc_ticks(processing);
            frame.produced_qpc = Some(PRODUCED_QPC);
            frame.sent_qpc = Some(sent);
            frame.qpc_frequency = Some(frequency());
            let received = ReceivedTelemetryFrame {
                frame,
                dropped_fields: Vec::new(),
                received_at: self.t0 + Duration::from_micros(received_us),
                received_qpc: Some(sent + qpc_ticks(transport)),
            };
            self.monitor.observe(&received)
        }

        /// A running frame received at `at_ms` with the given transport latency.
        fn transport(
            &mut self,
            session: u64,
            seq: u64,
            at_ms: u64,
            transport: Duration,
        ) -> Observation {
            let frame = running_frame(session, seq, at_ms * 1_000);
            self.feed_timed(frame, at_ms * 1_000, Duration::ZERO, transport)
        }

        /// A running frame received at `at_ms` that waited `processing` in the plugin before
        /// it was sent (transport 0): only its age at receive is high.
        fn processing(
            &mut self,
            session: u64,
            seq: u64,
            at_ms: u64,
            processing: Duration,
        ) -> Observation {
            let frame = running_frame(session, seq, at_ms * 1_000);
            self.feed_timed(frame, at_ms * 1_000, processing, Duration::ZERO)
        }
    }

    const NO_EPOCH: Observation = Observation::Accepted {
        epoch: 1,
        discontinuity: None,
    };

    fn latency_epoch(epoch: u64) -> Observation {
        Observation::Accepted {
            epoch,
            discontinuity: Some(Discontinuity::LatencyBacklog),
        }
    }

    #[test]
    fn test_helpers_produce_exact_latencies() {
        // The 49/50/51 ms cases depend on an exact conversion.
        for n in [20, 49, 50, 51, 60, 120, 300] {
            assert_eq!(ticks_to_age(qpc_ticks(ms(n))), ms(n), "{n} ms");
        }
    }

    #[test]
    fn single_outliers_of_20_49_and_50_ms_start_no_epoch_51_ms_starts_exactly_one() {
        // Tests 7-10, for both measures: transport, and the age at receive (plugin delay).
        for measure in ["transport", "ageAtReceive"] {
            for (latency, expected_epochs) in [(20, 1), (49, 1), (50, 1), (51, 2)] {
                let mut rig = Rig::settled();
                let observation = if measure == "transport" {
                    rig.transport(7, 6, 80, ms(latency))
                } else {
                    rig.processing(7, 6, 80, ms(latency))
                };
                if expected_epochs == 1 {
                    assert_eq!(observation, NO_EPOCH, "{measure} {latency} ms");
                } else {
                    assert_eq!(observation, latency_epoch(2), "{measure} {latency} ms");
                }
                // Normal frames afterwards: no further epoch.
                for k in 1..=10u64 {
                    rig.run(7, 6 + k, 80 + 16 * k);
                }
                assert_eq!(
                    rig.monitor.epoch(),
                    expected_epochs,
                    "{measure} {latency} ms"
                );
                assert!(rig.assess(240).usable().is_some(), "{measure} {latency} ms");
            }
        }
    }

    #[test]
    fn a_120_ms_pipe_stall_is_a_latency_backlog() {
        // Test 4. The frame produced at 80 ms waits 120 ms in the pipe; the receive gap (136
        // ms) stays below the 150 ms gap limit, so the latency check reports it.
        let mut rig = Rig::settled();
        let stalled = running_frame(7, 6, 80_000);
        assert_eq!(
            rig.feed_timed(stalled, 200_000, Duration::ZERO, ms(120)),
            latency_epoch(2)
        );
        // A second frame queued behind it, still late: same run, no further epoch.
        let queued = running_frame(7, 7, 96_000);
        assert_eq!(
            rig.feed_timed(queued, 201_000, Duration::ZERO, ms(105)),
            Observation::Accepted {
                epoch: 2,
                discontinuity: None
            }
        );
        assert_eq!(rig.unusable(201), Unusable::Settling);
        let usable_at = rig.settle_again(7, 7, 201);
        assert_eq!(rig.sample(usable_at).epoch, 2);
        assert_eq!(rig.monitor.epoch(), 2, "exactly one epoch");
    }

    #[test]
    fn a_300_ms_pipe_stall_is_reported_as_a_gap_and_not_again_as_latency() {
        // Test 3. The receive gap exceeds 150 ms: the gap has priority. The late frames still
        // form a run, so no second epoch follows.
        let mut rig = Rig::settled();
        let stalled = running_frame(7, 6, 80_000);
        assert_eq!(
            rig.feed_timed(stalled, 380_000, Duration::ZERO, ms(300)),
            Observation::Accepted {
                epoch: 2,
                discontinuity: Some(Discontinuity::Gap)
            }
        );
        let queued = running_frame(7, 7, 96_000);
        assert_eq!(
            rig.feed_timed(queued, 381_000, Duration::ZERO, ms(285)),
            Observation::Accepted {
                epoch: 2,
                discontinuity: None
            }
        );
        let usable_at = rig.settle_again(7, 7, 381);
        assert_eq!(rig.sample(usable_at).epoch, 2);
        assert_eq!(rig.monitor.epoch(), 2, "exactly one epoch");
        assert_eq!(rig.monitor.last_discontinuity(), Some(Discontinuity::Gap));
    }

    #[test]
    fn a_constant_60_ms_transport_latency_raises_one_epoch_and_is_never_usable() {
        // Test 5: 100 frames at 60 Hz, each 60 ms in the pipe.
        let mut rig = Rig::settled();
        for k in 1..=100u64 {
            let at = 64 + 16 * k;
            let observation = rig.transport(7, 5 + k, at, ms(60));
            if k == 1 {
                assert_eq!(observation, latency_epoch(2));
            } else {
                assert_eq!(
                    observation,
                    Observation::Accepted {
                        epoch: 2,
                        discontinuity: None
                    },
                    "frame {k}"
                );
            }
            assert_eq!(rig.monitor.streak.frames, 0, "settling reset by frame {k}");
            assert_eq!(rig.unusable(at), Unusable::Settling, "frame {k}");
            assert_eq!(rig.unusable(at + 15), Unusable::Settling, "frame {k}");
        }
        assert_eq!(rig.monitor.epoch(), 2, "exactly one epoch");
        // The run ends with the first frame within both limits; settling starts over.
        rig.run(7, 106, 64 + 16 * 101);
        let usable_at = rig.settle_again(7, 106, 64 + 16 * 101);
        assert_eq!(rig.sample(usable_at).epoch, 2);
    }

    #[test]
    fn a_blocked_plugin_write_is_detected_by_transport_or_by_age() {
        // Test 6. The plugin stamps `sentQpc` immediately before its write.
        // (a) The write blocks 80 ms: the transport shows it; then the frame the plugin kept
        //     (it replaces unsent frames) arrives on time.
        let mut rig = Rig::settled();
        let blocked = running_frame(7, 6, 80_000);
        assert_eq!(
            rig.feed_timed(blocked, 160_000, Duration::ZERO, ms(80)),
            latency_epoch(2)
        );
        let kept = running_frame(7, 10, 150_000);
        assert_eq!(
            rig.feed_timed(kept, 161_000, ms(10), ms(1)),
            Observation::Accepted {
                epoch: 2,
                discontinuity: None
            }
        );
        // (b) The worker is blocked before it stamps `sentQpc`: only the age at receive
        //     shows the delay.
        let mut rig = Rig::settled();
        assert_eq!(rig.processing(7, 6, 141, ms(61)), latency_epoch(2));
        assert_eq!(rig.monitor.epoch(), 2);
    }

    #[test]
    fn frames_without_a_valid_clock_are_invalid_and_never_a_latency_epoch() {
        // Tests 11 and 12: R2 decides (invalid frame), the latency check does not run.
        let mut rig = Rig::settled();
        let mut missing = running_frame(7, 6, 80_000);
        missing.produced_qpc = None;
        assert_eq!(
            rig.feed(missing, 80),
            Observation::Invalid(InvalidFrame::ClockMissing(Stamp::Produced))
        );
        assert_eq!(
            rig.monitor.last_discontinuity(),
            Some(Discontinuity::InvalidFrame)
        );
        let mut invalid = running_frame(7, 7, 96_000);
        invalid.produced_qpc = Some(500);
        invalid.sent_qpc = Some(400);
        assert!(matches!(
            rig.feed(invalid, 96),
            Observation::Invalid(InvalidFrame::ClockInvalid(_))
        ));
        assert!(matches!(
            rig.unusable(96),
            Unusable::Invalid(InvalidFrame::ClockInvalid(_))
        ));
        assert_eq!(
            rig.monitor.epoch(),
            2,
            "one invalid-frame epoch, no latency epoch"
        );
        assert_eq!(
            rig.monitor.last_discontinuity(),
            Some(Discontinuity::InvalidFrame)
        );
    }

    #[test]
    fn a_frame_without_a_valid_clock_neither_starts_nor_ends_a_run() {
        let mut rig = Rig::settled();
        assert_eq!(rig.transport(7, 6, 80, ms(60)), latency_epoch(2));
        // A paused frame without stamps (accepted, latency unknown) enters pause ...
        let mut unknown = paused_frame(7, 7, 96_000);
        unknown.produced_qpc = None;
        assert_eq!(
            rig.feed(unknown, 96),
            Observation::Accepted {
                epoch: 3,
                discontinuity: Some(Discontinuity::Paused)
            }
        );
        // ... and leaves the run open: the next late frame starts no new epoch.
        assert_eq!(
            rig.transport(7, 8, 112, ms(60)),
            Observation::Accepted {
                epoch: 3,
                discontinuity: None
            }
        );
        // A frame within both limits ends the run; the next late frame starts a new one.
        rig.run(7, 9, 128);
        assert_eq!(rig.transport(7, 10, 144, ms(60)), latency_epoch(4));
    }

    #[test]
    fn pause_epochs_are_kept_and_a_late_paused_frame_starts_a_latency_epoch() {
        // Test 13.
        let mut rig = Rig::settled();
        let pause = paused_frame(7, 6, 80_000);
        assert_eq!(
            rig.feed_timed(pause, 80_000, Duration::ZERO, ms(2)),
            Observation::Accepted {
                epoch: 2,
                discontinuity: Some(Discontinuity::Paused)
            }
        );
        // A paused frame 60 ms in the pipe: a latency epoch; still paused.
        let late = paused_frame(7, 7, 96_000);
        assert_eq!(
            rig.feed_timed(late, 96_000, Duration::ZERO, ms(60)),
            latency_epoch(3)
        );
        assert_eq!(rig.unusable(96), Unusable::Paused);
        // Resuming on time: no further epoch, settling as after every pause.
        rig.run(7, 8, 112);
        assert_eq!(rig.monitor.epoch(), 3);
        assert_eq!(rig.unusable(112), Unusable::Settling);
        let usable_at = rig.settle_again(7, 8, 112);
        assert_eq!(rig.sample(usable_at).epoch, 3);
        // Entering a pause on time is still exactly one pause epoch.
        let pause_at = (usable_at + 16) * 1_000;
        rig.feed_timed(
            paused_frame(7, 30, pause_at),
            pause_at,
            Duration::ZERO,
            ms(1),
        );
        assert_eq!(
            rig.monitor.last_discontinuity(),
            Some(Discontinuity::Paused)
        );
        assert_eq!(rig.monitor.epoch(), 4);
    }

    #[test]
    fn a_session_change_is_reported_first_and_the_old_session_stays_refused() {
        // Test 14, during a run of late frames.
        let mut rig = Rig::settled();
        assert_eq!(rig.transport(7, 6, 80, ms(60)), latency_epoch(2));
        assert_eq!(
            rig.transport(8, 1, 96, ms(60)),
            Observation::Accepted {
                epoch: 3,
                discontinuity: Some(Discontinuity::SessionChanged)
            }
        );
        assert_eq!(
            rig.run(7, 7, 112),
            Observation::Rejected(Rejection::RetiredSession)
        );
        assert_eq!(rig.monitor.epoch(), 3);
        let usable_at = rig.settle_again(8, 1, 112);
        assert_eq!(rig.sample(usable_at).state.identity.session, 8);
    }

    #[test]
    fn the_end_of_the_game_keeps_every_epoch() {
        // Test 15: the frames stop. The state goes stale; no epoch is added or removed.
        let mut rig = Rig::settled();
        assert_eq!(rig.transport(7, 6, 80, ms(60)), latency_epoch(2));
        let usable_at = {
            rig.run(7, 7, 96);
            rig.settle_again(7, 7, 96)
        };
        assert_eq!(rig.monitor.epoch(), 2);
        assert!(matches!(
            rig.unusable(usable_at + 1_000),
            Unusable::Stale { .. }
        ));
        assert_eq!(rig.monitor.epoch(), 2);
        assert_eq!(
            rig.monitor.last_discontinuity(),
            Some(Discontinuity::LatencyBacklog)
        );
    }

    #[test]
    fn steady_60_and_144_hz_streams_with_up_to_20_ms_latency_never_trigger() {
        // Test 17: 10 s each; transport and plugin processing vary between 0 and 20 ms in
        // total (age at receive at most 20 ms).
        for hz in [60u64, 144] {
            let mut rig = Rig::new();
            let period_us = 1_000_000 / hz;
            for n in 0..hz * 10 {
                let at_us = n * period_us;
                let transport = Duration::from_micros((n * 7_919) % 12_001); // 0..=12 ms
                let processing = Duration::from_micros((n * 104_729) % 8_001); // 0..=8 ms
                let frame = running_frame(7, n + 1, at_us);
                let observation = rig.feed_timed(frame, at_us, processing, transport);
                if n > 0 {
                    assert_eq!(observation, NO_EPOCH, "{hz} Hz frame {n}");
                }
            }
            assert_eq!(rig.monitor.epoch(), 1, "{hz} Hz");
            assert_eq!(rig.monitor.sim_ahead_hits(), 0, "{hz} Hz");
            let end = rig.t0 + Duration::from_micros((hz * 10 - 1) * period_us);
            assert!(rig.monitor.assess(end).usable().is_some(), "{hz} Hz");
        }
    }
}
