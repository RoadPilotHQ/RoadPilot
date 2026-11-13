//! Replays recorded ATS drives through the production control core, deterministically.
//!
//! The fixtures in `tests/fixtures/replay/` are compact extracts of two diagnostic recordings
//! (format: `tests/replay_support/fixture.rs`):
//!
//! * `stage-b-2026-11-13.txt`: Phase 4.5 Stage B, ATS 1.62, telemetry plugin without QPC
//!   stamps (36,290 frames, including a game restart);
//! * `calibration-2026-11-13.txt`: Phase 4.5.2 calibration drive with QPC stamps (46,389
//!   frames).
//!
//! Each frame is rebuilt with its recorded identity, plugin state, simulation time, QPC
//! stamps, speed and parking brake, received at its recorded time on a virtual clock, and fed
//! to `ControlCore` exactly as the runtime does: all frames received up to a tick, then the
//! tick, on a fixed 40 ms grid. The decisions the core logs are counted and compared with the
//! decisions of the recorded control run (the `expect` lines). Nothing here uses a game, a
//! pipe or the wall clock, so repeated runs give identical results.
//!
//! The full recordings stay local. To replay them directly (and check that a fixture loses
//! nothing the replay needs), set `ROADPILOT_REPLAY_JSONL` to one or more recording paths
//! separated by `;` and run the ignored test:
//!
//!   cargo test --test replay -- --ignored --nocapture

#[path = "replay_support/fixture.rs"]
mod fixture;

use fixture::{Fixture, Record};
use roadpilot_lib::control::freshness::FrameDigest;
use roadpilot_lib::control::log::{ControlLog, LogObserver, Observed};
use roadpilot_lib::control::mailbox::{self, Delivery, Received};
use roadpilot_lib::control::sender::{ControlCore, CoreConfig, NeutralRequests};
use roadpilot_lib::control::status::LogEntryDto;
use roadpilot_lib::control::watchdog::{Heartbeat, SUPERVISOR_TIMEOUT, Watchdog};
use roadpilot_telemetry_client::qpc::{self, Stamps};
use roadpilot_telemetry_client::{
    GameId, Placement, PluginState, ReceivedTelemetryFrame, TelemetryFrame, TruckState,
};
use std::collections::BTreeMap;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

const TICK: Duration = Duration::from_millis(40);
const CALIBRATION: &str = include_str!("fixtures/replay/calibration-2026-11-13.txt");
const STAGE_B: &str = include_str!("fixtures/replay/stage-b-2026-11-13.txt");

/// Counts the decisions the core logs, keyed like the recording (`epoch:backlog`, ...).
#[derive(Default)]
struct Decisions(Mutex<BTreeMap<String, u64>>);

impl LogObserver for Decisions {
    fn observe(&self, record: Observed) {
        if let Observed::Decision(entry) = record {
            let dto = serde_json::to_value(LogEntryDto::decision(&entry)).unwrap();
            let key = match dto["cause"].as_str() {
                Some(cause) => format!("{}:{cause}", dto["event"].as_str().unwrap()),
                None => dto["event"].as_str().unwrap().to_owned(),
            };
            *self.0.lock().unwrap().entry(key).or_default() += 1;
        }
    }
}

#[derive(Debug, PartialEq)]
struct Outcome {
    decisions: BTreeMap<String, u64>,
    frames_accepted: u64,
    frames_rejected: u64,
    frames_invalid: u64,
    ticks: u64,
    /// Frames whose QPC stamps evaluate to a valid timing (`produced_at` reconstructed).
    clock_valid: usize,
    clock_missing_or_invalid: usize,
    /// Largest `received_at - produced_at` over all frames with a valid timing.
    max_age_at_receive: Option<Duration>,
    /// Items the mailbox dropped (0 on the direct path).
    handoff_lost: u64,
}

fn game(fixture: &Fixture) -> GameId {
    match fixture.game.as_str() {
        "ets2" => GameId::Ets2,
        _ => GameId::Ats,
    }
}

/// Rebuilds the received frame of a record at `received_at`.
fn frame(fixture: &Fixture, r: &Record, received_at: Instant) -> ReceivedTelemetryFrame {
    let state = if r.paused {
        PluginState::Paused
    } else {
        PluginState::Running
    };
    let mut frame = TelemetryFrame::new(r.sequence, game(fixture), state);
    frame.session = Some(r.session);
    frame.simulation_time_us = r.simulation_time_us;
    frame.produced_qpc = r.produced_qpc;
    frame.sent_qpc = r.sent_qpc;
    frame.qpc_frequency = r.produced_qpc.and(fixture.qpc_frequency);
    frame.truck = Some(TruckState {
        speed_mps: r.speed_cm_s.map(|cm| cm as f32 / 100.0),
        parking_brake: r.parking_brake,
        ..TruckState::default()
    });
    // Freshness does not use the position; a fixed, valid one keeps the state usable.
    frame.placement = Some(Placement {
        x: 0.0,
        y: 0.0,
        z: 0.0,
        heading: 0.0,
        pitch: 0.0,
        roll: 0.0,
    });
    ReceivedTelemetryFrame {
        frame,
        dropped_fields: Vec::new(),
        received_at,
        received_qpc: r.received_qpc,
    }
}

/// `produced_at` from the QPC stamps: `received_at - (received - produced) / frequency`,
/// only for a timing that validates.
fn produced_at(fixture: &Fixture, f: &ReceivedTelemetryFrame) -> Option<Instant> {
    let timing = qpc::evaluate(
        Stamps {
            produced: f.frame.produced_qpc,
            sent: f.frame.sent_qpc,
            received: f.received_qpc,
            plugin_frequency: f.frame.qpc_frequency,
        },
        fixture.qpc_frequency,
    )
    .ok()?;
    f.received_at.checked_sub(timing.age_at_receive)
}

/// How frames reach the core.
#[derive(Clone, Copy, Debug)]
enum Path {
    /// Straight into `ControlCore::on_frame` at each tick (the baseline).
    Direct,
    /// Through the production mailbox, as the runtime does: the relay sends each digest when
    /// the frame is received; the control loop drains at each tick, except while `stalled`
    /// (µs since the recording started, start and length).
    Mailbox { stall: Option<(i64, i64)> },
}

fn replay(fixture: &Fixture) -> Outcome {
    replay_via(fixture, Path::Direct)
}

fn replay_via(fixture: &Fixture, path: Path) -> Outcome {
    let start = Instant::now();
    let at = |us: i64| start + Duration::from_micros(u64::try_from(us).expect("monoUs >= 0"));
    let decisions = Arc::new(Decisions::default());
    let log = ControlLog::with_observer(start, Some(decisions.clone()));
    let heartbeat = Heartbeat::new(start);
    let trip = Watchdog::new(heartbeat.clone(), SUPERVISOR_TIMEOUT).flag();
    let mut core = ControlCore::dry_run(
        CoreConfig::default(),
        Box::new(NeutralRequests),
        log,
        heartbeat,
        trip,
        start,
    );

    let mut clock_valid = 0;
    let mut clock_missing_or_invalid = 0;
    let mut max_age_at_receive: Option<Duration> = None;
    let mut ticks = 0u64;
    let mut next_tick = start + TICK;
    let mut records = fixture.records.iter().peekable();
    let end = at(fixture.records.last().expect("frames").received_us) + TICK * 5;
    let (mut tx, mut rx) = mailbox::mailbox();
    let mut lost = 0u64;
    while next_tick <= end {
        // Everything received up to this tick, in receive order.
        while let Some(r) = records.next_if(|r| at(r.received_us) <= next_tick) {
            let received_at = at(r.received_us);
            let f = frame(fixture, r, received_at);
            match produced_at(fixture, &f) {
                Some(produced) => {
                    clock_valid += 1;
                    let age = received_at - produced;
                    max_age_at_receive = Some(max_age_at_receive.map_or(age, |m| m.max(age)));
                }
                None => clock_missing_or_invalid += 1,
            }
            match path {
                Path::Direct => {
                    core.on_frame(&f, received_at);
                }
                Path::Mailbox { .. } => {
                    tx.send_frame(FrameDigest::of(&f), received_at);
                }
            }
        }
        if let Path::Mailbox { stall } = path {
            let since_start = (next_tick - start).as_micros() as i64;
            if stall.is_some_and(|(from, len)| (from..from + len).contains(&since_start)) {
                // The control thread is stalled: no drain and no tick; the relay keeps sending.
                next_tick += TICK;
                continue;
            }
            rx.drain(|received| match received {
                Received::Lost { count } => {
                    lost += count;
                    core.note_handoff_loss(next_tick);
                }
                Received::Delivery(Delivery::Frame {
                    digest,
                    observed_at,
                }) => {
                    core.on_digest(&digest, observed_at);
                }
                Received::Delivery(_) => {}
            });
        }
        core.tick(next_tick);
        ticks += 1;
        next_tick += TICK;
    }
    core.shutdown(end);
    let stats = core.stats();
    drop(core);
    let decisions = decisions.0.lock().unwrap().clone();
    Outcome {
        decisions,
        frames_accepted: stats.frames_accepted,
        frames_rejected: stats.frames_rejected,
        frames_invalid: stats.frames_invalid,
        ticks,
        clock_valid,
        clock_missing_or_invalid,
        max_age_at_receive,
        handoff_lost: lost,
    }
}

fn print(name: &str, outcome: &Outcome) {
    println!("{name}: {outcome:?}");
}

// ---- baseline: the current logic reproduces the recorded control runs ----

#[test]
fn calibration_drive_baseline_reproduces_the_recorded_decisions() {
    let fixture = fixture::parse(CALIBRATION);
    assert_eq!(fixture.records.len(), 46_389);
    let outcome = replay(&fixture);
    print("calibration", &outcome);
    assert_eq!(
        outcome.decisions, fixture.expect,
        "decisions of the recorded run"
    );
    assert_eq!(outcome.decisions["epoch:backlog"], 33);
    // Every frame carries a valid QPC timing; the reconstruction matches the recorder.
    assert_eq!(outcome.clock_valid, 46_389);
    assert_eq!(outcome.clock_missing_or_invalid, 0);
    let max_age = outcome.max_age_at_receive.unwrap();
    assert!(
        max_age > Duration::from_millis(23) && max_age < Duration::from_millis(24),
        "{max_age:?}"
    );
    assert_eq!(outcome.frames_invalid, 0);
}

#[test]
fn stage_b_baseline_reproduces_the_recorded_decisions() {
    let fixture = fixture::parse(STAGE_B);
    assert_eq!(fixture.records.len(), 36_290);
    let outcome = replay(&fixture);
    print("stage B", &outcome);
    assert_eq!(
        outcome.decisions, fixture.expect,
        "decisions of the recorded run"
    );
    assert_eq!(outcome.decisions["epoch:backlog"], 58);
    // The plugin of Stage B had no QPC stamps.
    assert_eq!(outcome.clock_valid, 0);
    assert_eq!(outcome.clock_missing_or_invalid, 36_290);
}

#[test]
fn replays_are_deterministic() {
    for text in [CALIBRATION, STAGE_B] {
        let fixture = fixture::parse(text);
        assert_eq!(replay(&fixture), replay(&fixture));
    }
}

#[test]
fn fixtures_round_trip_exactly() {
    for text in [CALIBRATION, STAGE_B] {
        let fixture = fixture::parse(text);
        assert_eq!(fixture::parse(&fixture::write(&fixture)), fixture);
    }
}

// ---- the full local recordings ----

#[test]
#[ignore = "needs the local recordings; set ROADPILOT_REPLAY_JSONL"]
fn full_recordings_replay_like_their_fixtures() {
    let paths = std::env::var("ROADPILOT_REPLAY_JSONL").expect("ROADPILOT_REPLAY_JSONL");
    for path in paths.split(';').filter(|p| !p.is_empty()) {
        let source = std::path::Path::new(path)
            .file_name()
            .unwrap()
            .to_string_lossy()
            .into_owned();
        let file = std::fs::File::open(path).expect("open the recording");
        let full = fixture::from_recording(std::io::BufReader::new(file), &source);
        let outcome = replay(&full);
        print(&source, &outcome);
        assert_eq!(outcome.decisions, full.expect, "{source}");
        for text in [CALIBRATION, STAGE_B] {
            let compact = fixture::parse(text);
            if compact.source == source {
                assert_eq!(
                    replay(&compact),
                    outcome,
                    "{source}: fixture replays like the recording"
                );
            }
        }
    }
}

// ---- the production mailbox ----

#[test]
fn the_mailbox_path_replays_exactly_like_the_baseline() {
    for text in [CALIBRATION, STAGE_B] {
        let fixture = fixture::parse(text);
        let direct = replay(&fixture);
        let via_mailbox = replay_via(&fixture, Path::Mailbox { stall: None });
        print(&fixture.source, &via_mailbox);
        assert_eq!(via_mailbox, direct, "{}", fixture.source);
        assert_eq!(via_mailbox.handoff_lost, 0);
        assert!(!via_mailbox.decisions.contains_key("epoch:handoffOverflow"));
    }
}

#[test]
fn a_control_thread_stalled_for_500_ms_across_a_real_pause_loses_no_event() {
    let fixture = fixture::parse(CALIBRATION);
    // The pause at 14:40:29 after the test-track drive: the first running-to-paused change
    // after the drive started (records ordered by receive time).
    let records = &fixture.records;
    let drive_start = records
        .iter()
        .position(|r| r.parking_brake == Some(false) && r.speed_cm_s.unwrap_or(0) > 100)
        .unwrap();
    let pause = (drive_start..records.len())
        .find(|&i| records[i].paused && !records[i - 1].paused)
        .unwrap();
    let pause_us = records[pause].received_us;
    // Stall the control thread from 250 ms before to 250 ms after the pause began.
    let stall = (pause_us - 250_000, 500_000);
    let frames_in_stall = records
        .iter()
        .filter(|r| (stall.0..stall.0 + stall.1).contains(&r.received_us))
        .count();
    assert!(
        frames_in_stall > 12,
        "the stall overflows the ordinary quota: {frames_in_stall}"
    );

    let baseline = replay(&fixture);
    let stalled = replay_via(&fixture, Path::Mailbox { stall: Some(stall) });
    print("calibration, stalled 500 ms", &stalled);
    // The loss is reported, once, and answered with a new epoch.
    assert!(stalled.handoff_lost > 0);
    assert_eq!(stalled.decisions["epoch:handoffOverflow"], 1);
    // No critical event is lost: the pause inside the stall, and every other pause and the
    // first frame, are seen exactly as without the stall.
    for key in ["epoch:paused", "epoch:firstFrame", "shutdown"] {
        assert_eq!(stalled.decisions[key], baseline.decisions[key], "{key}");
    }
    // Losing frames can only add epochs, never remove one: the dropped frames leave a
    // receive gap over the age limit, which is reported as one more gap epoch.
    assert_eq!(
        stalled.decisions["epoch:gap"],
        baseline.decisions["epoch:gap"] + 1
    );
    assert_eq!(stalled.frames_invalid, 0);
}
