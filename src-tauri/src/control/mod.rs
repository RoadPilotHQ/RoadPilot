//! Foundation for autonomous driving control (Phase 4.4).
//!
//! **Dry-run only.** Nothing in this module sends input to the game. Commands are encoded and
//! logged, then discarded by the dry-run sink; the input plugin's pipe is never opened. Live
//! transmission requires a separate, explicit authorization in a future phase and is not
//! selectable by any preference or configuration. See [`sink`].
//!
//! Read side:
//!
//! * [`vehicle`]: the validated vehicle state a controller may use.
//! * [`freshness`]: freshness and continuity checks that decide whether that state may be
//!   acted on, and an epoch counter that makes a reconnect, a pause or a restart impossible
//!   to overlook.
//!
//! Decision and write side:
//!
//! * [`supervisor`]: the Disabled / Armed / Active / Fault state machine, the only authority
//!   that decides whether control output is permitted. It consumes the assessment of the
//!   freshness monitor and explicit commands, and knows nothing about transport, UI or input.
//! * [`command`]: bounded, validated control commands that cannot be constructed outside their
//!   limits, the steering rate limiter, and a generator that produces commands only while the
//!   supervisor permits output.
//! * [`protocol`]: encoder for the RoadPilot Input pipe protocol v2, byte-compatible with
//!   RoadPilot-SDK. It accepts only validated commands and the explicit disarm message.
//!
//! Sender (Step 5):
//!
//! * [`sink`]: the sealed destination of encoded messages; dry-run is the only one.
//! * [`schedule`]: the monotonic 40 ms tick schedule and its timing monitoring.
//! * [`watchdog`]: independent detection of a stalled supervisor loop.
//! * [`log`]: the bounded log of decisions, timing and encoded messages.
//! * [`mailbox`]: the bounded, ordered hand-off of telemetry from the relay to the control loop.
//! * [`timing`]: tick timing histograms (lateness, interval, processing, command interval).
//! * [`timer`]: what wakes the loop at each deadline: tokio's timer (tests) or a precise
//!   timer thread (application).
//! * [`sender`]: the deterministic core that ties everything together.
//! * [`runtime`]: the async drivers that feed the core from the telemetry client's frame
//!   channel (a second receiver on the same channel, never a second pipe server) and from
//!   the 40 ms timer.
//!
//! Control consumes the raw frames of the telemetry client at full rate, not the 10 Hz
//! dashboard engine, which drops the session, sequence and simulation time.

pub mod command;
pub mod freshness;
pub mod log;
pub mod mailbox;
pub mod protocol;
pub mod runtime;
pub mod schedule;
pub mod sender;
pub mod sink;
pub mod status;
pub mod supervisor;
pub mod timer;
pub mod timing;
pub mod vehicle;
pub mod watchdog;

/// Structural proof that the control code cannot reach the input plugin, a file, a pipe or the
/// network. It scans the code (not the comments) of every control source file.
#[cfg(test)]
mod dry_run_proof {
    /// Every module of this directory. The test below keeps this list complete.
    const SOURCES: &[(&str, &str)] = &[
        ("command", include_str!("command.rs")),
        ("freshness", include_str!("freshness.rs")),
        ("log", include_str!("log.rs")),
        ("mailbox", include_str!("mailbox.rs")),
        ("mod", include_str!("mod.rs")),
        ("protocol", include_str!("protocol.rs")),
        ("runtime", include_str!("runtime.rs")),
        ("schedule", include_str!("schedule.rs")),
        ("sender", include_str!("sender.rs")),
        ("sink", include_str!("sink.rs")),
        ("status", include_str!("status.rs")),
        ("supervisor", include_str!("supervisor.rs")),
        ("timer", include_str!("timer.rs")),
        ("timing", include_str!("timing.rs")),
        ("vehicle", include_str!("vehicle.rs")),
        ("watchdog", include_str!("watchdog.rs")),
    ];

    /// Identifiers that would let code open the input plugin's pipe or do any other I/O. Each
    /// is assembled from parts so that this list does not match itself.
    fn forbidden() -> Vec<String> {
        [
            ["road", "pilot-input"].concat(), // the input plugin's pipe name
            ["Client", "Options"].concat(),   // tokio named pipe client
            ["named", "_pipe"].concat(),      // the telemetry client's pipe module
            ["windows", "_sys"].concat(),     // raw Win32 access
            ["Create", "File"].concat(),
            ["Open", "Options"].concat(),
            ["std::", "fs"].concat(),
            ["std::", "net"].concat(),
            ["std::", "process"].concat(),
            ["tokio::", "net"].concat(),
            ["tokio::", "fs"].concat(),
            ["tokio::", "process"].concat(),
            ["Tcp", "Stream"].concat(),
            ["Unix", "Stream"].concat(),
        ]
        .into()
    }

    fn code_lines(source: &str) -> impl Iterator<Item = (usize, &str)> {
        source
            .lines()
            .enumerate()
            .filter(|(_, line)| !line.trim_start().starts_with("//"))
    }

    #[test]
    fn no_control_source_can_open_the_input_pipe_or_do_any_io() {
        let forbidden = forbidden();
        assert!(forbidden.len() >= 10);
        for (name, source) in SOURCES {
            for (number, line) in code_lines(source) {
                for needle in &forbidden {
                    assert!(
                        !line.contains(needle.as_str()),
                        "control/{name}.rs:{} mentions `{needle}`: {line}",
                        number + 1
                    );
                }
            }
        }
    }

    #[test]
    fn the_scan_covers_every_declared_control_module() {
        let declared: Vec<&str> = code_lines(include_str!("mod.rs"))
            .filter_map(|(_, line)| line.strip_prefix("pub mod "))
            .filter_map(|rest| rest.strip_suffix(';'))
            .collect();
        assert!(declared.len() >= 15, "{declared:?}");
        for module in &declared {
            assert!(
                SOURCES.iter().any(|(name, _)| name == module),
                "control/{module}.rs is not covered by the dry-run proof"
            );
        }
        assert!(SOURCES.iter().any(|(name, _)| *name == "mod"));
    }

    #[test]
    fn the_scan_detects_what_it_is_looking_for() {
        // Guards the guard: a line that opens the input pipe must be caught.
        let bad = format!("let p = \"{}-v1\";", ["road", "pilot-input"].concat());
        assert!(
            forbidden()
                .iter()
                .any(|needle| bad.contains(needle.as_str()))
        );
        let io = format!("use {}::File;", ["std::", "fs"].concat());
        assert!(
            forbidden()
                .iter()
                .any(|needle| io.contains(needle.as_str()))
        );
    }

    #[test]
    fn nothing_but_the_telemetry_feed_type_is_imported_from_outside_the_control_module() {
        // The runtime is the only file that may name the telemetry module, and only its
        // frame feed; the rest of the control code is independent of the transport.
        let needle = ["crate::", "telemetry"].concat();
        for (name, source) in SOURCES {
            for (number, line) in code_lines(source) {
                if line.contains(needle.as_str()) {
                    assert_eq!(
                        *name,
                        "runtime",
                        "control/{name}.rs:{} depends on the telemetry module: {line}",
                        number + 1
                    );
                }
            }
        }
    }
}
