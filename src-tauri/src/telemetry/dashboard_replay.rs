//! Offline replay of recorded drives through the dashboard path: `normalize` and the
//! connection state machine, exactly as the engine runs them, without a game or a pipe.
//!
//! The fixtures are the compact replays of diagnostic recordings in
//! `tests/fixtures/replay/` (see `tests/replay_support/fixture.rs`). They keep the timing,
//! the identity, the pause state, the speed and the parking brake of every frame.

#[path = "../../tests/replay_support/fixture.rs"]
mod fixture;

use super::model::{ConnectionStatus, Game};
use super::normalize::{FrameInput, normalize};
use super::status::{ConnectionTracker, GameProcess, LatestFrame, STALE_AFTER};
use fixture::Fixture;
use roadpilot_telemetry_client as proto;
use std::time::{Duration, Instant};

const CALIBRATION: &str = include_str!("../../tests/fixtures/replay/calibration-2026-11-13.txt");
const STAGE_B: &str = include_str!("../../tests/fixtures/replay/stage-b-2026-11-13.txt");

#[derive(Debug, Default)]
struct Summary {
    frames: usize,
    connected: usize,
    paused: usize,
    stale: usize,
    with_speed: usize,
    with_parking_brake: usize,
    max_speed_kmh: f32,
}

fn game_id(fixture: &Fixture) -> proto::GameId {
    match fixture.game.as_str() {
        "ets2" => proto::GameId::Ets2,
        _ => proto::GameId::Ats,
    }
}

/// Feeds every frame at its recorded receive time; between frames that are further apart
/// than the stale limit, the state is also evaluated just after the limit, as the engine's
/// timer would.
fn replay(fixture: &Fixture) -> Summary {
    let parsed_game = game_id(fixture);
    let game = Game::from(parsed_game);
    let process = GameProcess::Running(game);
    let start = Instant::now();
    let first_us = fixture.records.first().map_or(0, |r| r.received_us);
    let at = |us: i64| start + Duration::from_micros((us - first_us).max(0) as u64);

    let mut tracker = ConnectionTracker::default();
    let mut latest: Option<LatestFrame> = None;
    let mut summary = Summary::default();

    for record in &fixture.records {
        let now = at(record.received_us);
        if let Some(previous) = &latest {
            let probe = previous.received_at + STALE_AFTER + Duration::from_millis(1);
            if probe < now {
                let update = tracker.evaluate(probe, Some(previous), process, None);
                if update.status == ConnectionStatus::Reconnecting {
                    summary.stale += 1;
                    assert!(update.data.is_none(), "stale values are never shown");
                    assert_eq!(update.game, Some(game));
                } else {
                    // Only a paused game keeps its last values without new frames.
                    assert_eq!(update.status, ConnectionStatus::Connected);
                    assert!(update.paused);
                }
            }
        }

        let state = if record.paused {
            proto::PluginState::Paused
        } else {
            proto::PluginState::Running
        };
        let mut frame = proto::TelemetryFrame::new(record.sequence, parsed_game, state);
        frame.session = Some(record.session);
        frame.simulation_time_us = record.simulation_time_us;
        frame.truck = Some(proto::TruckState {
            speed_mps: record.speed_cm_s.map(|cm| cm as f32 / 100.0),
            parking_brake: record.parking_brake,
            ..proto::TruckState::default()
        });
        let data = normalize(&FrameInput {
            frame: &frame,
            dropped_fields: &[],
            received_at_unix_ms: 1_700_000_000_000,
        });

        let v = &data.vehicle;
        match record.speed_cm_s {
            Some(cm) => {
                let expected = (cm as f32 * 0.036 * 10.0).round() / 10.0;
                let speed = v.speed_kmh.expect("speed present in the frame");
                assert!((speed - expected).abs() < 0.051, "{speed} vs {expected}");
                assert!(speed.is_finite());
                summary.with_speed += 1;
                summary.max_speed_kmh = summary.max_speed_kmh.max(speed.abs());
            }
            None => assert_eq!(v.speed_kmh, None, "missing speed stays missing"),
        }
        assert_eq!(v.parking_brake, record.parking_brake);
        if v.parking_brake.is_some() {
            summary.with_parking_brake += 1;
        }
        // The recording keeps no other vehicle value: none may be invented.
        assert_eq!(v.engine_rpm, None);
        assert_eq!(v.fuel_l, None);
        assert_eq!(v.odometer_km, None);

        latest = Some(LatestFrame {
            received_at: now,
            game,
            paused: record.paused,
            data,
        });
        let update = tracker.evaluate(now, latest.as_ref(), process, None);
        assert_eq!(update.status, ConnectionStatus::Connected);
        assert_eq!(update.game, Some(game));
        assert_eq!(update.paused, record.paused);
        let shown = update.data.expect("a fresh frame is shown");
        assert_eq!(shown.source.sequence, record.sequence);
        summary.frames += 1;
        summary.connected += 1;
        if record.paused {
            summary.paused += 1;
        }
    }

    // The game exits (frames have stopped): the last frame must never come back.
    let end =
        latest.as_ref().map_or(start, |f| f.received_at) + STALE_AFTER + Duration::from_secs(1);
    let update = tracker.evaluate(end, latest.as_ref(), GameProcess::NotRunning, None);
    assert_eq!(update.status, ConnectionStatus::Disconnected);
    assert!(update.data.is_none());
    let update = tracker.evaluate(end + Duration::from_secs(1), latest.as_ref(), process, None);
    assert_eq!(update.status, ConnectionStatus::Connecting);
    assert!(update.data.is_none());
    summary
}

#[test]
fn the_ats_calibration_drive_replays_through_the_dashboard_path() {
    let fixture = fixture::parse(CALIBRATION);
    assert_eq!(fixture.game, "ats");
    let s = replay(&fixture);
    assert_eq!(s.frames, fixture.records.len());
    assert!(s.frames > 1000, "{s:?}");
    assert!(s.paused > 0, "the drive starts paused: {s:?}");
    assert!(s.with_speed > 0, "{s:?}");
    assert!(s.max_speed_kmh < 200.0, "{s:?}");
}

#[test]
fn the_stage_b_drive_replays_through_the_dashboard_path() {
    let fixture = fixture::parse(STAGE_B);
    let s = replay(&fixture);
    assert_eq!(s.frames, fixture.records.len());
    assert!(s.frames > 1000, "{s:?}");
}
