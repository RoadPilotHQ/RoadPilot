pub mod control;
mod telemetry;

use control::runtime::{self as control_runtime, ControlHandle};
use control::sender::{CoreConfig, NeutralRequests, ShutdownReport};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::{Emitter, Manager, RunEvent};
use telemetry::engine::{self, FrameFeed, SharedUpdate, UpdateSink};
use telemetry::model::TelemetryUpdate;
use telemetry::visualization_stream::{self, UpdateBroadcaster};

/// Event carrying a `TelemetryUpdate` whenever the telemetry state changes.
pub const TELEMETRY_EVENT: &str = "telemetry:update";

struct TauriSink(tauri::AppHandle, UpdateBroadcaster);

impl UpdateSink for TauriSink {
    fn publish(&self, update: &TelemetryUpdate) {
        let _ = self.0.emit(TELEMETRY_EVENT, update);
        let _ = self.1.send(update.clone());
    }
}

/// How long application exit waits for the control task to disarm before aborting it. Aborting
/// still encodes the owed disarm, because dropping the control core does.
const CONTROL_SHUTDOWN_GRACE: Duration = Duration::from_millis(500);

/// The dry-run control tasks. Nothing in the application can arm them yet: there is no app
/// command and no UI, and the sink discards every message.
struct ControlState {
    handle: ControlHandle,
    sender: Mutex<Option<tauri::async_runtime::JoinHandle<ShutdownReport>>>,
    watchdog: Mutex<Option<tauri::async_runtime::JoinHandle<()>>>,
}

impl ControlState {
    /// Disarms and stops control, waiting a bounded time for the orderly path.
    fn shutdown(&self) {
        self.handle.shutdown();
        if let Ok(mut slot) = self.sender.lock()
            && let Some(mut task) = slot.take()
        {
            let finished = tauri::async_runtime::block_on(tokio::time::timeout(
                CONTROL_SHUTDOWN_GRACE,
                &mut task,
            ));
            if finished.is_err() {
                task.abort();
            }
        }
        if let Ok(mut slot) = self.watchdog.lock()
            && let Some(task) = slot.take()
        {
            task.abort();
        }
    }
}

struct TelemetryState {
    latest: SharedUpdate,
    task: Mutex<Option<tauri::async_runtime::JoinHandle<()>>>,
    visualization_task: Mutex<Option<tauri::async_runtime::JoinHandle<()>>>,
}

/// Current telemetry state, so the frontend can render before the next event arrives.
#[tauri::command]
fn telemetry_snapshot(state: tauri::State<'_, TelemetryState>) -> TelemetryUpdate {
    state
        .latest
        .lock()
        .map(|u| u.clone())
        .unwrap_or_else(|_| TelemetryUpdate::disconnected())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            let latest: SharedUpdate = Arc::new(Mutex::new(TelemetryUpdate::disconnected()));
            let visualization = visualization_stream::broadcaster();
            let visualization_task =
                visualization_stream::start(visualization.clone(), latest.clone());
            // One pipe server, owned by the engine. Control reads a second receiver of the same
            // frame channel through the feed.
            let feed = FrameFeed::new();
            let task = tauri::async_runtime::spawn(engine::run(
                TauriSink(app.handle().clone(), visualization),
                latest.clone(),
                feed.clone(),
            ));
            let control =
                control_runtime::build(feed, Box::new(NeutralRequests), CoreConfig::default());
            app.manage(ControlState {
                handle: control.handle,
                sender: Mutex::new(Some(tauri::async_runtime::spawn(control.sender_task))),
                watchdog: Mutex::new(Some(tauri::async_runtime::spawn(control.watchdog_task))),
            });
            app.manage(TelemetryState {
                latest,
                task: Mutex::new(Some(task)),
                visualization_task: Mutex::new(Some(visualization_task)),
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![telemetry_snapshot])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            if let RunEvent::Exit = event {
                // Control first: disarm before anything else goes away.
                if let Some(control) = app.try_state::<ControlState>() {
                    control.shutdown();
                }
                if let Some(state) = app.try_state::<TelemetryState>() {
                    if let Ok(mut task) = state.task.lock()
                        && let Some(task) = task.take()
                    {
                        // Stops the engine; dropping it also aborts the pipe server.
                        task.abort();
                    }
                    if let Ok(mut task) = state.visualization_task.lock()
                        && let Some(task) = task.take()
                    {
                        task.abort();
                    }
                }
            }
        });
}
