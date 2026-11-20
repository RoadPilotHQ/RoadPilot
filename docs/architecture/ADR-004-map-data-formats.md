# ADR-004: Map data formats — package, RPMT, MVT, PMTiles, GeoJSON

## 1. Status

**Proposed** (Phase 2.4D B0, 2026-11-21). Provisional recommendation: **keep the RoadPilot-Map package as the storage format and RPMT as the internal tile channel; do not adopt PMTiles.** If MapLibre passes B1 (ADR-003), add an MVT encoding of the same tiles in the MapService, generated on demand, instead of a stored tileset. Includes the licensing and legal review of Phase 2.4D (section 8).

## 2. Context

Two formats exist today, with different roles (FACT, code):

- **RoadPilot-Map package** (storage): a folder with `manifest.json` and `geometry.jsonl` (schema 1.0, JSON Lines), generated locally from the user's game installation by RoadPilot-Map; integers in 1/256 world units; checksums per file; `distribution: local_use_only` ([map.md](../map.md); RoadPilot-Map ADR 0002). ATS 462.0 MB, ETS2 451.2 MB of geometry.
- **RPMT** (transport, not stored): binary tiles produced on request by the Rust MapService from in-memory display data and sent over Tauri IPC; magic `RPMT`, version 1, 56-byte header with `f64` origin and `u64` content id, 12 bytes per road, `f32` points relative to the origin; at most 30,000 roads / 120,000 points (about 1.3 MB) per tile; four levels with tile sizes 1024 · 4ⁿ units (`src-tauri/src/map/tiles.rs:31-45, 97-124`; `display.rs:74-100`; [map.md](../map.md)). A golden tile keeps the Rust encoder and the TypeScript decoder (`src/domain/mapTile.ts`) in step.

**MEASUREMENT** ([map.md](../map.md#measured), release build): loading a package 6.4–8.1 s, peak private memory 301–315 MiB while loading, 49–50 MiB with the map loaded, display data about 30 MiB; a 48-tile viewport encodes in 0.1–2.2 ms per level; largest tile 237 KB (ATS) / 416 KB (ETS2).

## 3. Requirements

- R1. Fully offline; the data never leaves the user's machine (until L2 is resolved, section 8).
- R2. Random access by tile and level, fast enough for interactive pan and zoom.
- R3. Provenance: content id, schema version, generator, source archives, limitations travel with the data.
- R4. Readable in Rust (MapService) and TypeScript (renderers).
- R5. Native coordinates (ADR-002).
- R6. No migration without a measurable benefit.

## 4. Options considered

| Criterion            | Package (JSONL)                                                    | RPMT                                     | MVT (Mapbox Vector Tile)                                                           | PMTiles                                                                          | GeoJSON                                                               | Native SCS sectors                    |
| -------------------- | ------------------------------------------------------------------ | ---------------------------------------- | ---------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- | --------------------------------------------------------------------- | ------------------------------------- |
| Role                 | Storage                                                            | Transport (in memory)                    | Tile encoding                                                                      | Tile **archive** (container)                                                     | Interchange / small layers                                            | Source (game files)                   |
| Offline              | Yes                                                                | Yes                                      | Yes                                                                                | Yes (local file or `addProtocol`)                                                | Yes                                                                   | Yes                                   |
| Random access        | No (read whole file at load)                                       | Yes, by construction (per request)       | Per tile, given a container                                                        | Yes (directory + byte ranges)                                                    | No                                                                    | By sector, through the archive reader |
| Streaming            | Sequential                                                         | Per tile over IPC                        | Per tile                                                                           | Range reads                                                                      | Whole document (or per feature with JSON Lines)                       | Per sector                            |
| Compression          | None (text)                                                        | None needed (binary, about 1.3 MB max)   | Integer delta encoding, protobuf; often gzipped                                    | Container with optional compression of tiles and directory                       | None (text)                                                           | Game's own                            |
| Size                 | 450–462 MB per game                                                | Transient                                | Smaller than RPMT for the same geometry (integer coords; HYPOTHESIS, not measured) | Pre-generated tileset on disk, **in addition** to the package                    | Several times the package (HYPOTHESIS)                                | –                                     |
| Generation           | RoadPilot-Map CLI                                                  | On demand, 0.1–2.2 ms per viewport level | Would be on demand from the same display data                                      | Separate offline build step (tile all levels, write archive)                     | Export step                                                           | –                                     |
| Rust support         | Own reader (`roadpilot-map-package`)                               | Own                                      | Encoders exist (crates not reviewed in B0)                                         | `pmtiles` crate (stadiamaps/pmtiles-rs), MIT or Apache-2.0                       | `serde_json` and others                                               | RoadPilot-Map                         |
| TypeScript support   | Not needed (Rust reads it)                                         | Own decoder                              | MapLibre native                                                                    | `pmtiles` JS, BSD-3, MapLibre `addProtocol`                                      | MapLibre native (in a planar CRS only with a CRS definition, ADR-003) | –                                     |
| Metadata, provenance | Manifest with content id, schema, generator, archives, limitations | Content id per tile                      | None beyond layer names                                                            | JSON metadata block                                                              | Free-form                                                             | –                                     |
| Large maps           | Load once, 50 MiB resident                                         | Proven at full ATS/ETS2                  | Designed for it                                                                    | Designed for it (planet scale)                                                   | Unsuitable for 450 MB of roads                                        | –                                     |
| Grid                 | –                                                                  | Own grid, 1024 · 4ⁿ units                | Any square grid (tile extent in integers)                                          | Z/X/Y addressing of a quad tree; a planar grid must be mapped onto it            | –                                                                     | 4000-unit sectors                     |
| Maintenance          | Shared with RoadPilot-Map                                          | Small, tested on both sides              | A second encoder                                                                   | A build step, a second large file per game, regeneration after every game update | Small                                                                 | –                                     |

## 5. Does RoadPilot need PMTiles?

**No — not now, and not for MapLibre either.** Reasons (FACT and MEASUREMENT above):

1. PMTiles solves serving **pre-generated** tiles from one file, typically over HTTP range requests. RoadPilot generates each tile on demand in 0.1–2.2 ms per viewport level from data already in memory; random access already exists.
2. A PMTiles archive would be a second large file per game, built in an extra step and rebuilt after every game update, for data that is already on disk as the package. No size, speed or memory problem exists that it would solve; none was measured.
3. MapLibre does not require PMTiles: any tile URL scheme can be served through `addProtocol` (ADR-003). What MapLibre requires is a tile **encoding** it understands (MVT for vector data).

**RPMT remains the internal format.** If MapLibre is adopted after B1, the MapService gets an MVT encoding of the same display tiles (same levels, grid and content id), served through the same IPC path. PMTiles is reconsidered only if a measured need appears (for example sharing tiles between processes or a much larger cold-start cost).

## 6. Decision (provisional) and consequences

- Storage: the RoadPilot-Map package (unchanged; owned by RoadPilot-Map).
- Transport: RPMT for Canvas 2D and the WebGL 2 prototype (unchanged).
- If MapLibre passes B1: an additional MVT encoding in the MapService, behind a separate decision; GeoJSON only for small RoadPilot overlays (route, truck path), never for the road network.
- No PMTiles, no migration.

## 7. Risks

- An MVT encoder doubles the tile code path (two encodings to keep in step); mitigate with a shared golden-tile test.
- MVT tiles use integer coordinates in a fixed extent; at the coarsest level a tile spans 65,536 units, so an extent of 4096 gives 16 units per step there (fine for overview, HYPOTHESIS: needs a check of visible quantisation in B1).
- The package's text size (450+ MB) and load time (6–8 s) are the real costs; they belong to RoadPilot-Map's open question T5 (binary package encoding), not to the tile format.

## 8. Legal and licensing review

Not legal advice. Statements are what the cited texts say; unresolved points are listed as such.

### SCS game data

| Question                             | Finding                                                                                                                                                                                                                                                                                                                                                           | Status                                                                                                            |
| ------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| Current SCS EULA text                | The official EULA pages tried (`eurotrucksimulator2.com/eula.php`, `americantrucksimulator.com/eula.php`) returned HTTP 404 on 2026-11-21; `scssoft.com` links no EULA. Third-party copies of an old EULA (v1.2.5.1) contain a broad clause against copying or reducing the software to machine-readable form without written consent; they are not authoritative | **Unresolved**: the current official text was not read                                                            |
| Extraction                           | SCS's official modding wiki provides the Game Archive Extractor: "You may use the provided extractor to unpack the game archive to develop game mods." It says nothing about third-party tools deriving data for other purposes                                                                                                                                   | **Unresolved**: permission is stated for mod development; RoadPilot-Map's use is not addressed (RoadPilot-Map L1) |
| Extracted geometry, derived packages | No official statement found                                                                                                                                                                                                                                                                                                                                       | **Unresolved** (RoadPilot-Map L2)                                                                                 |
| Local-only packages                  | Packages are generated on the user's machine from the user's own installation and marked `distribution: local_use_only` in the manifest; RoadPilot reads only local packages and sends nothing out                                                                                                                                                                | FACT (design); legal status unresolved                                                                            |
| Distribution of generated data       | Not permitted by any text found; RoadPilot-Map treats packages as non-shareable until L2 is resolved                                                                                                                                                                                                                                                              | **Treat as forbidden** until resolved                                                                             |
| Synthetic data (B1)                  | Contains no SCS data                                                                                                                                                                                                                                                                                                                                              | No SCS restriction applies                                                                                        |

### Third-party software

| Component                         | Licence                                                                                                               | Source                          | Consequence                              |
| --------------------------------- | --------------------------------------------------------------------------------------------------------------------- | ------------------------------- | ---------------------------------------- |
| MapLibre GL JS                    | BSD-3-Clause (plus BSD-3 mapbox-gl-js v1.13 portion, glfx.js and d3-color notices)                                    | `LICENSE.txt` in the repository | Usable; ship the notices                 |
| PMTiles reference implementations | BSD-3-Clause; the specification is public domain / CC0                                                                | `LICENSE` in protomaps/PMTiles  | Usable if ever needed                    |
| pmtiles-rs (Rust)                 | MIT or Apache-2.0                                                                                                     | stadiamaps/pmtiles-rs README    | Usable if ever needed                    |
| Protomaps basemap data            | ODbL (OpenStreetMap)                                                                                                  | Protomaps docs                  | Not relevant: RoadPilot uses no OSM data |
| truckermudgeon/maps               | GPL v3 (README: "licensed under GPL v3"; `LICENSE` is the GPLv3 text; "or later" is not stated by the project itself) | Repository README and `LICENSE` | See below                                |
| MVT encoder crates                | Not reviewed                                                                                                          | –                               | Check before use                         |

### GPL reference project

- **Using an independently licensed library** (MapLibre, PMTiles): governed by that library's licence only.
- **Studying an implementation** (reading how truckermudgeon/maps parses or projects data): ideas and facts are not copied code, but anything written after reading GPL code risks being a derivative if it reproduces its expression. RoadPilot did not inspect its source for B0, and nothing from it is used.
- **Copying GPL code** into RoadPilot: would require RoadPilot to be distributed under the GPL. **Not done and not allowed.**
- **Distributing SCS-derived map data**: a separate question from any software licence (SCS rights, above); unresolved.

RoadPilot-Map's own record (L3): ts-map (MIT) used as a reference without copying code; TruckLib (GPL-2.0) not consulted.

## 9. Open questions

1. L1/L2 (RoadPilot-Map): may a third-party tool derive map data from a local installation, and may anything derived be shared? Needs the current official EULA text or a statement from SCS.
2. Which MVT encoder (and licence) if MapLibre is adopted?
3. Is MVT quantisation visible at the coarse levels?
4. T5 (RoadPilot-Map): a binary package encoding to reduce load time and memory peak.

## 10. Evidence and references

- RoadPilot: `src-tauri/src/map/tiles.rs`, `display.rs`, `loader.rs`; `src/domain/mapTile.ts`; [map.md](../map.md) (format and measurements).
- RoadPilot-Map: ADR 0002, `docs/formats/map-package.md`, `docs/open-questions.md` (T5, L1–L6).
- PMTiles licence: https://github.com/protomaps/PMTiles/blob/main/LICENSE; pmtiles-rs: https://github.com/stadiamaps/pmtiles-rs; MapLibre PMTiles example: https://maplibre.org/maplibre-gl-js/docs/examples/pmtiles-source-and-protocol/; Protomaps with MapLibre: https://docs.protomaps.com/pmtiles/maplibre
- MapLibre licence: https://github.com/maplibre/maplibre-gl-js/blob/main/LICENSE.txt
- SCS: https://modding.scssoft.com/wiki/Documentation/Tools/Game_Archive_Extractor (read 2026-11-21); EULA pages not reachable (404) on that date.
- truckermudgeon/maps: https://github.com/truckermudgeon/maps (README, `LICENSE`).
