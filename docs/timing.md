# Control tick timing

The control sender ticks every 40 ms. The input protocol requires a command refresh at least every 50 ms, and the safety limits are 100 ms for tick gaps and the watchdog. This page records how the tick timing was measured on Windows, what was changed and the result. Everything here applies to dry run: commands are encoded and discarded, never transmitted.

## Problem

The first measurements (Phase 4.4) ran the sender on tokio's timer on the shared Tauri runtime. On Windows tokio waits in whole milliseconds through I/O completion ports, and the system ends those waits on its default 15.6 ms clock interrupt:

- Wake-up lateness: median 8.2 ms, 95th percentile 15.3 ms, maximum 25.2 ms. 40 % of ticks were "late" (over 10 ms).
- Tick intervals: median 45.7 ms, maximum 55.3 ms. About 1 % exceeded the 50 ms refresh requirement.

A second effect appeared under CPU load: threads at normal priority were delayed by tens of milliseconds. With a 16-thread load at normal priority, 17 % of the 40 ms intervals exceeded 50 ms. That measurement ran while a full-screen game was also active (see "Limits" below).

## Change

- **Precise timer** (`src-tauri/src/control/timer.rs`): a dedicated timer thread sleeps with `std::thread::sleep`, which on Windows uses a high-resolution waitable timer. It wakes the control loop through a `watch` channel. It never resolves before the deadline, does not busy-wait and changes no global timer setting. Deterministic tests keep tokio's timer on the paused clock.
- **Dedicated control thread** (`src-tauri/src/control_app.rs`): the sender task runs on its own single-threaded tokio runtime, separate from the dashboard's thread pool. The relay and the watchdog stay on the shared runtime, so the watchdog stays independent of the thread it watches.
- **Elevated thread priority** (`src-tauri/src/platform.rs`): the control thread and the timer thread run at `THREAD_PRIORITY_HIGHEST` within the normal priority class. Both sleep almost all the time. The process priority class and the system timer resolution are unchanged.
- **No blocking on normal-priority threads** (`src-tauri/src/control/runtime.rs`): during development, a status reader of normal priority that was preempted while holding the status lock delayed the elevated control thread (priority inversion). The sender task is now woken only by its timer, takes telemetry and commands from lock-free queues with `try_recv`, and publishes its status at a tick only if no reader holds it at that moment. A relay task on the shared runtime forwards telemetry frames into the queue. A test holds the status for 300 ms and checks that ticks keep encoding commands.
- The status reports the timer (`precise` or `tokio`) and whether both threads run elevated. If the timer thread cannot start, the loop falls back to tokio's timer and the status shows it.

The schedule itself is unchanged: fixed 40 ms grid on the monotonic clock, missed deadlines skipped and never replayed, a gap over 100 ms is a safety event.

## Measurements (2026-11-13)

**Machine:** Windows 11 Home, AMD Ryzen 7 6800HS (16 logical CPUs), release build.
**Desktop:** no game, Steam closed, WSL shut down. The runs started only after the total CPU load stayed at or below 8 % for 20 seconds.
**Setup:** the production control slot with telemetry arriving at about 60 Hz, supervisor Active in dry run, so every tick generates and encodes a command.
**Acceptance criterion:** no tick interval and no command refresh interval above 50 ms, no timing fault, no watchdog trip.

| Run                                     | Ticks | Interval p99 | p99.9   | Max     | > 45 ms | > 50 ms | Lateness max | Result |
| --------------------------------------- | ----- | ------------ | ------- | ------- | ------- | ------- | ------------ | ------ |
| Idle, 60 s                              | 1504  | 40.5 ms      | 41.6 ms | 45.3 ms | 1       | 0       | 5.8 ms       | pass   |
| 16 busy threads (`cpu_load`), 60 s      | 1504  | 40.4 ms      | 40.4 ms | 40.4 ms | 0       | 0       | 0.6 ms       | pass   |
| Idle, 20 start/stop cycles of 5 s each  | 2573  | ≤ 40.6 ms    | —       | 40.7 ms | 0       | 0       | —            | pass   |

In all runs the command refresh intervals matched the tick intervals, and there were no late ticks, missed deadlines, timing faults or watchdog trips. Processing per tick stayed under 0.35 ms.

The idle desktop shows the only outlier (45.3 ms, one tick in 1500). Under full load the timing is tighter, most likely because the cores never enter deep idle states. Every start/stop cycle ended with an orderly shutdown.

## Reproducing

```
cargo test --release --lib timing_acceptance -- --ignored --nocapture
cargo test --release --lib timing_start_stop -- --ignored --nocapture
cargo run --release --example cpu_load -- 16 75
```

Run `cpu_load` in a second terminal, started a few seconds before `timing_acceptance`. `ROADPILOT_TIMING_SECONDS` (default 60) and `ROADPILOT_TIMING_CYCLES` (default 20) set the duration. For the running application, `ROADPILOT_TIMING_REPORT=<file>` writes the timing summary at exit, and the `telemetry_feeder` example supplies 60 Hz frames through the telemetry pipe.

Record whether the machine was otherwise idle: a game, a virus scan or a WSL virtual machine in the background changes the results.

## Limits

- The figures for normal priority under load (17 % over 50 ms) come from a run while a full-screen game was active. They were not repeated on the quiet desktop. They show the direction of the effect, not its exact size.
- One machine only. Other CPUs, power plans and laptops on battery may behave differently.
- No measurement with ATS or ETS2 running. A game competes for CPU time and may change the timer behaviour; this must be measured before any live transmission.
- The 10 ms "late" threshold has not been recalibrated. With the precise timer no tick came close to it.
