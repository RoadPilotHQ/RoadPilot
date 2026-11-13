//! Bounded in-memory log of control decisions.
//!
//! Three independent ring buffers, so that a high-rate stream can never push out the records
//! that matter most:
//!
//! * **decisions**: supervisor transitions with their reasons, vehicle epoch changes, invalid
//!   frames, withheld output, rejected commands, watchdog trips, feed changes and shutdown;
//! * **timing**: late ticks, skipped deadlines and gap violations;
//! * **messages**: every encoded message (25 per second while Active) with the requested and
//!   the bounded values.
//!
//! Every record is a fixed-size value (no strings, no vectors), and each ring has a fixed
//! capacity; when a ring is full the oldest record is dropped and counted. The log is cheap to
//! clone (shared handle) and never panics: a poisoned lock is recovered, because losing a log
//! line must not take control down.
//!
//! A message record states truthfully what happened to the message through [`Delivery`]; in
//! this phase it is always "not transmitted".
//!
//! # Observer (diagnostics only)
//!
//! A log can be created with a [`LogObserver`] ([`ControlLog::with_observer`]). The observer
//! receives a copy of every record as it is logged, before any ring could drop it, plus the
//! freshness assessment whenever it changes ([`ControlLog::assessment`], which no ring keeps).
//! The application uses it for the optional telemetry recorder. The observer is called after
//! the log's lock is released, on the thread that logged the record (the elevated control
//! thread for most records), so an implementation must return immediately and must never
//! block, wait for a lock or do I/O. Without an observer nothing changes.

use super::command::{Adjustments, ControlRequest, Withheld};
use super::freshness::{Assessment, Discontinuity};
use super::protocol::MESSAGE_LEN;
use super::sink::Delivery;
use super::supervisor::{Command, Rejection, Transition};
use super::vehicle::InvalidFrame;
use std::collections::VecDeque;
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::time::{Duration, Instant};

pub const DECISION_CAPACITY: usize = 256;
pub const TIMING_CAPACITY: usize = 128;
pub const MESSAGE_CAPACITY: usize = 256;

/// What a shutdown did about the disarm message. Never claims delivery.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum DisarmStatus {
    /// Nothing had been encoded as armed, so no disarm was needed.
    NotRequired,
    /// A disarm message was encoded but, in dry-run, not transmitted.
    EncodedNotTransmitted,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum DecisionEvent {
    Transition(Transition),
    /// The vehicle epoch changed (first frame, session or game change, pause, gap, restart,
    /// backlog or invalid frame).
    Epoch {
        epoch: u64,
        cause: Discontinuity,
    },
    FrameInvalid(InvalidFrame),
    /// Output was withheld; logged when the reason changes, not on every tick.
    Withheld(Withheld),
    CommandRejected {
        command: Command,
        rejection: Rejection,
    },
    /// The independent watchdog saw the supervisor loop silent.
    WatchdogTripped {
        silent_for: Duration,
    },
    FeedLost,
    FeedRestored,
    Shutdown {
        disarm: DisarmStatus,
    },
}

/// A tick that did not run on time. On-time ticks are not logged.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum TimingEvent {
    /// Later than the lateness tolerance, no deadline skipped.
    Late { lateness: Duration },
    /// Whole deadlines passed without a tick and were skipped, never replayed.
    DeadlinesMissed { missed: u32, lateness: Duration },
    /// The gap since the previous tick exceeded what the input plugin tolerates.
    GapViolation { gap: Duration, missed: u32 },
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum MessageKind {
    Command,
    Disarm,
}

/// The values that went into an encoded command after all limits were applied.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Bounded {
    pub steering: Option<f32>,
    pub throttle: f32,
    pub brake: f32,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct MessageRecord {
    pub kind: MessageKind,
    /// Exactly the bytes produced by the encoder.
    pub bytes: [u8; MESSAGE_LEN],
    /// What the controller asked for; `None` for a disarm.
    pub requested: Option<ControlRequest>,
    /// What was encoded; `None` for a disarm.
    pub bounded: Option<Bounded>,
    pub adjustments: Adjustments,
    pub delivery: Delivery,
}

/// A record as seen by a [`LogObserver`].
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Observed {
    Decision(Entry<DecisionEvent>),
    Timing(Entry<TimingEvent>),
    Message(Entry<MessageRecord>),
    /// The freshness assessment changed (kind, invalid reason or epoch). `at` is relative to
    /// the log's origin like every entry; there is no position `n` because no ring keeps it.
    Assessment {
        at: Duration,
        assessment: Assessment,
    },
}

/// Receives every record of a [`ControlLog`]. See the module documentation: it runs on the
/// logging thread and must never block.
pub trait LogObserver: Send + Sync {
    fn observe(&self, record: Observed);
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Entry<T> {
    /// Position in the order of all records of all rings.
    pub n: u64,
    /// Time since the log was created.
    pub at: Duration,
    pub event: T,
}

#[derive(Debug)]
struct Ring<T> {
    entries: VecDeque<Entry<T>>,
    capacity: usize,
    dropped: u64,
}

impl<T: Copy> Ring<T> {
    fn new(capacity: usize) -> Self {
        Self {
            entries: VecDeque::with_capacity(capacity),
            capacity,
            dropped: 0,
        }
    }

    fn push(&mut self, entry: Entry<T>) {
        if self.entries.len() == self.capacity {
            self.entries.pop_front();
            self.dropped += 1;
        }
        self.entries.push_back(entry);
    }
}

#[derive(Debug)]
struct Inner {
    origin: Instant,
    next_n: u64,
    decisions: Ring<DecisionEvent>,
    timing: Ring<TimingEvent>,
    messages: Ring<MessageRecord>,
}

/// Number of records each ring has dropped because it was full.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct Dropped {
    pub decisions: u64,
    pub timing: u64,
    pub messages: u64,
}

#[derive(Clone, Debug)]
pub struct LogSnapshot {
    pub decisions: Vec<Entry<DecisionEvent>>,
    pub timing: Vec<Entry<TimingEvent>>,
    pub messages: Vec<Entry<MessageRecord>>,
    pub dropped: Dropped,
}

/// Shared handle to the log.
#[derive(Clone)]
pub struct ControlLog {
    inner: Arc<Mutex<Inner>>,
    /// Copy of the origin, so the observer path needs no lock.
    origin: Instant,
    /// Fixed at creation and never changed.
    observer: Option<Arc<dyn LogObserver>>,
}

impl std::fmt::Debug for ControlLog {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ControlLog")
            .field("inner", &self.inner)
            .field("observed", &self.observer.is_some())
            .finish()
    }
}

impl ControlLog {
    pub fn new(origin: Instant) -> Self {
        Self::with_observer(origin, None)
    }

    /// A log whose records are also handed to `observer` (diagnostics). `None` is identical
    /// to [`ControlLog::new`].
    pub fn with_observer(origin: Instant, observer: Option<Arc<dyn LogObserver>>) -> Self {
        let mut log =
            Self::with_capacities(origin, DECISION_CAPACITY, TIMING_CAPACITY, MESSAGE_CAPACITY);
        log.observer = observer;
        log
    }

    fn with_capacities(origin: Instant, decisions: usize, timing: usize, messages: usize) -> Self {
        Self {
            inner: Arc::new(Mutex::new(Inner {
                origin,
                next_n: 0,
                decisions: Ring::new(decisions.max(1)),
                timing: Ring::new(timing.max(1)),
                messages: Ring::new(messages.max(1)),
            })),
            origin,
            observer: None,
        }
    }

    /// Hands a record to the observer, if any. Always called without the lock held.
    fn notify(&self, record: Observed) {
        if let Some(observer) = &self.observer {
            observer.observe(record);
        }
    }

    /// Reports a changed freshness assessment to the observer only. No ring keeps it, so the
    /// in-memory log and the UI are unaffected; without an observer this does nothing.
    pub fn assessment(&self, now: Instant, assessment: Assessment) {
        self.notify(Observed::Assessment {
            at: now.saturating_duration_since(self.origin),
            assessment,
        });
    }

    fn lock(&self) -> MutexGuard<'_, Inner> {
        self.inner.lock().unwrap_or_else(PoisonError::into_inner)
    }

    fn entry<T>(inner: &mut Inner, now: Instant, event: T) -> Entry<T> {
        let n = inner.next_n;
        inner.next_n += 1;
        Entry {
            n,
            at: now.saturating_duration_since(inner.origin),
            event,
        }
    }

    pub fn decision(&self, now: Instant, event: DecisionEvent) {
        let entry = {
            let mut inner = self.lock();
            let entry = Self::entry(&mut inner, now, event);
            inner.decisions.push(entry);
            entry
        };
        self.notify(Observed::Decision(entry));
    }

    pub fn timing(&self, now: Instant, event: TimingEvent) {
        let entry = {
            let mut inner = self.lock();
            let entry = Self::entry(&mut inner, now, event);
            inner.timing.push(entry);
            entry
        };
        self.notify(Observed::Timing(entry));
    }

    pub fn message(&self, now: Instant, record: MessageRecord) {
        let entry = {
            let mut inner = self.lock();
            let entry = Self::entry(&mut inner, now, record);
            inner.messages.push(entry);
            entry
        };
        self.notify(Observed::Message(entry));
    }

    /// The newest `count` decision records, oldest first.
    pub fn recent_decisions(&self, count: usize) -> Vec<Entry<DecisionEvent>> {
        let inner = self.lock();
        let skip = inner.decisions.entries.len().saturating_sub(count);
        inner.decisions.entries.iter().skip(skip).copied().collect()
    }

    /// Kind of the newest encoded message, if any. A ring always keeps its newest record, so
    /// this is reliable even after older messages were dropped.
    pub fn last_message_kind(&self) -> Option<MessageKind> {
        self.lock().messages.entries.back().map(|e| e.event.kind)
    }

    /// True if a command was encoded and no disarm followed it.
    pub fn owes_disarm(&self) -> bool {
        self.last_message_kind() == Some(MessageKind::Command)
    }

    pub fn snapshot(&self) -> LogSnapshot {
        let inner = self.lock();
        LogSnapshot {
            decisions: inner.decisions.entries.iter().copied().collect(),
            timing: inner.timing.entries.iter().copied().collect(),
            messages: inner.messages.entries.iter().copied().collect(),
            dropped: Dropped {
                decisions: inner.decisions.dropped,
                timing: inner.timing.dropped,
                messages: inner.messages.dropped,
            },
        }
    }
}

#[cfg(test)]
mod tests {
    use super::super::supervisor::{Reason, State};
    use super::*;

    fn ms(n: u64) -> Duration {
        Duration::from_millis(n)
    }

    fn msg(kind: MessageKind) -> MessageRecord {
        MessageRecord {
            kind,
            bytes: [0; MESSAGE_LEN],
            requested: None,
            bounded: None,
            adjustments: Adjustments::default(),
            delivery: Delivery::NotTransmitted,
        }
    }

    fn transition() -> DecisionEvent {
        DecisionEvent::Transition(Transition {
            from: State::Active,
            to: State::Fault,
            reason: Reason::ManualDisarm,
        })
    }

    #[test]
    fn records_are_ordered_and_timestamped_relative_to_the_origin() {
        let t0 = Instant::now();
        let log = ControlLog::new(t0);
        log.decision(t0 + ms(5), transition());
        log.message(t0 + ms(40), msg(MessageKind::Command));
        log.timing(t0 + ms(41), TimingEvent::Late { lateness: ms(12) });
        let s = log.snapshot();
        assert_eq!(s.decisions[0].n, 0);
        assert_eq!(s.decisions[0].at, ms(5));
        assert_eq!(s.messages[0].n, 1);
        assert_eq!(s.messages[0].at, ms(40));
        assert_eq!(s.timing[0].n, 2);
        assert_eq!(s.dropped, Dropped::default());
    }

    #[test]
    fn each_ring_is_bounded_and_counts_what_it_drops() {
        let t0 = Instant::now();
        let log = ControlLog::with_capacities(t0, 3, 2, 4);
        for i in 0..10u64 {
            log.decision(
                t0,
                DecisionEvent::Epoch {
                    epoch: i,
                    cause: Discontinuity::Gap,
                },
            );
            log.timing(t0, TimingEvent::Late { lateness: ms(i) });
            log.message(t0, msg(MessageKind::Command));
        }
        let s = log.snapshot();
        assert_eq!(s.decisions.len(), 3);
        assert_eq!(s.timing.len(), 2);
        assert_eq!(s.messages.len(), 4);
        assert_eq!(
            s.dropped,
            Dropped {
                decisions: 7,
                timing: 8,
                messages: 6
            }
        );
        // The newest records are the ones kept.
        assert!(matches!(
            s.decisions.last().unwrap().event,
            DecisionEvent::Epoch { epoch: 9, .. }
        ));
        assert!(matches!(
            s.decisions.first().unwrap().event,
            DecisionEvent::Epoch { epoch: 7, .. }
        ));
    }

    #[test]
    fn the_default_capacities_are_fixed() {
        let t0 = Instant::now();
        let log = ControlLog::new(t0);
        for _ in 0..(MESSAGE_CAPACITY * 3) {
            log.message(t0, msg(MessageKind::Command));
            log.decision(t0, DecisionEvent::FeedLost);
            log.timing(t0, TimingEvent::Late { lateness: ms(11) });
        }
        let s = log.snapshot();
        assert_eq!(s.messages.len(), MESSAGE_CAPACITY);
        assert_eq!(s.decisions.len(), DECISION_CAPACITY);
        assert_eq!(s.timing.len(), TIMING_CAPACITY);
    }

    #[test]
    fn a_message_flood_cannot_push_out_a_safety_decision() {
        let t0 = Instant::now();
        let log = ControlLog::new(t0);
        log.decision(t0, transition());
        for _ in 0..100_000 {
            log.message(t0, msg(MessageKind::Command));
            log.timing(t0, TimingEvent::Late { lateness: ms(11) });
        }
        let s = log.snapshot();
        assert_eq!(s.decisions.len(), 1);
        assert!(matches!(s.decisions[0].event, DecisionEvent::Transition(_)));
        assert_eq!(s.messages.len(), MESSAGE_CAPACITY);
        assert!(s.dropped.messages > 0 && s.dropped.decisions == 0);
    }

    #[test]
    fn a_message_record_never_claims_a_transmission() {
        let t0 = Instant::now();
        let log = ControlLog::new(t0);
        log.message(t0, msg(MessageKind::Disarm));
        let r = log.snapshot().messages[0].event;
        assert_eq!(r.delivery, Delivery::NotTransmitted);
        assert_ne!(
            DisarmStatus::EncodedNotTransmitted,
            DisarmStatus::NotRequired
        );
    }

    #[test]
    fn the_handle_is_shared_between_clones() {
        let t0 = Instant::now();
        let a = ControlLog::new(t0);
        let b = a.clone();
        a.decision(t0, DecisionEvent::FeedLost);
        b.decision(t0, DecisionEvent::FeedRestored);
        assert_eq!(a.snapshot().decisions.len(), 2);
        assert_eq!(b.snapshot().decisions.len(), 2);
    }

    #[test]
    fn a_poisoned_lock_does_not_stop_logging() {
        let t0 = Instant::now();
        let log = ControlLog::new(t0);
        let poisoner = log.clone();
        let _ = std::thread::spawn(move || {
            let _guard = poisoner.inner.lock().unwrap();
            panic!("poison the log lock");
        })
        .join();
        log.decision(t0, DecisionEvent::FeedLost);
        assert_eq!(log.snapshot().decisions.len(), 1);
    }

    #[test]
    fn a_time_before_the_origin_saturates_to_zero() {
        let t0 = Instant::now() + ms(1_000);
        let log = ControlLog::new(t0);
        log.decision(t0 - ms(500), DecisionEvent::FeedLost);
        assert_eq!(log.snapshot().decisions[0].at, Duration::ZERO);
    }

    // ---- observer ----

    #[derive(Default)]
    struct Collect(Mutex<Vec<Observed>>);

    impl LogObserver for Collect {
        fn observe(&self, record: Observed) {
            self.0.lock().unwrap().push(record);
        }
    }

    #[test]
    fn the_observer_sees_every_record_in_order_even_those_the_rings_drop() {
        let t0 = Instant::now();
        let seen = Arc::new(Collect::default());
        let mut log = ControlLog::with_capacities(t0, 2, 2, 2);
        log.observer = Some(seen.clone());
        for i in 0..10u64 {
            log.decision(
                t0 + ms(i),
                DecisionEvent::Epoch {
                    epoch: i,
                    cause: Discontinuity::Gap,
                },
            );
            log.timing(t0 + ms(i), TimingEvent::Late { lateness: ms(i) });
            log.message(t0 + ms(i), msg(MessageKind::Command));
        }
        assert_eq!(log.snapshot().dropped.decisions, 8, "the rings still drop");
        let seen = seen.0.lock().unwrap();
        assert_eq!(seen.len(), 30, "the observer misses nothing");
        let positions: Vec<u64> = seen
            .iter()
            .map(|r| match r {
                Observed::Decision(e) => e.n,
                Observed::Timing(e) => e.n,
                Observed::Message(e) => e.n,
                Observed::Assessment { .. } => unreachable!(),
            })
            .collect();
        assert_eq!(positions, (0..30).collect::<Vec<_>>());
        assert!(matches!(
            seen[27],
            Observed::Decision(Entry {
                at,
                event: DecisionEvent::Epoch { epoch: 9, .. },
                ..
            }) if at == ms(9)
        ));
    }

    #[test]
    fn assessments_reach_only_the_observer() {
        let t0 = Instant::now();
        let seen = Arc::new(Collect::default());
        let log = ControlLog::with_observer(t0, Some(seen.clone()));
        let paused = Assessment::Unusable(super::super::freshness::Unusable::Paused);
        log.assessment(t0 + ms(80), paused);
        let s = log.snapshot();
        assert!(s.decisions.is_empty() && s.timing.is_empty() && s.messages.is_empty());
        assert_eq!(
            *seen.0.lock().unwrap(),
            vec![Observed::Assessment {
                at: ms(80),
                assessment: paused
            }]
        );
        // Without an observer an assessment is a no-op.
        let plain = ControlLog::new(t0);
        plain.assessment(t0, paused);
        assert!(plain.snapshot().decisions.is_empty());
    }

    #[test]
    fn the_observer_is_called_without_the_log_lock_held() {
        // An observer that reads the log would deadlock if it ran under the lock.
        struct Reentrant(std::sync::OnceLock<ControlLog>, Mutex<usize>);
        impl LogObserver for Reentrant {
            fn observe(&self, _record: Observed) {
                if let Some(log) = self.0.get() {
                    *self.1.lock().unwrap() = log.snapshot().decisions.len();
                }
            }
        }
        let t0 = Instant::now();
        let observer = Arc::new(Reentrant(std::sync::OnceLock::new(), Mutex::new(0)));
        let log = ControlLog::with_observer(t0, Some(observer.clone()));
        let _ = observer.0.set(log.clone());
        log.decision(t0, DecisionEvent::FeedLost);
        assert_eq!(*observer.1.lock().unwrap(), 1);
    }
}
