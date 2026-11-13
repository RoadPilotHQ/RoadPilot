//! Application integration of the dry-run control runtime: lifecycle and Tauri commands.
//!
//! [`ControlSlot`] owns at most one control runtime. It starts it with the application, serves
//! the operator commands and status to the UI, and shuts it down at exit:
//!
//! 1. the sender task is asked to disarm and stop, and given [`SHUTDOWN_GRACE`];
//! 2. if it does not stop in time it is aborted, which drops the control core and with it
//!    encodes any owed disarm; the slot waits up to [`ABORT_GRACE`] for that;
//! 3. the outcome says truthfully whether the log shows a disarm after the last command.
//!
//! The UI is never the safety authority. The commands here only queue requests for the control
//! task; the supervisor decides. Dry-run is the only mode, and no command can change that.

use crate::control::runtime::{self, ControlHandle, ControlRuntime, FrameSource};
use crate::control::sender::{CoreConfig, RequestSource, ShutdownReport};
use crate::control::status::{
    self, CommandCode, ControlStatus, LogEntryDto, RejectionDto, RuntimeCode, StateCode,
};
use crate::control::supervisor::Command;
use crate::control::timer::{PreciseTimer, TickTimer, TokioTimer};
use crate::platform;
use serde::Serialize;
use std::sync::{Mutex, MutexGuard, PoisonError};
use std::time::{Duration, Instant};
use tauri::async_runtime::{self, JoinHandle};
use tokio::sync::oneshot;

/// Time the control task gets to disarm and stop on application exit.
pub const SHUTDOWN_GRACE: Duration = Duration::from_millis(500);
/// After an abort, time allowed for the dropped core to record its disarm.
pub const ABORT_GRACE: Duration = Duration::from_millis(1_000);
/// How long a command waits for the control task's answer.
pub const COMMAND_TIMEOUT: Duration = Duration::from_millis(500);
/// Event carrying the control status to the UI.
pub const STATUS_EVENT: &str = "control:status";
/// How often the status is sent to the UI.
pub const STATUS_INTERVAL: Duration = Duration::from_millis(200);
pub const DEFAULT_LOG_LIMIT: usize = 50;

/// Every control command the application registers (checked against the registration by the IPC
/// tests). There is deliberately none that selects an operating mode or enables transmission.
#[cfg(test)]
pub const CONTROL_COMMANDS: [&str; 6] = [
    "control_status",
    "control_log",
    "control_arm",
    "control_activate",
    "control_disarm",
    "control_reset_fault",
];

/// Called with every status the emitter sends.
pub type StatusEmitter = Box<dyn Fn(ControlStatus) + Send + Sync + 'static>;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum StartError {
    /// A control runtime was already started in this slot; there is never a second one.
    AlreadyStarted,
    /// The dedicated control thread or its runtime could not be created.
    ThreadUnavailable,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum ShutdownOutcome {
    /// The task disarmed and stopped within the grace period.
    Completed(ShutdownReport),
    /// The task did not stop in time and was aborted. `disarm_settled` is true if the log shows
    /// no command without a following disarm.
    Aborted { disarm_settled: bool },
    /// The task had already ended before the shutdown (for example it panicked).
    AlreadyStopped { disarm_settled: bool },
    /// No runtime was running.
    NotRunning,
}

/// The dedicated control thread. It runs the sender task on its own single-threaded runtime,
/// isolated from the dashboard's thread pool, at elevated thread priority.
struct ControlThread {
    thread: std::thread::JoinHandle<()>,
    /// Resolves with the shutdown report when the sender task ends normally.
    report: oneshot::Receiver<ShutdownReport>,
    /// Cancels the sender task; dropping the control core then encodes any owed disarm.
    abort: Option<oneshot::Sender<()>>,
}

struct Running {
    handle: ControlHandle,
    control: ControlThread,
    watchdog: JoinHandle<()>,
    /// Both control threads run at elevated priority.
    elevated: bool,
}

enum Slot {
    Empty,
    Running(Running),
    Stopped {
        handle: ControlHandle,
        elevated: bool,
    },
}

/// Holds the application's single control runtime.
pub struct ControlSlot {
    inner: Mutex<Slot>,
}

impl Default for ControlSlot {
    fn default() -> Self {
        Self::new()
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum OutcomeCode {
    /// The supervisor carried out the command.
    Accepted,
    /// The supervisor refused it; see `rejection`.
    Rejected,
    /// Queued, but no answer within the timeout. The control task will still process it.
    Pending,
    /// No control runtime is running; nothing is being encoded.
    Unavailable,
}

/// The answer to an operator command.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommandReplyDto {
    pub command: CommandCode,
    pub outcome: OutcomeCode,
    pub rejection: Option<RejectionDto>,
    /// Supervisor state after the command; `None` without an answer.
    pub state: Option<StateCode>,
}

impl ControlSlot {
    pub fn new() -> Self {
        Self {
            inner: Mutex::new(Slot::Empty),
        }
    }

    fn lock(&self) -> MutexGuard<'_, Slot> {
        self.inner.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// Starts the dry-run control runtime on the application's async runtime. Refuses a
    /// second start: there is only ever one runtime per slot.
    pub fn start(
        &self,
        feed: impl FrameSource,
        source: Box<dyn RequestSource>,
        emitter: Option<StatusEmitter>,
    ) -> Result<(), StartError> {
        let mut slot = self.lock();
        if !matches!(*slot, Slot::Empty) {
            return Err(StartError::AlreadyStarted);
        }
        let (control, (handle, relay_task, watchdog_task, elevated)) =
            start_control_thread(feed, source)?;
        // The relay and the watchdog stay on the shared runtime; the watchdog is independent of
        // the thread it watches. The relay ends by itself at shutdown.
        drop(async_runtime::spawn(relay_task));
        let watchdog = async_runtime::spawn(watchdog_task);
        if let Some(emit) = emitter {
            // Ends by itself once the control task has stopped.
            drop(async_runtime::spawn(emit_status(
                handle.clone(),
                emit,
                elevated,
            )));
        }
        *slot = Slot::Running(Running {
            handle,
            control,
            watchdog,
            elevated,
        });
        Ok(())
    }

    /// The handle of the running runtime, if any.
    pub(crate) fn handle(&self) -> Option<ControlHandle> {
        match &*self.lock() {
            Slot::Running(r) => Some(r.handle.clone()),
            Slot::Empty | Slot::Stopped { .. } => None,
        }
    }

    pub fn status(&self) -> ControlStatus {
        match &*self.lock() {
            Slot::Empty => ControlStatus::unavailable(),
            Slot::Running(r) => {
                let mut status = r.handle.status();
                status.timing.elevated_priority = r.elevated;
                if r.control.thread.is_finished() {
                    status.runtime = RuntimeCode::Stopped;
                }
                status
            }
            Slot::Stopped { handle, elevated } => {
                let mut status = handle.status();
                status.timing.elevated_priority = *elevated;
                status.runtime = RuntimeCode::Stopped;
                status
            }
        }
    }

    /// The newest log entries, newest first.
    pub fn log(&self, limit: usize) -> Vec<LogEntryDto> {
        let handle = match &*self.lock() {
            Slot::Running(r) => r.handle.clone(),
            Slot::Stopped { handle, .. } => handle.clone(),
            Slot::Empty => return Vec::new(),
        };
        status::recent_log(&handle.log().snapshot(), limit)
    }

    /// Queues an operator command and waits a bounded time for the answer.
    pub async fn command(&self, command: Command) -> CommandReplyDto {
        let unavailable = CommandReplyDto {
            command: command.into(),
            outcome: OutcomeCode::Unavailable,
            rejection: None,
            state: None,
        };
        // Never hold the slot lock across an await.
        let Some(handle) = self.handle() else {
            return unavailable;
        };
        let Some(answer) = handle.request(command) else {
            return unavailable;
        };
        match tokio::time::timeout(COMMAND_TIMEOUT, answer).await {
            Ok(Ok(reply)) => CommandReplyDto {
                command: command.into(),
                outcome: if reply.response.result.is_ok() {
                    OutcomeCode::Accepted
                } else {
                    OutcomeCode::Rejected
                },
                rejection: reply.response.result.err().map(Into::into),
                state: Some(reply.state.into()),
            },
            // The task ended before answering.
            Ok(Err(_)) => unavailable,
            Err(_) => CommandReplyDto {
                outcome: OutcomeCode::Pending,
                ..unavailable
            },
        }
    }

    /// Disarms and stops the runtime: the orderly path within `grace`, otherwise an abort
    /// and up to `abort_grace` for the drop-time disarm. Blocks the calling thread; call it
    /// from outside the async runtime (the application calls it on exit).
    pub fn shutdown(&self, grace: Duration, abort_grace: Duration) -> ShutdownOutcome {
        let running = {
            let mut slot = self.lock();
            match std::mem::replace(&mut *slot, Slot::Empty) {
                Slot::Running(r) => r,
                other => {
                    let outcome = match &other {
                        Slot::Stopped { .. } | Slot::Empty => ShutdownOutcome::NotRunning,
                        Slot::Running(_) => unreachable!(),
                    };
                    *slot = other;
                    return outcome;
                }
            }
        };
        let Running {
            handle,
            control,
            watchdog,
            elevated,
        } = running;
        let ControlThread {
            thread,
            mut report,
            mut abort,
        } = control;
        let log = handle.log();
        let already_finished = thread.is_finished();
        handle.shutdown();

        // The timeout must be created inside the future that block_on runs: its timer needs the
        // runtime context, which the calling (main) thread does not have.
        let waited =
            async_runtime::block_on(async { tokio::time::timeout(grace, &mut report).await });
        let outcome = match waited {
            Ok(Ok(report)) if !already_finished => ShutdownOutcome::Completed(report),
            // The thread ended without a report (it was aborted or panicked).
            Ok(_) => ShutdownOutcome::AlreadyStopped {
                disarm_settled: !log.owes_disarm(),
            },
            Err(_elapsed) => {
                if let Some(abort) = abort.take() {
                    let _ = abort.send(());
                }
                // Dropping the core encodes the owed disarm; give it time to happen. The abort
                // takes effect when the stuck tick returns, exactly as a task abort would.
                let until = Instant::now() + abort_grace;
                while !thread.is_finished() && Instant::now() < until {
                    std::thread::sleep(Duration::from_millis(10));
                }
                ShutdownOutcome::Aborted {
                    disarm_settled: !log.owes_disarm(),
                }
            }
        };
        if thread.is_finished() {
            let _ = thread.join();
        }
        watchdog.abort();
        *self.lock() = Slot::Stopped { handle, elevated };
        outcome
    }
}

type SharedTask = std::pin::Pin<Box<dyn std::future::Future<Output = ()> + Send + 'static>>;

/// What the control thread hands back once it runs: the handle, the tasks for the shared
/// runtime (relay, watchdog) and whether both control threads run elevated.
type Started = (ControlHandle, SharedTask, SharedTask, bool);

/// Starts the dedicated control thread: it raises its own priority, starts the precise timer
/// thread (which raises its own priority too), builds the control runtime and runs the sender
/// task on a single-threaded tokio runtime until shutdown or abort.
///
/// Measured on Windows (see `docs/timing.md`): tokio's timer on the shared runtime wakes up to
/// 16 ms late, and threads at normal priority are delayed by tens of milliseconds under CPU
/// load. Both control threads only wake briefly every 40 ms.
fn start_control_thread(
    feed: impl FrameSource,
    source: Box<dyn RequestSource>,
) -> Result<(ControlThread, Started), StartError> {
    let (ready_tx, ready_rx) = std::sync::mpsc::channel::<Started>();
    let (report_tx, report) = oneshot::channel();
    let (abort, abort_rx) = oneshot::channel::<()>();
    let thread = std::thread::Builder::new()
        .name("roadpilot-control".into())
        .spawn(move || {
            let loop_elevated = platform::raise_current_thread_priority();
            let (timer, timer_elevated): (Box<dyn TickTimer>, bool) =
                match PreciseTimer::start(platform::raise_current_thread_priority) {
                    Ok((timer, elevated)) => (Box::new(timer), elevated),
                    // Still bounded by the scheduler's gap limit and the watchdog; the status
                    // reports the coarse timer.
                    Err(_) => (Box::new(TokioTimer), false),
                };
            let Ok(executor) = tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
            else {
                return; // ready_tx is dropped: start reports the failure
            };
            let ControlRuntime {
                handle,
                sender_task,
                relay_task,
                watchdog_task,
            } = runtime::build_with_timer(feed, source, CoreConfig::default(), timer);
            let elevated = loop_elevated && timer_elevated;
            if ready_tx
                .send((handle, relay_task, watchdog_task, elevated))
                .is_err()
            {
                return;
            }
            let finished = executor.block_on(async move {
                tokio::select! {
                    biased;
                    // An abort, or the slot was dropped: cancel the sender task. Dropping the
                    // control core encodes any owed disarm.
                    _ = abort_rx => None,
                    report = sender_task => Some(report),
                }
            });
            if let Some(report) = finished {
                let _ = report_tx.send(report);
            }
        })
        .map_err(|_| StartError::ThreadUnavailable)?;
    let started = ready_rx
        .recv_timeout(Duration::from_secs(5))
        .map_err(|_| StartError::ThreadUnavailable)?;
    Ok((
        ControlThread {
            thread,
            report,
            abort: Some(abort),
        },
        started,
    ))
}

/// Sends the status at a fixed rate, independently of the control loop, so a stalled loop
/// shows up as a growing `loopSilentMs` rather than as silence. Sends a final status marked
/// stopped once the control task has ended.
async fn emit_status(handle: ControlHandle, emit: StatusEmitter, elevated: bool) {
    let mut ticker = tokio::time::interval(STATUS_INTERVAL);
    ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    loop {
        ticker.tick().await;
        let stopped = handle.is_stopped();
        let mut status = handle.status();
        status.timing.elevated_priority = elevated;
        if stopped {
            status.runtime = RuntimeCode::Stopped;
        }
        emit(status);
        if stopped {
            break;
        }
    }
}

// ---- Tauri commands ----

#[tauri::command]
pub fn control_status(slot: tauri::State<'_, ControlSlot>) -> ControlStatus {
    slot.status()
}

#[tauri::command]
pub fn control_log(slot: tauri::State<'_, ControlSlot>, limit: Option<usize>) -> Vec<LogEntryDto> {
    slot.log(limit.unwrap_or(DEFAULT_LOG_LIMIT))
}

#[tauri::command]
pub async fn control_arm(slot: tauri::State<'_, ControlSlot>) -> Result<CommandReplyDto, String> {
    Ok(slot.command(Command::Arm).await)
}

#[tauri::command]
pub async fn control_activate(
    slot: tauri::State<'_, ControlSlot>,
) -> Result<CommandReplyDto, String> {
    Ok(slot.command(Command::Activate).await)
}

/// Always accepted by the supervisor, in every state. The control task processes a disarm
/// before any other command queued with it.
#[tauri::command]
pub async fn control_disarm(
    slot: tauri::State<'_, ControlSlot>,
) -> Result<CommandReplyDto, String> {
    Ok(slot.command(Command::Disarm).await)
}

#[tauri::command]
pub async fn control_reset_fault(
    slot: tauri::State<'_, ControlSlot>,
) -> Result<CommandReplyDto, String> {
    Ok(slot.command(Command::ResetFault).await)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::control::sender::NeutralRequests;
    use crate::control::status::{FreshnessCode, ModeCode, ReasonDto};
    use crate::control::vehicle::VehicleState;
    use crate::control::vehicle::test_support::slow_frame;
    use crate::telemetry::engine::FrameFeed;
    use roadpilot_telemetry_client::ReceivedTelemetryFrame;
    use std::sync::Arc;
    use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
    use std::time::Instant;
    use tokio::sync::watch;

    fn ms(n: u64) -> Duration {
        Duration::from_millis(n)
    }

    /// The handle in any state after start, for inspecting the log.
    fn handle_of(slot: &ControlSlot) -> ControlHandle {
        match &*slot.lock() {
            Slot::Running(r) => r.handle.clone(),
            Slot::Stopped { handle, .. } => handle.clone(),
            Slot::Empty => panic!("not started"),
        }
    }

    /// Publishes a frame every 16 ms from a plain thread, in real time, like the pipe reader.
    struct Feeder {
        stop: Arc<AtomicBool>,
        thread: Option<std::thread::JoinHandle<()>>,
    }

    impl Feeder {
        fn start(feed: &FrameFeed, sequence: Arc<AtomicU64>) -> Self {
            let (tx, rx) = watch::channel(None);
            feed.publish(rx);
            let stop = Arc::new(AtomicBool::new(false));
            let flag = stop.clone();
            let base = Instant::now();
            // Measurement knobs (timing investigation only): frame period and feeder priority.
            let period = Duration::from_micros(env_u64("ROADPILOT_TIMING_FEEDER_US", 16_000));
            let elevate = env_u64("ROADPILOT_TIMING_FEEDER_HIGH", 0) == 1;
            let thread = std::thread::spawn(move || {
                if elevate {
                    crate::platform::raise_current_thread_priority();
                }
                while !flag.load(Ordering::SeqCst) {
                    let at = Instant::now();
                    let seq = sequence.fetch_add(1, Ordering::SeqCst) + 1;
                    let sim = u64::try_from(at.duration_since(base).as_micros()).unwrap();
                    let _ = tx.send(Some(ReceivedTelemetryFrame {
                        frame: slow_frame(7, seq, 1_000_000 + sim),
                        dropped_fields: Vec::new(),
                        received_at: at,
                    }));
                    std::thread::sleep(period);
                }
            });
            Self {
                stop,
                thread: Some(thread),
            }
        }

        /// Stops publishing and closes the channel, as when the pipe server ends.
        fn stop(mut self) {
            self.stop.store(true, Ordering::SeqCst);
            if let Some(t) = self.thread.take() {
                t.join().unwrap();
            }
        }
    }

    impl Drop for Feeder {
        fn drop(&mut self) {
            self.stop.store(true, Ordering::SeqCst);
            if let Some(t) = self.thread.take() {
                let _ = t.join();
            }
        }
    }

    fn wait_until(what: &str, limit: Duration, mut condition: impl FnMut() -> bool) {
        let start = Instant::now();
        while !condition() {
            assert!(start.elapsed() < limit, "timed out waiting for {what}");
            std::thread::sleep(ms(10));
        }
    }

    fn run(slot: &ControlSlot, command: Command) -> CommandReplyDto {
        async_runtime::block_on(slot.command(command))
    }

    struct Rig {
        slot: ControlSlot,
        feed: FrameFeed,
        sequence: Arc<AtomicU64>,
        feeder: Option<Feeder>,
    }

    impl Rig {
        fn start() -> Self {
            Self::start_with(Box::new(NeutralRequests))
        }

        fn start_with(source: Box<dyn RequestSource>) -> Self {
            let feed = FrameFeed::new();
            let sequence = Arc::new(AtomicU64::new(0));
            let feeder = Feeder::start(&feed, sequence.clone());
            let slot = ControlSlot::new();
            slot.start(feed.clone(), source, None).unwrap();
            let rig = Self {
                slot,
                feed,
                sequence,
                feeder: Some(feeder),
            };
            rig.wait_fresh();
            rig
        }

        fn wait_fresh(&self) {
            wait_until("fresh telemetry", ms(3_000), || {
                self.slot.status().telemetry.freshness == FreshnessCode::Fresh
            });
        }

        fn active() -> Self {
            Self::active_with(Box::new(NeutralRequests))
        }

        fn active_with(source: Box<dyn RequestSource>) -> Self {
            let rig = Self::start_with(source);
            assert_eq!(run(&rig.slot, Command::Arm).outcome, OutcomeCode::Accepted);
            assert_eq!(
                run(&rig.slot, Command::Activate).outcome,
                OutcomeCode::Accepted
            );
            wait_until("a first command", ms(2_000), || {
                rig.slot.status().counters.commands_encoded > 0
            });
            rig
        }

        fn stop_frames(&mut self) {
            if let Some(f) = self.feeder.take() {
                f.stop();
            }
        }

        fn restart_frames(&mut self) {
            self.stop_frames();
            self.feeder = Some(Feeder::start(&self.feed, self.sequence.clone()));
        }
    }

    impl Drop for Rig {
        fn drop(&mut self) {
            self.slot.shutdown(SHUTDOWN_GRACE, ABORT_GRACE);
        }
    }

    // ---- lifecycle ----

    #[test]
    fn a_slot_that_was_never_started_is_unavailable_and_disarmed() {
        let slot = ControlSlot::new();
        let s = slot.status();
        assert_eq!(s.runtime, RuntimeCode::Unavailable);
        assert_eq!(s.state, StateCode::Disabled);
        assert_eq!(s.mode, ModeCode::DryRun);
        let reply = run(&slot, Command::Disarm);
        assert_eq!(reply.outcome, OutcomeCode::Unavailable);
        assert_eq!(slot.log(10), Vec::new());
        assert_eq!(
            slot.shutdown(SHUTDOWN_GRACE, ABORT_GRACE),
            ShutdownOutcome::NotRunning
        );
    }

    #[test]
    fn a_second_runtime_is_never_started() {
        let rig = Rig::start();
        let again = rig
            .slot
            .start(rig.feed.clone(), Box::new(NeutralRequests), None);
        assert_eq!(again, Err(StartError::AlreadyStarted));
        assert_eq!(rig.slot.status().runtime, RuntimeCode::Running);
        // Not even after a shutdown: the slot stays stopped.
        rig.slot.shutdown(SHUTDOWN_GRACE, ABORT_GRACE);
        assert_eq!(
            rig.slot
                .start(rig.feed.clone(), Box::new(NeutralRequests), None),
            Err(StartError::AlreadyStarted)
        );
    }

    #[test]
    fn the_runtime_starts_disabled_in_dry_run_and_reads_telemetry() {
        let rig = Rig::start();
        let s = rig.slot.status();
        assert_eq!(s.runtime, RuntimeCode::Running);
        // The application runs the loop on its dedicated thread with the precise timer, at
        // elevated thread priority where the platform supports it.
        assert_eq!(s.timing.timer, status::TimerCode::Precise);
        assert_eq!(s.timing.elevated_priority, cfg!(windows));
        assert_eq!(s.mode, ModeCode::DryRun);
        assert_eq!(s.state, StateCode::Disabled);
        assert!(!s.permits_output);
        assert!(s.telemetry.feed_connected);
        assert!(s.telemetry.epoch >= 1);
        assert!(s.counters.frames_accepted > 3);
        assert_eq!(s.counters.commands_encoded, 0);
    }

    // ---- commands ----

    #[test]
    fn arm_activate_disarm_and_reset_through_the_slot() {
        let rig = Rig::start();
        let arm = run(&rig.slot, Command::Arm);
        assert_eq!(arm.outcome, OutcomeCode::Accepted);
        assert_eq!(arm.state, Some(StateCode::Armed));
        let activate = run(&rig.slot, Command::Activate);
        assert_eq!(activate.state, Some(StateCode::Active));
        wait_until("encoded commands", ms(2_000), || {
            rig.slot.status().counters.commands_encoded >= 3
        });
        let disarm = run(&rig.slot, Command::Disarm);
        assert_eq!(disarm.outcome, OutcomeCode::Accepted);
        assert_eq!(disarm.state, Some(StateCode::Disabled));
        assert_eq!(rig.slot.status().counters.disarms_encoded, 1);
        let reset = run(&rig.slot, Command::ResetFault);
        assert_eq!(reset.outcome, OutcomeCode::Rejected);
        assert_eq!(reset.rejection, Some(RejectionDto::NotInFault));
    }

    #[test]
    fn arm_and_activate_are_refused_unless_the_supervisor_allows_them() {
        let slot = ControlSlot::new();
        slot.start(FrameFeed::new(), Box::new(NeutralRequests), None)
            .unwrap();
        let arm = run(&slot, Command::Arm);
        assert_eq!(arm.outcome, OutcomeCode::Rejected);
        assert_eq!(
            arm.rejection,
            Some(RejectionDto::NotReady {
                freshness: FreshnessCode::NoFrame
            })
        );
        let activate = run(&slot, Command::Activate);
        assert_eq!(activate.rejection, Some(RejectionDto::NotArmed));
        assert_eq!(slot.status().state, StateCode::Disabled);
        slot.shutdown(SHUTDOWN_GRACE, ABORT_GRACE);
    }

    #[test]
    fn a_disarm_queued_together_with_an_activation_is_processed_first() {
        let rig = Rig::active();
        let handle = rig.slot.handle().unwrap();
        // Queued back to back, before the control task runs.
        let activate = handle.request(Command::Activate).unwrap();
        let disarm = handle.request(Command::Disarm).unwrap();
        let (activate, disarm) =
            async_runtime::block_on(async { (activate.await.unwrap(), disarm.await.unwrap()) });
        assert!(disarm.response.result.is_ok());
        assert!(
            activate.response.result.is_err(),
            "the activation came after the disarm and found nothing armed"
        );
        assert_eq!(disarm.state, crate::control::supervisor::State::Disabled);
        let log = rig.slot.log(20);
        let disarm_at = log
            .iter()
            .position(|e| {
                matches!(
                    &e.event,
                    status::LogEventDto::Transition {
                        reason: ReasonDto::ManualDisarm,
                        ..
                    }
                )
            })
            .unwrap();
        let rejected_at = log
            .iter()
            .position(|e| {
                matches!(
                    &e.event,
                    status::LogEventDto::CommandRejected {
                        command: CommandCode::Activate,
                        ..
                    }
                )
            })
            .unwrap();
        assert!(
            rejected_at < disarm_at,
            "newest first: the rejection is newer"
        );
    }

    #[test]
    fn disarm_is_accepted_in_every_state_including_fault() {
        let mut rig = Rig::active();
        rig.stop_frames();
        wait_until("fault", ms(3_000), || {
            rig.slot.status().state == StateCode::Fault
        });
        let reply = run(&rig.slot, Command::Disarm);
        assert_eq!(reply.outcome, OutcomeCode::Accepted);
        assert_eq!(
            reply.state,
            Some(StateCode::Fault),
            "a fault needs its own reset"
        );
        for state_setup in [Command::ResetFault, Command::Disarm] {
            let r = run(&rig.slot, state_setup);
            assert_ne!(r.outcome, OutcomeCode::Unavailable);
        }
        assert_eq!(
            run(&rig.slot, Command::Disarm).outcome,
            OutcomeCode::Accepted
        );
    }

    #[test]
    fn a_reconnect_never_arms_and_a_fault_reset_never_arms() {
        let mut rig = Rig::active();
        rig.stop_frames();
        wait_until("fault", ms(3_000), || {
            rig.slot.status().state == StateCode::Fault
        });
        let s = rig.slot.status();
        assert!(s.last_safety_event.is_some());
        assert_eq!(s.counters.disarms_encoded, 1);
        let commands = s.counters.commands_encoded;

        rig.restart_frames();
        rig.wait_fresh();
        std::thread::sleep(ms(600));
        let s = rig.slot.status();
        assert_eq!(
            s.state,
            StateCode::Fault,
            "a reconnect does not clear the fault"
        );
        assert_eq!(s.counters.commands_encoded, commands);

        let arm = run(&rig.slot, Command::Arm);
        assert_eq!(arm.rejection, Some(RejectionDto::FaultNotReset));
        let reset = run(&rig.slot, Command::ResetFault);
        assert_eq!(reset.outcome, OutcomeCode::Accepted);
        assert_eq!(reset.state, Some(StateCode::Disabled));
        std::thread::sleep(ms(400));
        let s = rig.slot.status();
        assert_eq!(s.state, StateCode::Disabled, "the reset does not arm");
        assert_eq!(s.counters.commands_encoded, commands);
    }

    // ---- no blocking on readers ----

    #[test]
    fn a_reader_holding_the_status_never_blocks_the_control_ticks() {
        // A reader of normal priority that holds the status (for example while it is preempted)
        // must not stop the elevated control loop: ticks keep encoding commands meanwhile.
        let rig = Rig::active();
        let handle = handle_of(&rig.slot);
        let log = handle.log();
        let count = |log: &crate::control::log::ControlLog| {
            log.snapshot()
                .messages
                .iter()
                .filter(|e| e.event.kind == crate::control::log::MessageKind::Command)
                .count()
        };
        let before = count(&log);
        {
            let _reader = handle.hold_status();
            std::thread::sleep(ms(300));
            let during = count(&log) - before;
            assert!(
                during >= 5,
                "only {during} commands were encoded while a reader held the status"
            );
        }
        // Once the reader is gone, the status is published again.
        let ticks = rig.slot.status().timing.ticks;
        wait_until("a newer status", ms(1_000), || {
            rig.slot.status().timing.ticks > ticks
        });
    }

    #[test]
    fn commands_are_answered_within_a_few_tick_periods() {
        let rig = Rig::start();
        let started = Instant::now();
        let reply = run(&rig.slot, Command::Disarm);
        assert_eq!(reply.outcome, OutcomeCode::Accepted);
        assert!(
            started.elapsed() < COMMAND_TIMEOUT,
            "a disarm is processed at the next tick: {:?}",
            started.elapsed()
        );
    }

    // ---- status and log ----

    #[test]
    fn the_status_shows_ticks_watchdog_and_the_last_message() {
        let rig = Rig::active();
        std::thread::sleep(ms(300));
        let s = rig.slot.status();
        let tick = s.last_tick.clone().unwrap();
        assert!(tick.sequence > 5);
        assert!(matches!(
            tick.outcome,
            status::TickOutcomeDto::CommandEncoded
        ));
        assert!(!s.watchdog.trip_pending);
        assert!(s.watchdog.loop_silent_ms < s.watchdog.timeout_ms);
        let message = s.last_message.unwrap().message;
        assert!(message.generated && message.encoded);
        assert_eq!(message.delivery, status::DeliveryCode::NotTransmitted);
        assert_eq!(s.last_transition.unwrap().to, StateCode::Active);
        assert!(!s.recent_decisions.is_empty());
    }

    #[test]
    fn the_log_is_newest_first_bounded_and_never_claims_delivery() {
        let rig = Rig::active();
        wait_until("enough log entries", ms(4_000), || {
            rig.slot.status().counters.commands_encoded >= 40
        });
        run(&rig.slot, Command::Disarm);
        let log = rig.slot.log(30);
        assert_eq!(log.len(), 30);
        assert!(log.windows(2).all(|w| w[0].n > w[1].n));
        assert_eq!(rig.slot.log(5).len(), 5);
        assert!(rig.slot.log(100_000).len() <= status::MAX_LOG_ENTRIES);
        let json = serde_json::to_string(&rig.slot.log(200)).unwrap();
        assert!(json.contains("\"delivery\":\"notTransmitted\""));
        assert!(!json.to_lowercase().contains("delivered"));
        let status = serde_json::to_string(&rig.slot.status()).unwrap();
        assert!(!status.to_lowercase().contains("delivered"));
        assert!(status.contains("\"mode\":\"dryRun\""));
    }

    #[test]
    fn the_emitter_sends_the_status_regularly_and_a_final_stopped_status() {
        let feed = FrameFeed::new();
        let seen: Arc<Mutex<Vec<ControlStatus>>> = Arc::default();
        let sink = seen.clone();
        let slot = ControlSlot::new();
        slot.start(
            feed,
            Box::new(NeutralRequests),
            Some(Box::new(move |s| sink.lock().unwrap().push(s))),
        )
        .unwrap();
        std::thread::sleep(ms(1_100));
        let count = seen.lock().unwrap().len();
        assert!((3..=8).contains(&count), "about 5 per second, got {count}");
        assert!(
            seen.lock()
                .unwrap()
                .iter()
                .all(|s| s.mode == ModeCode::DryRun)
        );
        slot.shutdown(SHUTDOWN_GRACE, ABORT_GRACE);
        wait_until("the final status", ms(2_000), || {
            seen.lock()
                .unwrap()
                .last()
                .is_some_and(|s| s.runtime == RuntimeCode::Stopped)
        });
        let n = seen.lock().unwrap().len();
        std::thread::sleep(ms(500));
        assert_eq!(seen.lock().unwrap().len(), n, "the emitter stopped");
    }

    // ---- shutdown ----

    #[test]
    fn shutdown_while_active_disarms_within_the_grace_period() {
        let rig = Rig::active();
        let started = Instant::now();
        let outcome = rig.slot.shutdown(SHUTDOWN_GRACE, ABORT_GRACE);
        let elapsed = started.elapsed();
        assert!(elapsed < SHUTDOWN_GRACE, "orderly path took {elapsed:?}");
        let ShutdownOutcome::Completed(report) = outcome else {
            panic!("expected an orderly shutdown, got {outcome:?}");
        };
        assert_eq!(
            report.disarm,
            crate::control::log::DisarmStatus::EncodedNotTransmitted
        );
        // The disarm and the shutdown record exist before the task ended.
        let log = rig.slot.log(10);
        assert!(log.iter().any(|e| matches!(
            e.event,
            status::LogEventDto::Shutdown {
                disarm: status::DisarmCode::EncodedNotTransmitted
            }
        )));
        let last_message = log
            .iter()
            .find_map(|e| match &e.event {
                status::LogEventDto::Message { message } => Some(message.clone()),
                _ => None,
            })
            .unwrap();
        assert_eq!(last_message.kind, status::MessageKindCode::Disarm);
        let s = rig.slot.status();
        assert_eq!(s.runtime, RuntimeCode::Stopped);
        assert_eq!(s.state, StateCode::Disabled);
        assert_eq!(
            run(&rig.slot, Command::Arm).outcome,
            OutcomeCode::Unavailable
        );
        assert_eq!(
            rig.slot.shutdown(SHUTDOWN_GRACE, ABORT_GRACE),
            ShutdownOutcome::NotRunning
        );
    }

    /// A controller that blocks its thread once `block` is set, simulating a stuck loop.
    struct Blocking {
        block: Arc<AtomicBool>,
        delay: Duration,
    }

    impl RequestSource for Blocking {
        fn next_request(
            &mut self,
            _state: &VehicleState,
        ) -> crate::control::command::ControlRequest {
            if self.block.load(Ordering::SeqCst) {
                std::thread::sleep(self.delay);
            }
            crate::control::command::ControlRequest {
                steering: None,
                throttle: 0.0,
                brake: 0.0,
            }
        }
    }

    #[test]
    fn a_stuck_task_is_aborted_after_the_grace_period_and_its_disarm_is_still_recorded() {
        let block = Arc::new(AtomicBool::new(false));
        let rig = Rig::active_with(Box::new(Blocking {
            block: block.clone(),
            delay: ms(900),
        }));
        block.store(true, Ordering::SeqCst);
        // Let a tick enter the blocking call.
        std::thread::sleep(ms(100));
        let started = Instant::now();
        let outcome = rig.slot.shutdown(SHUTDOWN_GRACE, ABORT_GRACE);
        let elapsed = started.elapsed();
        assert!(
            elapsed >= SHUTDOWN_GRACE,
            "the grace period was honoured: {elapsed:?}"
        );
        assert!(
            elapsed < SHUTDOWN_GRACE + ABORT_GRACE,
            "bounded: {elapsed:?}"
        );
        assert_eq!(
            outcome,
            ShutdownOutcome::Aborted {
                disarm_settled: true
            },
            "the dropped core recorded the disarm"
        );
        let log = handle_of(&rig.slot).log().snapshot();
        assert_eq!(
            log.messages.last().unwrap().event.kind,
            crate::control::log::MessageKind::Disarm
        );
    }

    #[test]
    fn a_task_that_already_died_is_reported_and_its_disarm_checked() {
        let rig = Rig::active();
        // Simulate a crash of the control task.
        if let Slot::Running(r) = &mut *rig.slot.lock()
            && let Some(abort) = r.control.abort.take()
        {
            let _ = abort.send(());
        }
        wait_until("the task to end", ms(2_000), || {
            rig.slot.status().runtime == RuntimeCode::Stopped
        });
        let outcome = rig.slot.shutdown(SHUTDOWN_GRACE, ABORT_GRACE);
        assert_eq!(
            outcome,
            ShutdownOutcome::AlreadyStopped {
                disarm_settled: true
            }
        );
    }

    // ---- real-time timing measurements (Windows acceptance tests, ignored by default) ----
    //
    // These run the production slot and runtime on the real clock, with telemetry arriving at
    // 60 Hz and the supervisor Active in dry run, so every tick generates and encodes a
    // command. They are ignored in normal runs because their result depends on the machine and
    // its load. Run them with a release build:
    //
    //   cargo test --release --lib timing_acceptance -- --ignored --nocapture
    //   cargo test --release --lib timing_start_stop -- --ignored --nocapture
    //
    // ROADPILOT_TIMING_SECONDS (default 60) and ROADPILOT_TIMING_CYCLES (default 20) set the
    // duration. The acceptance criterion is no tick interval and no command refresh interval
    // above 50 ms, no timing fault and no watchdog trip.

    fn env_u64(name: &str, default: u64) -> u64 {
        std::env::var(name)
            .ok()
            .and_then(|v| v.parse().ok())
            .unwrap_or(default)
    }

    fn print_report(label: &str, seconds: f64, timing: &status::TimingDto) {
        let report = serde_json::json!({
            "label": label,
            "seconds": seconds,
            "os": std::env::consts::OS,
            "logicalCpus": std::thread::available_parallelism().map(|n| n.get()).unwrap_or(0),
            "optimized": !cfg!(debug_assertions),
            "timing": timing,
        });
        println!("{}", serde_json::to_string_pretty(&report).unwrap());
    }

    /// Prints the wall-clock time of every late tick still in the log, so outliers can be
    /// correlated with other processes (an independent probe sees system-wide stalls too).
    fn print_late_ticks(slot: &ControlSlot, status: &ControlStatus) {
        let wall_now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0);
        // Read the timing ring itself: the merged log view is dominated by the 25 messages per
        // second and would hide older timing records.
        for entry in handle_of(slot).log().snapshot().timing {
            let at_ms = entry.at.as_millis() as u64;
            let wall = wall_now.saturating_sub(status.now_ms.saturating_sub(at_ms));
            println!(
                "late tick at t+{:.1}s wall {} : {:?}",
                at_ms as f64 / 1_000.0,
                wall % 1_000_000,
                entry.event
            );
        }
    }

    fn assert_acceptance(timing: &status::TimingDto) {
        assert_eq!(timing.intervals.over_50, 0, "tick intervals above 50 ms");
        assert_eq!(
            timing.command_intervals.over_50, 0,
            "command refresh intervals above 50 ms"
        );
        assert_eq!(timing.gap_violations, 0, "timing faults");
        assert_eq!(timing.watchdog_trips, 0, "watchdog trips");
    }

    #[test]
    #[ignore = "real-time Windows timing measurement; run explicitly"]
    fn timing_acceptance() {
        let seconds = env_u64("ROADPILOT_TIMING_SECONDS", 60);
        let rig = Rig::active();
        let started = Instant::now();
        std::thread::sleep(Duration::from_secs(seconds));
        let status = rig.slot.status();
        print_report(
            "timing_acceptance",
            started.elapsed().as_secs_f64(),
            &status.timing,
        );
        print_late_ticks(&rig.slot, &status);
        assert_eq!(status.state, StateCode::Active, "still active at the end");
        assert_acceptance(&status.timing);
    }

    #[test]
    #[ignore = "real-time Windows timing measurement; run explicitly"]
    fn timing_start_stop() {
        let cycles = env_u64("ROADPILOT_TIMING_CYCLES", 20);
        let mut worst_interval: f64 = 0.0;
        let mut worst_command: f64 = 0.0;
        let mut ticks = 0;
        let mut over_50 = 0;
        for cycle in 1..=cycles {
            let rig = Rig::active();
            std::thread::sleep(Duration::from_secs(5));
            let timing = rig.slot.status().timing;
            let outcome = rig.slot.shutdown(SHUTDOWN_GRACE, ABORT_GRACE);
            assert!(
                matches!(outcome, ShutdownOutcome::Completed(_)),
                "cycle {cycle}: {outcome:?}"
            );
            println!(
                "cycle {cycle}: ticks {} p99 {:.2} p99.9 {:.2} max {:.2} ms, command max {:.2} ms, >50 {}",
                timing.ticks,
                timing.intervals.p99_ms,
                timing.intervals.p999_ms,
                timing.intervals.max_ms,
                timing.command_intervals.max_ms,
                timing.intervals.over_50 + timing.command_intervals.over_50
            );
            worst_interval = worst_interval.max(timing.intervals.max_ms);
            worst_command = worst_command.max(timing.command_intervals.max_ms);
            ticks += timing.ticks;
            over_50 += timing.intervals.over_50 + timing.command_intervals.over_50;
            assert_acceptance(&timing);
        }
        println!(
            "start/stop: {cycles} cycles, {ticks} ticks, worst interval {worst_interval:.2} ms, worst command interval {worst_command:.2} ms, above 50 ms: {over_50}"
        );
    }

    // ---- dry run ----

    #[test]
    fn no_command_selects_a_mode_or_enables_transmission() {
        for name in CONTROL_COMMANDS {
            for word in ["live", "mode", "transmit", "pipe", "send", "enable"] {
                assert!(!name.contains(word), "{name} contains {word}");
            }
        }
        assert_eq!(CONTROL_COMMANDS.len(), 6);
    }
}
