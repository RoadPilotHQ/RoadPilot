pub mod control;
mod control_app;
mod diagnostics;
mod platform;
mod telemetry;

use control::sender::NeutralRequests;
use control_app::{ABORT_GRACE, ControlSlot, SHUTDOWN_GRACE, STATUS_EVENT, ShutdownOutcome};
use diagnostics::recorder::{FINISH_TIMEOUT, Recorder};
use std::sync::{Arc, Mutex};
use tauri::{Emitter, Manager, RunEvent, Runtime};
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

struct TelemetryState {
    latest: SharedUpdate,
    task: Mutex<Option<tauri::async_runtime::JoinHandle<()>>>,
    visualization_task: Mutex<Option<tauri::async_runtime::JoinHandle<()>>>,
}

/// The optional diagnostic telemetry recorder (see `diagnostics::recorder`). Present only when
/// `ROADPILOT_TELEMETRY_RECORD` names a file.
struct RecorderState(Mutex<Option<Recorder>>);

/// Current telemetry state, so the frontend can render before the next event arrives.
#[tauri::command]
fn telemetry_snapshot(state: tauri::State<'_, TelemetryState>) -> TelemetryUpdate {
    state
        .latest
        .lock()
        .map(|u| u.clone())
        .unwrap_or_else(|_| TelemetryUpdate::disconnected())
}

/// Every command the frontend can invoke. Shared by the application and its IPC tests.
fn register_commands<R: Runtime>(builder: tauri::Builder<R>) -> tauri::Builder<R> {
    builder.invoke_handler(tauri::generate_handler![
        telemetry_snapshot,
        control_app::control_status,
        control_app::control_log,
        control_app::control_arm,
        control_app::control_activate,
        control_app::control_disarm,
        control_app::control_reset_fault,
    ])
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    register_commands(tauri::Builder::default())
        .setup(|app| {
            let latest: SharedUpdate = Arc::new(Mutex::new(TelemetryUpdate::disconnected()));
            let visualization = visualization_stream::broadcaster();
            let visualization_task =
                visualization_stream::start(visualization.clone(), latest.clone());
            // One pipe server, owned by the engine. Control reads a second receiver of the same
            // frame channel through the feed.
            let feed = FrameFeed::new();
            // Diagnostics only, and only on request: records every frame and every control log
            // record. It reads the same frame channel as control and never talks to the game.
            let mut recorder = Recorder::from_env();
            if let Some(recorder) = recorder.as_mut()
                && let Err(error) = recorder.observe_frames(feed.clone())
            {
                eprintln!("RoadPilot: telemetry recording cannot observe frames: {error}");
            }
            let observer = recorder.as_ref().map(Recorder::control_observer);
            let task = tauri::async_runtime::spawn(engine::run(
                TauriSink(app.handle().clone(), visualization),
                latest.clone(),
                feed.clone(),
            ));

            // The dry-run control runtime. If it cannot start, the application still runs and
            // reports control as unavailable; nothing is ever encoded in that case.
            let control = ControlSlot::new();
            let emitter = app.handle().clone();
            if let Err(error) = control.start_observed(
                feed,
                Box::new(NeutralRequests),
                Some(Box::new(move |status| {
                    let _ = emitter.emit(STATUS_EVENT, status);
                })),
                observer,
            ) {
                eprintln!("RoadPilot: control runtime not started: {error:?}");
            }
            app.manage(control);
            app.manage(RecorderState(Mutex::new(recorder)));

            app.manage(TelemetryState {
                latest,
                task: Mutex::new(Some(task)),
                visualization_task: Mutex::new(Some(visualization_task)),
            });
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            if let RunEvent::Exit = event {
                // Control first: disarm before anything else goes away.
                if let Some(control) = app.try_state::<ControlSlot>() {
                    // Diagnostics for timing measurements of the running application: when
                    // ROADPILOT_TIMING_REPORT names a file, the tick timing summary is written
                    // there at exit. Nothing is written otherwise.
                    if let Some(path) = std::env::var_os("ROADPILOT_TIMING_REPORT") {
                        let timing = control.status().timing;
                        if let Ok(json) = serde_json::to_vec_pretty(&timing) {
                            let _ = std::fs::write(path, json);
                        }
                    }
                    let outcome = control.shutdown(SHUTDOWN_GRACE, ABORT_GRACE);
                    if !matches!(
                        outcome,
                        ShutdownOutcome::Completed(_) | ShutdownOutcome::NotRunning
                    ) {
                        eprintln!("RoadPilot: control shutdown: {outcome:?}");
                    }
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
                // Last: control has stopped and recorded its shutdown, so the recording can be
                // written out completely and closed with its end record.
                if let Some(state) = app.try_state::<RecorderState>()
                    && let Ok(mut recorder) = state.0.lock()
                    && let Some(recorder) = recorder.take()
                {
                    let _ = recorder.finish(FINISH_TIMEOUT);
                }
            }
        });
}

/// IPC tests against Tauri's mock runtime: the commands are invoked exactly as the frontend
/// invokes them. No telemetry pipe server is created here; control reads an empty feed.
#[cfg(test)]
mod tests {
    use super::*;
    use control_app::CONTROL_COMMANDS;
    use serde_json::{Value, json};
    use tauri::ipc::{CallbackFn, InvokeBody};
    use tauri::test::{
        INVOKE_KEY, MockRuntime, get_ipc_response, mock_builder, mock_context, noop_assets,
    };
    use tauri::webview::InvokeRequest;

    fn app() -> (tauri::App<MockRuntime>, tauri::WebviewWindow<MockRuntime>) {
        let control = ControlSlot::new();
        control
            .start(FrameFeed::new(), Box::new(NeutralRequests), None)
            .unwrap();
        let app = register_commands(mock_builder())
            .manage(control)
            .manage(TelemetryState {
                latest: Arc::new(Mutex::new(TelemetryUpdate::disconnected())),
                task: Mutex::new(None),
                visualization_task: Mutex::new(None),
            })
            .build(mock_context(noop_assets()))
            .unwrap();
        let webview = tauri::WebviewWindowBuilder::new(&app, "main", Default::default())
            .build()
            .unwrap();
        (app, webview)
    }

    fn invoke(
        webview: &tauri::WebviewWindow<MockRuntime>,
        cmd: &str,
        body: Value,
    ) -> Result<Value, Value> {
        get_ipc_response(
            webview,
            InvokeRequest {
                cmd: cmd.into(),
                callback: CallbackFn(0),
                error: CallbackFn(1),
                url: if cfg!(windows) {
                    "http://tauri.localhost"
                } else {
                    "tauri://localhost"
                }
                .parse()
                .unwrap(),
                body: InvokeBody::Json(body),
                headers: Default::default(),
                invoke_key: INVOKE_KEY.to_string(),
            },
        )
        .map(|b| b.deserialize::<Value>().unwrap())
    }

    fn shutdown(app: &tauri::App<MockRuntime>) -> ShutdownOutcome {
        app.state::<ControlSlot>()
            .shutdown(SHUTDOWN_GRACE, ABORT_GRACE)
    }

    #[test]
    fn every_control_command_is_registered_and_answers() {
        let (app, webview) = app();
        for cmd in CONTROL_COMMANDS {
            assert!(
                invoke(&webview, cmd, json!({})).is_ok(),
                "{cmd} is not registered"
            );
        }
        assert!(invoke(&webview, "telemetry_snapshot", json!({})).is_ok());
        shutdown(&app);
    }

    #[test]
    fn no_command_exists_to_enable_transmission_or_change_the_mode() {
        let (app, webview) = app();
        for cmd in [
            "control_enable_live",
            "control_set_mode",
            "control_transmit",
            "control_send",
            "control_open_pipe",
        ] {
            assert!(
                invoke(&webview, cmd, json!({})).is_err(),
                "{cmd} must not exist"
            );
        }
        shutdown(&app);
    }

    #[test]
    fn the_status_command_reports_a_disarmed_dry_run_runtime() {
        let (app, webview) = app();
        let status = invoke(&webview, "control_status", json!({})).unwrap();
        assert_eq!(status["runtime"], "running");
        assert_eq!(status["mode"], "dryRun");
        assert_eq!(status["state"], "disabled");
        assert_eq!(status["permitsOutput"], false);
        assert_eq!(status["telemetry"]["freshness"], "noFrame");
        shutdown(&app);
    }

    #[test]
    fn operator_commands_answer_through_ipc_and_the_supervisor_decides() {
        let (app, webview) = app();
        // No telemetry: arming is refused by the supervisor, not by the UI.
        let arm = invoke(&webview, "control_arm", json!({})).unwrap();
        assert_eq!(arm["command"], "arm");
        assert_eq!(arm["outcome"], "rejected");
        assert_eq!(arm["rejection"]["code"], "notReady");
        assert_eq!(arm["state"], "disabled");
        let activate = invoke(&webview, "control_activate", json!({})).unwrap();
        assert_eq!(activate["rejection"]["code"], "notArmed");
        let reset = invoke(&webview, "control_reset_fault", json!({})).unwrap();
        assert_eq!(reset["rejection"]["code"], "notInFault");
        // Disarm is always accepted.
        let disarm = invoke(&webview, "control_disarm", json!({})).unwrap();
        assert_eq!(disarm["outcome"], "accepted");
        assert_eq!(disarm["state"], "disabled");
        shutdown(&app);
    }

    #[test]
    fn the_log_command_honours_its_limit() {
        let (app, webview) = app();
        for _ in 0..5 {
            invoke(&webview, "control_arm", json!({})).unwrap();
        }
        let log = invoke(&webview, "control_log", json!({ "limit": 3 })).unwrap();
        assert_eq!(log.as_array().unwrap().len(), 3);
        assert_eq!(log[0]["category"], "decision");
        assert_eq!(log[0]["event"], "commandRejected");
        let all = invoke(&webview, "control_log", json!({})).unwrap();
        assert!(all.as_array().unwrap().len() >= 5);
        shutdown(&app);
    }

    #[test]
    fn after_shutdown_the_commands_report_a_stopped_disarmed_runtime() {
        let (app, webview) = app();
        let outcome = shutdown(&app);
        assert!(
            matches!(outcome, ShutdownOutcome::Completed(_)),
            "{outcome:?}"
        );
        let status = invoke(&webview, "control_status", json!({})).unwrap();
        assert_eq!(status["runtime"], "stopped");
        assert_eq!(status["state"], "disabled");
        let disarm = invoke(&webview, "control_disarm", json!({})).unwrap();
        assert_eq!(disarm["outcome"], "unavailable");
    }
}
