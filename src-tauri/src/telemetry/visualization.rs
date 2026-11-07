//! Read-only adapter from RoadPilot's normalized telemetry schema to visualization frame v2.
//!
//! Fields without a source in game telemetry stay `null`; this adapter does not infer a route,
//! lane geometry, path curvature, or vehicle dimensions.

use super::model::TelemetryUpdate;
use serde::Serialize;

const FRAME_FORMAT: &str = "roadpilot-visualization-frame";

#[derive(Debug, Serialize)]
pub struct VisualizationFrameV2 {
    format: &'static str,
    schema_version: SchemaVersion,
    source: FrameSource,
    sequence: u64,
    timestamp_s: f64,
    ego: Ego,
    agents: Vec<serde_json::Value>,
    signals: Vec<serde_json::Value>,
    lanes: Vec<serde_json::Value>,
    trajectory: Option<serde_json::Value>,
    acc: Option<serde_json::Value>,
    inputs: Inputs,
    status: Vec<serde_json::Value>,
}

#[derive(Debug, Serialize)]
struct SchemaVersion {
    major: u8,
    minor: u8,
}

#[derive(Debug, Serialize)]
struct FrameSource {
    id: &'static str,
}

#[derive(Debug, Serialize)]
struct Ego {
    position: Option<Point>,
    heading_rad: Option<f64>,
    speed_mps: Option<f64>,
    steering_angle_rad: Option<f64>,
    curvature_per_m: Option<f64>,
    length_m: Option<f64>,
    width_m: Option<f64>,
}

#[derive(Debug, Serialize)]
struct Point {
    x: f64,
    y: f64,
}

#[derive(Debug, Serialize)]
struct Inputs {
    steering: Option<f64>,
    throttle: Option<f64>,
    brake: Option<f64>,
}

/// Produces a visualization frame only while RoadPilot has a normalized game telemetry update.
pub fn frame_from_update(update: &TelemetryUpdate) -> Option<VisualizationFrameV2> {
    let data = update.data.as_ref()?;
    let position = data.position.filter(|p| p.x.is_finite() && p.z.is_finite());
    let heading_rad = position.map(|p| {
        (std::f64::consts::FRAC_PI_2 + f64::from(p.heading_deg).to_radians())
            .rem_euclid(std::f64::consts::TAU)
    });

    Some(VisualizationFrameV2 {
        format: FRAME_FORMAT,
        schema_version: SchemaVersion { major: 2, minor: 0 },
        source: FrameSource { id: "roadpilot" },
        sequence: data.source.sequence,
        timestamp_s: data
            .source
            .simulation_time_us
            .map(|v| v as f64 / 1_000_000.0)
            .unwrap_or(data.source.received_at_unix_ms as f64 / 1_000.0),
        ego: Ego {
            position: position.map(|p| Point { x: p.x, y: -p.z }),
            heading_rad,
            speed_mps: data
                .vehicle
                .speed_kmh
                .map(f64::from)
                .filter(|v| v.is_finite())
                .map(|v| v / 3.6),
            steering_angle_rad: data
                .dynamics
                .wheel_steering_angle_deg
                .map(f64::from)
                .filter(|v| v.is_finite())
                .map(f64::to_radians),
            // Yaw rate is not path curvature; no curvature is reported by telemetry schema 2.
            curvature_per_m: None,
            // Vehicle dimensions are not present in the normalized telemetry contract.
            length_m: None,
            width_m: None,
        },
        agents: Vec::new(),
        signals: Vec::new(),
        lanes: Vec::new(),
        trajectory: None,
        acc: None,
        inputs: Inputs {
            steering: data.dynamics.steering_input.map(f64::from),
            throttle: data.dynamics.throttle_input.map(f64::from),
            brake: data.dynamics.brake_input.map(f64::from),
        },
        status: Vec::new(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::telemetry::model::{ConnectionStatus, Dynamics, Position, TelemetryData, Vehicle};

    fn update() -> TelemetryUpdate {
        let mut update = TelemetryUpdate::status(ConnectionStatus::Connected, None);
        update.data = Some(TelemetryData {
            position: Some(Position {
                x: 150.0,
                y: 4.0,
                z: 30.0,
                heading_deg: 90.0,
                ..Position::default()
            }),
            vehicle: Vehicle {
                speed_kmh: Some(36.0),
                ..Vehicle::default()
            },
            dynamics: Dynamics {
                steering_input: Some(0.25),
                throttle_input: Some(0.4),
                brake_input: Some(0.0),
                wheel_steering_angle_deg: Some(-2.0),
                ..Dynamics::default()
            },
            ..TelemetryData::default()
        });
        update
    }

    #[test]
    fn maps_confirmed_position_axes_and_vehicle_measurements() {
        let frame = frame_from_update(&update()).unwrap();
        let json = serde_json::to_value(frame).unwrap();
        assert_eq!(json["schema_version"]["major"], 2);
        assert_eq!(json["ego"]["position"]["x"], 150.0);
        assert_eq!(json["ego"]["position"]["y"], -30.0);
        assert!((json["ego"]["heading_rad"].as_f64().unwrap() - std::f64::consts::PI).abs() < 1e-6);
        assert_eq!(json["ego"]["speed_mps"], 10.0);
        assert!(
            (json["ego"]["steering_angle_rad"].as_f64().unwrap() + 2_f64.to_radians()).abs() < 1e-6
        );
        assert!((json["inputs"]["steering"].as_f64().unwrap() - 0.25).abs() < 1e-6);
        assert!((json["inputs"]["throttle"].as_f64().unwrap() - 0.4).abs() < 1e-6);
    }

    #[test]
    fn keeps_unavailable_position_dimensions_and_curvature_null() {
        let mut update = update();
        update.data.as_mut().unwrap().position = None;
        update
            .data
            .as_mut()
            .unwrap()
            .dynamics
            .wheel_steering_angle_deg = None;
        let json = serde_json::to_value(frame_from_update(&update).unwrap()).unwrap();
        assert!(json["ego"]["position"].is_null());
        assert!(json["ego"]["heading_rad"].is_null());
        assert!(json["ego"]["steering_angle_rad"].is_null());
        assert!(json["ego"]["curvature_per_m"].is_null());
        assert!(json["ego"]["length_m"].is_null());
        assert!(json["ego"]["width_m"].is_null());
    }

    #[test]
    fn sends_no_scene_frame_without_live_telemetry() {
        assert!(frame_from_update(&TelemetryUpdate::disconnected()).is_none());
    }
}
