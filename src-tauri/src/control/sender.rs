//! The control core: vehicle state, freshness, supervisor, command generation, encoding and
//! the dry-run sink behind one deterministic interface.
//!
//! The core owns no clock, task or I/O. A driver (see `runtime`) feeds it every telemetry
//! frame with [`ControlCore::on_frame`], every operator command with
//! [`ControlCore::on_command`], and calls [`ControlCore::tick`] on each 40 ms deadline of its
//! [`Scheduler`]. That makes every behaviour below testable with explicit times.
//!
//! # What a tick does, in this order
//!
//! 1. Consumes the watchdog's trip flag: a silent supervisor loop is a safety event.
//! 2. Measures timing against the scheduler: a gap over the limit is a safety event.
//! 3. Assesses the vehicle state at `now` and updates the supervisor.
//! 4. Records the heartbeat the independent watchdog observes.
//! 5. Only if the supervisor now permits output: asks the request source for a request,
//!    bounds it, encodes it and hands it to the sink. Otherwise, if a command had been encoded
//!    since the last disarm, encodes exactly one disarm message.
//!
//! # Guarantees
//!
//! * **Nothing stale is ever sent.** A command is produced only inside a tick from the vehicle
//!   state of that tick; it is never stored, queued or repeated. After any fault the only
//!   message that can follow is a single disarm.
//! * **Dry-run only.** The sink discards every message; see `sink`.
//! * **Truthful reporting.** Logs and reports say "encoded, not transmitted"; no value can say
//!   "delivered".
//! * **Disarm is reliable.** It is encoded immediately on a manual disarm, on any fault, on
//!   shutdown, and, as a last resort, when the core is dropped (for example when its task is
//!   aborted).

use super::command::{Adjustments, CommandGenerator, ControlLimits, ControlRequest, Withheld};
use super::freshness::{
    Assessment, Discontinuity, FrameDigest, FreshnessConfig, FreshnessMonitor, Observation,
    Unusable,
};
use super::log::{
    Bounded, ControlLog, DecisionEvent, DisarmStatus, MessageKind, MessageRecord, TimingEvent,
};
use super::protocol::{WireMessage, encode};
use super::schedule::{Scheduler, Timing, Verdict};
use super::sink::{Delivery, DryRunSink, MessageSink, OperatingMode};
use super::status::{ControlStatus, RECENT_DECISIONS, StatusInput};
use super::supervisor::{
    Command, Reason, Response, SafetyEvent, Supervisor, SupervisorConfig, Transition,
};
use super::timing::{TimerKind, TimingStats};
use super::vehicle::VehicleState;
use super::watchdog::{Heartbeat, TripFlag};
use roadpilot_telemetry_client::ReceivedTelemetryFrame;
use std::time::{Duration, Instant};

/// What the controller wants this tick. In this phase no controller exists; the runtime uses
/// [`NeutralRequests`].
pub trait RequestSource: Send {
    fn next_request(&mut self, state: &VehicleState) -> ControlRequest;
}

/// Asks for nothing: no steering claim, no throttle, no brake.
#[derive(Clone, Copy, Debug, Default)]
pub struct NeutralRequests;

impl RequestSource for NeutralRequests {
    fn next_request(&mut self, _state: &VehicleState) -> ControlRequest {
        ControlRequest {
            steering: None,
            throttle: 0.0,
            brake: 0.0,
        }
    }
}

#[derive(Clone, Copy, Debug, Default)]
pub struct CoreConfig {
    pub freshness: FreshnessConfig,
    pub supervisor: SupervisorConfig,
    pub limits: ControlLimits,
    /// Which timer drives the ticks; reported in the timing statistics only.
    pub timer: TimerKind,
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct CoreStats {
    pub frames_accepted: u64,
    pub frames_rejected: u64,
    pub frames_invalid: u64,
    pub ticks: u64,
    pub commands_encoded: u64,
    pub disarms_encoded: u64,
}

/// What one tick did.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct TickReport {
    pub timing: Timing,
    /// The first supervisor state change of this tick, if any.
    pub transition: Option<Transition>,
    pub command_encoded: bool,
    pub disarm_encoded: bool,
    /// Why no command was produced although the supervisor was Active.
    pub withheld: Option<Withheld>,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct ShutdownReport {
    pub transition: Option<Transition>,
    pub disarm: DisarmStatus,
}

/// What a tick did with its output.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum TickOutcome {
    /// Not Active and no disarm owed: nothing to do.
    Idle,
    /// A command was generated, bounded and encoded (and, in dry-run, not transmitted).
    CommandEncoded,
    /// The owed disarm was encoded.
    DisarmEncoded,
    /// Active, but no command could be produced.
    Withheld(Withheld),
}

pub struct ControlCore<S: MessageSink> {
    monitor: FreshnessMonitor,
    supervisor: Supervisor,
    generator: CommandGenerator,
    scheduler: Scheduler,
    sink: S,
    source: Box<dyn RequestSource>,
    log: ControlLog,
    heartbeat: Heartbeat,
    trip: TripFlag,
    /// A command has been encoded since the last disarm, so a disarm is still owed.
    wire_armed: bool,
    last_withheld: Option<Withheld>,
    last_frame_invalid: bool,
    feed_lost: bool,
    stats: CoreStats,
    last_now: Instant,
    // What the status display shows. Recorded where it happens; never used for decisions.
    start: Instant,
    last_tick: Option<(Timing, TickOutcome, Instant)>,
    last_transition: Option<(Transition, Instant)>,
    last_safety_event: Option<(SafetyEvent, Instant)>,
    last_message: Option<(MessageRecord, Instant)>,
    watchdog_trips: u64,
    last_watchdog_trip: Option<(Duration, Instant)>,
    timing: TimingStats,
    tick_started: Option<Instant>,
    last_command_at: Option<Instant>,
    /// Kind of the last assessment handed to the log observer (diagnostics only).
    last_assessment: Option<AssessmentKey>,
}

impl ControlCore<DryRunSink> {
    /// The only way to build a core in this phase: dry-run.
    pub fn dry_run(
        config: CoreConfig,
        source: Box<dyn RequestSource>,
        log: ControlLog,
        heartbeat: Heartbeat,
        trip: TripFlag,
        start: Instant,
    ) -> Self {
        Self::with_sink(config, DryRunSink, source, log, heartbeat, trip, start)
    }
}

impl<S: MessageSink> ControlCore<S> {
    fn with_sink(
        config: CoreConfig,
        sink: S,
        source: Box<dyn RequestSource>,
        log: ControlLog,
        heartbeat: Heartbeat,
        trip: TripFlag,
        start: Instant,
    ) -> Self {
        Self {
            monitor: FreshnessMonitor::new(config.freshness),
            supervisor: Supervisor::new(config.supervisor),
            generator: CommandGenerator::new(config.limits),
            scheduler: Scheduler::new(start),
            sink,
            source,
            log,
            heartbeat,
            trip,
            wire_armed: false,
            last_withheld: None,
            last_frame_invalid: false,
            feed_lost: false,
            stats: CoreStats::default(),
            last_now: start,
            start,
            last_tick: None,
            last_transition: None,
            last_safety_event: None,
            last_message: None,
            watchdog_trips: 0,
            last_watchdog_trip: None,
            timing: TimingStats::new(config.timer),
            tick_started: None,
            last_command_at: None,
            last_assessment: None,
        }
    }

    pub fn mode(&self) -> OperatingMode {
        self.sink.mode()
    }

    pub fn state(&self) -> super::supervisor::State {
        self.supervisor.state()
    }

    pub fn permits_output(&self) -> bool {
        self.supervisor.permits_output()
    }

    pub fn epoch(&self) -> u64 {
        self.monitor.epoch()
    }

    pub fn stats(&self) -> CoreStats {
        self.stats
    }

    pub fn log(&self) -> &ControlLog {
        &self.log
    }

    pub fn next_deadline(&self) -> Instant {
        self.scheduler.next_deadline()
    }

    /// The runtime reports when the work of the current tick was finished, so the processing
    /// duration is measured on the real clock rather than assumed.
    pub fn tick_finished(&mut self, at: Instant) {
        if let Some(started) = self.tick_started.take() {
            self.timing
                .processing
                .record(at.saturating_duration_since(started));
        }
    }

    pub fn timing(&self) -> &TimingStats {
        &self.timing
    }

    fn record_timing(&mut self, timing: &Timing, now: Instant) {
        let stats = &mut self.timing;
        stats.ticks += 1;
        stats.lateness.record(timing.lateness);
        if let Some(gap) = timing.gap {
            stats.intervals.record(gap);
        }
        stats.missed_deadlines += u64::from(timing.missed);
        match timing.verdict {
            Verdict::OnTime => {}
            Verdict::Late | Verdict::DeadlinesMissed => stats.late_ticks += 1,
            Verdict::GapViolation => {
                stats.late_ticks += 1;
                stats.gap_violations += 1;
            }
        }
        self.tick_started = Some(now);
    }

    /// A read-only status snapshot for display. Never used for decisions.
    pub fn status(&self, now: Instant) -> ControlStatus {
        super::status::build(&StatusInput {
            now,
            start: self.start,
            mode: self.sink.mode(),
            state: self.supervisor.state(),
            permits_output: self.supervisor.permits_output(),
            assessment: self.monitor.assess(now),
            epoch: self.monitor.epoch(),
            frame_age: self.monitor.last_frame_age(now),
            feed_lost: self.feed_lost,
            last_transition: self.last_transition,
            last_safety_event: self.last_safety_event,
            last_tick: self.last_tick,
            last_message: self.last_message,
            watchdog_pending: self.trip.is_tripped(),
            watchdog_trips: self.watchdog_trips,
            last_watchdog_trip: self.last_watchdog_trip,
            loop_silent: self.heartbeat.silent_for(now),
            stats: self.stats,
            recent_decisions: self.log.recent_decisions(RECENT_DECISIONS),
            timing: &self.timing,
        })
    }

    fn log_transition(&mut self, now: Instant, transition: Transition) {
        self.log
            .decision(now, DecisionEvent::Transition(transition));
        self.last_transition = Some((transition, now));
        if let Reason::Safety(event) = transition.reason {
            self.last_safety_event = Some((event, now));
        }
    }

    fn report(&mut self, now: Instant, event: SafetyEvent) -> Option<Transition> {
        let transition = self.supervisor.report(event)?;
        self.log_transition(now, transition);
        Some(transition)
    }

    /// Encodes a message, hands it to the sink and logs exactly what happened.
    fn emit(
        &mut self,
        now: Instant,
        message: WireMessage,
        requested: Option<ControlRequest>,
        adjustments: Adjustments,
    ) -> Delivery {
        let bytes = encode(&message);
        let delivery = self.sink.deliver(&bytes);
        let (kind, bounded) = match message {
            WireMessage::Disarm => (MessageKind::Disarm, None),
            WireMessage::Command(c) => (
                MessageKind::Command,
                Some(Bounded {
                    steering: c.steering(),
                    throttle: c.throttle(),
                    brake: c.brake(),
                }),
            ),
        };
        let record = MessageRecord {
            kind,
            bytes,
            requested,
            bounded,
            adjustments,
            delivery,
        };
        self.log.message(now, record);
        self.last_message = Some((record, now));
        delivery
    }

    /// Encodes the owed disarm, once. `None` if no disarm was owed.
    fn flush_disarm(&mut self, now: Instant) -> Option<Delivery> {
        if !self.wire_armed {
            return None;
        }
        self.wire_armed = false;
        self.stats.disarms_encoded += 1;
        Some(self.emit(now, WireMessage::Disarm, None, Adjustments::default()))
    }

    /// Feeds one received telemetry frame. Call it for every frame, in receive order.
    pub fn on_frame(&mut self, received: &ReceivedTelemetryFrame, now: Instant) -> Observation {
        self.on_digest(&FrameDigest::of(received), now)
    }

    /// Feeds the digest of one received frame (see `mailbox`). Identical to
    /// [`ControlCore::on_frame`] on the frame itself.
    pub fn on_digest(&mut self, digest: &FrameDigest, now: Instant) -> Observation {
        self.last_now = now;
        let observation = self.monitor.observe_digest(digest);
        match observation {
            Observation::Accepted {
                epoch,
                discontinuity,
            } => {
                self.stats.frames_accepted += 1;
                self.last_frame_invalid = false;
                if let Some(cause) = discontinuity {
                    self.log
                        .decision(now, DecisionEvent::Epoch { epoch, cause });
                }
            }
            Observation::Rejected(_) => self.stats.frames_rejected += 1,
            Observation::Invalid(reason) => {
                self.stats.frames_invalid += 1;
                // One record per episode of invalid frames, not one per frame.
                if !self.last_frame_invalid {
                    self.log.decision(now, DecisionEvent::FrameInvalid(reason));
                    self.log.decision(
                        now,
                        DecisionEvent::Epoch {
                            epoch: self.monitor.epoch(),
                            cause: super::freshness::Discontinuity::InvalidFrame,
                        },
                    );
                }
                self.last_frame_invalid = true;
            }
        }
        observation
    }

    /// The hand-off from the relay lost items (see `mailbox`): continuity is no longer
    /// known, so a new epoch starts and the state must settle again. The supervisor reacts
    /// through its existing rules (Armed disarms, Active faults).
    pub fn note_handoff_loss(&mut self, now: Instant) {
        self.last_now = now;
        self.monitor.force_epoch(Discontinuity::HandoffOverflow);
        self.log.decision(
            now,
            DecisionEvent::Epoch {
                epoch: self.monitor.epoch(),
                cause: Discontinuity::HandoffOverflow,
            },
        );
    }

    /// The telemetry feed went away or came back. Logged once per change.
    pub fn note_feed(&mut self, connected: bool, now: Instant) {
        self.last_now = now;
        if connected && self.feed_lost {
            self.feed_lost = false;
            self.log.decision(now, DecisionEvent::FeedRestored);
        } else if !connected && !self.feed_lost {
            self.feed_lost = true;
            self.log.decision(now, DecisionEvent::FeedLost);
        }
    }

    /// Processes one operator command against the vehicle state at `now`. A disarm that
    /// results is encoded immediately, not at the next tick.
    pub fn on_command(&mut self, command: Command, now: Instant) -> Response {
        self.last_now = now;
        let assessment = self.monitor.assess(now);
        let response = self.supervisor.command(command, &assessment);
        if let Some(transition) = response.transition {
            self.log_transition(now, transition);
        }
        if let Err(rejection) = response.result {
            self.log
                .decision(now, DecisionEvent::CommandRejected { command, rejection });
        }
        if !self.supervisor.permits_output() {
            self.flush_disarm(now);
        }
        response
    }

    /// Runs one control tick at `now`. See the module documentation for the order.
    pub fn tick(&mut self, now: Instant) -> TickReport {
        self.last_now = now;
        self.stats.ticks += 1;
        let mut transition: Option<Transition> = None;

        // 1. The independent watchdog saw this loop silent.
        if let Some(silent_for) = self.trip.take() {
            self.watchdog_trips += 1;
            self.last_watchdog_trip = Some((silent_for, now));
            let t = self.report(now, SafetyEvent::SupervisorTimeout { silent_for });
            transition = transition.or(t);
        }

        // 2. Timing.
        let timing = self.scheduler.on_tick(now);
        self.record_timing(&timing, now);
        match timing.verdict {
            Verdict::OnTime => {}
            Verdict::Late => self.log.timing(
                now,
                TimingEvent::Late {
                    lateness: timing.lateness,
                },
            ),
            Verdict::DeadlinesMissed => self.log.timing(
                now,
                TimingEvent::DeadlinesMissed {
                    missed: timing.missed,
                    lateness: timing.lateness,
                },
            ),
            Verdict::GapViolation => {
                let gap = timing.gap.unwrap_or_default();
                self.log.timing(
                    now,
                    TimingEvent::GapViolation {
                        gap,
                        missed: timing.missed,
                    },
                );
                let t = self.report(now, SafetyEvent::SenderTiming { gap });
                transition = transition.or(t);
            }
        }

        // 3. Vehicle assessment and supervisor.
        let assessment = self.monitor.assess(now);
        let key = AssessmentKey::of(&assessment);
        if self.last_assessment != Some(key) {
            self.last_assessment = Some(key);
            self.log.assessment(now, assessment);
        }
        if let Some(t) = self.supervisor.update(&assessment) {
            self.log_transition(now, t);
            transition = transition.or(Some(t));
        }

        // 4. The heartbeat the independent watchdog observes.
        self.heartbeat.beat(now);

        // 5. Output.
        let mut command_encoded = false;
        let mut withheld = None;
        if self.supervisor.permits_output() {
            match self.produce(now, &assessment, &mut transition) {
                Ok(()) => command_encoded = true,
                Err(reason) => withheld = Some(reason),
            }
        }
        let disarm_encoded = if self.supervisor.permits_output() {
            false
        } else {
            self.flush_disarm(now).is_some()
        };
        let outcome = match (command_encoded, withheld, disarm_encoded) {
            (true, _, _) => TickOutcome::CommandEncoded,
            (false, Some(reason), _) => TickOutcome::Withheld(reason),
            (false, None, true) => TickOutcome::DisarmEncoded,
            (false, None, false) => TickOutcome::Idle,
        };
        self.last_tick = Some((timing, outcome, now));
        if command_encoded {
            if let Some(previous) = self.last_command_at {
                self.timing
                    .command_intervals
                    .record(now.saturating_duration_since(previous));
            }
            self.last_command_at = Some(now);
        } else {
            // The refresh sequence ends; the next command starts a new one.
            self.last_command_at = None;
        }
        TickReport {
            timing,
            transition,
            command_encoded,
            disarm_encoded,
            withheld,
        }
    }

    /// Produces and encodes this tick's command. Only called while the supervisor is Active.
    fn produce(
        &mut self,
        now: Instant,
        assessment: &Assessment,
        transition: &mut Option<Transition>,
    ) -> Result<(), Withheld> {
        let Some(sample) = assessment.usable() else {
            // Cannot happen while Active (the supervisor would have faulted); fail closed.
            return Err(Withheld::OutputNotPermitted(self.supervisor.state()));
        };
        let request = self.source.next_request(&sample.state);
        match self.generator.generate(&self.supervisor, request, now) {
            Ok(generated) => {
                self.last_withheld = None;
                self.stats.commands_encoded += 1;
                self.wire_armed = true;
                self.emit(
                    now,
                    WireMessage::Command(generated.command),
                    Some(request),
                    generated.adjustments,
                );
                Ok(())
            }
            Err(reason) => {
                if matches!(reason, Withheld::InvalidRequest(_)) {
                    // A controller error is a fault, never something to retry silently.
                    let t = self.report(now, SafetyEvent::InvalidControlRequest);
                    *transition = transition.or(t);
                }
                if self.last_withheld != Some(reason) {
                    self.last_withheld = Some(reason);
                    self.log.decision(now, DecisionEvent::Withheld(reason));
                }
                Err(reason)
            }
        }
    }

    /// Orderly shutdown: disarms the supervisor and encodes the owed disarm message.
    pub fn shutdown(&mut self, now: Instant) -> ShutdownReport {
        self.last_now = now;
        let transition = self.supervisor.shutdown();
        if let Some(t) = transition {
            self.log_transition(now, t);
        }
        let disarm = match self.flush_disarm(now) {
            None => DisarmStatus::NotRequired,
            Some(Delivery::NotTransmitted) => DisarmStatus::EncodedNotTransmitted,
        };
        self.log.decision(now, DecisionEvent::Shutdown { disarm });
        ShutdownReport { transition, disarm }
    }
}

/// What counts as a change of the freshness assessment for the log observer: the kind, the
/// invalid reason, and the epoch of a usable state. Ages and stall durations grow every tick
/// and are deliberately not part of it.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum AssessmentKey {
    Usable {
        epoch: u64,
    },
    Unusable {
        kind: std::mem::Discriminant<Unusable>,
        invalid: Option<super::vehicle::InvalidFrame>,
    },
}

impl AssessmentKey {
    fn of(assessment: &Assessment) -> Self {
        match assessment {
            Assessment::Usable(sample) => Self::Usable {
                epoch: sample.epoch,
            },
            Assessment::Unusable(u) => Self::Unusable {
                kind: std::mem::discriminant(u),
                invalid: match u {
                    Unusable::Invalid(reason) => Some(*reason),
                    _ => None,
                },
            },
        }
    }
}

impl<S: MessageSink> Drop for ControlCore<S> {
    /// Last resort when the core is torn down without a shutdown (for example its task was
    /// aborted): the owed disarm is still encoded.
    fn drop(&mut self) {
        let now = self.last_now;
        self.flush_disarm(now);
    }
}

#[cfg(test)]
mod tests {
    use super::super::freshness::Discontinuity;
    use super::super::log::LogSnapshot;
    use super::super::supervisor::{Reason, Rejection, State};
    use super::super::vehicle::InvalidFrame;
    use super::super::vehicle::test_support::{paused_frame, slow_frame};
    use super::super::watchdog::{SUPERVISOR_TIMEOUT, Watchdog};
    use super::*;
    use roadpilot_telemetry_client::GameId;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::{Arc, Mutex};
    use std::time::Duration;

    fn ms(n: u64) -> Duration {
        Duration::from_millis(n)
    }

    #[derive(Clone)]
    struct Scripted {
        request: Arc<Mutex<ControlRequest>>,
        calls: Arc<AtomicUsize>,
    }

    impl Scripted {
        fn new(request: ControlRequest) -> Self {
            Self {
                request: Arc::new(Mutex::new(request)),
                calls: Arc::new(AtomicUsize::new(0)),
            }
        }
        fn set(&self, request: ControlRequest) {
            *self.request.lock().unwrap() = request;
        }
        fn calls(&self) -> usize {
            self.calls.load(Ordering::SeqCst)
        }
    }

    impl RequestSource for Scripted {
        fn next_request(&mut self, _state: &VehicleState) -> ControlRequest {
            self.calls.fetch_add(1, Ordering::SeqCst);
            *self.request.lock().unwrap()
        }
    }

    fn neutral() -> ControlRequest {
        ControlRequest {
            steering: None,
            throttle: 0.0,
            brake: 0.0,
        }
    }

    /// Frames every 16 ms and ticks every 40 ms on one deterministic millisecond clock.
    struct Rig {
        core: ControlCore<DryRunSink>,
        t0: Instant,
        now_ms: u64,
        seq: u64,
        session: u64,
        game: GameId,
        speed: f32,
        paused: bool,
        frames_on: bool,
        ticks_on: bool,
        source: Scripted,
        trip: TripFlag,
        watchdog: Watchdog,
        reports: Vec<TickReport>,
    }

    impl Rig {
        fn new() -> Self {
            Self::with_request(neutral())
        }

        fn with_request(request: ControlRequest) -> Self {
            Self::with_observer(request, None)
        }

        fn with_observer(
            request: ControlRequest,
            observer: Option<Arc<dyn super::super::log::LogObserver>>,
        ) -> Self {
            let t0 = Instant::now();
            let log = ControlLog::with_observer(t0, observer);
            let heartbeat = Heartbeat::new(t0);
            let watchdog = Watchdog::new(heartbeat.clone(), SUPERVISOR_TIMEOUT);
            let trip = watchdog.flag();
            let source = Scripted::new(request);
            let core = ControlCore::dry_run(
                CoreConfig::default(),
                Box::new(source.clone()),
                log,
                heartbeat.clone(),
                trip.clone(),
                t0,
            );
            Self {
                core,
                t0,
                now_ms: 0,
                seq: 0,
                session: 7,
                game: GameId::Ets2,
                speed: 3.0,
                paused: false,
                frames_on: true,
                ticks_on: true,
                source,
                trip,
                watchdog,
                reports: Vec::new(),
            }
        }

        fn at(&self, millis: u64) -> Instant {
            self.t0 + Duration::from_millis(millis)
        }

        fn frame(&mut self) {
            self.seq += 1;
            let mut frame = if self.paused {
                paused_frame(self.session, self.seq, self.now_ms * 1_000)
            } else {
                slow_frame(self.session, self.seq, self.now_ms * 1_000)
            };
            frame.game = self.game;
            if !self.paused {
                frame.truck.as_mut().unwrap().speed_mps = Some(self.speed);
            }
            let received = ReceivedTelemetryFrame {
                frame,
                dropped_fields: Vec::new(),
                received_at: self.at(self.now_ms),
                received_qpc: None,
            };
            self.core.on_frame(&received, self.at(self.now_ms));
        }

        /// Advances the shared clock in 4 ms steps up to `until_ms`.
        fn run_to(&mut self, until_ms: u64) {
            while self.now_ms < until_ms {
                self.now_ms += 4;
                if self.frames_on && self.now_ms.is_multiple_of(16) {
                    self.frame();
                }
                if self.ticks_on && self.now_ms.is_multiple_of(40) {
                    let report = self.core.tick(self.at(self.now_ms));
                    self.reports.push(report);
                }
            }
        }

        fn command(&mut self, command: Command) -> Response {
            self.core.on_command(command, self.at(self.now_ms))
        }

        /// Settles telemetry, then arms and activates through the supervisor.
        fn active() -> Self {
            Self::active_with(neutral())
        }

        fn active_with(request: ControlRequest) -> Self {
            let mut rig = Self::with_request(request);
            rig.run_to(200);
            assert!(rig.command(Command::Arm).result.is_ok());
            assert!(rig.command(Command::Activate).result.is_ok());
            assert_eq!(rig.core.state(), State::Active);
            rig
        }

        /// Active and already encoding commands, so a fault owes a disarm.
        fn active_running() -> Self {
            let mut rig = Self::active();
            rig.run_to(320);
            assert!(!rig.commands().is_empty());
            rig
        }

        fn snapshot(&self) -> LogSnapshot {
            self.core.log().snapshot()
        }

        fn commands(&self) -> Vec<MessageRecord> {
            self.snapshot()
                .messages
                .iter()
                .map(|e| e.event)
                .filter(|m| m.kind == MessageKind::Command)
                .collect()
        }

        fn disarms(&self) -> usize {
            self.snapshot()
                .messages
                .iter()
                .filter(|e| e.event.kind == MessageKind::Disarm)
                .count()
        }

        fn decisions(&self) -> Vec<DecisionEvent> {
            self.snapshot().decisions.iter().map(|e| e.event).collect()
        }

        fn last_transition(&self) -> Option<Transition> {
            self.decisions().into_iter().rev().find_map(|d| match d {
                DecisionEvent::Transition(t) => Some(t),
                _ => None,
            })
        }
    }

    // ---- initial state and dry run ----

    #[test]
    fn a_new_core_is_disabled_dry_run_and_silent() {
        let mut rig = Rig::new();
        rig.run_to(2_000);
        assert_eq!(rig.core.state(), State::Disabled);
        assert_eq!(rig.core.mode(), OperatingMode::DryRun);
        assert!(!rig.core.permits_output());
        assert!(
            rig.snapshot().messages.is_empty(),
            "nothing is encoded while disabled"
        );
        assert_eq!(rig.core.stats().ticks, 50);
        assert!(rig.core.stats().frames_accepted > 100);
    }

    #[test]
    fn nothing_arms_without_an_explicit_command() {
        let mut rig = Rig::new();
        rig.run_to(5_000);
        assert_eq!(rig.core.state(), State::Disabled);
        assert!(rig.reports.iter().all(|r| r.transition.is_none()));
    }

    #[test]
    fn an_active_core_encodes_one_bounded_command_per_tick_and_transmits_nothing() {
        let mut rig = Rig::active();
        let before = rig.commands().len();
        rig.run_to(1_200);
        let commands = rig.commands();
        assert_eq!(commands.len() - before, 25, "1 s at 40 ms");
        for c in &commands {
            assert_eq!(c.bytes.len(), 20);
            assert_eq!(&c.bytes[0..4], b"RPIN");
            assert_eq!(&c.bytes[4..6], &[2, 0]);
            assert_eq!(c.bytes[6], 1, "enabled");
            assert_eq!(c.delivery, Delivery::NotTransmitted);
        }
        assert_eq!(rig.core.stats().commands_encoded as usize, commands.len());
    }

    #[test]
    fn commands_are_encoded_on_the_40_ms_grid() {
        let mut rig = Rig::active();
        rig.run_to(1_000);
        let times: Vec<Duration> = rig
            .snapshot()
            .messages
            .iter()
            .filter(|e| e.event.kind == MessageKind::Command)
            .map(|e| e.at)
            .collect();
        assert!(times.len() > 10);
        for pair in times.windows(2) {
            assert_eq!(pair[1] - pair[0], ms(40));
        }
        assert!(rig.snapshot().timing.is_empty(), "no late or missed ticks");
    }

    #[test]
    fn requested_and_bounded_values_are_logged_with_the_adjustments() {
        let request = ControlRequest {
            steering: Some(0.9),
            throttle: 0.9,
            brake: 0.0,
        };
        let mut rig = Rig::active_with(request);
        rig.run_to(1_000);
        let commands = rig.commands();
        let last = commands.last().unwrap();
        assert_eq!(last.requested, Some(request));
        let bounded = last.bounded.unwrap();
        assert_eq!(bounded.throttle, 0.10);
        assert_eq!(bounded.steering, Some(0.15));
        assert_eq!(bounded.brake, 0.0);
        assert!(last.adjustments.limited);
        // The very first command starts the steering ramp from zero.
        assert_eq!(commands[0].bounded.unwrap().steering, Some(0.0));
        assert!(commands[0].adjustments.steering_rate_limited);
        // The ramp never exceeds the limit.
        assert!(
            commands
                .iter()
                .all(|c| c.bounded.unwrap().steering.unwrap() <= 0.15)
        );
    }

    #[test]
    fn brake_overrides_throttle_in_the_logged_command() {
        let mut rig = Rig::active_with(ControlRequest {
            steering: None,
            throttle: 0.08,
            brake: 0.5,
        });
        rig.run_to(400);
        let c = rig.commands().last().copied().unwrap();
        let b = c.bounded.unwrap();
        assert_eq!((b.throttle, b.brake), (0.0, 0.5));
        assert!(c.adjustments.brake_overrode_throttle);
    }

    // ---- faults: nothing stale is ever sent ----

    fn assert_faulted_cleanly(rig: &mut Rig, expected: SafetyEvent) {
        let t = rig.last_transition().unwrap();
        assert_eq!(
            t,
            Transition {
                from: State::Active,
                to: State::Fault,
                reason: Reason::Safety(expected)
            }
        );
        assert_eq!(rig.core.state(), State::Fault);
        assert!(!rig.core.permits_output());
        // Exactly one disarm, and nothing but ticks that do nothing afterwards.
        assert_eq!(rig.disarms(), 1);
        let commands_at_fault = rig.commands().len();
        let calls_at_fault = rig.source.calls();
        let disarms = rig.disarms();
        rig.run_to(rig.now_ms + 2_000);
        assert_eq!(
            rig.commands().len(),
            commands_at_fault,
            "no stale command after a fault"
        );
        assert_eq!(
            rig.source.calls(),
            calls_at_fault,
            "the controller is not even asked"
        );
        assert_eq!(
            rig.disarms(),
            disarms,
            "the disarm is encoded once, not repeated"
        );
    }

    #[test]
    fn stale_telemetry_faults_and_encodes_one_disarm() {
        let mut rig = Rig::active();
        rig.run_to(300);
        rig.frames_on = false; // the connection drops
        rig.run_to(520);
        let t = rig.last_transition().unwrap();
        assert!(matches!(
            t.reason,
            Reason::Safety(SafetyEvent::StaleTelemetry { .. })
        ));
        assert_eq!(t.to, State::Fault);
        let fault_tick = rig.reports.iter().find(|r| r.transition.is_some()).unwrap();
        assert!(!fault_tick.command_encoded);
        assert!(fault_tick.disarm_encoded);
        assert_eq!(rig.disarms(), 1);
        let n = rig.commands().len();
        rig.run_to(3_000);
        assert_eq!(rig.commands().len(), n);
        assert_eq!(rig.disarms(), 1);
    }

    #[test]
    fn a_reconnect_never_restores_output() {
        let mut rig = Rig::active();
        rig.run_to(300);
        rig.frames_on = false;
        rig.run_to(700); // long silence: fault
        assert_eq!(rig.core.state(), State::Fault);
        let commands = rig.commands().len();
        // The same session reconnects and streams healthy frames for a long time.
        rig.frames_on = true;
        rig.run_to(5_000);
        assert_eq!(rig.core.state(), State::Fault, "still faulted");
        assert_eq!(rig.commands().len(), commands, "no output since the fault");
        // Recovery needs the deliberate sequence: reset, arm, activate.
        assert!(rig.command(Command::Activate).result.is_err());
        assert!(rig.command(Command::Arm).result.is_err());
        assert!(rig.command(Command::ResetFault).result.is_ok());
        assert_eq!(rig.core.state(), State::Disabled);
        rig.run_to(5_200);
        assert_eq!(rig.core.state(), State::Disabled, "reset does not arm");
        assert_eq!(rig.commands().len(), commands);
        assert!(rig.command(Command::Arm).result.is_ok());
        assert!(rig.command(Command::Activate).result.is_ok());
        rig.run_to(5_400);
        assert!(
            rig.commands().len() > commands,
            "output only after the explicit sequence"
        );
    }

    #[test]
    fn a_reconnect_after_an_armed_only_disarm_is_not_rearmed() {
        let mut rig = Rig::new();
        rig.run_to(200);
        assert!(rig.command(Command::Arm).result.is_ok());
        rig.frames_on = false;
        rig.run_to(600);
        assert_eq!(rig.core.state(), State::Disabled);
        rig.frames_on = true;
        rig.run_to(3_000);
        assert_eq!(rig.core.state(), State::Disabled);
        assert!(
            rig.snapshot().messages.is_empty(),
            "armed never reached the wire"
        );
    }

    #[test]
    fn a_session_change_faults() {
        let mut rig = Rig::active_running();
        rig.session = 99;
        rig.run_to(520);
        let t = rig.last_transition().unwrap();
        // A tick that falls into the settling period reports "not settled"; the cause is in
        // the epoch record. A tick after settling would report the session change itself.
        assert!(matches!(
            t.reason,
            Reason::Safety(
                SafetyEvent::NotSettled
                    | SafetyEvent::SessionChanged {
                        armed: 7,
                        current: 99
                    }
            )
        ));
        assert_eq!(rig.core.state(), State::Fault);
        assert_eq!(rig.disarms(), 1);
        assert!(rig.decisions().iter().any(|d| matches!(
            d,
            DecisionEvent::Epoch {
                cause: Discontinuity::SessionChanged,
                ..
            }
        )));
    }

    #[test]
    fn a_game_change_faults() {
        let mut rig = Rig::active_running();
        rig.game = GameId::Ats;
        rig.run_to(520);
        let t = rig.last_transition().unwrap();
        assert!(matches!(
            t.reason,
            Reason::Safety(SafetyEvent::NotSettled | SafetyEvent::GameChanged { .. })
        ));
        assert!(rig.decisions().iter().any(|d| matches!(
            d,
            DecisionEvent::Epoch {
                cause: Discontinuity::GameChanged,
                ..
            }
        )));
        assert_eq!(rig.core.state(), State::Fault);
        assert_eq!(rig.disarms(), 1);
    }

    #[test]
    fn a_pause_faults() {
        let mut rig = Rig::active_running();
        rig.paused = true;
        rig.run_to(400);
        let t = rig.last_transition().unwrap();
        assert!(matches!(
            t.reason,
            Reason::Safety(SafetyEvent::Paused | SafetyEvent::EpochChanged { .. })
        ));
        assert_eq!(rig.core.state(), State::Fault);
        assert_eq!(rig.disarms(), 1);
        // Resuming does not restore anything.
        rig.paused = false;
        rig.run_to(3_000);
        assert_eq!(rig.core.state(), State::Fault);
        assert_eq!(rig.disarms(), 1);
    }

    #[test]
    fn exceeding_the_speed_cap_faults() {
        let mut rig = Rig::active_running();
        rig.speed = 5.5;
        rig.run_to(400);
        assert_faulted_cleanly(
            &mut rig,
            SafetyEvent::SpeedCapExceeded {
                speed_mps: 5.5,
                cap_mps: 5.0,
            },
        );
    }

    #[test]
    fn an_invalid_frame_faults_and_is_logged_once_per_episode() {
        let mut rig = Rig::active_running();
        // Frames without a session are invalid for control.
        for _ in 0..5 {
            rig.seq += 1;
            let mut frame = slow_frame(7, rig.seq, rig.now_ms * 1_000);
            frame.session = None;
            let received = ReceivedTelemetryFrame {
                frame,
                dropped_fields: Vec::new(),
                received_at: rig.at(rig.now_ms),
                received_qpc: None,
            };
            rig.core.on_frame(&received, rig.at(rig.now_ms));
        }
        rig.frames_on = false;
        rig.run_to(rig.now_ms + 100);
        assert_eq!(rig.core.state(), State::Fault);
        assert_eq!(rig.core.stats().frames_invalid, 5);
        let invalid_records = rig
            .decisions()
            .into_iter()
            .filter(|d| matches!(d, DecisionEvent::FrameInvalid(InvalidFrame::MissingSession)))
            .count();
        assert_eq!(invalid_records, 1, "one record per episode");
        assert_eq!(rig.disarms(), 1);
    }

    #[test]
    fn a_controller_error_faults_and_sends_no_command() {
        let mut rig = Rig::active_with(ControlRequest {
            steering: None,
            throttle: 0.05,
            brake: 0.0,
        });
        rig.run_to(400);
        assert!(!rig.commands().is_empty());
        rig.source.set(ControlRequest {
            steering: Some(f32::NAN),
            throttle: 0.05,
            brake: 0.0,
        });
        rig.run_to(480);
        let t = rig.last_transition().unwrap();
        assert_eq!(
            t,
            Transition {
                from: State::Active,
                to: State::Fault,
                reason: Reason::Safety(SafetyEvent::InvalidControlRequest)
            }
        );
        assert!(
            rig.decisions()
                .iter()
                .any(|d| matches!(d, DecisionEvent::Withheld(Withheld::InvalidRequest(_))))
        );
        assert_eq!(rig.disarms(), 1);
        // The faulted core does not come back when the controller recovers.
        rig.source.set(neutral());
        let n = rig.commands().len();
        rig.run_to(2_000);
        assert_eq!(rig.commands().len(), n);
    }

    #[test]
    fn a_controller_error_before_any_command_needs_no_disarm() {
        let mut rig = Rig::active_with(ControlRequest {
            steering: None,
            throttle: f32::INFINITY,
            brake: 0.0,
        });
        rig.run_to(300);
        assert_eq!(rig.core.state(), State::Fault);
        assert!(rig.commands().is_empty());
        assert_eq!(rig.disarms(), 0, "nothing was ever encoded as armed");
    }

    // ---- manual disarm, shutdown, drop ----

    #[test]
    fn a_manual_disarm_encodes_the_disarm_immediately() {
        let mut rig = Rig::active();
        rig.run_to(400);
        assert_eq!(rig.disarms(), 0);
        let r = rig.command(Command::Disarm);
        assert_eq!(r.result, Ok(()));
        assert_eq!(rig.core.state(), State::Disabled);
        assert_eq!(rig.disarms(), 1, "before the next tick");
        rig.run_to(1_000);
        assert_eq!(rig.disarms(), 1);
        let disarm = rig
            .snapshot()
            .messages
            .iter()
            .find(|e| e.event.kind == MessageKind::Disarm)
            .unwrap()
            .event;
        assert_eq!(disarm.bytes[6], 0, "enabled = 0");
        assert_eq!(disarm.bytes[7], 0);
        assert_eq!(&disarm.bytes[8..20], &[0u8; 12]);
        assert_eq!(disarm.delivery, Delivery::NotTransmitted);
        assert_eq!(disarm.requested, None);
    }

    #[test]
    fn disarming_when_nothing_was_armed_encodes_nothing() {
        let mut rig = Rig::new();
        rig.run_to(200);
        assert!(rig.command(Command::Disarm).result.is_ok());
        assert!(rig.command(Command::Arm).result.is_ok());
        assert!(rig.command(Command::Disarm).result.is_ok());
        assert!(rig.snapshot().messages.is_empty());
    }

    #[test]
    fn a_rejected_command_is_logged() {
        let mut rig = Rig::new(); // no frames yet
        let r = rig.command(Command::Arm);
        assert!(r.result.is_err());
        assert!(rig.decisions().iter().any(|d| matches!(
            d,
            DecisionEvent::CommandRejected {
                command: Command::Arm,
                rejection: Rejection::NotReady(_)
            }
        )));
        assert_eq!(rig.core.state(), State::Disabled);
    }

    #[test]
    fn shutdown_while_active_disarms_and_reports_truthfully() {
        let mut rig = Rig::active();
        rig.run_to(400);
        let report = rig.core.shutdown(rig.at(rig.now_ms));
        assert_eq!(report.transition.map(|t| t.reason), Some(Reason::Shutdown));
        assert_eq!(report.disarm, DisarmStatus::EncodedNotTransmitted);
        assert_eq!(rig.core.state(), State::Disabled);
        assert_eq!(rig.disarms(), 1);
        assert!(rig.decisions().iter().any(|d| matches!(
            d,
            DecisionEvent::Shutdown {
                disarm: DisarmStatus::EncodedNotTransmitted
            }
        )));
        // The report never says "delivered": no such value exists.
        let again = rig.core.shutdown(rig.at(rig.now_ms + 1));
        assert_eq!(again.disarm, DisarmStatus::NotRequired, "idempotent");
        assert_eq!(rig.disarms(), 1);
    }

    #[test]
    fn shutdown_when_idle_requires_no_disarm() {
        let mut rig = Rig::new();
        rig.run_to(200);
        let report = rig.core.shutdown(rig.at(200));
        assert_eq!(report.transition, None);
        assert_eq!(report.disarm, DisarmStatus::NotRequired);
        assert!(rig.snapshot().messages.is_empty());
    }

    #[test]
    fn shutdown_when_only_armed_requires_no_disarm() {
        let mut rig = Rig::new();
        rig.run_to(200);
        rig.command(Command::Arm);
        let report = rig.core.shutdown(rig.at(200));
        assert_eq!(report.transition.map(|t| t.to), Some(State::Disabled));
        assert_eq!(report.disarm, DisarmStatus::NotRequired);
    }

    #[test]
    fn shutdown_after_a_fault_keeps_the_fault_and_does_not_disarm_twice() {
        let mut rig = Rig::active();
        rig.run_to(400);
        rig.frames_on = false;
        rig.run_to(700);
        assert_eq!(rig.core.state(), State::Fault);
        let report = rig.core.shutdown(rig.at(700));
        assert_eq!(report.transition, None);
        assert_eq!(
            report.disarm,
            DisarmStatus::NotRequired,
            "already disarmed by the fault"
        );
        assert_eq!(rig.disarms(), 1);
    }

    #[test]
    fn dropping_an_armed_core_still_encodes_the_disarm() {
        let mut rig = Rig::active();
        rig.run_to(400);
        let log = rig.core.log().clone();
        let before = log.snapshot().messages.len();
        let Rig { core, .. } = rig;
        drop(core); // for example: the task was aborted at application exit
        let messages = log.snapshot().messages;
        assert_eq!(messages.len(), before + 1);
        assert_eq!(messages.last().unwrap().event.kind, MessageKind::Disarm);
    }

    #[test]
    fn dropping_an_idle_or_already_disarmed_core_encodes_nothing() {
        let mut rig = Rig::active();
        rig.run_to(400);
        rig.command(Command::Disarm);
        let log = rig.core.log().clone();
        let before = log.snapshot().messages.len();
        let Rig { core, .. } = rig;
        drop(core);
        assert_eq!(log.snapshot().messages.len(), before);
    }

    // ---- timing and the independent watchdog ----

    #[test]
    fn a_tick_gap_over_the_limit_faults_and_sends_no_command() {
        let mut rig = Rig::active();
        rig.run_to(400);
        // The loop stalls while telemetry keeps flowing, so only the timing can be the cause:
        // the next tick runs 130 ms after the previous one.
        rig.ticks_on = false;
        rig.run_to(528);
        let before = rig.commands().len();
        let report = rig.core.tick(rig.at(400 + 130));
        assert_eq!(report.timing.verdict, Verdict::GapViolation);
        assert!(
            !report.command_encoded,
            "no command on the tick that detected the stall"
        );
        assert!(report.disarm_encoded);
        assert_eq!(rig.commands().len(), before);
        assert_eq!(
            report.transition.unwrap().reason,
            Reason::Safety(SafetyEvent::SenderTiming { gap: ms(130) })
        );
        assert_eq!(rig.core.state(), State::Fault);
        assert!(
            rig.snapshot()
                .timing
                .iter()
                .any(|e| matches!(e.event, TimingEvent::GapViolation { .. }))
        );
    }

    #[test]
    fn a_late_tick_within_tolerance_is_logged_but_does_not_fault() {
        let mut rig = Rig::active();
        rig.run_to(400);
        rig.ticks_on = false;
        rig.run_to(464);
        // Deadline 440; tick at 470: 30 ms late, gap 70 ms.
        let report = rig.core.tick(rig.at(470));
        assert_eq!(report.timing.verdict, Verdict::Late);
        assert!(report.command_encoded);
        assert_eq!(rig.core.state(), State::Active);
        assert!(
            rig.snapshot()
                .timing
                .iter()
                .any(|e| matches!(e.event, TimingEvent::Late { .. }))
        );
    }

    #[test]
    fn skipped_deadlines_are_logged_and_never_replayed() {
        let mut rig = Rig::active();
        rig.run_to(400);
        rig.ticks_on = false;
        rig.run_to(480);
        let before = rig.commands().len();
        // Deadlines 440 and 480 passed; the tick at 485 is 45 ms late: one skipped, gap 85.
        let report = rig.core.tick(rig.at(485));
        assert_eq!(report.timing.missed, 1);
        assert_eq!(report.timing.verdict, Verdict::DeadlinesMissed);
        assert_eq!(
            rig.commands().len() - before,
            1,
            "exactly one command, no catch-up burst"
        );
        assert!(
            rig.snapshot()
                .timing
                .iter()
                .any(|e| matches!(e.event, TimingEvent::DeadlinesMissed { missed: 1, .. }))
        );
        assert!(rig.core.next_deadline() > rig.at(485));
    }

    #[test]
    fn the_independent_watchdog_detects_a_stalled_loop_and_the_loop_faults_on_return() {
        let mut rig = Rig::active();
        rig.run_to(400);
        // The loop stops ticking while telemetry keeps flowing; only the watchdog runs.
        rig.ticks_on = false;
        let mut silent = None;
        for at in (420..=560).step_by(20) {
            rig.run_to(at);
            silent = silent.or(rig.watchdog.check(rig.at(at)));
        }
        let silent = silent.expect("the watchdog must trip without any help from the loop");
        assert!(silent > SUPERVISOR_TIMEOUT);
        assert!(rig.trip.is_tripped());
        assert_eq!(
            rig.core.state(),
            State::Active,
            "the watchdog cannot touch the supervisor"
        );

        // The loop comes back.
        let report = rig.core.tick(rig.at(560));
        let t = report.transition.unwrap();
        assert_eq!(t.from, State::Active);
        assert_eq!(t.to, State::Fault);
        assert!(
            matches!(
                t.reason,
                Reason::Safety(SafetyEvent::SupervisorTimeout { .. })
            ),
            "the out-of-band event wins: {t:?}"
        );
        assert!(!report.command_encoded);
        assert!(report.disarm_encoded);
        assert!(!rig.trip.is_tripped(), "consumed");
    }

    #[test]
    fn a_healthy_loop_never_trips_the_watchdog() {
        let mut rig = Rig::active();
        for at in (400..=4_000).step_by(20) {
            rig.run_to(at);
            assert_eq!(rig.watchdog.check(rig.at(at)), None, "at {at}");
        }
        assert_eq!(rig.core.state(), State::Active);
        assert!(!rig.trip.is_tripped());
    }

    #[test]
    fn a_watchdog_trip_while_disabled_changes_nothing() {
        let mut rig = Rig::new();
        rig.run_to(200);
        rig.ticks_on = false;
        rig.run_to(600);
        rig.watchdog.check(rig.at(600));
        assert!(rig.trip.is_tripped());
        let report = rig.core.tick(rig.at(600));
        assert_eq!(report.transition, None);
        assert_eq!(rig.core.state(), State::Disabled);
    }

    // ---- feed notes and bookkeeping ----

    #[test]
    fn feed_changes_are_logged_once_per_change() {
        let mut rig = Rig::new();
        let now = rig.at(10);
        rig.core.note_feed(false, now);
        rig.core.note_feed(false, now);
        rig.core.note_feed(true, now);
        rig.core.note_feed(true, now);
        let d = rig.decisions();
        assert_eq!(
            d.iter()
                .filter(|e| matches!(e, DecisionEvent::FeedLost))
                .count(),
            1
        );
        assert_eq!(
            d.iter()
                .filter(|e| matches!(e, DecisionEvent::FeedRestored))
                .count(),
            1
        );
        rig.core.note_feed(true, now); // connected at start: nothing to restore
        assert_eq!(rig.decisions().len(), 2);
    }

    #[test]
    fn rejected_frames_are_counted_not_logged_individually() {
        let mut rig = Rig::new();
        rig.run_to(100);
        let accepted = rig.core.stats().frames_accepted;
        // Replay an old sequence.
        let frame = slow_frame(7, 1, 1_000);
        let received = ReceivedTelemetryFrame {
            frame,
            dropped_fields: Vec::new(),
            received_at: rig.at(120),
            received_qpc: None,
        };
        for _ in 0..10 {
            rig.core.on_frame(&received, rig.at(120));
        }
        assert_eq!(rig.core.stats().frames_rejected, 10);
        assert_eq!(rig.core.stats().frames_accepted, accepted);
    }

    #[test]
    fn the_log_stays_bounded_over_a_long_active_run() {
        let mut rig = Rig::active_with(ControlRequest {
            steering: Some(0.1),
            throttle: 0.05,
            brake: 0.0,
        });
        rig.run_to(120_000); // two minutes: 3000 messages
        let s = rig.snapshot();
        assert_eq!(s.messages.len(), super::super::log::MESSAGE_CAPACITY);
        assert!(s.dropped.messages > 2_000);
        assert!(s.decisions.len() < super::super::log::DECISION_CAPACITY);
        assert!(
            s.decisions
                .iter()
                .any(|e| matches!(e.event, DecisionEvent::Transition(_))),
            "the arm and activate transitions survive the message flood"
        );
        assert_eq!(s.dropped.decisions, 0);
    }

    // ---- timing statistics ----

    #[test]
    fn ticks_on_the_grid_record_intervals_and_command_refresh_intervals() {
        let mut rig = Rig::active();
        rig.run_to(1_000);
        let t = rig.core.timing();
        assert_eq!(t.ticks, 25);
        let intervals = t.intervals.summary();
        assert_eq!(intervals.count, 24);
        assert!((intervals.max_ms - 40.0).abs() < 1e-9);
        assert_eq!(intervals.over_40, 0);
        assert!((t.lateness.summary().max_ms).abs() < 1e-9);
        // Commands from the tick at 240 ms on: 20 commands, 19 refresh intervals of 40 ms.
        let commands = t.command_intervals.summary();
        assert_eq!(commands.count, 19);
        assert!((commands.max_ms - 40.0).abs() < 1e-9);
        assert_eq!(
            (t.missed_deadlines, t.late_ticks, t.gap_violations),
            (0, 0, 0)
        );
    }

    #[test]
    fn a_late_tick_a_missed_deadline_and_a_gap_are_counted() {
        let mut rig = Rig::active();
        rig.run_to(400);
        rig.ticks_on = false;
        rig.run_to(480);
        rig.core.tick(rig.at(485)); // 45 ms late: one deadline skipped, gap 85 ms
        rig.run_to(624);
        rig.core.tick(rig.at(630)); // next deadline 520: 110 ms late, gap 145 ms
        let t = rig.core.timing();
        assert_eq!(t.missed_deadlines, 1 + 2);
        assert_eq!(t.late_ticks, 2);
        assert_eq!(t.gap_violations, 1);
        let intervals = t.intervals.summary();
        assert_eq!(intervals.over_50, 2);
        assert!((intervals.max_ms - 145.0).abs() < 1e-9);
        // The 85 ms refresh interval counts; after the gap fault the sequence ended.
        let commands = t.command_intervals.summary();
        assert!((commands.max_ms - 85.0).abs() < 1e-9);
        assert_eq!(commands.over_50, 1);
    }

    #[test]
    fn the_refresh_sequence_restarts_after_output_stops() {
        let mut rig = Rig::active();
        rig.run_to(400);
        rig.command(Command::Disarm);
        rig.run_to(1_000);
        let before = rig.core.timing().command_intervals.summary();
        rig.command(Command::Arm);
        rig.command(Command::Activate);
        rig.run_to(1_200);
        let after = rig.core.timing().command_intervals.summary();
        assert!(after.count > before.count);
        assert!(
            (after.max_ms - 40.0).abs() < 1e-9,
            "no interval spans the disarmed time: {}",
            after.max_ms
        );
    }

    #[test]
    fn processing_is_measured_from_tick_start_to_reported_finish() {
        let mut rig = Rig::new();
        rig.ticks_on = false;
        rig.run_to(40);
        rig.core.tick(rig.at(40));
        rig.core
            .tick_finished(rig.at(40) + Duration::from_micros(2_500));
        // A finish without a new tick is ignored.
        rig.core.tick_finished(rig.at(60));
        let p = rig.core.timing().processing.summary();
        assert_eq!(p.count, 1);
        assert!((p.max_ms - 2.5).abs() < 1e-9);
    }

    #[test]
    fn the_timing_summary_is_part_of_the_status() {
        let mut rig = Rig::active();
        rig.run_to(600);
        let status = rig.core.status(rig.at(600));
        assert_eq!(status.timing.ticks, 15);
        assert_eq!(status.timing.intervals.count, 14);
        assert_eq!(status.timing.timer, super::super::status::TimerCode::Tokio);
        assert!(!status.timing.elevated_priority);
    }

    #[derive(Default)]
    struct Observed(Mutex<Vec<super::super::log::Observed>>);

    impl super::super::log::LogObserver for Observed {
        fn observe(&self, record: super::super::log::Observed) {
            self.0.lock().unwrap().push(record);
        }
    }

    #[test]
    fn assessment_changes_reach_the_log_observer_once_per_change() {
        use super::super::log::Observed as O;
        let seen = Arc::new(Observed::default());
        let mut rig = Rig::with_observer(neutral(), Some(seen.clone()));
        rig.frames_on = false;
        rig.run_to(200); // no frame yet
        rig.frames_on = true;
        rig.run_to(1_000); // settling, then usable
        rig.paused = true;
        rig.run_to(1_400);
        rig.paused = false;
        rig.run_to(2_400);
        rig.frames_on = false;
        rig.run_to(3_000); // stale
        let kinds: Vec<String> = seen
            .0
            .lock()
            .unwrap()
            .iter()
            .filter_map(|r| match r {
                O::Assessment { assessment, .. } => Some(match assessment {
                    Assessment::Usable(s) => format!("usable@{}", s.epoch),
                    Assessment::Unusable(u) => format!("{u:?}")
                        .split([' ', '(', '{'])
                        .next()
                        .unwrap()
                        .to_owned(),
                }),
                _ => None,
            })
            .collect();
        assert_eq!(
            kinds,
            [
                "NoFrame", "Settling", "usable@1", "Paused", "Settling", "usable@2", "Stale"
            ],
            "{kinds:?}"
        );
        // Every decision also reached the observer, in log order.
        let decisions = seen
            .0
            .lock()
            .unwrap()
            .iter()
            .filter(|r| matches!(r, O::Decision(_)))
            .count();
        assert_eq!(decisions, rig.core.log().snapshot().decisions.len());
    }
}
