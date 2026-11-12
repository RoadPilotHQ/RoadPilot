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

#[derive(Debug)]
pub struct Watchdog {
    heartbeat: Heartbeat,
    timeout: Duration,
    flag: TripFlag,
    /// The current silence has already been reported.
    reported: bool,
}

impl Watchdog {
    pub fn new(heartbeat: Heartbeat, timeout: Duration) -> Self {
        Self {
            heartbeat,
            timeout,
            flag: TripFlag::default(),
            reported: false,
        }
    }

    pub fn flag(&self) -> TripFlag {
        self.flag.clone()
    }

    /// Call periodically. Trips the flag while the loop is silent; returns the silence once
    /// per episode so the caller can log it exactly once.
    pub fn check(&mut self, now: Instant) -> Option<Duration> {
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
}
