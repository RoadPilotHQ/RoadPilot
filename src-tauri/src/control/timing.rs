//! Tick timing statistics.
//!
//! Every tick records, on the monotonic clock:
//!
//! * **lateness**: how far after its scheduled deadline the tick started (scheduler wake-up);
//! * **interval**: time between the starts of two consecutive ticks;
//! * **processing**: time from the start of a tick until its work was finished;
//! * **command interval**: time between two consecutive ticks that both encoded a command,
//!   which is the refresh interval the input protocol cares about. An encoded command is not a
//!   delivered command; in dry run nothing is delivered.
//!
//! Each quantity goes into a fixed-size histogram (0.1 ms buckets up to 200 ms plus an overflow
//! count) with an exact maximum, mean and exact counts above 40, 45 and 50 ms. Percentiles are
//! reported as the upper edge of their bucket, so they are never optimistic by more than 0.1 ms.
//! Memory is fixed; nothing here allocates per tick.

use std::time::Duration;

const BUCKET: Duration = Duration::from_micros(100);
const BUCKETS: usize = 2_000; // 0 .. 200 ms

/// Which timer drives the ticks. Descriptive only.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub enum TimerKind {
    /// Tokio's timer on the shared runtime (deterministic tests, and the original design).
    #[default]
    Tokio,
    /// A dedicated precise timer thread.
    Precise,
}

#[derive(Clone, Debug)]
pub struct Histogram {
    buckets: Box<[u32; BUCKETS]>,
    overflow: u64,
    count: u64,
    sum: Duration,
    max: Duration,
    over_40: u64,
    over_45: u64,
    over_50: u64,
}

impl Default for Histogram {
    fn default() -> Self {
        Self {
            buckets: Box::new([0; BUCKETS]),
            overflow: 0,
            count: 0,
            sum: Duration::ZERO,
            max: Duration::ZERO,
            over_40: 0,
            over_45: 0,
            over_50: 0,
        }
    }
}

/// A summary of one histogram, in milliseconds.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct Summary {
    pub count: u64,
    pub mean_ms: f64,
    pub p50_ms: f64,
    pub p95_ms: f64,
    pub p99_ms: f64,
    pub p999_ms: f64,
    pub max_ms: f64,
    pub over_40: u64,
    pub over_45: u64,
    pub over_50: u64,
}

fn ms(d: Duration) -> f64 {
    d.as_secs_f64() * 1_000.0
}

impl Histogram {
    pub fn record(&mut self, value: Duration) {
        let index = usize::try_from(value.as_nanos() / BUCKET.as_nanos()).unwrap_or(usize::MAX);
        match self.buckets.get_mut(index) {
            Some(bucket) => *bucket = bucket.saturating_add(1),
            None => self.overflow += 1,
        }
        self.count += 1;
        self.sum = self.sum.saturating_add(value);
        self.max = self.max.max(value);
        let over = |limit: u64| value > Duration::from_millis(limit);
        self.over_40 += u64::from(over(40));
        self.over_45 += u64::from(over(45));
        self.over_50 += u64::from(over(50));
    }

    pub fn count(&self) -> u64 {
        self.count
    }

    pub fn max(&self) -> Duration {
        self.max
    }

    /// The smallest bucket edge at or below which `q` of all values lie; the maximum if that
    /// lies in the overflow.
    pub fn percentile(&self, q: f64) -> Duration {
        if self.count == 0 {
            return Duration::ZERO;
        }
        let rank = ((q.clamp(0.0, 1.0) * self.count as f64).ceil() as u64).max(1);
        let mut seen = 0u64;
        for (index, &n) in self.buckets.iter().enumerate() {
            seen += u64::from(n);
            if seen >= rank {
                return (BUCKET * (index as u32 + 1)).min(self.max);
            }
        }
        self.max
    }

    pub fn summary(&self) -> Summary {
        Summary {
            count: self.count,
            mean_ms: if self.count == 0 {
                0.0
            } else {
                ms(self.sum) / self.count as f64
            },
            p50_ms: ms(self.percentile(0.50)),
            p95_ms: ms(self.percentile(0.95)),
            p99_ms: ms(self.percentile(0.99)),
            p999_ms: ms(self.percentile(0.999)),
            max_ms: ms(self.max),
            over_40: self.over_40,
            over_45: self.over_45,
            over_50: self.over_50,
        }
    }
}

/// Timing of all ticks since the control runtime started.
#[derive(Clone, Debug, Default)]
pub struct TimingStats {
    pub timer: TimerKind,
    pub ticks: u64,
    pub lateness: Histogram,
    pub intervals: Histogram,
    pub processing: Histogram,
    pub command_intervals: Histogram,
    /// Deadlines skipped because a tick was more than a period late (never replayed).
    pub missed_deadlines: u64,
    /// Ticks later than the lateness threshold.
    pub late_ticks: u64,
    /// Tick gaps above the safety limit; each one is a safety event.
    pub gap_violations: u64,
}

impl TimingStats {
    pub fn new(timer: TimerKind) -> Self {
        Self {
            timer,
            ..Self::default()
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Exact for values with at most three decimals.
    fn ms(n: f64) -> Duration {
        Duration::from_micros((n * 1_000.0).round() as u64)
    }

    #[test]
    fn an_empty_histogram_reports_zeros() {
        let h = Histogram::default();
        assert_eq!(h.summary(), Summary::default());
    }

    #[test]
    fn counts_above_the_limits_are_exact() {
        let mut h = Histogram::default();
        for v in [40.0, 40.01, 45.0, 45.01, 50.0, 50.01, 120.0] {
            h.record(ms(v));
        }
        let s = h.summary();
        assert_eq!(s.count, 7);
        assert_eq!(s.over_40, 6, "40.0 itself is not above 40");
        assert_eq!(s.over_45, 4, "45.0 itself is not above 45");
        assert_eq!(s.over_50, 2, "50.0 itself is not above 50");
        assert!((s.max_ms - 120.0).abs() < 1e-9);
    }

    #[test]
    fn percentiles_are_never_optimistic_by_more_than_one_bucket() {
        let mut h = Histogram::default();
        for i in 0..1_000u32 {
            h.record(Duration::from_micros(39_000 + u64::from(i) * 2)); // 39.000 .. 40.998 ms
        }
        let s = h.summary();
        assert!(s.p50_ms >= 39.999 && s.p50_ms <= 40.1, "{}", s.p50_ms);
        assert!(
            s.p99_ms >= 40.978 && s.p99_ms <= 41.0 + 1e-9,
            "{}",
            s.p99_ms
        );
        assert!(s.p999_ms <= s.max_ms + 1e-9);
        assert!((s.mean_ms - 39.999).abs() < 0.01, "{}", s.mean_ms);
    }

    #[test]
    fn a_single_outlier_shows_in_p999_and_max_but_not_p99() {
        let mut h = Histogram::default();
        for _ in 0..999 {
            h.record(ms(40.0));
        }
        h.record(ms(73.0));
        let s = h.summary();
        assert!(s.p99_ms < 40.2);
        assert!((s.max_ms - 73.0).abs() < 1e-6);
        assert_eq!(s.over_50, 1);
        let mut more = h.clone();
        more.record(ms(73.0));
        assert!(more.summary().p999_ms > 70.0);
    }

    #[test]
    fn values_beyond_the_range_go_to_the_overflow_and_the_maximum() {
        let mut h = Histogram::default();
        h.record(ms(10.0));
        h.record(Duration::from_secs(3));
        let s = h.summary();
        assert_eq!(s.count, 2);
        assert!((s.max_ms - 3_000.0).abs() < 1e-6);
        assert!(
            (s.p99_ms - 3_000.0).abs() < 1e-6,
            "the overflow reports the maximum"
        );
    }

    #[test]
    fn huge_values_do_not_panic() {
        let mut h = Histogram::default();
        h.record(Duration::MAX);
        h.record(Duration::MAX);
        assert_eq!(h.count(), 2);
        assert_eq!(h.max(), Duration::MAX);
    }
}
