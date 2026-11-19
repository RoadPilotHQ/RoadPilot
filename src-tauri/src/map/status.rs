//! The map status as the dashboard sees it (event `map:status`, command `map_status`).
//!
//! Error details never contain directory paths: the user chose the folder, and paths can
//! contain account names. File names inside the package (for example `geometry.jsonl`) are
//! kept, because they say which part is damaged.

use crate::telemetry::model::Game;
use serde::Serialize;

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum MapState {
    /// No package is configured for the game, or no game is selected.
    None,
    /// A package folder was chosen; its manifest is being checked.
    Selecting,
    /// The package is being verified and read in the background.
    Loading,
    Ready,
    Error,
    /// The package belongs to the other game.
    GameMismatch,
    /// The package uses a schema major version this application does not read.
    UnsupportedVersion,
}

/// What the loader is doing right now.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum LoadPhase {
    /// Reading and checking the manifest.
    Manifest,
    /// Checking every file against its checksum and reading the geometry.
    Reading,
    /// Preparing the display geometry.
    Preparing,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum MapErrorCode {
    /// The folder or its manifest does not exist.
    NotFound,
    /// A file could not be read (permissions, locked, I/O error).
    Unreadable,
    /// The folder holds no RoadPilot-Map package manifest.
    NotAPackage,
    InvalidManifest,
    /// A file is missing or differs from the manifest (size, checksum, format).
    FileMismatch,
    /// The geometry file is damaged or incomplete (for example, no footer).
    CorruptGeometry,
    /// The data disagrees with the manifest or with itself.
    Inconsistent,
    /// The package cannot be shown (for example, no usable road).
    Unusable,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
pub struct MapError {
    pub code: MapErrorCode,
    /// Technical detail without directory paths.
    pub detail: String,
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq, Serialize)]
pub struct MapCounts {
    pub nodes: u64,
    pub roads: u64,
    pub junctions: u64,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MapStatus {
    pub state: MapState,
    /// The game the map was requested for.
    pub game: Option<Game>,
    /// The game named by the package manifest, once it was read.
    pub package_game: Option<String>,
    pub phase: Option<LoadPhase>,
    /// Package `content_id`, lower-case hexadecimal.
    pub content_id: Option<String>,
    /// Package schema version `major.minor`.
    pub schema: Option<String>,
    pub counts: Option<MapCounts>,
    /// Horizontal extent of the map nodes in map world units: `[min_x, min_z, max_x, max_z]`.
    pub bounds: Option<[f64; 4]>,
    pub error: Option<MapError>,
    /// How long verifying, reading and preparing took.
    pub load_ms: Option<u64>,
    /// Increases with every change, so the frontend can order updates.
    pub revision: u64,
}

impl MapStatus {
    pub fn none(game: Option<Game>, revision: u64) -> Self {
        Self {
            state: MapState::None,
            game,
            package_game: None,
            phase: None,
            content_id: None,
            schema: None,
            counts: None,
            bounds: None,
            error: None,
            load_ms: None,
            revision,
        }
    }
}

pub fn content_id_hex(id: u64) -> String {
    format!("{id:016x}")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn serializes_the_frontend_contract() {
        let mut s = MapStatus::none(Some(Game::Ats), 3);
        s.state = MapState::GameMismatch;
        s.package_game = Some("ets2".into());
        s.error = Some(MapError {
            code: MapErrorCode::FileMismatch,
            detail: "geometry.jsonl: checksum differs".into(),
        });
        let json = serde_json::to_value(&s).unwrap();
        assert_eq!(json["state"], "game_mismatch");
        assert_eq!(json["game"], "ats");
        assert_eq!(json["packageGame"], "ets2");
        assert_eq!(json["error"]["code"], "file_mismatch");
        assert_eq!(json["revision"], 3);
        assert_eq!(json["contentId"], serde_json::Value::Null);
    }

    #[test]
    fn formats_content_ids_with_leading_zeros() {
        assert_eq!(content_id_hex(0x20ae70ba19c404c8), "20ae70ba19c404c8");
        assert_eq!(content_id_hex(0xab), "00000000000000ab");
    }
}
