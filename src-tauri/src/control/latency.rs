//! Telemetry latency diagnosis (R6), in shadow mode.
//!
//! Classifies four measures separately, from the QPC timing of each running frame and from
//! the age of the newest frame at each control tick:
//!
//! | Measure | Delayed | Critical | Calibration drive (13.11.2026) |
//! |---|---|---|---|
//! | Plugin processing (`sent - produced`, includes the ~16 ms send pacing) | > 20 ms | > 50 ms | max 23.7 ms, 1 frame > 20 ms |
//! | Transport (`received - sent`) | > 10 ms | > 50 ms | max 20.9 ms, 3 frames > 10 ms |
//! | Age at receive (`received - produced`) | > 30 ms | > 50 ms | max 23.9 ms, none > 30 ms |
//! | Age at decision (tick time - produced, newest running frame) | > 100 ms | > 150 ms | max 111.6 ms, 2 ticks > 100 ms |
//!
//! A sample is **Normal**, **Delayed** or **Critical** by these limits, or **Unusable** when
//! the frame has no valid QPC timing: a missing or invalid clock is never normal. A measure
//! is **Degraded** when at least [`DEGRADED_COUNT`] of its last [`DEGRADED_WINDOW`] samples
//! were not normal; the episode ends after [`RECOVERY_SAMPLES`] normal samples in a row. A
//! single outlier therefore never starts an episode. A critical sample is reported at once
//! when the measure becomes critical (every critical sample is counted, but a run of them, for
//! example the age at decision after the game stopped, is reported once).
//!
//! **Shadow mode.** Nothing here takes part in a decision: the results go only to the status,
//! the log observer (diagnostic recording) and tests. The freshness check, the supervisor, the
//! command generator and the simulation-time backlog check (R7) do not read them. The limits
//! above are diagnostic and change no safety limit (the 150 ms age limit is enforced by the
//! freshness check, not here).

use super::freshness::{ClockStatus, FrameDigest};
use std::time::{Duration, Instant};

pub const DEGRADED_WINDOW: usize = 10;
pub const DEGRADED_COUNT: usize = 3;
pub const RECOVERY_SAMPLES: u32 = 30;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Measure {
    Processing,
    Transport,
    AgeAtReceive,
    AgeAtDecision,
}

impl Measure {
    pub const ALL: [Measure; 4] = [
        Measure::Processing,
        Measure::Transport,
        Measure::AgeAtReceive,
        Measure::AgeAtDecision,
    ];

    /// (delayed, critical) limits; a value above a limit is in that class.
    pub fn limits(self) -> (Duration, Duration) {
        let ms = Duration::from_millis;
        match self {
            Measure::Processing => (ms(20), ms(50)),
            Measure::Transport => (ms(10), ms(50)),
            Measure::AgeAtReceive => (ms(30), ms(50)),
            Measure::AgeAtDecision => (ms(100), ms(150)),
        }
    }

    pub fn classify(self, value: Option<Duration>) -> LatencyClass {
        let (delayed, critical) = self.limits();
        match value {
            None => LatencyClass::Unusable,
            Some(v) if v > critical => LatencyClass::Critical,
            Some(v) if v > delayed => LatencyClass::Delayed,
            Some(_) => LatencyClass::Normal,
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum LatencyClass {
    Normal,
    Delayed,
    Critical,
    /// No valid QPC timing: the value is unknown.
    Unusable,
}

/// Something worth recording, reported at once.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum LatencyEvent {
    Critical { measure: Measure, value: Duration },
    DegradedStarted { measure: Measure },
    DegradedEnded { measure: Measure },
}

/// Counts and state of one measure.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct MeasureSnapshot {
    pub last_class: Option<LatencyClass>,
    pub last_value: Option<Duration>,
    pub normal: u64,
    pub delayed: u64,
    pub critical: u64,
    pub unusable: u64,
    pub degraded: bool,
    pub degraded_episodes: u64,
}

#[derive(Clone, Copy, Debug)]
struct Tracker {
    measure: Measure,
    snapshot: MeasureSnapshot,
    /// Last samples, `true` = not normal (ring).
    window: [bool; DEGRADED_WINDOW],
    next: usize,
    normal_streak: u32,
}

impl Tracker {
    fn new(measure: Measure) -> Self {
        Self {
            measure,
            snapshot: MeasureSnapshot::default(),
            window: [false; DEGRADED_WINDOW],
            next: 0,
            normal_streak: 0,
        }
    }

    fn record(&mut self, value: Option<Duration>, events: &mut impl FnMut(LatencyEvent)) {
        let class = self.measure.classify(value);
        let s = &mut self.snapshot;
        let was_critical = s.last_class == Some(LatencyClass::Critical);
        s.last_class = Some(class);
        s.last_value = value;
        match class {
            LatencyClass::Normal => s.normal += 1,
            LatencyClass::Delayed => s.delayed += 1,
            LatencyClass::Critical => s.critical += 1,
            LatencyClass::Unusable => s.unusable += 1,
        }
        let abnormal = class != LatencyClass::Normal;
        self.window[self.next] = abnormal;
        self.next = (self.next + 1) % DEGRADED_WINDOW;
        self.normal_streak = if abnormal {
            0
        } else {
            self.normal_streak.saturating_add(1)
        };
        if let (LatencyClass::Critical, Some(value), false) = (class, value, was_critical) {
            events(LatencyEvent::Critical {
                measure: self.measure,
                value,
            });
        }
        let abnormal_in_window = self.window.iter().filter(|a| **a).count();
        if !s.degraded && abnormal_in_window >= DEGRADED_COUNT {
            s.degraded = true;
            s.degraded_episodes += 1;
            events(LatencyEvent::DegradedStarted {
                measure: self.measure,
            });
        } else if s.degraded && self.normal_streak >= RECOVERY_SAMPLES {
            s.degraded = false;
            events(LatencyEvent::DegradedEnded {
                measure: self.measure,
            });
        }
    }
}

/// The four measures. Owned by the control core; read only for status and diagnostics.
#[derive(Clone, Copy, Debug)]
pub struct LatencyMonitor {
    trackers: [Tracker; 4],
}

impl Default for LatencyMonitor {
    fn default() -> Self {
        Self {
            trackers: Measure::ALL.map(Tracker::new),
        }
    }
}

impl LatencyMonitor {
    fn tracker(&mut self, measure: Measure) -> &mut Tracker {
        &mut self.trackers[Measure::ALL.iter().position(|m| *m == measure).unwrap()]
    }

    /// Records the timing of one running frame. Paused frames are not measured.
    pub fn on_frame(&mut self, digest: &FrameDigest, mut events: impl FnMut(LatencyEvent)) {
        if digest.paused {
            return;
        }
        let (processing, transport, age) = match digest.clock {
            ClockStatus::Verified {
                processing,
                transport,
            } => (
                Some(processing),
                Some(transport),
                digest
                    .produced_at
                    .map(|p| digest.received_at.saturating_duration_since(p)),
            ),
            ClockStatus::Missing(_) | ClockStatus::Invalid(_) => (None, None, None),
        };
        self.tracker(Measure::Processing)
            .record(processing, &mut events);
        self.tracker(Measure::Transport)
            .record(transport, &mut events);
        self.tracker(Measure::AgeAtReceive).record(age, &mut events);
    }

    /// Records the age of the newest running frame at a control tick: `Some(None)` when that
    /// frame had no valid timing; nothing when there is no running frame.
    pub fn on_tick(
        &mut self,
        now: Instant,
        newest_produced_at: Option<Option<Instant>>,
        mut events: impl FnMut(LatencyEvent),
    ) {
        if let Some(produced_at) = newest_produced_at {
            let age = produced_at.map(|p| now.saturating_duration_since(p));
            self.tracker(Measure::AgeAtDecision)
                .record(age, &mut events);
        }
    }

    pub fn snapshot(&self, measure: Measure) -> MeasureSnapshot {
        self.trackers[Measure::ALL.iter().position(|m| *m == measure).unwrap()].snapshot
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ms(n: u64) -> Duration {
        Duration::from_millis(n)
    }

    fn run(measure: Measure, values: &[Option<Duration>]) -> (MeasureSnapshot, Vec<LatencyEvent>) {
        let mut tracker = Tracker::new(measure);
        let mut events = Vec::new();
        for v in values {
            tracker.record(*v, &mut |e| events.push(e));
        }
        (tracker.snapshot, events)
    }

    #[test]
    fn transport_samples_of_20_49_and_51_ms() {
        assert_eq!(
            Measure::Transport.classify(Some(ms(10))),
            LatencyClass::Normal
        );
        assert_eq!(
            Measure::Transport.classify(Some(ms(20))),
            LatencyClass::Delayed
        );
        assert_eq!(
            Measure::Transport.classify(Some(ms(49))),
            LatencyClass::Delayed
        );
        assert_eq!(
            Measure::Transport.classify(Some(ms(50))),
            LatencyClass::Delayed
        );
        assert_eq!(
            Measure::Transport.classify(Some(ms(51))),
            LatencyClass::Critical
        );
        // A critical sample is reported at once, without an episode.
        let (s, events) = run(Measure::Transport, &[Some(ms(51))]);
        assert_eq!(
            events,
            [LatencyEvent::Critical {
                measure: Measure::Transport,
                value: ms(51)
            }]
        );
        assert_eq!((s.critical, s.degraded), (1, false));
        // A run of critical samples is reported once, but counted fully.
        let (s, events) = run(
            Measure::Transport,
            &[Some(ms(60)), Some(ms(70)), Some(ms(1)), Some(ms(55))],
        );
        assert_eq!(s.critical, 3);
        assert_eq!(
            events
                .iter()
                .filter(|e| matches!(e, LatencyEvent::Critical { .. }))
                .count(),
            2
        );
    }

    #[test]
    fn a_missing_or_invalid_clock_is_never_normal() {
        for measure in Measure::ALL {
            assert_eq!(measure.classify(None), LatencyClass::Unusable);
        }
        let (s, _) = run(Measure::Transport, &[None, None, None]);
        assert_eq!((s.unusable, s.normal), (3, 0));
        assert!(s.degraded, "an unknown clock counts as abnormal");
    }

    #[test]
    fn a_single_outlier_starts_no_episode() {
        let mut values = vec![Some(ms(1)); 20];
        values[5] = Some(ms(20));
        let (s, events) = run(Measure::Transport, &values);
        assert_eq!((s.delayed, s.degraded, s.degraded_episodes), (1, false, 0));
        assert!(events.is_empty());
    }

    #[test]
    fn three_of_ten_delayed_samples_start_a_degraded_episode() {
        let mut values = vec![Some(ms(1)); 10];
        values[1] = Some(ms(15));
        values[4] = Some(ms(15));
        values[9] = Some(ms(15));
        let (s, events) = run(Measure::Transport, &values);
        assert!(s.degraded);
        assert_eq!(s.degraded_episodes, 1);
        assert_eq!(
            events,
            [LatencyEvent::DegradedStarted {
                measure: Measure::Transport
            }]
        );
        // Spread further apart than the window: no episode.
        let mut sparse = vec![Some(ms(1)); 30];
        for i in [0, 10, 20] {
            sparse[i] = Some(ms(15));
        }
        assert!(!run(Measure::Transport, &sparse).0.degraded);
    }

    #[test]
    fn an_episode_ends_after_30_normal_samples() {
        let mut values = vec![Some(ms(15)); 3];
        values.extend(std::iter::repeat_n(Some(ms(1)), 29));
        let (s, _) = run(Measure::Transport, &values);
        assert!(s.degraded, "29 normal samples are not enough");
        values.push(Some(ms(1)));
        let (s, events) = run(Measure::Transport, &values);
        assert!(!s.degraded);
        assert_eq!(
            events.last(),
            Some(&LatencyEvent::DegradedEnded {
                measure: Measure::Transport
            })
        );
        // An abnormal sample in between restarts the count.
        let mut interrupted = vec![Some(ms(15)); 3];
        interrupted.extend(std::iter::repeat_n(Some(ms(1)), 20));
        interrupted.push(Some(ms(15)));
        interrupted.extend(std::iter::repeat_n(Some(ms(1)), 20));
        assert!(run(Measure::Transport, &interrupted).0.degraded);
    }

    #[test]
    fn the_limits_are_per_measure() {
        assert_eq!(
            Measure::Processing.classify(Some(ms(17))),
            LatencyClass::Normal
        );
        assert_eq!(
            Measure::Processing.classify(Some(ms(21))),
            LatencyClass::Delayed
        );
        assert_eq!(
            Measure::AgeAtReceive.classify(Some(ms(29))),
            LatencyClass::Normal
        );
        assert_eq!(
            Measure::AgeAtReceive.classify(Some(ms(31))),
            LatencyClass::Delayed
        );
        assert_eq!(
            Measure::AgeAtDecision.classify(Some(ms(99))),
            LatencyClass::Normal
        );
        assert_eq!(
            Measure::AgeAtDecision.classify(Some(ms(101))),
            LatencyClass::Delayed
        );
        assert_eq!(
            Measure::AgeAtDecision.classify(Some(ms(151))),
            LatencyClass::Critical
        );
    }
}
