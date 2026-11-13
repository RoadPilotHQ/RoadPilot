//! The bounded hand-off of telemetry from the relay to the control loop.
//!
//! The relay (shared runtime, normal priority) turns every frame it sees into a
//! [`FrameDigest`] and sends it here; the control thread (elevated priority) takes what is
//! queued at each tick. The design keeps three guarantees:
//!
//! * **Bounded.** One `std::sync::mpsc::sync_channel` of [`CAPACITY`] fixed-size `Copy`
//!   items. Nothing grows, and the control thread takes at most [`CAPACITY`] items per tick.
//!   It never frees a frame: digests hold no heap memory.
//! * **Ordered, and critical items cannot be crowded out.** There is one FIFO, so items
//!   arrive in the order they were sent and an older frame can never follow a newer one.
//!   Ordinary frames may occupy at most [`NORMAL_QUOTA`] places; the rest is reserved for
//!   *critical* items, so a backlog of ordinary frames never displaces one. Critical are the
//!   first frame, every change of session, game, pause state or validity (invalid identity,
//!   invalid vehicle state) and feed lost / restored. A loss does not make the next frame
//!   critical: that would fill the reserve with ordinary frames during a stall.
//! * **Every loss is reported where it happened.** Each item carries the number of items
//!   dropped before it was sent. The receiver reports [`Received::Lost`] *before* the first
//!   item that follows a loss, and, if nothing followed, at the end of the drain. The control
//!   core answers with a new freshness epoch ([`Discontinuity::HandoffOverflow`]): the state
//!   must settle again, so an Armed supervisor disarms and an Active one faults through its
//!   existing rules. A loss is therefore never silent and never assumed harmless.
//!
//! A loss needs either more than [`NORMAL_QUOTA`] ordinary frames waiting (at 60 Hz, a
//! control thread stalled for about 200 ms, which is already a gap violation) or more than
//! `CAPACITY - NORMAL_QUOTA` critical items waiting at once.
//!
//! Disconnects and the end of the game have no item of their own: the pipe gives no signal.
//! They are detected from time at every tick (no frame for longer than the age limit), which
//! does not depend on this queue and cannot be lost here.
//!
//! **No waiting, no lock contention.** The relay only calls `try_send`, the control thread
//! only `try_recv`. The standard library's bounded channel takes a lock only to wake a
//! receiver blocked in `recv`; the control thread never blocks, so the two sides never
//! contend for a lock. The counters are atomics.
//!
//! Known limit, unchanged by this module: the relay reads frames through the engine's
//! `watch` channel, which keeps only the newest frame. A state that lasts shorter than the
//! relay takes to wake up (milliseconds) is invisible to everything downstream; the plugin
//! itself sends at most one frame per 16 ms.

use super::freshness::FrameDigest;
use super::vehicle::InvalidFrame;
use roadpilot_telemetry_client::GameId;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering::SeqCst};
use std::sync::mpsc::{Receiver, SyncSender, TryRecvError, TrySendError, sync_channel};
use std::time::Instant;

/// Places in the queue, and the most items the control thread takes per tick.
pub const CAPACITY: usize = 16;
/// Places ordinary frames may occupy; the rest is reserved for critical items.
pub const NORMAL_QUOTA: usize = 12;

/// What the relay hands to the control loop.
// Fixed size on purpose: boxing the digest (as clippy suggests for the size difference) would
// allocate per frame, which the mailbox exists to avoid.
#[allow(clippy::large_enum_variant)]
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Delivery {
    Frame {
        digest: FrameDigest,
        /// When the relay saw the frame.
        observed_at: Instant,
    },
    /// The engine's frame channel was lost or replaced.
    FeedLost(Instant),
    FeedRestored(Instant),
}

/// What the control loop takes out, in order.
#[allow(clippy::large_enum_variant)] // see Delivery
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Received {
    /// `count` items were dropped at this point of the sequence.
    Lost {
        count: u64,
    },
    Delivery(Delivery),
}

/// What happened to one item.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum SendOutcome {
    Queued {
        critical: bool,
    },
    Dropped {
        critical: bool,
    },
    /// The control loop is gone.
    Closed,
}

#[derive(Clone, Copy, Debug)]
struct Item {
    delivery: Delivery,
    critical: bool,
    /// Items dropped before this one was sent (cumulative).
    dropped_before: u64,
}

#[derive(Debug, Default)]
struct Shared {
    /// Ordinary frames sent and not yet taken. Raised only by the sender, lowered only by the
    /// receiver.
    normal_queued: AtomicUsize,
    /// Items dropped so far (cumulative), and how many of them were critical.
    dropped: AtomicU64,
    critical_dropped: AtomicU64,
}

/// The condition of a frame; a change of it makes the frame critical.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
struct Condition {
    stream: Option<(GameId, u64)>,
    paused: bool,
    invalid: Option<InvalidFrame>,
}

impl Condition {
    fn of(digest: &FrameDigest) -> Self {
        let (stream, invalid) = match digest.identity {
            Ok(id) => (
                Some((id.game, id.session)),
                match digest.state {
                    Some(Err(reason)) => Some(reason),
                    Some(Ok(_)) => digest.clock_problem(),
                    None => None,
                },
            ),
            Err(reason) => (None, Some(reason)),
        };
        Self {
            stream,
            paused: digest.paused,
            invalid,
        }
    }
}

/// A new, empty mailbox.
pub fn mailbox() -> (MailboxSender, MailboxReceiver) {
    let (tx, rx) = sync_channel(CAPACITY);
    let shared = Arc::new(Shared::default());
    (
        MailboxSender {
            tx,
            shared: shared.clone(),
            last: None,
            closed: false,
        },
        MailboxReceiver {
            rx,
            shared,
            reported: 0,
        },
    )
}

/// The relay's side. Never blocks.
#[derive(Debug)]
pub struct MailboxSender {
    tx: SyncSender<Item>,
    shared: Arc<Shared>,
    /// Condition of the previous frame offered.
    last: Option<Condition>,
    closed: bool,
}

impl MailboxSender {
    /// Offers the digest of the next frame the relay saw.
    pub fn send_frame(&mut self, digest: FrameDigest, observed_at: Instant) -> SendOutcome {
        let condition = Condition::of(&digest);
        let critical = self.last != Some(condition);
        self.last = Some(condition);
        self.send(
            Delivery::Frame {
                digest,
                observed_at,
            },
            critical,
        )
    }

    pub fn send_feed_lost(&mut self, at: Instant) -> SendOutcome {
        self.send(Delivery::FeedLost(at), true)
    }

    pub fn send_feed_restored(&mut self, at: Instant) -> SendOutcome {
        self.send(Delivery::FeedRestored(at), true)
    }

    /// True once a send found the control loop gone.
    pub fn is_closed(&self) -> bool {
        self.closed
    }

    fn send(&mut self, delivery: Delivery, critical: bool) -> SendOutcome {
        if self.closed {
            return SendOutcome::Closed;
        }
        let shared = &self.shared;
        if !critical {
            if shared.normal_queued.load(SeqCst) >= NORMAL_QUOTA {
                return self.drop_item(false);
            }
            shared.normal_queued.fetch_add(1, SeqCst);
        }
        let item = Item {
            delivery,
            critical,
            dropped_before: shared.dropped.load(SeqCst),
        };
        match self.tx.try_send(item) {
            Ok(()) => SendOutcome::Queued { critical },
            Err(TrySendError::Full(_)) => {
                if !critical {
                    shared.normal_queued.fetch_sub(1, SeqCst);
                }
                self.drop_item(critical)
            }
            Err(TrySendError::Disconnected(_)) => {
                if !critical {
                    shared.normal_queued.fetch_sub(1, SeqCst);
                }
                self.closed = true;
                SendOutcome::Closed
            }
        }
    }

    fn drop_item(&mut self, critical: bool) -> SendOutcome {
        self.shared.dropped.fetch_add(1, SeqCst);
        if critical {
            self.shared.critical_dropped.fetch_add(1, SeqCst);
        }
        SendOutcome::Dropped { critical }
    }
}

/// The control loop's side. Never blocks.
#[derive(Debug)]
pub struct MailboxReceiver {
    rx: Receiver<Item>,
    shared: Arc<Shared>,
    /// Losses already reported (cumulative).
    reported: u64,
}

impl MailboxReceiver {
    /// Hands at most [`CAPACITY`] items to `handle`, in send order, without waiting. A loss
    /// is reported as [`Received::Lost`] before the first item that follows it; a loss with
    /// no item after it is reported at the end, once the queue was found empty. Returns the
    /// number of items taken.
    pub fn drain(&mut self, mut handle: impl FnMut(Received)) -> usize {
        let mut taken = 0;
        let mut emptied = false;
        while taken < CAPACITY {
            match self.rx.try_recv() {
                Ok(item) => {
                    taken += 1;
                    if !item.critical {
                        self.shared.normal_queued.fetch_sub(1, SeqCst);
                    }
                    if item.dropped_before > self.reported {
                        handle(Received::Lost {
                            count: item.dropped_before - self.reported,
                        });
                        self.reported = item.dropped_before;
                    }
                    handle(Received::Delivery(item.delivery));
                }
                Err(TryRecvError::Empty | TryRecvError::Disconnected) => {
                    emptied = true;
                    break;
                }
            }
        }
        if emptied {
            let dropped = self.shared.dropped.load(SeqCst);
            if dropped > self.reported {
                handle(Received::Lost {
                    count: dropped - self.reported,
                });
                self.reported = dropped;
            }
        }
        taken
    }

    /// Items dropped so far, and how many of them were critical.
    pub fn dropped(&self) -> (u64, u64) {
        (
            self.shared.dropped.load(SeqCst),
            self.shared.critical_dropped.load(SeqCst),
        )
    }
}

#[cfg(test)]
mod tests {
    use super::super::freshness::FrameDigest;
    use super::super::vehicle::test_support::{paused_frame, running_frame};
    use super::*;
    use roadpilot_telemetry_client::{ReceivedTelemetryFrame, TelemetryFrame};
    use std::time::Duration;

    fn digest(frame: TelemetryFrame, at: Instant) -> FrameDigest {
        FrameDigest::of(&ReceivedTelemetryFrame {
            frame,
            dropped_fields: Vec::new(),
            received_at: at,
            received_qpc: crate::control::vehicle::test_support::RECEIVED_QPC,
        })
    }

    fn running(session: u64, seq: u64, at: Instant) -> FrameDigest {
        digest(running_frame(session, seq, seq * 16_667), at)
    }

    fn paused(session: u64, seq: u64, at: Instant) -> FrameDigest {
        digest(paused_frame(session, seq, seq * 16_667), at)
    }

    /// Sequence numbers (and losses) in drain order.
    fn drain_all(rx: &mut MailboxReceiver) -> Vec<String> {
        let mut out = Vec::new();
        rx.drain(|r| {
            out.push(match r {
                Received::Lost { count } => format!("lost {count}"),
                Received::Delivery(Delivery::Frame { digest, .. }) => {
                    let id = digest.identity.unwrap();
                    format!(
                        "{}{}:{}",
                        if digest.paused { "p" } else { "r" },
                        id.session,
                        id.sequence
                    )
                }
                Received::Delivery(Delivery::FeedLost(_)) => "feed lost".into(),
                Received::Delivery(Delivery::FeedRestored(_)) => "feed restored".into(),
            })
        });
        out
    }

    #[test]
    fn frames_arrive_in_order_and_only_changes_are_critical() {
        let (mut tx, mut rx) = mailbox();
        let t = Instant::now();
        let outcomes: Vec<SendOutcome> = [
            running(7, 1, t),
            running(7, 2, t),
            paused(7, 3, t),
            paused(7, 4, t),
            running(7, 5, t),
            running(9, 1, t),
        ]
        .into_iter()
        .map(|d| tx.send_frame(d, t))
        .collect();
        let critical: Vec<bool> = outcomes
            .iter()
            .map(|o| matches!(o, SendOutcome::Queued { critical: true }))
            .collect();
        // First frame, pause, resume and the new session are critical.
        assert_eq!(critical, [true, false, true, false, true, true]);
        assert_eq!(
            drain_all(&mut rx),
            ["r7:1", "r7:2", "p7:3", "p7:4", "r7:5", "r9:1"]
        );
    }

    #[test]
    fn ordinary_frames_are_capped_and_the_loss_is_reported() {
        let (mut tx, mut rx) = mailbox();
        let t = Instant::now();
        for seq in 1..=20 {
            tx.send_frame(running(7, seq, t), t);
        }
        // 1 critical (first) + 12 ordinary; 7 dropped.
        assert_eq!(rx.dropped(), (7, 0));
        let drained = drain_all(&mut rx);
        assert_eq!(drained.len(), 14, "{drained:?}");
        assert_eq!(drained.last().unwrap(), "lost 7");
        assert_eq!(drained[..13].last().unwrap(), "r7:13");
        // Nothing is reported twice.
        assert!(drain_all(&mut rx).is_empty());
    }

    #[test]
    fn critical_items_use_the_reserve_and_are_never_crowded_out_by_frames() {
        let (mut tx, mut rx) = mailbox();
        let t = Instant::now();
        // The first frame is critical; fill the ordinary quota.
        for seq in 1..=13 {
            tx.send_frame(running(7, seq, t), t);
        }
        // Ordinary frames beyond the quota are dropped...
        assert_eq!(
            tx.send_frame(running(7, 14, t), t),
            SendOutcome::Dropped { critical: false }
        );
        // ...but a pause is critical and uses the reserve.
        assert_eq!(
            tx.send_frame(paused(7, 15, t), t),
            SendOutcome::Queued { critical: true }
        );
        assert_eq!(tx.send_feed_lost(t), SendOutcome::Queued { critical: true });
        let drained = drain_all(&mut rx);
        let pause_at = drained.iter().position(|e| e == "p7:15").unwrap();
        // The loss of frame 14 is reported exactly where it happened: before the pause.
        assert_eq!(drained[pause_at - 1], "lost 1");
        assert_eq!(drained[pause_at - 2], "r7:13");
        assert_eq!(drained.last().unwrap(), "feed lost");
    }

    #[test]
    fn a_full_reserve_loses_critical_items_conservatively() {
        let (mut tx, mut rx) = mailbox();
        let t = Instant::now();
        for seq in 1..=13 {
            tx.send_frame(running(7, seq, t), t);
        }
        // 1 + 12 used; the reserve holds 3 more critical items, then the queue is full.
        for _ in 0..3 {
            assert_eq!(tx.send_feed_lost(t), SendOutcome::Queued { critical: true });
        }
        assert_eq!(
            tx.send_feed_restored(t),
            SendOutcome::Dropped { critical: true }
        );
        assert_eq!(rx.dropped(), (1, 1));
        // The first drain takes the 16 queued items (the cap); the loss follows them.
        assert_eq!(drain_all(&mut rx).len(), 16);
        assert_eq!(drain_all(&mut rx), ["lost 1"]);
    }

    #[test]
    fn at_most_capacity_items_are_taken_per_drain() {
        let (mut tx, mut rx) = mailbox();
        let t = Instant::now();
        // Alternating pause states: every frame is critical, so all 16 places fill.
        for seq in 1..=40 {
            let d = if seq % 2 == 0 {
                paused(7, seq, t)
            } else {
                running(7, seq, t)
            };
            tx.send_frame(d, t);
        }
        let mut count = 0;
        let taken = rx.drain(|_| count += 1);
        assert_eq!(taken, CAPACITY);
        // The drain stopped at the cap, not on an empty queue: the trailing loss of the 24
        // dropped items is reported by the next drain, not out of order.
        assert_eq!(count, CAPACITY);
        let rest = drain_all(&mut rx);
        assert_eq!(rest, ["lost 24"]);
    }

    #[test]
    fn simultaneous_pause_and_session_change_keep_their_order() {
        let (mut tx, mut rx) = mailbox();
        let t = Instant::now();
        tx.send_frame(running(7, 1, t), t);
        tx.send_frame(paused(7, 2, t), t);
        tx.send_frame(paused(9, 1, t), t);
        tx.send_frame(running(9, 2, t), t);
        assert_eq!(drain_all(&mut rx), ["r7:1", "p7:2", "p9:1", "r9:2"]);
    }

    #[test]
    fn a_stalled_control_thread_never_grows_the_queue() {
        // 500 ms without a drain at 60 Hz, then 10,000 more frames: the queue holds at most
        // CAPACITY items and every loss is counted.
        let (mut tx, mut rx) = mailbox();
        let t0 = Instant::now();
        let frames = 30 + 10_000;
        for seq in 1..=frames {
            let at = t0 + Duration::from_micros(seq * 16_667);
            tx.send_frame(running(7, seq, at), at);
        }
        let mut delivered = 0u64;
        let mut lost = 0u64;
        rx.drain(|r| match r {
            Received::Lost { count } => lost += count,
            Received::Delivery(_) => delivered += 1,
        });
        assert!(delivered <= CAPACITY as u64);
        assert_eq!(delivered + lost, frames);
    }

    #[test]
    fn a_closed_control_loop_is_reported() {
        let (mut tx, rx) = mailbox();
        drop(rx);
        let t = Instant::now();
        assert_eq!(tx.send_frame(running(7, 1, t), t), SendOutcome::Closed);
        assert!(tx.is_closed());
    }
}
