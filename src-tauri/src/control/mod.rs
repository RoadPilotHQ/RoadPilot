//! Foundation for autonomous driving control (Phase 4.4).
//!
//! This module never sends input to the game. At this stage it contains only the read side:
//!
//! * [`vehicle`]: the validated vehicle state a controller may use.
//! * [`freshness`]: freshness and continuity checks that decide whether that state may be
//!   acted on, and an epoch counter that makes a reconnect, a pause or a restart impossible
//!   to overlook.
//!
//! * [`supervisor`]: the Disabled / Armed / Active / Fault state machine, the only authority
//!   that decides whether control output is permitted. It consumes the assessment of the
//!   freshness monitor and explicit commands, and knows nothing about transport, UI or input.
//!
//! Control must consume the raw frames of the telemetry client at full rate, not the 10 Hz
//! dashboard engine, which drops the session, sequence and simulation time.

pub mod freshness;
pub mod supervisor;
pub mod vehicle;
