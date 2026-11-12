//! The vehicle state a controller is allowed to see.
//!
//! [`VehicleState::from_frame`] turns a decoded telemetry frame into a state that is
//! guaranteed to contain everything control needs and nothing non-finite. A frame that does
//! not qualify is rejected with a reason; nothing is ever defaulted to zero, because for
//! telemetry "absent" never means zero.
//!
//! Values keep the raw SDK units (see `docs/telemetry.md` and the telemetry protocol):
//! metres, metres per second, rotations in turns, vehicle space X right / Y up / Z backwards,
//! world space X east / Y up / Z south. Conversions belong to the controller that needs them.

use roadpilot_telemetry_client::{
    CURRENT_SCHEMA_VERSION, GameId, Placement, PluginState, TelemetryFrame,
};

/// Which frame a value comes from. Together these identify a frame uniquely and let a
/// consumer order frames and notice a restart of the game or the plugin.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct FrameIdentity {
    pub game: GameId,
    /// Random id of one plugin initialization; a different value means the game or the
    /// plugin was restarted.
    pub session: u64,
    /// Strictly increasing within a session. Gaps are normal because the plugin replaces
    /// unsent frames by newer ones; repeats and decreases are not.
    pub sequence: u64,
    /// SDK simulation time in microseconds. Advances even while the game is paused and can
    /// restart from zero; it is never used for ordering.
    pub simulation_time_us: u64,
}

/// Why a frame cannot be used for control.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum InvalidFrame {
    /// Only schema 2 carries the identity fields control relies on.
    UnsupportedSchema(u16),
    /// Frames without a session cannot be told apart from a restarted game.
    MissingSession,
    /// Required to cross-check the local receive time; absent when the plugin could not
    /// register for the SDK frame start event.
    MissingSimulationTime,
    /// The game is paused: the SDK stops updating the vehicle values, so they are not a
    /// current reading of the truck.
    NotRunning,
    /// A value control requires is absent (wire path).
    MissingField(&'static str),
    /// A required value is NaN or infinite (wire path).
    NonFiniteValue(&'static str),
}

impl FrameIdentity {
    /// Extracts and checks the identity of a frame, whatever its plugin state.
    pub fn from_frame(frame: &TelemetryFrame) -> Result<Self, InvalidFrame> {
        if frame.schema_version != CURRENT_SCHEMA_VERSION {
            return Err(InvalidFrame::UnsupportedSchema(frame.schema_version));
        }
        Ok(Self {
            game: frame.game,
            session: frame.session.ok_or(InvalidFrame::MissingSession)?,
            sequence: frame.sequence,
            simulation_time_us: frame
                .simulation_time_us
                .ok_or(InvalidFrame::MissingSimulationTime)?,
        })
    }
}

/// A validated snapshot of the player's truck.
///
/// Required values are plain fields. Optional values are `None` when the game did not
/// provide them (or provided a non-finite number); a controller that needs one must treat
/// `None` as "cannot act".
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct VehicleState {
    pub identity: FrameIdentity,
    /// Signed speed in m/s; negative while reversing. `truck.speedMps`.
    pub speed_mps: f32,
    /// World position in metres and orientation in turns (heading counterclockwise from
    /// north). `placement`.
    pub placement: Placement,
    /// Physical road-wheel angle in turns, positive = left. `motion.wheelSteeringRot`.
    pub wheel_steering_rot: Option<f32>,
    /// Steering the simulation applies, -1..1, positive = left. `inputs.steeringEffective`.
    pub steering_effective: Option<f32>,
    /// Throttle the simulation applies, 0..1. `inputs.throttleEffective`.
    pub throttle_effective: Option<f32>,
    /// Service brake the simulation applies, 0..1. `inputs.brakeEffective`.
    pub brake_effective: Option<f32>,
    /// Yaw rate in turns per second (vehicle-space Y angular velocity).
    /// `motion.localAngularVelocityRps.y`.
    pub yaw_rate_rps: Option<f32>,
    /// >0 forward, 0 neutral, <0 reverse. `truck.gear`.
    pub gear: Option<i32>,
    pub parking_brake: Option<bool>,
    pub engine_enabled: Option<bool>,
}

fn finite(value: Option<f32>) -> Option<f32> {
    value.filter(|v| v.is_finite())
}

fn required(value: Option<f32>, path: &'static str) -> Result<f32, InvalidFrame> {
    let value = value.ok_or(InvalidFrame::MissingField(path))?;
    if value.is_finite() {
        Ok(value)
    } else {
        Err(InvalidFrame::NonFiniteValue(path))
    }
}

impl VehicleState {
    /// Builds the control state of a frame that reports the game as running. Paused frames
    /// are refused with [`InvalidFrame::NotRunning`].
    pub fn from_frame(frame: &TelemetryFrame) -> Result<Self, InvalidFrame> {
        let identity = FrameIdentity::from_frame(frame)?;
        if frame.plugin_state != PluginState::Running {
            return Err(InvalidFrame::NotRunning);
        }

        let speed_mps = required(frame.truck.and_then(|t| t.speed_mps), "truck.speedMps")?;
        let placement = frame
            .placement
            .ok_or(InvalidFrame::MissingField("placement"))?;
        let coordinates_finite = [placement.x, placement.y, placement.z]
            .iter()
            .all(|v| v.is_finite());
        if !coordinates_finite {
            return Err(InvalidFrame::NonFiniteValue("placement"));
        }
        required(Some(placement.heading), "placement.heading")?;

        let inputs = frame.inputs.unwrap_or_default();
        let truck = frame.truck.unwrap_or_default();
        let motion = frame.motion.unwrap_or_default();
        Ok(Self {
            identity,
            speed_mps,
            placement,
            wheel_steering_rot: finite(motion.wheel_steering_rot),
            steering_effective: finite(inputs.steering_effective),
            throttle_effective: finite(inputs.throttle_effective),
            brake_effective: finite(inputs.brake_effective),
            yaw_rate_rps: finite(motion.local_angular_velocity_rps.map(|v| v.y)),
            gear: truck.gear,
            parking_brake: truck.parking_brake,
            engine_enabled: truck.engine_enabled,
        })
    }
}

#[cfg(test)]
pub(crate) mod test_support {
    use super::*;
    use roadpilot_telemetry_client::{Inputs, Motion, TruckState, Vec3};

    /// A valid running schema 2 frame with the required values set.
    pub fn running_frame(session: u64, sequence: u64, simulation_time_us: u64) -> TelemetryFrame {
        let mut f = TelemetryFrame::new(sequence, GameId::Ets2, PluginState::Running);
        f.session = Some(session);
        f.simulation_time_us = Some(simulation_time_us);
        f.truck = Some(TruckState {
            speed_mps: Some(20.0),
            gear: Some(8),
            parking_brake: Some(false),
            engine_enabled: Some(true),
            ..TruckState::default()
        });
        f.placement = Some(Placement {
            x: 100.0,
            y: 45.0,
            z: -50.0,
            heading: 0.25,
            pitch: 0.0,
            roll: 0.0,
        });
        f.inputs = Some(Inputs {
            steering_effective: Some(-0.1),
            throttle_effective: Some(0.5),
            brake_effective: Some(0.0),
            ..Inputs::default()
        });
        f.motion = Some(Motion {
            wheel_steering_rot: Some(-0.03),
            local_angular_velocity_rps: Some(Vec3 {
                x: 0.0,
                y: 0.0125,
                z: 0.0,
            }),
            ..Motion::default()
        });
        f
    }

    /// A usable assessment of epoch 1, session 7 at 3 m/s: slow enough to arm under the
    /// default speed cap.
    pub fn slow_usable_assessment() -> crate::control::freshness::Assessment {
        let mut frame = running_frame(7, 10, 1_000_000);
        frame.truck.as_mut().unwrap().speed_mps = Some(3.0);
        crate::control::freshness::Assessment::Usable(crate::control::freshness::Sample {
            state: VehicleState::from_frame(&frame).unwrap(),
            epoch: 1,
            age: std::time::Duration::from_millis(5),
        })
    }

    pub fn paused_frame(session: u64, sequence: u64, simulation_time_us: u64) -> TelemetryFrame {
        let mut f = TelemetryFrame::new(sequence, GameId::Ets2, PluginState::Paused);
        f.session = Some(session);
        f.simulation_time_us = Some(simulation_time_us);
        f
    }
}

#[cfg(test)]
mod tests {
    use super::test_support::running_frame;
    use super::*;
    use roadpilot_telemetry_client as proto;

    const FULL: &str = include_str!("../../tests/fixtures/frame-v2-full.json");

    #[test]
    fn builds_the_state_from_the_shared_full_fixture() {
        let decoded = proto::decode_frame(FULL.as_bytes()).unwrap();
        let s = VehicleState::from_frame(&decoded.frame).unwrap();
        assert_eq!(s.identity.game, GameId::Ets2);
        assert_eq!(s.identity.session, 4_242_424_242);
        assert_eq!(s.identity.sequence, 1234);
        assert_eq!(s.identity.simulation_time_us, 98_765_432);
        assert_eq!(s.speed_mps, 22.5);
        assert_eq!(s.placement.x, -31234.5678);
        assert_eq!(s.placement.heading, 0.25);
        assert_eq!(s.wheel_steering_rot, Some(-0.03));
        assert_eq!(s.steering_effective, Some(-0.1));
        assert_eq!(s.throttle_effective, Some(0.7));
        assert_eq!(s.brake_effective, Some(0.0));
        assert_eq!(s.yaw_rate_rps, Some(0.0125));
        assert_eq!(s.gear, Some(11));
        assert_eq!(s.parking_brake, Some(false));
        assert_eq!(s.engine_enabled, Some(true));
    }

    #[test]
    fn optional_values_stay_absent_and_are_never_defaulted() {
        let mut f = running_frame(1, 1, 1_000);
        f.inputs = None;
        f.motion = None;
        f.truck = Some(proto::TruckState {
            speed_mps: Some(5.0),
            ..Default::default()
        });
        let s = VehicleState::from_frame(&f).unwrap();
        assert_eq!(s.wheel_steering_rot, None);
        assert_eq!(s.steering_effective, None);
        assert_eq!(s.throttle_effective, None);
        assert_eq!(s.brake_effective, None);
        assert_eq!(s.yaw_rate_rps, None);
        assert_eq!(s.gear, None);
        assert_eq!(s.parking_brake, None);
        assert_eq!(s.engine_enabled, None);
    }

    #[test]
    fn non_finite_optional_values_become_absent() {
        let mut f = running_frame(1, 1, 1_000);
        f.motion = Some(proto::Motion {
            wheel_steering_rot: Some(f32::NAN),
            local_angular_velocity_rps: Some(proto::Vec3 {
                x: 0.0,
                y: f32::INFINITY,
                z: 0.0,
            }),
            ..Default::default()
        });
        f.inputs = Some(proto::Inputs {
            throttle_effective: Some(f32::NEG_INFINITY),
            ..Default::default()
        });
        let s = VehicleState::from_frame(&f).unwrap();
        assert_eq!(s.wheel_steering_rot, None);
        assert_eq!(s.yaw_rate_rps, None);
        assert_eq!(s.throttle_effective, None);
    }

    #[test]
    fn paused_frames_are_not_a_vehicle_state() {
        let mut f = running_frame(1, 1, 1_000);
        f.plugin_state = PluginState::Paused;
        assert_eq!(VehicleState::from_frame(&f), Err(InvalidFrame::NotRunning));
    }

    #[test]
    fn frames_without_identity_are_rejected() {
        let mut f = running_frame(1, 1, 1_000);
        f.session = None;
        assert_eq!(
            VehicleState::from_frame(&f),
            Err(InvalidFrame::MissingSession)
        );

        let mut f = running_frame(1, 1, 1_000);
        f.simulation_time_us = None;
        assert_eq!(
            VehicleState::from_frame(&f),
            Err(InvalidFrame::MissingSimulationTime)
        );

        let mut f = running_frame(1, 1, 1_000);
        f.schema_version = 1;
        assert_eq!(
            VehicleState::from_frame(&f),
            Err(InvalidFrame::UnsupportedSchema(1))
        );
    }

    #[test]
    fn an_upgraded_schema_1_frame_is_never_usable() {
        // Schema 1 frames are upgraded to the schema 2 model without session, time or
        // placement, and must not reach a controller.
        let f = TelemetryFrame::new(7, GameId::Ats, PluginState::Running);
        assert_eq!(
            VehicleState::from_frame(&f),
            Err(InvalidFrame::MissingSession)
        );
    }

    #[test]
    fn missing_required_values_are_rejected() {
        let mut f = running_frame(1, 1, 1_000);
        f.truck = None;
        assert_eq!(
            VehicleState::from_frame(&f),
            Err(InvalidFrame::MissingField("truck.speedMps"))
        );

        let mut f = running_frame(1, 1, 1_000);
        f.truck.as_mut().unwrap().speed_mps = None;
        assert_eq!(
            VehicleState::from_frame(&f),
            Err(InvalidFrame::MissingField("truck.speedMps"))
        );

        let mut f = running_frame(1, 1, 1_000);
        f.placement = None;
        assert_eq!(
            VehicleState::from_frame(&f),
            Err(InvalidFrame::MissingField("placement"))
        );
    }

    #[test]
    fn non_finite_required_values_are_rejected() {
        for speed in [f32::NAN, f32::INFINITY, f32::NEG_INFINITY] {
            let mut f = running_frame(1, 1, 1_000);
            f.truck.as_mut().unwrap().speed_mps = Some(speed);
            assert_eq!(
                VehicleState::from_frame(&f),
                Err(InvalidFrame::NonFiniteValue("truck.speedMps"))
            );
        }
        for bad in [f64::NAN, f64::INFINITY] {
            let mut f = running_frame(1, 1, 1_000);
            f.placement.as_mut().unwrap().z = bad;
            assert_eq!(
                VehicleState::from_frame(&f),
                Err(InvalidFrame::NonFiniteValue("placement"))
            );
        }
        let mut f = running_frame(1, 1, 1_000);
        f.placement.as_mut().unwrap().heading = f32::NAN;
        assert_eq!(
            VehicleState::from_frame(&f),
            Err(InvalidFrame::NonFiniteValue("placement.heading"))
        );
    }
}
