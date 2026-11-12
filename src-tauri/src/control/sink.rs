//! Where encoded messages go. In this phase the only destination is the dry-run sink, which
//! discards every message.
//!
//! Dry-run is enforced by construction rather than by a switch:
//!
//! * [`MessageSink`] is **sealed**: it cannot be implemented outside this module, so no other
//!   crate module can introduce a real transport by accident.
//! * [`OperatingMode`] has exactly one variant, [`OperatingMode::DryRun`]. There is no
//!   preference, option or environment value that selects anything else.
//! * [`Delivery`] can only say that a message was **not transmitted**. Nothing in the control
//!   code can claim a message was delivered, because no code path exists that could deliver
//!   one. A future phase that adds live transmission must add the missing variant, which
//!   makes every `match` on it a compile error until it is reviewed.
//! * [`DryRunSink`] opens nothing and holds no handle. The module-level test in
//!   `control/mod.rs` scans every control source file for the input plugin's pipe name and
//!   for any file, pipe or network API.
//!
//! Live transmission requires a separate, explicit authorization in a future development
//! phase; it is deliberately not selectable here.

use super::protocol::MESSAGE_LEN;

/// How the control side runs. Dry-run is the only mode.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub enum OperatingMode {
    /// Messages are encoded, logged and discarded. Nothing is sent to the game.
    #[default]
    DryRun,
}

/// What happened to a message handed to a sink.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Delivery {
    /// The message was encoded but not transmitted anywhere.
    NotTransmitted,
}

mod sealed {
    pub trait Sealed {}
}

/// A destination for encoded messages. Sealed: see the module documentation.
pub trait MessageSink: sealed::Sealed + Send {
    fn mode(&self) -> OperatingMode;
    fn deliver(&mut self, message: &[u8; MESSAGE_LEN]) -> Delivery;
}

/// Discards every message and reports truthfully that nothing was transmitted.
#[derive(Debug, Default)]
pub struct DryRunSink;

impl sealed::Sealed for DryRunSink {}

impl MessageSink for DryRunSink {
    fn mode(&self) -> OperatingMode {
        OperatingMode::DryRun
    }

    fn deliver(&mut self, _message: &[u8; MESSAGE_LEN]) -> Delivery {
        Delivery::NotTransmitted
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dry_run_is_the_only_and_the_default_mode() {
        assert_eq!(OperatingMode::default(), OperatingMode::DryRun);
        assert_eq!(DryRunSink.mode(), OperatingMode::DryRun);
        // Exhaustive without a wildcard: adding a mode breaks this test until reviewed.
        match OperatingMode::default() {
            OperatingMode::DryRun => {}
        }
    }

    #[test]
    fn the_dry_run_sink_never_reports_a_transmission() {
        let mut sink = DryRunSink;
        for byte in [0u8, 1, 255] {
            let delivery = sink.deliver(&[byte; MESSAGE_LEN]);
            assert_eq!(delivery, Delivery::NotTransmitted);
            // Exhaustive without a wildcard: a future `Delivered` variant must be handled.
            match delivery {
                Delivery::NotTransmitted => {}
            }
        }
    }
}
