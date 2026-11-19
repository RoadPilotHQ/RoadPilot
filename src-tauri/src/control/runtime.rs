//! Async drivers for the control core. Thin on purpose: all decisions are made by the
//! deterministic [`ControlCore`]; this layer only moves events into it.
//!
//! * **Telemetry.** A relay task on the shared runtime reads raw schema 2 frames from a
//!   **second receiver** on the telemetry engine's own `watch` channel (see [`FrameFeed`]).
//!   There is exactly one pipe server, owned by the dashboard engine; control never creates
//!   another. The relay turns every frame into a fixed-size digest and hands it, with the time
//!   it observed it, to the bounded, ordered [`mailbox`](super::mailbox), which the sender
//!   task drains at each tick (at most 16 items, never waiting; any loss starts a new
//!   freshness epoch). When the engine replaces its channel after restarting the pipe
//!   server, the relay re-attaches and reports the change.
//! * **Timing.** The sender task waits for the core's next 40 ms deadline on the monotonic clock
//!   through a [`TickTimer`] and ticks. Missed deadlines are skipped by the scheduler, never
//!   replayed. The application uses a precise timer thread; tests use tokio's timer.
//! * **Operator commands** are queued and processed at the start of the next tick (at most one
//!   period later). Everything queued is processed together and any disarm first, so a disarm
//!   is never stuck behind other commands. A disarm also has priority over its whole batch:
//!   no arm or activation queued with it is carried out.
//! * **No blocking on other threads.** The sender task never waits for a lock held by, and is
//!   never woken by, a thread of normal priority: it is woken only by its timer (and once by
//!   shutdown), it takes telemetry and commands with `try_recv` from queues that need no lock,
//!   and at each tick it publishes its status only if no reader holds it at that moment.
//!   Otherwise a reader preempted while holding a lock would delay the elevated control
//!   thread (priority inversion; measured, see `docs/timing.md`).
//! * **Watchdog.** A separate task checks the supervisor loop's heartbeat every 20 ms and
//!   trips a flag the loop consumes at the start of its next tick, before any queued command
//!   (see `watchdog`). Each check also records the watchdog's own liveness, which the loop
//!   checks in turn.
//! * **Shutdown.** [`ControlHandle::shutdown`] makes the sender task disarm and return a
//!   [`ShutdownReport`]. If the task is aborted instead, dropping the core still encodes the
//!   owed disarm.
//!
//! The drivers are returned as futures so that the application can spawn them on the runtimes
//! of its choice. Time comes from tokio's clock, which in tests is paused and advanced
//! explicitly. Dry-run only: see `sink`.

use super::freshness::FrameDigest;
use super::log::{ControlLog, DecisionEvent, LogObserver};
use super::mailbox::{self, Delivery, MailboxReceiver, MailboxSender, Received};
use super::sender::{ControlCore, CoreConfig, RequestSource, ShutdownReport};
use super::sink::DryRunSink;
use super::status::ControlStatus;
use super::supervisor::{Command, Response, State};
use super::timer::{TickTimer, TokioTimer};
use super::timing::TickDiagnostics;
use super::watchdog::{Heartbeat, SUPERVISOR_TIMEOUT, WATCHDOG_PERIOD, Watchdog, WatchdogLink};
use crate::telemetry::engine::FrameFeed;
use roadpilot_telemetry_client::ReceivedTelemetryFrame;
use roadpilot_telemetry_client::qpc;
use std::future::Future;
use std::pin::Pin;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, PoisonError, TryLockError};
use std::time::{Duration, Instant};
use tokio::sync::{mpsc, oneshot, watch};
use tokio::time::{Instant as TokioInstant, sleep};

type FrameReceiver = watch::Receiver<Option<ReceivedTelemetryFrame>>;
type BoxFuture<T> = Pin<Box<dyn Future<Output = T> + Send + 'static>>;

/// How often the relay looks for a replaced frame channel while the feed is lost.
const FEED_RETRY: Duration = Duration::from_millis(40);

/// Where raw telemetry frames come from. The application uses the engine's [`FrameFeed`].
pub trait FrameSource: Send + 'static {
    /// A receiver on the current frame channel. Closed if the producer is gone.
    fn receiver(&self) -> FrameReceiver;
}

impl FrameSource for FrameFeed {
    fn receiver(&self) -> FrameReceiver {
        self.current()
    }
}

fn millis(d: Duration) -> u64 {
    u64::try_from(d.as_millis()).unwrap_or(u64::MAX)
}

/// Monotonic now. In production the same clock as `std::time::Instant`, which is what the
/// telemetry client stamps frames with; in tests tokio's paused clock.
fn now() -> Instant {
    TokioInstant::now().into_std()
}

/// What the control task answered to an operator command.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct CommandReply {
    pub response: Response,
    /// Supervisor state after the whole batch the command was part of.
    pub state: State,
}

struct Request {
    command: Command,
    reply: Option<oneshot::Sender<CommandReply>>,
}

/// The published status. Readers lock it briefly; the sender task never waits for it at a tick.
/// How publishing one status went (diagnostics).
struct PublishTiming {
    published: bool,
    attempt: Duration,
    hold: Duration,
}

struct StatusCell {
    status: Mutex<ControlStatus>,
    stopped: AtomicBool,
}

impl StatusCell {
    /// Waits for the lock. Used only once, after the control loop has ended (shutdown); never
    /// in a tick or a command batch.
    fn publish(&self, status: ControlStatus) {
        *self.status.lock().unwrap_or_else(PoisonError::into_inner) = status;
    }

    /// Publishes only if no reader holds the status right now; otherwise the next tick will.
    /// A skipped status is dropped, not queued: the previous status stays published whole
    /// (it is only ever replaced as a complete value under the lock), the skip is counted in
    /// the tick diagnostics, and the next tick offers a fresh, complete status.
    /// Returns how long the `try_lock` and the hold (assignment, including the release of the
    /// previous status) took, for diagnostics; the locking itself is unchanged.
    fn publish_if_free(&self, status: ControlStatus) -> PublishTiming {
        let asked = Instant::now();
        let (mut slot, acquired) = match self.status.try_lock() {
            Ok(slot) => (slot, Instant::now()),
            Err(TryLockError::Poisoned(poisoned)) => (poisoned.into_inner(), Instant::now()),
            Err(TryLockError::WouldBlock) => {
                return PublishTiming {
                    published: false,
                    attempt: asked.elapsed(),
                    hold: Duration::ZERO,
                };
            }
        };
        *slot = status;
        drop(slot);
        PublishTiming {
            published: true,
            attempt: acquired.saturating_duration_since(asked),
            hold: acquired.elapsed(),
        }
    }

    fn read(&self) -> ControlStatus {
        self.status
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .clone()
    }
}

/// Marks the status as stopped when the sender task ends, however it ends.
struct StoppedOnDrop(Arc<StatusCell>);

impl Drop for StoppedOnDrop {
    fn drop(&mut self) {
        self.0.stopped.store(true, Ordering::SeqCst);
    }
}

/// Operator access to the running control tasks. Cheap to clone.
#[derive(Clone)]
pub struct ControlHandle {
    commands: mpsc::UnboundedSender<Request>,
    shutdown: Arc<watch::Sender<bool>>,
    log: ControlLog,
    status: Arc<StatusCell>,
    /// Read when serving a status: the loop's heartbeat, the trip flag and the watchdog's
    /// liveness (atomics only).
    watchdog: WatchdogLink,
}

impl ControlHandle {
    /// Queues an operator command without waiting for the answer. `false` if the control
    /// task is gone.
    pub fn send(&self, command: Command) -> bool {
        self.commands
            .send(Request {
                command,
                reply: None,
            })
            .is_ok()
    }

    /// Queues an operator command; the receiver resolves with the answer once the control
    /// task has processed it at its next tick. `None` if the control task is gone.
    pub fn request(&self, command: Command) -> Option<oneshot::Receiver<CommandReply>> {
        let (tx, rx) = oneshot::channel();
        self.commands
            .send(Request {
                command,
                reply: Some(tx),
            })
            .ok()?;
        Some(rx)
    }

    /// The newest status the control task published, with the watchdog values measured now,
    /// independently of the loop, so a stalled loop or a failed watchdog is visible: the loop
    /// silence, whether the loop counts as stalled (then the published supervisor values are
    /// only the last known ones), a pending trip and the watchdog's own silence. Reads atomics
    /// only, besides the status lock every reader takes.
    pub fn status(&self) -> ControlStatus {
        let mut status = self.status.read();
        let at = now();
        let loop_silent = self.watchdog.heartbeat.silent_for(at);
        let w = &mut status.watchdog;
        w.loop_silent_ms = millis(loop_silent);
        // A loop that has ended published its final status; it is not stalled.
        w.loop_stalled = !self.is_stopped() && loop_silent > SUPERVISOR_TIMEOUT;
        w.trip_pending = self.watchdog.trip.is_tripped();
        w.watchdog_silent_ms = millis(self.watchdog.alive.silent_for(at));
        status
    }

    /// True once the sender task has ended (shutdown, abort or failure).
    pub fn is_stopped(&self) -> bool {
        self.status.stopped.load(Ordering::SeqCst)
    }

    /// Asks the sender task to disarm and stop, and the relay and watchdog to stop.
    pub fn shutdown(&self) {
        self.shutdown.send_replace(true);
    }

    pub fn log(&self) -> ControlLog {
        self.log.clone()
    }

    /// Holds the status lock as a slow reader would; for tests of the non-blocking publish.
    #[cfg(test)]
    pub(crate) fn hold_status(&self) -> std::sync::MutexGuard<'_, ControlStatus> {
        self.status
            .status
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
    }
}

/// The control tasks, ready to be spawned, and the handle to operate them.
pub struct ControlRuntime {
    pub handle: ControlHandle,
    /// The control loop. Runs until shutdown; resolves with what the shutdown did. The
    /// application runs it on its own elevated thread.
    pub sender_task: BoxFuture<ShutdownReport>,
    /// Forwards telemetry frames to the control loop. Runs until shutdown, on the shared
    /// runtime.
    pub relay_task: BoxFuture<()>,
    /// Runs until shutdown, on the shared runtime.
    pub watchdog_task: BoxFuture<()>,
}

/// Builds the dry-run control runtime with tokio's timer (deterministic tests). Nothing runs
/// until the returned futures are spawned.
pub fn build(
    feed: impl FrameSource,
    source: Box<dyn RequestSource>,
    config: CoreConfig,
) -> ControlRuntime {
    build_with_timer(feed, source, config, Box::new(TokioTimer), None)
}

/// Builds the dry-run control runtime with the given tick timer. The application uses a
/// precise timer and runs the sender task on its own thread (see `control_app`).
/// `observer`, if given, receives a copy of every log record (diagnostics only; see `log`).
pub fn build_with_timer(
    feed: impl FrameSource,
    source: Box<dyn RequestSource>,
    mut config: CoreConfig,
    timer: Box<dyn TickTimer>,
    observer: Option<Arc<dyn LogObserver>>,
) -> ControlRuntime {
    config.timer = timer.kind();
    let start = now();
    let log = ControlLog::with_observer(start, observer);
    let watchdog = Watchdog::new(Heartbeat::new(start), SUPERVISOR_TIMEOUT);
    let link = watchdog.link();
    let core = ControlCore::dry_run(config, source, log.clone(), link.clone(), start);

    let (command_tx, command_rx) = mpsc::unbounded_channel();
    let (input_tx, input_rx) = mailbox::mailbox();
    let (shutdown_tx, shutdown_rx) = watch::channel(false);
    let status = Arc::new(StatusCell {
        status: Mutex::new(core.status(start)),
        stopped: AtomicBool::new(false),
    });
    ControlRuntime {
        handle: ControlHandle {
            commands: command_tx,
            shutdown: Arc::new(shutdown_tx),
            log: log.clone(),
            status: status.clone(),
            watchdog: link,
        },
        sender_task: Box::pin(run_sender(
            core,
            input_rx,
            command_rx,
            shutdown_rx.clone(),
            status,
            timer,
        )),
        relay_task: Box::pin(run_relay(feed, input_tx, shutdown_rx.clone())),
        watchdog_task: Box::pin(run_watchdog(watchdog, log, shutdown_rx)),
    }
}

/// Forwards the digest of the receiver's current frame, if there is one. The digest is built
/// here, on the relay, so the control thread never handles (or frees) the frame itself.
fn forward(receiver: &mut FrameReceiver, inputs: &mut MailboxSender) {
    let observed_at = now();
    let digest = receiver.borrow_and_update().as_ref().map(FrameDigest::of);
    if let Some(digest) = digest {
        inputs.send_frame(digest, observed_at);
    }
}

/// Runs on the shared runtime: forwards every frame of the engine's channel to the control
/// loop and reports when the channel is lost and found again. The control loop never waits on
/// the mailbox, so the relay cannot wake (or block) the elevated control thread.
async fn run_relay(
    feed: impl FrameSource,
    mut inputs: MailboxSender,
    mut shutdown: watch::Receiver<bool>,
) {
    let inputs = &mut inputs;
    let mut receiver = feed.receiver();
    let mut open = receiver.has_changed().is_ok();
    if open {
        forward(&mut receiver, inputs);
    } else {
        inputs.send_feed_lost(now());
    }
    let mut retry = tokio::time::interval(FEED_RETRY);
    retry.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    while !inputs.is_closed() {
        tokio::select! {
            biased;
            _ = shutdown.changed() => break,
            changed = receiver.changed(), if open => {
                if changed.is_ok() {
                    forward(&mut receiver, inputs);
                } else {
                    open = false;
                    inputs.send_feed_lost(now());
                }
            }
            _ = retry.tick(), if !open => {
                // The engine may have restarted its pipe server and replaced the channel.
                receiver = feed.receiver();
                if receiver.has_changed().is_ok() {
                    open = true;
                    inputs.send_feed_restored(now());
                    forward(&mut receiver, inputs);
                }
            }
        }
    }
}

/// Hands what the relay queued to the core, in order: at most `mailbox::CAPACITY` items,
/// never waiting. A loss in the hand-off starts a new freshness epoch at the point where it
/// happened (see `mailbox`).
fn drain_inputs(
    core: &mut ControlCore<DryRunSink>,
    inputs: &mut MailboxReceiver,
    at: Instant,
) -> usize {
    inputs.drain(|received| match received {
        Received::Lost { .. } => core.note_handoff_loss(at),
        Received::Delivery(Delivery::Frame {
            digest,
            observed_at,
        }) => {
            core.on_digest(&digest, observed_at);
        }
        Received::Delivery(Delivery::FeedLost(when)) => core.note_feed(false, when),
        Received::Delivery(Delivery::FeedRestored(when)) => core.note_feed(true, when),
    })
}

/// Answers to one command batch, sent by [`Answers::send`] once the tick has offered its
/// status.
struct Answers(Vec<(oneshot::Sender<CommandReply>, CommandReply)>);

impl Answers {
    fn send(self) {
        for (reply, answer) in self.0 {
            // The requester may have given up waiting; that is not an error.
            let _ = reply.send(answer);
        }
    }
}

/// Processes every queued command, any disarm first, and returns the answers. Never waits
/// for new commands, and never touches the status: the tick that follows publishes it without
/// waiting, and the answers are sent after that (see `run_sender`).
///
/// A disarm has priority over its whole batch: if the batch contains one, every arm and
/// activation in it is refused with `Rejection::SupersededByDisarm` instead of being
/// processed, wherever it stands in the batch. Otherwise an arm and an activation queued in
/// the same period as a disarm would re-arm control right after it (F-01).
fn drain_commands(
    core: &mut ControlCore<DryRunSink>,
    queue: &mut mpsc::UnboundedReceiver<Request>,
    at: Instant,
) -> Answers {
    let mut batch = Vec::new();
    while let Ok(request) = queue.try_recv() {
        batch.push(request);
    }
    if batch.is_empty() {
        return Answers(Vec::new());
    }
    let (disarms, others): (Vec<Request>, Vec<Request>) = batch
        .into_iter()
        .partition(|r| r.command == Command::Disarm);
    let disarm_requested = !disarms.is_empty();
    let mut answered = Vec::with_capacity(disarms.len() + others.len());
    for request in disarms.into_iter().chain(others) {
        let response = match request.command {
            Command::Arm | Command::Activate if disarm_requested => {
                core.supersede_by_disarm(request.command, at)
            }
            command => core.on_command(command, at),
        };
        answered.push((request.reply, response));
    }
    let state = core.state();
    Answers(
        answered
            .into_iter()
            .filter_map(|(reply, response)| Some((reply?, CommandReply { response, state })))
            .collect(),
    )
}

async fn run_sender(
    mut core: ControlCore<DryRunSink>,
    mut inputs: MailboxReceiver,
    mut commands: mpsc::UnboundedReceiver<Request>,
    mut shutdown: watch::Receiver<bool>,
    status: Arc<StatusCell>,
    mut timer: Box<dyn TickTimer>,
) -> ShutdownReport {
    let _stopped = StoppedOnDrop(status.clone());
    loop {
        let deadline = core.next_deadline();
        tokio::select! {
            biased;
            // Shutdown, or the handle was dropped: either way, disarm and stop.
            _ = shutdown.changed() => break,
            () = timer.wait_until(deadline) => {
                let at = now();
                // Diagnostics only: timestamps around the unchanged steps (see `timing`).
                let control_start_qpc = qpc::now();
                let wake = timer.last_wake().filter(|w| w.deadline == deadline);
                // Safety signals from outside the loop first: a stall the watchdog saw (or a
                // silent watchdog) is handled before any command queued meanwhile, so an arm
                // or activation from this tick cannot follow it.
                core.check_external_safety(at);
                let inputs_taken = drain_inputs(&mut core, &mut inputs, at);
                let answers = drain_commands(&mut core, &mut commands, at);
                core.tick(at);
                let work_done = now();
                core.tick_finished(work_done);
                let (current, log_lock) = core.status_timed(at);
                let status_built = now();
                let publish = status.publish_if_free(current);
                let status_published = now();
                core.record_tick_diagnostics(TickDiagnostics {
                    deadline,
                    timer_woke: wake.map(|w| w.woke),
                    timer_signalled: wake.map(|w| w.signalled),
                    control_start: at,
                    control_start_qpc,
                    work_done,
                    status_built,
                    status_published,
                    published: publish.published,
                    log_lock_wait: log_lock.wait,
                    log_lock_hold: log_lock.hold,
                    status_lock_attempt: publish.attempt,
                    status_lock_hold: publish.hold,
                    inputs: inputs_taken,
                });
                // After the publication, so a requester never sees a status older than its
                // answer, unless a reader held the status: then the answer is not held back,
                // its `state` is authoritative and the status follows at a later tick.
                answers.send();
            }
        }
    }
    let at = now();
    let report = core.shutdown(at);
    // The final status (disarmed) is published before the task ends. The only waiting
    // publication: the control loop has ended, so no tick can be delayed by it.
    status.publish(core.status(at));
    report
}

async fn run_watchdog(
    mut watchdog: Watchdog,
    log: ControlLog,
    mut shutdown: watch::Receiver<bool>,
) {
    loop {
        tokio::select! {
            biased;
            _ = shutdown.changed() => break,
            () = sleep(WATCHDOG_PERIOD) => {
                let at = now();
                if let Some(silent_for) = watchdog.check(at) {
                    log.decision(at, DecisionEvent::WatchdogTripped { silent_for });
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::super::command::{ControlRequest, Withheld};
    use super::super::log::{DisarmStatus, LogSnapshot, MessageKind};
    use super::super::sender::NeutralRequests;
    use super::super::supervisor::{Reason, Rejection, SafetyEvent, State};
    use super::super::vehicle::test_support::slow_frame;
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::time::Duration;
    use tokio::task::JoinHandle;

    fn ms(n: u64) -> Duration {
        Duration::from_millis(n)
    }

    /// Advances the paused clock in 1 ms steps so every timer fires at its exact time.
    async fn run_for(millis: u64) {
        for _ in 0..millis {
            tokio::time::advance(ms(1)).await;
            tokio::task::yield_now().await;
        }
    }

    /// Publishes a frame every 16 ms on its own channel until stopped.
    struct Feeder {
        task: JoinHandle<()>,
    }

    impl Feeder {
        fn start(sender: watch::Sender<Option<ReceivedTelemetryFrame>>, session: u64) -> Self {
            let base = now();
            let sequence = Arc::new(AtomicU64::new(0));
            let task = tokio::spawn(async move {
                let mut ticker = tokio::time::interval(ms(16));
                loop {
                    ticker.tick().await;
                    let at = now();
                    let seq = sequence.fetch_add(1, Ordering::SeqCst) + 1;
                    let sim = u64::try_from(at.duration_since(base).as_micros()).unwrap();
                    let received = ReceivedTelemetryFrame {
                        frame: slow_frame(session, seq, sim),
                        dropped_fields: Vec::new(),
                        received_at: at,
                        received_qpc: crate::control::vehicle::test_support::RECEIVED_QPC,
                    };
                    if sender.send(Some(received)).is_err() {
                        break;
                    }
                }
            });
            Self { task }
        }

        /// Stops publishing and drops the channel, as when the pipe server task ends.
        async fn stop(self) {
            self.task.abort();
            let _ = self.task.await;
        }
    }

    struct Setup {
        handle: ControlHandle,
        sender: JoinHandle<ShutdownReport>,
        watchdog: JoinHandle<()>,
    }

    fn spawn_runtime(feed: &FrameFeed, request: Box<dyn RequestSource>) -> Setup {
        spawn_with_timer(feed, request, Box::new(TokioTimer))
    }

    fn spawn_with_timer(
        feed: &FrameFeed,
        request: Box<dyn RequestSource>,
        timer: Box<dyn TickTimer>,
    ) -> Setup {
        let rt = build_with_timer(feed.clone(), request, CoreConfig::default(), timer, None);
        // The relay ends by itself at shutdown.
        drop(tokio::spawn(rt.relay_task));
        Setup {
            handle: rt.handle,
            sender: tokio::spawn(rt.sender_task),
            watchdog: tokio::spawn(rt.watchdog_task),
        }
    }

    fn feed_with_channel() -> (FrameFeed, watch::Sender<Option<ReceivedTelemetryFrame>>) {
        let feed = FrameFeed::new();
        let (tx, rx) = watch::channel(None);
        feed.publish(rx);
        (feed, tx)
    }

    fn decisions(s: &LogSnapshot) -> Vec<DecisionEvent> {
        s.decisions.iter().map(|e| e.event).collect()
    }

    fn count_messages(s: &LogSnapshot, kind: MessageKind) -> usize {
        s.messages.iter().filter(|e| e.event.kind == kind).count()
    }

    fn faulted_with(s: &LogSnapshot, f: impl Fn(&SafetyEvent) -> bool) -> bool {
        decisions(s).iter().any(|d| match d {
            DecisionEvent::Transition(t) => {
                t.to == State::Fault && matches!(&t.reason, Reason::Safety(e) if f(e))
            }
            _ => false,
        })
    }

    async fn arm_and_activate(handle: &ControlHandle) {
        assert!(handle.send(Command::Arm));
        run_for(45).await;
        assert!(handle.send(Command::Activate));
        run_for(45).await;
    }

    #[tokio::test(start_paused = true)]
    async fn the_runtime_starts_disabled_and_stays_silent() {
        let (feed, tx) = feed_with_channel();
        let setup = spawn_runtime(&feed, Box::new(NeutralRequests));
        let feeder = Feeder::start(tx, 7);
        run_for(2_000).await;
        let log = setup.handle.log().snapshot();
        assert!(
            log.messages.is_empty(),
            "nothing is encoded without an explicit arm"
        );
        assert!(
            !decisions(&log)
                .iter()
                .any(|d| matches!(d, DecisionEvent::Transition(_)))
        );
        feeder.stop().await;
        setup.handle.shutdown();
        let report = setup.sender.await.unwrap();
        assert_eq!(report.disarm, DisarmStatus::NotRequired);
        setup.watchdog.await.unwrap();
    }

    #[tokio::test(start_paused = true)]
    async fn an_armed_runtime_encodes_a_command_every_40_ms_and_transmits_nothing() {
        let (feed, tx) = feed_with_channel();
        let setup = spawn_runtime(&feed, Box::new(NeutralRequests));
        let feeder = Feeder::start(tx, 7);
        run_for(300).await;
        arm_and_activate(&setup.handle).await;
        run_for(1_000).await;
        let log = setup.handle.log().snapshot();
        let times: Vec<Duration> = log
            .messages
            .iter()
            .filter(|e| e.event.kind == MessageKind::Command)
            .map(|e| e.at)
            .collect();
        assert!(times.len() >= 24, "{}", times.len());
        for pair in times.windows(2) {
            assert_eq!(pair[1] - pair[0], ms(40), "the grid is exact: {times:?}");
        }
        assert!(
            log.messages
                .iter()
                .all(|e| e.event.delivery == super::super::sink::Delivery::NotTransmitted)
        );
        assert!(log.timing.is_empty(), "no late ticks on a healthy loop");
        feeder.stop().await;
        setup.handle.shutdown();
        setup.sender.await.unwrap();
        setup.watchdog.await.unwrap();
    }

    #[tokio::test(start_paused = true)]
    async fn telemetry_is_consumed_per_frame_not_at_the_dashboard_rate() {
        // Frames every 16 ms: after one second the core has accepted about 62, far more than
        // the 10 a dashboard sample would give.
        let (feed, tx) = feed_with_channel();
        let setup = spawn_runtime(&feed, Box::new(NeutralRequests));
        let feeder = Feeder::start(tx, 7);
        run_for(1_000).await;
        // Arming works only if telemetry is usable, which needs the monitor to have seen
        // several consecutive frames.
        assert!(setup.handle.send(Command::Arm));
        run_for(45).await;
        let log = setup.handle.log().snapshot();
        assert!(
            decisions(&log).iter().any(|d| matches!(
                d,
                DecisionEvent::Transition(t) if t.to == State::Armed
            )),
            "{:?}",
            decisions(&log)
        );
        feeder.stop().await;
        setup.handle.shutdown();
        setup.sender.await.unwrap();
        setup.watchdog.await.unwrap();
    }

    #[tokio::test(start_paused = true)]
    async fn losing_the_frames_faults_and_encodes_exactly_one_disarm() {
        let (feed, tx) = feed_with_channel();
        let setup = spawn_runtime(&feed, Box::new(NeutralRequests));
        let feeder = Feeder::start(tx, 7);
        run_for(300).await;
        arm_and_activate(&setup.handle).await;
        run_for(400).await;
        let before = setup.handle.log().snapshot();
        assert!(count_messages(&before, MessageKind::Command) > 5);

        feeder.stop().await; // the plugin disconnects
        run_for(1_000).await;
        let log = setup.handle.log().snapshot();
        assert!(faulted_with(&log, |e| matches!(
            e,
            SafetyEvent::StaleTelemetry { .. }
        )));
        assert_eq!(count_messages(&log, MessageKind::Disarm), 1);
        let commands = count_messages(&log, MessageKind::Command);
        run_for(2_000).await;
        let later = setup.handle.log().snapshot();
        assert_eq!(count_messages(&later, MessageKind::Command), commands);
        assert_eq!(count_messages(&later, MessageKind::Disarm), 1);
        assert!(
            decisions(&later)
                .iter()
                .any(|d| matches!(d, DecisionEvent::FeedLost))
        );
        setup.handle.shutdown();
        setup.sender.await.unwrap();
        setup.watchdog.await.unwrap();
    }

    #[tokio::test(start_paused = true)]
    async fn following_a_replaced_channel_never_restores_output() {
        let (feed, tx) = feed_with_channel();
        let setup = spawn_runtime(&feed, Box::new(NeutralRequests));
        let feeder = Feeder::start(tx, 7);
        run_for(300).await;
        arm_and_activate(&setup.handle).await;
        run_for(300).await;

        // The engine restarts its pipe server: the old channel closes, a new one is published.
        feeder.stop().await;
        run_for(600).await;
        let (new_tx, new_rx) = watch::channel(None);
        feed.publish(new_rx);
        let new_feeder = Feeder::start(new_tx, 7);
        run_for(1_500).await;

        let log = setup.handle.log().snapshot();
        let d = decisions(&log);
        assert!(d.iter().any(|e| matches!(e, DecisionEvent::FeedLost)));
        assert!(d.iter().any(|e| matches!(e, DecisionEvent::FeedRestored)));
        assert!(
            faulted_with(&log, |_| true),
            "the interruption faulted control"
        );
        let commands = count_messages(&log, MessageKind::Command);
        run_for(1_000).await;
        assert_eq!(
            count_messages(&setup.handle.log().snapshot(), MessageKind::Command),
            commands,
            "frames flowing again do not restore output"
        );

        // The deliberate sequence works on the new channel, which proves it is being read.
        assert!(setup.handle.send(Command::ResetFault));
        run_for(45).await;
        arm_and_activate(&setup.handle).await;
        run_for(400).await;
        assert!(
            count_messages(&setup.handle.log().snapshot(), MessageKind::Command) > commands,
            "output resumes only after reset, arm and activate"
        );
        new_feeder.stop().await;
        setup.handle.shutdown();
        setup.sender.await.unwrap();
        setup.watchdog.await.unwrap();
    }

    #[tokio::test(start_paused = true)]
    async fn a_feed_that_is_closed_at_start_is_picked_up_when_the_engine_publishes() {
        let feed = FrameFeed::new(); // closed until the engine has started
        let setup = spawn_runtime(&feed, Box::new(NeutralRequests));
        run_for(200).await;
        let (tx, rx) = watch::channel(None);
        feed.publish(rx);
        let feeder = Feeder::start(tx, 7);
        run_for(600).await;
        let log = setup.handle.log().snapshot();
        let d = decisions(&log);
        assert!(d.iter().any(|e| matches!(e, DecisionEvent::FeedLost)));
        assert!(d.iter().any(|e| matches!(e, DecisionEvent::FeedRestored)));
        // Telemetry is usable now: arming succeeds.
        assert!(setup.handle.send(Command::Arm));
        run_for(45).await;
        assert!(
            decisions(&setup.handle.log().snapshot())
                .iter()
                .any(|e| matches!(
                    e,
                    DecisionEvent::Transition(t) if t.to == State::Armed
                ))
        );
        feeder.stop().await;
        setup.handle.shutdown();
        setup.sender.await.unwrap();
        setup.watchdog.await.unwrap();
    }

    #[tokio::test(start_paused = true)]
    async fn shutdown_while_active_disarms_and_reports_truthfully() {
        let (feed, tx) = feed_with_channel();
        let setup = spawn_runtime(&feed, Box::new(NeutralRequests));
        let feeder = Feeder::start(tx, 7);
        run_for(300).await;
        arm_and_activate(&setup.handle).await;
        run_for(300).await;
        setup.handle.shutdown();
        let report = setup.sender.await.unwrap();
        assert_eq!(report.transition.map(|t| t.reason), Some(Reason::Shutdown));
        assert_eq!(report.disarm, DisarmStatus::EncodedNotTransmitted);
        let log = setup.handle.log().snapshot();
        assert_eq!(count_messages(&log, MessageKind::Disarm), 1);
        assert!(decisions(&log).iter().any(|d| matches!(
            d,
            DecisionEvent::Shutdown {
                disarm: DisarmStatus::EncodedNotTransmitted
            }
        )));
        setup.watchdog.await.unwrap();
        feeder.stop().await;
        assert!(!setup.handle.send(Command::Arm), "the control task is gone");
    }

    #[tokio::test(start_paused = true)]
    async fn an_aborted_sender_task_still_encodes_the_disarm() {
        let (feed, tx) = feed_with_channel();
        let setup = spawn_runtime(&feed, Box::new(NeutralRequests));
        let feeder = Feeder::start(tx, 7);
        run_for(300).await;
        arm_and_activate(&setup.handle).await;
        run_for(300).await;
        let log = setup.handle.log();
        let disarms_before = count_messages(&log.snapshot(), MessageKind::Disarm);
        setup.sender.abort(); // for example the application exits without a clean shutdown
        let _ = setup.sender.await;
        assert_eq!(
            count_messages(&log.snapshot(), MessageKind::Disarm),
            disarms_before + 1
        );
        setup.handle.shutdown();
        setup.watchdog.await.unwrap();
        feeder.stop().await;
    }

    #[tokio::test(start_paused = true)]
    async fn dropping_the_handle_shuts_the_runtime_down_safely() {
        let (feed, tx) = feed_with_channel();
        let setup = spawn_runtime(&feed, Box::new(NeutralRequests));
        let feeder = Feeder::start(tx, 7);
        run_for(300).await;
        arm_and_activate(&setup.handle).await;
        run_for(200).await;
        let log = setup.handle.log();
        drop(setup.handle);
        let report = setup.sender.await.unwrap();
        assert_eq!(report.disarm, DisarmStatus::EncodedNotTransmitted);
        assert_eq!(count_messages(&log.snapshot(), MessageKind::Disarm), 1);
        setup.watchdog.await.unwrap();
        feeder.stop().await;
    }

    #[tokio::test(start_paused = true)]
    async fn a_queued_disarm_is_processed_before_other_commands() {
        let (feed, tx) = feed_with_channel();
        let setup = spawn_runtime(&feed, Box::new(NeutralRequests));
        let feeder = Feeder::start(tx, 7);
        run_for(300).await;
        arm_and_activate(&setup.handle).await;
        run_for(200).await;
        // Both are queued before the loop runs; the disarm goes first.
        assert!(setup.handle.send(Command::Activate));
        assert!(setup.handle.send(Command::Disarm));
        run_for(45).await;
        let d = decisions(&setup.handle.log().snapshot());
        let disarm_at = d
            .iter()
            .position(
                |e| matches!(e, DecisionEvent::Transition(t) if t.reason == Reason::ManualDisarm),
            )
            .expect("the disarm was processed");
        let rejected_at = d
            .iter()
            .position(|e| {
                matches!(
                    e,
                    DecisionEvent::CommandRejected {
                        command: Command::Activate,
                        rejection: Rejection::SupersededByDisarm
                    }
                )
            })
            .expect("the activation was refused after the disarm, which has priority");
        assert!(disarm_at < rejected_at);
        feeder.stop().await;
        setup.handle.shutdown();
        setup.sender.await.unwrap();
        setup.watchdog.await.unwrap();
    }

    /// Queues every command before the loop runs, so they form one batch, and returns the
    /// replies in the order the commands were sent.
    async fn send_batch(handle: &ControlHandle, commands: &[Command]) -> Vec<CommandReply> {
        let pending: Vec<_> = commands
            .iter()
            .map(|c| handle.request(*c).expect("the control task runs"))
            .collect();
        run_for(45).await;
        let mut replies = Vec::with_capacity(pending.len());
        for rx in pending {
            replies.push(rx.await.expect("the batch was answered"));
        }
        replies
    }

    /// A running runtime with usable telemetry, brought into `state` (Disabled, Armed or
    /// Active) by the normal manual sequence.
    async fn runtime_in(state: State) -> (Setup, Feeder) {
        runtime_with_timer_in(state, Box::new(TokioTimer)).await
    }

    async fn runtime_with_timer_in(state: State, timer: Box<dyn TickTimer>) -> (Setup, Feeder) {
        let (feed, tx) = feed_with_channel();
        let setup = spawn_with_timer(&feed, Box::new(NeutralRequests), timer);
        let feeder = Feeder::start(tx, 7);
        run_for(300).await;
        match state {
            State::Disabled => {}
            State::Armed => {
                assert!(setup.handle.send(Command::Arm));
                run_for(45).await;
            }
            State::Active => {
                arm_and_activate(&setup.handle).await;
                run_for(200).await;
            }
            State::Fault => unreachable!("not a starting state of these tests"),
        }
        assert_eq!(setup.handle.status().state, state.into());
        (setup, feeder)
    }

    async fn stop(setup: Setup, feeder: Feeder) {
        feeder.stop().await;
        setup.handle.shutdown();
        setup.sender.await.unwrap();
        setup.watchdog.await.unwrap();
    }

    fn superseded(reply: &CommandReply) -> bool {
        reply.response.result == Err(Rejection::SupersededByDisarm)
            && reply.response.transition.is_none()
    }

    fn superseded_in_log(log: &LogSnapshot, command: Command) -> bool {
        decisions(log).iter().any(|d| {
            matches!(
                d,
                DecisionEvent::CommandRejected { command: c, rejection: Rejection::SupersededByDisarm }
                    if *c == command
            )
        })
    }

    fn armed_or_activated(log: &LogSnapshot, since: usize) -> bool {
        decisions(log)[since..].iter().any(|d| {
            matches!(d, DecisionEvent::Transition(t) if t.to == State::Armed || t.to == State::Active)
        })
    }

    // SUP-08 (F-01): a disarm at the end of a batch is not undone by the arm and activate
    // processed before it.
    #[tokio::test(start_paused = true)]
    async fn sup_08_a_batch_arm_activate_disarm_stays_disabled() {
        let (setup, feeder) = runtime_in(State::Disabled).await;
        let since = setup.handle.log().snapshot().decisions.len();
        let replies = send_batch(
            &setup.handle,
            &[Command::Arm, Command::Activate, Command::Disarm],
        )
        .await;
        run_for(400).await;
        let log = setup.handle.log().snapshot();
        assert!(
            replies.iter().all(|r| r.state == State::Disabled),
            "{replies:?}"
        );
        assert_eq!(setup.handle.status().state, State::Disabled.into());
        assert!(superseded(&replies[0]), "{:?}", replies[0]);
        assert!(superseded(&replies[1]), "{:?}", replies[1]);
        assert_eq!(replies[2].response.result, Ok(()));
        assert!(superseded_in_log(&log, Command::Arm));
        assert!(superseded_in_log(&log, Command::Activate));
        assert!(!armed_or_activated(&log, since), "{:?}", decisions(&log));
        assert!(
            log.messages.is_empty(),
            "nothing is encoded: {:?}",
            log.messages
        );
        stop(setup, feeder).await;
    }

    // SUP-09
    #[tokio::test(start_paused = true)]
    async fn sup_09_a_batch_arm_disarm_stays_disabled() {
        let (setup, feeder) = runtime_in(State::Disabled).await;
        let since = setup.handle.log().snapshot().decisions.len();
        let replies = send_batch(&setup.handle, &[Command::Arm, Command::Disarm]).await;
        run_for(400).await;
        let log = setup.handle.log().snapshot();
        assert_eq!(setup.handle.status().state, State::Disabled.into());
        assert!(replies.iter().all(|r| r.state == State::Disabled));
        assert!(superseded(&replies[0]), "{:?}", replies[0]);
        assert_eq!(replies[1].response.result, Ok(()));
        assert!(superseded_in_log(&log, Command::Arm));
        assert!(!armed_or_activated(&log, since));
        assert!(
            log.messages.is_empty(),
            "nothing is encoded: {:?}",
            log.messages
        );
        stop(setup, feeder).await;
    }

    // SUP-10: the disarm wins wherever it stands in the batch.
    #[tokio::test(start_paused = true)]
    async fn sup_10_armed_with_a_batch_disarm_arm_ends_disabled() {
        let (setup, feeder) = runtime_in(State::Armed).await;
        let since = setup.handle.log().snapshot().decisions.len();
        let replies = send_batch(&setup.handle, &[Command::Disarm, Command::Arm]).await;
        run_for(400).await;
        let log = setup.handle.log().snapshot();
        assert_eq!(setup.handle.status().state, State::Disabled.into());
        assert!(replies.iter().all(|r| r.state == State::Disabled));
        assert_eq!(
            replies[0]
                .response
                .transition
                .map(|t| (t.from, t.to, t.reason)),
            Some((State::Armed, State::Disabled, Reason::ManualDisarm))
        );
        assert!(superseded(&replies[1]), "{:?}", replies[1]);
        assert!(superseded_in_log(&log, Command::Arm));
        assert!(!armed_or_activated(&log, since));
        assert_eq!(count_messages(&log, MessageKind::Command), 0);
        stop(setup, feeder).await;
    }

    // SUP-11
    #[tokio::test(start_paused = true)]
    async fn sup_11_active_with_a_batch_disarm_activate_arm_encodes_one_disarm_only() {
        let (setup, feeder) = runtime_in(State::Active).await;
        let before = setup.handle.log().snapshot();
        let since = before.decisions.len();
        assert_eq!(count_messages(&before, MessageKind::Disarm), 0);
        let commands = count_messages(&before, MessageKind::Command);
        assert!(commands > 0, "output was running");
        let replies = send_batch(
            &setup.handle,
            &[Command::Disarm, Command::Activate, Command::Arm],
        )
        .await;
        run_for(400).await;
        let log = setup.handle.log().snapshot();
        assert_eq!(setup.handle.status().state, State::Disabled.into());
        assert!(replies.iter().all(|r| r.state == State::Disabled));
        assert_eq!(
            replies[0].response.transition.map(|t| t.reason),
            Some(Reason::ManualDisarm)
        );
        assert!(superseded(&replies[1]), "{:?}", replies[1]);
        assert!(superseded(&replies[2]), "{:?}", replies[2]);
        assert!(superseded_in_log(&log, Command::Activate));
        assert!(superseded_in_log(&log, Command::Arm));
        assert!(!armed_or_activated(&log, since));
        assert_eq!(count_messages(&log, MessageKind::Disarm), 1);
        assert_eq!(
            count_messages(&log, MessageKind::Command),
            commands,
            "no command after the disarm"
        );
        stop(setup, feeder).await;
    }

    // SUP-12
    #[tokio::test(start_paused = true)]
    async fn sup_12_active_with_a_batch_activate_disarm_encodes_one_disarm_only() {
        let (setup, feeder) = runtime_in(State::Active).await;
        let before = setup.handle.log().snapshot();
        let since = before.decisions.len();
        let commands = count_messages(&before, MessageKind::Command);
        let replies = send_batch(&setup.handle, &[Command::Activate, Command::Disarm]).await;
        run_for(400).await;
        let log = setup.handle.log().snapshot();
        assert_eq!(setup.handle.status().state, State::Disabled.into());
        assert!(superseded(&replies[0]), "{:?}", replies[0]);
        assert_eq!(
            replies[1].response.transition.map(|t| t.reason),
            Some(Reason::ManualDisarm)
        );
        assert!(superseded_in_log(&log, Command::Activate));
        assert!(!armed_or_activated(&log, since));
        assert_eq!(count_messages(&log, MessageKind::Disarm), 1);
        assert_eq!(count_messages(&log, MessageKind::Command), commands);
        stop(setup, feeder).await;
    }

    // SUP-13: without a disarm in the batch the command semantics are unchanged.
    #[tokio::test(start_paused = true)]
    async fn sup_13_a_batch_without_disarm_arms_and_activates_as_before() {
        let (setup, feeder) = runtime_in(State::Disabled).await;
        let replies = send_batch(&setup.handle, &[Command::Arm, Command::Activate]).await;
        assert_eq!(
            replies[0].response.transition.map(|t| t.reason),
            Some(Reason::ManualArm)
        );
        assert_eq!(
            replies[1].response.transition.map(|t| t.reason),
            Some(Reason::ManualActivate)
        );
        assert!(replies.iter().all(|r| r.state == State::Active));
        run_for(400).await;
        let log = setup.handle.log().snapshot();
        assert_eq!(setup.handle.status().state, State::Active.into());
        assert!(count_messages(&log, MessageKind::Command) > 5);
        assert!(!superseded_in_log(&log, Command::Arm));
        assert!(!superseded_in_log(&log, Command::Activate));

        // The other rejections are unchanged too.
        let replies = send_batch(&setup.handle, &[Command::Arm, Command::Activate]).await;
        assert_eq!(replies[0].response.result, Err(Rejection::AlreadyArmed));
        assert_eq!(replies[1].response.result, Err(Rejection::NotArmed));
        assert_eq!(setup.handle.status().state, State::Active.into());
        stop(setup, feeder).await;
    }

    // ---- F-02: the status is never published with a waiting lock in the loop ----

    fn skipped(status: &ControlStatus) -> u64 {
        status.timing.diagnostics.status_publish_skipped
    }

    // F-02 (1): with no reader, the status is published before the answer, as before.
    #[tokio::test(start_paused = true)]
    async fn a_free_status_is_published_before_the_answer() {
        let (setup, feeder) = runtime_in(State::Disabled).await;
        let replies = send_batch(&setup.handle, &[Command::Arm]).await;
        assert_eq!(replies[0].state, State::Armed);
        let status = setup.handle.status();
        assert_eq!(
            status.state,
            State::Armed.into(),
            "no older than the answer"
        );
        assert_eq!(skipped(&status), 0);
        stop(setup, feeder).await;
    }

    // F-02 (2)-(5): a held status neither stops the loop nor the answers; the skipped
    // publications are counted, the old status stays whole, and publishing resumes.
    #[tokio::test(start_paused = true)]
    #[expect(
        clippy::await_holding_lock,
        reason = "the test plays a reader that holds the status while the loop runs"
    )]
    async fn a_held_status_is_skipped_kept_whole_and_published_again_after_release() {
        let (setup, feeder) = runtime_in(State::Disabled).await;
        let before = setup.handle.status();
        let ticks_before = before.timing.ticks;
        {
            let reader = setup.handle.hold_status();
            let answer = setup.handle.request(Command::Arm).unwrap();
            run_for(200).await;
            // The loop did not wait: the command was processed and answered meanwhile.
            let reply = answer
                .await
                .expect("answered while the reader held the status");
            assert_eq!(reply.response.result, Ok(()));
            assert_eq!(reply.state, State::Armed);
            assert!(
                decisions(&setup.handle.log().snapshot())
                    .iter()
                    .any(|d| matches!(d, DecisionEvent::Transition(t) if t.to == State::Armed))
            );
            // The published status is still the complete previous one, unchanged.
            let mut held = reader.clone();
            held.watchdog.loop_silent_ms = before.watchdog.loop_silent_ms;
            assert_eq!(held, before);
        }
        run_for(45).await;
        let after = setup.handle.status();
        assert_eq!(after.state, State::Armed.into());
        assert!(after.now_ms > before.now_ms);
        let ticks = after.timing.ticks - ticks_before;
        let skips = skipped(&after);
        assert!((4..=6).contains(&skips), "{skips} skipped in {ticks} ticks");
        assert!(ticks > skips, "a later tick published again");
        run_for(400).await;
        assert_eq!(skipped(&setup.handle.status()), skips, "no further skips");
        stop(setup, feeder).await;
    }

    // F-02 (6): a long hold skips one publication per tick and queues nothing: after release
    // the next tick publishes the current status, not a backlog.
    #[tokio::test(start_paused = true)]
    #[expect(
        clippy::await_holding_lock,
        reason = "the test plays a reader that holds the status while the loop runs"
    )]
    async fn a_long_hold_queues_no_statuses() {
        let (setup, feeder) = runtime_in(State::Disabled).await;
        let before = setup.handle.status();
        {
            let _reader = setup.handle.hold_status();
            assert!(setup.handle.send(Command::Arm));
            run_for(1_000).await;
            assert!(setup.handle.send(Command::Activate));
            run_for(1_000).await;
        }
        run_for(45).await;
        let after = setup.handle.status();
        let ticks = after.timing.ticks - before.timing.ticks;
        assert!(ticks >= 50, "the loop kept its rate: {ticks} ticks");
        let skips = skipped(&after);
        assert!(
            (49..=51).contains(&skips),
            "one skip per held tick: {skips}"
        );
        assert_eq!(after.state, State::Active.into());
        assert!(
            after.now_ms >= before.now_ms + 2_000,
            "the newest status, not an old one: {} -> {}",
            before.now_ms,
            after.now_ms
        );
        // Output ran while the status was held.
        assert!(count_messages(&setup.handle.log().snapshot(), MessageKind::Command) > 20);
        stop(setup, feeder).await;
    }

    // F-02 (7): command processing and the disarm priority do not depend on the status lock.
    #[tokio::test(start_paused = true)]
    #[expect(
        clippy::await_holding_lock,
        reason = "the test plays a reader that holds the status while the loop runs"
    )]
    async fn the_disarm_priority_holds_while_a_reader_holds_the_status() {
        let (setup, feeder) = runtime_in(State::Active).await;
        let commands = {
            let _reader = setup.handle.hold_status();
            let replies = send_batch(
                &setup.handle,
                &[Command::Arm, Command::Activate, Command::Disarm],
            )
            .await;
            assert!(superseded(&replies[0]), "{:?}", replies[0]);
            assert!(superseded(&replies[1]), "{:?}", replies[1]);
            assert_eq!(
                replies[2].response.transition.map(|t| t.reason),
                Some(Reason::ManualDisarm)
            );
            assert!(replies.iter().all(|r| r.state == State::Disabled));
            let log = setup.handle.log().snapshot();
            assert_eq!(
                count_messages(&log, MessageKind::Disarm),
                1,
                "encoded at once"
            );
            count_messages(&log, MessageKind::Command)
        };
        run_for(400).await;
        let log = setup.handle.log().snapshot();
        assert_eq!(setup.handle.status().state, State::Disabled.into());
        assert_eq!(count_messages(&log, MessageKind::Command), commands);
        assert_eq!(count_messages(&log, MessageKind::Disarm), 1);
        stop(setup, feeder).await;
    }

    // ---- F-03 (4.6.4b): watchdog signals before commands, fresh status, watchdog liveness ----

    /// Tokio's timer that, when asked, wakes the loop once `stall` late: a stalled control loop
    /// on the paused clock, while the watchdog task keeps running.
    struct StallingTimer(Arc<AtomicU64>);

    impl TickTimer for StallingTimer {
        fn kind(&self) -> super::super::timing::TimerKind {
            super::super::timing::TimerKind::Tokio
        }

        fn wait_until(&mut self, deadline: Instant) -> super::super::timer::WaitFuture<'_> {
            let extra = ms(self.0.swap(0, Ordering::SeqCst));
            Box::pin(tokio::time::sleep_until(TokioInstant::from_std(
                deadline + extra,
            )))
        }
    }

    /// A runtime in `state` whose loop can be stalled once with [`stall`].
    async fn stallable_in(state: State) -> (Setup, Feeder, Arc<AtomicU64>) {
        let stall = Arc::new(AtomicU64::new(0));
        let (setup, feeder) =
            runtime_with_timer_in(state, Box::new(StallingTimer(stall.clone()))).await;
        (setup, feeder, stall)
    }

    /// Stalls the loop for `millis` from its next tick on and returns once the stall has begun
    /// (the loop has ticked and is waiting `millis` too long).
    async fn stall(stall: &AtomicU64, millis: u64) {
        stall.store(millis, Ordering::SeqCst);
        run_for(45).await;
        assert_eq!(stall.load(Ordering::SeqCst), 0, "the stall has begun");
    }

    /// Queues the commands while the loop is stalled and returns their answers, which arrive
    /// at the first tick after the stall.
    async fn queue_during_stall(handle: &ControlHandle, commands: &[Command]) -> Vec<CommandReply> {
        let pending: Vec<_> = commands
            .iter()
            .map(|c| handle.request(*c).expect("the control task runs"))
            .collect();
        run_for(500).await;
        let mut replies = Vec::new();
        for rx in pending {
            replies.push(rx.await.expect("answered after the stall"));
        }
        replies
    }

    fn timed_out(reply: &CommandReply) -> bool {
        matches!(
            reply.response.result,
            Err(Rejection::Safety(SafetyEvent::SupervisorTimeout { .. }))
        ) && reply.response.transition.is_none()
    }

    fn transitions_to(log: &LogSnapshot, since: usize, to: State) -> usize {
        decisions(log)[since..]
            .iter()
            .filter(|d| matches!(d, DecisionEvent::Transition(t) if t.to == to))
            .count()
    }

    // 4.6.4b (1): a stall the watchdog saw is handled before an activation queued meanwhile.
    #[tokio::test(start_paused = true)]
    async fn a_watchdog_trip_is_handled_before_a_queued_activation() {
        let (setup, feeder, stall_ms) = stallable_in(State::Armed).await;
        let since = setup.handle.log().snapshot().decisions.len();
        stall(&stall_ms, 150).await;
        let replies = queue_during_stall(&setup.handle, &[Command::Activate]).await;
        let log = setup.handle.log().snapshot();
        assert!(timed_out(&replies[0]), "{:?}", replies[0]);
        assert_eq!(replies[0].state, State::Disabled);
        assert!(decisions(&log)[since..].iter().any(|d| matches!(
            d,
            DecisionEvent::Transition(t) if t.from == State::Armed
                && t.to == State::Disabled
                && matches!(t.reason, Reason::Safety(SafetyEvent::SupervisorTimeout { .. }))
        )));
        assert_eq!(
            transitions_to(&log, since, State::Active),
            0,
            "never active"
        );
        assert_eq!(count_messages(&log, MessageKind::Command), 0);
        assert_eq!(setup.handle.status().state, State::Disabled.into());
        stop(setup, feeder).await;
    }

    // 4.6.4b (2): the whole batch queued during the stall follows the trip.
    #[tokio::test(start_paused = true)]
    async fn a_watchdog_trip_is_handled_before_a_queued_batch() {
        let (setup, feeder, stall_ms) = stallable_in(State::Disabled).await;
        let since = setup.handle.log().snapshot().decisions.len();
        stall(&stall_ms, 150).await;
        let replies = queue_during_stall(&setup.handle, &[Command::Arm, Command::Activate]).await;
        let log = setup.handle.log().snapshot();
        assert!(replies.iter().all(timed_out), "{replies:?}");
        assert!(replies.iter().all(|r| r.state == State::Disabled));
        assert_eq!(transitions_to(&log, since, State::Armed), 0);
        assert_eq!(transitions_to(&log, since, State::Active), 0);
        assert_eq!(setup.handle.status().watchdog.trips, 1);
        // The next tick without a safety event accepts commands again, as before.
        let replies = send_batch(&setup.handle, &[Command::Arm]).await;
        assert_eq!(replies[0].response.result, Ok(()));
        assert_eq!(replies[0].state, State::Armed);
        stop(setup, feeder).await;
    }

    // 4.6.4b (3): a fault from the trip is not overwritten by commands from the same tick, and
    // only an explicit reset (and a new arm) leaves it.
    #[tokio::test(start_paused = true)]
    async fn a_watchdog_fault_is_not_overwritten_by_queued_commands() {
        let (setup, feeder, stall_ms) = stallable_in(State::Active).await;
        let since = setup.handle.log().snapshot().decisions.len();
        stall(&stall_ms, 150).await;
        let commands = count_messages(&setup.handle.log().snapshot(), MessageKind::Command);
        let replies = queue_during_stall(&setup.handle, &[Command::Activate, Command::Arm]).await;
        assert!(replies.iter().all(timed_out), "{replies:?}");
        assert!(replies.iter().all(|r| r.state == State::Fault));
        run_for(400).await;
        let log = setup.handle.log().snapshot();
        assert_eq!(setup.handle.status().state, State::Fault.into());
        assert_eq!(transitions_to(&log, since, State::Fault), 1);
        assert_eq!(transitions_to(&log, since, State::Active), 0);
        assert_eq!(count_messages(&log, MessageKind::Command), commands);
        assert_eq!(count_messages(&log, MessageKind::Disarm), 1);
        // Reset and arm work as before.
        let replies = send_batch(&setup.handle, &[Command::ResetFault]).await;
        assert_eq!(replies[0].state, State::Disabled);
        let replies = send_batch(&setup.handle, &[Command::Arm]).await;
        assert_eq!(replies[0].state, State::Armed);
        stop(setup, feeder).await;
    }

    // 4.6.4b (8): the F-01 disarm priority is unchanged when a trip is handled first.
    #[tokio::test(start_paused = true)]
    async fn the_disarm_priority_holds_after_a_watchdog_trip() {
        let (setup, feeder, stall_ms) = stallable_in(State::Active).await;
        stall(&stall_ms, 150).await;
        let replies = queue_during_stall(
            &setup.handle,
            &[Command::Arm, Command::Activate, Command::Disarm],
        )
        .await;
        assert!(superseded(&replies[0]), "{:?}", replies[0]);
        assert!(superseded(&replies[1]), "{:?}", replies[1]);
        assert_eq!(replies[2].response.result, Ok(()));
        // The trip came first: the disarm finds a fault, which it keeps.
        assert!(replies.iter().all(|r| r.state == State::Fault));
        let log = setup.handle.log().snapshot();
        assert_eq!(count_messages(&log, MessageKind::Disarm), 1);
        stop(setup, feeder).await;
    }

    // 4.6.4b (4): a stalled loop cannot hide a pending trip, and its published supervisor
    // values are marked as last known.
    #[tokio::test(start_paused = true)]
    async fn the_status_shows_a_pending_trip_and_a_stalled_loop_while_the_loop_is_stuck() {
        let (setup, feeder, stall_ms) = stallable_in(State::Active).await;
        let before = setup.handle.status();
        assert!(!before.watchdog.trip_pending);
        assert!(!before.watchdog.loop_stalled);
        stall(&stall_ms, 400).await;
        run_for(150).await;
        let during = setup.handle.status();
        assert!(during.watchdog.trip_pending, "read from the flag itself");
        assert!(during.watchdog.loop_stalled);
        assert!(during.watchdog.loop_silent_ms > during.watchdog.timeout_ms);
        // What the loop published last, now explicitly only the last known values.
        assert_eq!(during.state, State::Active.into());
        assert_eq!(during.watchdog.trips, 0, "consumed trips only");
        run_for(400).await;
        let after = setup.handle.status();
        assert!(!after.watchdog.trip_pending, "consumed");
        assert!(!after.watchdog.loop_stalled);
        assert_eq!(after.watchdog.trips, 1);
        assert_eq!(after.state, State::Fault.into());
        stop(setup, feeder).await;
    }

    // 4.6.4b (5): the running watchdog task keeps its liveness fresh.
    #[tokio::test(start_paused = true)]
    async fn the_watchdog_task_records_its_liveness_at_every_check() {
        let (setup, feeder) = runtime_in(State::Disabled).await;
        for _ in 0..50 {
            run_for(7).await;
            let w = setup.handle.status().watchdog;
            assert!(
                w.watchdog_silent_ms <= millis(WATCHDOG_PERIOD),
                "{}",
                w.watchdog_silent_ms
            );
        }
        stop(setup, feeder).await;
    }

    /// Stops the runtime after its watchdog task was aborted on purpose.
    async fn stop_without_watchdog(setup: Setup, feeder: Feeder) {
        feeder.stop().await;
        setup.handle.shutdown();
        setup.sender.await.unwrap();
        assert!(setup.watchdog.await.unwrap_err().is_cancelled());
    }

    // 4.6.4b (6), (7): a failed watchdog is detected and never leads to an activation.
    #[tokio::test(start_paused = true)]
    async fn a_failed_watchdog_is_detected_and_refuses_arming() {
        let (setup, feeder) = runtime_in(State::Disabled).await;
        let since = setup.handle.log().snapshot().decisions.len();
        setup.watchdog.abort();
        run_for(400).await;
        let w = setup.handle.status().watchdog;
        assert!(w.watchdog_silent_ms > w.watchdog_limit_ms, "{w:?}");
        for _ in 0..5 {
            let replies = send_batch(&setup.handle, &[Command::Arm, Command::Activate]).await;
            for reply in &replies {
                assert!(
                    matches!(
                        reply.response.result,
                        Err(Rejection::Safety(SafetyEvent::WatchdogSilent { .. }))
                    ),
                    "{reply:?}"
                );
                assert_eq!(reply.state, State::Disabled);
            }
            run_for(400).await;
        }
        let log = setup.handle.log().snapshot();
        assert_eq!(transitions_to(&log, since, State::Armed), 0);
        assert_eq!(transitions_to(&log, since, State::Active), 0);
        assert!(log.messages.is_empty());
        stop_without_watchdog(setup, feeder).await;
    }

    // 4.6.4b (6): while Active, a failed watchdog faults control fail-closed.
    #[tokio::test(start_paused = true)]
    async fn a_failed_watchdog_faults_an_active_loop() {
        let (setup, feeder) = runtime_in(State::Active).await;
        setup.watchdog.abort();
        run_for(500).await;
        let log = setup.handle.log().snapshot();
        let fault = decisions(&log)
            .iter()
            .find_map(|d| match d {
                DecisionEvent::Transition(t) if t.to == State::Fault => Some(*t),
                _ => None,
            })
            .expect("the loop faulted");
        assert!(
            matches!(
                fault.reason,
                Reason::Safety(SafetyEvent::WatchdogSilent { silent_for })
                    if silent_for > super::super::watchdog::WATCHDOG_SILENCE_LIMIT
            ),
            "{fault:?}"
        );
        assert_eq!(count_messages(&log, MessageKind::Disarm), 1);
        let commands = count_messages(&log, MessageKind::Command);
        run_for(1_000).await;
        let later = setup.handle.log().snapshot();
        assert_eq!(count_messages(&later, MessageKind::Command), commands);
        assert_eq!(setup.handle.status().state, State::Fault.into());
        stop_without_watchdog(setup, feeder).await;
    }

    // A reset is neither an arm nor an activation; a disarm in its batch does not refuse it.
    #[tokio::test(start_paused = true)]
    async fn a_disarm_does_not_supersede_a_fault_reset_in_its_batch() {
        let (setup, feeder) = runtime_in(State::Active).await;
        feeder.stop().await; // the plugin disconnects: Active ends in Fault
        run_for(1_000).await;
        assert_eq!(setup.handle.status().state, State::Fault.into());
        let replies = send_batch(&setup.handle, &[Command::ResetFault, Command::Disarm]).await;
        assert_eq!(replies[0].response.result, Ok(()));
        assert_eq!(
            replies[0].response.transition.map(|t| t.reason),
            Some(Reason::FaultReset)
        );
        assert_eq!(setup.handle.status().state, State::Disabled.into());
        setup.handle.shutdown();
        setup.sender.await.unwrap();
        setup.watchdog.await.unwrap();
    }

    // ---- 4.6.4c: a safety event wins over a fault reset of the same batch ----

    fn reset_refused_for_timeout(reply: &CommandReply) -> bool {
        timed_out(reply) && reply.state == State::Fault
    }

    fn fault_resets(log: &LogSnapshot) -> usize {
        decisions(log)
            .iter()
            .filter(|d| matches!(d, DecisionEvent::Transition(t) if t.reason == Reason::FaultReset))
            .count()
    }

    #[tokio::test(start_paused = true)]
    async fn a_reset_in_the_batch_of_a_trip_does_not_acknowledge_the_fault() {
        let (setup, feeder, stall_ms) = stallable_in(State::Active).await;
        stall(&stall_ms, 150).await;
        let replies = queue_during_stall(&setup.handle, &[Command::ResetFault]).await;
        assert!(reset_refused_for_timeout(&replies[0]), "{:?}", replies[0]);
        run_for(200).await;
        assert_eq!(setup.handle.status().state, State::Fault.into());
        assert_eq!(fault_resets(&setup.handle.log().snapshot()), 0);
        // A later batch, in a step without a safety event, may reset; nothing arms.
        let replies = send_batch(&setup.handle, &[Command::ResetFault]).await;
        assert_eq!(replies[0].response.result, Ok(()));
        assert_eq!(replies[0].state, State::Disabled);
        run_for(400).await;
        assert_eq!(setup.handle.status().state, State::Disabled.into());
        stop(setup, feeder).await;
    }

    #[tokio::test(start_paused = true)]
    async fn a_reset_before_the_trip_batch_stays_and_one_after_it_needs_a_new_batch() {
        let (setup, feeder, stall_ms) = stallable_in(State::Active).await;
        // An ordinary fault, reset in its own batch.
        stall(&stall_ms, 150).await;
        run_for(500).await;
        assert_eq!(setup.handle.status().state, State::Fault.into());
        let replies = send_batch(&setup.handle, &[Command::ResetFault]).await;
        assert_eq!(replies[0].state, State::Disabled);
        // A second trip finds Disabled; a reset and an arm queued with it are refused.
        stall(&stall_ms, 150).await;
        let replies = queue_during_stall(&setup.handle, &[Command::ResetFault, Command::Arm]).await;
        assert!(replies.iter().all(timed_out), "{replies:?}");
        assert!(replies.iter().all(|r| r.state == State::Disabled));
        let log = setup.handle.log().snapshot();
        assert_eq!(fault_resets(&log), 1);
        assert_eq!(
            transitions_to(&log, 0, State::Active),
            1,
            "only the initial one"
        );
        stop(setup, feeder).await;
    }

    #[tokio::test(start_paused = true)]
    async fn a_new_trip_on_an_existing_fault_blocks_the_reset_of_its_batch() {
        let (setup, feeder, stall_ms) = stallable_in(State::Active).await;
        stall(&stall_ms, 150).await;
        run_for(500).await;
        assert_eq!(setup.handle.status().state, State::Fault.into());
        // Still in Fault, the loop stalls again; the reset queued meanwhile is refused.
        stall(&stall_ms, 150).await;
        let replies = queue_during_stall(&setup.handle, &[Command::ResetFault]).await;
        assert!(reset_refused_for_timeout(&replies[0]), "{:?}", replies[0]);
        assert_eq!(setup.handle.status().watchdog.trips, 2);
        assert_eq!(fault_resets(&setup.handle.log().snapshot()), 0);
        stop(setup, feeder).await;
    }

    #[tokio::test(start_paused = true)]
    async fn a_disarm_and_a_reset_in_the_batch_of_a_trip_keep_the_fault() {
        let (setup, feeder, stall_ms) = stallable_in(State::Active).await;
        stall(&stall_ms, 150).await;
        let replies = queue_during_stall(
            &setup.handle,
            &[
                Command::ResetFault,
                Command::Arm,
                Command::Disarm,
                Command::Activate,
            ],
        )
        .await;
        // F-01: the disarm is processed first, arm and activation are superseded by it.
        assert_eq!(replies[2].response.result, Ok(()));
        assert!(superseded(&replies[1]), "{:?}", replies[1]);
        assert!(superseded(&replies[3]), "{:?}", replies[3]);
        // 4.6.4c: the reset does not acknowledge the fault of the trip.
        assert!(reset_refused_for_timeout(&replies[0]), "{:?}", replies[0]);
        assert!(replies.iter().all(|r| r.state == State::Fault));
        let log = setup.handle.log().snapshot();
        assert_eq!(count_messages(&log, MessageKind::Disarm), 1);
        assert_eq!(fault_resets(&log), 0);
        stop(setup, feeder).await;
    }

    #[tokio::test(start_paused = true)]
    async fn the_watchdog_task_notices_a_sender_that_never_runs() {
        let start = now();
        let log = ControlLog::new(start);
        let heartbeat = Heartbeat::new(start);
        let watchdog = Watchdog::new(heartbeat, SUPERVISOR_TIMEOUT);
        let flag = watchdog.flag();
        let (stop_tx, stop_rx) = watch::channel(false);
        let task = tokio::spawn(run_watchdog(watchdog, log.clone(), stop_rx));
        run_for(300).await;
        let trips = decisions(&log.snapshot())
            .iter()
            .filter(|d| matches!(d, DecisionEvent::WatchdogTripped { .. }))
            .count();
        assert_eq!(trips, 1, "reported once per episode");
        assert!(flag.is_tripped());
        stop_tx.send_replace(true);
        task.await.unwrap();
    }

    #[tokio::test(start_paused = true)]
    async fn the_watchdog_stays_quiet_while_the_sender_runs() {
        let (feed, tx) = feed_with_channel();
        let setup = spawn_runtime(&feed, Box::new(NeutralRequests));
        let feeder = Feeder::start(tx, 7);
        run_for(5_000).await;
        let log = setup.handle.log().snapshot();
        assert!(
            !decisions(&log)
                .iter()
                .any(|d| matches!(d, DecisionEvent::WatchdogTripped { .. }))
        );
        feeder.stop().await;
        setup.handle.shutdown();
        setup.sender.await.unwrap();
        setup.watchdog.await.unwrap();
    }

    #[tokio::test(start_paused = true)]
    async fn a_controller_error_faults_through_the_runtime() {
        struct Broken;
        impl RequestSource for Broken {
            fn next_request(
                &mut self,
                _state: &super::super::vehicle::VehicleState,
            ) -> ControlRequest {
                ControlRequest {
                    steering: Some(f32::NAN),
                    throttle: 0.0,
                    brake: 0.0,
                }
            }
        }
        let (feed, tx) = feed_with_channel();
        let setup = spawn_runtime(&feed, Box::new(Broken));
        let feeder = Feeder::start(tx, 7);
        run_for(300).await;
        arm_and_activate(&setup.handle).await;
        run_for(200).await;
        let log = setup.handle.log().snapshot();
        assert!(faulted_with(&log, |e| matches!(
            e,
            SafetyEvent::InvalidControlRequest
        )));
        assert!(
            decisions(&log)
                .iter()
                .any(|d| matches!(d, DecisionEvent::Withheld(Withheld::InvalidRequest(_))))
        );
        assert_eq!(count_messages(&log, MessageKind::Command), 0);
        feeder.stop().await;
        setup.handle.shutdown();
        setup.sender.await.unwrap();
        setup.watchdog.await.unwrap();
    }
}
