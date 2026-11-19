# Road map (RoadPilot-Map packages)

RoadPilot can show the real ETS2 and ATS road network from a **RoadPilot-Map package** that the user generates from their own game installation. The map is for **display only**: nothing in it is used by control, and it is never a basis for steering.

> **Status (Phase 2.4B):** package selection, validation, background loading, the map status, the display data and binary map tiles are implemented and tested with synthetic packages; real ETS2 and ATS packages load in an opt-in test. Drawing follows in 2.4C. Telemetry positions are **not** placed on the map (see [Coordinates](#coordinates)).

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
| `display.rs` | Display geometry: estimated curves as polylines, simplified per level of detail, indexed by tile                                                   |
| `tiles.rs`   | Binary tile format, encoder and the in-memory LRU tile cache                                                                                       |

Commands: `map_select(game, path, reload)`, `map_status` and `map_tile(game, contentId, level, x, z)`; event `map:status`.

Loading uses the reference reader's `verify_files` and `read_geometry` and compares the record counts with the manifest: the same checks as `MapPackage::open`, without its spatial index, which RoadPilot does not use. After the display data is built, the raw records are released; only the display data stays in memory.

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

## Display data and tiles

`display.rs` evaluates each road's **estimated** curve (cubic Hermite through the node positions with the node travel directions and the stored tangent scale, as specified for schema 1), samples it every 2 world units and simplifies it with Douglas-Peucker per level. A road without a curve is drawn as the straight line between its nodes (flag `chord`); a curve that does not reproduce the stored length is flagged (`length off`). Roads with missing nodes or non-finite geometry are skipped and counted, never drawn with made-up geometry. Coordinates stay in the package's world space.

**Road class** (display heuristic, not a category of the game): from the lane types of the road look, which differ between the games.

| Class      | Lane types                                                                 |
| ---------- | -------------------------------------------------------------------------- |
| `motorway` | `traffic_lane.road.freeway*` (ATS), `traffic_lane.road.motorway*` (ETS2)   |
| `primary`  | `traffic_lane.road.divided*` (ATS), `traffic_lane.road.expressway*` (ETS2) |
| `local`    | any other lane type, including unknown ones                                |
| `minor`    | `traffic_lane.no_vehicles*`, or no lane data                               |
| `rail`     | only `traffic_lane.rail.*` lanes (tracks stored as roads)                  |

**Levels of detail:**

| Level | Tile edge (units) | Simplification | Classes shown            |
| ----- | ----------------- | -------------- | ------------------------ |
| 0     | 1,024             | 0.5            | all                      |
| 1     | 4,096             | 4              | motorway, primary, local |
| 2     | 16,384            | 32             | motorway, primary        |
| 3     | 65,536            | 160            | motorway                 |

A road is listed in every tile its simplified shape touches, most important class first.

**Tile format** (`map_tile` answers with raw bytes, never JSON; version 1, little endian, sections 4-byte aligned):

| Offset | Size  | Field                                                                                                                        |
| ------ | ----- | ---------------------------------------------------------------------------------------------------------------------------- |
| 0      | 4     | magic `RPMT`                                                                                                                 |
| 4      | 2     | format version (1)                                                                                                           |
| 6      | 1     | level                                                                                                                        |
| 7      | 1     | flags (bit 0: truncated)                                                                                                     |
| 8, 12  | 4 + 4 | tile x, z (i32); the tile covers `[x·size, (x+1)·size) × [z·size, (z+1)·size)`                                               |
| 16     | 4     | tile size (f32)                                                                                                              |
| 20     | 4     | reserved                                                                                                                     |
| 24, 32 | 8 + 8 | origin x, z (f64)                                                                                                            |
| 40, 44 | 4 + 4 | road count R, point count P (u32)                                                                                            |
| 48     | 8     | package content id (u64)                                                                                                     |
| 56     | 12·R  | per road: road index (u32), first point (u32), point count (u16), class (u8), flags (u8: 1 estimated, 2 chord, 4 length off) |
| …      | 8·P   | points x, z (f32) relative to the origin                                                                                     |

Limits: at most 30,000 roads and 120,000 points per tile (about 1.3 MB); a fuller tile drops its least important roads and sets the truncated flag. The frontend decoder (`src/domain/mapTile.ts`) rejects anything that does not match the request exactly (tile, level, size, content id), has inconsistent counts or offsets, unknown classes or flags, or non-finite coordinates. A golden tile (`GOLDEN_TILE_HEX`) is produced by the Rust encoder and decoded by the frontend tests, so both sides stay in step.

**Cache:** encoded tiles are kept in an LRU cache of 64 MiB keyed by content id, level and tile; it is cleared whenever the map is released. A tile is encoded under the cache lock, so two requests for one tile never encode it twice. A request must name the loaded package's content id: a request made for a previous package is refused (`wrong_map`), as is a request for the other game (`not_ready`) or out of range (`invalid_request`). No derived data is written to disk.

## Coordinates

Map positions are drawn in the package's own coordinates (X east, Z south, ÷256 world units; the physical unit is unconfirmed, RoadPilot-Map T3). Telemetry positions are **not** drawn on the map. An offline comparison in the Phase 2.4 audit found ATS telemetry and the ATS package consistent without transformation in one region of about 2 × 3 km; ETS2 is unverified. Placing the truck or its path on the map needs a separate verification and decision (Phase 2.4D).

## Measured

On the development machine, release build, warm file cache. Packages:

| Package                     | Content id         | Nodes / roads     | Geometry file |
| --------------------------- | ------------------ | ----------------- | ------------- |
| ATS (generated 2026-11-05)  | `cba63760bde5b3a1` | 902,347 / 224,870 | 462.0 MB      |
| ETS2 (generated 2026-11-19) | `20ae70ba19c404c8` | 807,602 / 252,368 | 451.2 MB      |

Loading including the display data (opt-in test process, private bytes sampled every 100 ms):

| Measure                            | ATS                      | ETS2                       | Target             |
| ---------------------------------- | ------------------------ | -------------------------- | ------------------ |
| Load (verify, read, prepare)       | 6.4 s                    | 6.5–8.1 s                  | ≤ 10 s             |
| Peak private memory while loading  | 301 MiB                  | 315 MiB                    | ≤ 350 MiB          |
| Private memory with the map loaded | 49 MiB                   | 50 MiB                     | ≤ 150 MiB          |
| Display data (allocation estimate) | about 30 MiB             | about 30 MiB               |                    |
| Points, levels 0 / 1 / 2 / 3       | 829k / 395k / 152k / 83k | 1,047k / 435k / 113k / 90k |                    |
| Largest tile                       | 237 KB (level 3)         | 416 KB (level 3)           | ≤ 1.3 MB           |
| 48-tile viewport, encoded cold     | 0.1–2.2 ms per level     | 0.1–1.5 ms per level       | ≤ 50 ms end to end |

The first version used `MapPackage::open`; its unused spatial index raised the ETS2 peak to 355 MiB, above the target. The viewport figure is the encoding in the backend only; IPC and drawing are measured in the application (2.4C).

## Tests

Synthetic packages are written in the tests with the RoadPilot-Map writer (`src-tauri/src/map/testkit.rs`) into a temporary folder; no game data is in the repository. Covered: valid ATS and ETS2 packages, the curve evaluation, classification of both games' lane types, simplification tolerance, tile membership across tile borders, empty tiles, the response limit with minor roads dropped first, cache eviction and invalidation, game and content-id separation, the golden tile, malformed tiles in the decoder, a 7,200-road synthetic network, missing folder and manifest, corrupt manifest, damaged and missing geometry file (checksum), geometry without footer, unsupported schema major, wrong game, game switching and release of the previous map, overtaken loads, retry after a failure, the IPC commands, and in the frontend the folder selection per game, its persistence, following the connected game and every state text. `real_packages_load` loads real packages when `ROADPILOT_MAP_PACKAGE_ATS` / `ROADPILOT_MAP_PACKAGE_ETS2` are set (ignored otherwise).
