//! Read-only game telemetry for ETS2 and ATS.
//!
//! Data flow: RoadPilot telemetry plugin (in the game) -> named pipe ->
//! `roadpilot-telemetry-client` (decode + validate) -> `normalize` -> `status` (connection
//! state machine) -> `engine` (sampling, change detection) -> Tauri event `telemetry:update`.
//!
//! This module never sends input to the game.

pub mod engine;
pub mod model;
pub mod normalize;
pub mod process;
pub mod status;
pub mod visualization;
pub mod visualization_stream;
