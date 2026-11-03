//! Validation and normalization of protocol values into the dashboard model.
//!
//! The telemetry client already rejects frames with non-finite speed or negative RPM. This
//! layer additionally drops values outside plausibility bounds, so a corrupt value becomes
//! "unavailable" instead of being displayed. The bounds are safety guards, not game limits.

use super::model::VehicleTelemetry;
use roadpilot_telemetry_client::TelemetryValues;

const MAX_ABS_SPEED_KMH: f32 = 400.0;
const MAX_ENGINE_RPM: f32 = 10_000.0;
const GEAR_RANGE: std::ops::RangeInclusive<i32> = -16..=32;

pub fn normalize_vehicle(values: &TelemetryValues) -> VehicleTelemetry {
    VehicleTelemetry {
        speed_kmh: values
            .speed_mps
            .filter(|v| v.is_finite())
            .map(|mps| round1(mps * 3.6))
            .filter(|kmh| kmh.abs() <= MAX_ABS_SPEED_KMH),
        engine_rpm: values
            .engine_rpm
            .filter(|v| v.is_finite() && (0.0..=MAX_ENGINE_RPM).contains(v))
            .map(f32::round),
        gear: values.gear.filter(|g| GEAR_RANGE.contains(g)),
    }
}

fn round1(value: f32) -> f32 {
    (value * 10.0).round() / 10.0
}

#[cfg(test)]
mod tests {
    use super::*;

    fn values(speed: Option<f32>, rpm: Option<f32>, gear: Option<i32>) -> TelemetryValues {
        TelemetryValues {
            speed_mps: speed,
            engine_rpm: rpm,
            gear,
        }
    }

    #[test]
    fn converts_speed_to_kmh_and_rounds() {
        let v = normalize_vehicle(&values(Some(22.222), Some(1420.4), Some(12)));
        assert_eq!(v.speed_kmh, Some(80.0));
        assert_eq!(v.engine_rpm, Some(1420.0));
        assert_eq!(v.gear, Some(12));
    }

    #[test]
    fn keeps_reverse_speed_and_gear_signed() {
        let v = normalize_vehicle(&values(Some(-2.5), Some(800.0), Some(-1)));
        assert_eq!(v.speed_kmh, Some(-9.0));
        assert_eq!(v.gear, Some(-1));
    }

    #[test]
    fn missing_fields_stay_missing() {
        assert_eq!(
            normalize_vehicle(&values(None, None, None)),
            VehicleTelemetry::default()
        );
    }

    #[test]
    fn drops_invalid_and_implausible_values() {
        let v = normalize_vehicle(&values(Some(f32::NAN), Some(-5.0), Some(99)));
        assert_eq!(v, VehicleTelemetry::default());
        let v = normalize_vehicle(&values(Some(500.0), Some(f32::INFINITY), Some(-40)));
        assert_eq!(v, VehicleTelemetry::default());
    }

    #[test]
    fn neutral_gear_and_standstill_are_real_values() {
        let v = normalize_vehicle(&values(Some(0.0), Some(0.0), Some(0)));
        assert_eq!(v.speed_kmh, Some(0.0));
        assert_eq!(v.engine_rpm, Some(0.0));
        assert_eq!(v.gear, Some(0));
    }
}
