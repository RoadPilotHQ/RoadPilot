//! Telemetry engine: hosts the RoadPilot telemetry pipe, tracks the connection and
//! publishes normalized updates. Runs on Tauri's async runtime, never on the main thread.

use super::model::{ConnectionStatus, TelemetryUpdate};
use super::normalize::{FrameInput, normalize};
use super::process::detect_game;
use super::status::{ConnectionTracker, GameProcess, LatestFrame};
use roadpilot_telemetry_client::{PluginState, ReceivedTelemetryFrame};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
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

type FrameReceiver = watch::Receiver<Option<ReceivedTelemetryFrame>>;

/// Gives other consumers a receiver on the engine's own frame channel, so that control can read
/// the raw frames at full rate without a second pipe server (the pipe allows one reader).
///
/// The engine creates a new channel whenever it restarts the pipe server after a failure; it
/// publishes the new receiver here, so a consumer that finds its receiver closed asks for the
/// current one with [`FrameFeed::current`]. Until the engine has started, the feed holds a
/// closed receiver.
#[derive(Clone, Debug)]
pub struct FrameFeed {
    current: Arc<Mutex<FrameReceiver>>,
}

impl FrameFeed {
    pub fn new() -> Self {
        let (_sender, receiver) = watch::channel(None);
        Self {
            current: Arc::new(Mutex::new(receiver)),
        }
    }

    /// A new receiver on the engine's current frame channel.
    pub fn current(&self) -> FrameReceiver {
        self.current
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clone()
    }

    pub(crate) fn publish(&self, receiver: FrameReceiver) {
        *self
            .current
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner) = receiver;
    }
}

impl Default for FrameFeed {
    fn default() -> Self {
        Self::new()
    }
}

pub async fn run(sink: impl UpdateSink, shared: SharedUpdate, feed: FrameFeed) {
    let mut tracker = ConnectionTracker::default();
    let mut endpoint = Endpoint::start(feed);
    let mut process = GameProcess::Unknown;
    let mut last_scan: Option<Instant> = None;
    let mut last_sent: Option<TelemetryUpdate> = None;

    loop {
        let now = Instant::now();
        endpoint.poll(now).await;

        let latest = endpoint.latest();
        let fresh_frame = latest
            .as_ref()
            .is_some_and(|f| now.duration_since(f.received_at) < LIVE_INTERVAL * 5);
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

        // While connected (also paused: the game keeps sending frames) sample at a fixed
        // rate instead of waking on every frame.
        let connected = last_sent
            .as_ref()
            .is_some_and(|u| u.status == ConnectionStatus::Connected);
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
    /// Shares every channel this endpoint creates with the control side.
    feed: FrameFeed,
    task: Option<tauri::async_runtime::JoinHandle<std::io::Result<()>>>,
    error: Option<String>,
    failed_at: Option<Instant>,
    started_at: Instant,
    /// Normalized form of the newest frame, keyed by its receive time.
    cache: Option<LatestFrame>,
}

impl Endpoint {
    fn start(feed: FrameFeed) -> Self {
        let (sender, receiver) = watch::channel(None);
        feed.publish(receiver.clone());
        let task = spawn_server(sender);
        Self {
            receiver,
            feed,
            task,
            error: None,
            failed_at: None,
            started_at: Instant::now(),
            cache: None,
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
            self.feed.publish(receiver.clone());
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

    /// The newest frame, normalized once per received frame.
    fn latest(&mut self) -> Option<LatestFrame> {
        let borrowed = self.receiver.borrow();
        let Some(received) = borrowed.as_ref() else {
            self.cache = None;
            return None;
        };
        if self
            .cache
            .as_ref()
            .is_none_or(|c| c.received_at != received.received_at)
        {
            self.cache = Some(LatestFrame {
                received_at: received.received_at,
                game: received.frame.game.into(),
                paused: received.frame.plugin_state == PluginState::Paused,
                data: normalize(&FrameInput {
                    frame: &received.frame,
                    dropped_fields: &received.dropped_fields,
                    received_at_unix_ms: unix_ms(received.received_at),
                }),
            });
        }
        self.cache.clone()
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

/// Wall-clock time of a monotonic instant in the past, as Unix epoch milliseconds.
fn unix_ms(at: Instant) -> u64 {
    SystemTime::now()
        .checked_sub(at.elapsed())
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map_or(0, |d| d.as_millis() as u64)
}
