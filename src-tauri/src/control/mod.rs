//! Foundation for autonomous driving control (Phase 4.4).
//!
//! This module never sends input to the game. At this stage it contains only the read side:
//!
//! * [`vehicle`]: the validated vehicle state a controller may use.
//! * [`freshness`]: freshness and continuity checks that decide whether that state may be
//!   acted on, and an epoch counter that makes a reconnect, a pause or a restart impossible
//!   to overlook.
//!
//! Control must consume the raw frames of the telemetry client at full rate, not the 10 Hz
//! dashboard engine, which drops the session, sequence and simulation time.

pub mod freshness;
pub mod vehicle;
