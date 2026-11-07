# Phase 4.1 – Telemetry capability audit

Scope: read-only audit of the telemetry plugin (`RoadPilot-Telemetry`, schema 2), the Rust client, this app's telemetry engine, the Input plugin (`RoadPilot-SDK`) and the pinned SCS SDK 1.16 headers (`scs_sdk_1_16.zip`, official download, read locally). No code was changed, no game was run, no builds or tests were run (nothing was modified). Every claim about the SDK below comes from the 1.16 headers; claims about RoadPilot come from the source and docs.

> **Follow-up status:** this report is the Phase 4.1 audit as written. Its recommended wheel geometry step was implemented in Phase 4.2 (wheel geometry in telemetry, wheelbase in the RoadPilot application), and the steering axis and protocol v2 in Phase 4.3 ([RoadPilot-SDK](https://github.com/RoadPilotHQ/RoadPilot-SDK)). Neither has been verified in a running game, and no input sender, steering UI or controller exists yet. Current status: [README](../README.md#development-phases).

## 1. Summary

- Schema 2 already carries almost everything the SDK offers for a first autonomous test: world position and heading, pitch/roll, local velocity/acceleration/angular velocity, steering/throttle/brake input and effective values, road-wheel angle, speed, gear, fuel, navigation distance/time/speed limit.
- None of it has been verified in a running game (schema 2 is test-only; schema 1 was live in ATS 1.62.x only; ETS2 never).
- The real gaps are not missing SDK channels. They are: (a) vehicle geometry (wheel positions/radius are in the SDK configuration events but are not read), (b) no road/lane/route geometry exists in the SDK at all, (c) the control path (no steering output, 250 ms stale timeout, separate DLL), and (d) the app pipeline samples at 10 Hz while the plugin sends ~60 Hz.

## 2. Available telemetry (already in schema 2, SDK-direct)

| Need                   | Fields                                                                                                                                                                                                                           | SDK source                                                                                         | Notes                                                                                                |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| Position / orientation | `placement.x,y,z,heading,pitch,roll`                                                                                                                                                                                             | `truck.world.placement` (dplacement)                                                               | Double-precision metres, rotations in turns. All-or-nothing object.                                  |
| Movement               | `speedMps`, `localVelocityMps`, `localAccelerationMps2`, `localAngularVelocityRps`                                                                                                                                               | `truck.speed`, `truck.local.velocity.linear`, `…acceleration.linear`, `…velocity.angular`          | Vehicle space: X right, Y up, Z backwards. Yaw rate = angular velocity Y.                            |
| Steering               | `steeringInput`, `steeringEffective`, `wheelSteeringRot`                                                                                                                                                                         | `truck.input.steering`, `truck.effective.steering`, `truck.wheel.steering` (first steerable wheel) | `wheelSteeringRot` is the physical angle (turns, ±0.25); the others are normalized −1…1, not angles. |
| Pedals                 | `throttle/brake/clutch` input + effective                                                                                                                                                                                        | `truck.input.*`, `truck.effective.*`                                                               | 0…1. Effective brake excludes retarder/parking/engine brake.                                         |
| Powertrain             | `gear`, `displayedGear`, `engineRpm`, `engineEnabled`, `electricEnabled`, `cruiseControlMps`, `retarderLevel`, `parkingBrake`, `motorBrake`                                                                                      | `truck.*`                                                                                          |                                                                                                      |
| Fuel / condition       | `fuelL`, `fuelRangeKm`, `fuelConsumptionLPerKm`, `fuelWarning`, `adblueL`, oil/water temperature, oil pressure, battery voltage, brake air pressure, brake temperature, `odometerKm`, `cargoDamage`, `truckConfig.fuelCapacityL` | `truck.*`, `job.cargo.damage`, truck config                                                        | SDK: pressures/temps/voltages only loosely approximated; ATS consumption mostly static.              |
| Navigation             | `navigation.distanceM`, `timeS`, `speedLimitMps`                                                                                                                                                                                 | `truck.navigation.*`                                                                               | Route Advisor scalars only. Meaning of speed limit 0 undocumented by the SDK.                        |
| Timing                 | `simulationTimeUs`, `gameTimeMin`, `sequence`, `session`, `localScale`, `pluginState`                                                                                                                                            | frame_start, `game.time`, `local_scale`                                                            | Simulation time is the right clock for control.                                                      |
| Job                    | state, cargo, cities/companies, deadline, planned distance                                                                                                                                                                       | job config + gameplay events                                                                       | Context only.                                                                                        |

## 3. SDK channels that exist but are not yet read

Verified in the headers, not registered by the plugin:

- **Wear (vehicle condition):** `truck.wear.engine/transmission/cabin/chassis/wheels` (floats 0…1). Useful for damage detection.
- **Wheel state (per wheel, indexed):** `truck.wheel.on_ground`, `.suspension.deflection`, `.angular_velocity`, `.rotation`, `.substance` (surface type), `.lift`, `.lift.offset`. Useful for slip/traction and "on road" hints (substance).
- **Dynamics extras:** `truck.local.acceleration.angular`, cabin/head offsets and angular velocity/acceleration (cosmetic, low value).
- **Indicators/lights:** `lblinker`, `rblinker`, `light.*` (incl. brake, reverse, beams), `hazard.warning`, `wipers`, `differential_lock`. Useful to mirror/detect state; needed only if the autonomous driver signals turns.
- **Warnings:** `truck.*.warning` booleans (oil, water, battery, air pressure, adblue).
- **Driver state:** `mandatory.break` (next mandatory break), `rest.stop`.
- **Trailer channels** (18 `trailer.*` channels, indexed, SDK ≥ 1.14): world placement, local velocity/acceleration, wear, wheel state, connected flag. Not read at all.
- **Configuration events not parsed:** `wheels.count`, `wheel.position`, `wheel.radius`, `wheel.simulated`, `wheel.powered`, `hook.position`, `cabin.position`, `head.position`, `fuel.warning.factor`, warning thresholds, gear ratios, `differential.ratio`; trailer configuration (`hook.position`, wheels, `body.type`, `chain.type`).

## 4. Not provided by the SDK (must be calculated or obtained elsewhere)

| Need                                                    | Status                                                                                                                                              | Source                                                                                                   |
| ------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| Vehicle length, width, wheelbase, track                 | **No SDK channel for outer dimensions.** Wheelbase/track/axle layout _can be calculated_ from `wheel.position` config; overall length/width cannot. | Config parsing + manual per-truck table or conservative defaults                                         |
| Road, lane geometry, lane count, lane width, road edges | **Not in the SDK**                                                                                                                                  | Map data (RoadPilot-Map) matched to `world.placement`                                                    |
| Planned route geometry / next turn / destination name   | **Not in the SDK** (only distance, time, speed limit)                                                                                               | RoadPilot-Map route planning; destination from job city only, free-driving has none                      |
| Traffic, signals, other vehicles, weather, day/night    | **Not in the SDK**                                                                                                                                  | Not obtainable from telemetry. Perception would need another source; out of scope for the first test.    |
| Curvature / path                                        | Derived                                                                                                                                             | From map geometry. Do not equate yaw rate with path curvature (the Visualization docs already say this). |
| Steering angle in degrees / wheel lock                  | Derived                                                                                                                                             | `wheelSteeringRot` × 360 (road wheel); steering-wheel angle requires a ratio the SDK does not provide.   |
| Yaw / yaw rate / slip angle                             | Derived                                                                                                                                             | heading differences over `simulationTimeUs`; angular velocity Y; local velocity X/Z                      |
| Speed limit at road position                            | Partial                                                                                                                                             | Only the Route Advisor value, and only while a route is active                                           |

## 5. SDK limitations

1. **Telemetry is read-only.** Control uses the separate **Input SDK** (`scssdk_input.h`, 1.00): the plugin registers a _generic_ device; the user must bind its axes manually in game, and only axes/buttons/events the game maps can be driven. There is no API to set steering or position directly.
2. Data arrives per game frame (`frame_end`); the Input SDK delivers input in its own callback. Latency/ordering between the two is not specified.
3. SDK telemetry is the player truck (and its trailers) only. No world data.
4. Channel availability varies by game/version: the plugin tolerates this (absent = not provided), but nothing has been confirmed per game yet.
5. Pause: the game sends `paused`; control must treat paused as "do not output".
6. SDK headers are not in any repo (by design); builds need a local SDK 1.16.

## 6. Control path today (RoadPilot-SDK)

- Axes: **throttle and service brake only**. No steering axis, no gear/clutch/indicator output.
- Fail-safe: 16-byte pipe message, 250 ms stale timeout, client must resend every ≤100 ms, disarm on disconnect.
- It is a separate DLL (`roadpilot-input.dll`) with its own pipe (`roadpilot-input-v1`); the telemetry DLL is a different pipe. A single DLL may export both entry points, but that is a design decision, not a given.
- Neither plugin has been run in a game with schema 2 / this build.

## 7. Architecture findings

- **Rate mismatch:** plugin ~60 Hz, app engine samples at 10 Hz, visualization stream follows the engine. A closed loop needs a path from the reader to the controller at full frame rate (the Rust client already has every frame; the `watch` channel keeps only the newest, which is fine for control).
- **Control must not live in the UI process path** (React/Tauri events). Put it in a Rust task consuming the client's frames directly.
- **Units/axes** are normalized in `telemetry::normalize`; heading conversion already exists for the visualization (scene radians from east). Reuse one conversion, do not duplicate it.
- **Steering sign:** SDK positive = left (counterclockwise). The control layer must define one convention and test it.
- **Geometry gap** is the dominant risk: without a road/route source, "autonomous driving" cannot go beyond holding a straight heading, speed holding, or following a recorded path.

## 8. Minimum telemetry for the first autonomous driving test

Already available in schema 2, no protocol change needed:

`placement` (x, z, heading), `speedMps`, `localVelocityMps`, `localAngularVelocityRps`, `wheelSteeringRot`, `steeringEffective`, `throttleEffective`, `brakeEffective`, `gear`, `parkingBrake`, `engineEnabled`, `pluginState`, `simulationTimeUs`, `sequence`/`session`.

Nice-to-have, additive (new optional fields, no schema bump): wheel positions + radius (wheelbase), `wear.*`, `wheel.on_ground`, `wheel.substance`, blinkers.

Not telemetry but required: a reference path (recorded or from map data), a steering output channel, and an emergency override.

A realistic first test is **closed-loop path following on a short recorded or synthetic straight/gentle-curve path at low speed** (speed hold + lateral controller on `placement`/`heading`), supervised, with the human able to override instantly. It needs no road/lane perception.

## 9. Required protocol / architecture changes

Telemetry (RoadPilot-Telemetry, additive within schema 2, unknown fields are ignored per the protocol):

1. Parse truck configuration: `wheels.count`, `wheel.position`, `wheel.radius`, `wheel.steerable` (already parsed), `wheel.powered`, `hook.position`; expose as `truckConfig.wheels[]` and a calculated wheelbase. Static data, sent only on change like the rest of `truckConfig`.
2. Optional dynamic fields: `wear.*`, per-wheel `onGround`/`substance`, blinkers.
3. Trailer channels and config: defer until trailers are in scope.
4. Update `PROTOCOL-V2.md`, JSON schema, fixtures, Rust model and C++ tests together (existing pattern).

Control (RoadPilot-SDK / app):

5. Input protocol v2: add a **steering** axis (plus keep throttle/brake and the fail-safe rules); version bump per the existing rule. Keep the 250 ms stale timeout.
6. Decide DLL layout: two DLLs (current) vs one DLL exporting telemetry and input. Recommendation: keep two until both are live-verified.
7. App: add a Rust control task fed by full-rate frames, separate from the 10 Hz UI engine, with an arm/disarm state machine and automatic disarm on telemetry loss, `paused`, driver pedal input, or stale frames.

Geometry:

8. Define a path interface (list of world-space points + speed) that both a recorded path and RoadPilot-Map can fill. Map integration is a later phase.

## 10. Recommended implementation order

1. **Live-verify the existing schema 2 telemetry in ATS and ETS2** (position, heading sign, steering sign, units). Everything else builds on these conventions. Needs a game session, which this phase deliberately did not use.
2. Add the additive config/field extensions from section 9 (wheel geometry first).
3. Input protocol v2 with steering axis; live-verify binding and sign in game.
4. Control task in the app (open-loop test of the output path first: fixed small steering, fixed throttle, with kill switch).
5. Path interface and a lateral + speed controller against a recorded/synthetic path.
6. Map-based route/lane geometry (RoadPilot-Map), then perception topics (traffic, signals), which the SDK cannot supply.

## 11. Concrete next development step (Phase 4.2 candidate, not started)

Extend the telemetry plugin and protocol with **truck wheel geometry from the configuration event** (`wheels.count`, `wheel.position`, `wheel.radius`, `wheel.powered`, `hook.position`), exposed as additive `truckConfig` fields plus a calculated wheelbase in the Rust normalizer. It is small, fully testable offline (C++ serializer tests, shared fixtures, Rust decode tests), needs no ATS/ETS2 session, and gives the controller the vehicle model it needs. In parallel, schedule the live verification session from step 1 as the first thing to do with a game running.

## 12. Housekeeping notes

- The visualization docs state vehicle dimensions are currently reported as `null`; step 2 above is what fills that.
- This report was not committed. Committing goes through `roadpilot-git.ps1` per CLAUDE.md.
