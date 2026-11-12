//! Async drivers for the control core. Thin on purpose: all decisions are made by the
//! deterministic [`ControlCore`]; this layer only moves events into it.
//!
//! * **Telemetry.** The sender task reads raw schema 2 frames from a **second receiver** on the
//!   telemetry engine's own `watch` channel (see [`FrameFeed`]). There is exactly one pipe
//!   server, owned by the dashboard engine; control never creates another. Frames are observed
//!   as they arrive, independently of the dashboard's 10 Hz sampling. When the engine replaces
//!   its channel after restarting the pipe server, the task re-attaches on its next tick.
//! * **Timing.** The sender task sleeps until the core's next 40 ms deadline on the monotonic
//!   clock and ticks. Missed deadlines are skipped by the scheduler, never replayed.
//! * **Operator commands** arrive over a channel. Everything queued at once is drained
//!   together and any disarm is processed first, so a disarm is never stuck behind other
//!   commands.
//! * **Watchdog.** A separate task checks the supervisor loop's heartbeat every 20 ms and
//!   trips a flag the loop consumes (see `watchdog`).
//! * **Shutdown.** [`ControlHandle::shutdown`] makes the sender task disarm and return a
//!   [`ShutdownReport`]. If the task is aborted instead, dropping the core still encodes the
//!   owed disarm.
//!
//! The drivers are returned as futures so that the application can spawn them on its own
//! runtime. Time comes from tokio's clock, which in tests is paused and advanced explicitly.
//! Dry-run only: see `sink`.

use super::log::{ControlLog, DecisionEvent};
use super::sender::{ControlCore, CoreConfig, RequestSource, ShutdownReport};
use super::sink::DryRunSink;
use super::status::ControlStatus;
use super::supervisor::{Command, Response, State};
use super::watchdog::{Heartbeat, SUPERVISOR_TIMEOUT, WATCHDOG_PERIOD, Watchdog};
use crate::telemetry::engine::FrameFeed;
use roadpilot_telemetry_client::ReceivedTelemetryFrame;
use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;
use std::time::Instant;
use tokio::sync::{mpsc, oneshot, watch};
use tokio::time::{Instant as TokioInstant, sleep, sleep_until};

type FrameReceiver = watch::Receiver<Option<ReceivedTelemetryFrame>>;
type BoxFuture<T> = Pin<Box<dyn Future<Output = T> + Send + 'static>>;

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

/// Operator access to the running control tasks. Cheap to clone.
#[derive(Clone)]
pub struct ControlHandle {
    commands: mpsc::UnboundedSender<Request>,
    shutdown: Arc<watch::Sender<bool>>,
    log: ControlLog,
    status: watch::Receiver<ControlStatus>,
    heartbeat: Heartbeat,
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
    /// task has processed it. `None` if the control task is gone.
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

    /// The newest status the control task published, with the loop silence measured now,
    /// independently of the loop, so a stalled loop is visible.
    pub fn status(&self) -> ControlStatus {
        let mut status = self.status.borrow().clone();
        status.watchdog.loop_silent_ms =
            u64::try_from(self.heartbeat.silent_for(now()).as_millis()).unwrap_or(u64::MAX);
        status
    }

    /// Notifies whenever the control task publishes a new status. Closed once it has stopped.
    pub fn status_changes(&self) -> watch::Receiver<ControlStatus> {
        self.status.clone()
    }

    /// Asks the sender task to disarm and stop, and the watchdog to stop.
    pub fn shutdown(&self) {
        self.shutdown.send_replace(true);
    }

    pub fn log(&self) -> ControlLog {
        self.log.clone()
    }
}

/// The control tasks, ready to be spawned, and the handle to operate them.
pub struct ControlRuntime {
    pub handle: ControlHandle,
    /// Runs until shutdown; resolves with what the shutdown did.
    pub sender_task: BoxFuture<ShutdownReport>,
    /// Runs until shutdown.
    pub watchdog_task: BoxFuture<()>,
}

/// Builds the dry-run control runtime. Nothing runs until the returned futures are spawned.
pub fn build(
    feed: impl FrameSource,
    source: Box<dyn RequestSource>,
    config: CoreConfig,
) -> ControlRuntime {
    let start = now();
    let log = ControlLog::new(start);
    let heartbeat = Heartbeat::new(start);
    let watchdog = Watchdog::new(heartbeat.clone(), SUPERVISOR_TIMEOUT);
    let trip = watchdog.flag();
    let core = ControlCore::dry_run(config, source, log.clone(), heartbeat.clone(), trip, start);

    let (command_tx, command_rx) = mpsc::unbounded_channel();
    let (shutdown_tx, shutdown_rx) = watch::channel(false);
    let (status_tx, status_rx) = watch::channel(core.status(start));
    ControlRuntime {
        handle: ControlHandle {
            commands: command_tx,
            shutdown: Arc::new(shutdown_tx),
            log: log.clone(),
            status: status_rx,
            heartbeat,
        },
        sender_task: Box::pin(run_sender(
            core,
            feed,
            command_rx,
            shutdown_rx.clone(),
            status_tx,
        )),
        watchdog_task: Box::pin(run_watchdog(watchdog, log, shutdown_rx)),
    }
}

/// Observes the newest frame of a receiver, if there is one.
fn observe(core: &mut ControlCore<DryRunSink>, receiver: &mut FrameReceiver) {
    let at = now();
    let frame = receiver.borrow_and_update();
    if let Some(received) = frame.as_ref() {
        core.on_frame(received, at);
    }
}

/// Processes everything queued at once, any disarm first, publishes the resulting status, and
/// only then answers each request, so a requester never sees a status older than its answer.
fn handle_commands(
    core: &mut ControlCore<DryRunSink>,
    first: Request,
    queue: &mut mpsc::UnboundedReceiver<Request>,
    status: &watch::Sender<ControlStatus>,
) {
    let mut batch = vec![first];
    while let Ok(request) = queue.try_recv() {
        batch.push(request);
    }
    let at = now();
    let (disarms, others): (Vec<Request>, Vec<Request>) = batch
        .into_iter()
        .partition(|r| r.command == Command::Disarm);
    let mut answered = Vec::with_capacity(disarms.len() + others.len());
    for request in disarms.into_iter().chain(others) {
        let response = core.on_command(request.command, at);
        answered.push((request.reply, response));
    }
    let state = core.state();
    status.send_replace(core.status(now()));
    for (reply, response) in answered {
        if let Some(reply) = reply {
            // The requester may have given up waiting; that is not an error.
            let _ = reply.send(CommandReply { response, state });
        }
    }
}

async fn run_sender(
    mut core: ControlCore<DryRunSink>,
    feed: impl FrameSource,
    mut commands: mpsc::UnboundedReceiver<Request>,
    mut shutdown: watch::Receiver<bool>,
    status: watch::Sender<ControlStatus>,
) -> ShutdownReport {
    let mut receiver = feed.receiver();
    let mut open = receiver.has_changed().is_ok();
    if open {
        observe(&mut core, &mut receiver);
    } else {
        core.note_feed(false, now());
    }

    loop {
        let deadline = TokioInstant::from_std(core.next_deadline());
        tokio::select! {
            biased;
            // Shutdown, or the handle was dropped: either way, disarm and stop.
            _ = shutdown.changed() => break,
            request = commands.recv() => {
                if let Some(request) = request {
                    handle_commands(&mut core, request, &mut commands, &status);
                }
            }
            () = sleep_until(deadline) => {
                let at = now();
                if !open {
                    // The engine may have restarted its pipe server and replaced the channel.
                    receiver = feed.receiver();
                    if receiver.has_changed().is_ok() {
                        open = true;
                        core.note_feed(true, at);
                        observe(&mut core, &mut receiver);
                    }
                }
                core.tick(at);
                status.send_replace(core.status(at));
            }
            changed = receiver.changed(), if open => {
                if changed.is_ok() {
                    observe(&mut core, &mut receiver);
                } else {
                    open = false;
                    core.note_feed(false, now());
                }
            }
        }
    }
    let at = now();
    let report = core.shutdown(at);
    // The final status (disarmed) is published before the task ends; the channel then closes.
    status.send_replace(core.status(at));
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
        let rt = build(feed.clone(), request, CoreConfig::default());
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
        run_for(10).await;
        assert!(handle.send(Command::Activate));
        run_for(10).await;
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
        run_for(5).await;
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
        run_for(10).await;
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
        run_for(10).await;
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
        run_for(5).await;
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
                        rejection: Rejection::NotArmed
                    }
                )
            })
            .expect("the activation arrived after the disarm and was refused");
        assert!(disarm_at < rejected_at);
        feeder.stop().await;
        setup.handle.shutdown();
        setup.sender.await.unwrap();
        setup.watchdog.await.unwrap();
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
