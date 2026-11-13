//! Converts a diagnostic recording (`ROADPILOT_TELEMETRY_RECORD`, JSON Lines) into a compact
//! replay fixture for `tests/replay.rs`. The format is described in
//! `tests/replay_support/fixture.rs`. Reads only; never overwrites an existing fixture.
//!
//! Usage: `cargo run --example replay_fixture -- <recording.jsonl> <fixture.txt>`

#[path = "../tests/replay_support/fixture.rs"]
mod fixture;

use std::io::BufReader;
use std::path::Path;

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let (Some(input), Some(output)) = (args.get(1), args.get(2)) else {
        eprintln!("usage: replay_fixture <recording.jsonl> <fixture.txt>");
        std::process::exit(2);
    };
    let source = Path::new(input)
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    let file = std::fs::File::open(input).expect("open the recording");
    let fixture = fixture::from_recording(BufReader::new(file), &source);
    let text = fixture::write(&fixture);
    // The fixture must replay exactly what the recording held.
    assert_eq!(
        fixture::parse(&text).records,
        fixture.records,
        "fixture round trip"
    );
    let mut out = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(output)
        .expect("create the fixture (it must not exist yet)");
    std::io::Write::write_all(&mut out, text.as_bytes()).expect("write the fixture");
    println!(
        "{}: {} frames, QPC {}, expected decisions {:?}, {} bytes",
        output,
        fixture.records.len(),
        fixture
            .qpc_frequency
            .map_or("absent".into(), |f| format!("{f} Hz")),
        fixture.expect,
        text.len()
    );
}
