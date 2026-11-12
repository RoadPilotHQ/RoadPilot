//! Bounded control commands.
//!
//! A [`ControlCommand`] can only be created through [`ControlCommand::new`] (or
//! [`ControlCommand::neutral`]), which checks every value against [`ControlLimits`]. Its fields
//! are private, so a command that is non-finite, outside its limits or has throttle and brake
//! applied together cannot exist, and the protocol encoder accepts nothing else.
//!
//! [`CommandGenerator`] turns a controller's raw [`ControlRequest`] into a command. It
//! produces output only while the [`Supervisor`] permits it, bounds every value, lets the brake
//! override the throttle and applies the application-side steering rate limit.
//!
//! This module sends nothing. It has no pipe, clock or UI dependency; the caller supplies the
//! time.
//!
//! # Conventions
//!
//! * Steering is -1..1 in the SDK's convention, positive = left (counterclockwise). The sign
//!   as bound in the game is not verified.
//! * Throttle and brake are 0..1.
//! * The defaults are deliberately conservative; raising a limit is a conscious act.

use super::supervisor::{State, Supervisor};
use std::time::{Duration, Instant};

pub const DEFAULT_MAX_STEERING: f32 = 0.15;
pub const DEFAULT_MAX_THROTTLE: f32 = 0.10;
pub const DEFAULT_MAX_BRAKE: f32 = 1.0;
/// Application-side steering rate limit (magnitude increase per second): full default lock in
/// 0.3 s. Stricter than the plugin's own limit.
pub const DEFAULT_MAX_STEERING_RATE_PER_S: f32 = 0.5;
/// The input plugin's own steering rate limit. The application limit may not exceed it.
pub const SDK_STEERING_RATE_PER_S: f32 = 2.0;
/// After a longer pause between steering steps the ramp restarts from zero. Equal to the
/// plugin's own restart gap.
pub const MAX_STEERING_STEP: Duration = Duration::from_millis(100);

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Field {
    Steering,
    Throttle,
    Brake,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum CommandError {
    /// NaN or infinity.
    NonFinite(Field),
    /// Outside the configured limits (including negative throttle or brake).
    OutOfLimits { field: Field, value: f32 },
}

/// A limit was not a finite number inside its allowed range.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct InvalidLimits(pub &'static str);

/// Configured bounds for every control output. All values are checked on construction.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct ControlLimits {
    max_steering: f32,
    max_throttle: f32,
    max_brake: f32,
    max_steering_rate_per_s: f32,
}

impl ControlLimits {
    /// * `max_steering`: `(0, 1]`, symmetric.
    /// * `max_throttle`, `max_brake`: `[0, 1]`; 0 disables that output.
    /// * `max_steering_rate_per_s`: `(0, SDK_STEERING_RATE_PER_S]`.
    pub fn new(
        max_steering: f32,
        max_throttle: f32,
        max_brake: f32,
        max_steering_rate_per_s: f32,
    ) -> Result<Self, InvalidLimits> {
        let ok = |v: f32, lo_exclusive: bool, hi: f32| {
            v.is_finite() && v <= hi && if lo_exclusive { v > 0.0 } else { v >= 0.0 }
        };
        if !ok(max_steering, true, 1.0) {
            return Err(InvalidLimits("max_steering"));
        }
        if !ok(max_throttle, false, 1.0) {
            return Err(InvalidLimits("max_throttle"));
        }
        if !ok(max_brake, false, 1.0) {
            return Err(InvalidLimits("max_brake"));
        }
        if !ok(max_steering_rate_per_s, true, SDK_STEERING_RATE_PER_S) {
            return Err(InvalidLimits("max_steering_rate_per_s"));
        }
        Ok(Self {
            max_steering,
            max_throttle,
            max_brake,
            max_steering_rate_per_s,
        })
    }

    pub fn max_steering(&self) -> f32 {
        self.max_steering
    }
    pub fn max_throttle(&self) -> f32 {
        self.max_throttle
    }
    pub fn max_brake(&self) -> f32 {
        self.max_brake
    }
    pub fn max_steering_rate_per_s(&self) -> f32 {
        self.max_steering_rate_per_s
    }
}

impl Default for ControlLimits {
    fn default() -> Self {
        Self {
            max_steering: DEFAULT_MAX_STEERING,
            max_throttle: DEFAULT_MAX_THROTTLE,
            max_brake: DEFAULT_MAX_BRAKE,
            max_steering_rate_per_s: DEFAULT_MAX_STEERING_RATE_PER_S,
        }
    }
}

/// Maps negative zero to zero so equal commands encode to equal bytes.
fn normalize_zero(v: f32) -> f32 {
    if v == 0.0 { 0.0 } else { v }
}

/// A validated, bounded control command for an armed controller.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct ControlCommand {
    steering: Option<f32>,
    throttle: f32,
    brake: f32,
}

impl ControlCommand {
    /// Validates the values against `limits`; nothing is clamped here.
    ///
    /// `steering: None` does not claim the steering axis at all (the plugin releases it);
    /// `Some(0.0)` actively commands the centre. Brake overrides throttle: with any brake
    /// above zero the throttle is zero, as in the plugin.
    pub fn new(
        limits: &ControlLimits,
        steering: Option<f32>,
        throttle: f32,
        brake: f32,
    ) -> Result<Self, CommandError> {
        if let Some(s) = steering {
            check(
                s,
                -limits.max_steering,
                limits.max_steering,
                Field::Steering,
            )?;
        }
        check(throttle, 0.0, limits.max_throttle, Field::Throttle)?;
        check(brake, 0.0, limits.max_brake, Field::Brake)?;
        let throttle = if brake > 0.0 { 0.0 } else { throttle };
        Ok(Self {
            steering: steering.map(normalize_zero),
            throttle: normalize_zero(throttle),
            brake: normalize_zero(brake),
        })
    }

    /// Armed with every axis at zero and the steering axis not claimed.
    pub fn neutral() -> Self {
        Self {
            steering: None,
            throttle: 0.0,
            brake: 0.0,
        }
    }

    /// `None` when steering is not requested.
    pub fn steering(&self) -> Option<f32> {
        self.steering
    }
    pub fn throttle(&self) -> f32 {
        self.throttle
    }
    pub fn brake(&self) -> f32 {
        self.brake
    }
}

fn check(value: f32, lo: f32, hi: f32, field: Field) -> Result<(), CommandError> {
    if !value.is_finite() {
        Err(CommandError::NonFinite(field))
    } else if value < lo || value > hi {
        Err(CommandError::OutOfLimits { field, value })
    } else {
        Ok(())
    }
}

/// Limits the steering value and its rate of change, mirroring the plugin's own rules so that
/// the plugin's limiter is a second line of defence and rarely has to act:
///
/// * the first output after a start or reset, and the first output after a gap longer than
///   [`MAX_STEERING_STEP`] (or a clock that went backwards), is 0;
/// * reducing the magnitude, including to 0, is immediate;
/// * a change of direction passes through 0 first and then ramps in the new direction;
/// * increasing the magnitude moves by at most `rate * elapsed time` towards the target.
#[derive(Clone, Copy, Debug)]
pub struct SteeringRateLimiter {
    rate_per_s: f32,
    last: Option<(f32, Instant)>,
}

impl SteeringRateLimiter {
    pub fn new(rate_per_s: f32) -> Self {
        Self {
            rate_per_s,
            last: None,
        }
    }

    /// Forget the current output; the next output is 0.
    pub fn reset(&mut self) {
        self.last = None;
    }

    pub fn step(&mut self, target: f32, now: Instant) -> f32 {
        // A non-finite target means something is wrong upstream: go to neutral.
        let target = if target.is_finite() { target } else { 0.0 };
        let out = match self.last {
            Some((current, last)) => match now.checked_duration_since(last) {
                Some(dt) if dt <= MAX_STEERING_STEP => {
                    let reversal =
                        current != 0.0 && target != 0.0 && (current > 0.0) != (target > 0.0);
                    if reversal {
                        0.0
                    } else if target.abs() <= current.abs() {
                        target
                    } else {
                        let step = self.rate_per_s * dt.as_secs_f32();
                        let remaining = target.abs() - current.abs();
                        current + target.signum() * step.min(remaining)
                    }
                }
                // Gap too long or clock went backwards.
                _ => 0.0,
            },
            None => 0.0,
        };
        let out = normalize_zero(out);
        self.last = Some((out, now));
        out
    }
}

/// What a controller asks for, before any limit is applied. Values are raw and untrusted.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct ControlRequest {
    /// `None` = do not claim the steering axis.
    pub steering: Option<f32>,
    pub throttle: f32,
    pub brake: f32,
}

/// What the generator changed on the way from request to command, for logging.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct Adjustments {
    /// A value was outside its limit and was reduced to it.
    pub limited: bool,
    /// The throttle was set to zero because the brake was applied.
    pub brake_overrode_throttle: bool,
    /// The steering rate limiter held the value back from the limited request.
    pub steering_rate_limited: bool,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Generated {
    pub command: ControlCommand,
    pub adjustments: Adjustments,
}

/// Why no command was produced. In both cases the caller must send neutral or disarm, never
/// repeat an earlier command.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Withheld {
    /// The supervisor does not permit output (anything but Active).
    OutputNotPermitted(State),
    /// The request contained NaN or infinity.
    InvalidRequest(CommandError),
}

#[derive(Debug)]
pub struct CommandGenerator {
    limits: ControlLimits,
    limiter: SteeringRateLimiter,
}

impl CommandGenerator {
    pub fn new(limits: ControlLimits) -> Self {
        Self {
            limits,
            limiter: SteeringRateLimiter::new(limits.max_steering_rate_per_s),
        }
    }

    pub fn limits(&self) -> ControlLimits {
        self.limits
    }

    /// Produces the next command, but only while `supervisor` permits output. Whenever it
    /// does not, or the request is unusable, the steering ramp is forgotten so that the next
    /// permitted output starts from zero.
    pub fn generate(
        &mut self,
        supervisor: &Supervisor,
        request: ControlRequest,
        now: Instant,
    ) -> Result<Generated, Withheld> {
        if !supervisor.permits_output() {
            self.limiter.reset();
            return Err(Withheld::OutputNotPermitted(supervisor.state()));
        }
        for (value, field) in [
            (request.steering.unwrap_or(0.0), Field::Steering),
            (request.throttle, Field::Throttle),
            (request.brake, Field::Brake),
        ] {
            if !value.is_finite() {
                self.limiter.reset();
                return Err(Withheld::InvalidRequest(CommandError::NonFinite(field)));
            }
        }

        let l = &self.limits;
        let mut adjustments = Adjustments::default();
        let mut bound = |v: f32, lo: f32, hi: f32| {
            let b = v.clamp(lo, hi);
            adjustments.limited |= b != v;
            b
        };
        let throttle = bound(request.throttle, 0.0, l.max_throttle);
        let brake = bound(request.brake, 0.0, l.max_brake);
        let steering_target = request
            .steering
            .map(|s| bound(s, -l.max_steering, l.max_steering));

        let throttle = if brake > 0.0 && throttle > 0.0 {
            adjustments.brake_overrode_throttle = true;
            0.0
        } else {
            throttle
        };

        let steering = match steering_target {
            Some(target) => {
                let out = self.limiter.step(target, now);
                adjustments.steering_rate_limited = out != target;
                Some(out)
            }
            None => {
                self.limiter.reset();
                None
            }
        };

        // Every value is now inside the limits, so construction cannot fail; if it ever
        // does, withhold rather than send anything.
        let command = ControlCommand::new(l, steering, throttle, brake).map_err(|e| {
            self.limiter.reset();
            Withheld::InvalidRequest(e)
        })?;
        Ok(Generated {
            command,
            adjustments,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::super::freshness::Assessment;
    use super::super::supervisor::Command;
    use super::super::vehicle::test_support::slow_usable_assessment;
    use super::*;

    fn ms(n: u64) -> Duration {
        Duration::from_millis(n)
    }

    fn limits() -> ControlLimits {
        ControlLimits::default()
    }

    fn usable() -> Assessment {
        slow_usable_assessment()
    }

    fn supervisor_in(state: State) -> Supervisor {
        let mut s = Supervisor::default();
        let a = usable();
        match state {
            State::Disabled => {}
            State::Armed => {
                s.command(Command::Arm, &a);
            }
            State::Active => {
                s.command(Command::Arm, &a);
                s.command(Command::Activate, &a);
            }
            State::Fault => {
                s.command(Command::Arm, &a);
                s.command(Command::Activate, &a);
                s.update(&Assessment::Unusable(
                    super::super::freshness::Unusable::Paused,
                ));
            }
        }
        assert_eq!(s.state(), state);
        s
    }

    fn req(steering: Option<f32>, throttle: f32, brake: f32) -> ControlRequest {
        ControlRequest {
            steering,
            throttle,
            brake,
        }
    }

    // ---- limits ----

    #[test]
    fn the_defaults_are_conservative() {
        let l = ControlLimits::default();
        assert_eq!(l.max_steering(), 0.15);
        assert_eq!(l.max_throttle(), 0.10);
        assert_eq!(l.max_brake(), 1.0);
        assert_eq!(l.max_steering_rate_per_s(), 0.5);
        assert!(l.max_steering_rate_per_s() <= SDK_STEERING_RATE_PER_S);
    }

    #[test]
    fn limits_are_validated() {
        assert!(ControlLimits::new(1.0, 1.0, 1.0, 2.0).is_ok());
        assert!(ControlLimits::new(0.01, 0.0, 0.0, 0.01).is_ok());
        let bad = |s, t, b, r| ControlLimits::new(s, t, b, r).unwrap_err().0;
        assert_eq!(bad(0.0, 0.1, 1.0, 0.5), "max_steering");
        assert_eq!(bad(-0.1, 0.1, 1.0, 0.5), "max_steering");
        assert_eq!(bad(1.01, 0.1, 1.0, 0.5), "max_steering");
        assert_eq!(bad(f32::NAN, 0.1, 1.0, 0.5), "max_steering");
        assert_eq!(bad(0.15, -0.01, 1.0, 0.5), "max_throttle");
        assert_eq!(bad(0.15, 1.01, 1.0, 0.5), "max_throttle");
        assert_eq!(bad(0.15, f32::INFINITY, 1.0, 0.5), "max_throttle");
        assert_eq!(bad(0.15, 0.1, -1.0, 0.5), "max_brake");
        assert_eq!(bad(0.15, 0.1, 1.5, 0.5), "max_brake");
        assert_eq!(bad(0.15, 0.1, f32::NAN, 0.5), "max_brake");
        assert_eq!(bad(0.15, 0.1, 1.0, 0.0), "max_steering_rate_per_s");
        assert_eq!(bad(0.15, 0.1, 1.0, 2.01), "max_steering_rate_per_s");
        assert_eq!(
            bad(0.15, 0.1, 1.0, f32::INFINITY),
            "max_steering_rate_per_s"
        );
    }

    // ---- command construction ----

    #[test]
    fn minimum_and_maximum_values_are_accepted() {
        let l = limits();
        for (s, t, b) in [
            (Some(0.15), 0.10, 0.0),
            (Some(-0.15), 0.10, 0.0),
            (Some(0.0), 0.0, 0.0),
            (None, 0.0, 1.0),
            (Some(-0.15), 0.0, 1.0),
            (None, 0.10, 0.0),
        ] {
            let c = ControlCommand::new(&l, s, t, b).unwrap();
            assert_eq!(c.steering(), s);
            assert_eq!(c.throttle(), t);
            assert_eq!(c.brake(), b);
        }
    }

    #[test]
    fn values_outside_the_limits_cannot_be_constructed() {
        let l = limits();
        let steering = |v| ControlCommand::new(&l, Some(v), 0.0, 0.0);
        let throttle = |v| ControlCommand::new(&l, None, v, 0.0);
        let brake = |v| ControlCommand::new(&l, None, 0.0, v);
        for v in [0.150_001, -0.150_001, 0.5, -1.0, f32::MAX, f32::MIN] {
            assert_eq!(
                steering(v),
                Err(CommandError::OutOfLimits {
                    field: Field::Steering,
                    value: v
                })
            );
        }
        for v in [0.100_001, 0.5, 1.0, -0.000_001, -1.0, f32::MAX] {
            assert_eq!(
                throttle(v),
                Err(CommandError::OutOfLimits {
                    field: Field::Throttle,
                    value: v
                })
            );
        }
        for v in [1.000_001, 2.0, -0.000_001, -1.0, f32::MAX] {
            assert_eq!(
                brake(v),
                Err(CommandError::OutOfLimits {
                    field: Field::Brake,
                    value: v
                })
            );
        }
    }

    #[test]
    fn limits_are_configurable_and_enforced_strictly() {
        let l = ControlLimits::new(0.3, 0.5, 0.6, 1.0).unwrap();
        assert!(ControlCommand::new(&l, Some(0.3), 0.5, 0.0).is_ok());
        assert!(ControlCommand::new(&l, Some(0.31), 0.0, 0.0).is_err());
        assert!(ControlCommand::new(&l, None, 0.51, 0.0).is_err());
        assert!(ControlCommand::new(&l, None, 0.0, 0.61).is_err());
        // A zero limit disables the output entirely.
        let none = ControlLimits::new(0.15, 0.0, 0.0, 0.5).unwrap();
        assert!(ControlCommand::new(&none, None, 0.0, 0.0).is_ok());
        assert!(ControlCommand::new(&none, None, 0.001, 0.0).is_err());
        assert!(ControlCommand::new(&none, None, 0.0, 0.001).is_err());
    }

    #[test]
    fn nan_and_infinity_cannot_be_constructed() {
        let l = limits();
        for bad in [f32::NAN, f32::INFINITY, f32::NEG_INFINITY] {
            assert_eq!(
                ControlCommand::new(&l, Some(bad), 0.0, 0.0),
                Err(CommandError::NonFinite(Field::Steering))
            );
            assert_eq!(
                ControlCommand::new(&l, None, bad, 0.0),
                Err(CommandError::NonFinite(Field::Throttle))
            );
            assert_eq!(
                ControlCommand::new(&l, None, 0.0, bad),
                Err(CommandError::NonFinite(Field::Brake))
            );
        }
    }

    #[test]
    fn brake_overrides_throttle() {
        let l = limits();
        let c = ControlCommand::new(&l, None, 0.05, 0.5).unwrap();
        assert_eq!(c.throttle(), 0.0);
        assert_eq!(c.brake(), 0.5);
        let c = ControlCommand::new(&l, None, 0.10, 0.000_001).unwrap();
        assert_eq!(c.throttle(), 0.0, "any brake wins");
        let c = ControlCommand::new(&l, None, 0.10, 0.0).unwrap();
        assert_eq!(c.throttle(), 0.10, "no brake, no override");
    }

    #[test]
    fn negative_zero_is_normalized() {
        let l = limits();
        let c = ControlCommand::new(&l, Some(-0.0), -0.0, -0.0).unwrap();
        assert!(c.steering().unwrap().is_sign_positive());
        assert!(c.throttle().is_sign_positive());
        assert!(c.brake().is_sign_positive());
    }

    #[test]
    fn the_neutral_command_is_armed_with_everything_at_zero() {
        let c = ControlCommand::neutral();
        assert_eq!(c.steering(), None, "steering axis not claimed");
        assert_eq!(c.throttle(), 0.0);
        assert_eq!(c.brake(), 0.0);
        assert_eq!(c, ControlCommand::new(&limits(), None, 0.0, 0.0).unwrap());
    }

    // ---- steering rate limiter ----

    #[test]
    fn the_first_output_after_a_start_is_zero_then_it_ramps() {
        let t0 = Instant::now();
        let mut l = SteeringRateLimiter::new(0.5);
        assert_eq!(l.step(0.15, t0), 0.0);
        // 50 ms at 0.5/s = 0.025.
        assert!((l.step(0.15, t0 + ms(50)) - 0.025).abs() < 1e-6);
        assert!((l.step(0.15, t0 + ms(100)) - 0.05).abs() < 1e-6);
    }

    #[test]
    fn the_ramp_reaches_the_target_without_overshoot() {
        let t0 = Instant::now();
        let mut l = SteeringRateLimiter::new(0.5);
        let mut at = 0;
        let mut out = 0.0;
        for _ in 0..40 {
            out = l.step(0.15, t0 + ms(at));
            assert!(out <= 0.15 + 1e-6);
            at += 50;
        }
        assert_eq!(out, 0.15);
    }

    #[test]
    fn reducing_the_magnitude_is_immediate() {
        let t0 = Instant::now();
        let mut l = SteeringRateLimiter::new(2.0);
        let mut at = 0;
        let mut out = 0.0;
        while out < 0.15 {
            out = l.step(0.15, t0 + ms(at));
            at += 50;
        }
        assert_eq!(l.step(0.05, t0 + ms(at)), 0.05);
        assert_eq!(l.step(0.0, t0 + ms(at + 50)), 0.0);
    }

    #[test]
    fn a_direction_change_passes_through_zero() {
        let t0 = Instant::now();
        let mut l = SteeringRateLimiter::new(0.5);
        let mut at = 0;
        let mut out = 0.0;
        while out < 0.15 {
            out = l.step(0.15, t0 + ms(at));
            at += 50;
        }
        // Target flips sign: output goes to exactly 0 first, then ramps in the new direction.
        let a = l.step(-0.15, t0 + ms(at));
        assert_eq!(a, 0.0);
        let b = l.step(-0.15, t0 + ms(at + 50));
        assert!((b - -0.025).abs() < 1e-6, "{b}");
        let c = l.step(-0.15, t0 + ms(at + 100));
        assert!(c < b);
    }

    #[test]
    fn a_long_gap_or_a_backwards_clock_restarts_from_zero() {
        let t0 = Instant::now() + ms(1_000);
        let mut l = SteeringRateLimiter::new(2.0);
        l.step(0.15, t0);
        l.step(0.15, t0 + ms(50));
        let before = l.step(0.15, t0 + ms(100));
        assert!(before > 0.0);
        assert_eq!(l.step(0.15, t0 + ms(100) + ms(101)), 0.0, "gap over 100 ms");
        assert!(l.step(0.15, t0 + ms(250)) > 0.0, "ramps again afterwards");
        let at = t0 + ms(250);
        assert_eq!(l.step(0.15, at - ms(10)), 0.0, "clock went backwards");
    }

    #[test]
    fn a_gap_of_exactly_100_ms_still_ramps() {
        let t0 = Instant::now();
        let mut l = SteeringRateLimiter::new(0.5);
        l.step(0.15, t0);
        assert!((l.step(0.15, t0 + ms(100)) - 0.05).abs() < 1e-6);
    }

    #[test]
    fn reset_and_non_finite_targets_return_to_zero() {
        let t0 = Instant::now();
        let mut l = SteeringRateLimiter::new(2.0);
        l.step(0.1, t0);
        l.step(0.1, t0 + ms(50));
        l.reset();
        assert_eq!(l.step(0.1, t0 + ms(100)), 0.0);
        l.step(0.1, t0 + ms(150));
        assert_eq!(l.step(f32::NAN, t0 + ms(200)), 0.0);
        l.step(0.1, t0 + ms(250));
        assert_eq!(l.step(f32::INFINITY, t0 + ms(300)), 0.0);
    }

    #[test]
    fn the_rate_is_never_exceeded_and_the_sign_never_flips_without_zero() {
        // A deterministic, jagged target sequence at varied intervals.
        let t0 = Instant::now();
        let rate = 0.5;
        let mut l = SteeringRateLimiter::new(rate);
        let mut at = 0u64;
        let mut prev = 0.0f32;
        let mut x = 12345u32;
        for i in 0..2000 {
            x = x.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
            let target = ((x >> 8) % 301) as f32 / 1000.0 - 0.15;
            let step_ms = 10 + u64::from((x >> 3) % 70);
            at += step_ms;
            let out = l.step(target, t0 + ms(at));
            assert!(out.abs() <= 0.15 + 1e-6, "{i}: {out}");
            if prev != 0.0 && out != 0.0 {
                assert_eq!(prev > 0.0, out > 0.0, "{i}: flipped {prev} -> {out}");
            }
            if out.abs() > prev.abs() {
                let allowed = rate * (step_ms as f32 / 1000.0) + 1e-6;
                assert!(out.abs() - prev.abs() <= allowed, "{i}: {prev} -> {out}");
            }
            prev = out;
        }
    }

    // ---- generator and supervisor permission ----

    #[test]
    fn nothing_is_generated_unless_the_supervisor_is_active() {
        for state in [State::Disabled, State::Armed, State::Fault] {
            let mut g = CommandGenerator::new(limits());
            let r = g.generate(
                &supervisor_in(state),
                req(Some(0.1), 0.05, 0.0),
                Instant::now(),
            );
            assert_eq!(r, Err(Withheld::OutputNotPermitted(state)), "{state:?}");
        }
        let mut g = CommandGenerator::new(limits());
        assert!(
            g.generate(
                &supervisor_in(State::Active),
                req(None, 0.0, 0.0),
                Instant::now()
            )
            .is_ok()
        );
    }

    #[test]
    fn losing_permission_forgets_the_steering_ramp() {
        let t0 = Instant::now();
        let active = supervisor_in(State::Active);
        let mut g = CommandGenerator::new(limits());
        let steer = |g: &mut CommandGenerator, s: &Supervisor, at| {
            g.generate(s, req(Some(0.15), 0.0, 0.0), t0 + ms(at))
        };
        assert_eq!(
            steer(&mut g, &active, 0).unwrap().command.steering(),
            Some(0.0)
        );
        let ramped = steer(&mut g, &active, 50)
            .unwrap()
            .command
            .steering()
            .unwrap();
        assert!(ramped > 0.0);
        // Permission is lost for one tick (for example a disarm).
        assert!(steer(&mut g, &supervisor_in(State::Disabled), 100).is_err());
        // When output is permitted again the ramp starts from zero, not from `ramped`.
        assert_eq!(
            steer(&mut g, &active, 150).unwrap().command.steering(),
            Some(0.0)
        );
    }

    #[test]
    fn requests_outside_the_limits_are_reduced_and_reported() {
        let mut g = CommandGenerator::new(limits());
        let s = supervisor_in(State::Active);
        let t0 = Instant::now();
        g.generate(&s, req(Some(5.0), 0.0, 0.0), t0).unwrap();
        // Run the ramp up to the limit; the output never exceeds 0.15.
        let mut out = None;
        for i in 1..=20 {
            out = Some(
                g.generate(&s, req(Some(5.0), 0.9, 0.0), t0 + ms(i * 50))
                    .unwrap(),
            );
        }
        let out = out.unwrap();
        assert_eq!(out.command.steering(), Some(0.15));
        assert_eq!(out.command.throttle(), 0.10);
        assert!(out.adjustments.limited);

        let neg = g
            .generate(&s, req(Some(-9.0), -3.0, 7.0), t0 + ms(1_050))
            .unwrap();
        assert!(neg.command.steering().unwrap() >= -0.15);
        assert_eq!(neg.command.throttle(), 0.0);
        assert_eq!(neg.command.brake(), 1.0);
        assert!(neg.adjustments.limited);
    }

    #[test]
    fn a_request_inside_the_limits_is_not_reported_as_limited() {
        let mut g = CommandGenerator::new(limits());
        let s = supervisor_in(State::Active);
        let r = g
            .generate(&s, req(None, 0.05, 0.0), Instant::now())
            .unwrap();
        assert_eq!(r.adjustments, Adjustments::default());
        assert_eq!(r.command.throttle(), 0.05);
    }

    #[test]
    fn the_generator_applies_the_brake_override_and_reports_it() {
        let mut g = CommandGenerator::new(limits());
        let s = supervisor_in(State::Active);
        let r = g
            .generate(&s, req(None, 0.08, 0.4), Instant::now())
            .unwrap();
        assert_eq!(r.command.throttle(), 0.0);
        assert_eq!(r.command.brake(), 0.4);
        assert!(r.adjustments.brake_overrode_throttle);
        let r = g.generate(&s, req(None, 0.0, 0.4), Instant::now()).unwrap();
        assert!(!r.adjustments.brake_overrode_throttle);
    }

    #[test]
    fn steering_is_rate_limited_and_reported() {
        let mut g = CommandGenerator::new(limits());
        let s = supervisor_in(State::Active);
        let t0 = Instant::now();
        let first = g.generate(&s, req(Some(0.15), 0.0, 0.0), t0).unwrap();
        assert_eq!(first.command.steering(), Some(0.0));
        assert!(first.adjustments.steering_rate_limited);
        let second = g
            .generate(&s, req(Some(0.15), 0.0, 0.0), t0 + ms(50))
            .unwrap();
        assert!((second.command.steering().unwrap() - 0.025).abs() < 1e-6);
        assert!(second.adjustments.steering_rate_limited);
    }

    #[test]
    fn steering_direction_changes_pass_through_zero_in_the_generator() {
        let mut g = CommandGenerator::new(limits());
        let s = supervisor_in(State::Active);
        let t0 = Instant::now();
        let mut at = 0;
        let mut last = 0.0;
        while last < 0.15 {
            last = g
                .generate(&s, req(Some(0.15), 0.0, 0.0), t0 + ms(at))
                .unwrap()
                .command
                .steering()
                .unwrap();
            at += 50;
        }
        let flip = g
            .generate(&s, req(Some(-0.15), 0.0, 0.0), t0 + ms(at))
            .unwrap();
        assert_eq!(flip.command.steering(), Some(0.0));
    }

    #[test]
    fn not_requesting_steering_releases_the_axis_and_resets_the_ramp() {
        let mut g = CommandGenerator::new(limits());
        let s = supervisor_in(State::Active);
        let t0 = Instant::now();
        g.generate(&s, req(Some(0.15), 0.0, 0.0), t0).unwrap();
        g.generate(&s, req(Some(0.15), 0.0, 0.0), t0 + ms(50))
            .unwrap();
        let r = g.generate(&s, req(None, 0.0, 0.0), t0 + ms(100)).unwrap();
        assert_eq!(r.command.steering(), None);
        let again = g
            .generate(&s, req(Some(0.15), 0.0, 0.0), t0 + ms(150))
            .unwrap();
        assert_eq!(again.command.steering(), Some(0.0));
    }

    #[test]
    fn a_non_finite_request_is_withheld_and_resets_the_ramp() {
        let s = supervisor_in(State::Active);
        let t0 = Instant::now();
        for (request, field) in [
            (req(Some(f32::NAN), 0.0, 0.0), Field::Steering),
            (req(Some(f32::INFINITY), 0.0, 0.0), Field::Steering),
            (req(None, f32::NAN, 0.0), Field::Throttle),
            (req(None, f32::NEG_INFINITY, 0.0), Field::Throttle),
            (req(None, 0.0, f32::NAN), Field::Brake),
            (req(None, 0.0, f32::INFINITY), Field::Brake),
        ] {
            let mut g = CommandGenerator::new(limits());
            g.generate(&s, req(Some(0.15), 0.0, 0.0), t0).unwrap();
            g.generate(&s, req(Some(0.15), 0.0, 0.0), t0 + ms(50))
                .unwrap();
            assert_eq!(
                g.generate(&s, request, t0 + ms(100)),
                Err(Withheld::InvalidRequest(CommandError::NonFinite(field)))
            );
            let next = g
                .generate(&s, req(Some(0.15), 0.0, 0.0), t0 + ms(150))
                .unwrap();
            assert_eq!(next.command.steering(), Some(0.0), "ramp restarted");
        }
    }

    #[test]
    fn generated_commands_are_always_inside_the_limits() {
        let l = limits();
        let mut g = CommandGenerator::new(l);
        let s = supervisor_in(State::Active);
        let t0 = Instant::now();
        let values = [
            -1e30, -10.0, -1.0, -0.15, -0.1, -0.0, 0.0, 0.05, 0.1, 0.15, 0.5, 1.0, 10.0, 1e30,
        ];
        let mut at = 0;
        for &st in &values {
            for &th in &values {
                for &br in &values {
                    at += 30;
                    let out = g
                        .generate(&s, req(Some(st), th, br), t0 + ms(at))
                        .unwrap()
                        .command;
                    assert!(out.steering().unwrap().abs() <= l.max_steering());
                    assert!((0.0..=l.max_throttle()).contains(&out.throttle()));
                    assert!((0.0..=l.max_brake()).contains(&out.brake()));
                    assert!(out.throttle() == 0.0 || out.brake() == 0.0);
                    assert!(out.steering().unwrap().is_finite());
                }
            }
        }
    }

    #[test]
    fn safety_events_stop_generation_immediately() {
        let mut g = CommandGenerator::new(limits());
        let mut s = supervisor_in(State::Active);
        let t0 = Instant::now();
        assert!(g.generate(&s, req(None, 0.05, 0.0), t0).is_ok());
        s.update(&Assessment::Unusable(
            super::super::freshness::Unusable::Stale { age: ms(400) },
        ));
        assert_eq!(
            g.generate(&s, req(None, 0.05, 0.0), t0 + ms(30)),
            Err(Withheld::OutputNotPermitted(State::Fault))
        );
    }
}
