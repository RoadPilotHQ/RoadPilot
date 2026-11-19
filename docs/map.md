# Road map (RoadPilot-Map packages)

RoadPilot can show the real ETS2 and ATS road network from a **RoadPilot-Map package** that the user generates from their own game installation. The map is for **display only**: nothing in it is used by control, and it is never a basis for steering.

> **Status (Phase 2.4A):** package selection, validation, background loading and the map status are implemented and tested with synthetic packages; real ETS2 and ATS packages load in an opt-in test. Display data, tiles and drawing follow in 2.4B and 2.4C. Telemetry positions are **not** placed on the map (see [Coordinates](#coordinates)).

## Getting a package

RoadPilot never searches for game installations, never reads `.scs` archives and never generates packages. Generate one with the [RoadPilot-Map](https://github.com/RoadPilotHQ/RoadPilot-Map) command-line tool, one per game:

```
roadpilot-map build-package --game ets2 --game-dir "<ETS2 folder>" --out "<package folder>" [--without-navigation]
roadpilot-map check-package "<package folder>"
```

The navigation file is not used by RoadPilot; `--without-navigation` saves about 420–460 MB. Then enter the package folder in the dashboard: **Navigation → Map package**. The folder is stored per game in the local preferences (`roadpilot.preferences.v1`, `mapPackages`).

A package is derived from the user's game files and marked `local_use_only`. Keep it on the computer that generated it and do not share it; whether derived data may be shared is an open legal question (RoadPilot-Map L1/L2). Regenerate it after a game update: a package records no game version, so RoadPilot cannot tell whether it is current.

## Dependency

`src-tauri/Cargo.toml` pins the package reader:

```toml
roadpilot-map-package = { git = "https://github.com/RoadPilotHQ/RoadPilot-Map.git", rev = "77e60941c00ed156c1526f891b10c443a46af0fd" }
```

It brings only `roadpilot-map-model` from the same repository, no third-party crate. RoadPilot reads packages exactly as specified in RoadPilot-Map `docs/formats/map-package.md` (schema 1) and never writes them.

## Loading (`src-tauri/src/map/`)

| Module       | Role                                                                                                                                               |
| ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `loader.rs`  | Manifest check (schema major 1, game), then `MapPackage::open`: every file against size and checksum, geometry read and validated, counts compared |
| `service.rs` | One package at a time; background loading; release on every change of game or folder; overtaken loads are discarded                                |
| `status.rs`  | The status sent to the dashboard                                                                                                                   |

Commands: `map_select(game, path, reload)` and `map_status`; event `map:status`.

The dashboard selects the map of the **connected game**; while no game is connected, the map of the last game (or the one the user picks) stays on screen. When the game changes, the previous map is released before the next one is loaded, so ETS2 geometry can never appear while ATS is active, or the other way round.

### Map states

| State                 | Meaning                                                                                                                                                                           |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `none`                | No folder configured for the game                                                                                                                                                 |
| `selecting`           | Manifest is being checked                                                                                                                                                         |
| `loading`             | Files verified and geometry read (`phase`: `reading`, then `preparing`)                                                                                                           |
| `ready`               | Loaded; content id, schema, counts, bounds and load time are reported                                                                                                             |
| `error`               | `not_found`, `unreadable`, `not_a_package`, `invalid_manifest`, `file_mismatch` (missing file, size or checksum), `corrupt_geometry` (e.g. no footer), `inconsistent`, `unusable` |
| `game_mismatch`       | The manifest names the other game; the package is not loaded                                                                                                                      |
| `unsupported_version` | Schema major version other than 1                                                                                                                                                 |

Error details never contain directory paths. A failed or missing map never affects the rest of the dashboard; the traveled-path view stays available.

## Coordinates

Map positions are drawn in the package's own coordinates (X east, Z south, ÷256 world units; the physical unit is unconfirmed, RoadPilot-Map T3). Telemetry positions are **not** drawn on the map. An offline comparison in the Phase 2.4 audit found ATS telemetry and the ATS package consistent without transformation in one region of about 2 × 3 km; ETS2 is unverified. Placing the truck or its path on the map needs a separate verification and decision (Phase 2.4D).

## Measured

On the development machine, release build, warm file cache:

| Package                     | Content id         | Nodes / roads     | Geometry file | Load (verify + read) |
| --------------------------- | ------------------ | ----------------- | ------------- | -------------------- |
| ATS (generated 2026-11-05)  | `cba63760bde5b3a1` | 902,347 / 224,870 | 462.0 MB      | 6.0 s                |
| ETS2 (generated 2026-11-19) | `20ae70ba19c404c8` | 807,602 / 252,368 | 451.2 MB      | 6.8 s                |

## Tests

Synthetic packages are written in the tests with the RoadPilot-Map writer (`src-tauri/src/map/testkit.rs`) into a temporary folder; no game data is in the repository. Covered: valid ATS and ETS2 packages, missing folder and manifest, corrupt manifest, damaged and missing geometry file (checksum), geometry without footer, unsupported schema major, wrong game, game switching and release of the previous map, overtaken loads, retry after a failure, the IPC commands, and in the frontend the folder selection per game, its persistence, following the connected game and every state text. `real_packages_load` loads real packages when `ROADPILOT_MAP_PACKAGE_ATS` / `ROADPILOT_MAP_PACKAGE_ETS2` are set (ignored otherwise).
