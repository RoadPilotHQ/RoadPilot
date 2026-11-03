//! Normalized telemetry model sent to the frontend.
//!
//! Only values that the RoadPilot telemetry protocol (v1) actually carries are modelled here.
//! Anything the protocol does not provide is absent, never a default value.

use serde::Serialize;

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Game {
    Ets2,
    Ats,
}

impl From<roadpilot_telemetry_client::GameId> for Game {
    fn from(id: roadpilot_telemetry_client::GameId) -> Self {
        match id {
            roadpilot_telemetry_client::GameId::Ets2 => Game::Ets2,
            roadpilot_telemetry_client::GameId::Ats => Game::Ats,
        }
    }
}

/// Connection state as seen by the dashboard.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ConnectionStatus {
    /// No supported game is running.
    Disconnected,
    /// A game is running and RoadPilot is waiting for its first telemetry frame.
    Connecting,
    /// Fresh telemetry frames are arriving.
    Connected,
    /// Telemetry was live in this game session but frames stopped while the game still runs.
    Reconnecting,
    /// A game is running but no telemetry arrives (for example, plugin not installed).
    Unavailable,
    /// The telemetry endpoint could not be opened.
    Error,
}

/// Vehicle values from protocol v1. `None` means unavailable, not zero.
#[derive(Clone, Copy, Debug, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VehicleTelemetry {
    /// Signed speed in km/h; negative while reversing.
    pub speed_kmh: Option<f32>,
    pub engine_rpm: Option<f32>,
    /// Positive forward, zero neutral, negative reverse.
    pub gear: Option<i32>,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TelemetryUpdate {
    pub status: ConnectionStatus,
    pub game: Option<Game>,
    /// The game reported that its simulation is paused.
    pub paused: bool,
    /// Present only while connected, so stale values are never shown as current.
    pub vehicle: Option<VehicleTelemetry>,
    /// Technical detail for the `Error` state.
    pub error: Option<String>,
}

impl TelemetryUpdate {
    pub fn disconnected() -> Self {
        Self::status(ConnectionStatus::Disconnected, None)
    }

    pub fn status(status: ConnectionStatus, game: Option<Game>) -> Self {
        Self {
            status,
            game,
            paused: false,
            vehicle: None,
            error: None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn serializes_the_frontend_contract() {
        let update = TelemetryUpdate {
            status: ConnectionStatus::Connected,
            game: Some(Game::Ets2),
            paused: false,
            vehicle: Some(VehicleTelemetry {
                speed_kmh: Some(80.0),
                engine_rpm: None,
                gear: Some(-1),
            }),
            error: None,
        };
        let json = serde_json::to_value(&update).unwrap();
        assert_eq!(
            json,
            serde_json::json!({
                "status": "connected",
                "game": "ets2",
                "paused": false,
                "vehicle": { "speedKmh": 80.0, "engineRpm": null, "gear": -1 },
                "error": null
            })
        );
    }

    #[test]
    fn maps_protocol_game_ids() {
        assert_eq!(
            Game::from(roadpilot_telemetry_client::GameId::Ats),
            Game::Ats
        );
        assert_eq!(
            Game::from(roadpilot_telemetry_client::GameId::Ets2),
            Game::Ets2
        );
    }
}
