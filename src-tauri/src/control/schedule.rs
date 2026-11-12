//! Monotonic tick schedule and timing monitoring for the sender.
//!
//! Pure logic on [`Instant`]s: the caller sleeps until [`Scheduler::next_deadline`], calls
//! [`Scheduler::on_tick`] with the actual time, and gets back how late the tick was.
//!
//! Deadlines lie on a fixed grid (`start + n * period`), so lateness never accumulates into
//! drift. When a tick is so late that one or more later deadlines have also passed, those
//! deadlines are **skipped**, never replayed: the scheduler never produces a burst of ticks to
//! catch up, so no stale or queued command can ever be sent.
//!
//! The input plugin releases steering after 150 ms without a message and restarts its steering
//! ramp after a 100 ms gap, and asks clients to refresh at least every 50 ms. A tick interval
//! above [`MAX_TICK_GAP`] is therefore a safety violation, not a statistic.

use std::time::{Duration, Instant};

/// Sender period. Within the plugin's required 50 ms refresh and well inside its 150 ms
/// steering timeout.
pub const TICK_PERIOD: Duration = Duration::from_millis(40);
/// A tick later than this is reported as late.
pub const LATE_AFTER: Duration = Duration::from_millis(10);
/// A gap between two ticks above this is a violation (the plugin's own ramp restart gap).
pub const MAX_TICK_GAP: Duration = Duration::from_millis(100);

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Verdict {
    OnTime,
    /// Later than [`LATE_AFTER`] but no deadline was skipped.
    Late,
    /// At least one whole deadline was skipped.
    DeadlinesMissed,
    /// The gap since the previous tick exceeded [`MAX_TICK_GAP`].
    GapViolation,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct Timing {
    /// 1 for the first tick.
    pub sequence: u64,
    /// The deadline this tick answered.
    pub scheduled: Instant,
    /// How far after the deadline the tick ran; zero if it ran early.
    pub lateness: Duration,
    /// Deadlines that passed entirely without a tick and were skipped.
    pub missed: u32,
    /// Time since the previous tick; `None` for the first.
    pub gap: Option<Duration>,
    pub verdict: Verdict,
}

#[derive(Clone, Copy, Debug)]
pub struct Scheduler {
    period: Duration,
    next_deadline: Instant,
    last_tick: Option<Instant>,
    sequence: u64,
}

impl Scheduler {
    /// The first deadline is one period after `start`.
    pub fn new(start: Instant) -> Self {
        Self::with_period(start, TICK_PERIOD)
    }

    fn with_period(start: Instant, period: Duration) -> Self {
        Self {
            period,
            next_deadline: start + period,
            last_tick: None,
            sequence: 0,
        }
    }

    pub fn period(&self) -> Duration {
        self.period
    }

    pub fn next_deadline(&self) -> Instant {
        self.next_deadline
    }

    /// Records a tick that ran at `now` and schedules the next deadline strictly after `now`
    /// (or one period after the answered deadline, if the tick ran early).
    pub fn on_tick(&mut self, now: Instant) -> Timing {
        self.sequence += 1;
        let scheduled = self.next_deadline;
        let lateness = now.saturating_duration_since(scheduled);
        let missed =
            u32::try_from(lateness.as_nanos() / self.period.as_nanos()).unwrap_or(u32::MAX);
        self.next_deadline = scheduled + self.period * missed.saturating_add(1);
        let gap = self
            .last_tick
            .map(|last| now.saturating_duration_since(last));
        self.last_tick = Some(now);

        let verdict = if gap.is_some_and(|g| g > MAX_TICK_GAP) {
            Verdict::GapViolation
        } else if missed > 0 {
            Verdict::DeadlinesMissed
        } else if lateness > LATE_AFTER {
            Verdict::Late
        } else {
            Verdict::OnTime
        };
        Timing {
            sequence: self.sequence,
            scheduled,
            lateness,
            missed,
            gap,
            verdict,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ms(n: u64) -> Duration {
        Duration::from_millis(n)
    }

    #[test]
    fn the_period_is_40_ms_and_the_first_deadline_is_one_period_out() {
        let t0 = Instant::now();
        let s = Scheduler::new(t0);
        assert_eq!(TICK_PERIOD, ms(40));
        assert_eq!(s.period(), ms(40));
        assert_eq!(s.next_deadline(), t0 + ms(40));
        assert!(
            TICK_PERIOD <= ms(50),
            "within the plugin's refresh requirement"
        );
        assert!(MAX_TICK_GAP < ms(150), "inside the steering timeout");
    }

    #[test]
    fn on_time_ticks_stay_on_the_grid() {
        let t0 = Instant::now();
        let mut s = Scheduler::new(t0);
        for n in 1..=100u64 {
            let t = s.on_tick(t0 + ms(40 * n));
            assert_eq!(t.sequence, n);
            assert_eq!(t.verdict, Verdict::OnTime);
            assert_eq!(t.lateness, Duration::ZERO);
            assert_eq!(t.missed, 0);
            assert_eq!(s.next_deadline(), t0 + ms(40 * (n + 1)));
        }
    }

    #[test]
    fn lateness_does_not_accumulate_into_drift() {
        // Every tick runs 8 ms late; deadlines stay on the 40 ms grid.
        let t0 = Instant::now();
        let mut s = Scheduler::new(t0);
        for n in 1..=50u64 {
            let t = s.on_tick(t0 + ms(40 * n + 8));
            assert_eq!(t.lateness, ms(8));
            assert_eq!(t.verdict, Verdict::OnTime, "8 ms is within tolerance");
            assert_eq!(s.next_deadline(), t0 + ms(40 * (n + 1)));
        }
    }

    #[test]
    fn a_late_tick_is_reported_late() {
        let t0 = Instant::now();
        let mut s = Scheduler::new(t0);
        s.on_tick(t0 + ms(40));
        let t = s.on_tick(t0 + ms(80 + 11));
        assert_eq!(t.verdict, Verdict::Late);
        assert_eq!(t.lateness, ms(11));
        assert_eq!(t.missed, 0);
        // Exactly at the threshold is still on time.
        let t = s.on_tick(t0 + ms(120 + 10));
        assert_eq!(t.verdict, Verdict::OnTime);
    }

    #[test]
    fn missed_deadlines_are_skipped_not_replayed() {
        let t0 = Instant::now();
        let mut s = Scheduler::new(t0);
        s.on_tick(t0 + ms(40));
        // The next deadline is 80 ms; the tick runs at 170 ms: deadlines 80 and 120 passed.
        let t = s.on_tick(t0 + ms(170));
        assert_eq!(t.scheduled, t0 + ms(80));
        assert_eq!(t.lateness, ms(90));
        assert_eq!(t.missed, 2);
        // Strictly after now, on the grid: 160 would be in the past, so 200.
        assert_eq!(s.next_deadline(), t0 + ms(200));
        assert!(s.next_deadline() > t0 + ms(170));
        // No catch-up burst: the next tick answers a single deadline.
        let next = s.on_tick(t0 + ms(200));
        assert_eq!(next.missed, 0);
        assert_eq!(next.verdict, Verdict::OnTime);
    }

    #[test]
    fn one_whole_missed_deadline_is_detected() {
        let t0 = Instant::now();
        let mut s = Scheduler::new(t0);
        s.on_tick(t0 + ms(40));
        let t = s.on_tick(t0 + ms(80 + 40));
        assert_eq!(t.missed, 1);
        assert_eq!(t.verdict, Verdict::DeadlinesMissed);
        assert_eq!(t.gap, Some(ms(80)), "80 ms is not yet a gap violation");
        assert_eq!(s.next_deadline(), t0 + ms(160));
    }

    #[test]
    fn a_gap_over_the_limit_is_a_violation_with_priority_over_missed_deadlines() {
        let t0 = Instant::now();
        let mut s = Scheduler::new(t0);
        s.on_tick(t0 + ms(40));
        let t = s.on_tick(t0 + ms(40 + 101));
        assert_eq!(t.gap, Some(ms(101)));
        assert_eq!(t.verdict, Verdict::GapViolation);
        assert!(t.missed > 0);
    }

    #[test]
    fn a_gap_of_exactly_the_limit_is_not_a_violation() {
        let t0 = Instant::now();
        let mut s = Scheduler::new(t0);
        s.on_tick(t0 + ms(40));
        let t = s.on_tick(t0 + ms(140));
        assert_eq!(t.gap, Some(ms(100)));
        assert_ne!(t.verdict, Verdict::GapViolation);
    }

    #[test]
    fn the_first_tick_has_no_gap_even_if_it_is_very_late() {
        let t0 = Instant::now();
        let mut s = Scheduler::new(t0);
        let t = s.on_tick(t0 + ms(5_000));
        assert_eq!(t.gap, None);
        assert_ne!(t.verdict, Verdict::GapViolation);
        assert!(t.missed > 100);
    }

    #[test]
    fn an_early_tick_has_zero_lateness_and_keeps_the_grid() {
        let t0 = Instant::now();
        let mut s = Scheduler::new(t0);
        let t = s.on_tick(t0 + ms(30));
        assert_eq!(t.lateness, Duration::ZERO);
        assert_eq!(t.missed, 0);
        assert_eq!(s.next_deadline(), t0 + ms(80));
    }

    #[test]
    fn ticks_are_never_closer_than_the_grid_allows_after_an_overrun() {
        // After a long stall, the following deadlines are at least one period apart.
        let t0 = Instant::now();
        let mut s = Scheduler::new(t0);
        s.on_tick(t0 + ms(40));
        s.on_tick(t0 + ms(1_000));
        let a = s.next_deadline();
        s.on_tick(a);
        let b = s.next_deadline();
        assert_eq!(b - a, ms(40));
    }
}
