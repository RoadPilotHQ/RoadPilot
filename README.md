# RoadPilot

RoadPilot is a planned desktop application that adds driving assistance and autonomous driving to Euro Truck Simulator 2 (ETS2) and American Truck Simulator (ATS).

> **Status: early planning.** This repository does not contain source code yet. Responsibilities, architecture and roadmap below describe the **planned** scope, not existing functionality.

## Purpose

This repository is home to the main RoadPilot desktop application. It is meant to coordinate the whole ecosystem: it reads the game state, decides how the truck should drive, and presents everything to the user in a dashboard.

## Key responsibilities

- Desktop application
- Dashboard
- Core application architecture
- Vehicle control integration
- Driving assistance systems
- Main application coordination

## Architecture overview

The following structure is a proposal and may change as development starts:

- **Application shell**: the desktop window, settings and user interface.
- **Dashboard**: the main view showing the system state and driving assistance status.
- **Core**: coordination between the game connection, driving logic and the other RoadPilot components.
- **Vehicle control integration**: the boundary through which steering, throttle and braking commands would be sent to the game.
- **Driving assistance systems**: individual assistance functions built on top of the core.

## Integration with the RoadPilot ecosystem

RoadPilot is split into independent repositories. Each one is developed, versioned and released on its own; there is no monorepo and no shared source code.

| Repository | Role |
|---|---|
| **RoadPilot** (this repository) | Main desktop application |
| [RoadPilot-Map](https://github.com/RoadPilotHQ/RoadPilot-Map) | Map processing and geographic data |
| [RoadPilot-Language](https://github.com/RoadPilotHQ/RoadPilot-Language) | Translations and localization |
| [RoadPilot-Visualization](https://github.com/RoadPilotHQ/RoadPilot-Visualization) | Visualization components and development tools |
| [RoadPilot-Plugin](https://github.com/RoadPilotHQ/RoadPilot-Plugin) | Plugin architecture and SDK |
| [RoadPilot-Website](https://github.com/RoadPilotHQ/RoadPilot-Website) | Official website |
| [RoadPilot-Discord](https://github.com/RoadPilotHQ/RoadPilot-Discord) | Discord community infrastructure |
| [RoadPilot-Docs](https://github.com/RoadPilotHQ/RoadPilot-Docs) | Central documentation |

As the central application, RoadPilot is expected to consume map data from RoadPilot-Map, translations from RoadPilot-Language, visualization components from RoadPilot-Visualization and extensions through the interfaces defined in RoadPilot-Plugin. These interfaces are still being defined; none of them exists yet.

## Development status

| Area | Status |
|---|---|
| Source code | Not started |
| Architecture | In planning |
| Releases | None |

## Planned roadmap

Planned work, in no fixed order and without dates:

- [ ] Define the core application architecture
- [ ] Select the technology stack for the desktop application
- [ ] Design the dashboard
- [ ] Define the vehicle control integration boundary
- [ ] Specify the first driving assistance functions
- [ ] Define the interfaces to the other RoadPilot repositories

## Contributing

RoadPilot is at an early stage and the contribution process is still being defined. Shared guidelines are planned in [RoadPilot-Docs](https://github.com/RoadPilotHQ/RoadPilot-Docs).

Until then, please open an issue or start a discussion before starting any work, so it can be coordinated. All contributions, issues and documentation must be written in English.

## License

Licensing is currently undecided. No license has been selected for this repository yet. Until a license is published here, no permission is granted to use, copy, modify or distribute its contents beyond what the GitHub Terms of Service allow.

---

Euro Truck Simulator 2 and American Truck Simulator are trademarks of SCS Software. RoadPilot is not an official SCS Software product.
