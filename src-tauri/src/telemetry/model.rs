//! Normalized telemetry model sent to the frontend (event `telemetry:update`).
//!
//! One model for ETS2 and ATS. Values come from RoadPilot telemetry protocol schema 2 (or
//! schema 1 with only speed, RPM and gear). Anything the game did not provide is `None`,
//! never a default. Units are part of every field name. Values derived by RoadPilot rather
//! than read from the game are documented as "Calculated" (see `normalize.rs`).

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

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TelemetryUpdate {
    pub status: ConnectionStatus,
    pub game: Option<Game>,
    /// The game reported that its simulation is paused.
    pub paused: bool,
    /// Present only while connected, so stale values are never shown as current.
    pub data: Option<TelemetryData>,
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
            data: None,
            error: None,
        }
    }
}

#[derive(Clone, Debug, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TelemetryData {
    pub source: SourceInfo,
    pub vehicle: Vehicle,
    pub dynamics: Dynamics,
    pub position: Option<Position>,
    pub job: Job,
    pub navigation: Navigation,
    pub environment: Environment,
}

/// Where and when the values come from.
#[derive(Clone, Debug, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceInfo {
    /// Telemetry schema of the frame (1 = speed, RPM and gear only).
    pub schema_version: u16,
    /// SDK telemetry game version `major.minor`.
    pub game_version: Option<String>,
    pub sequence: u64,
    /// Game simulation time of the frame (microseconds).
    pub simulation_time_us: Option<u64>,
    /// When RoadPilot received the frame (Unix epoch milliseconds).
    pub received_at_unix_ms: u64,
    /// Wire paths of values the reader removed as invalid in this frame.
    pub invalid_fields: Vec<String>,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Vehicle {
    /// Signed; negative while reversing.
    pub speed_kmh: Option<f32>,
    pub engine_rpm: Option<f32>,
    /// Positive forward, zero neutral, negative reverse.
    pub gear: Option<i32>,
    pub displayed_gear: Option<i32>,
    pub engine_running: Option<bool>,
    pub electric_on: Option<bool>,
    pub fuel_l: Option<f32>,
    pub fuel_capacity_l: Option<f32>,
    /// Calculated: fuel / capacity.
    pub fuel_percent: Option<f32>,
    /// Game estimate.
    pub fuel_range_km: Option<f32>,
    /// Game average, converted from l/km.
    pub fuel_consumption_l_per_100km: Option<f32>,
    pub fuel_warning: Option<bool>,
    pub adblue_l: Option<f32>,
    pub adblue_capacity_l: Option<f32>,
    /// Approximated by the game, not simulated.
    pub oil_temperature_c: Option<f32>,
    /// Approximated by the game, not simulated.
    pub water_temperature_c: Option<f32>,
    pub battery_voltage_v: Option<f32>,
    pub parking_brake: Option<bool>,
    pub engine_brake: Option<bool>,
    pub retarder_level: Option<u32>,
    pub retarder_steps: Option<u32>,
    /// Calculated: the set speed is above zero.
    pub cruise_control_on: Option<bool>,
    /// Cruise control set speed; `None` while off.
    pub cruise_control_kmh: Option<f32>,
    pub brand: Option<String>,
    pub model: Option<String>,
}

/// Driving dynamics in the truck's own frame. Velocities and accelerations are converted
/// from SDK vehicle space (X right, Y up, Z backwards) to forward / right / up.
#[derive(Clone, Debug, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Dynamics {
    /// Forward is positive.
    pub longitudinal_velocity_ms: Option<f32>,
    /// Right is positive.
    pub lateral_velocity_ms: Option<f32>,
    /// Up is positive.
    pub vertical_velocity_ms: Option<f32>,
    /// Forward is positive (braking is negative).
    pub longitudinal_acceleration_ms2: Option<f32>,
    /// Right is positive.
    pub lateral_acceleration_ms2: Option<f32>,
    pub vertical_acceleration_ms2: Option<f32>,
    /// Rotation around the vertical axis, counterclockwise from above (left turn) positive.
    pub yaw_rate_deg_s: Option<f32>,
    /// Player steering input, -1..1, positive = left.
    pub steering_input: Option<f32>,
    /// Player inputs, 0..1.
    pub throttle_input: Option<f32>,
    pub brake_input: Option<f32>,
    pub clutch_input: Option<f32>,
    /// Inputs as used by the simulation (includes cruise control and automatic clutch).
    pub steering_effective: Option<f32>,
    pub throttle_effective: Option<f32>,
    pub brake_effective: Option<f32>,
    pub clutch_effective: Option<f32>,
    /// Physical road-wheel angle of the first steerable wheel, positive = left.
    pub wheel_steering_angle_deg: Option<f32>,
}

/// World position in SDK world space (X east, Y up, Z south), meters. Angles converted from
/// SDK unit rotations to degrees without changing their direction conventions.
#[derive(Clone, Copy, Debug, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Position {
    pub x: f64,
    pub y: f64,
    pub z: f64,
    /// 0..360, counterclockwise from north (90 = west).
    pub heading_deg: f32,
    /// -90..90, positive = nose up.
    pub pitch_deg: f32,
    /// -180..180, counterclockwise around the forward axis.
    pub roll_deg: f32,
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum JobState {
    /// The telemetry did not report job information (schema 1, or not received yet).
    #[default]
    Unknown,
    None,
    Active,
    Delivered,
    Cancelled,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Job {
    pub state: JobState,
    pub cargo: Option<String>,
    pub cargo_mass_kg: Option<f32>,
    pub cargo_damage_percent: Option<f32>,
    pub source_city: Option<String>,
    pub source_company: Option<String>,
    pub destination_city: Option<String>,
    pub destination_company: Option<String>,
    pub income: Option<u64>,
    /// ISO 4217 code of the game currency (ETS2: EUR, ATS: USD, per the SDK).
    pub currency: Option<&'static str>,
    pub deadline: Option<Deadline>,
    /// Calculated: delivery deadline minus current game time, in game minutes.
    pub time_to_deadline_min: Option<i64>,
    pub planned_distance_km: Option<u32>,
    /// Calculated, approximate: 1 - navigation distance / planned distance.
    pub progress_percent: Option<f32>,
    pub delivered_revenue: Option<i64>,
    pub cancel_penalty: Option<i64>,
}

/// Calculated from the absolute deadline and the current game time.
#[derive(Clone, Debug, Default, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Deadline {
    /// In-game days from today (0 = today).
    pub day_offset: i64,
    /// In-game clock time `HH:MM`.
    pub time: String,
}

/// Route Advisor values as provided by the game.
#[derive(Clone, Copy, Debug, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Navigation {
    pub distance_km: Option<f32>,
    /// Converted from the advisor's seconds.
    pub eta_min: Option<f32>,
    /// `Some(0)` would mean "no limit shown"; such values are reported as `None` with
    /// `speed_limit_shown = Some(false)`.
    pub speed_limit_kmh: Option<f32>,
    pub speed_limit_shown: Option<bool>,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Environment {
    /// In-game minutes since 00:00 of the first in-game day.
    pub game_time_min: Option<u32>,
    /// Calculated: in-game clock time `HH:MM`.
    pub game_clock: Option<String>,
    /// Map scale applied to time and distance.
    pub time_scale: Option<f32>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn serializes_the_frontend_contract() {
        let mut update = TelemetryUpdate::status(ConnectionStatus::Connected, Some(Game::Ets2));
        update.data = Some(TelemetryData {
            vehicle: Vehicle {
                speed_kmh: Some(80.0),
                gear: Some(-1),
                ..Vehicle::default()
            },
            ..TelemetryData::default()
        });
        let json = serde_json::to_value(&update).unwrap();
        assert_eq!(json["status"], "connected");
        assert_eq!(json["game"], "ets2");
        assert_eq!(json["data"]["vehicle"]["speedKmh"], 80.0);
        assert_eq!(
            json["data"]["vehicle"]["engineRpm"],
            serde_json::Value::Null
        );
        assert_eq!(json["data"]["vehicle"]["gear"], -1);
        assert_eq!(json["data"]["job"]["state"], "unknown");
        assert_eq!(json["data"]["position"], serde_json::Value::Null);
        assert_eq!(json["data"]["source"]["receivedAtUnixMs"], 0);
        assert_eq!(json["error"], serde_json::Value::Null);
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
