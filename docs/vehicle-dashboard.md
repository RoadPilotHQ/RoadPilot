# Vehicle data dashboard

The **Vehicle Data** section of the dashboard shows the truck's state from ETS2 or ATS telemetry. It is a **display only**: it reads the existing telemetry path described in [telemetry.md](telemetry.md), adds no control path, sends nothing to the game and changes nothing in the control pipeline (which stays in dry run, supervisor disabled; see [control.md](control.md)).

> **Status:** implemented and covered by automated tests with synthetic data and an offline replay of recorded drives. **Not verified in a running game.** Which values ETS2 and ATS actually deliver is tracked in [telemetry.md](telemetry.md#verification-status).

## Layout

Ordered by priority, inside one card:

1. **Link strip** — link state, game, time of the last update and its age; a pause tag while the game is paused.
2. **Speed** — large readout in the display unit, the same speed in the other unit system, a _Reversing_ tag, cruise control and its set speed.
3. **Engine speed and gear** — gear (N, R1 …), engine speed with a meter against the truck's RPM limit, gear status (forward / neutral / reverse), the gear the in-game dashboard shows, the gearbox (forward and reverse gear counts).
4. **Fuel** — level in % with a meter (calculated by RoadPilot, marked `*`), amount of capacity, average consumption and range (both calculated by the game), the game's low-fuel warning, AdBlue.
5. **Engine** — engine state (running / ignition on, engine off / off), coolant and oil temperature, oil pressure, battery voltage.
6. **Vehicle and brakes** — odometer, parking brake, brake pedal, engine brake, retarder level of steps, brake air pressure, brake temperature.
7. **Data source** — game, telemetry game version, schema, frame sequence number, values rejected in this frame (their wire paths as tooltip), the display units.

Columns: three above 1000 px window width, two from 721 to 1000 px, one at 720 px and below. Panels shrink rather than overflow, and the speed readout scales with the window. Checked in a headless browser at 1280 and 500 px (the smallest window the headless browser renders) and by layout tests on the stylesheet.

## Link states

The backend's six connection states (see [telemetry.md](telemetry.md#connection-states)) are shown as five link states:

| Link state     | Backend state(s)                                 | Values shown                  |
| -------------- | ------------------------------------------------ | ----------------------------- |
| `disconnected` | `disconnected`                                   | Demo values, labelled as demo |
| `connecting`   | `connecting`                                     | Demo values, labelled as demo |
| `connected`    | `connected` (also while paused)                  | Live values                   |
| `stale`        | `reconnecting`, or `connected` with an old frame | None (_No data_)              |
| `error`        | `unavailable` (no telemetry), `error` (pipe)     | Demo values, labelled as demo |

**Freshness.** Every live frame carries RoadPilot's receive time. The strip shows it as clock time and age (`Last update 14:02:31 · 0.2 s ago`). The backend clears values 2 s after the last frame (`reconnecting`). If even that update does not arrive, the dashboard turns `stale` on its own once the newest frame is older than **3 s** (`LOCAL_STALE_AFTER_MS`) and stops showing the values. A paused game stays `connected` with its last values, however old, because a paused game may stop sending frames. While stale, the age of the session's last frame keeps counting; it is dropped when the game changes or exits.

**ATS or ETS2.** While connected the game comes from the telemetry frame itself (`game` field of the plugin); before that, from process detection (`eurotrucks2.exe`, `amtrucks.exe`). Units, the game name and the currency follow it.

## Value states

Every value is one of:

| State       | Text                            | Meaning                                                                                                                        |
| ----------- | ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| value       | the value                       | Current and valid                                                                                                              |
| missing     | _Not available_                 | Supported, but this game, plugin (schema 1) or frame did not provide it — e.g. AdBlue in ATS                                   |
| invalid     | _Invalid value_ (red)           | Removed by the telemetry reader as non-finite or implausible (listed in `invalidFields`), or rejected again at the UI boundary |
| no data     | _No data_                       | No current telemetry: interrupted, stale, or a whole section absent                                                            |
| unsupported | _Not provided by the telemetry_ | The RoadPilot telemetry protocol does not carry it at all                                                                      |

Non-values are muted and never formatted like data; zero and `false` are values. The UI boundary rejects a value of the wrong type, a non-finite number, a fractional gear or count, a negative amount or a fuel percentage outside 0–100, so a defect can never reach the screen as a number. Calculated values (fuel %) are marked `*`; game estimates and approximated temperatures say so in their tooltip.

**Demo data** appears only while not connected, always under the global _Demo data_ banner, with a _Demo_ tag on the card, muted readouts, _Sample values_ in the data source panel and _Demo data · not from a game_ in the strip. It is never mixed with live values.

## Units

The data model always keeps the telemetry units (km/h, km, l, l/100 km, °C, psi). Conversion happens only for display. The unit choice (_Auto_, _Metric_, _US_) is stored locally with the other preferences; _Auto_ shows metric units for ETS2 and US customary units for ATS.

| Quantity    | Metric   | US customary                          |
| ----------- | -------- | ------------------------------------- |
| Speed       | km/h     | mph                                   |
| Distance    | km       | mi                                    |
| Volume      | l        | US gal                                |
| Consumption | l/100 km | mpg (US); none for a consumption of 0 |
| Temperature | °C       | °F                                    |
| Pressure    | bar      | psi                                   |

## Supported vehicle data

From `TelemetryUpdate.data.vehicle` (sources and units in [telemetry.md](telemetry.md#vehicle)):

| Requested                   | Shown as                                                        | Field(s)                                                                                                                           |
| --------------------------- | --------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| Speed (km/h, mph)           | Speed                                                           | `speedKmh` (signed)                                                                                                                |
| Engine RPM                  | Engine speed, meter                                             | `engineRpm`, `rpmLimit`                                                                                                            |
| Engine status               | Engine state                                                    | `engineRunning`, `electricOn`                                                                                                      |
| Engine temperature          | Coolant and oil temperature                                     | `waterTemperatureC`, `oilTemperatureC` (approximated by the game)                                                                  |
| Current gear, gear status   | Gear, gear status, in-game display, gearbox                     | `gear`, `displayedGear`, `forwardGears`, `reverseGears`                                                                            |
| Fuel level, capacity        | Fuel %, amount of capacity                                      | `fuelL`, `fuelCapacityL`, `fuelPercent` (calculated)                                                                               |
| Consumption                 | Average consumption                                             | `fuelConsumptionLPer100km` (game average; ATS mostly static)                                                                       |
| Remaining range             | Estimated range                                                 | `fuelRangeKm` (game estimate, not calculated by RoadPilot)                                                                         |
| Odometer                    | Odometer                                                        | `odometerKm`                                                                                                                       |
| Brake status, parking brake | Parking brake, brake pedal, engine brake, retarder, air, temp.  | `parkingBrake`, `dynamics.brakeInput`, `engineBrake`, `retarderLevel`, `retarderSteps`, `brakeAirPressurePsi`, `brakeTemperatureC` |
| Further values              | Cruise control, low-fuel warning, AdBlue, oil pressure, voltage | `cruiseControlOn`, `cruiseControlKmh`, `fuelWarning`, `adblueL`, `adblueCapacityL`, `oilPressurePsi`, `batteryVoltageV`            |

`odometerKm`, `oilPressurePsi`, `brakeAirPressurePsi`, `brakeTemperatureC`, `rpmLimit`, `forwardGears` and `reverseGears` were already decoded and validated by `roadpilot-telemetry-client`; this phase passes them through `telemetry::normalize` unchanged. RoadPilot-Telemetry, the SDK and the input plugin were not changed.

**Not available from the telemetry** (shown as _Not provided by the telemetry_): engine load, automatic/manual transmission mode, lights (beams, indicators, hazard lights), brake lights. The SCS SDK has channels for some of these (light states, shifter type), but the RoadPilot telemetry plugin does not send them; adding them is a change to RoadPilot-Telemetry and needs a separate approval. **Weather, rain, traffic** are not in the SDK at all.

**Game-specific:** AdBlue is not provided by ATS (_Not available_). Schema 1 plugins provide only speed, RPM and gear; the data source panel says so.

## Components and data model

| Part                                    | Role                                                                                                                                                |
| --------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/domain/types.ts`                   | `VehicleData` (all vehicle values, telemetry units), `TelemetryMeta`, snapshot fields `telemetry`, `lastFrameAtUnixMs`, `error`, preference `units` |
| `src/domain/vehicle.ts`                 | `Reading<T>`, `link()` (link state and age), `readVehicle()`, wire path → field map for invalid values, unsupported list                            |
| `src/domain/units.ts`                   | Unit system resolution and conversions                                                                                                              |
| `src/backend/dashboardSource.ts`        | Maps `telemetry:update` to the snapshot, rejects impossible values, keeps the last frame time while stale                                           |
| `src/ui/vehicle/VehicleDashboard.tsx`   | The section: link strip and the six panels                                                                                                          |
| `src/ui/vehicle/parts.tsx`              | `Panel`, `ValueRow` (with value state), `Meter`                                                                                                     |
| `src/ui/vehicle/format.ts`, `useNow.ts` | Formatting (no `-0`, locale), a 500 ms clock for the data age                                                                                       |

The section replaces the former `VehicleDataCard`. It reuses the existing telemetry source (`telemetrySource.ts`, event `telemetry:update`); there is no second telemetry implementation.

## Tests

No game, no test drive, no live sink. All data is synthetic or replayed:

- **Rust** `telemetry::normalize` — the shared schema 2 fixture now also checks odometer, pressures, brake temperature, RPM limit and gear counts; missing stays missing.
- **Rust** `telemetry::dashboard_replay` — offline replay of the recorded ATS calibration drive and the Stage B drive (`tests/fixtures/replay/`) through `normalize` and the connection state machine at the recorded frame timing: every frame is shown with its sequence, speeds match the recording, nothing else is invented, gaps over 2 s turn stale without values (a paused game stays connected), and after the game exits the last frame never returns.
- **Frontend** `units.test.ts`, `vehicle.test.ts` — conversions, auto units per game, link states, local staleness, pause, clock going backwards, value states, invalid path mapping (checked against every vehicle path the client validates).
- **Frontend** `telemetrySource.test.ts` — complete mapping, invalid values from the reader, wrong types and ranges at the UI boundary, last frame age across interruptions, games and exits, error detail.
- **Frontend** `VehicleDashboard.test.tsx` — demo labelling, all ETS2 values in metric units, ATS → exit → ETS2 with units following the game, explicit unit choice, invalid / missing / unsupported, impossible values, schema 1, staleness over simulated time and recovery, pause, unavailable and pipe errors, layout rules for small windows.
- **Frontend** `App.telemetry.test.tsx` — the whole dashboard with the new section.
