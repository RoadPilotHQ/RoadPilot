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

## Tests

`cargo test` (in `src-tauri`) covers the freshness monitor, supervisor, limits, encoder (byte-compatible with the RoadPilot-SDK test vector), scheduler, watchdog, log, the core with simulated telemetry, the async runtime on virtual time, the application lifecycle in real time (including the 500 ms shutdown and the abort path), and every Tauri command through Tauri's mock runtime. `npm run check` covers the control source and the Control section.

On Windows, test executables need the same application manifest as the app (Common Controls v6). `src-tauri/build.rs` therefore embeds `windows-app-manifest.xml`, an unchanged copy of tauri-build's default, through the linker for every artifact; the application's embedded manifest is identical to before.
