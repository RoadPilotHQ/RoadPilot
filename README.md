# RoadPilot

RoadPilot is a desktop application project for Euro Truck Simulator 2 (ETS2) and American Truck Simulator (ATS). The current release is an early dashboard prototype: it displays clearly marked demo values and does not connect to or control either game.

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

- The ETS2 badge reports a connection state supplied by the backend boundary. The current offline source reports **Disconnected**.
- Sample vehicle and job values are labeled **Demo data** and are never represented as live telemetry.
- Autopilot and assistance features are marked **Planned**. Their switches only save local preferences; they do not control the game.
- English is bundled as the default locale. Translation keys are centralized in `src/i18n/en.ts`; the separate [RoadPilot-Language repository](https://github.com/RoadPilotHQ/RoadPilot-Language) remains the home for future language bundles.

## Repository boundaries

RoadPilot is developed in separate repositories. This repository owns the desktop shell, dashboard, application architecture, and future vehicle integration.

| Repository | Responsibility |
|---|---|
| **RoadPilot** (this repository) | Main desktop application |
| [RoadPilot-Map](https://github.com/RoadPilotHQ/RoadPilot-Map) | Map processing and geographic data |
| [RoadPilot-Language](https://github.com/RoadPilotHQ/RoadPilot-Language) | Translation bundles |
| [RoadPilot-Visualization](https://github.com/RoadPilotHQ/RoadPilot-Visualization) | Visualization components and development tools |
| [RoadPilot-Plugin](https://github.com/RoadPilotHQ/RoadPilot-Plugin) | Plugin architecture and SDK |
| [RoadPilot-Website](https://github.com/RoadPilotHQ/RoadPilot-Website) | Official website |
| [RoadPilot-Discord](https://github.com/RoadPilotHQ/RoadPilot-Discord) | Discord community infrastructure |
| [RoadPilot-Docs](https://github.com/RoadPilotHQ/RoadPilot-Docs) | Central documentation |

These integrations and interfaces are planned; they are not active in the dashboard yet.

## Status

The React dashboard runs inside a Tauri 2 desktop window. Game telemetry, vehicle control, and the other planned assistance features are not implemented yet.

## Contributing

The contribution process is still being defined. Please open an issue or discussion before starting larger work so it can be coordinated. Project contributions and documentation should be written in English.

## License

Licensing is undecided. No license has been selected, and no permission is granted beyond what the GitHub Terms of Service allow.

Euro Truck Simulator 2 and American Truck Simulator are trademarks of SCS Software. RoadPilot is not an official SCS Software product.
