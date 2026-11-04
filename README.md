# RoadPilot

RoadPilot is a desktop application project for Euro Truck Simulator 2 (ETS2) and American Truck Simulator (ATS). The current release is an early dashboard prototype. It reads live game telemetry (vehicle, driving dynamics, position, job, navigation and game time) through the RoadPilot telemetry plugin, shows clearly marked demo values when no game is connected, and never controls the game.

## Run the desktop app

Install Node.js 22.12 or newer, Rust, the Microsoft C++ Build Tools, and the WebView2 Runtime on Windows. From this repository, install the JavaScript dependencies once and launch the native window:

```powershell
npm install
npm run desktop
```

This opens RoadPilot in its own desktop window. To create a Windows installer, run:

```powershell
npm run desktop:build
```

The installer is written under `src-tauri/target/release/bundle/`.

For browser-only UI development, `npm run dev` remains available. It runs the Vite development server at `http://127.0.0.1:1420`.

## Verify changes

```powershell
npm run check
npm run build
```

## Current dashboard behavior

- The connection badge shows the state reported by the Rust telemetry engine: game not running, connecting, connected, paused, reconnecting, telemetry unavailable or error.
- While connected, the dashboard shows **Live data** in the Vehicle Data, Driving Dynamics, Current Job, Route Progress, Navigation and Environment cards. Values the game does not provide are shown as **Not available**; weather and rain are not part of the SCS telemetry SDK and are shown as **Not provided by the game**. Values RoadPilot calculates from game data are marked with `*` or `≈`.
- Otherwise, sample vehicle and job values are labeled **Demo data** and are never mixed with live telemetry.
- Autopilot and assistance features are marked **Planned**. Their switches only save local preferences; they do not control the game.
- English is bundled as the default locale. Translation keys are centralized in `src/i18n/en.ts`; the separate [RoadPilot-Language repository](https://github.com/RoadPilotHQ/RoadPilot-Language) remains the home for future language bundles.

## Repository boundaries

RoadPilot is developed in separate repositories. This repository owns the desktop shell, dashboard, application architecture, and future vehicle integration.

| Repository | Responsibility |
|---|---|
| **RoadPilot** (this repository) | Main desktop application |
| [RoadPilot-Map](https://github.com/RoadPilotHQ/RoadPilot-Map) | Map processing and geographic data |
| [RoadPilot-Telemetry](https://github.com/RoadPilotHQ/RoadPilot-Telemetry) | Game telemetry plugin and reader |
| [RoadPilot-Language](https://github.com/RoadPilotHQ/RoadPilot-Language) | Translation bundles |
| [RoadPilot-Visualization](https://github.com/RoadPilotHQ/RoadPilot-Visualization) | Visualization components and development tools |
| [RoadPilot-Plugin](https://github.com/RoadPilotHQ/RoadPilot-Plugin) | Plugin architecture and SDK |
| [RoadPilot-Website](https://github.com/RoadPilotHQ/RoadPilot-Website) | Official website |
| [RoadPilot-Discord](https://github.com/RoadPilotHQ/RoadPilot-Discord) | Discord community infrastructure |
| [RoadPilot-Docs](https://github.com/RoadPilotHQ/RoadPilot-Docs) | Central documentation |

RoadPilot-Telemetry is in use for live game telemetry. The other integrations and interfaces are planned; they are not active in the dashboard yet.

## Status

The React dashboard runs inside a Tauri 2 desktop window. Read-only game telemetry (protocol schema 2) is integrated; fields, units, coordinate conventions, setup, data flow and limitations are described in [docs/telemetry.md](docs/telemetry.md). Live telemetry requires the `roadpilot-telemetry.dll` plugin from [RoadPilot-Telemetry](https://github.com/RoadPilotHQ/RoadPilot-Telemetry) in the game's plugin folder. Vehicle control and the planned assistance features are not implemented.

| Game | Implementation | Live verification |
|---|---|---|
| American Truck Simulator | Implemented (schema 2) | Schema 1 plugin **verified** in ATS 1.62.x: speed, RPM, gear, connect, pause/resume, game exit, reconnect. **Schema 2 fields not yet tested in the game.** |
| Euro Truck Simulator 2 | Implemented (same shared code path as ATS) | **Not yet tested.** Requires `roadpilot-telemetry.dll` in the ETS2 plugin folder; a manual live test is planned |

Automated tests cover the protocol, conversions, connection states and the dashboard with mocked data; they do not prove that the game delivers each value. See the per-field table in [docs/telemetry.md](docs/telemetry.md#verification-status).

## Contributing

The contribution process is still being defined. Please open an issue or discussion before starting larger work so it can be coordinated. Project contributions and documentation should be written in English.

## License

Licensing is undecided. No license has been selected, and no permission is granted beyond what the GitHub Terms of Service allow.

Euro Truck Simulator 2 and American Truck Simulator are trademarks of SCS Software. RoadPilot is not an official SCS Software product.
