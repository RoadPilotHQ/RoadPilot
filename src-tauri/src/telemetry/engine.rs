//! Telemetry engine: hosts the RoadPilot telemetry pipe, tracks the connection and
//! publishes normalized updates. Runs on Tauri's async runtime, never on the main thread.

use super::model::TelemetryUpdate;
use super::normalize::normalize_vehicle;
use super::process::detect_game;
use super::status::{ConnectionTracker, GameProcess, LatestFrame};
use roadpilot_telemetry_client::{PluginState, ReceivedTelemetryFrame};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tokio::sync::watch;
use tokio::time::sleep;

/// Sampling interval while connected: caps frontend events at 10 per second
/// although the plugin sends one frame per game frame.
const LIVE_INTERVAL: Duration = Duration::from_millis(100);
/// Re-evaluation interval while not connected (status changes only).
const IDLE_INTERVAL: Duration = Duration::from_secs(1);
const PROCESS_SCAN_INTERVAL: Duration = Duration::from_secs(2);
const ENDPOINT_RETRY: Duration = Duration::from_secs(5);

/// Receives every changed update. Implemented by the Tauri event emitter.
pub trait UpdateSink: Send + 'static {
    fn publish(&self, update: &TelemetryUpdate);
}

/// Latest update, readable by the `telemetry_snapshot` command.
pub type SharedUpdate = Arc<Mutex<TelemetryUpdate>>;

pub async fn run(sink: impl UpdateSink, shared: SharedUpdate) {
    let mut tracker = ConnectionTracker::default();
    let mut endpoint = Endpoint::start();
    let mut process = GameProcess::Unknown;
    let mut last_scan: Option<Instant> = None;
    let mut last_sent: Option<TelemetryUpdate> = None;

    loop {
        let now = Instant::now();
        endpoint.poll(now).await;

        let latest = endpoint.latest();
        let fresh_frame =
            latest.is_some_and(|f| now.duration_since(f.received_at) < LIVE_INTERVAL * 5);
        if !fresh_frame && last_scan.is_none_or(|t| now.duration_since(t) >= PROCESS_SCAN_INTERVAL)
        {
            process = tokio::task::spawn_blocking(detect_game)
                .await
                .unwrap_or(GameProcess::Unknown);
            last_scan = Some(now);
        }

        let update = tracker.evaluate(now, latest.as_ref(), process, endpoint.error.as_deref());
        if last_sent.as_ref() != Some(&update) {
            if let Ok(mut slot) = shared.lock() {
                *slot = update.clone();
            }
            sink.publish(&update);
            last_sent = Some(update);
        }

        let connected = last_sent
            .as_ref()
            .is_some_and(|u| u.vehicle.is_some() && !u.paused);
        if connected {
            sleep(LIVE_INTERVAL).await;
        } else {
            // Wake early when the first frame arrives.
            tokio::select! {
                _ = sleep(IDLE_INTERVAL) => {}
                _ = endpoint.changed() => {}
            }
        }
    }
}

/// The named-pipe server task plus its output channel. Restarted after failures,
/// for example while another telemetry reader holds the pipe.
struct Endpoint {
    receiver: watch::Receiver<Option<ReceivedTelemetryFrame>>,
    task: Option<tauri::async_runtime::JoinHandle<std::io::Result<()>>>,
    error: Option<String>,
    failed_at: Option<Instant>,
    started_at: Instant,
}

impl Endpoint {
    fn start() -> Self {
        let (sender, receiver) = watch::channel(None);
        let task = spawn_server(sender);
        Self {
            receiver,
            task,
            error: None,
            failed_at: None,
            started_at: Instant::now(),
        }
    }

    async fn poll(&mut self, now: Instant) {
        if self.task.as_ref().is_some_and(|t| t.inner().is_finished())
            && let Some(task) = self.task.take()
        {
            let reason = match task.await {
                Ok(Ok(())) => "telemetry endpoint stopped".to_owned(),
                Ok(Err(error)) => format!("telemetry pipe unavailable: {error}"),
                Err(error) => format!("telemetry endpoint failed: {error}"),
            };
            self.error = Some(reason);
            self.failed_at = Some(now);
        }
        if self.task.is_none()
            && self
                .failed_at
                .is_none_or(|t| now.duration_since(t) >= ENDPOINT_RETRY)
        {
            let (sender, receiver) = watch::channel(None);
            self.receiver = receiver;
            self.task = spawn_server(sender);
            self.started_at = now;
            if self.task.is_none() {
                self.failed_at = Some(now);
            }
        }
        // Clear a previous error only once a restarted server has stayed up, so a pipe that
        // is still busy does not make the status flicker on every retry.
        if self.task.is_some() && now.duration_since(self.started_at) >= Duration::from_secs(1) {
            self.error = None;
        }
    }

    fn latest(&self) -> Option<LatestFrame> {
        self.receiver.borrow().as_ref().map(|received| LatestFrame {
            received_at: received.received_at,
            game: received.frame.game.into(),
            paused: received.frame.plugin_state == PluginState::Paused,
            vehicle: normalize_vehicle(&received.frame.values),
        })
    }

    async fn changed(&mut self) {
        if self.receiver.changed().await.is_err() {
            // Sender dropped: the server stopped. Avoid a busy loop until the next poll.
            sleep(IDLE_INTERVAL).await;
        }
    }
}

impl Drop for Endpoint {
    fn drop(&mut self) {
        if let Some(task) = self.task.take() {
            task.abort();
        }
    }
}

#[cfg(windows)]
fn spawn_server(
    sender: watch::Sender<Option<ReceivedTelemetryFrame>>,
) -> Option<tauri::async_runtime::JoinHandle<std::io::Result<()>>> {
    Some(tauri::async_runtime::spawn(
        roadpilot_telemetry_client::named_pipe::serve_latest(sender),
    ))
}

#[cfg(not(windows))]
fn spawn_server(
    _sender: watch::Sender<Option<ReceivedTelemetryFrame>>,
) -> Option<tauri::async_runtime::JoinHandle<std::io::Result<()>>> {
    // The RoadPilot telemetry transport is a Windows named pipe; other platforms have none yet.
    None
}
