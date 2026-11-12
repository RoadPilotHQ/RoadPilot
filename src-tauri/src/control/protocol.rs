//! Encoder for the RoadPilot Input pipe protocol, version 2.
//!
//! Byte-compatible with RoadPilot-SDK (`docs/PROTOCOL.md`, `src/input_protocol.cpp`), checked
//! against the SDK's own test vector. Only version 2 is implemented: version 1 cannot carry
//! steering and RoadPilot has no use for it.
//!
//! One message is 20 bytes, little endian:
//!
//! | Offset | Size | Field      | Value                                              |
//! |-------:|-----:|------------|----------------------------------------------------|
//! | 0      | 4    | magic      | `R` `P` `I` `N`                                    |
//! | 4      | 2    | version    | `2`                                                |
//! | 6      | 1    | `enabled`  | `0` = disarm everything, `1` = armed               |
//! | 7      | 1    | `flags`    | bit 0 = `steering_enabled`; other bits must be 0   |
//! | 8      | 4    | `throttle` | IEEE-754 float32                                   |
//! | 12     | 4    | `brake`    | IEEE-754 float32                                   |
//! | 16     | 4    | `steering` | IEEE-754 float32                                   |
//!
//! The encoder accepts only [`WireMessage`], which can hold nothing but the explicit disarm
//! message or a validated [`ControlCommand`]. Encoding is therefore infallible and cannot
//! produce a message the plugin would reject. This module does no I/O.

use super::command::ControlCommand;

pub const MESSAGE_LEN: usize = 20;
const MAGIC: [u8; 4] = *b"RPIN";
const VERSION: u16 = 2;
const FLAG_STEERING_ENABLED: u8 = 0x01;

/// What may be put on the wire.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum WireMessage {
    /// Explicit disarm: `enabled = 0`, every value 0, steering off. The plugin returns to its
    /// safe state and ignores the values.
    Disarm,
    /// An armed command. Steering is claimed (`steering_enabled = 1`) only if the command
    /// requests it.
    Command(ControlCommand),
}

pub fn encode(message: &WireMessage) -> [u8; MESSAGE_LEN] {
    match message {
        WireMessage::Disarm => encode_raw(false, false, 0.0, 0.0, 0.0),
        WireMessage::Command(c) => encode_raw(
            true,
            c.steering().is_some(),
            c.throttle(),
            c.brake(),
            c.steering().unwrap_or(0.0),
        ),
    }
}

/// The byte layout. Private: callers cannot reach it with unvalidated values.
fn encode_raw(
    enabled: bool,
    steering_enabled: bool,
    throttle: f32,
    brake: f32,
    steering: f32,
) -> [u8; MESSAGE_LEN] {
    let mut m = [0u8; MESSAGE_LEN];
    m[0..4].copy_from_slice(&MAGIC);
    m[4..6].copy_from_slice(&VERSION.to_le_bytes());
    m[6] = u8::from(enabled);
    m[7] = if steering_enabled {
        FLAG_STEERING_ENABLED
    } else {
        0
    };
    m[8..12].copy_from_slice(&throttle.to_le_bytes());
    m[12..16].copy_from_slice(&brake.to_le_bytes());
    m[16..20].copy_from_slice(&steering.to_le_bytes());
    m
}

#[cfg(test)]
mod tests {
    use super::super::command::{
        CommandGenerator, ControlLimits, ControlRequest, SDK_STEERING_RATE_PER_S,
    };
    use super::super::supervisor::{Command, Supervisor};
    use super::super::vehicle::test_support::slow_usable_assessment;
    use super::*;
    use std::time::{Duration, Instant};

    /// The v2 vector from RoadPilot-SDK `tests/core_tests.cpp` (test_v2_wire_format_and_
    /// validation): throttle 0.5, brake 1.0, steering -0.5 (0xBF000000), steering enabled.
    const SDK_V2_VECTOR: [u8; 20] = [
        b'R', b'P', b'I', b'N', 2, 0, 1, 1, 0, 0, 0, 0x3F, 0, 0, 0x80, 0x3F, 0, 0, 0, 0xBF,
    ];

    /// Mirror of the SDK's `parse_message` (src/input_protocol.cpp) for version 2, to prove
    /// that what the encoder writes passes the plugin's validation.
    #[derive(Debug, PartialEq)]
    struct Parsed {
        enabled: bool,
        steering_enabled: bool,
        throttle: f32,
        brake: f32,
        steering: f32,
    }

    fn sdk_parse(data: &[u8]) -> Result<Parsed, &'static str> {
        if data.len() != 16 && data.len() != 20 {
            return Err("bad size");
        }
        if data[0..4] != *b"RPIN" {
            return Err("bad magic");
        }
        let version = u16::from_le_bytes([data[4], data[5]]);
        if version != 1 && version != 2 {
            return Err("bad version");
        }
        if (version == 1) != (data.len() == 16) {
            return Err("bad size");
        }
        if data[6] > 1 {
            return Err("bad enabled");
        }
        let v2 = version == 2;
        if if v2 { data[7] & !1 != 0 } else { data[7] != 0 } {
            return Err("bad reserved");
        }
        let f = |at: usize| f32::from_le_bytes(data[at..at + 4].try_into().unwrap());
        let (throttle, brake) = (f(8), f(12));
        let steering = if v2 { f(16) } else { 0.0 };
        if !(throttle.is_finite() && brake.is_finite() && steering.is_finite()) {
            return Err("non-finite");
        }
        Ok(Parsed {
            enabled: data[6] == 1,
            steering_enabled: v2 && data[7] & 1 != 0,
            throttle,
            brake,
            steering,
        })
    }

    fn command(steering: Option<f32>, throttle: f32, brake: f32) -> WireMessage {
        WireMessage::Command(
            ControlCommand::new(&ControlLimits::default(), steering, throttle, brake).unwrap(),
        )
    }

    #[test]
    fn the_layout_matches_the_sdk_vector_byte_for_byte() {
        // The SDK's vector has throttle and brake both set, which a validated command can
        // never hold, so it is checked against the byte layout directly.
        assert_eq!(encode_raw(true, true, 0.5, 1.0, -0.5), SDK_V2_VECTOR);
        let parsed = sdk_parse(&SDK_V2_VECTOR).unwrap();
        assert_eq!(
            parsed,
            Parsed {
                enabled: true,
                steering_enabled: true,
                throttle: 0.5,
                brake: 1.0,
                steering: -0.5
            }
        );
    }

    #[test]
    fn a_message_is_20_bytes_with_magic_and_version_2() {
        for m in [WireMessage::Disarm, command(Some(0.1), 0.05, 0.0)] {
            let b = encode(&m);
            assert_eq!(b.len(), 20);
            assert_eq!(MESSAGE_LEN, 20);
            assert_eq!(&b[0..4], b"RPIN");
            assert_eq!(&b[4..6], &[2, 0], "version 2, little endian");
        }
    }

    #[test]
    fn the_disarm_message_is_exact() {
        let expected: [u8; 20] = [
            b'R', b'P', b'I', b'N', 2, 0, 0, 0, // header, enabled = 0, flags = 0
            0, 0, 0, 0, // throttle 0.0
            0, 0, 0, 0, // brake 0.0
            0, 0, 0, 0, // steering 0.0
        ];
        assert_eq!(encode(&WireMessage::Disarm), expected);
        assert!(!sdk_parse(&expected).unwrap().enabled);
    }

    #[test]
    fn the_neutral_command_is_armed_without_claiming_steering() {
        let expected: [u8; 20] = [
            b'R', b'P', b'I', b'N', 2, 0, 1, 0, // enabled = 1, flags = 0
            0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
        ];
        assert_eq!(
            encode(&WireMessage::Command(ControlCommand::neutral())),
            expected
        );
    }

    #[test]
    fn maximum_default_values_encode_to_the_documented_floats() {
        // 0.15f32 = 0x3E19999A, 0.10f32 = 0x3DCCCCCD, 1.0f32 = 0x3F800000.
        let steer_left = encode(&command(Some(0.15), 0.10, 0.0));
        assert_eq!(
            steer_left,
            [
                b'R', b'P', b'I', b'N', 2, 0, 1, 1, //
                0xCD, 0xCC, 0xCC, 0x3D, // throttle 0.10
                0x00, 0x00, 0x00, 0x00, // brake 0
                0x9A, 0x99, 0x19, 0x3E, // steering +0.15
            ]
        );
        let steer_right = encode(&command(Some(-0.15), 0.0, 1.0));
        assert_eq!(
            steer_right,
            [
                b'R', b'P', b'I', b'N', 2, 0, 1, 1, //
                0x00, 0x00, 0x00, 0x00, // throttle 0
                0x00, 0x00, 0x80, 0x3F, // brake 1.0
                0x9A, 0x99, 0x19, 0xBE, // steering -0.15
            ]
        );
    }

    #[test]
    fn steering_none_leaves_the_flag_and_value_clear() {
        let b = encode(&command(None, 0.10, 0.0));
        assert_eq!(b[7], 0, "steering_enabled off");
        assert_eq!(&b[16..20], &[0, 0, 0, 0]);
        let b = encode(&command(Some(0.0), 0.0, 0.0));
        assert_eq!(b[7], 1, "an explicit zero still claims the axis");
        assert_eq!(&b[16..20], &[0, 0, 0, 0]);
    }

    #[test]
    fn brake_override_is_visible_on_the_wire() {
        let b = encode(&command(None, 0.08, 0.5));
        assert_eq!(&b[8..12], &[0, 0, 0, 0], "throttle is zero");
        assert_eq!(&b[12..16], &0.5f32.to_le_bytes());
    }

    #[test]
    fn negative_zero_never_reaches_the_wire() {
        let b = encode(&command(Some(-0.0), -0.0, -0.0));
        assert_eq!(&b[8..20], &[0u8; 12]);
    }

    #[test]
    fn disarm_and_commands_always_pass_the_sdk_validation() {
        assert!(sdk_parse(&encode(&WireMessage::Disarm)).is_ok());
        let grid = [-0.15f32, -0.1, -0.000_1, 0.0, 0.000_1, 0.05, 0.1, 0.15];
        let pedals = [0.0f32, 0.000_1, 0.05, 0.1, 0.5, 1.0];
        let l = ControlLimits::default();
        let mut checked = 0;
        for steering in std::iter::once(None).chain(grid.iter().copied().map(Some)) {
            for &throttle in &pedals {
                for &brake in &pedals {
                    let Ok(c) = ControlCommand::new(&l, steering, throttle, brake) else {
                        continue; // outside the limits: cannot be constructed, so not encoded
                    };
                    let parsed = sdk_parse(&encode(&WireMessage::Command(c))).unwrap();
                    assert!(parsed.enabled);
                    assert_eq!(parsed.steering_enabled, steering.is_some());
                    assert!(parsed.throttle == 0.0 || parsed.brake == 0.0);
                    assert!(parsed.steering.abs() <= l.max_steering());
                    assert!((0.0..=l.max_throttle()).contains(&parsed.throttle));
                    assert!((0.0..=l.max_brake()).contains(&parsed.brake));
                    checked += 1;
                }
            }
        }
        assert!(checked > 100, "{checked}");
    }

    #[test]
    fn the_reference_parser_rejects_what_the_sdk_rejects() {
        // Guards the guard: the mirror must actually discriminate.
        let good = encode(&command(Some(0.1), 0.05, 0.0));
        assert!(sdk_parse(&good).is_ok());
        assert_eq!(sdk_parse(&good[..19]), Err("bad size"));
        let mut m = good;
        m[0] = b'X';
        assert_eq!(sdk_parse(&m), Err("bad magic"));
        m = good;
        m[4] = 3;
        assert_eq!(sdk_parse(&m), Err("bad version"));
        m = good;
        m[4] = 1;
        assert_eq!(sdk_parse(&m), Err("bad size"));
        m = good;
        m[6] = 2;
        assert_eq!(sdk_parse(&m), Err("bad enabled"));
        m = good;
        m[7] = 3;
        assert_eq!(sdk_parse(&m), Err("bad reserved"));
        m = good;
        m[16..20].copy_from_slice(&f32::NAN.to_le_bytes());
        assert_eq!(sdk_parse(&m), Err("non-finite"));
    }

    #[test]
    fn the_application_rate_limit_is_within_the_plugin_limit() {
        // The plugin's limiter is a second line of defence only if ours is at least as strict.
        let l = ControlLimits::default();
        assert!(l.max_steering_rate_per_s() <= SDK_STEERING_RATE_PER_S);
        assert!(ControlLimits::new(0.15, 0.1, 1.0, SDK_STEERING_RATE_PER_S + 0.01).is_err());
    }

    #[test]
    fn a_full_pipeline_run_produces_only_plugin_valid_messages() {
        // Supervisor Active -> generator -> encoder over a jagged request sequence.
        let mut supervisor = Supervisor::default();
        let usable = slow_usable_assessment();
        supervisor.command(Command::Arm, &usable);
        supervisor.command(Command::Activate, &usable);
        assert!(supervisor.permits_output());

        let mut generator = CommandGenerator::new(ControlLimits::default());
        let t0 = Instant::now();
        let mut previous_steering = 0.0f32;
        for i in 0..500u64 {
            let phase = (i as f32 * 0.37).sin();
            let request = ControlRequest {
                steering: Some(phase * 3.0),
                throttle: (phase + 1.0) * 0.5,
                brake: if i % 50 > 40 { 0.7 } else { 0.0 },
            };
            let generated = generator
                .generate(&supervisor, request, t0 + Duration::from_millis(i * 30))
                .unwrap();
            let parsed = sdk_parse(&encode(&WireMessage::Command(generated.command))).unwrap();
            assert!(parsed.steering.abs() <= 0.15 + 1e-6);
            assert!(parsed.throttle <= 0.10 + 1e-6);
            assert!(parsed.throttle == 0.0 || parsed.brake == 0.0);
            if previous_steering != 0.0 && parsed.steering != 0.0 {
                assert_eq!(previous_steering > 0.0, parsed.steering > 0.0);
            }
            previous_steering = parsed.steering;
        }
    }

    #[test]
    fn nothing_is_encoded_once_the_supervisor_stops_permitting_output() {
        // The generator yields no command, so the only wire message left is the disarm.
        let mut supervisor = Supervisor::default();
        let usable = slow_usable_assessment();
        supervisor.command(Command::Arm, &usable);
        supervisor.command(Command::Activate, &usable);
        supervisor.command(Command::Disarm, &usable);
        let mut generator = CommandGenerator::new(ControlLimits::default());
        let request = ControlRequest {
            steering: Some(0.1),
            throttle: 0.05,
            brake: 0.0,
        };
        assert!(
            generator
                .generate(&supervisor, request, Instant::now())
                .is_err()
        );
        assert_eq!(encode(&WireMessage::Disarm)[6], 0);
    }
}
