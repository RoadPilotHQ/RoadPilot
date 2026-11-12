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
//! * [`command`]: bounded, validated control commands that cannot be constructed outside their
//!   limits, the steering rate limiter, and a generator that produces commands only while the
//!   supervisor permits output.
//! * [`protocol`]: encoder for the RoadPilot Input pipe protocol v2, byte-compatible with
//!   RoadPilot-SDK. It accepts only validated commands and the explicit disarm message.
//!
//! Control must consume the raw frames of the telemetry client at full rate, not the 10 Hz
//! dashboard engine, which drops the session, sequence and simulation time.

pub mod command;
pub mod freshness;
pub mod protocol;
pub mod supervisor;
pub mod vehicle;
