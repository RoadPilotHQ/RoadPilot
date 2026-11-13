//! Compact replay fixtures made from diagnostic recordings (`ROADPILOT_TELEMETRY_RECORD`).
//!
//! A recording holds every frame with its full content (~3 KB per frame). Replaying the
//! freshness and control logic needs only the timing, the identity, the plugin state and a
//! few vehicle values, so a fixture keeps exactly those, delta-encoded as text:
//!
//! ```text
//! roadpilot-replay 1
//! source <recording file name>
//! game ats|ets2
//! qpc-frequency <hz>|-
//! expect <decision key> <count>          (decisions of the recorded control run)
//! f <dRecvUs> <session|=> <seq|+d> <r|p> <dSimUs|-> <dProducedQpc|-> <sent-produced|-> <recv-sent|-> <speedCmPerS|-> <parkingBrake 1|0|->
//! ```
//!
//! `dRecvUs` is the receive time (`monoUs`) relative to the previous frame (the first is
//! absolute); `=` repeats the session; `+d` advances the sequence (an absolute sequence
//! follows a session change); `dSimUs` and `dProducedQpc` are relative to the previous frame
//! that had them. Speed is rounded to cm/s; the placement is not kept (freshness does not
//! use it, so the replay uses a fixed one).
//!
//! Shared by `examples/replay_fixture.rs` (writes fixtures) and `tests/replay.rs` (reads them,
//! or converts a full recording on the fly).

#![allow(dead_code)]

use serde_json::Value;
use std::collections::BTreeMap;
use std::fmt::Write as _;
use std::io::BufRead;

pub const FORMAT: &str = "roadpilot-replay 1";

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Record {
    /// Receive time, µs since the recorder started (`monoUs`).
    pub received_us: i64,
    pub session: u64,
    pub sequence: u64,
    pub paused: bool,
    pub simulation_time_us: Option<u64>,
    pub produced_qpc: Option<u64>,
    pub sent_qpc: Option<u64>,
    pub received_qpc: Option<u64>,
    pub speed_cm_s: Option<i64>,
    pub parking_brake: Option<bool>,
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct Fixture {
    pub source: String,
    pub game: String,
    pub qpc_frequency: Option<u64>,
    /// Decision counts of the recorded control run, e.g. `epoch:backlog` → 33.
    pub expect: BTreeMap<String, u64>,
    pub records: Vec<Record>,
}

fn decision_key(entry: &Value) -> String {
    let event = entry["event"].as_str().unwrap_or("?");
    match entry["cause"].as_str() {
        Some(cause) => format!("{event}:{cause}"),
        None => event.to_owned(),
    }
}

/// Converts a recording (JSON Lines) into a fixture.
pub fn from_recording(reader: impl BufRead, source: &str) -> Fixture {
    let mut fixture = Fixture {
        source: source.to_owned(),
        ..Fixture::default()
    };
    for line in reader.lines() {
        let line = line.expect("readable recording");
        let o: Value = serde_json::from_str(&line).expect("one JSON object per line");
        match o["type"].as_str() {
            Some("frame") => {
                let f = &o["frame"];
                if fixture.game.is_empty() {
                    fixture.game = f["game"].as_str().unwrap_or("ats").to_owned();
                }
                if let Some(hz) = f["qpcFrequency"].as_u64() {
                    match fixture.qpc_frequency {
                        None => fixture.qpc_frequency = Some(hz),
                        Some(known) => assert_eq!(known, hz, "one QPC frequency per recording"),
                    }
                }
                fixture.records.push(Record {
                    received_us: o["monoUs"].as_i64().expect("monoUs"),
                    session: o["session"].as_u64().expect("session"),
                    sequence: o["sequence"].as_u64().expect("sequence"),
                    paused: o["pluginState"] == "paused",
                    simulation_time_us: o["simulationTimeUs"].as_u64(),
                    produced_qpc: f["producedQpc"].as_u64(),
                    sent_qpc: f["sentQpc"].as_u64(),
                    received_qpc: o["receivedQpc"].as_u64(),
                    speed_cm_s: f["truck"]["speedMps"]
                        .as_f64()
                        .map(|v| (v * 100.0).round() as i64),
                    parking_brake: f["truck"]["parkingBrake"].as_bool(),
                });
            }
            Some("control") if o["category"] == "decision" => {
                *fixture.expect.entry(decision_key(&o["entry"])).or_default() += 1;
            }
            _ => {}
        }
    }
    fixture
}

fn opt<T: std::fmt::Display>(v: Option<T>) -> String {
    v.map_or_else(|| "-".to_owned(), |v| v.to_string())
}

pub fn write(fixture: &Fixture) -> String {
    let mut out = String::new();
    writeln!(out, "{FORMAT}").unwrap();
    writeln!(out, "source {}", fixture.source).unwrap();
    writeln!(out, "game {}", fixture.game).unwrap();
    writeln!(out, "qpc-frequency {}", opt(fixture.qpc_frequency)).unwrap();
    for (key, count) in &fixture.expect {
        writeln!(out, "expect {key} {count}").unwrap();
    }
    let mut prev: Option<Record> = None;
    let mut last_sim: Option<u64> = None;
    let mut last_produced: Option<u64> = None;
    for r in &fixture.records {
        let d_recv = r.received_us - prev.map_or(0, |p| p.received_us);
        let same_session = prev.is_some_and(|p| p.session == r.session);
        let session = if same_session {
            "=".to_owned()
        } else {
            r.session.to_string()
        };
        let sequence = if same_session {
            format!("+{}", r.sequence - prev.unwrap().sequence)
        } else {
            r.sequence.to_string()
        };
        let sim = r
            .simulation_time_us
            .map(|s| (s as i64 - last_sim.unwrap_or(0) as i64).to_string())
            .unwrap_or_else(|| "-".into());
        let produced = r
            .produced_qpc
            .map(|p| (p as i64 - last_produced.unwrap_or(0) as i64).to_string())
            .unwrap_or_else(|| "-".into());
        let sent = match (r.produced_qpc, r.sent_qpc) {
            (Some(p), Some(s)) => (s as i64 - p as i64).to_string(),
            _ => "-".into(),
        };
        let received = match (r.sent_qpc, r.received_qpc) {
            (Some(s), Some(v)) => (v as i64 - s as i64).to_string(),
            _ => "-".into(),
        };
        let pb = r.parking_brake.map_or("-", |b| if b { "1" } else { "0" });
        writeln!(
            out,
            "f {d_recv} {session} {sequence} {} {sim} {produced} {sent} {received} {} {pb}",
            if r.paused { "p" } else { "r" },
            opt(r.speed_cm_s)
        )
        .unwrap();
        if r.simulation_time_us.is_some() {
            last_sim = r.simulation_time_us;
        }
        if r.produced_qpc.is_some() {
            last_produced = r.produced_qpc;
        }
        prev = Some(*r);
    }
    out
}

fn field<'a>(parts: &mut impl Iterator<Item = &'a str>, line: usize) -> &'a str {
    parts
        .next()
        .unwrap_or_else(|| panic!("fixture line {line}: missing field"))
}

fn num(s: &str, line: usize) -> i64 {
    s.parse()
        .unwrap_or_else(|_| panic!("fixture line {line}: bad number {s:?}"))
}

fn opt_num(s: &str, line: usize) -> Option<i64> {
    (s != "-").then(|| num(s, line))
}

pub fn parse(text: &str) -> Fixture {
    let mut lines = text.lines().map(|l| l.trim_end_matches('\r'));
    assert_eq!(lines.next(), Some(FORMAT), "fixture format");
    let mut fixture = Fixture::default();
    let mut prev: Option<Record> = None;
    let mut last_sim: Option<u64> = None;
    let mut last_produced: Option<u64> = None;
    for (index, line) in lines.enumerate() {
        let n = index + 2;
        let mut parts = line.split(' ');
        match field(&mut parts, n) {
            "source" => fixture.source = field(&mut parts, n).to_owned(),
            "game" => fixture.game = field(&mut parts, n).to_owned(),
            "qpc-frequency" => {
                fixture.qpc_frequency = opt_num(field(&mut parts, n), n).map(|v| v as u64)
            }
            "expect" => {
                let key = field(&mut parts, n).to_owned();
                fixture
                    .expect
                    .insert(key, num(field(&mut parts, n), n) as u64);
            }
            "f" => {
                let received_us = prev.map_or(0, |p| p.received_us) + num(field(&mut parts, n), n);
                let session_field = field(&mut parts, n);
                let session = if session_field == "=" {
                    prev.expect("a session before '='").session
                } else {
                    num(session_field, n) as u64
                };
                let sequence_field = field(&mut parts, n);
                let sequence = match sequence_field.strip_prefix('+') {
                    Some(d) => prev.expect("a sequence before '+'").sequence + num(d, n) as u64,
                    None => num(sequence_field, n) as u64,
                };
                let paused = match field(&mut parts, n) {
                    "p" => true,
                    "r" => false,
                    other => panic!("fixture line {n}: bad state {other:?}"),
                };
                let simulation_time_us = opt_num(field(&mut parts, n), n)
                    .map(|d| (last_sim.unwrap_or(0) as i64 + d) as u64);
                let produced_qpc = opt_num(field(&mut parts, n), n)
                    .map(|d| (last_produced.unwrap_or(0) as i64 + d) as u64);
                let sent_qpc = opt_num(field(&mut parts, n), n)
                    .and_then(|d| produced_qpc.map(|p| (p as i64 + d) as u64));
                let received_qpc = opt_num(field(&mut parts, n), n)
                    .and_then(|d| sent_qpc.map(|s| (s as i64 + d) as u64));
                let speed_cm_s = opt_num(field(&mut parts, n), n);
                let parking_brake = match field(&mut parts, n) {
                    "1" => Some(true),
                    "0" => Some(false),
                    _ => None,
                };
                let record = Record {
                    received_us,
                    session,
                    sequence,
                    paused,
                    simulation_time_us,
                    produced_qpc,
                    sent_qpc,
                    received_qpc,
                    speed_cm_s,
                    parking_brake,
                };
                if simulation_time_us.is_some() {
                    last_sim = simulation_time_us;
                }
                if produced_qpc.is_some() {
                    last_produced = produced_qpc;
                }
                fixture.records.push(record);
                prev = Some(record);
            }
            other => panic!("fixture line {n}: unknown record {other:?}"),
        }
    }
    fixture
}
