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
//! * **Age** is measured with the monotonic local receive time of the newest accepted frame,
//!   never with simulation time. Data older than the limit (default 150 ms, at most 200 ms)
//!   is unusable.
//! * **Ordering** uses `(session, sequence)` only. Repeated and older frames, and frames whose
//!   receive time goes backwards, are rejected and do **not** refresh freshness.
//! * **Simulation time** is a cross-check, never an ordering or age source: a clock that
//!   stops while frames keep arriving means a frozen game, and a clock that runs ahead of the
//!   local clock within a short window means frames are being read from a backlog.
//! * **Epochs.** Every event after which control must not continue unchanged increments the
//!   epoch counter: first frame, new session, game change, entering pause, a gap longer than
//!   the age limit (which is how a reconnect looks), a simulation clock restart, a detected
//!   backlog and an invalid frame. A controller arms for one specific epoch. Because the
//!   counter can only grow, a reconnect or a pause can never silently restore control, even
//!   if the caller was not looking at the moment of the interruption.
//! * **Settling.** After any epoch change, and after a pause or an invalid frame, a few
//!   consecutive good frames over a short time are required before the state is usable.
//!
//! The thresholds are conservative and have **not** been tuned against a live game. They may
//! only make the system stricter; they must not be loosened without live measurements.

use super::vehicle::{FrameIdentity, InvalidFrame, VehicleState};
use roadpilot_telemetry_client::{PluginState, ReceivedTelemetryFrame};
use std::time::{Duration, Instant};

/// Default maximum age of the newest accepted frame. A healthy plugin delivers a frame about
/// every 16 ms, so this tolerates several missed frames but not a real interruption.
pub const DEFAULT_MAX_AGE: Duration = Duration::from_millis(150);
/// Configurable range of the age limit. Values outside are refused, not clamped.
pub const MIN_MAX_AGE: Duration = Duration::from_millis(50);
pub const MAX_MAX_AGE: Duration = Duration::from_millis(200);

/// Good consecutive frames and local time span required after any epoch change.
const SETTLE_FRAMES: u32 = 3;
const SETTLE_TIME: Duration = Duration::from_millis(50);
/// The simulation clock may run ahead of the local clock by this much within one window
/// before frames are considered to come from a backlog.
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
    /// The simulation clock ran ahead of the local clock: frames were read from a backlog.
    Backlog,
    /// A frame was unusable (see [`Observation::Invalid`]).
    InvalidFrame,
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
    /// Local time since the frame was received.
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
    paused: bool,
    /// Local time at which the simulation clock last advanced.
    sim_advanced_at: Instant,
    /// Reference point of the backlog check; renewed every [`BACKLOG_WINDOW`].
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
        }
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

    fn classify(&self, id: &FrameIdentity, at: Instant, paused: bool) -> Option<Discontinuity> {
        let Some(t) = &self.track else {
            return Some(Discontinuity::FirstFrame);
        };
        if t.identity.session != id.session {
            Some(Discontinuity::SessionChanged)
        } else if t.identity.game != id.game {
            Some(Discontinuity::GameChanged)
        } else if at.saturating_duration_since(t.received_at) > self.config.max_age {
            Some(Discontinuity::Gap)
        } else if id.simulation_time_us < t.identity.simulation_time_us {
            Some(Discontinuity::SimulationTimeRestarted)
        } else if backlog(t, id, at) {
            Some(Discontinuity::Backlog)
        } else if paused && !t.paused {
            Some(Discontinuity::Paused)
        } else {
            None
        }
    }

    /// Feeds one received frame. Call it for every frame, in receive order.
    pub fn observe(&mut self, received: &ReceivedTelemetryFrame) -> Observation {
        let frame = &received.frame;
        let at = received.received_at;

        let identity = match FrameIdentity::from_frame(frame) {
            Ok(identity) => identity,
            Err(reason) => return self.reject_invalid(reason),
        };

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

        let paused = frame.plugin_state == PluginState::Paused;
        let state = if paused {
            None
        } else {
            match VehicleState::from_frame(frame) {
                Ok(state) => Some(state),
                Err(reason) => return self.reject_invalid(reason),
            }
        };

        let discontinuity = self.classify(&identity, at, paused);
        if let Some(cause) = discontinuity {
            self.bump(cause);
        }
        self.invalid = None;

        let previous = self.track;
        let sim = identity.simulation_time_us;
        let renew_window = discontinuity.is_some()
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

        if paused {
            self.streak = Streak::default();
        } else {
            self.streak.frames = self.streak.frames.saturating_add(1);
            self.streak.started_at.get_or_insert(at);
        }
        self.latest = state;
        self.track = Some(Track {
            identity,
            received_at: at,
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
        let age = now.saturating_duration_since(t.received_at);
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

/// True if, since the window started, the simulation clock advanced more than the local clock
/// plus the tolerance. Sustained normal drift between the clocks stays far below the
/// tolerance within one window; a burst of buffered frames does not.
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
            let received = ReceivedTelemetryFrame {
                frame,
                dropped_fields: Vec::new(),
                received_at: self.at(at_ms),
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
    fn returning_to_an_older_session_is_another_new_epoch() {
        let mut rig = Rig::settled();
        rig.run(8, 1, 80);
        assert_eq!(
            rig.run(7, 6, 96),
            Observation::Accepted {
                epoch: 3,
                discontinuity: Some(Discontinuity::SessionChanged)
            }
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

    #[test]
    fn a_burst_of_buffered_frames_is_detected_as_a_backlog() {
        let mut rig = Rig::settled(); // window starts at 0 ms
        // Twenty frames read back to back at 70 ms, but produced 16 ms apart.
        let mut detected_at = None;
        for k in 1..=20u64 {
            let observation = rig.feed(running_frame(7, 5 + k, (64 + 16 * k) * 1_000), 70);
            if let Observation::Accepted {
                discontinuity: Some(Discontinuity::Backlog),
                ..
            } = observation
            {
                detected_at = Some(k);
                break;
            }
        }
        // The clock must have run more than 170 ms ahead: 64 + 16k > 170, so k = 7.
        assert_eq!(detected_at, Some(7));
        assert_eq!(rig.monitor.epoch(), 2);
        assert_eq!(rig.unusable(70), Unusable::Settling);
    }

    #[test]
    fn a_short_normal_burst_is_not_a_backlog() {
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
}
