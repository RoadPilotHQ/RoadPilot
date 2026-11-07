# Game telemetry

RoadPilot reads live data from Euro Truck Simulator 2 (ETS2) and American Truck Simulator (ATS). This integration is **read-only**: it never steers, brakes, accelerates or injects input into the game.

> **Status:** telemetry schema 2 (vehicle including wheel geometry, dynamics, position, job, navigation, game time) is implemented and covered by automated tests. **No schema 2 field has been verified in a running game yet.** The earlier schema 1 integration (speed, RPM, gear) was live-verified in **ATS 1.62.x** only; **ETS2 has not been tested live at all.** See [Verification status](#verification-status).

## Telemetry source

RoadPilot uses the RoadPilot telemetry stack from the separate [RoadPilot-Telemetry](https://github.com/RoadPilotHQ/RoadPilot-Telemetry) repository:

| Part                                         | Where                                       | Role                                                                                                                      |
| -------------------------------------------- | ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| Native game plugin `roadpilot-telemetry.dll` | RoadPilot-Telemetry `plugin/`               | Loaded by ETS2/ATS through the official SCS Telemetry SDK 1.16. Writes schema 2 frames over a persistent pipe connection. |
| `roadpilot-telemetry-client` crate           | RoadPilot-Telemetry `client/`               | Hosts the named pipe, decodes, validates and orders frames. Accepts schema 1 and 2.                                       |
| Telemetry engine                             | this repository, `src-tauri/src/telemetry/` | Connection state, unit and axis conversion, calculated values, events to the dashboard.                                   |
| Visualization stream                         | this repository, `visualization_stream.rs`  | Read-only schema 2 frame stream on loopback port `17891` for RoadPilot-Visualization.                                     |

The wire format, units, bounds and SDK sources of every field are specified in RoadPilot-Telemetry [`docs/PROTOCOL-V2.md`](https://github.com/RoadPilotHQ/RoadPilot-Telemetry/blob/main/docs/PROTOCOL-V2.md).

Why this source:

- It is built on the official [SCS Telemetry SDK](https://modding.scssoft.com/wiki/Documentation/Engine/SDK/Telemetry), shared by ETS2 and ATS, so both games use one data model.
- It is RoadPilot's own protocol: no third-party plugin, memory layout or licence has to be adopted.
- The client is Rust and runs inside the Tauri backend.

### Dependency

`src-tauri/Cargo.toml` pins the client crate to a fixed commit:

```toml
roadpilot-telemetry-client = { git = "https://github.com/RoadPilotHQ/RoadPilot-Telemetry.git", rev = "ca64c8e7e169a26143c62b2c525de3e8ec3b39ab" }
```

Update the `rev` deliberately, together with the copied test fixture in `src-tauri/tests/fixtures/`. The client's dependencies report MIT, Apache-2.0 or Unlicense terms. The SCS SDK (© SCS Software, MIT-style licence) is not vendored or redistributed by RoadPilot; the plugin is built against a locally extracted SDK. The project licence is still undecided.

### Wheel geometry and wheelbase

The plugin sends raw wheel geometry from the SDK truck configuration (`truckConfig.wheels[]`, `hookPositionM`, at most 14 wheels, SDK vehicle space X right, Y up, Z backwards). The application calculates `vehicle.wheelbaseM` in `telemetry::normalize` only: the distance along Z between the mean of the steerable wheels and the mean of the powered, non-steerable wheels. It is absent when the geometry is incomplete (missing or truncated wheel list, a wheel without position or flags, no steerable or no drive wheel), non-finite, or outside 0.5–30 m. Not verified in a running game yet.

### Setup

1. Build `roadpilot-telemetry.dll` as described in RoadPilot-Telemetry `plugin/README.md`.
2. Copy it manually into the game's `bin/win_x64/plugins/` folder (create the folder if necessary) — **separately for ETS2 and ATS**. RoadPilot does not install or modify game files.
3. Start RoadPilot, then the game. The game asks once to confirm the use of SDK plugins.

Only one program can host the telemetry pipe. Close the RoadPilot-Telemetry console reader before starting RoadPilot, otherwise RoadPilot shows **Telemetry error**.

An older schema 1 plugin keeps working: RoadPilot then shows speed, RPM and gear and marks everything else as not available.

## Relationship to the Input SDK

This telemetry integration is read-only and has no control path. Control uses a different part of the SCS SDK, the Input SDK, in a different plugin from [RoadPilot-SDK](https://github.com/RoadPilotHQ/RoadPilot-SDK) (`roadpilot-input.dll`, pipe `\\.\pipe\roadpilot-input-v1`). That plugin registers a generic input device with throttle, brake and steering axes; the user binds them manually in the game. The protocol, limits and safety rules are specified only in its [PROTOCOL.md](https://github.com/RoadPilotHQ/RoadPilot-SDK/blob/main/docs/PROTOCOL.md).

State in this application: **no component sends commands to that pipe and there is no steering activation UI.** The future sender must refresh commands at least every 50 ms, independently of the 10 Hz telemetry engine described below; that rate is a requirement of the input protocol, not an existing capability. Steering range, sign and interaction with manual controls are unverified in ATS and ETS2. The steering values in the telemetry (`steeringInput`, `steeringEffective`) are readings of the game state, not commands.

## Data flow

```
ETS2/ATS -> roadpilot-telemetry.dll (worker thread, persistent connection)
  -> \\.\pipe\RoadPilot.Telemetry.v1
  -> roadpilot-telemetry-client: decode, validate, order (session + sequence)   [Tokio task]
  -> telemetry::normalize: units, axes, calculated values (once per frame)
  -> telemetry::status: connection state machine
  -> telemetry::engine: 10 Hz sampling, change detection                         [Tokio task]
  -> Tauri event "telemetry:update" / command "telemetry_snapshot"
  -> src/backend/telemetrySource.ts -> snapshotFromTelemetry -> dashboard
  -> loopback WebSocket ws://127.0.0.1:17891 -> roadpilot-visualization-frame schema 2
```

- The engine runs on Tauri's async runtime, independent of React and of the main thread. Process detection runs on a blocking worker thread.
- While connected (also while paused, when the game keeps sending frames) the engine samples at most 10 times per second; the plugin sends up to ~60 frames per second. Events are emitted only when the update changes. While not connected it re-evaluates once per second and wakes immediately on the first frame.
- Only the newest frame is kept (Tokio `watch` channel) and normalized once, so memory does not grow during long sessions.
- On application exit the engine task is aborted, which also stops the pipe server.

## Visualization stream

RoadPilot also broadcasts telemetry frames to the separate RoadPilot-Visualization application. The stream binds only to `127.0.0.1:17891`, accepts browser origins used by the local Visualization dev/preview servers and Tauri local origins, and never accepts commands. A client without an `Origin` header is allowed only through the loopback listener, for local native tools. Incoming client text/binary messages are closed; WebSocket messages are limited to 1 KiB.

Open the Visualization app with `?source=live` to connect to this stream. It sends schema 2 `roadpilot-visualization-frame` messages only while telemetry data is present. Position maps from SDK X/Z metres to scene east/north (`scene y = -SDK z`); heading is converted from the SDK's counterclockwise-from-north convention to scene radians counterclockwise from east. Speed, observed road-wheel angle, and player inputs are forwarded with unit conversion. Vehicle dimensions, path curvature, lane geometry, other agents, traffic signals and a planned trajectory are not reported by the current RoadPilot telemetry source and remain `null` or empty. In particular, yaw rate is not presented as path curvature.

The bridge is newly implemented and **has not yet been verified live in ATS or ETS2**. The socket's origin check limits browser access; binding to loopback does not authenticate other local processes.

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

## Data quality

| Kind                     | How RoadPilot handles it                                                                                                              |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------- |
| Valid live data          | Shown while `connected`. Every update carries the frame's sequence, SDK simulation time and RoadPilot's receive time (`data.source`). |
| Missing data             | `null`; shown as **Not available**. Never replaced by zero or a demo value.                                                           |
| Invalid data             | Removed by the client (non-finite or outside plausibility bounds); listed in `data.source.invalidFields`; shown as **Not available**. |
| Stale data               | Not shown: after 2 s without frames the state becomes `reconnecting` and all values are cleared.                                      |
| Calculated data          | Derived by RoadPilot from game values; marked with `*` in the dashboard (see below).                                                  |
| Unavailable from the SDK | Weather, rain, day/night, traffic, road information: shown as **Not provided by the game**.                                           |
| Demo data                | Only when not connected, under the **Demo data** banner. Never mixed with live values.                                                |

## Supported fields (schema 2)

Field names in `TelemetryUpdate.data` (Rust `model.rs`, TypeScript `src/domain/telemetry.ts`).

### Vehicle

| Field                                                     | Unit                                   | Source                                                     |
| --------------------------------------------------------- | -------------------------------------- | ---------------------------------------------------------- |
| `speedKmh`                                                | km/h, signed (negative = reverse)      | `truck.speed` m/s × 3.6                                    |
| `engineRpm`, `gear`, `displayedGear`                      | rpm; >0 forward, 0 neutral, <0 reverse | SDK                                                        |
| `engineRunning`, `electricOn`                             | bool                                   | SDK                                                        |
| `fuelL`, `fuelCapacityL`                                  | litres                                 | SDK channel / truck configuration                          |
| `fuelPercent`                                             | %                                      | **Calculated:** fuel / capacity                            |
| `fuelRangeKm`                                             | km                                     | SDK (game estimate)                                        |
| `fuelConsumptionLPer100km`                                | l/100 km                               | SDK average l/km × 100 (ATS: mostly static per SDK)        |
| `adblueL`, `adblueCapacityL`                              | litres                                 | SDK (not provided by ATS)                                  |
| `oilTemperatureC`, `waterTemperatureC`, `batteryVoltageV` | °C, V                                  | SDK (loosely approximated by the game)                     |
| `parkingBrake`, `engineBrake`                             | bool                                   | SDK                                                        |
| `retarderLevel`, `retarderSteps`                          | step                                   | SDK channel / configuration                                |
| `cruiseControlOn`                                         | bool                                   | **Calculated:** set speed > 0 (the SDK reports 0 when off) |
| `cruiseControlKmh`                                        | km/h                                   | SDK set speed × 3.6, `null` while off                      |
| `brand`, `model`                                          | text                                   | Truck configuration                                        |

### Dynamics

Converted from SDK vehicle space (X right, Y up, **Z backwards**) to forward / right / up:

| Field                                                         | Unit                      | Conversion                                                                                                                                                              |
| ------------------------------------------------------------- | ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `longitudinalVelocityMs`, `longitudinalAccelerationMs2`       | m/s, m/s²                 | −Z (forward positive, braking negative)                                                                                                                                 |
| `lateralVelocityMs`, `lateralAccelerationMs2`                 | m/s, m/s²                 | X (right positive)                                                                                                                                                      |
| `verticalVelocityMs`, `verticalAccelerationMs2`               | m/s, m/s²                 | Y (up positive)                                                                                                                                                         |
| `yawRateDegS`                                                 | °/s                       | angular velocity Y (turns/s) × 360, counterclockwise (left turn) positive                                                                                               |
| `steeringInput`, `steeringEffective`                          | −1…1, **positive = left** | SDK, unchanged                                                                                                                                                          |
| `throttleInput`, `brakeInput`, `clutchInput` and `*Effective` | 0…1                       | SDK, unchanged. `Input` = player, `Effective` = used by the simulation (cruise control, automatic clutch). Effective brake excludes retarder, parking and engine brake. |
| `wheelSteeringAngleDeg`                                       | °                         | First steerable wheel, turns × 360, positive = left. A **physical road-wheel angle**, not the steering input.                                                           |

The dashboard shows the player inputs (`*Input`).

### Position

`position` is present only when the game provides the complete placement.

| Field         | Unit            | Convention                                                                                        |
| ------------- | --------------- | ------------------------------------------------------------------------------------------------- |
| `x`, `y`, `z` | metres (double) | SDK world space: X east, Y up, **Z south**. Not transformed.                                      |
| `headingDeg`  | 0…360°          | Turns × 360. **Counterclockwise from north** (90 = west, 180 = south, 270 = east), as in the SDK. |
| `pitchDeg`    | −90…90°         | Positive = nose up                                                                                |
| `rollDeg`     | −180…180°       | Counterclockwise around the forward axis                                                          |

These conventions matter for RoadPilot-Map and lane keeping later: heading is _not_ a compass bearing (which runs clockwise), and world Z grows towards the south. Any further transformation must be documented and tested where it is introduced.

### Job

| Field                                                                  | Notes                                                                                                                                                  |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `state`                                                                | `unknown` (no job information from the telemetry), `none`, `active`, `delivered`, `cancelled`. Delivered and cancelled stay until the next job starts. |
| `cargo`, `cargoMassKg`, `cargoDamagePercent`                           | From the job configuration; damage from the `job.cargo.damage` channel                                                                                 |
| `sourceCity`, `sourceCompany`, `destinationCity`, `destinationCompany` | Localized by the game                                                                                                                                  |
| `income`, `currency`                                                   | Game currency per the SDK: ETS2 EUR, ATS USD                                                                                                           |
| `deadline` `{dayOffset, time}`                                         | **Calculated** from the absolute deadline and the current game time                                                                                    |
| `timeToDeadlineMin`                                                    | **Calculated:** deadline − game time (negative = late)                                                                                                 |
| `plannedDistanceKm`                                                    | SDK                                                                                                                                                    |
| `progressPercent`                                                      | **Calculated, approximate:** 1 − Route Advisor distance / planned distance; only while active. Shown as "≈".                                           |
| `deliveredRevenue`, `cancelPenalty`                                    | From the `job.delivered` / `job.cancelled` gameplay events                                                                                             |

The Current Job card's remaining distance and time come from the Route Advisor and are only shown while a job is active.

### Navigation

Route Advisor values as provided by the game: `distanceKm` (from metres), `etaMin` (from seconds), `speedLimitKmh` (from m/s). The SDK does not document what a speed limit of 0 means; RoadPilot shows it as "None shown" (`speedLimitShown = false`). **This interpretation is unconfirmed until checked in the game.** The navigation target name, the route geometry and road information are not provided by the SDK.

### Environment

`gameTimeMin` (in-game minutes since 00:00 of day 1), `gameClock` (**calculated** `HH:MM`), `timeScale`. Weather, rain, day/night state and traffic are **not provided by the SCS SDK** and are shown as "Not provided by the game".

## Verification status

Implementation and verification are tracked separately. "Automated" means unit and integration tests with mocked data, a fake SCS host and the real pipe — not a running game.

| Area                                                             | Implemented              | Automated tests | ATS live              | ETS2 live      |
| ---------------------------------------------------------------- | ------------------------ | --------------- | --------------------- | -------------- |
| Connection, pause/resume, game exit, reconnect (schema 1 plugin) | Yes                      | Yes             | **Verified** (1.62.x) | Not yet tested |
| Speed, RPM, gear (schema 1 plugin)                               | Yes                      | Yes             | **Verified** (1.62.x) | Not yet tested |
| Schema 2 plugin: connection, persistent pipe, reconnect          | Yes                      | Yes             | Not yet tested        | Not yet tested |
| Fuel, engine, temperatures, cruise control                       | Yes                      | Yes             | Not yet tested        | Not yet tested |
| Dynamics and inputs                                              | Yes                      | Yes             | Not yet tested        | Not yet tested |
| Position and orientation                                         | Yes                      | Yes             | Not yet tested        | Not yet tested |
| Job, deadline, delivered/cancelled                               | Yes                      | Yes             | Not yet tested        | Not yet tested |
| Navigation (distance, ETA, speed limit)                          | Yes                      | Yes             | Not yet tested        | Not yet tested |
| Game time                                                        | Yes                      | Yes             | Not yet tested        | Not yet tested |
| Weather, rain, traffic                                           | Not available in the SDK | —               | —                     | —              |

The complete path from pipe to dashboard was additionally exercised in the running desktop app without a game, by writing the shared schema 2 fixture frame into the real pipe over one persistent connection.

## Manual test with the game

To be performed for **each** game; record the game version and which fields were confirmed.

1. Install the schema 2 `roadpilot-telemetry.dll` in the game's `bin/win_x64/plugins/` folder.
2. Start RoadPilot without a game. Expect "Game not running" and the **Demo data** banner.
3. Start the game. Expect "Connecting…", then "Connected" and **Live data** once a truck is loaded. (Without the plugin: "Telemetry unavailable" after 15 s.)
4. Vehicle: speed, RPM, gear (reverse shows R1), fuel and fuel %, engine running/off, coolant temperature, cruise control on/off and set speed.
5. Dynamics: throttle and brake inputs follow the pedals; steering left/right matches; acceleration is positive when speeding up and negative when braking.
6. Position (developer check): heading changes in the expected direction when turning (counterclockwise from north).
7. Job: accept a job; check origin, destination, cargo, weight, income, deadline; deliver or cancel and check the state.
8. Navigation: remaining distance and ETA match the Route Advisor; check what the speed limit shows on roads with and without a displayed limit.
9. Game time matches the in-game clock.
10. Pause (Esc) and resume; exit the game; restart it with RoadPilot left open.
