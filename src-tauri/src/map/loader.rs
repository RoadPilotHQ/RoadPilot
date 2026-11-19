//! Loads one RoadPilot-Map package folder: manifest checks first (cheap), then the full,
//! checksum-verified read with the reference reader of `roadpilot-map-package`
//! (`verify_files` and `read_geometry`).
//!
//! The package stays the source of truth. Nothing is written, cached on disk or sent
//! anywhere; the raw records are dropped as soon as the display data is prepared.

use super::display::{self, DisplayMap};
use super::status::{LoadPhase, MapCounts, MapError, MapErrorCode, content_id_hex};
use crate::telemetry::model::Game;
use roadpilot_map_package::{
    GEOMETRY_FORMAT_NAME, GeometryData, LanesRecord, Manifest, ManifestError, PackageError,
    read_geometry, read_manifest, verify_files,
};
use std::fs::File;
use std::io::BufReader;
use std::path::Path;
use std::time::Instant;

/// The package schema major version this application reads.
pub const SUPPORTED_SCHEMA_MAJOR: u32 = 1;

/// Why a package was not loaded.
#[derive(Clone, Debug, PartialEq)]
pub enum LoadFailure {
    /// The package is for the other game (or an unknown one).
    GameMismatch {
        package_game: String,
    },
    UnsupportedVersion {
        major: i64,
    },
    Failed(MapError),
}

/// What remains in memory of a loaded package.
#[derive(Debug)]
pub struct LoadedMap {
    pub game: Game,
    pub content_id: u64,
    pub schema: String,
    pub counts: MapCounts,
    /// `[min_x, min_z, max_x, max_z]` of the nodes, map world units.
    pub bounds: [f64; 4],
    pub load_ms: u64,
    /// Simplified geometry per level of detail; the only map data kept in memory.
    pub display: DisplayMap,
}

impl LoadedMap {
    pub fn content_id_hex(&self) -> String {
        content_id_hex(self.content_id)
    }
}

pub fn game_name(game: Game) -> &'static str {
    match game {
        Game::Ets2 => "ets2",
        Game::Ats => "ats",
    }
}

fn failed(code: MapErrorCode, detail: impl Into<String>) -> LoadFailure {
    LoadFailure::Failed(MapError {
        code,
        detail: detail.into(),
    })
}

/// The I/O error kind from a `PackageError::Io` text (`"<path> (<Kind>)"`), without the path.
fn io_kind(text: &str) -> &str {
    text.rsplit_once(" (")
        .map(|(_, kind)| kind.trim_end_matches(')'))
        .unwrap_or("I/O error")
}

/// Maps a package error to a code and a path-free detail.
pub fn describe(error: &PackageError) -> LoadFailure {
    match error {
        PackageError::Io(text) => {
            let kind = io_kind(text);
            if kind == "NotFound" {
                failed(MapErrorCode::NotFound, "no manifest.json in the folder")
            } else {
                failed(MapErrorCode::Unreadable, kind.to_owned())
            }
        }
        PackageError::Manifest(ManifestError::UnsupportedVersion { major }) => {
            LoadFailure::UnsupportedVersion { major: *major }
        }
        PackageError::Manifest(ManifestError::NotAPackage) => failed(
            MapErrorCode::NotAPackage,
            "manifest.json is not a RoadPilot-Map package manifest",
        ),
        PackageError::Manifest(e) => failed(MapErrorCode::InvalidManifest, e.to_string()),
        PackageError::FileMismatch { name, reason } => {
            // A missing file is reported by the reader as an I/O text that may hold a path.
            let reason = if reason.contains('\\') || reason.contains('/') {
                "is missing or unreadable".to_owned()
            } else {
                reason.clone()
            };
            failed(MapErrorCode::FileMismatch, format!("{name} {reason}"))
        }
        PackageError::Geometry(e) => failed(MapErrorCode::CorruptGeometry, e.to_string()),
        PackageError::Inconsistent(m) => failed(MapErrorCode::Inconsistent, m.clone()),
        PackageError::Spatial(e) => failed(MapErrorCode::Inconsistent, format!("{e:?}")),
        // The error type is non-exhaustive in spirit; anything new is reported generically.
        #[allow(unreachable_patterns)]
        _ => failed(MapErrorCode::Inconsistent, "unknown package error"),
    }
}

/// Reads the manifest only and checks schema version and game. Fast; no data file is read.
pub fn check_manifest(dir: &Path, game: Game) -> Result<Manifest, LoadFailure> {
    if !dir.is_dir() {
        return Err(failed(MapErrorCode::NotFound, "the folder does not exist"));
    }
    let manifest = read_manifest(dir).map_err(|e| describe(&e))?;
    if manifest.schema_major != SUPPORTED_SCHEMA_MAJOR {
        return Err(LoadFailure::UnsupportedVersion {
            major: i64::from(manifest.schema_major),
        });
    }
    if manifest.game != game_name(game) {
        return Err(LoadFailure::GameMismatch {
            package_game: manifest.game,
        });
    }
    Ok(manifest)
}

/// Verifies and reads the geometry with the reference reader, with the same checks as
/// `MapPackage::open` except its spatial index, which RoadPilot does not use (it keeps its own
/// tile grid and drops the records): every listed file against size and checksum, the geometry
/// file (format, header, order, references, footer) and the record counts of the manifest.
fn read_verified(dir: &Path, manifest: &Manifest) -> Result<GeometryData, PackageError> {
    verify_files(dir, manifest)?;
    let entry = manifest.file("geometry").ok_or_else(|| {
        PackageError::Inconsistent("the manifest lists no geometry file".to_owned())
    })?;
    if entry.format != GEOMETRY_FORMAT_NAME {
        return Err(PackageError::FileMismatch {
            name: entry.name.clone(),
            reason: format!("has format {:?}", entry.format),
        });
    }
    let file = File::open(dir.join(&entry.name)).map_err(|e| PackageError::FileMismatch {
        name: entry.name.clone(),
        reason: format!("cannot be opened ({:?})", e.kind()),
    })?;
    let data = read_geometry(BufReader::new(file), Some(manifest.length_tolerance))
        .map_err(PackageError::Geometry)?;
    let lanes: u64 = data
        .roads
        .iter()
        .map(|r| match &r.lanes {
            LanesRecord::Resolved(l) => l.len() as u64,
            LanesRecord::Unresolved(_) => 0,
        })
        .sum();
    for (name, declared, found) in [
        ("nodes", manifest.counts.nodes, data.nodes.len() as u64),
        ("roads", manifest.counts.roads, data.roads.len() as u64),
        ("lanes", manifest.counts.lanes, lanes),
        (
            "junctions",
            manifest.counts.junctions,
            data.junctions.len() as u64,
        ),
        (
            "connections",
            manifest.counts.connections,
            data.connections.len() as u64,
        ),
    ] {
        if declared != found {
            return Err(PackageError::Inconsistent(format!(
                "{name}: the manifest says {declared}, the geometry file has {found}"
            )));
        }
    }
    Ok(data)
}

/// Loads and validates a package for `game`. `phase` reports progress; the call blocks, so it
/// runs on a background thread in the application.
pub fn load(dir: &Path, game: Game, phase: &dyn Fn(LoadPhase)) -> Result<LoadedMap, LoadFailure> {
    let started = Instant::now();
    phase(LoadPhase::Manifest);
    let manifest = check_manifest(dir, game)?;
    let content_id = manifest.content_id();
    let schema = format!("{}.{}", manifest.schema_major, manifest.schema_minor);

    phase(LoadPhase::Reading);
    let data = read_verified(dir, &manifest).map_err(|e| describe(&e))?;

    phase(LoadPhase::Preparing);
    let mut bounds = [f64::MAX, f64::MAX, f64::MIN, f64::MIN];
    for node in &data.nodes {
        let x = f64::from(node.position[0]) / 256.0;
        let z = f64::from(node.position[2]) / 256.0;
        bounds = [
            bounds[0].min(x),
            bounds[1].min(z),
            bounds[2].max(x),
            bounds[3].max(z),
        ];
    }
    if data.roads.is_empty() || data.nodes.is_empty() {
        return Err(failed(
            MapErrorCode::Unusable,
            "the package contains no roads",
        ));
    }
    let counts = MapCounts {
        nodes: data.nodes.len() as u64,
        roads: data.roads.len() as u64,
        junctions: data.junctions.len() as u64,
    };
    let display = display::build(&data);
    if display.levels[0].roads.is_empty() {
        return Err(failed(MapErrorCode::Unusable, "no road can be drawn"));
    }
    // The raw records are released here; only the display data stays.
    drop(data);
    Ok(LoadedMap {
        game,
        content_id,
        schema,
        counts,
        bounds,
        load_ms: started.elapsed().as_millis() as u64,
        display,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::map::testkit::{Road, TestPackage};
    use std::cell::RefCell;

    fn straight(id: u64, from: (f64, f64), to: (f64, f64)) -> Road {
        Road::straight(id, from, to, "traffic_lane.road.local")
    }

    #[test]
    fn loads_valid_packages_of_both_games() {
        for game in [Game::Ats, Game::Ets2] {
            let pkg = TestPackage::new(game_name(game))
                .road(straight(1, (0.0, 0.0), (100.0, 0.0)))
                .road(straight(2, (100.0, 0.0), (100.0, 250.0)))
                .write();
            let phases = RefCell::new(Vec::new());
            let map = load(pkg.dir(), game, &|p| phases.borrow_mut().push(p)).unwrap();
            assert_eq!(map.game, game);
            assert_eq!(map.content_id, pkg.content_id());
            assert_eq!(map.schema, "1.0");
            assert_eq!(map.counts.roads, 2);
            assert_eq!(map.bounds, [0.0, 0.0, 100.0, 250.0]);
            assert_eq!(
                *phases.borrow(),
                [
                    LoadPhase::Manifest,
                    LoadPhase::Reading,
                    LoadPhase::Preparing
                ]
            );
        }
    }

    #[test]
    fn rejects_a_package_of_the_other_game() {
        let pkg = TestPackage::new("ets2")
            .road(straight(1, (0.0, 0.0), (50.0, 0.0)))
            .write();
        assert_eq!(
            load(pkg.dir(), Game::Ats, &|_| {}).unwrap_err(),
            LoadFailure::GameMismatch {
                package_game: "ets2".into()
            }
        );
    }

    #[test]
    fn rejects_an_unsupported_schema_major_version() {
        let pkg = TestPackage::new("ats")
            .road(straight(1, (0.0, 0.0), (50.0, 0.0)))
            .schema_major(2)
            .write();
        assert_eq!(
            load(pkg.dir(), Game::Ats, &|_| {}).unwrap_err(),
            LoadFailure::UnsupportedVersion { major: 2 }
        );
    }

    fn code(f: LoadFailure) -> (MapErrorCode, String) {
        match f {
            LoadFailure::Failed(e) => (e.code, e.detail),
            other => panic!("unexpected {other:?}"),
        }
    }

    #[test]
    fn reports_a_missing_folder_or_manifest_without_paths() {
        let missing = std::env::temp_dir().join("roadpilot-map-test-does-not-exist");
        let (c, detail) = code(load(&missing, Game::Ats, &|_| {}).unwrap_err());
        assert_eq!(c, MapErrorCode::NotFound);
        assert!(!detail.contains("roadpilot-map-test"), "{detail}");

        let pkg = TestPackage::new("ats")
            .road(straight(1, (0.0, 0.0), (50.0, 0.0)))
            .write();
        std::fs::remove_file(pkg.dir().join("manifest.json")).unwrap();
        let (c, detail) = code(load(pkg.dir(), Game::Ats, &|_| {}).unwrap_err());
        assert_eq!(c, MapErrorCode::NotFound);
        assert!(!detail.contains(&*pkg.dir().to_string_lossy()), "{detail}");
    }

    #[test]
    fn rejects_a_corrupt_manifest() {
        let pkg = TestPackage::new("ats")
            .road(straight(1, (0.0, 0.0), (50.0, 0.0)))
            .write();
        std::fs::write(pkg.dir().join("manifest.json"), "{not json").unwrap();
        let (c, _) = code(load(pkg.dir(), Game::Ats, &|_| {}).unwrap_err());
        assert_eq!(c, MapErrorCode::InvalidManifest);
        std::fs::write(pkg.dir().join("manifest.json"), r#"{"format":"other"}"#).unwrap();
        let (c, _) = code(load(pkg.dir(), Game::Ats, &|_| {}).unwrap_err());
        assert!(matches!(
            c,
            MapErrorCode::NotAPackage | MapErrorCode::InvalidManifest
        ));
    }

    #[test]
    fn rejects_a_damaged_geometry_file_by_its_checksum() {
        let pkg = TestPackage::new("ats")
            .road(straight(1, (0.0, 0.0), (50.0, 0.0)))
            .write();
        let path = pkg.dir().join("geometry.jsonl");
        let mut bytes = std::fs::read(&path).unwrap();
        let i = bytes.iter().position(|b| *b == b'5').unwrap();
        bytes[i] = b'6';
        std::fs::write(&path, bytes).unwrap();
        let (c, detail) = code(load(pkg.dir(), Game::Ats, &|_| {}).unwrap_err());
        assert_eq!(c, MapErrorCode::FileMismatch);
        assert!(detail.starts_with("geometry.jsonl"), "{detail}");
    }

    #[test]
    fn rejects_a_missing_geometry_file() {
        let pkg = TestPackage::new("ats")
            .road(straight(1, (0.0, 0.0), (50.0, 0.0)))
            .write();
        std::fs::remove_file(pkg.dir().join("geometry.jsonl")).unwrap();
        let (c, detail) = code(load(pkg.dir(), Game::Ats, &|_| {}).unwrap_err());
        assert_eq!(c, MapErrorCode::FileMismatch);
        assert!(!detail.contains(&*pkg.dir().to_string_lossy()), "{detail}");
    }

    #[test]
    fn rejects_counts_that_disagree_with_the_manifest() {
        let pkg = TestPackage::new("ats")
            .road(straight(1, (0.0, 0.0), (50.0, 0.0)))
            .write();
        let path = pkg.dir().join("manifest.json");
        let text = std::fs::read_to_string(&path).unwrap();
        assert!(text.contains("\"roads\":1,"));
        std::fs::write(&path, text.replacen("\"roads\":1,", "\"roads\":2,", 1)).unwrap();
        let (c, detail) = code(load(pkg.dir(), Game::Ats, &|_| {}).unwrap_err());
        assert_eq!(c, MapErrorCode::Inconsistent);
        assert!(detail.starts_with("roads:"), "{detail}");
    }

    #[test]
    fn rejects_a_geometry_file_without_footer_even_with_a_matching_checksum() {
        let pkg = TestPackage::new("ats")
            .road(straight(1, (0.0, 0.0), (50.0, 0.0)))
            .without_footer()
            .write();
        let (c, detail) = code(load(pkg.dir(), Game::Ats, &|_| {}).unwrap_err());
        assert_eq!(c, MapErrorCode::CorruptGeometry, "{detail}");
    }

    /// Opt-in: loads real, locally generated packages. Never part of the normal test run.
    ///
    /// ```text
    /// $env:ROADPILOT_MAP_PACKAGE_ATS = "<folder of an ATS package>"
    /// $env:ROADPILOT_MAP_PACKAGE_ETS2 = "<folder of an ETS2 package>"
    /// cargo test --release --lib real_packages -- --ignored --nocapture
    /// ```
    #[test]
    #[ignore = "needs locally generated map packages"]
    fn real_packages_load() {
        for (var, game) in [
            ("ROADPILOT_MAP_PACKAGE_ATS", Game::Ats),
            ("ROADPILOT_MAP_PACKAGE_ETS2", Game::Ets2),
        ] {
            let Some(dir) = std::env::var_os(var) else {
                println!("{var} not set, skipped");
                continue;
            };
            let map = load(Path::new(&dir), game, &|_| {}).unwrap();
            println!(
                "{}: content id {}, schema {}, {} nodes, {} roads, {} junctions, loaded in {} ms",
                game_name(game),
                map.content_id_hex(),
                map.schema,
                map.counts.nodes,
                map.counts.roads,
                map.counts.junctions,
                map.load_ms
            );
            for (i, level) in map.display.levels.iter().enumerate() {
                let largest = level.tiles.keys().map(|(x, z)| {
                    crate::map::tiles::encode(&map.display, map.content_id, i as u8, *x, *z).len()
                });
                println!(
                    "  level {i}: {} roads, {} points, {} tiles, largest tile {} bytes",
                    level.roads.len(),
                    level.points,
                    level.tiles.len(),
                    largest.max().unwrap_or(0)
                );
            }
            // A viewport of 8 × 6 tiles around the middle of the map, encoded cold, per level.
            let (cx, cz) = (
                (map.bounds[0] + map.bounds[2]) / 2.0,
                (map.bounds[1] + map.bounds[3]) / 2.0,
            );
            for (i, spec) in crate::map::display::LEVELS.iter().enumerate() {
                let (tx, tz) = (
                    (cx / spec.tile_size).floor() as i32,
                    (cz / spec.tile_size).floor() as i32,
                );
                let started = std::time::Instant::now();
                let mut bytes = 0;
                for x in tx - 4..tx + 4 {
                    for z in tz - 3..tz + 3 {
                        bytes +=
                            crate::map::tiles::encode(&map.display, map.content_id, i as u8, x, z)
                                .len();
                    }
                }
                println!(
                    "  level {i}: 48 tiles encoded in {:.2} ms, {} KiB",
                    started.elapsed().as_secs_f64() * 1000.0,
                    bytes / 1024
                );
            }
            println!(
                "  display data about {} MiB, {} roads skipped",
                map.display.heap_bytes() / (1024 * 1024),
                map.display.skipped
            );
            // Lets an outside tool sample the steady memory while the map is held.
            if let Some(ms) = std::env::var_os("ROADPILOT_MAP_HOLD_MS")
                .and_then(|v| v.to_str().and_then(|s| s.parse().ok()))
            {
                println!("  holding the loaded map for {ms} ms");
                std::thread::sleep(std::time::Duration::from_millis(ms));
            }
            let other = match game {
                Game::Ats => Game::Ets2,
                Game::Ets2 => Game::Ats,
            };
            assert!(matches!(
                check_manifest(Path::new(&dir), other),
                Err(LoadFailure::GameMismatch { .. })
            ));
        }
    }
}
