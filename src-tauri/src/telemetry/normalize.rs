//! Conversion of validated protocol frames into the dashboard model.
//!
//! Validation (non-finite and implausible values) happens once, in
//! `roadpilot-telemetry-client`; this module only converts units and axes and derives the
//! values marked "Calculated" in `model.rs`. Every conversion is covered by a test below.
//!
//! Conventions (SCS SDK `scssdk_value.h`): vehicle space X right, Y up, Z backwards; world
//! space X east, Y up, Z south; rotations in full turns.

use super::model::{
    Deadline, Dynamics, Environment, Game, Job, JobState, Navigation, Position, SourceInfo,
    TelemetryData, Vehicle,
};
use roadpilot_telemetry_client as proto;

const MPS_TO_KMH: f32 = 3.6;
const TURN_TO_DEG: f32 = 360.0;
const MINUTES_PER_DAY: i64 = 24 * 60;

/// Everything RoadPilot knows about one received frame.
pub struct FrameInput<'a> {
    pub frame: &'a proto::TelemetryFrame,
    pub dropped_fields: &'a [&'static str],
    pub received_at_unix_ms: u64,
}

pub fn normalize(input: &FrameInput<'_>) -> TelemetryData {
    let f = input.frame;
    let game: Game = f.game.into();
    let truck = f.truck.unwrap_or_default();
    let config = f.truck_config.clone().unwrap_or_default();
    let navigation = navigation(f.navigation.unwrap_or_default());
    TelemetryData {
        source: SourceInfo {
            schema_version: f.schema_version,
            game_version: f.game_version.clone(),
            sequence: f.sequence,
            simulation_time_us: f.simulation_time_us,
            received_at_unix_ms: input.received_at_unix_ms,
            invalid_fields: input.dropped_fields.iter().map(|s| s.to_string()).collect(),
        },
        vehicle: vehicle(&truck, &config),
        dynamics: dynamics(f.inputs.unwrap_or_default(), f.motion.unwrap_or_default()),
        position: f.placement.map(position),
        job: job(f.job.as_ref(), game, f.game_time_min, &navigation),
        navigation,
        environment: Environment {
            game_time_min: f.game_time_min,
            game_clock: f.game_time_min.map(|m| clock(i64::from(m))),
            time_scale: f.local_scale,
        },
    }
}

fn vehicle(t: &proto::TruckState, c: &proto::TruckConfig) -> Vehicle {
    let fuel_percent = match (t.fuel_l, c.fuel_capacity_l) {
        (Some(fuel), Some(capacity)) if capacity > 0.0 => {
            Some(round1((fuel / capacity * 100.0).clamp(0.0, 100.0)))
        }
        _ => None,
    };
    Vehicle {
        speed_kmh: t.speed_mps.map(|v| round1(v * MPS_TO_KMH)),
        engine_rpm: t.engine_rpm.map(f32::round),
        gear: t.gear,
        displayed_gear: t.displayed_gear,
        engine_running: t.engine_enabled,
        electric_on: t.electric_enabled,
        fuel_l: t.fuel_l.map(round1),
        fuel_capacity_l: c.fuel_capacity_l,
        fuel_percent,
        fuel_range_km: t.fuel_range_km.map(f32::round),
        fuel_consumption_l_per_100km: t.fuel_consumption_l_per_km.map(|v| round1(v * 100.0)),
        fuel_warning: t.fuel_warning,
        adblue_l: t.adblue_l.map(round1),
        adblue_capacity_l: c.adblue_capacity_l,
        oil_temperature_c: t.oil_temperature_c.map(round1),
        water_temperature_c: t.water_temperature_c.map(round1),
        battery_voltage_v: t.battery_voltage_v.map(round1),
        parking_brake: t.parking_brake,
        engine_brake: t.motor_brake,
        retarder_level: t.retarder_level,
        retarder_steps: c.retarder_steps,
        cruise_control_on: t.cruise_control_mps.map(|v| v > 0.0),
        cruise_control_kmh: t
            .cruise_control_mps
            .filter(|v| *v > 0.0)
            .map(|v| round1(v * MPS_TO_KMH)),
        brand: c.brand.clone(),
        model: c.name.clone(),
        wheelbase_m: wheelbase_m(c),
    }
}

/// Plausible range for a truck wheelbase in metres; anything else is treated as bad data.
const WHEELBASE_RANGE_M: std::ops::RangeInclusive<f32> = 0.5..=30.0;

/// Wheelbase from the truck configuration, calculated only here (the plugin sends raw wheel
/// geometry). Distance along vehicle Z between the mean position of the steerable wheels and
/// the mean position of the powered wheels that are not steerable (the drive axle group).
///
/// Returns `None` when the data is incomplete or invalid: wheels missing or truncated
/// (`wheelCount` differs from the list length), any wheel without position, steerable or
/// powered flag, non-finite positions, no steerable or no drive wheel, or an implausible
/// result.
fn wheelbase_m(c: &proto::TruckConfig) -> Option<f32> {
    let wheels = c.wheels.as_ref()?;
    if wheels.is_empty() || c.wheel_count? as usize != wheels.len() {
        return None;
    }
    let (mut steer_sum, mut steer_n, mut drive_sum, mut drive_n) = (0.0_f64, 0_u32, 0.0_f64, 0_u32);
    for wheel in wheels {
        let (pos, steerable, powered) = (wheel.position_m?, wheel.steerable?, wheel.powered?);
        if !pos.z.is_finite() {
            return None;
        }
        if steerable {
            steer_sum += f64::from(pos.z);
            steer_n += 1;
        } else if powered {
            drive_sum += f64::from(pos.z);
            drive_n += 1;
        }
    }
    if steer_n == 0 || drive_n == 0 {
        return None;
    }
    let wheelbase = (drive_sum / f64::from(drive_n) - steer_sum / f64::from(steer_n)).abs() as f32;
    WHEELBASE_RANGE_M
        .contains(&wheelbase)
        .then(|| (wheelbase * 100.0).round() / 100.0)
}

/// SDK vehicle space (X right, Y up, Z backwards) -> forward / right / up.
fn dynamics(i: proto::Inputs, m: proto::Motion) -> Dynamics {
    let v = m.local_velocity_mps;
    let a = m.local_acceleration_mps2;
    Dynamics {
        longitudinal_velocity_ms: v.map(|v| -v.z),
        lateral_velocity_ms: v.map(|v| v.x),
        vertical_velocity_ms: v.map(|v| v.y),
        longitudinal_acceleration_ms2: a.map(|a| -a.z),
        lateral_acceleration_ms2: a.map(|a| a.x),
        vertical_acceleration_ms2: a.map(|a| a.y),
        // Rotations per second around +Y (up); counterclockwise from above is positive.
        yaw_rate_deg_s: m
            .local_angular_velocity_rps
            .map(|w| round1(w.y * TURN_TO_DEG)),
        steering_input: i.steering_input,
        throttle_input: i.throttle_input,
        brake_input: i.brake_input,
        clutch_input: i.clutch_input,
        steering_effective: i.steering_effective,
        throttle_effective: i.throttle_effective,
        brake_effective: i.brake_effective,
        clutch_effective: i.clutch_effective,
        wheel_steering_angle_deg: m.wheel_steering_rot.map(|r| round1(r * TURN_TO_DEG)),
    }
}

/// Unit rotations -> degrees; axes and directions unchanged.
fn position(p: proto::Placement) -> Position {
    Position {
        x: p.x,
        y: p.y,
        z: p.z,
        heading_deg: (p.heading * TURN_TO_DEG).rem_euclid(360.0),
        pitch_deg: p.pitch * TURN_TO_DEG,
        roll_deg: p.roll * TURN_TO_DEG,
    }
}

fn navigation(n: proto::Navigation) -> Navigation {
    Navigation {
        distance_km: n.distance_m.map(|m| round1(m / 1000.0)),
        eta_min: n.time_s.map(|s| (s / 60.0).round()),
        // The SDK does not document a limit of 0. RoadPilot treats it as "no limit shown";
        // this interpretation still has to be confirmed in the game.
        speed_limit_kmh: n
            .speed_limit_mps
            .filter(|v| *v > 0.0)
            .map(|v| (v * MPS_TO_KMH).round()),
        speed_limit_shown: n.speed_limit_mps.map(|v| v > 0.0),
    }
}

fn job(j: Option<&proto::Job>, game: Game, now_min: Option<u32>, nav: &Navigation) -> Job {
    let Some(j) = j else {
        return Job::default();
    };
    let state = match j.state {
        proto::JobState::None => JobState::None,
        proto::JobState::Active => JobState::Active,
        proto::JobState::Delivered => JobState::Delivered,
        proto::JobState::Cancelled => JobState::Cancelled,
    };
    let now = now_min.map(i64::from);
    let deadline_min = j.delivery_time_min.map(i64::from);
    let progress_percent = match (state, nav.distance_km, j.planned_distance_km) {
        (JobState::Active, Some(remaining), Some(planned)) if planned > 0 => Some(round1(
            ((1.0 - remaining / planned as f32) * 100.0).clamp(0.0, 100.0),
        )),
        _ => None,
    };
    Job {
        state,
        cargo: j.cargo.clone(),
        cargo_mass_kg: j.cargo_mass_kg.map(f32::round),
        cargo_damage_percent: j.cargo_damage.map(|d| round1(d * 100.0)),
        source_city: j.source_city.clone(),
        source_company: j.source_company.clone(),
        destination_city: j.destination_city.clone(),
        destination_company: j.destination_company.clone(),
        income: j.income,
        currency: Some(match game {
            Game::Ets2 => "EUR",
            Game::Ats => "USD",
        }),
        deadline: match (deadline_min, now) {
            (Some(deadline), Some(now)) => Some(Deadline {
                day_offset: deadline.div_euclid(MINUTES_PER_DAY) - now.div_euclid(MINUTES_PER_DAY),
                time: clock(deadline),
            }),
            _ => None,
        },
        time_to_deadline_min: deadline_min.zip(now).map(|(d, n)| d - n),
        planned_distance_km: j.planned_distance_km,
        progress_percent,
        delivered_revenue: j.delivered_revenue,
        cancel_penalty: j.cancel_penalty,
    }
}

/// In-game minutes -> `HH:MM` of that in-game day.
fn clock(minutes: i64) -> String {
    let m = minutes.rem_euclid(MINUTES_PER_DAY);
    format!("{:02}:{:02}", m / 60, m % 60)
}

fn round1(value: f32) -> f32 {
    (value * 10.0).round() / 10.0
}

#[cfg(test)]
mod tests {
    use super::*;
    use proto::{GameId, PluginState, TelemetryFrame, Vec3};

    const FULL: &str = include_str!("../../tests/fixtures/frame-v2-full.json");

    fn decode(json: &str) -> TelemetryData {
        let decoded = proto::decode_frame(json.as_bytes()).unwrap();
        normalize(&FrameInput {
            frame: &decoded.frame,
            dropped_fields: &decoded.dropped_fields,
            received_at_unix_ms: 42,
        })
    }

    fn with(frame: TelemetryFrame) -> TelemetryData {
        normalize(&FrameInput {
            frame: &frame,
            dropped_fields: &[],
            received_at_unix_ms: 0,
        })
    }

    fn frame(game: GameId) -> TelemetryFrame {
        let mut f = TelemetryFrame::new(1, game, PluginState::Running);
        f.session = Some(1);
        f
    }

    #[test]
    fn converts_the_shared_full_fixture() {
        let d = decode(FULL);
        assert_eq!(d.source.schema_version, 2);
        assert_eq!(d.source.game_version.as_deref(), Some("1.21"));
        assert_eq!(d.source.sequence, 1234);
        assert_eq!(d.source.simulation_time_us, Some(98_765_432));
        assert_eq!(d.source.received_at_unix_ms, 42);

        let v = &d.vehicle;
        assert_eq!(v.speed_kmh, Some(81.0)); // 22.5 m/s
        assert_eq!(v.engine_rpm, Some(1351.0));
        assert_eq!(v.gear, Some(11));
        assert_eq!(v.engine_running, Some(true));
        assert_eq!(v.fuel_l, Some(412.5));
        assert_eq!(v.fuel_capacity_l, Some(800.0));
        assert_eq!(v.fuel_percent, Some(51.6));
        assert_eq!(v.fuel_consumption_l_per_100km, Some(35.0));
        assert_eq!(v.water_temperature_c, Some(88.0));
        assert_eq!(v.cruise_control_on, Some(true));
        assert_eq!(v.cruise_control_kmh, Some(80.0)); // 22.222 m/s
        assert_eq!(v.retarder_steps, Some(3));
        assert_eq!(v.brand.as_deref(), Some("Scania"));
        assert_eq!(v.wheelbase_m, Some(3.0)); // front z -1.75, drive z 1.25

        let j = &d.job;
        assert_eq!(j.state, JobState::Active);
        assert_eq!(j.cargo.as_deref(), Some("Electronics"));
        assert_eq!(j.destination_city.as_deref(), Some("Praha \"Hlavní\""));
        assert_eq!(j.income, Some(24_360));
        assert_eq!(j.currency, Some("EUR"));
        assert_eq!(j.cargo_damage_percent, Some(1.5));
        // Deadline minute 3412 = day 2, 08:52; now = minute 2000 = day 1.
        assert_eq!(
            j.deadline,
            Some(Deadline {
                day_offset: 1,
                time: "08:52".into()
            })
        );
        assert_eq!(j.time_to_deadline_min, Some(1412));
        // 742 km navigation distance of 742 km planned: at the start.
        assert_eq!(j.progress_percent, Some(0.0));

        assert_eq!(d.navigation.distance_km, Some(742.0));
        assert_eq!(d.navigation.eta_min, Some(552.0));
        assert_eq!(d.navigation.speed_limit_kmh, Some(80.0));
        assert_eq!(d.environment.game_clock.as_deref(), Some("09:20"));
    }

    #[test]
    fn maps_vehicle_axes_to_forward_right_up() {
        let mut f = frame(GameId::Ets2);
        f.motion = Some(proto::Motion {
            local_velocity_mps: Some(Vec3 {
                x: 0.5,
                y: -0.25,
                z: -20.0,
            }),
            local_acceleration_mps2: Some(Vec3 {
                x: -1.0,
                y: 0.0,
                z: 2.0,
            }),
            local_angular_velocity_rps: Some(Vec3 {
                x: 0.0,
                y: 0.05,
                z: 0.0,
            }),
            wheel_steering_rot: Some(-0.05),
        });
        let d = with(f).dynamics;
        assert_eq!(
            d.longitudinal_velocity_ms,
            Some(20.0),
            "Z backwards -> forward"
        );
        assert_eq!(d.lateral_velocity_ms, Some(0.5), "X right");
        assert_eq!(d.vertical_velocity_ms, Some(-0.25), "Y up");
        assert_eq!(
            d.longitudinal_acceleration_ms2,
            Some(-2.0),
            "braking is negative"
        );
        assert_eq!(d.lateral_acceleration_ms2, Some(-1.0));
        assert_eq!(d.yaw_rate_deg_s, Some(18.0));
        assert_eq!(d.wheel_steering_angle_deg, Some(-18.0), "right turn");
    }

    #[test]
    fn keeps_input_ranges_and_steering_direction() {
        let mut f = frame(GameId::Ats);
        f.inputs = Some(proto::Inputs {
            steering_input: Some(0.5),
            throttle_input: Some(0.25),
            brake_effective: Some(1.0),
            ..proto::Inputs::default()
        });
        let d = with(f).dynamics;
        assert_eq!(d.steering_input, Some(0.5), "positive stays left");
        assert_eq!(d.throttle_input, Some(0.25));
        assert_eq!(d.brake_effective, Some(1.0));
        assert_eq!(d.brake_input, None);
    }

    #[test]
    fn converts_orientation_to_degrees_without_changing_direction() {
        let mut f = frame(GameId::Ets2);
        f.placement = Some(proto::Placement {
            x: -100.5,
            y: 10.0,
            z: 2000.25,
            heading: 0.25,
            pitch: -0.125,
            roll: 0.5,
        });
        let p = with(f).position.unwrap();
        assert_eq!((p.x, p.y, p.z), (-100.5, 10.0, 2000.25));
        assert_eq!(p.heading_deg, 90.0, "0.25 turn counterclockwise = west");
        assert_eq!(p.pitch_deg, -45.0);
        assert_eq!(p.roll_deg, 180.0);
        let mut f = frame(GameId::Ets2);
        f.placement = Some(proto::Placement {
            heading: 1.0,
            ..proto::Placement::default()
        });
        assert_eq!(with(f).position.unwrap().heading_deg, 0.0);
    }

    #[test]
    fn missing_values_stay_missing_and_calculations_need_all_inputs() {
        let mut f = frame(GameId::Ats);
        f.truck = Some(proto::TruckState {
            fuel_l: Some(100.0),
            cruise_control_mps: Some(0.0),
            ..proto::TruckState::default()
        });
        let d = with(f);
        assert_eq!(d.vehicle.fuel_percent, None, "no capacity, no percentage");
        assert_eq!(d.vehicle.cruise_control_on, Some(false));
        assert_eq!(d.vehicle.cruise_control_kmh, None);
        assert_eq!(d.vehicle.speed_kmh, None);
        assert_eq!(d.vehicle.adblue_l, None);
        assert!(d.position.is_none());
        assert_eq!(d.job.state, JobState::Unknown);
        assert_eq!(d.navigation, Navigation::default());
        assert_eq!(d.environment.game_clock, None);
    }

    #[test]
    fn job_states_currency_and_overdue_deadlines() {
        let mut f = frame(GameId::Ats);
        f.game_time_min = Some(3 * 1440 + 600);
        f.job = Some(proto::Job {
            state: proto::JobState::Active,
            cargo: None,
            cargo_mass_kg: None,
            cargo_damage: None,
            cargo_loaded: None,
            source_city: None,
            source_company: None,
            destination_city: None,
            destination_company: None,
            income: Some(5_000),
            delivery_time_min: Some(3 * 1440 + 540),
            planned_distance_km: Some(100),
            job_market: None,
            delivered_revenue: None,
            cancel_penalty: None,
        });
        f.navigation = Some(proto::Navigation {
            distance_m: Some(25_000.0),
            time_s: None,
            speed_limit_mps: Some(0.0),
        });
        let d = with(f);
        assert_eq!(d.job.currency, Some("USD"));
        assert_eq!(d.job.time_to_deadline_min, Some(-60), "one hour late");
        assert_eq!(
            d.job.deadline,
            Some(Deadline {
                day_offset: 0,
                time: "09:00".into()
            })
        );
        assert_eq!(d.job.progress_percent, Some(75.0));
        assert_eq!(d.navigation.speed_limit_kmh, None);
        assert_eq!(d.navigation.speed_limit_shown, Some(false));

        let mut f = frame(GameId::Ets2);
        f.job = Some(proto::Job {
            state: proto::JobState::Delivered,
            delivered_revenue: Some(25_000),
            ..job_template()
        });
        let j = with(f).job;
        assert_eq!(j.state, JobState::Delivered);
        assert_eq!(j.delivered_revenue, Some(25_000));
        assert_eq!(j.progress_percent, None, "progress only for active jobs");
    }

    #[test]
    fn schema_1_frames_only_fill_speed_rpm_and_gear() {
        let v1 = r#"{"protocol":"roadpilot.telemetry","schemaVersion":1,"sequence":3,"game":"ats","pluginState":"running","values":{"speedMps":10,"engineRpm":900.4,"gear":3}}"#;
        let d = decode(v1);
        assert_eq!(d.source.schema_version, 1);
        assert_eq!(d.vehicle.speed_kmh, Some(36.0));
        assert_eq!(d.vehicle.engine_rpm, Some(900.0));
        assert_eq!(d.vehicle.gear, Some(3));
        assert_eq!(d.vehicle.fuel_l, None);
        assert_eq!(d.job.state, JobState::Unknown);
    }

    #[test]
    fn reports_values_removed_as_invalid() {
        let bad = r#"{"protocol":"roadpilot.telemetry","schemaVersion":2,"session":1,"sequence":1,"game":"ets2","pluginState":"running","truck":{"engineRpm":-5,"gear":4}}"#;
        let d = decode(bad);
        assert_eq!(d.vehicle.engine_rpm, None);
        assert_eq!(d.vehicle.gear, Some(4));
        assert_eq!(d.source.invalid_fields, vec!["truck.engineRpm".to_string()]);
    }

    fn wheel(z: f32, steerable: bool, powered: bool) -> proto::WheelConfig {
        proto::WheelConfig {
            position_m: Some(Vec3 { x: 0.9, y: 0.5, z }),
            radius_m: Some(0.5),
            steerable: Some(steerable),
            powered: Some(powered),
        }
    }

    fn wheelbase_of(count: Option<u32>, wheels: Option<Vec<proto::WheelConfig>>) -> Option<f32> {
        let mut f = frame(GameId::Ats);
        f.truck_config = Some(proto::TruckConfig {
            wheel_count: count,
            wheels,
            ..proto::TruckConfig::default()
        });
        with(f).vehicle.wheelbase_m
    }

    #[test]
    fn wheelbase_uses_steerable_and_drive_axle_group_centres() {
        // 6x4: steerable front axle, two powered rear axles (tandem), one unpowered rear.
        let wheels = vec![
            wheel(-2.0, true, false),
            wheel(-2.0, true, false),
            wheel(2.0, false, true),
            wheel(3.2, false, true),
            wheel(5.0, false, false),
        ];
        assert_eq!(wheelbase_of(Some(5), Some(wheels)), Some(4.6)); // (2.0+3.2)/2 - (-2.0)
        // A powered steerable front wheel does not count as a drive wheel.
        let awd = vec![wheel(-1.5, true, true), wheel(2.0, false, true)];
        assert_eq!(wheelbase_of(Some(2), Some(awd)), Some(3.5));
    }

    #[test]
    fn wheelbase_is_absent_for_incomplete_or_invalid_geometry() {
        let ok = vec![wheel(-1.5, true, false), wheel(2.0, false, true)];
        assert_eq!(wheelbase_of(Some(2), Some(ok.clone())), Some(3.5));
        assert_eq!(wheelbase_of(None, None), None);
        assert_eq!(wheelbase_of(Some(2), None), None);
        assert_eq!(wheelbase_of(None, Some(ok.clone())), None);
        assert_eq!(wheelbase_of(Some(0), Some(vec![])), None);
        // Truncated list: the game reported more wheels than the protocol carries.
        assert_eq!(wheelbase_of(Some(16), Some(ok.clone())), None);
        // Missing position, steerable or powered on any wheel.
        for broken in 0..3 {
            let mut w = ok.clone();
            match broken {
                0 => w[1].position_m = None,
                1 => w[1].steerable = None,
                _ => w[0].powered = None,
            }
            assert_eq!(wheelbase_of(Some(2), Some(w)), None);
        }
        // No steerable wheel, no drive wheel, non-finite position, implausible distance.
        let no_steer = vec![wheel(-1.5, false, false), wheel(2.0, false, true)];
        assert_eq!(wheelbase_of(Some(2), Some(no_steer)), None);
        let no_drive = vec![wheel(-1.5, true, false), wheel(2.0, false, false)];
        assert_eq!(wheelbase_of(Some(2), Some(no_drive)), None);
        let nan = vec![wheel(f32::NAN, true, false), wheel(2.0, false, true)];
        assert_eq!(wheelbase_of(Some(2), Some(nan)), None);
        let same = vec![wheel(1.0, true, false), wheel(1.1, false, true)];
        assert_eq!(wheelbase_of(Some(2), Some(same)), None);
        let far = vec![wheel(-20.0, true, false), wheel(20.0, false, true)];
        assert_eq!(wheelbase_of(Some(2), Some(far)), None);
    }

    fn job_template() -> proto::Job {
        proto::Job {
            state: proto::JobState::None,
            cargo: None,
            cargo_mass_kg: None,
            cargo_damage: None,
            cargo_loaded: None,
            source_city: None,
            source_company: None,
            destination_city: None,
            destination_company: None,
            income: None,
            delivery_time_min: None,
            planned_distance_km: None,
            job_market: None,
            delivered_revenue: None,
            cancel_penalty: None,
        }
    }
}
