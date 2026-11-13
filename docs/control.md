# Control pipeline (dry run)

This page describes the control foundation built in Phase 4.4: how RoadPilot turns telemetry into supervised, bounded control commands, and why none of them reaches the game yet.

## Current status

- **Dry run is the only operating mode.** Commands are generated, bounded and encoded in the exact byte format of the input plugin, then logged and discarded. The input plugin's pipe (`roadpilot-input-v1`) is never opened. There is no setting, preference, configuration flag or command that enables transmission; enabling it requires a separate, explicitly authorized development phase.
- **Schema 2 live telemetry is not yet verified in gameplay.** Only the schema 1 plugin (speed, RPM, gear) has been live-tested, in ATS. All control behaviour below is verified by automated tests with simulated frames.
- **The input plugin has not been tested in-game.** Whether ATS or ETS2 accept its axes, the steering sign and range, and the interaction with manual controls are unverified.
- **No autonomous steering or speed controller exists.** The pipeline asks a request source for values; the only source in the application is a neutral one (no steering, no throttle, no brake).

## Data flow

```
telemetry plugin --pipe--> telemetry engine (one pipe server)
                              |  watch channel (raw frames)
                              |------> dashboard (10 Hz, normalized)
                              '------> control runtime (every frame)
                                         freshness monitor -> supervisor
                                         request source -> generator (limits, rate limit)
                                         encoder (protocol v2) -> dry-run sink (discards)
                                         bounded log, status -> UI
```

- Control reads a second receiver on the telemetry engine's own frame channel. There is exactly one telemetry pipe server. When the engine restarts its server and replaces the channel, control re-attaches and logs the change.
- **Telemetry mailbox** (`control/mailbox.rs`). The relay turns every frame into a fixed-size digest (identity, plugin state, vehicle state or why it is invalid, receive time) and hands it to the control thread through one bounded, ordered queue:
  - **Bounded:** 16 places of `Copy` items; the control thread takes at most 16 per tick, never waits (`try_recv`), and never frees a frame.
  - **Critical items cannot be crowded out:** ordinary frames may occupy at most 12 places; 4 are reserved for critical items: the first frame, every change of session, game, pause state or validity, and feed lost / restored. One FIFO keeps everything in send order, so an older frame never follows a newer one.
  - **Every loss is reported where it happened:** each item carries the count of items dropped before it; the control loop starts a new freshness epoch (`handoffOverflow`) at that point, so the state must settle again and the supervisor reacts through its existing rules (Armed disarms, Active faults). A loss with no item after it is reported once the queue is found empty.
  - Disconnects and the end of the game have no item of their own (the pipe gives no signal); they are detected from time at every tick and cannot be lost in the queue.
  - Replay of both recorded drives through the mailbox gives exactly the decisions of the direct path. With the control thread stalled for 500 ms across a real pause, 8 frames are dropped, one `handoffOverflow` epoch and one extra gap epoch follow, and the pause is still detected.
- **Latency diagnosis, shadow mode** (R6, `control/latency.rs`). Four measures, each classified per sample as normal, delayed, critical or unusable (no valid QPC timing, never normal):

  | Measure                                                       | Delayed  | Critical | Calibration drive        |
  | ------------------------------------------------------------- | -------- | -------- | ------------------------ |
  | Plugin processing (`sent − produced`, includes ~16 ms pacing) | > 20 ms  | > 50 ms  | 1 delayed (max 23.7 ms)  |
  | Transport (`received − sent`)                                 | > 10 ms  | > 50 ms  | 3 delayed (max 20.9 ms)  |
  | Age at receive (`received − produced`)                        | > 30 ms  | > 50 ms  | none (max 23.9 ms)       |
  | Age at decision (tick − produced, newest running frame)       | > 100 ms | > 150 ms | 2 delayed (max 111.6 ms) |

  A measure is _degraded_ while at least 3 of its last 10 samples are not normal; the episode ends after 30 normal samples. A critical sample is reported at once when a measure becomes critical. The results appear in the status (`latency`) and in the diagnostic recording (`control` lines of category `latency`); **no decision reads them**: freshness, supervisor, command generation and the simulation-time backlog check (R7) are unchanged, and the replays give exactly the same decisions and freshness states with the diagnosis. The limits were checked against the calibration drive and kept as proposed; none of them is a safety limit (the 150 ms age limit is enforced by the freshness check).

- The sender ticks every 40 ms on the monotonic clock. Missed deadlines are skipped, never replayed; a gap over 100 ms between ticks is a safety event.
- An independent watchdog task checks every 20 ms that the control loop updated the supervisor within the last 100 ms.

Source: `src-tauri/src/control/` (core, no Tauri dependency) and `src-tauri/src/control_app.rs` (application lifecycle and commands).

## Safety rules

| Rule                             | Value                                                                                                                                        |
| -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| Telemetry age limit              | 150 ms (configurable 50–200 ms), measured as the absolute age since the game produced the frame (QPC); simulation time is only a cross-check |
| Settling after any discontinuity | at least 3 frames over at least 50 ms                                                                                                        |
| Test speed cap                   | 5 m/s; exceeding it disarms (Armed) or faults (Active)                                                                                       |
| Steering limit                   | ±0.15, rate 0.5 per second, direction changes pass through zero                                                                              |
| Throttle limit                   | 0.10; brake 1.0; brake overrides throttle                                                                                                    |
| Sender period                    | 40 ms; a gap over 100 ms is a safety event                                                                                                   |
| Watchdog timeout                 | 100 ms without a supervisor update                                                                                                           |

Supervisor states: **Disabled** (initial), **Armed**, **Active** (the only state that produces commands), **Fault**.

- Arming needs fresh, settled telemetry within the speed cap, and binds to that vehicle epoch, session and game. Any later discontinuity (pause, gap or reconnect, session or game change, invalid frame) is a safety event.
- A safety event disarms Armed to Disabled and puts Active into Fault. Nothing re-arms automatically; a reconnect never restores Armed or Active.
- A fault is left only by an explicit **Reset Fault**, which leads to Disabled; control then needs a new **Arm** and **Activate**.
- **Disarm** is accepted in every state and processed before any other command queued with it.
- After any fault, the only message that can follow is a single disarm. Commands are never stored, queued or repeated.

## Operator commands and status

The dashboard's **Control** section shows the supervisor state, the operating mode (Dry Run), vehicle connection, telemetry freshness, vehicle epoch, the last safety event, the last tick and its timing, the watchdog, the last tick's output, and recent decisions. For an output it distinguishes three stages: **Generated** (built from a request), **Encoded** (bytes produced) and **Not transmitted (Dry Run)**. Nothing in the UI or the backend can report a message as delivered.

| Tauri command                                                              | Purpose                                                                                         |
| -------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `control_status`                                                           | Current status (also pushed as the `control:status` event every 200 ms)                         |
| `control_log`                                                              | Recent log entries, newest first (`limit`, default 50, at most 200)                             |
| `control_arm`, `control_activate`, `control_disarm`, `control_reset_fault` | Operator requests; the answer says accepted, rejected (with the reason), pending or unavailable |

The UI is never the safety authority. Its buttons only send requests; the supervisor in the backend accepts or refuses them. The Disarm button is always visible and enabled, needs no confirmation, and stays usable during a fault and while another request is pending.

## Lifecycle

- The control runtime starts with the application. If it cannot start, the application still runs and reports control as unavailable; nothing is encoded in that case. A second runtime is never started.
- On exit the control task is asked to disarm and stop and gets 500 ms. If it does not stop in time it is aborted; dropping the control core still encodes any owed disarm, and the application waits up to another second for that. The outcome reports whether the log shows a disarm after the last command; it never claims a transmission.

## Log

Three bounded rings, so high-rate records cannot evict safety decisions: decisions (256), timing (128) and encoded messages (256). Message records hold the encoded bytes, the requested and the bounded values, the adjustments (limited, brake override, rate limited) and the delivery status, which is always "not transmitted".

For test drives, the optional diagnostic recorder writes every log record, and every change of the freshness assessment, to a file without the rings' limits. It is off unless `ROADPILOT_TELEMETRY_RECORD` is set; see [Diagnostic recording](telemetry.md#diagnostic-recording).

## Verification status

Four levels, from weakest to strongest evidence. Nothing in the control pipeline has reached the last one.

**1. Implemented and covered by automated tests** (`cargo test` in `src-tauri`, `npm run check`):

- Freshness monitor, supervisor, limits and rate limiter, protocol encoder (byte-compatible with the RoadPilot-SDK test vector), scheduler, watchdog, bounded log, status and log views.
- **Replay of recorded ATS drives** (`src-tauri/tests/replay.rs`): two diagnostic recordings, reduced to compact fixtures in `src-tauri/tests/fixtures/replay/` (timing, identity, plugin state, QPC stamps, speed, parking brake; 0.75 MB compressed), are fed to the production control core on a virtual clock with 40 ms ticks. The replay reproduces every decision of the recorded control runs exactly: Stage B (no QPC, 36,290 frames) 58 backlog, 9 gap, 5 paused, 1 session-changed epochs; the calibration drive (QPC, 46,389 frames) 33 backlog, 4 gap, 3 paused epochs. This is the baseline later freshness changes are measured against. `examples/replay_fixture.rs` builds a fixture from a recording; with `ROADPILOT_REPLAY_JSONL` an ignored test replays full local recordings and checks that the fixtures replay identically.
- The control core driven with simulated telemetry, and the async runtime on virtual time (reconnects, faults, channel replacement, disarm priority, shutdown, aborted task).
- The application lifecycle in real time: start, refused second start, orderly shutdown within 500 ms, abort of a stuck task with the drop-time disarm recorded, a task that already died.
- Every Tauri command invoked through Tauri's mock runtime, and the absence of any command that changes the mode or transmits.
- The Control section and its data source (React tests), including Disarm availability in every state.
- A test scans all control source files for the input pipe name and for file, pipe, process and network APIs.

**2. Verified in the running desktop application** (Windows 11, display scaling 150 %, no game running):

- The control runtime starts with the application and reports Disabled, Dry Run and no vehicle data.
- The Control section renders at 1280×900, 900×800 and 380×800 (logical pixels): Disarm stays first and fully visible, the buttons wrap at narrow widths, the Dry Run badge and the not-transmitted note are visible.
- Arm through the real IPC path was refused by the supervisor ("telemetry not ready") and both refusals appeared in the recent decisions with their age.
- Closing the window ran the orderly control shutdown; the application exited in under one second without any shutdown warning.
- Tick timing on the same machine, with no game running: see [timing.md](timing.md).

**3. Verified in ATS or ETS2 gameplay:** nothing in the control pipeline. Only the schema 1 telemetry plugin (speed, RPM, gear) was live-tested, in ATS.

**4. Not implemented:** live transmission to the input plugin, any steering or speed controller, autonomous driving, single-instance protection across application processes.

On Windows, test executables need the same application manifest as the app (Common Controls v6). `src-tauri/build.rs` therefore embeds `windows-app-manifest.xml`, an unchanged copy of tauri-build's default, through the linker for every artifact; the application's embedded manifest is identical to before.

## Outstanding risks

- **Schema 2 live telemetry is not verified in gameplay.** Freshness, epochs and settling are tested against the plugin's documented behaviour only.
- **The input plugin is not verified in-game.** Axis binding, steering sign and range, and the effect of the plugin's own limits are unknown.
- **Manual override is not verified.** How the game combines a bound RoadPilot axis with the player's wheel or keyboard is unknown; until it is, the only reliable override is to disarm, unbind the axis or remove the plugin.
- **Thresholds are not calibrated against live gameplay.** The 150 ms age limit, 50 ms settling, 100 ms backlog tolerance, 40 ms period and 100 ms watchdog timeout come from documented frame rates and protocol limits, not from measurements in a game.
- **Tick timing with a game running is not measured.** The sender now runs on a dedicated thread with a precise timer at elevated thread priority. On a quiet desktop and under full CPU load no tick interval exceeded 50 ms (maximum 45.3 ms idle, 40.4 ms under load; see [timing.md](timing.md)). Before that, tokio's timer produced intervals up to 55.3 ms. It is not yet measured with ATS or ETS2 running, and the 10 ms "late" threshold is not recalibrated.
- **No single-instance protection across processes.** A second application instance cannot open the telemetry pipe, but its own dry-run control runtime still starts.
- **Control section size.** In the desktop window at 1280×900 the section takes most of the first screen and pushes the overview cards below the fold; the status rows could be laid out more compactly.
- **No autonomous steering or speed controller exists.** The request source is neutral.
