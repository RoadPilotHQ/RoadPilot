mod telemetry;

use std::sync::{Arc, Mutex};
use tauri::{Emitter, Manager, RunEvent};
use telemetry::engine::{self, SharedUpdate, UpdateSink};
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
            let task = tauri::async_runtime::spawn(engine::run(
                TauriSink(app.handle().clone(), visualization),
                latest.clone(),
            ));
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
