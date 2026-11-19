//! Road maps from RoadPilot-Map packages, for display only.
//!
//! The user generates a package for ETS2 or ATS with the RoadPilot-Map CLI and selects its
//! folder; RoadPilot never searches for game installations, extracts game files or generates
//! packages. Packages are read with the reference reader of `roadpilot-map-package` (pinned in
//! `Cargo.toml`) and stay local.
//!
//! Nothing here is used by control, and the map is never used to steer. Telemetry positions are
//! not placed on the map: whether telemetry and map coordinates agree is only partly verified
//! (see docs/map.md).

pub mod loader;
pub mod service;
pub mod status;
#[cfg(test)]
pub mod testkit;

use crate::telemetry::model::Game;
use service::MapService;
use status::MapStatus;
use std::path::PathBuf;

/// Event carrying a `MapStatus` whenever it changes.
pub const MAP_STATUS_EVENT: &str = "map:status";

/// Managed Tauri state holding the map service.
pub struct MapServiceState(pub MapService);

fn parse_game(game: Option<&str>) -> Result<Option<Game>, String> {
    match game {
        None => Ok(None),
        Some("ets2") => Ok(Some(Game::Ets2)),
        Some("ats") => Ok(Some(Game::Ats)),
        Some(_) => Err("unknown game".into()),
    }
}

/// The folder as the user typed it: surrounding whitespace and quotes are removed.
fn parse_dir(path: Option<&str>) -> Option<PathBuf> {
    let trimmed = path?.trim().trim_matches('"').trim();
    (!trimmed.is_empty()).then(|| PathBuf::from(trimmed))
}

/// Selects the map package folder for a game (`null` releases the map). The folder is chosen
/// by the user; it is only read.
#[tauri::command]
pub fn map_select(
    state: tauri::State<'_, MapServiceState>,
    game: Option<String>,
    path: Option<String>,
    reload: Option<bool>,
) -> Result<MapStatus, String> {
    let game = parse_game(game.as_deref())?;
    Ok(state
        .0
        .select(game, parse_dir(path.as_deref()), reload.unwrap_or(false)))
}

#[tauri::command]
pub fn map_status(state: tauri::State<'_, MapServiceState>) -> MapStatus {
    state.0.status()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_games_and_folders_from_the_frontend() {
        assert_eq!(parse_game(Some("ats")), Ok(Some(Game::Ats)));
        assert_eq!(parse_game(None), Ok(None));
        assert!(parse_game(Some("ets3")).is_err());
        assert_eq!(
            parse_dir(Some("  \"C:\\maps\\ats\" ")),
            Some(PathBuf::from("C:\\maps\\ats"))
        );
        assert_eq!(parse_dir(Some("   ")), None);
        assert_eq!(parse_dir(None), None);
    }
}
