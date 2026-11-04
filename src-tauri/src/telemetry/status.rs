//! Connection state machine. Pure logic: time and inputs are passed in, so every
//! transition is unit-testable without a game, a pipe or a real clock.

use super::model::{ConnectionStatus, Game, TelemetryData, TelemetryUpdate};
use std::time::{Duration, Instant};

/// A frame is considered current for this long after it was received.
pub const STALE_AFTER: Duration = Duration::from_secs(2);
/// How long a running game may take to deliver its first frame before telemetry is
/// reported as unavailable.
pub const CONNECT_GRACE: Duration = Duration::from_secs(15);

/// Result of looking for a game process.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum GameProcess {
    Running(Game),
    NotRunning,
    /// Detection is not supported or failed; rely on telemetry frames only.
    Unknown,
}

/// The newest frame, already normalized.
#[derive(Clone, Debug, PartialEq)]
pub struct LatestFrame {
    pub received_at: Instant,
    pub game: Game,
    pub paused: bool,
    pub data: TelemetryData,
}

#[derive(Debug, Default)]
pub struct ConnectionTracker {
    /// Telemetry was live at least once in the current game session.
    had_live_data: bool,
    /// When the current game process was first seen without telemetry.
    waiting_since: Option<Instant>,
    /// Frames received before this instant belong to an earlier session and are ignored.
    session_floor: Option<Instant>,
}

impl ConnectionTracker {
    pub fn evaluate(
        &mut self,
        now: Instant,
        latest: Option<&LatestFrame>,
        process: GameProcess,
        endpoint_error: Option<&str>,
    ) -> TelemetryUpdate {
        if let Some(error) = endpoint_error {
            self.had_live_data = false;
            self.waiting_since = None;
            let mut update = TelemetryUpdate::status(ConnectionStatus::Error, None);
            update.error = Some(error.to_owned());
            return update;
        }

        let latest = latest.filter(|f| {
            self.session_floor
                .is_none_or(|floor| f.received_at >= floor)
        });
        let fresh = latest.filter(|f| now.saturating_duration_since(f.received_at) <= STALE_AFTER);
        let process_game = match process {
            GameProcess::Running(game) => Some(game),
            _ => None,
        };

        if let Some(frame) = fresh {
            self.had_live_data = true;
            self.waiting_since = None;
            return connected(frame);
        }

        match process {
            GameProcess::Running(game) => {
                // A paused game may stop sending frames; its last values are still current.
                if let Some(frame) = latest.filter(|f| f.paused && self.had_live_data) {
                    return connected(frame);
                }
                if self.had_live_data {
                    return TelemetryUpdate::status(
                        ConnectionStatus::Reconnecting,
                        latest.map(|f| f.game).or(Some(game)),
                    );
                }
                let since = *self.waiting_since.get_or_insert(now);
                let status = if now.saturating_duration_since(since) < CONNECT_GRACE {
                    ConnectionStatus::Connecting
                } else {
                    ConnectionStatus::Unavailable
                };
                TelemetryUpdate::status(status, process_game)
            }
            GameProcess::NotRunning => {
                // The game is gone: end the session so its last frame can never come back.
                self.had_live_data = false;
                self.waiting_since = None;
                self.session_floor = Some(now);
                TelemetryUpdate::disconnected()
            }
            GameProcess::Unknown => {
                if self.had_live_data {
                    let stale_for = latest
                        .map(|f| now.saturating_duration_since(f.received_at))
                        .unwrap_or(Duration::MAX);
                    if stale_for < CONNECT_GRACE {
                        return TelemetryUpdate::status(
                            ConnectionStatus::Reconnecting,
                            latest.map(|f| f.game),
                        );
                    }
                    self.had_live_data = false;
                }
                TelemetryUpdate::disconnected()
            }
        }
    }
}

fn connected(frame: &LatestFrame) -> TelemetryUpdate {
    TelemetryUpdate {
        status: ConnectionStatus::Connected,
        game: Some(frame.game),
        paused: frame.paused,
        data: Some(frame.data.clone()),
        error: None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn frame(at: Instant, game: Game, paused: bool) -> LatestFrame {
        LatestFrame {
            received_at: at,
            game,
            paused,
            data: TelemetryData {
                vehicle: crate::telemetry::model::Vehicle {
                    speed_kmh: Some(80.0),
                    engine_rpm: Some(1400.0),
                    gear: Some(12),
                    ..Default::default()
                },
                ..Default::default()
            },
        }
    }

    fn secs(n: u64) -> Duration {
        Duration::from_secs(n)
    }

    #[test]
    fn no_game_means_disconnected() {
        let mut t = ConnectionTracker::default();
        let u = t.evaluate(Instant::now(), None, GameProcess::NotRunning, None);
        assert_eq!(u, TelemetryUpdate::disconnected());
    }

    #[test]
    fn running_game_without_frames_is_connecting_then_unavailable() {
        let mut t = ConnectionTracker::default();
        let start = Instant::now();
        let ets2 = GameProcess::Running(Game::Ets2);
        let u = t.evaluate(start, None, ets2, None);
        assert_eq!(u.status, ConnectionStatus::Connecting);
        assert_eq!(u.game, Some(Game::Ets2));
        let u = t.evaluate(start + CONNECT_GRACE, None, ets2, None);
        assert_eq!(u.status, ConnectionStatus::Unavailable);
        assert!(u.data.is_none());
    }

    #[test]
    fn fresh_frame_is_connected_with_values_and_game_identity() {
        let mut t = ConnectionTracker::default();
        let now = Instant::now();
        let f = frame(now, Game::Ats, false);
        let u = t.evaluate(
            now + secs(1),
            Some(&f),
            GameProcess::Running(Game::Ats),
            None,
        );
        assert_eq!(u.status, ConnectionStatus::Connected);
        assert_eq!(u.game, Some(Game::Ats));
        assert_eq!(u.data.and_then(|d| d.vehicle.speed_kmh), Some(80.0));
    }

    #[test]
    fn stale_frame_while_game_runs_is_reconnecting_without_values() {
        let mut t = ConnectionTracker::default();
        let start = Instant::now();
        let f = frame(start, Game::Ets2, false);
        let ets2 = GameProcess::Running(Game::Ets2);
        t.evaluate(start, Some(&f), ets2, None);
        let u = t.evaluate(start + STALE_AFTER + secs(1), Some(&f), ets2, None);
        assert_eq!(u.status, ConnectionStatus::Reconnecting);
        assert!(
            u.data.is_none(),
            "stale values must not be shown as current"
        );
    }

    #[test]
    fn new_frame_after_interruption_reconnects() {
        let mut t = ConnectionTracker::default();
        let start = Instant::now();
        let ets2 = GameProcess::Running(Game::Ets2);
        t.evaluate(start, Some(&frame(start, Game::Ets2, false)), ets2, None);
        t.evaluate(
            start + secs(5),
            Some(&frame(start, Game::Ets2, false)),
            ets2,
            None,
        );
        let later = start + secs(6);
        let u = t.evaluate(later, Some(&frame(later, Game::Ets2, false)), ets2, None);
        assert_eq!(u.status, ConnectionStatus::Connected);
    }

    #[test]
    fn game_shutdown_disconnects_and_discards_old_session() {
        let mut t = ConnectionTracker::default();
        let start = Instant::now();
        let old = frame(start, Game::Ets2, false);
        t.evaluate(start, Some(&old), GameProcess::Running(Game::Ets2), None);
        let u = t.evaluate(start + secs(3), Some(&old), GameProcess::NotRunning, None);
        assert_eq!(u, TelemetryUpdate::disconnected());
        // Game restarts: the old frame must not count as live data.
        let u = t.evaluate(
            start + secs(4),
            Some(&old),
            GameProcess::Running(Game::Ets2),
            None,
        );
        assert_eq!(u.status, ConnectionStatus::Connecting);
    }

    #[test]
    fn switching_games_reports_the_frame_game() {
        let mut t = ConnectionTracker::default();
        let start = Instant::now();
        t.evaluate(
            start,
            Some(&frame(start, Game::Ets2, false)),
            GameProcess::Running(Game::Ets2),
            None,
        );
        t.evaluate(start + secs(1), None, GameProcess::NotRunning, None);
        let at = start + secs(10);
        let u = t.evaluate(
            at,
            Some(&frame(at, Game::Ats, false)),
            GameProcess::Running(Game::Ats),
            None,
        );
        assert_eq!(u.game, Some(Game::Ats));
        assert_eq!(u.status, ConnectionStatus::Connected);
    }

    #[test]
    fn paused_game_keeps_last_values_while_running() {
        let mut t = ConnectionTracker::default();
        let start = Instant::now();
        let ets2 = GameProcess::Running(Game::Ets2);
        let paused = frame(start, Game::Ets2, true);
        t.evaluate(start, Some(&paused), ets2, None);
        let u = t.evaluate(start + secs(30), Some(&paused), ets2, None);
        assert_eq!(u.status, ConnectionStatus::Connected);
        assert!(u.paused);
        assert!(u.data.is_some());
    }

    #[test]
    fn unknown_process_state_falls_back_to_frame_age() {
        let mut t = ConnectionTracker::default();
        let start = Instant::now();
        let f = frame(start, Game::Ets2, false);
        t.evaluate(start, Some(&f), GameProcess::Unknown, None);
        let u = t.evaluate(start + secs(5), Some(&f), GameProcess::Unknown, None);
        assert_eq!(u.status, ConnectionStatus::Reconnecting);
        let u = t.evaluate(
            start + CONNECT_GRACE + secs(1),
            Some(&f),
            GameProcess::Unknown,
            None,
        );
        assert_eq!(u.status, ConnectionStatus::Disconnected);
    }

    #[test]
    fn endpoint_error_is_reported_without_values() {
        let mut t = ConnectionTracker::default();
        let now = Instant::now();
        let f = frame(now, Game::Ets2, false);
        let u = t.evaluate(
            now,
            Some(&f),
            GameProcess::Running(Game::Ets2),
            Some("pipe busy"),
        );
        assert_eq!(u.status, ConnectionStatus::Error);
        assert_eq!(u.error.as_deref(), Some("pipe busy"));
        assert!(u.data.is_none());
    }
}
