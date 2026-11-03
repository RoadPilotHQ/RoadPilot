# Game telemetry

RoadPilot reads live data from Euro Truck Simulator 2 (ETS2) and American Truck Simulator (ATS). This integration is **read-only**: it never steers, brakes, accelerates or injects input into the game.

> **Status:** implemented for both games. Live-verified in **ATS 1.62.x** only. **ETS2 live telemetry has not been tested yet**; see [Verification status](#verification-status).

## Telemetry source

RoadPilot uses the RoadPilot telemetry stack from the separate [RoadPilot-Telemetry](https://github.com/RoadPilotHQ/RoadPilot-Telemetry) repository:

| Part                                         | Where                                       | Role                                                                                     |
| -------------------------------------------- | ------------------------------------------- | ---------------------------------------------------------------------------------------- |
| Native game plugin `roadpilot-telemetry.dll` | RoadPilot-Telemetry `plugin/`               | Loaded by ETS2/ATS through the official SCS Telemetry SDK. Sends normalized JSON frames. |
| `roadpilot-telemetry-client` crate           | RoadPilot-Telemetry `client/`               | Hosts the named pipe, decodes and validates frames.                                      |
| Telemetry engine                             | this repository, `src-tauri/src/telemetry/` | Connection state, normalization, events to the dashboard.                                |

Why this source:

- It is built on the official [SCS Telemetry SDK](https://modding.scssoft.com/wiki/Documentation/Engine/SDK/Telemetry), which is shared by ETS2 and ATS, so both games use one data model.
- It is RoadPilot's own protocol, so no third-party plugin, memory layout or licence has to be adopted. Community plugins were evaluated by RoadPilot-Telemetry as references only.
- The client is Rust and runs inside the Tauri backend.

### Dependency

`src-tauri/Cargo.toml` pins the client crate to a fixed commit:

```toml
roadpilot-telemetry-client = { git = "https://github.com/RoadPilotHQ/RoadPilot-Telemetry.git", rev = "98e1cbd82dd6a30c119287d66ab4b1b00f49f1f3" }
```

Update the `rev` deliberately when the protocol changes. The client's dependencies report MIT, Apache-2.0 or Unlicense terms (see RoadPilot-Telemetry `client/README.md`). The SCS SDK is not vendored or redistributed by RoadPilot; the plugin is built against a locally extracted SDK (see RoadPilot-Telemetry `plugin/README.md`). The project licence is still undecided.

### Setup

1. Build `roadpilot-telemetry.dll` as described in RoadPilot-Telemetry `plugin/README.md`.
2. Copy it manually into the game's `bin/win_x64/plugins/` folder (create the folder if necessary). RoadPilot does not install or modify game files.
3. Start RoadPilot, then the game. The game asks once to confirm the use of SDK plugins.

Only one program can host the telemetry pipe. Close the RoadPilot-Telemetry console reader before starting RoadPilot, otherwise RoadPilot shows **Telemetry error**.

## Data flow

```
ETS2/ATS -> roadpilot-telemetry.dll -> \\.\pipe\RoadPilot.Telemetry.v1
  -> roadpilot-telemetry-client (decode, validate)       [Tokio task]
  -> telemetry::normalize (units, plausibility)
  -> telemetry::status (connection state machine)
  -> telemetry::engine (sampling, change detection)       [Tokio task]
  -> Tauri event "telemetry:update" / command "telemetry_snapshot"
  -> src/backend/telemetrySource.ts -> snapshotFromTelemetry -> dashboard
```

- The engine runs on Tauri's async runtime, independent of React and of the main thread. Process detection runs on a blocking worker thread.
- While connected, the engine samples at most 10 times per second, although the plugin sends one frame per game frame. Events are emitted only when the update changes. While not connected, it re-evaluates once per second and wakes immediately on the first frame.
- Only the newest frame is kept (Tokio `watch` channel), so memory does not grow during long sessions.
- On application exit the engine task is aborted, which also stops the pipe server.

## Connection states

| State          | Meaning                                                                        | Dashboard                           |
| -------------- | ------------------------------------------------------------------------------ | ----------------------------------- |
| `disconnected` | No ETS2/ATS process is running.                                                | Demo data, badge "Game not running" |
| `connecting`   | Game process found, waiting up to 15 s for the first frame.                    | Demo data with reason               |
| `connected`    | Frames newer than 2 s arrive (or the game reported pause).                     | Live data                           |
| `reconnecting` | Telemetry was live, frames stopped, game still runs.                           | Live mode **without values**        |
| `unavailable`  | Game runs, but no frame arrived within 15 s (plugin missing?).                 | Demo data with reason               |
| `error`        | The pipe could not be opened (for example, already in use). Retried every 5 s. | Demo data with reason               |

Game detection looks for `eurotrucks2.exe` and `amtrucks.exe`. It only distinguishes "not running" from "no telemetry"; the game identity shown while connected comes from the plugin. When the game exits, its last frame is discarded so it can never reappear as current data.

Demo and live values are never mixed. In live mode, any value the telemetry does not provide is shown as **Not available**.

## Supported fields (protocol v1)

| Field      | Unit           | Notes                                                                                      |
| ---------- | -------------- | ------------------------------------------------------------------------------------------ |
| Game       | `ets2` / `ats` | From the plugin                                                                            |
| Paused     | bool           | From the plugin's running/paused state                                                     |
| Speed      | km/h           | Converted from m/s, rounded to 0.1, signed (negative = reverse). Dropped if over 400 km/h. |
| Engine RPM | rpm            | Rounded. Dropped if negative or over 10,000.                                               |
| Gear       | integer        | Positive forward, 0 neutral (N), negative reverse (R1…). Dropped outside −16…32.           |

The plausibility bounds are safety guards against corrupt values, not game limits.

## Not yet available

The following requested values are **not** part of telemetry protocol v1 and are therefore absent in RoadPilot (never defaulted):

- Vehicle: engine state, parking brake, cruise control, fuel level and capacity, position, rotation, heading, steering wheel position.
- Dynamics: acceleration, brake/throttle/steering input, velocity, movement direction.
- Navigation: job, source/destination city, cargo, income, deadline, remaining distance and time, road information.
- Environment: game time, weather, traffic.

Most vehicle, dynamics, navigation and job values are offered by the SCS Telemetry SDK as truck channels, the game time channel and the job configuration and gameplay events. Adding them requires, in RoadPilot-Telemetry: registering the channels in the plugin, extending the frame schema (additive optional fields are allowed by the protocol draft), and extending the client model. Afterwards RoadPilot only needs model and UI mapping changes. Check the exact channel names and units against the SDK headers when implementing. The SDK does not document weather or surrounding-traffic data; those should be treated as unavailable.

## Verification status

Implementation status and verification status are tracked separately. Both games use the same plugin, protocol, engine and dashboard code; only ATS has been tested live so far.

|                                                                      | ATS                  | ETS2                   |
| -------------------------------------------------------------------- | -------------------- | ---------------------- |
| Telemetry integration implemented                                    | Yes                  | Yes (shared code path) |
| Plugin `roadpilot-telemetry.dll` installed and loaded in a live test | Yes                  | **Not yet tested**     |
| Live telemetry verified in the running game                          | **Yes** (ATS 1.62.x) | **No — planned**       |
| Speed, engine RPM, gear received                                     | Verified             | Not yet tested         |
| Connect ("Connected", Live data banner)                              | Verified             | Not yet tested         |
| Pause / resume ("Paused", back to "Connected")                       | Verified             | Not yet tested         |
| Game exit ("Game not running", demo data again)                      | Verified             | Not yet tested         |
| Reconnect after a game restart, RoadPilot left open                  | Verified             | Not yet tested         |

ETS2 live telemetry must not be considered verified until the manual test below has been performed with ETS2. ETS2 requires `roadpilot-telemetry.dll` in its own `bin/win_x64/plugins/` folder; installing it for ATS does not cover ETS2.

States that have not been observed in either live game: **Telemetry unavailable** (game running without the plugin), **Telemetry error** (pipe in use) and **Reconnecting** (frames stop while the game keeps running). They are covered by automated tests only.

Additionally, the pipe-to-dashboard path was verified without a game by writing protocol v1 frames into the real pipe, the same way the plugin does.

## Manual test with the game

Automated tests use mocked telemetry and never need a running game. The live test, still outstanding for ETS2:

1. Install `roadpilot-telemetry.dll` in the game's `bin/win_x64/plugins/` folder.
2. Start RoadPilot without a game. Expect "Game not running" and the **Demo data** banner.
3. Start the game. Expect "ETS2 Connecting…" (or "ATS Connecting…"), then:
   - with the plugin installed: "Connected" and the **Live data** banner once a truck is loaded;
   - without the plugin: "Telemetry unavailable" after 15 s.
4. Drive. Speed, RPM and gear must follow the in-game values. Reverse shows R1 and a positive speed.
5. Pause the game (Esc). Expect "Paused"; after resuming, "Connected" again.
6. Exit the game. Expect "Game not running" and demo data within about 3 seconds.
7. Start the game again with RoadPilot still open. Expect live data to return.
