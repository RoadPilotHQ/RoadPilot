//! Telemetry feeder for timing measurements of the running application.
//!
//! Connects to the application's telemetry pipe as the game plugin would and writes schema 2
//! frames at 60 Hz, based on the shared test fixture, at a speed below the control test speed
//! cap so that control can be armed in dry run. It writes only to the read-only *telemetry*
//! pipe; it never touches the input plugin.
//!
//! Usage: `cargo run --release --example telemetry_feeder -- [seconds] [speed_mps]`
//! Defaults: 300 seconds, 3.0 m/s. The application must be running.

#[cfg(not(windows))]
fn main() {
    eprintln!("telemetry_feeder: the telemetry pipe exists on Windows only");
}

#[cfg(windows)]
fn main() {
    use roadpilot_telemetry_client::named_pipe::PIPE_NAME;
    use serde_json::Value;
    use std::io::Write;
    use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

    const FIXTURE: &str = include_str!("../tests/fixtures/frame-v2-full.json");
    const PERIOD: Duration = Duration::from_micros(16_667);

    let args: Vec<String> = std::env::args().collect();
    let seconds: u64 = args.get(1).and_then(|s| s.parse().ok()).unwrap_or(300);
    let speed: f64 = args.get(2).and_then(|s| s.parse().ok()).unwrap_or(3.0);

    let mut pipe = loop {
        match std::fs::OpenOptions::new().write(true).open(PIPE_NAME) {
            Ok(pipe) => break pipe,
            Err(error) => {
                eprintln!("waiting for the application's telemetry pipe {PIPE_NAME}: {error}");
                std::thread::sleep(Duration::from_secs(1));
            }
        }
    };

    let mut frame: Value = serde_json::from_str(FIXTURE).expect("fixture");
    let session = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64 % 1_000_000_000_000)
        .unwrap_or(1)
        .max(1);
    frame["session"] = session.into();
    frame["pluginState"] = "running".into();
    frame["truck"]["speedMps"] = speed.into();

    let start = Instant::now();
    let end = start + Duration::from_secs(seconds);
    let mut next = start;
    let mut sequence = 0u64;
    println!("telemetry_feeder: session {session}, 60 Hz for {seconds} s at {speed} m/s");
    while Instant::now() < end {
        sequence += 1;
        frame["sequence"] = sequence.into();
        frame["simulationTimeUs"] = (1_000_000 + start.elapsed().as_micros() as u64).into();
        let payload = serde_json::to_vec(&frame).expect("serialize");
        let length = (payload.len() as u32).to_le_bytes();
        if pipe
            .write_all(&length)
            .and_then(|()| pipe.write_all(&payload))
            .is_err()
        {
            eprintln!("telemetry pipe closed after {sequence} frames");
            return;
        }
        next += PERIOD;
        let now = Instant::now();
        if next > now {
            std::thread::sleep(next - now);
        } else {
            next = now;
        }
    }
    println!("telemetry_feeder: sent {sequence} frames");
}
