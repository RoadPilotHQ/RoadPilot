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

use crate::control::runtime::{self, ControlHandle, FrameSource};
use crate::control::sender::{CoreConfig, RequestSource, ShutdownReport};
use crate::control::status::{
    self, CommandCode, ControlStatus, LogEntryDto, RejectionDto, RuntimeCode, StateCode,
};
use crate::control::supervisor::Command;
use serde::Serialize;
use std::sync::{Mutex, MutexGuard, PoisonError};
use std::time::Duration;
use tauri::async_runtime::{self, JoinHandle};

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

struct Running {
    handle: ControlHandle,
    sender: JoinHandle<ShutdownReport>,
    watchdog: JoinHandle<()>,
}

enum Slot {
    Empty,
    Running(Running),
    Stopped { handle: ControlHandle },
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
        let rt = runtime::build(feed, source, CoreConfig::default());
        let sender = async_runtime::spawn(rt.sender_task);
        let watchdog = async_runtime::spawn(rt.watchdog_task);
        if let Some(emit) = emitter {
            // Ends by itself once the control task has stopped.
            drop(async_runtime::spawn(emit_status(rt.handle.clone(), emit)));
        }
        *slot = Slot::Running(Running {
            handle: rt.handle,
            sender,
            watchdog,
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
                if r.sender.inner().is_finished() {
                    status.runtime = RuntimeCode::Stopped;
                }
                status
            }
            Slot::Stopped { handle, .. } => {
                let mut status = handle.status();
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
            mut sender,
            watchdog,
        } = running;
        let log = handle.log();
        let already_finished = sender.inner().is_finished();
        handle.shutdown();

        // The timeout must be created inside the future that block_on runs: its timer needs the
        // runtime context, which the calling (main) thread does not have.
        let waited =
            async_runtime::block_on(async { tokio::time::timeout(grace, &mut sender).await });
        let outcome = match waited {
            Ok(Ok(report)) if !already_finished => ShutdownOutcome::Completed(report),
            Ok(_) => ShutdownOutcome::AlreadyStopped {
                disarm_settled: !log.owes_disarm(),
            },
            Err(_elapsed) => {
                sender.abort();
                // Dropping the core encodes the owed disarm; give it time to happen.
                let _ = async_runtime::block_on(async {
                    tokio::time::timeout(abort_grace, &mut sender).await
                });
                ShutdownOutcome::Aborted {
                    disarm_settled: !log.owes_disarm(),
                }
            }
        };
        watchdog.abort();
        *self.lock() = Slot::Stopped { handle };
        outcome
    }
}

/// Sends the status at a fixed rate, independently of the control loop, so a stalled loop
/// shows up as a growing `loopSilentMs` rather than as silence. Sends a final status marked
/// stopped once the control task has ended.
async fn emit_status(handle: ControlHandle, emit: StatusEmitter) {
    let changes = handle.status_changes();
    let mut ticker = tokio::time::interval(STATUS_INTERVAL);
    ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    loop {
        ticker.tick().await;
        let stopped = changes.has_changed().is_err();
        let mut status = handle.status();
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
            let thread = std::thread::spawn(move || {
                while !flag.load(Ordering::SeqCst) {
                    let at = Instant::now();
                    let seq = sequence.fetch_add(1, Ordering::SeqCst) + 1;
                    let sim = u64::try_from(at.duration_since(base).as_micros()).unwrap();
                    let _ = tx.send(Some(ReceivedTelemetryFrame {
                        frame: slow_frame(7, seq, 1_000_000 + sim),
                        dropped_fields: Vec::new(),
                        received_at: at,
                    }));
                    std::thread::sleep(ms(16));
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
        if let Slot::Running(r) = &*rig.slot.lock() {
            r.sender.abort();
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
