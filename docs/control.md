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
- The sender ticks every 40 ms on the monotonic clock. Missed deadlines are skipped, never replayed; a gap over 100 ms between ticks is a safety event.
- An independent watchdog task checks every 20 ms that the control loop updated the supervisor within the last 100 ms.

Source: `src-tauri/src/control/` (core, no Tauri dependency) and `src-tauri/src/control_app.rs` (application lifecycle and commands).

## Safety rules

| Rule                             | Value                                                                  |
| -------------------------------- | ---------------------------------------------------------------------- |
| Telemetry age limit              | 150 ms (configurable 50–200 ms); simulation time is only a cross-check |
| Settling after any discontinuity | at least 3 frames over at least 50 ms                                  |
| Test speed cap                   | 5 m/s; exceeding it disarms (Armed) or faults (Active)                 |
| Steering limit                   | ±0.15, rate 0.5 per second, direction changes pass through zero        |
| Throttle limit                   | 0.10; brake 1.0; brake overrides throttle                              |
| Sender period                    | 40 ms; a gap over 100 ms is a safety event                             |
| Watchdog timeout                 | 100 ms without a supervisor update                                     |

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

## Verification status

Four levels, from weakest to strongest evidence. Nothing in the control pipeline has reached the last one.

**1. Implemented and covered by automated tests** (`cargo test` in `src-tauri`, `npm run check`):

- Freshness monitor, supervisor, limits and rate limiter, protocol encoder (byte-compatible with the RoadPilot-SDK test vector), scheduler, watchdog, bounded log, status and log views.
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
- Tick timing on the same machine: see the outstanding risks below.

**3. Verified in ATS or ETS2 gameplay:** nothing in the control pipeline. Only the schema 1 telemetry plugin (speed, RPM, gear) was live-tested, in ATS.

**4. Not implemented:** live transmission to the input plugin, any steering or speed controller, autonomous driving, single-instance protection across application processes.

On Windows, test executables need the same application manifest as the app (Common Controls v6). `src-tauri/build.rs` therefore embeds `windows-app-manifest.xml`, an unchanged copy of tauri-build's default, through the linker for every artifact; the application's embedded manifest is identical to before.

## Outstanding risks

- **Schema 2 live telemetry is not verified in gameplay.** Freshness, epochs and settling are tested against the plugin's documented behaviour only.
- **The input plugin is not verified in-game.** Axis binding, steering sign and range, and the effect of the plugin's own limits are unknown.
- **Manual override is not verified.** How the game combines a bound RoadPilot axis with the player's wheel or keyboard is unknown; until it is, the only reliable override is to disarm, unbind the axis or remove the plugin.
- **Thresholds are not calibrated against live gameplay.** The 150 ms age limit, 50 ms settling, 100 ms backlog tolerance, 40 ms period and 100 ms watchdog timeout come from documented frame rates and protocol limits, not from measurements in a game.
- **Windows timer granularity.** Measured on the development machine (250 ticks of the same tokio timer the sender uses): lateness median 8.2 ms, 95th percentile 15.3 ms, maximum 25.2 ms; 40 % of ticks exceed the 10 ms "late" threshold. Tick intervals: median 45.7 ms, maximum 55.3 ms, and about 1 % exceed the input protocol's 50 ms refresh requirement. This is harmless in dry run (the safety limits are 100 ms for gaps and the watchdog, 150 ms for the plugin's steering timeout), but it must be resolved before any live transmission, for example with a high-resolution timer or a shorter period, and the late threshold needs calibrating.
- **No single-instance protection across processes.** A second application instance cannot open the telemetry pipe, but its own dry-run control runtime still starts.
- **Control section size.** In the desktop window at 1280×900 the section takes most of the first screen and pushes the overview cards below the fold; the status rows could be laid out more compactly.
- **No autonomous steering or speed controller exists.** The request source is neutral.
