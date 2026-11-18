//! Independent detection of a stalled supervisor loop.
//!
//! The sender loop updates the supervisor on every tick and records a [`Heartbeat`]. The
//! [`Watchdog`] runs in a **separate task** and measures the time since the last heartbeat. If
//! the loop stalls, blocks or dies, the watchdog notices without any help from the loop: it
//! trips a [`TripFlag`] that the loop consumes first thing on its next tick, which reports a
//! `SupervisorTimeout` safety event to the supervisor (Active ends in Fault, Armed is
//! disarmed). The watchdog has no access to the supervisor itself, so it cannot arm or
//! activate anything; the worst it can do is cause a disarm.
//!
//! The loop consumes the flag before it processes any queued command (see `runtime`), so a
//! stall it missed can never be followed by an arm or activation from the same tick.
//!
//! The watchdog has a liveness [`Heartbeat`] of its own, beaten by every check it actually
//! runs and by nothing else. The loop reads it: a watchdog silent for longer than
//! [`WATCHDOG_SILENCE_LIMIT`] is a `WatchdogSilent` safety event, handled fail-closed (Active
//! ends in Fault, Armed is disarmed, arming and activation are refused while it lasts). This
//! only makes a failed watchdog visible and keeps control off; it does not enforce a disarm
//! while the loop itself is stuck.
//!
//! All values are plain atomics over monotonic time. Time is passed in, so every rule is
//! unit-testable.

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::time::{Duration, Instant};

/// No supervisor update for longer than this trips the watchdog. Tolerates two missed 40 ms
/// ticks, not three.
pub const SUPERVISOR_TIMEOUT: Duration = Duration::from_millis(100);
/// How often the watchdog task checks.
pub const WATCHDOG_PERIOD: Duration = Duration::from_millis(20);
/// No watchdog check for longer than this means the watchdog has failed. Twelve missed checks:
/// the watchdog runs at normal priority on the shared runtime, where wake-ups late by tens of
/// milliseconds are expected under load (see `docs/timing.md`), and a false alarm faults
/// control.
pub const WATCHDOG_SILENCE_LIMIT: Duration = Duration::from_millis(250);

fn millis_since(origin: Instant, at: Instant) -> u64 {
    u64::try_from(at.saturating_duration_since(origin).as_millis()).unwrap_or(u64::MAX)
}

/// Written by the supervisor loop on every update.
#[derive(Clone, Debug)]
pub struct Heartbeat {
    origin: Instant,
    last_ms: Arc<AtomicU64>,
}

impl Heartbeat {
    /// The loop counts as having beaten at `origin`, so a loop that never starts is detected.
    pub fn new(origin: Instant) -> Self {
        Self {
            origin,
            last_ms: Arc::new(AtomicU64::new(0)),
        }
    }

    pub fn beat(&self, now: Instant) {
        self.last_ms
            .fetch_max(millis_since(self.origin, now), Ordering::SeqCst);
    }

    pub fn silent_for(&self, now: Instant) -> Duration {
        let last = self.last_ms.load(Ordering::SeqCst);
        Duration::from_millis(millis_since(self.origin, now).saturating_sub(last))
    }
}

/// Raised by the watchdog, consumed by the supervisor loop.
#[derive(Clone, Debug, Default)]
pub struct TripFlag {
    tripped: Arc<AtomicBool>,
    silent_ms: Arc<AtomicU64>,
}

impl TripFlag {
    /// Returns how long the loop was silent if the watchdog tripped since the last call, and
    /// clears the flag.
    pub fn take(&self) -> Option<Duration> {
        self.tripped
            .swap(false, Ordering::SeqCst)
            .then(|| Duration::from_millis(self.silent_ms.load(Ordering::SeqCst)))
    }

    pub fn is_tripped(&self) -> bool {
        self.tripped.load(Ordering::SeqCst)
    }

    fn trip(&self, silent_for: Duration) {
        let ms = u64::try_from(silent_for.as_millis()).unwrap_or(u64::MAX);
        self.silent_ms.store(ms, Ordering::SeqCst);
        self.tripped.store(true, Ordering::SeqCst);
    }
}

/// What the supervisor loop shares with its watchdog: the loop's heartbeat (written by the
/// loop), the trip flag (raised by the watchdog) and the watchdog's own liveness (written only
/// by the watchdog's checks). All atomics; cheap to clone.
#[derive(Clone, Debug)]
pub struct WatchdogLink {
    pub heartbeat: Heartbeat,
    pub trip: TripFlag,
    pub alive: Heartbeat,
}

#[derive(Debug)]
pub struct Watchdog {
    heartbeat: Heartbeat,
    timeout: Duration,
    flag: TripFlag,
    /// Beaten by every check, and by nothing else.
    alive: Heartbeat,
    /// The current silence has already been reported.
    reported: bool,
}

impl Watchdog {
    pub fn new(heartbeat: Heartbeat, timeout: Duration) -> Self {
        // The watchdog counts as having checked at the loop's origin, so a watchdog that never
        // runs is detected like one that stops.
        let alive = Heartbeat::new(heartbeat.origin);
        Self {
            heartbeat,
            timeout,
            flag: TripFlag::default(),
            alive,
            reported: false,
        }
    }

    pub fn flag(&self) -> TripFlag {
        self.flag.clone()
    }

    /// The watchdog's liveness heartbeat, for readers.
    pub fn liveness(&self) -> Heartbeat {
        self.alive.clone()
    }

    /// Everything the loop needs from this watchdog.
    pub fn link(&self) -> WatchdogLink {
        WatchdogLink {
            heartbeat: self.heartbeat.clone(),
            trip: self.flag(),
            alive: self.liveness(),
        }
    }

    /// Call periodically. Trips the flag while the loop is silent; returns the silence once
    /// per episode so the caller can log it exactly once. Every call records the watchdog's
    /// own liveness.
    pub fn check(&mut self, now: Instant) -> Option<Duration> {
        self.alive.beat(now);
        let silent_for = self.heartbeat.silent_for(now);
        if silent_for > self.timeout {
            self.flag.trip(silent_for);
            if !self.reported {
                self.reported = true;
                return Some(silent_for);
            }
        } else {
            self.reported = false;
        }
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ms(n: u64) -> Duration {
        Duration::from_millis(n)
    }

    fn rig() -> (Instant, Heartbeat, Watchdog, TripFlag) {
        let t0 = Instant::now();
        let hb = Heartbeat::new(t0);
        let wd = Watchdog::new(hb.clone(), SUPERVISOR_TIMEOUT);
        let flag = wd.flag();
        (t0, hb, wd, flag)
    }

    #[test]
    fn a_loop_that_keeps_beating_never_trips() {
        let (t0, hb, mut wd, flag) = rig();
        for n in 1..=500u64 {
            hb.beat(t0 + ms(n * 40));
            // The watchdog checks twice per period, as the real task does.
            assert_eq!(wd.check(t0 + ms(n * 40 + 20)), None);
            assert_eq!(wd.check(t0 + ms(n * 40 + 39)), None);
        }
        assert!(!flag.is_tripped());
        assert_eq!(flag.take(), None);
    }

    #[test]
    fn two_missed_ticks_are_tolerated_three_are_not() {
        let (t0, hb, mut wd, flag) = rig();
        hb.beat(t0 + ms(40));
        assert_eq!(wd.check(t0 + ms(40 + 100)), None, "exactly at the limit");
        assert!(!flag.is_tripped());
        assert_eq!(wd.check(t0 + ms(40 + 101)), Some(ms(101)));
        assert!(flag.is_tripped());
    }

    #[test]
    fn a_stalled_loop_is_detected_without_the_loop() {
        let (t0, hb, mut wd, flag) = rig();
        hb.beat(t0 + ms(40));
        // The loop never beats again; only the watchdog runs.
        let mut reports = Vec::new();
        for n in 1..=100u64 {
            if let Some(silent) = wd.check(t0 + ms(40 + n * 20)) {
                reports.push(silent);
            }
        }
        assert_eq!(reports.len(), 1, "reported once per episode: {reports:?}");
        assert!(flag.is_tripped());
        assert!(reports[0] > SUPERVISOR_TIMEOUT);
    }

    #[test]
    fn a_loop_that_never_started_is_detected() {
        let (t0, _hb, mut wd, flag) = rig();
        assert_eq!(wd.check(t0 + ms(100)), None);
        assert_eq!(wd.check(t0 + ms(120)), Some(ms(120)));
        assert!(flag.is_tripped());
    }

    #[test]
    fn the_flag_is_consumed_once_and_carries_the_silence() {
        let (t0, hb, mut wd, flag) = rig();
        hb.beat(t0 + ms(10));
        wd.check(t0 + ms(300));
        assert_eq!(flag.take(), Some(ms(290)));
        assert_eq!(flag.take(), None, "consumed");
        assert!(!flag.is_tripped());
    }

    #[test]
    fn it_keeps_tripping_while_the_silence_lasts() {
        // Even after the loop consumed the flag, a loop that is still silent trips it again.
        let (t0, hb, mut wd, flag) = rig();
        hb.beat(t0 + ms(10));
        wd.check(t0 + ms(200));
        assert!(flag.take().is_some());
        wd.check(t0 + ms(220));
        assert!(flag.is_tripped(), "still silent, trips again");
    }

    #[test]
    fn a_recovered_loop_reports_a_new_episode_later() {
        let (t0, hb, mut wd, _flag) = rig();
        hb.beat(t0 + ms(10));
        assert!(wd.check(t0 + ms(200)).is_some());
        hb.beat(t0 + ms(210));
        assert_eq!(wd.check(t0 + ms(220)), None, "recovered");
        assert!(
            wd.check(t0 + ms(400)).is_some(),
            "a new episode is reported again"
        );
    }

    #[test]
    fn a_later_episode_reports_its_own_silence_not_an_older_one() {
        let (t0, hb, mut wd, flag) = rig();
        hb.beat(t0 + ms(10));
        wd.check(t0 + ms(900)); // a long first episode
        assert_eq!(flag.take(), Some(ms(890)));
        hb.beat(t0 + ms(910));
        wd.check(t0 + ms(920));
        wd.check(t0 + ms(1_050)); // a shorter second episode
        assert_eq!(flag.take(), Some(ms(140)));
    }

    #[test]
    fn heartbeats_never_go_backwards() {
        let t0 = Instant::now();
        let hb = Heartbeat::new(t0);
        hb.beat(t0 + ms(500));
        hb.beat(t0 + ms(100)); // a late writer must not move the heartbeat back
        assert_eq!(hb.silent_for(t0 + ms(500)), Duration::ZERO);
    }

    #[test]
    fn the_timeout_is_shorter_than_the_plugin_steering_timeout() {
        assert!(SUPERVISOR_TIMEOUT < ms(150));
        assert!(WATCHDOG_PERIOD < SUPERVISOR_TIMEOUT);
    }

    #[test]
    fn every_check_and_only_a_check_records_the_watchdog_liveness() {
        let (t0, hb, mut wd, _flag) = rig();
        let alive = wd.liveness();
        assert_eq!(alive.silent_for(t0 + ms(300)), ms(300), "no check yet");
        // The loop beating its own heartbeat does not count as a watchdog check.
        hb.beat(t0 + ms(300));
        assert_eq!(alive.silent_for(t0 + ms(300)), ms(300));
        wd.check(t0 + ms(310));
        assert_eq!(alive.silent_for(t0 + ms(320)), ms(10));
        // A check that trips counts too: the watchdog did run.
        wd.check(t0 + ms(900));
        assert_eq!(alive.silent_for(t0 + ms(900)), Duration::ZERO);
    }

    #[test]
    fn the_link_shares_the_same_atomics() {
        let (t0, hb, mut wd, flag) = rig();
        let link = wd.link();
        hb.beat(t0 + ms(10));
        assert_eq!(link.heartbeat.silent_for(t0 + ms(10)), Duration::ZERO);
        wd.check(t0 + ms(300));
        assert!(link.trip.is_tripped());
        assert!(flag.is_tripped());
        assert_eq!(link.alive.silent_for(t0 + ms(300)), Duration::ZERO);
    }

    #[test]
    fn the_watchdog_silence_limit_tolerates_a_late_task_but_not_a_dead_one() {
        assert!(WATCHDOG_SILENCE_LIMIT >= 10 * WATCHDOG_PERIOD);
        assert!(WATCHDOG_SILENCE_LIMIT > SUPERVISOR_TIMEOUT);
        assert!(
            WATCHDOG_SILENCE_LIMIT <= ms(250),
            "the plugin's input timeout"
        );
    }
}
