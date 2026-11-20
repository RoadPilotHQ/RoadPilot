# ADR-002: Coordinate system for the in-game map

## 1. Status

**Proposed** (Phase 2.4D B0, 2026-11-21). Provisional recommendation: keep the native SCS world coordinates (option A), shown north-up through a fixed axis flip. No transformation is introduced by this ADR. The unit and the alignment with telemetry are only partly verified (ATS) or not verified (ETS2); see the matrix in section 9.

## 2. Context

RoadPilot shows the road network from a RoadPilot-Map package that the user builds from their own game installation ([map.md](../map.md)). The truck is deliberately not drawn on the map (`src/ui/navigation/RoadMapView.tsx:26-31`), because map and telemetry coordinates were never shown to agree. Phase 2.4D evaluates MapLibre (ADR-003), which needs a decision on the coordinate space it would draw in.

### Where the coordinates come from (FACT, code)

| Step                 | What happens                                                                                                                                                                         | Reference                                                                                                                                                |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Game sector files    | Node position `i32[3]` X, Y, Z in fixed point; `÷ 256` resolves it. Axes +X east, +Y up, +Z south; 4000-unit sector grid                                                             | RoadPilot-Map `crates/roadpilot-map-formats/src/sector.rs:97-102`; `docs/formats/scs-sector-format.md:121`; open question T3 in `docs/open-questions.md` |
| Model                | `Position { fixed: [i32; 3] }`, `SCALE = 256.0`, `world()` = `fixed / 256` in `f64`, "Nothing is transformed"                                                                        | RoadPilot-Map `crates/roadpilot-map-model/src/geometry.rs:5,16,18`                                                                                       |
| Package (schema 1.0) | Stores the integers unchanged; manifest `coordinate_system: {x: east, y: up, z: south, position_scale: 256, world_unit: unconfirmed}`; the reader rejects any other `position_scale` | RoadPilot-Map `crates/roadpilot-map-package/src/manifest.rs:174, 260-263`; `crates/roadpilot-map/src/export/mod.rs:40-41, 381`                           |
| RoadPilot loader     | Bounds from `node.position[0] / 256.0` and `[2] / 256.0` (X and Z only); checks schema major and game, the reference reader checks `position_scale`                                  | `src-tauri/src/map/loader.rs:115-131, 199-209`                                                                                                           |
| Display data         | Positions `÷ 256` in `f64`, Hermite curve in the horizontal X/Z plane, sampled every 2 units, Douglas–Peucker per level (0.5 / 4 / 32 / … units), stored as absolute `[f32; 2]`      | `src-tauri/src/map/display.rs:117-118, 169-171, 322`; levels at `display.rs:74-100`                                                                      |
| RPMT tiles           | `f64` tile origin, points as `f32` relative to it                                                                                                                                    | `src-tauri/src/map/tiles.rs:31-34, 102-124`, decoder `tiles.rs:200-224`, frontend `src/domain/mapTile.ts`                                                |
| Map view             | Draws X right, Z down (north up), package coordinates without transformation; centres on the telemetry `x`, `z` in follow mode, draws no marker                                      | `src/ui/navigation/RoadMapView.tsx:26-31, 58-63`; `src/ui/navigation/roadPainter.ts`                                                                     |
| Telemetry            | SCS SDK `truck.world.placement`: `x, y, z` metres as `double`, X east, Y up, Z south; heading 0…1 turn counterclockwise from north (−Z)                                              | RoadPilot-Telemetry `docs/FRAME-SNAPSHOT.md:33, 52`, `docs/PROTOCOL-V2.md:205`; RoadPilot `docs/telemetry.md:196-205`                                    |

## 3. Requirements

- R1. Map geometry and the truck must use one space, with any transformation explicit and tested where it is introduced (`docs/telemetry.md:205`).
- R2. Fully offline; no geographic data source.
- R3. Precision at least as good as the display needs (a pixel at the closest zoom is about 0.1 units); lane-level accuracy is **not** a requirement of the map (the map is never a steering input, [map.md](../map.md)).
- R4. Same rules for ATS and ETS2; unverified parts reported as unverified.
- R5. Usable as a planar CRS by a renderer (Canvas 2D, WebGL 2, MapLibre identity/custom CRS).

## 4. Verification of the documented assumptions

| Assumption                       | Finding                                                                                                                                                                                                                                                                                                                                                              | Evidence class                                             |
| -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| X points east                    | Package and SDK both say so; the ATS comparison (below) matches only without mirroring X                                                                                                                                                                                                                                                                             | FACT (format and SDK docs) + MEASUREMENT (ATS, one region) |
| Y points up                      | Same. Y is not used anywhere in map rendering: loader, display and tiles use X and Z only                                                                                                                                                                                                                                                                            | FACT (code)                                                |
| Z points south                   | Same; the map is drawn with Z downwards = north up; mirroring Z finds no road within 60 units                                                                                                                                                                                                                                                                        | FACT + MEASUREMENT (ATS)                                   |
| Factor 256                       | Applied in exactly one form, `/ 256` on the `i32`, in RoadPilot-Map and in RoadPilot (`loader.rs:201-202`, `display.rs:170`); the reader rejects other scales; the RoadPilot test kit uses `* 256` for synthetic packages (`testkit.rs:87`)                                                                                                                          | FACT (code)                                                |
| World origin = coordinate origin | No transformation exists anywhere; telemetry positions near x ≈ −99,000, z ≈ −69,000 match the package within metres without an offset (below). A global offset of the whole world cannot be tested and has no meaning for a planar map                                                                                                                              | FACT + MEASUREMENT (ATS)                                   |
| `world_unit` = metre             | **Unconfirmed** in the package (T3). Indirect evidence for ATS: telemetry metres and world units agree at about −99,000 / −69,000 without scale; a scale error of only 10⁻⁴ would shift points by about 10 m there, while the median distance is 2.4–3.0 m. This holds for one region and does not exclude an equal-and-opposite offset that happens to cancel there | MEASUREMENT (ATS, one region); HYPOTHESIS elsewhere        |

### Answers to the B0 questions

1. **Origin of the coordinates:** sector files of the user's installation, through RoadPilot-Map; telemetry from the SCS SDK placement. Two independent sources, one documented convention.
2. **Where transformations occur:** only the fixed-point division `/ 256` (RoadPilot-Map model and reader, RoadPilot loader and display) and, for drawing, the view transform (scale, centre, DPR) in the painter and the WebGL prototype. No axis, offset or projection transform exists.
3. **Is 256 consistent:** yes; one constant per crate (`POSITION_SCALE`, `Position::SCALE`), literal `256.0` in RoadPilot's loader and display, and a reader check against any other value.
4. **Is Y relevant:** no, not for a 2D map. It matters only for overlapping roads (bridges): the 2D map draws them over each other without a height order (FACT: no draw order by Y exists).
5. **ATS and ETS2 identical:** the same format code and the same SDK documentation serve both games (FACT). Measured agreement exists for ATS only; ETS2 is **unverified**.
6. **DLCs and game versions:** DLC sectors live in the same world space (the ATS package was built from 76 archives incl. state DLCs, one coordinate system). The axis and scale convention is a format property. But road positions and identifiers change with map updates (`identifiers_are_not_stable_across_game_versions` in the manifest), and the package does **not** record the game version (`source.game_version: null` in both measured packages). A package must therefore be rebuilt after a map update; RoadPilot cannot detect a stale package today.
7. **Precision:** none lost in the package (`i32 / 256` is exact in `f64`; resolution 1/256 ≈ 3.9 mm per unit). Display data stores absolute `f32` (`display.rs:117`): at |x| ≈ 131,072 the step is 1/64 ≈ 1.6 cm; at 100,000 about 0.8 cm. Tiles re-base on an `f64` origin but cannot recover that rounding. Much larger, deliberately: curves are estimated (Hermite, position accuracy unmeasured) and simplified by up to 0.5 units at level 0. Telemetry is `f64`. For display this is ample; for lane-level use it is not (and not intended).
8. **Same conventions in renderer and telemetry:** yes by documentation and by code (both X east, Z south, no transform; follow mode centres on telemetry `x, z` directly). Agreement is measured for ATS in one region only.

## 5. ATS evidence (rechecked in B0)

**What was verified (MEASUREMENT, reproduced in B0 from existing files, read-only):** telemetry placements lie on the package's road curves without any transformation.

| Item         | Value                                                                                                                                                                                                                                                                                                                                                                                                     |
| ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Package      | ATS `cba63760bde5b3a1`, generated 2026-11-05 (902,347 nodes, 224,870 roads), `%USERPROFILE%\Documents\RoadPilot-Measurements\2026-11-05\ats-package`                                                                                                                                                                                                                                                      |
| Recording 1  | `%USERPROFILE%\Documents\RoadPilot\calibration\ats-calibration-2026-11-13.jsonl` (calibration drive)                                                                                                                                                                                                                                                                                                      |
| Recording 2  | `%USERPROFILE%\Documents\RoadPilot\stage-b\ats-drive-2026-11-13.jsonl` (Stage B dry-run drive)                                                                                                                                                                                                                                                                                                            |
| Method       | Placements thinned to ≥ 15 m apart, nearest distance to the estimated road curves (Hermite, ≤ 64 segments per road, roads only, not prefab/junction geometry), heading vs. segment direction; alternative hypotheses: Z mirrored, X mirrored, axes swapped, scale 0.95 / 1.05, +20 east                                                                                                                   |
| Region       | x −99,053 … −97,361, z −70,315 … −67,466 (about 1.7 × 2.8 km)                                                                                                                                                                                                                                                                                                                                             |
| Recording 1  | 919 samples; distance median **2.37**, p90 5.98, p99 26.80; ≤ 5 units 89.1 %; heading deviation median **0.9°**                                                                                                                                                                                                                                                                                           |
| Recording 2  | 320 samples; median **2.99**, p90 20.50, p99 45.48; ≤ 5 units 59.7 %; heading median **0.7°**                                                                                                                                                                                                                                                                                                             |
| Alternatives | mirrored, swapped and ±5 % scale: no road within 60 units for (almost) every sample; +20 east: median 11.7 / 8.1                                                                                                                                                                                                                                                                                          |
| Excluded     | Paccar template session 2026-11-05 (`ats-paccar-session.jsonl`, road `4f795335089b0323`, look `road.us_paccar_03`): in all six passes the truck lies **58.5–61.3 units beside** that road (heading within 0.1–0.9°, height equal). Unexplained; most likely the session names a different, parallel road than the one driven (HYPOTHESIS). It contradicts nothing above but is not evidence for it either |

Reproduction: the analysis script (`align.py`, an offline Python reader of the package and the recordings, written in Phase 2.4 and kept outside the repository) produced identical figures in B0. It is not part of the repository; the inputs are the user's local files listed above.

**Limitations:** one region of about 5 km², a few hours of driving, two recordings on one day; roads only (yards, junction interiors and prefab lanes count as "far from a road" and explain the tails, HYPOTHESIS); the distance includes the lane offset of the truck from the road centre (a median of 2–3 units fits one lane, HYPOTHESIS); the package is eight days older than the recordings and records no game version, so a map change in between cannot be excluded; scale and offset are tested only as discrete hypotheses; no second, distant region; the unit is inferred, not confirmed.

## 6. ETS2 status

| Capability                | Status                             | Evidence                                                                                                                       |
| ------------------------- | ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| Map extraction            | Done                               | Package `20ae70ba19c404c8`, generated 2026-11-19, 807,602 nodes / 252,368 roads ([map.md](../map.md#measured))                 |
| Package validation        | Done                               | Reference reader: manifest, schema, sizes, checksums; opt-in test `real_packages_load` (`src-tauri/src/map/loader.rs:387-400`) |
| Map rendering             | Done (Canvas 2D)                   | Dashboard road map, M0 measurements with real packages in WebView2 ([map.md](../map.md))                                       |
| Coordinate interpretation | Format level only                  | Same format code and conventions as ATS; nothing ETS2-specific measured                                                        |
| Telemetry alignment       | **Not verified**                   | No ETS2 recording exists in the user's measurement folders                                                                     |
| Vehicle positioning       | **Not implemented / not verified** | The truck is not drawn                                                                                                         |

A rendered ETS2 map is **not** evidence that ETS2 telemetry positions fall on it.

## 7. Options considered

|             | A. Native SCS coordinates                                                                             | B. Custom affine transform                                      | C. Projection from SCS map definitions                                                                                        | D. WGS84                                                                                                                             |
| ----------- | ----------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| Feasibility | In use today                                                                                          | Easy (2×3 matrix)                                               | Unclear: no SCS definition of a projection is known to RoadPilot or RoadPilot-Map; the UI map's parameters are not researched | Needs a projection model of each game; community projects derive one (e.g. truckermudgeon/maps, GPL-3.0; not inspected for this ADR) |
| Accuracy    | Exact to the data (no transform)                                                                      | Exact if the matrix is exact; any fitted matrix adds error      | Unknown                                                                                                                       | Approximate by nature: the game worlds are scaled, distorted compositions of real geography                                          |
| Offline     | Yes                                                                                                   | Yes                                                             | Yes                                                                                                                           | Yes                                                                                                                                  |
| Calibration | None for the map; telemetry alignment must be verified (done for ATS, one region)                     | A fitted matrix needs reference points; a fixed flip needs none | Needs parameters from game files                                                                                              | Needs control points per game and per region (ETS2 is not one continuous projection, HYPOTHESIS)                                     |
| ATS / ETS2  | Same                                                                                                  | Same                                                            | Unknown                                                                                                                       | Separate models, possibly per region                                                                                                 |
| Risks       | The unit stays formally unconfirmed; large absolute values need care in `f32` (rebase per tile, done) | A fitted matrix can hide data errors                            | Unknown format, possibly undocumented                                                                                         | Distorts distances; brings licence and maintenance load; no benefit for an offline game map                                          |
| Complexity  | Lowest                                                                                                | Low                                                             | High and uncertain                                                                                                            | High                                                                                                                                 |

## 8. Decision (provisional) and consequences

**RECOMMENDATION:** option **A**, native SCS world coordinates in world units, with only a fixed, exact axis convention for display (screen right = +X, screen down = +Z, i.e. north up). For a renderer that expects "y up" (MapLibre's planar CRS), the mapping is the exact flip `(x, y) = (X, −Z)` with no scale, applied in one documented place and covered by a test. No fitted transformation, no projection, no WGS84.

Consequences:

- Map, prototype and a later truck marker share one space; the telemetry position needs no conversion beyond the same flip.
- The physical unit stays "world unit"; distances shown to the user remain labelled accordingly until T3 is closed.
- A renderer with large-coordinate limits must rebase per tile (RPMT and the WebGL prototype already do).
- Drawing the truck on the map still needs its own decision and verification (ETS2 alignment, a second ATS region); this ADR does not authorise it.

## 9. Verification matrix

| Capability                       | ATS                                                                                                                      | ETS2                                                                            |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------- |
| Map extraction                   | VERIFIED (package `cba63760…`, 2026-11-05)                                                                               | VERIFIED (package `20ae70ba…`, 2026-11-19)                                      |
| Package validation               | VERIFIED (reference reader, opt-in load test)                                                                            | VERIFIED (reference reader, opt-in load test)                                   |
| Map rendering                    | VERIFIED in Canvas 2D (dashboard); WebGL 2 prototype: NOT TESTED with real data                                          | VERIFIED in Canvas 2D (dashboard); WebGL 2 prototype: NOT TESTED with real data |
| Native coordinate interpretation | PARTIALLY VERIFIED (format; axes and scale consistent with telemetry in one 1.7 × 2.8 km region; unit unconfirmed)       | FORMAT-LEVEL ONLY (same code; nothing measured)                                 |
| Telemetry alignment              | PARTIALLY VERIFIED (2 recordings, one region, median 2.4 / 3.0 units, heading 0.7–0.9°; Paccar 60-unit case unexplained) | NOT VERIFIED (no recording)                                                     |
| Vehicle positioning              | NOT IMPLEMENTED, NOT VERIFIED                                                                                            | NOT IMPLEMENTED, NOT VERIFIED                                                   |

## 10. Risks

- The ATS agreement may not hold elsewhere (other states, other DLC eras of map editing). Mitigation: a second, distant region from existing or future recordings before any truck marker.
- ETS2 may differ in ways the format does not reveal (none known). Mitigation: an ETS2 recording and the same analysis.
- A stale package after a game update shows outdated roads in the right space; positions of changed roads would disagree with telemetry. Mitigation: record the game version in the package (RoadPilot-Map, T8).
- The Paccar case shows that a single road ID can be the wrong reference; template measurements need the road chosen from the driven position.

## 11. Open questions

1. T3: is a world unit exactly one metre? (Indirect ATS evidence only.)
2. Does the identity hold in a second ATS region and in ETS2?
3. Why does the Paccar session lie about 60 units beside its road?
4. How should overlapping roads (bridges) be ordered without Y?
5. Should RoadPilot-Map record the game version, so RoadPilot can warn about stale packages?

## 12. Evidence and references

- Code: paths and lines in section 2 (RoadPilot at `129e0b4`, RoadPilot-Map at `77e6094`, the revision RoadPilot's `src-tauri/Cargo.toml:19` pins).
- Documents: RoadPilot-Map `docs/open-questions.md` (T3, T8, T11), `docs/formats/map-package.md:60, 307`, `docs/formats/scs-sector-format.md:121`; RoadPilot-Telemetry `docs/FRAME-SNAPSHOT.md`, `docs/PROTOCOL-V2.md`; RoadPilot [map.md](../map.md), [telemetry.md](../telemetry.md).
- Data (user's machine, not in the repository): the ATS package and three recordings listed in section 5.
