//! The output gate (Phase 4.6.4c, API hardened in 4.6.4d step 1): the component that will
//! become the sole owner and writer of the output port. **Not integrated yet**: nothing in the
//! application builds a gate, and the only ports that exist are [`DryRunPort`] and the test
//! fakes of this module. There is no pipe port; the module-level proof in `control/mod.rs`
//! scans this file like every other.
//!
//! The gate runs on a thread of its own, independent of the control loop. It does not use
//! tokio, the control log or the status mutex. It shares only atomics and one `try_lock`-only
//! slot with the rest of the program, none of them blocking the control loop:
//!
//! * the latch, one atomic word, and the supervisor mirror, another;
//! * the command slot, written by the single [`CommandWriter`] of the control loop;
//! * two heartbeats: the control loop's, read by the gate, and the gate's own, read by the
//!   control loop ([`GateLink::check_gate`]);
//! * the epoch the gate last saw open, from which [`GateLink::disarm_owed`] is derived.
//!
//! # Who may do what
//!
//! [`gate`] returns four parts, each with exactly the rights its owner needs:
//!
//! * [`GateLink`] (`Clone`): read the state, the mirror, the health and the statistics, and
//!   **cut**. It has no way to open. Status readers and the operator's disarm get this.
//! * [`GateOpener`] (neither `Clone` nor `Copy`, one per gate): [`GateOpener::prepare`],
//!   [`GateOpener::open`] and the supervisor mirror. Meant for the control core only; a test in
//!   `control/mod.rs` checks that no other source names it.
//! * [`CommandWriter`] (one per gate): the control loop's side of the command slot and its
//!   heartbeat.
//! * [`GateRunner`]: becomes the gate thread ([`GateRunner::spawn`]) or, in tests, a
//!   [`GateDriver`] stepped on an explicit clock.
//!
//! # Opening: ticket before the commands, proof from the supervisor
//!
//! 1. At the start of each processing step, **before** any command is processed, the core
//!    takes an [`ArmTicket`] with [`GateOpener::prepare`]. It records the latch generation of
//!    that moment.
//! 2. Only the supervisor's own transition Armed -> Active with `ManualActivate` creates a
//!    [`ManualArm`] proof; it has private fields, can be taken once and only while that
//!    activation is the current state, and it borrows the supervisor until it is used (see
//!    `supervisor`). A fault, a disarm, a reset or any other transition never yields one.
//! 3. [`GateOpener::open`] consumes the ticket and the proof and succeeds only by a
//!    compare-and-swap from exactly the closed generation of the ticket. Every cut advances
//!    the generation, so any cut since `prepare` (an operator disarm, a loop or gate failure)
//!    makes the open fail with [`OpenError::Stale`]: a late open can never override a cut.
//!
//! Taking the ticket first matters: a ticket taken *after* the activation would carry the
//! generation of a cut that happened in between and would then succeed.
//!
//! # The supervisor mirror: a consistency check, never a permission
//!
//! The opener publishes what the supervisor state is ([`GateOpener::publish_supervisor`]);
//! [`GateOpener::open`] itself sets it to `Active` with the epoch it is opening, before its
//! compare-and-swap, and restores the previous value if the open fails. The gate cuts an open
//! latch whose epoch the mirror does not confirm ([`CutReason::SupervisorMismatch`]). The
//! mirror can only ever close the gate: nothing opens because of it.
//!
//! # The command slot: why a `Mutex` with `try_lock` on both sides
//!
//! The hand-off from the control loop to the gate is a `std::sync::Mutex<Option<SlotEntry>>`
//! that **both sides only ever `try_lock`**. Compared alternatives (see the 4.6.4c report):
//!
//! * a seqlock over ordinary bytes: a data race by definition, undefined behaviour in Rust,
//!   explicitly forbidden;
//! * a seqlock whose data words are themselves atomics: free of data races, but the
//!   consistency of a read depends on subtle fence placement, and the reader may retry
//!   without bound;
//! * a triple buffer or another lock-free structure: needs `unsafe` (`UnsafeCell`) or a new
//!   dependency that contains it; `arc-swap` also allocates on every write;
//! * a bounded channel: delivers the *older* command first and cannot replace it;
//! * packing the command into one `AtomicU64`: loses precision of the protocol's `f32`s.
//!
//! The chosen slot contains no `unsafe` code, so the compiler proves it free of data races,
//! and the mutex makes every read see one whole entry written by one whole write: tearing is
//! impossible by construction. `try_lock` never waits (on Windows it is
//! `TryAcquireSRWLockExclusive`). Each critical section only moves a `Copy` value in or out of
//! an `Option`, so it cannot panic, allocate or block, and the lock is held for nanoseconds.
//!
//! * **The writer never blocks.** If the gate happens to hold the slot, the new command is
//!   dropped and counted ([`PublishOutcome::Busy`]). If an unread command is in the slot, the
//!   new one replaces it ([`PublishOutcome::Replaced`]): there is at most one command waiting,
//!   never a queue.
//! * **The gate never blocks either.** It takes the entry out (`Option::take`), so every
//!   command is seen at most once, and releases the lock **before** it writes to the port.
//! * **Poisoning** cannot occur (no panic is possible inside the lock). Should it ever be
//!   reported, both sides cut the latch ([`CutReason::SlotPoisoned`]).
//!
//! # The latch: one atomic word
//!
//! `generation << 8 | code`. Code 0 means open; every other code is the [`CutReason`] that
//! closed it. The generation counts every cut and every open. All operations are single loads
//! or compare-and-swap steps with `SeqCst`, so every cut and every open is one indivisible
//! step in one total order. A cut is callable from any thread at any time, never waits and
//! always advances the generation; on a closed latch it keeps the first reason.
//!
//! # What the gate does every period ([`GATE_PERIOD`])
//!
//! 1. Records its own liveness.
//! 2. Reads the latch. If it is open and the control loop's heartbeat is older than
//!    [`LOOP_SILENCE_LIMIT`], it cuts ([`CutReason::LoopSilent`]); if the mirror does not
//!    confirm the open epoch, it cuts ([`CutReason::SupervisorMismatch`]).
//! 3. If it had seen an epoch open that is no longer the open one, it writes **exactly one**
//!    disarm.
//! 4. Closed: it empties the slot, so nothing computed before the cut can be written later.
//! 5. Open: it records the open epoch as seen, takes the newest command, if any, and writes it
//!    only if it belongs to the open epoch, is not older than [`MAX_COMMAND_AGE`], and the
//!    latch is still exactly the state it checked (re-read just before the write). Right
//!    after the write it reads the latch again and writes the disarm at once if a cut arrived
//!    meanwhile.
//!
//! A cut that happens while a command is already being written is ordered after that write;
//! the disarm follows it in the same period. No command whose check comes after the cut is
//! written, and no command is ever written twice.
//!
//! # Disarm owed
//!
//! The gate records the epoch it saw open **before** it can write a command of it, and clears
//! it only **after** the disarm for it has been written. [`GateLink::disarm_owed`] is true
//! exactly while that epoch is recorded and is no longer the open one: from the cut until the
//! disarm write has returned. It reads the latch first and the recorded epoch second, so it
//! can report a disarm as owed a moment too long, never too short.
//!
//! # Timing
//!
//! The limits are central constants. The gate sleeps until its next deadline with
//! `std::thread::sleep`, which on Windows uses a high-resolution waitable timer (see `timer`);
//! a start hook lets the application raise the gate thread's priority, as for the control
//! thread. The reaction is *bounded by the checks*, not real-time: no reaction time is
//! guaranteed on Windows.

use super::command::ControlCommand;
use super::protocol::{MESSAGE_LEN, WireMessage, encode};
use super::sink::{Delivery, OperatingMode};
use super::supervisor::{ManualArm, State};
use super::watchdog::Heartbeat;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering::SeqCst};
use std::sync::mpsc::{self, RecvTimeoutError};
use std::sync::{Arc, Mutex, TryLockError};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

/// A control loop heartbeat older than this cuts an open latch.
pub const LOOP_SILENCE_LIMIT: Duration = Duration::from_millis(100);
/// How often the gate checks (a lower bound: see "Timing" in the module documentation).
pub const GATE_PERIOD: Duration = Duration::from_millis(10);
/// A command older than this when the gate looks at it is discarded.
pub const MAX_COMMAND_AGE: Duration = Duration::from_millis(50);
/// A gate whose own heartbeat is older than this has failed ([`GateLink::check_gate`]).
pub const GATE_SILENCE_LIMIT: Duration = Duration::from_millis(100);

// ---- latch ----

/// Why the latch is closed. Stored as the low byte of the latch word; 0 means open.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
#[repr(u8)]
pub enum CutReason {
    /// Never opened since the gate was created.
    Initial = 1,
    ManualDisarm = 2,
    /// The supervisor left Active (fault, safety event).
    SupervisorFault = 3,
    /// The gate saw no control loop heartbeat for longer than [`LOOP_SILENCE_LIMIT`].
    LoopSilent = 4,
    /// The gate was stopped (shutdown).
    Shutdown = 5,
    /// The command slot reported a poisoned lock.
    SlotPoisoned = 6,
    /// The control loop found the gate silent or not running.
    GateFailed = 7,
    /// The gate thread ended without being stopped (a panic in the port).
    GateEnded = 8,
    /// The latch was open with an epoch the supervisor mirror did not confirm.
    SupervisorMismatch = 9,
}

impl CutReason {
    fn from_code(code: u64) -> Self {
        match code {
            2 => Self::ManualDisarm,
            3 => Self::SupervisorFault,
            4 => Self::LoopSilent,
            5 => Self::Shutdown,
            6 => Self::SlotPoisoned,
            7 => Self::GateFailed,
            8 => Self::GateEnded,
            9 => Self::SupervisorMismatch,
            // 1, and anything that cannot occur: closed.
            _ => Self::Initial,
        }
    }
}

const OPEN_CODE: u64 = 0;
const CODE_BITS: u32 = 8;
const CODE_MASK: u64 = (1 << CODE_BITS) - 1;
/// The largest generation. Reaching it (after 2^56 cuts and opens) leaves the latch closed
/// for good.
const MAX_GENERATION: u64 = u64::MAX >> CODE_BITS;

fn word(generation: u64, code: u64) -> u64 {
    (generation << CODE_BITS) | code
}

/// What the latch says at one instant.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum LatchState {
    /// Output is permitted for commands of `epoch`.
    Open {
        epoch: u64,
    },
    Closed {
        generation: u64,
        reason: CutReason,
    },
}

impl LatchState {
    fn of(w: u64) -> Self {
        let generation = w >> CODE_BITS;
        match w & CODE_MASK {
            OPEN_CODE => Self::Open { epoch: generation },
            code => Self::Closed {
                generation,
                reason: CutReason::from_code(code),
            },
        }
    }

    pub fn is_open(&self) -> bool {
        matches!(self, Self::Open { .. })
    }
}

/// What a cut did.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum CutOutcome {
    /// The latch was open with `epoch` and is now closed.
    Closed { epoch: u64 },
    /// The latch was already closed; its reason is kept, its generation advanced.
    AlreadyClosed,
}

/// The cut latch. Private: [`GateLink`] may cut it, only [`GateOpener`] may open it.
#[derive(Debug)]
struct GateLatch {
    word: AtomicU64,
}

impl GateLatch {
    fn new() -> Self {
        Self {
            word: AtomicU64::new(word(0, CutReason::Initial as u64)),
        }
    }

    fn state(&self) -> LatchState {
        LatchState::of(self.raw())
    }

    fn raw(&self) -> u64 {
        self.word.load(SeqCst)
    }

    /// Closes the latch (or keeps it closed) and advances the generation. Never waits beyond
    /// a compare-and-swap retry when another thread changed the word at the same moment.
    fn cut(&self, reason: CutReason) -> CutOutcome {
        let mut current = self.word.load(SeqCst);
        loop {
            let generation = current >> CODE_BITS;
            let next_generation = (generation + 1).min(MAX_GENERATION);
            let (next, outcome) = match current & CODE_MASK {
                OPEN_CODE => (
                    word(next_generation, reason as u64),
                    CutOutcome::Closed { epoch: generation },
                ),
                code => (word(next_generation, code), CutOutcome::AlreadyClosed),
            };
            match self
                .word
                .compare_exchange_weak(current, next, SeqCst, SeqCst)
            {
                Ok(_) => return outcome,
                Err(seen) => current = seen,
            }
        }
    }
}

/// Permission to open the latch once, valid only while no cut or open happened since
/// [`GateOpener::prepare`] issued it. Neither `Clone` nor `Copy`, and its field is private:
/// [`GateOpener::open`] consumes it.
#[derive(Debug, Eq, PartialEq)]
pub struct ArmTicket {
    generation: u64,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum PrepareError {
    /// The latch is open; it must be cut before a new arm sequence.
    AlreadyOpen,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum OpenError {
    /// A cut or another open happened since the ticket was prepared (a late open).
    Stale,
    /// The generation counter is exhausted; the latch stays closed for good.
    Exhausted,
}

// ---- supervisor mirror ----

/// What the control core says the supervisor state is. A consistency check for the gate, never
/// a permission: see the module documentation.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum MirrorState {
    Disabled,
    Armed,
    /// Active, confirmed for the open epoch by [`GateOpener::open`].
    Active {
        epoch: u64,
    },
    /// Published as Active without an open of this gate: confirms no epoch.
    ActiveUnconfirmed,
    Fault,
}

const MIRROR_DISABLED: u64 = 1;
const MIRROR_ARMED: u64 = 2;
const MIRROR_ACTIVE: u64 = 3;
const MIRROR_ACTIVE_UNCONFIRMED: u64 = 4;
const MIRROR_FAULT: u64 = 5;

impl MirrorState {
    fn word(self) -> u64 {
        match self {
            Self::Disabled => MIRROR_DISABLED,
            Self::Armed => MIRROR_ARMED,
            Self::Active { epoch } => word(epoch, MIRROR_ACTIVE),
            Self::ActiveUnconfirmed => MIRROR_ACTIVE_UNCONFIRMED,
            Self::Fault => MIRROR_FAULT,
        }
    }

    fn of(w: u64) -> Self {
        match w & CODE_MASK {
            MIRROR_ACTIVE => Self::Active {
                epoch: w >> CODE_BITS,
            },
            MIRROR_ARMED => Self::Armed,
            MIRROR_ACTIVE_UNCONFIRMED => Self::ActiveUnconfirmed,
            MIRROR_FAULT => Self::Fault,
            // Disabled, and anything that cannot occur: confirms nothing.
            _ => Self::Disabled,
        }
    }
}

// ---- port ----

mod sealed {
    pub trait Sealed {}
}

/// Where the gate writes. Sealed: only [`DryRunPort`] and the test fakes of this module
/// implement it. A port that transmits anything does not exist in this phase.
pub trait OutputPort: sealed::Sealed + Send + 'static {
    fn mode(&self) -> OperatingMode;
    fn write(&mut self, message: &[u8; MESSAGE_LEN]) -> Delivery;
}

/// Discards every message and reports truthfully that nothing was transmitted.
#[derive(Debug, Default)]
pub struct DryRunPort;

impl sealed::Sealed for DryRunPort {}

impl OutputPort for DryRunPort {
    fn mode(&self) -> OperatingMode {
        OperatingMode::DryRun
    }

    fn write(&mut self, _message: &[u8; MESSAGE_LEN]) -> Delivery {
        Delivery::NotTransmitted
    }
}

// ---- command slot ----

/// A command as the control loop hands it to the gate.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct GateCommand {
    pub command: ControlCommand,
    /// The latch epoch the command was computed for (the value [`GateOpener::open`] returned).
    pub epoch: u64,
    /// When the control loop computed it.
    pub computed_at: Instant,
}

#[derive(Clone, Copy, Debug, PartialEq)]
struct SlotEntry {
    command: GateCommand,
    /// 1 for the first command the writer published; strictly increasing.
    sequence: u64,
}

/// What happened to a published command.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum PublishOutcome {
    /// The slot was empty and now holds the command.
    Stored,
    /// An unread command was replaced by this newer one.
    Replaced,
    /// The gate held the slot at this instant; the command was dropped, nothing waited.
    Busy,
    /// The slot is unusable; the latch was cut.
    Poisoned,
}

#[derive(Clone, Copy, Debug, PartialEq)]
enum SlotRead {
    Entry(SlotEntry),
    Empty,
    Busy,
    Poisoned,
}

// ---- shared state ----

#[derive(Debug, Default)]
struct Counters {
    steps: AtomicU64,
    commands_written: AtomicU64,
    disarms_written: AtomicU64,
    discarded_stale: AtomicU64,
    discarded_epoch: AtomicU64,
    discarded_closed: AtomicU64,
    discarded_cut: AtomicU64,
    replaced: AtomicU64,
    publish_busy: AtomicU64,
    read_busy: AtomicU64,
    loop_silence_cuts: AtomicU64,
    mismatch_cuts: AtomicU64,
}

/// Counters of the gate, for diagnostics and tests. Never used for a decision.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct GateStats {
    /// Gate periods run.
    pub steps: u64,
    pub commands_written: u64,
    pub disarms_written: u64,
    /// Older than [`MAX_COMMAND_AGE`] when the gate looked at it.
    pub discarded_stale: u64,
    /// Computed for another epoch than the open one.
    pub discarded_epoch: u64,
    /// Found in the slot while the latch was closed.
    pub discarded_closed: u64,
    /// The latch changed between the checks and the write.
    pub discarded_cut: u64,
    /// Unread commands replaced by a newer one.
    pub replaced: u64,
    /// Commands the writer dropped because the gate held the slot.
    pub publish_busy: u64,
    /// Periods in which the gate found the slot held by the writer.
    pub read_busy: u64,
    pub loop_silence_cuts: u64,
    /// Cuts because the mirror did not confirm the open epoch.
    pub mismatch_cuts: u64,
}

#[derive(Debug)]
struct Shared {
    latch: GateLatch,
    mirror: AtomicU64,
    slot: Mutex<Option<SlotEntry>>,
    /// Beaten by the control loop through its [`CommandWriter`].
    loop_heartbeat: Heartbeat,
    /// Beaten by every gate step, and by nothing else.
    gate_alive: Heartbeat,
    /// The open epoch the gate saw and has not written the disarm for; 0 for none. Written
    /// only by the gate. Epochs start at 1.
    seen_epoch: AtomicU64,
    /// True while a gate thread or driver runs.
    running: AtomicBool,
    stop: AtomicBool,
    /// What the start hook of the gate thread reported.
    elevated: AtomicBool,
    counters: Counters,
}

impl Shared {
    fn take(&self) -> SlotRead {
        match self.slot.try_lock() {
            Ok(mut slot) => match slot.take() {
                Some(entry) => SlotRead::Entry(entry),
                None => SlotRead::Empty,
            },
            Err(TryLockError::WouldBlock) => SlotRead::Busy,
            Err(TryLockError::Poisoned(_)) => SlotRead::Poisoned,
        }
    }

    fn mirror(&self) -> MirrorState {
        MirrorState::of(self.mirror.load(SeqCst))
    }

    fn stats(&self) -> GateStats {
        let c = &self.counters;
        GateStats {
            steps: c.steps.load(SeqCst),
            commands_written: c.commands_written.load(SeqCst),
            disarms_written: c.disarms_written.load(SeqCst),
            discarded_stale: c.discarded_stale.load(SeqCst),
            discarded_epoch: c.discarded_epoch.load(SeqCst),
            discarded_closed: c.discarded_closed.load(SeqCst),
            discarded_cut: c.discarded_cut.load(SeqCst),
            replaced: c.replaced.load(SeqCst),
            publish_busy: c.publish_busy.load(SeqCst),
            read_busy: c.read_busy.load(SeqCst),
            loop_silence_cuts: c.loop_silence_cuts.load(SeqCst),
            mismatch_cuts: c.mismatch_cuts.load(SeqCst),
        }
    }
}

/// The parts of one gate. See "Who may do what" in the module documentation.
#[derive(Debug)]
pub struct GateParts {
    pub link: GateLink,
    pub opener: GateOpener,
    pub writer: CommandWriter,
    pub runner: GateRunner,
}

/// A new, closed gate. `start` is the origin of both heartbeats: a control loop or a gate
/// that never runs is detected like one that stops.
pub fn gate(start: Instant) -> GateParts {
    let shared = Arc::new(Shared {
        latch: GateLatch::new(),
        mirror: AtomicU64::new(MirrorState::Disabled.word()),
        slot: Mutex::new(None),
        loop_heartbeat: Heartbeat::new(start),
        gate_alive: Heartbeat::new(start),
        seen_epoch: AtomicU64::new(0),
        running: AtomicBool::new(false),
        stop: AtomicBool::new(false),
        elevated: AtomicBool::new(false),
        counters: Counters::default(),
    });
    GateParts {
        link: GateLink {
            shared: shared.clone(),
        },
        opener: GateOpener {
            shared: shared.clone(),
        },
        writer: CommandWriter {
            shared: shared.clone(),
            sequence: 0,
        },
        runner: GateRunner { shared },
    }
}

// ---- control core side ----

/// The only way to open the gate. Neither `Clone` nor `Copy`; meant for the control core
/// alone (checked in `control/mod.rs`). Never waits.
#[derive(Debug)]
pub struct GateOpener {
    shared: Arc<Shared>,
}

impl GateOpener {
    /// The ticket for this processing step. Take it at the start of the step, before any
    /// command is processed.
    pub fn prepare(&self) -> Result<ArmTicket, PrepareError> {
        match self.shared.latch.state() {
            LatchState::Open { .. } => Err(PrepareError::AlreadyOpen),
            LatchState::Closed { generation, .. } => Ok(ArmTicket { generation }),
        }
    }

    /// Opens the latch if nothing happened since [`GateOpener::prepare`] issued `ticket`, on
    /// the proof of the supervisor's manual activation. Returns the open epoch, which every
    /// command for this activation must carry. Sets the mirror to `Active` for that epoch
    /// first, and restores it if the open fails.
    pub fn open(&self, ticket: ArmTicket, _proof: ManualArm<'_>) -> Result<u64, OpenError> {
        let shared = &*self.shared;
        let epoch = ticket.generation + 1;
        if epoch >= MAX_GENERATION {
            return Err(OpenError::Exhausted);
        }
        let closed = shared.latch.raw();
        if closed >> CODE_BITS != ticket.generation || closed & CODE_MASK == OPEN_CODE {
            return Err(OpenError::Stale);
        }
        let previous = shared
            .mirror
            .swap(MirrorState::Active { epoch }.word(), SeqCst);
        match shared
            .latch
            .word
            .compare_exchange(closed, word(epoch, OPEN_CODE), SeqCst, SeqCst)
        {
            Ok(_) => Ok(epoch),
            Err(_) => {
                shared.mirror.store(previous, SeqCst);
                Err(OpenError::Stale)
            }
        }
    }

    /// Publishes the supervisor state to the mirror. Active can be confirmed only by
    /// [`GateOpener::open`]: published here, it becomes [`MirrorState::ActiveUnconfirmed`],
    /// which makes the gate cut an open latch.
    pub fn publish_supervisor(&self, state: State) {
        let mirror = match state {
            State::Disabled => MirrorState::Disabled,
            State::Armed => MirrorState::Armed,
            State::Active => MirrorState::ActiveUnconfirmed,
            State::Fault => MirrorState::Fault,
        };
        self.shared.mirror.store(mirror.word(), SeqCst);
    }
}

/// The control loop's side of the slot. Neither `Clone` nor `Copy`: there is exactly one
/// writer. Never blocks.
#[derive(Debug)]
pub struct CommandWriter {
    shared: Arc<Shared>,
    sequence: u64,
}

impl CommandWriter {
    /// Hands the newest command to the gate. Never waits: see [`PublishOutcome`].
    pub fn publish(&mut self, command: GateCommand) -> PublishOutcome {
        let shared = &self.shared;
        match shared.slot.try_lock() {
            Ok(mut slot) => {
                self.sequence += 1;
                let previous = slot.replace(SlotEntry {
                    command,
                    sequence: self.sequence,
                });
                drop(slot);
                if previous.is_some() {
                    shared.counters.replaced.fetch_add(1, SeqCst);
                    PublishOutcome::Replaced
                } else {
                    PublishOutcome::Stored
                }
            }
            Err(TryLockError::WouldBlock) => {
                shared.counters.publish_busy.fetch_add(1, SeqCst);
                PublishOutcome::Busy
            }
            Err(TryLockError::Poisoned(_)) => {
                shared.latch.cut(CutReason::SlotPoisoned);
                PublishOutcome::Poisoned
            }
        }
    }

    /// The control loop's heartbeat, which the gate observes.
    pub fn beat(&self, now: Instant) {
        self.shared.loop_heartbeat.beat(now);
    }
}

// ---- shared read-and-cut access ----

/// Why the control loop considers the gate failed.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum GateFailure {
    /// No gate thread or driver runs (never started, stopped, or ended).
    NotRunning,
    /// The gate ran no step for longer than [`GATE_SILENCE_LIMIT`].
    Silent { silent_for: Duration },
}

/// What the gate's output stands at.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum GateOutput {
    /// The gate has seen no open epoch since its last disarm: nothing can have been written
    /// that needs one.
    Idle,
    /// The gate has seen `epoch` open and it still is.
    Open { epoch: u64 },
    /// `epoch` was cut and its disarm has not been written yet.
    DisarmOwed { epoch: u64 },
}

/// Read access to the gate and the right to cut it. Cheap to clone; every method is a few
/// atomic operations and never waits. **It cannot open the gate.**
#[derive(Clone, Debug)]
pub struct GateLink {
    shared: Arc<Shared>,
}

impl GateLink {
    pub fn state(&self) -> LatchState {
        self.shared.latch.state()
    }

    pub fn cut(&self, reason: CutReason) -> CutOutcome {
        self.shared.latch.cut(reason)
    }

    pub fn mirror(&self) -> MirrorState {
        self.shared.mirror()
    }

    /// For the control loop: is the gate alive? A failure cuts the latch (fail-closed); the
    /// caller must also leave Active. A dead gate writes no disarm: the input plugin's own
    /// timeout is then the last line of defence.
    pub fn check_gate(&self, now: Instant) -> Result<(), GateFailure> {
        let shared = &self.shared;
        let failure = if !shared.running.load(SeqCst) {
            Some(GateFailure::NotRunning)
        } else {
            let silent_for = shared.gate_alive.silent_for(now);
            (silent_for > GATE_SILENCE_LIMIT).then_some(GateFailure::Silent { silent_for })
        };
        match failure {
            Some(failure) => {
                shared.latch.cut(CutReason::GateFailed);
                Err(failure)
            }
            None => Ok(()),
        }
    }

    /// How long the gate has run no step.
    pub fn gate_silent_for(&self, now: Instant) -> Duration {
        self.shared.gate_alive.silent_for(now)
    }

    pub fn is_running(&self) -> bool {
        self.shared.running.load(SeqCst)
    }

    /// What the start hook of the gate thread reported (raised priority).
    pub fn elevated(&self) -> bool {
        self.shared.elevated.load(SeqCst)
    }

    /// See "Disarm owed" in the module documentation.
    pub fn output(&self) -> GateOutput {
        // The latch first, the seen epoch second: never reports too little.
        let latch = self.shared.latch.state();
        match self.shared.seen_epoch.load(SeqCst) {
            0 => GateOutput::Idle,
            epoch if latch == (LatchState::Open { epoch }) => GateOutput::Open { epoch },
            epoch => GateOutput::DisarmOwed { epoch },
        }
    }

    /// True from a cut of an epoch the gate has seen open until its disarm write returned.
    pub fn disarm_owed(&self) -> bool {
        matches!(self.output(), GateOutput::DisarmOwed { .. })
    }

    pub fn stats(&self) -> GateStats {
        self.shared.stats()
    }
}

// ---- gate side ----

/// What one gate step did.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct StepReport {
    pub command_written: bool,
    pub disarm_written: bool,
    /// The step cut the latch because the control loop was silent.
    pub cut_loop_silent: bool,
    /// The step cut the latch because the mirror did not confirm the open epoch.
    pub cut_mismatch: bool,
}

/// The gate's logic. Becomes the gate thread ([`GateRunner::spawn`]) or a [`GateDriver`]
/// stepped on an explicit clock ([`GateRunner::drive`]).
#[derive(Debug)]
pub struct GateRunner {
    shared: Arc<Shared>,
}

impl GateRunner {
    /// One gate period at `now`. See the module documentation for the order.
    fn step<P: OutputPort>(&mut self, now: Instant, port: &mut P) -> StepReport {
        let shared = &*self.shared;
        let counters = &shared.counters;
        shared.gate_alive.beat(now);
        counters.steps.fetch_add(1, SeqCst);
        let mut report = StepReport::default();

        let mut raw = shared.latch.raw();
        if let LatchState::Open { epoch } = LatchState::of(raw) {
            if shared.loop_heartbeat.silent_for(now) > LOOP_SILENCE_LIMIT {
                shared.latch.cut(CutReason::LoopSilent);
                counters.loop_silence_cuts.fetch_add(1, SeqCst);
                report.cut_loop_silent = true;
            } else if shared.mirror() != (MirrorState::Active { epoch }) {
                shared.latch.cut(CutReason::SupervisorMismatch);
                counters.mismatch_cuts.fetch_add(1, SeqCst);
                report.cut_mismatch = true;
            }
            raw = shared.latch.raw();
        }
        Self::settle(shared, LatchState::of(raw), port, &mut report);

        let epoch = match LatchState::of(raw) {
            LatchState::Closed { .. } => {
                // Nothing computed before the cut may be written later.
                match shared.take() {
                    SlotRead::Entry(_) => {
                        counters.discarded_closed.fetch_add(1, SeqCst);
                    }
                    SlotRead::Poisoned => {
                        shared.latch.cut(CutReason::SlotPoisoned);
                    }
                    SlotRead::Empty | SlotRead::Busy => {}
                }
                return report;
            }
            LatchState::Open { epoch } => epoch,
        };
        // Recorded before any command of this epoch can be written.
        shared.seen_epoch.store(epoch, SeqCst);

        let entry = match shared.take() {
            SlotRead::Entry(entry) => entry,
            SlotRead::Empty => return report,
            SlotRead::Busy => {
                counters.read_busy.fetch_add(1, SeqCst);
                return report;
            }
            SlotRead::Poisoned => {
                shared.latch.cut(CutReason::SlotPoisoned);
                Self::settle(shared, shared.latch.state(), port, &mut report);
                return report;
            }
        };
        let command = entry.command;
        if command.epoch != epoch {
            counters.discarded_epoch.fetch_add(1, SeqCst);
            return report;
        }
        if now.saturating_duration_since(command.computed_at) > MAX_COMMAND_AGE {
            counters.discarded_stale.fetch_add(1, SeqCst);
            return report;
        }
        // The last check, immediately before the write: exactly the state checked above.
        if shared.latch.raw() != raw {
            counters.discarded_cut.fetch_add(1, SeqCst);
            Self::settle(shared, shared.latch.state(), port, &mut report);
            return report;
        }
        let bytes = encode(&WireMessage::Command(command.command));
        match port.write(&bytes) {
            Delivery::NotTransmitted => {}
        }
        counters.commands_written.fetch_add(1, SeqCst);
        report.command_written = true;
        // A cut that arrived during the write is answered at once.
        Self::settle(shared, shared.latch.state(), port, &mut report);
        report
    }

    /// Writes the owed disarm, once, if the open epoch the gate saw is no longer open. The
    /// seen epoch is cleared only after the write has returned.
    fn settle<P: OutputPort>(
        shared: &Shared,
        state: LatchState,
        port: &mut P,
        report: &mut StepReport,
    ) {
        let seen = shared.seen_epoch.load(SeqCst);
        if seen == 0 || state == (LatchState::Open { epoch: seen }) {
            return;
        }
        let bytes = encode(&WireMessage::Disarm);
        match port.write(&bytes) {
            Delivery::NotTransmitted => {}
        }
        shared.seen_epoch.store(0, SeqCst);
        shared.counters.disarms_written.fetch_add(1, SeqCst);
        report.disarm_written = true;
    }

    /// A gate stepped by its owner on an explicit clock instead of a thread: for tests on a
    /// virtual (for example paused) clock, whose times a real gate thread would not share.
    /// Counts as running until it is finished or dropped.
    pub fn drive<P: OutputPort>(self, port: P) -> GateDriver<P> {
        self.shared.running.store(true, SeqCst);
        GateDriver {
            runner: self,
            port,
            finished: false,
        }
    }

    /// Starts the gate thread. `on_start` runs first on that thread (the application raises
    /// its priority there) and its result is reported by [`GateLink::elevated`]. The thread
    /// runs a step every [`GATE_PERIOD`] (at least) until [`GateHandle::stop`]; then it cuts
    /// the latch, writes the owed disarm and ends.
    pub fn spawn<P, F>(self, port: P, on_start: F) -> std::io::Result<GateHandle>
    where
        P: OutputPort,
        F: FnOnce() -> bool + Send + 'static,
    {
        let shared = self.shared.clone();
        let (done_tx, done_rx) = mpsc::channel();
        shared.running.store(true, SeqCst);
        let spawned = thread::Builder::new()
            .name("roadpilot-gate".into())
            .spawn(move || run_gate(self, port, on_start, done_tx));
        match spawned {
            Ok(thread) => Ok(GateHandle {
                shared,
                thread: Some(thread),
                done: done_rx,
            }),
            Err(error) => {
                shared.running.store(false, SeqCst);
                Err(error)
            }
        }
    }
}

/// A gate stepped on an explicit clock ([`GateRunner::drive`]). Exactly the gate thread's
/// logic, without the thread.
#[derive(Debug)]
pub struct GateDriver<P: OutputPort> {
    runner: GateRunner,
    port: P,
    finished: bool,
}

impl<P: OutputPort> GateDriver<P> {
    /// One gate period at `now`.
    pub fn step(&mut self, now: Instant) -> StepReport {
        self.runner.step(now, &mut self.port)
    }

    pub fn port(&self) -> &P {
        &self.port
    }

    /// Ends the gate as [`GateHandle::stop`] does: cuts the latch, writes the owed disarm.
    pub fn finish(mut self, now: Instant) -> StepReport {
        self.finished = true;
        let shared = self.runner.shared.clone();
        shared.stop.store(true, SeqCst);
        shared.latch.cut(CutReason::Shutdown);
        self.step(now)
    }
}

impl<P: OutputPort> Drop for GateDriver<P> {
    /// Like the end of the gate thread: no longer running, and an end that was not asked
    /// for cuts the latch.
    fn drop(&mut self) {
        let shared = &self.runner.shared;
        if !self.finished {
            shared.latch.cut(CutReason::GateEnded);
        }
        shared.running.store(false, SeqCst);
    }
}

/// Marks the gate as no longer running when its thread ends, however it ends. An end that was
/// not asked for (a panic in the port) cuts the latch.
struct RunningGuard {
    shared: Arc<Shared>,
    done: mpsc::Sender<()>,
}

impl Drop for RunningGuard {
    fn drop(&mut self) {
        if !self.shared.stop.load(SeqCst) {
            self.shared.latch.cut(CutReason::GateEnded);
        }
        self.shared.running.store(false, SeqCst);
        let _ = self.done.send(());
    }
}

fn run_gate<P, F>(mut runner: GateRunner, mut port: P, on_start: F, done: mpsc::Sender<()>)
where
    P: OutputPort,
    F: FnOnce() -> bool,
{
    let _guard = RunningGuard {
        shared: runner.shared.clone(),
        done,
    };
    runner.shared.elevated.store(on_start(), SeqCst);
    let mut next = Instant::now();
    while !runner.shared.stop.load(SeqCst) {
        runner.step(Instant::now(), &mut port);
        // A fixed grid; a late step is not caught up with a burst.
        next += GATE_PERIOD;
        let now = Instant::now();
        if next > now {
            thread::sleep(next - now);
        } else {
            next = now;
        }
    }
    // The latch was cut by `stop`; this step writes the owed disarm.
    runner.step(Instant::now(), &mut port);
}

/// The running gate thread.
#[derive(Debug)]
pub struct GateHandle {
    shared: Arc<Shared>,
    thread: Option<JoinHandle<()>>,
    done: mpsc::Receiver<()>,
}

/// The gate did not end within the time given to [`GateHandle::stop`] (its port blocks). The
/// handle is returned so the caller can wait again; the latch is cut either way.
#[derive(Debug)]
pub struct StopTimeout(pub GateHandle);

impl GateHandle {
    /// Cuts the latch, asks the gate to end, and waits at most `timeout` for it. The gate
    /// writes the owed disarm before it ends; it notices the request within one period.
    pub fn stop(mut self, timeout: Duration) -> Result<(), StopTimeout> {
        self.request_stop();
        match self.done.recv_timeout(timeout) {
            Ok(()) | Err(RecvTimeoutError::Disconnected) => {
                if let Some(thread) = self.thread.take() {
                    // The thread has signalled its end; joining cannot wait for long.
                    let _ = thread.join();
                }
                Ok(())
            }
            Err(RecvTimeoutError::Timeout) => Err(StopTimeout(self)),
        }
    }

    fn request_stop(&self) {
        self.shared.latch.cut(CutReason::Shutdown);
        self.shared.stop.store(true, SeqCst);
    }
}

impl Drop for GateHandle {
    /// A handle dropped without `stop`: the latch is cut and the gate asked to end, without
    /// waiting for it.
    fn drop(&mut self) {
        if self.thread.is_some() {
            self.request_stop();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::super::command::ControlLimits;
    use super::super::supervisor::Supervisor;
    use super::super::supervisor::test_support::activated;
    use super::*;
    use std::collections::HashMap;
    use std::sync::Barrier;
    use std::sync::atomic::AtomicUsize;

    fn ms(n: u64) -> Duration {
        Duration::from_millis(n)
    }

    // ---- fakes ----

    /// Records every message; transmits nothing.
    #[derive(Clone, Default)]
    struct RecordingPort {
        messages: Arc<Mutex<Vec<[u8; MESSAGE_LEN]>>>,
    }

    impl sealed::Sealed for RecordingPort {}

    impl OutputPort for RecordingPort {
        fn mode(&self) -> OperatingMode {
            OperatingMode::DryRun
        }
        fn write(&mut self, message: &[u8; MESSAGE_LEN]) -> Delivery {
            self.messages.lock().unwrap().push(*message);
            Delivery::NotTransmitted
        }
    }

    fn disarm_bytes() -> [u8; MESSAGE_LEN] {
        encode(&WireMessage::Disarm)
    }

    impl RecordingPort {
        fn all(&self) -> Vec<[u8; MESSAGE_LEN]> {
            self.messages.lock().unwrap().clone()
        }
        fn disarms(&self) -> usize {
            self.all().iter().filter(|m| **m == disarm_bytes()).count()
        }
        fn commands(&self) -> usize {
            self.all().len() - self.disarms()
        }
    }

    /// Cuts the latch from inside its first command write, as a cut on another thread at
    /// exactly that moment would. Records every message; transmits nothing.
    struct CuttingPort {
        link: GateLink,
        recorder: RecordingPort,
        cut_done: bool,
    }

    impl sealed::Sealed for CuttingPort {}

    impl OutputPort for CuttingPort {
        fn mode(&self) -> OperatingMode {
            OperatingMode::DryRun
        }
        fn write(&mut self, message: &[u8; MESSAGE_LEN]) -> Delivery {
            if !self.cut_done && *message != disarm_bytes() {
                self.cut_done = true;
                assert_eq!(
                    self.link.cut(CutReason::ManualDisarm),
                    CutOutcome::Closed { epoch: 1 }
                );
            }
            self.recorder.write(message)
        }
    }

    /// Blocks in `write` while `blocked` is set, until released. Transmits nothing.
    #[derive(Clone)]
    struct BlockingPort {
        blocked: Arc<AtomicBool>,
        writes: Arc<AtomicUsize>,
    }

    impl sealed::Sealed for BlockingPort {}

    impl OutputPort for BlockingPort {
        fn mode(&self) -> OperatingMode {
            OperatingMode::DryRun
        }
        fn write(&mut self, _message: &[u8; MESSAGE_LEN]) -> Delivery {
            self.writes.fetch_add(1, SeqCst);
            let deadline = Instant::now() + Duration::from_secs(20);
            while self.blocked.load(SeqCst) && Instant::now() < deadline {
                thread::sleep(ms(1));
            }
            Delivery::NotTransmitted
        }
    }

    /// Panics on its first write.
    struct PanickingPort;

    impl sealed::Sealed for PanickingPort {}

    impl OutputPort for PanickingPort {
        fn mode(&self) -> OperatingMode {
            OperatingMode::DryRun
        }
        fn write(&mut self, _message: &[u8; MESSAGE_LEN]) -> Delivery {
            panic!("the test port fails");
        }
    }

    // ---- helpers ----

    /// The full sequence as the core will run it: the ticket at the start of the step, then
    /// a genuine manual activation, then the open.
    fn open(opener: &GateOpener) -> u64 {
        let ticket = opener.prepare().expect("closed");
        let mut supervisor = activated();
        let proof = supervisor.take_activation_proof().expect("activated");
        opener.open(ticket, proof).expect("no cut since prepare")
    }

    fn command_with_brake(brake: f32, epoch: u64, computed_at: Instant) -> GateCommand {
        GateCommand {
            command: ControlCommand::new(&ControlLimits::default(), None, 0.0, brake).unwrap(),
            epoch,
            computed_at,
        }
    }

    fn command(epoch: u64, computed_at: Instant) -> GateCommand {
        GateCommand {
            command: ControlCommand::new(&ControlLimits::default(), Some(0.05), 0.05, 0.0).unwrap(),
            epoch,
            computed_at,
        }
    }

    fn command_bytes() -> [u8; MESSAGE_LEN] {
        encode(&WireMessage::Command(command(0, Instant::now()).command))
    }

    /// A gate stepped on an explicit millisecond clock (no thread).
    struct Rig {
        t0: Instant,
        link: GateLink,
        opener: GateOpener,
        writer: CommandWriter,
        runner: GateRunner,
        port: RecordingPort,
    }

    impl Rig {
        fn new() -> Self {
            let t0 = Instant::now();
            let GateParts {
                link,
                opener,
                writer,
                runner,
            } = gate(t0);
            Self {
                t0,
                link,
                opener,
                writer,
                runner,
                port: RecordingPort::default(),
            }
        }

        fn at(&self, millis: u64) -> Instant {
            self.t0 + ms(millis)
        }

        /// The control loop beats and the gate steps at `millis`.
        fn step(&mut self, millis: u64) -> StepReport {
            self.writer.beat(self.at(millis));
            self.step_silent(millis)
        }

        /// The gate steps at `millis` without a loop heartbeat.
        fn step_silent(&mut self, millis: u64) -> StepReport {
            let now = self.at(millis);
            self.runner.step(now, &mut self.port)
        }

        fn publish(&mut self, epoch: u64, computed_ms: u64) -> PublishOutcome {
            let at = self.at(computed_ms);
            self.writer.publish(command(epoch, at))
        }
    }

    /// Compiles only if `T` is not `Clone` (and therefore not `Copy`): with a `Clone` type
    /// both impls apply and the call is ambiguous.
    macro_rules! assert_not_clone {
        ($t:ty) => {{
            trait AmbiguousIfClone<A> {
                fn check() {}
            }
            impl<T: ?Sized> AmbiguousIfClone<()> for T {}
            #[allow(dead_code)]
            struct IsClone;
            impl<T: ?Sized + Clone> AmbiguousIfClone<IsClone> for T {}
            <$t as AmbiguousIfClone<_>>::check();
        }};
    }

    /// The code of this file before its test module.
    fn production_code() -> impl Iterator<Item = (usize, &'static str)> {
        include_str!("gate.rs")
            .lines()
            .enumerate()
            .take_while(|(_, line)| line.trim() != "mod tests {")
            .filter(|(_, line)| !line.trim_start().starts_with("//"))
    }

    // ---- R3: who may open ----

    #[test]
    fn the_gate_starts_closed_unconfirmed_and_writes_nothing() {
        let mut rig = Rig::new();
        assert_eq!(
            rig.link.state(),
            LatchState::Closed {
                generation: 0,
                reason: CutReason::Initial
            }
        );
        assert_eq!(rig.link.mirror(), MirrorState::Disabled);
        assert_eq!(rig.link.output(), GateOutput::Idle);
        // Even a command for the epoch the next open would have is not written.
        rig.publish(1, 0);
        for t in (0..500).step_by(10) {
            assert_eq!(rig.step(t), StepReport::default());
        }
        assert!(rig.port.all().is_empty());
        assert_eq!(rig.link.stats().discarded_closed, 1);
    }

    #[test]
    fn a_genuine_manual_activation_opens_with_a_ticket_of_the_step() {
        let mut rig = Rig::new();
        let epoch = open(&rig.opener);
        assert_eq!(epoch, 1);
        assert_eq!(rig.link.state(), LatchState::Open { epoch: 1 });
        assert_eq!(rig.link.mirror(), MirrorState::Active { epoch: 1 });
        rig.publish(epoch, 5);
        assert!(rig.step(10).command_written);
        assert_eq!(rig.port.all(), vec![command_bytes()]);
    }

    #[test]
    fn a_ticket_prepared_before_a_cut_is_stale_and_restores_the_mirror() {
        let rig = Rig::new();
        rig.opener.publish_supervisor(State::Armed);
        // Start of the step: the ticket.
        let ticket = rig.opener.prepare().unwrap();
        // A cut arrives (an operator disarm, a gate failure) before the activation is
        // processed. The latch is closed already; the cut still advances the generation.
        assert_eq!(
            rig.link.cut(CutReason::ManualDisarm),
            CutOutcome::AlreadyClosed
        );
        // The activation is genuine, and still the open must fail.
        let mut supervisor = activated();
        let proof = supervisor.take_activation_proof().unwrap();
        assert_eq!(rig.opener.open(ticket, proof), Err(OpenError::Stale));
        assert_eq!(
            rig.link.state(),
            LatchState::Closed {
                generation: 1,
                reason: CutReason::Initial
            }
        );
        assert_eq!(rig.link.mirror(), MirrorState::Armed, "restored");
    }

    #[test]
    fn a_ticket_taken_after_the_cut_would_not_protect_and_is_why_prepare_comes_first() {
        // Documents the ordering rule: the same cut, but the ticket taken only after it.
        // Such a ticket carries the post-cut generation and opens. The core must therefore
        // prepare at the start of the step (step 2 of 4.6.4d).
        let rig = Rig::new();
        rig.link.cut(CutReason::ManualDisarm);
        let late = rig.opener.prepare().unwrap();
        let mut supervisor = activated();
        let proof = supervisor.take_activation_proof().unwrap();
        assert!(rig.opener.open(late, proof).is_ok());
    }

    #[test]
    fn a_cut_between_ticket_and_open_from_another_thread_always_wins() {
        // Four threads cut while a fifth opens with a ticket prepared before them. Whatever
        // the interleaving, the latch ends closed: an open after a cut fails, a cut after
        // the open closes.
        for _ in 0..300 {
            let GateParts { link, opener, .. } = gate(Instant::now());
            let ticket = opener.prepare().unwrap();
            let barrier = Arc::new(Barrier::new(5));
            let mut cutters = Vec::new();
            for _ in 0..4 {
                let link = link.clone();
                let barrier = barrier.clone();
                cutters.push(thread::spawn(move || {
                    barrier.wait();
                    link.cut(CutReason::SupervisorFault);
                }));
            }
            let opener_thread = {
                let barrier = barrier.clone();
                thread::spawn(move || {
                    let mut supervisor = activated();
                    let proof = supervisor.take_activation_proof().unwrap();
                    barrier.wait();
                    opener.open(ticket, proof)
                })
            };
            for t in cutters {
                t.join().unwrap();
            }
            let opened = opener_thread.join().unwrap();
            let state = link.state();
            assert!(!state.is_open(), "{opened:?} {state:?}");
            if let LatchState::Closed { generation, .. } = state {
                assert_eq!(generation, if opened.is_ok() { 5 } else { 4 });
            }
        }
    }

    #[test]
    fn an_open_gate_cannot_be_prepared_and_a_forged_ticket_is_stale() {
        let rig = Rig::new();
        let epoch = open(&rig.opener);
        assert_eq!(rig.opener.prepare(), Err(PrepareError::AlreadyOpen));
        // A ticket for the generation the first open used (only constructible here, in the
        // module itself) replayed against the open latch.
        let replay = ArmTicket { generation: 0 };
        let mut supervisor = activated();
        let proof = supervisor.take_activation_proof().unwrap();
        assert_eq!(rig.opener.open(replay, proof), Err(OpenError::Stale));
        assert_eq!(rig.link.state(), LatchState::Open { epoch });
    }

    #[test]
    fn a_proof_comes_only_from_a_valid_activation_and_only_once() {
        let rig = Rig::new();
        let mut supervisor = Supervisor::default();
        assert!(supervisor.take_activation_proof().is_none(), "disabled");
        let mut supervisor = activated();
        let proof = supervisor.take_activation_proof().unwrap();
        assert!(
            rig.opener
                .open(rig.opener.prepare().unwrap(), proof)
                .is_ok()
        );
        // The same supervisor cannot give a second proof for the same activation.
        assert!(supervisor.take_activation_proof().is_none());
    }

    #[test]
    fn no_open_after_a_fault_and_reset_without_a_new_full_sequence() {
        let rig = Rig::new();
        let first = open(&rig.opener);
        // The activation's supervisor faults; the core cuts (step 2) and resets the fault.
        let mut supervisor = activated(); // its proof is never taken
        supervisor.report(super::super::supervisor::SafetyEvent::InvalidControlRequest);
        rig.link.cut(CutReason::SupervisorFault);
        assert!(
            supervisor
                .command(
                    super::super::supervisor::Command::ResetFault,
                    &super::super::supervisor::test_support::usable()
                )
                .result
                .is_ok()
        );
        // A ticket is available, but without a proof nothing can be opened; the reset does
        // not provide one.
        assert!(rig.opener.prepare().is_ok());
        assert!(supervisor.take_activation_proof().is_none());
        assert!(!rig.link.state().is_open());
        // A new arm and activation (and a new ticket) open a new, higher epoch.
        let second = open(&rig.opener);
        assert!(second > first);
    }

    #[test]
    fn the_link_cannot_open_and_the_rights_cannot_be_copied() {
        assert_not_clone!(GateOpener);
        assert_not_clone!(ArmTicket);
        assert_not_clone!(ManualArm<'static>);
        assert_not_clone!(CommandWriter);
        assert_not_clone!(GateRunner);
        // The `impl GateLink` block names no opening right.
        let code: Vec<&str> = production_code().map(|(_, l)| l).collect();
        let start = code
            .iter()
            .position(|l| l.trim() == "impl GateLink {")
            .expect("impl GateLink");
        let block: Vec<&&str> = code[start..].iter().take_while(|l| **l != "}").collect();
        assert!(block.len() > 10, "found the block");
        for line in block {
            for needle in [
                "fn open",
                "fn prepare",
                "fn publish_supervisor",
                "GateOpener",
            ] {
                assert!(!line.contains(needle), "GateLink offers `{needle}`: {line}");
            }
        }
    }

    // ---- the supervisor mirror ----

    #[test]
    fn a_mirror_that_stops_confirming_the_epoch_cuts_with_one_disarm() {
        for published in [State::Disabled, State::Armed, State::Fault, State::Active] {
            let mut rig = Rig::new();
            let epoch = open(&rig.opener);
            rig.step(0);
            rig.opener.publish_supervisor(published);
            let report = rig.step(10);
            assert!(report.cut_mismatch, "{published:?}");
            assert!(report.disarm_written);
            assert_eq!(
                rig.link.state(),
                LatchState::Closed {
                    generation: epoch + 1,
                    reason: CutReason::SupervisorMismatch
                }
            );
            rig.publish(epoch, 15);
            assert!(!rig.step(20).command_written);
            assert_eq!(rig.port.disarms(), 1);
            assert_eq!(rig.link.stats().mismatch_cuts, 1);
        }
    }

    #[test]
    fn the_mirror_never_opens_anything() {
        let mut rig = Rig::new();
        for state in [State::Active, State::Armed, State::Active, State::Fault] {
            rig.opener.publish_supervisor(state);
            for t in 0..20 {
                rig.step(t * 10);
                assert!(!rig.link.state().is_open());
            }
        }
        assert!(rig.port.all().is_empty());
    }

    // ---- disarm owed ----

    #[test]
    fn disarm_owed_covers_exactly_the_time_from_the_cut_to_the_disarm() {
        let mut rig = Rig::new();
        let epoch = open(&rig.opener);
        assert_eq!(
            rig.link.output(),
            GateOutput::Idle,
            "not seen by the gate yet"
        );
        rig.step(0);
        assert_eq!(rig.link.output(), GateOutput::Open { epoch });
        assert!(!rig.link.disarm_owed());
        rig.link.cut(CutReason::ManualDisarm);
        assert_eq!(rig.link.output(), GateOutput::DisarmOwed { epoch });
        assert!(rig.link.disarm_owed());
        assert!(rig.step(10).disarm_written);
        assert_eq!(rig.link.output(), GateOutput::Idle);
        assert!(!rig.link.disarm_owed());
    }

    #[test]
    fn an_open_and_cut_the_gate_never_saw_owes_no_disarm() {
        let mut rig = Rig::new();
        open(&rig.opener);
        rig.link.cut(CutReason::ManualDisarm);
        assert!(!rig.link.disarm_owed());
        assert!(!rig.step(10).disarm_written);
        assert!(rig.port.all().is_empty());
    }

    // ---- R1: a cut during a write ----

    #[test]
    fn a_cut_inside_a_command_write_is_followed_by_one_disarm_and_nothing_else() {
        let t0 = Instant::now();
        let GateParts {
            link,
            opener,
            mut writer,
            runner,
        } = gate(t0);
        let recorder = RecordingPort::default();
        let mut driver = runner.drive(CuttingPort {
            link: link.clone(),
            recorder: recorder.clone(),
            cut_done: false,
        });
        let epoch = open(&opener);
        writer.beat(t0);
        writer.publish(command(epoch, t0));
        let report = driver.step(t0 + ms(5));
        // The command that was already being written, then the disarm in the same step.
        assert!(report.command_written && report.disarm_written);
        assert_eq!(recorder.all(), vec![command_bytes(), disarm_bytes()]);
        assert!(!link.disarm_owed());
        // The loop keeps publishing commands of the cut epoch: nothing more is written.
        for n in 1..50 {
            let now = t0 + ms(5 + n * 10);
            writer.beat(now);
            writer.publish(command(epoch, now));
            assert_eq!(driver.step(now), StepReport::default());
        }
        assert_eq!(recorder.all().len(), 2);
        drop(driver);
    }

    #[test]
    fn a_cutter_thread_never_lets_an_old_command_follow_its_disarm() {
        // A real gate thread, a cutter thread cutting at irregular moments, and the test
        // thread acting as the core: it opens one epoch after another (ticket first, genuine
        // activation), and publishes commands whose brake value names their activation.
        // In the written sequence, no command may follow a disarm unless it belongs to a
        // later activation than every command before that disarm.
        const CYCLES: u32 = 120;
        let start = Instant::now();
        let GateParts {
            link,
            opener,
            mut writer,
            runner,
        } = gate(start);
        let port = RecordingPort::default();
        let handle = runner.spawn(port.clone(), || false).unwrap();
        let done = Arc::new(AtomicBool::new(false));
        let cutter = {
            let link = link.clone();
            let done = done.clone();
            thread::spawn(move || {
                let mut seed = 0x2545_f491_u32;
                while !done.load(SeqCst) {
                    seed ^= seed << 13;
                    seed ^= seed >> 17;
                    seed ^= seed << 5;
                    thread::sleep(Duration::from_micros(u64::from(seed % 30_000)));
                    link.cut(CutReason::SupervisorFault);
                }
            })
        };
        let brake = |cycle: u32| f32::from(u16::try_from(cycle % 1_000).unwrap()) / 1_000.0;
        let mut by_bytes: HashMap<[u8; MESSAGE_LEN], u32> = HashMap::new();
        let mut opened = 0;
        for cycle in 1..=CYCLES {
            let probe = command_with_brake(brake(cycle), 0, start);
            by_bytes.insert(encode(&WireMessage::Command(probe.command)), cycle);
            let Ok(ticket) = opener.prepare() else {
                continue;
            };
            let mut supervisor = activated();
            let proof = supervisor.take_activation_proof().unwrap();
            let Ok(epoch) = opener.open(ticket, proof) else {
                continue; // cut since the ticket: correctly refused
            };
            opened += 1;
            let until = Instant::now() + ms(15);
            while Instant::now() < until {
                let now = Instant::now();
                writer.beat(now);
                writer.publish(command_with_brake(brake(cycle), epoch, now));
                thread::sleep(ms(2));
            }
            // As the core will on leaving Active.
            link.cut(CutReason::ManualDisarm);
            opener.publish_supervisor(State::Disabled);
        }
        done.store(true, SeqCst);
        cutter.join().unwrap();
        handle.stop(Duration::from_secs(5)).expect("the gate ends");

        let messages = port.all();
        let (mut before_last_disarm, mut since_last_disarm) = (0u32, 0u32);
        let mut commands = 0;
        for message in &messages {
            if *message == disarm_bytes() {
                before_last_disarm = before_last_disarm.max(since_last_disarm);
                continue;
            }
            let cycle = *by_bytes.get(message).expect("a known command");
            assert!(
                cycle > before_last_disarm,
                "cycle {cycle} written after the disarm of cycle {before_last_disarm}"
            );
            assert!(cycle >= since_last_disarm, "commands never go back");
            since_last_disarm = cycle;
            commands += 1;
        }
        assert!(
            opened > 0 && commands > 0,
            "opened {opened}, wrote {commands}"
        );
        assert!(!link.disarm_owed(), "every cut answered");
        assert_eq!(*messages.last().unwrap(), disarm_bytes());
    }

    // ---- gate behaviour ----

    #[test]
    fn the_loop_heartbeat_is_watched_and_silence_cuts_with_one_disarm() {
        let mut rig = Rig::new();
        let epoch = open(&rig.opener);
        rig.step(0);
        // The loop beats at 0 and goes silent. Exactly at the limit nothing happens.
        for t in (10..=100).step_by(10) {
            assert_eq!(rig.step_silent(t), StepReport::default());
        }
        assert!(rig.link.state().is_open());
        let report = rig.step_silent(101);
        assert!(report.cut_loop_silent);
        assert!(report.disarm_written);
        assert_eq!(
            rig.link.state(),
            LatchState::Closed {
                generation: epoch + 1,
                reason: CutReason::LoopSilent
            }
        );
        // A loop that comes back does not reopen anything.
        for t in (110..1_000).step_by(10) {
            let r = rig.step(t);
            assert!(!r.command_written && !r.disarm_written && !r.cut_loop_silent);
        }
        assert!(!rig.link.state().is_open());
        assert_eq!(rig.port.disarms(), 1);
        assert_eq!(rig.link.stats().loop_silence_cuts, 1);
    }

    #[test]
    fn a_cut_is_written_once_and_nothing_follows_it() {
        let mut rig = Rig::new();
        let epoch = open(&rig.opener);
        for t in (0..100).step_by(10) {
            rig.publish(epoch, t);
            assert!(rig.step(t).command_written);
        }
        rig.link.cut(CutReason::SupervisorFault);
        rig.link.cut(CutReason::ManualDisarm);
        rig.link.cut(CutReason::GateFailed);
        for t in (100..600).step_by(10) {
            rig.publish(epoch, t);
            rig.step(t);
        }
        assert_eq!(rig.port.commands(), 10);
        assert_eq!(rig.port.disarms(), 1);
        assert_eq!(*rig.port.all().last().unwrap(), disarm_bytes());
        assert_eq!(rig.link.stats().discarded_closed, 50);
    }

    #[test]
    fn a_command_of_an_old_epoch_is_discarded_after_a_new_open() {
        let mut rig = Rig::new();
        let first = open(&rig.opener);
        rig.step(0);
        rig.link.cut(CutReason::ManualDisarm);
        let second = open(&rig.opener);
        assert!(second > first);
        rig.publish(first, 5);
        let report = rig.step(10);
        assert!(!report.command_written);
        // Cut and reopen within one period: the disarm for the first epoch is still written.
        assert!(report.disarm_written);
        assert_eq!(rig.link.stats().discarded_epoch, 1);
        rig.publish(second, 15);
        assert!(rig.step(20).command_written);
        assert_eq!(rig.port.disarms(), 1);
        assert_eq!(rig.port.commands(), 1);
    }

    #[test]
    fn a_command_older_than_the_limit_is_discarded() {
        let mut rig = Rig::new();
        let epoch = open(&rig.opener);
        rig.publish(epoch, 100);
        assert!(rig.step(150).command_written, "exactly at the limit");
        rig.publish(epoch, 200);
        assert!(!rig.step(251).command_written);
        assert_eq!(rig.link.stats().discarded_stale, 1);
        assert!(
            rig.link.state().is_open(),
            "a stale command alone is no cut"
        );
        assert!(!rig.step(260).command_written);
        assert_eq!(rig.port.commands(), 1);
    }

    #[test]
    fn a_newer_command_replaces_an_unread_one_and_each_is_written_at_most_once() {
        let mut rig = Rig::new();
        let epoch = open(&rig.opener);
        assert_eq!(rig.publish(epoch, 0), PublishOutcome::Stored);
        let newer = GateCommand {
            command: ControlCommand::new(&ControlLimits::default(), Some(-0.1), 0.0, 0.5).unwrap(),
            epoch,
            computed_at: rig.at(4),
        };
        assert_eq!(rig.writer.publish(newer), PublishOutcome::Replaced);
        assert!(rig.step(5).command_written);
        assert!(!rig.step(15).command_written, "nothing is repeated");
        assert_eq!(
            rig.port.all(),
            vec![encode(&WireMessage::Command(newer.command))]
        );
        assert_eq!(rig.link.stats().replaced, 1);
    }

    #[test]
    fn a_command_waiting_in_the_slot_at_a_cut_is_never_written() {
        let mut rig = Rig::new();
        let epoch = open(&rig.opener);
        rig.step(0);
        rig.publish(epoch, 5);
        rig.link.cut(CutReason::SupervisorFault);
        let report = rig.step(10);
        assert!(!report.command_written);
        assert!(report.disarm_written);
        assert_eq!(rig.link.stats().discarded_closed, 1);
        let next = open(&rig.opener);
        assert!(!rig.step(20).command_written);
        rig.publish(next, 25);
        assert!(rig.step(30).command_written);
        assert_eq!(rig.port.commands(), 1);
    }

    #[test]
    fn the_gate_never_opens_by_itself() {
        let mut rig = Rig::new();
        for t in (0..20_000).step_by(10) {
            rig.publish(t / 1_000, t);
            if t % 3_000 < 1_500 {
                rig.step(t);
            } else {
                rig.step_silent(t);
            }
            assert!(!rig.link.state().is_open(), "at {t}");
        }
        assert!(rig.port.all().is_empty());
        assert_eq!(rig.link.stats().commands_written, 0);
    }

    #[test]
    fn a_poisoned_slot_cuts_the_latch() {
        let mut rig = Rig::new();
        let epoch = open(&rig.opener);
        rig.step(0);
        let shared = rig.runner.shared.clone();
        let _ = thread::spawn(move || {
            let _guard = shared.slot.lock().unwrap();
            panic!("poison the slot on purpose");
        })
        .join();
        assert_eq!(rig.publish(epoch, 5), PublishOutcome::Poisoned);
        assert_eq!(
            rig.link.state(),
            LatchState::Closed {
                generation: epoch + 1,
                reason: CutReason::SlotPoisoned
            }
        );
        assert!(rig.step(10).disarm_written);
        assert_eq!(rig.port.commands(), 0);
    }

    #[test]
    fn the_latch_word_round_trips_every_reason() {
        for reason in [
            CutReason::Initial,
            CutReason::ManualDisarm,
            CutReason::SupervisorFault,
            CutReason::LoopSilent,
            CutReason::Shutdown,
            CutReason::SlotPoisoned,
            CutReason::GateFailed,
            CutReason::GateEnded,
            CutReason::SupervisorMismatch,
        ] {
            assert_eq!(
                LatchState::of(word(42, reason as u64)),
                LatchState::Closed {
                    generation: 42,
                    reason
                }
            );
        }
        assert_eq!(
            LatchState::of(word(7, OPEN_CODE)),
            LatchState::Open { epoch: 7 }
        );
        for mirror in [
            MirrorState::Disabled,
            MirrorState::Armed,
            MirrorState::Active { epoch: 99 },
            MirrorState::ActiveUnconfirmed,
            MirrorState::Fault,
        ] {
            assert_eq!(MirrorState::of(mirror.word()), mirror);
        }
    }

    #[test]
    fn an_exhausted_generation_keeps_the_latch_closed() {
        let rig = Rig::new();
        let latch = &rig.runner.shared.latch;
        latch
            .word
            .store(word(MAX_GENERATION - 1, CutReason::Initial as u64), SeqCst);
        let mut supervisor = activated();
        let proof = supervisor.take_activation_proof().unwrap();
        let ticket = rig.opener.prepare().unwrap();
        assert_eq!(rig.opener.open(ticket, proof), Err(OpenError::Exhausted));
        latch.cut(CutReason::LoopSilent);
        latch.cut(CutReason::LoopSilent);
        assert!(!latch.state().is_open());
    }

    // ---- the deterministic driver on a paused clock ----

    fn virtual_now() -> Instant {
        tokio::time::Instant::now().into_std()
    }

    #[tokio::test(start_paused = true)]
    async fn a_driven_gate_follows_a_paused_clock() {
        let start = virtual_now();
        let GateParts {
            link,
            opener,
            mut writer,
            runner,
        } = gate(start);
        let port = RecordingPort::default();
        let mut driver = runner.drive(port.clone());
        assert!(link.is_running());
        let epoch = open(&opener);
        // One virtual second: a command every 40 ms, a gate step every 10 ms.
        for n in 1..=100u32 {
            tokio::time::advance(GATE_PERIOD).await;
            let now = virtual_now();
            writer.beat(now);
            if n % 4 == 0 {
                writer.publish(command(epoch, now));
            }
            driver.step(now);
            assert_eq!(link.check_gate(now), Ok(()), "at step {n}");
        }
        assert_eq!(port.commands(), 25, "every command, none stale");
        assert!(
            link.state().is_open(),
            "no loop silence on the virtual clock"
        );
        // The loop goes silent on the virtual clock: the driven gate cuts after the limit.
        for _ in 0..10 {
            tokio::time::advance(GATE_PERIOD).await;
            assert!(!driver.step(virtual_now()).cut_loop_silent);
        }
        tokio::time::advance(ms(1)).await;
        assert!(driver.step(virtual_now()).cut_loop_silent);
        assert_eq!(port.disarms(), 1);
        // A driver that stops stepping is reported silent on the same clock.
        tokio::time::advance(GATE_SILENCE_LIMIT + ms(1)).await;
        assert!(matches!(
            link.check_gate(virtual_now()),
            Err(GateFailure::Silent { .. })
        ));
        let report = driver.finish(virtual_now());
        assert!(!report.disarm_written, "already disarmed");
        assert_eq!(link.check_gate(virtual_now()), Err(GateFailure::NotRunning));
    }

    #[test]
    fn a_driver_dropped_without_finishing_cuts_and_stops_running() {
        let GateParts {
            link,
            opener,
            runner,
            ..
        } = gate(Instant::now());
        let driver = runner.drive(DryRunPort);
        open(&opener);
        drop(driver);
        assert!(!link.is_running());
        assert!(matches!(
            link.state(),
            LatchState::Closed {
                reason: CutReason::GateEnded,
                ..
            }
        ));
    }

    // ---- real threads ----

    #[test]
    fn concurrent_writes_and_reads_are_race_free_and_never_torn_or_reordered() {
        const N: u64 = 200_000;
        let base = Instant::now();
        let GateParts {
            mut writer, runner, ..
        } = gate(base);
        let shared = runner.shared.clone();
        let done = Arc::new(AtomicBool::new(false));
        let limits = ControlLimits::default();

        let reader = {
            let shared = shared.clone();
            let done = done.clone();
            thread::spawn(move || {
                let deadline = Instant::now() + Duration::from_secs(60);
                let (mut last, mut taken) = (0u64, 0u64);
                loop {
                    let finished = done.load(SeqCst);
                    match shared.take() {
                        SlotRead::Entry(e) => {
                            let s = e.sequence;
                            assert!(s > last, "sequence {s} after {last}");
                            last = s;
                            taken += 1;
                            assert_eq!(e.command.epoch, s);
                            assert_eq!(
                                e.command.computed_at.duration_since(base),
                                Duration::from_nanos(s)
                            );
                            let brake = f32::from(u16::try_from(s % 1_000).unwrap()) / 1_000.0;
                            assert_eq!(e.command.command.brake(), brake);
                        }
                        SlotRead::Empty if finished => break,
                        SlotRead::Empty | SlotRead::Busy => std::hint::spin_loop(),
                        SlotRead::Poisoned => panic!("poisoned"),
                    }
                    assert!(Instant::now() < deadline, "the reader must finish");
                }
                taken
            })
        };

        let (mut stored, mut replaced, mut busy) = (0u64, 0u64, 0u64);
        for _ in 0..N {
            let s = writer.sequence + 1;
            let brake = f32::from(u16::try_from(s % 1_000).unwrap()) / 1_000.0;
            match writer.publish(GateCommand {
                command: ControlCommand::new(&limits, None, 0.0, brake).unwrap(),
                epoch: s,
                computed_at: base + Duration::from_nanos(s),
            }) {
                PublishOutcome::Stored => stored += 1,
                PublishOutcome::Replaced => replaced += 1,
                PublishOutcome::Busy => busy += 1,
                PublishOutcome::Poisoned => panic!("poisoned"),
            }
        }
        done.store(true, SeqCst);
        let taken = reader.join().expect("the reader thread");
        assert_eq!(stored, taken);
        assert_eq!(stored + replaced + busy, N);
        assert_eq!(writer.sequence, stored + replaced);
        assert_eq!(shared.stats().replaced, replaced);
        assert_eq!(shared.stats().publish_busy, busy);
    }

    #[test]
    fn the_start_hook_runs_on_the_gate_thread_and_its_result_is_reported() {
        let GateParts { link, runner, .. } = gate(Instant::now());
        let name = Arc::new(Mutex::new(None));
        let seen = name.clone();
        let handle = runner
            .spawn(DryRunPort, move || {
                *seen.lock().unwrap() = thread::current().name().map(String::from);
                true
            })
            .unwrap();
        let deadline = Instant::now() + Duration::from_secs(10);
        while !link.elevated() {
            thread::sleep(ms(1));
            assert!(Instant::now() < deadline, "the hook must run");
        }
        assert_eq!(name.lock().unwrap().as_deref(), Some("roadpilot-gate"));
        handle.stop(Duration::from_secs(5)).expect("the gate ends");
    }

    #[test]
    fn the_gate_thread_never_steps_faster_than_its_period() {
        let GateParts { link, runner, .. } = gate(Instant::now());
        let handle = runner.spawn(DryRunPort, || false).unwrap();
        let measured_from = Instant::now();
        let first = link.stats().steps;
        thread::sleep(ms(500));
        let steps = link.stats().steps - first;
        let elapsed = measured_from.elapsed();
        handle.stop(Duration::from_secs(5)).expect("the gate ends");
        let most = elapsed.as_millis() / GATE_PERIOD.as_millis() + 2;
        assert!(u128::from(steps) <= most, "{steps} steps in {elapsed:?}");
        assert!(steps >= 10, "{steps} steps in {elapsed:?}");
    }

    #[test]
    fn the_gate_thread_writes_commands_and_stops_with_one_disarm() {
        let GateParts {
            link,
            opener,
            mut writer,
            runner,
        } = gate(Instant::now());
        let port = RecordingPort::default();
        let handle = runner.spawn(port.clone(), || false).unwrap();
        let epoch = open(&opener);
        let deadline = Instant::now() + Duration::from_secs(10);
        while link.stats().commands_written < 5 {
            let now = Instant::now();
            writer.beat(now);
            writer.publish(command(epoch, now));
            assert_eq!(link.check_gate(now), Ok(()));
            thread::sleep(ms(5));
            assert!(Instant::now() < deadline, "the gate must write");
        }
        handle.stop(Duration::from_secs(5)).expect("the gate ends");
        assert_eq!(
            link.state(),
            LatchState::Closed {
                generation: epoch + 1,
                reason: CutReason::Shutdown
            }
        );
        assert_eq!(port.disarms(), 1);
        assert_eq!(*port.all().last().unwrap(), disarm_bytes());
        assert!(!link.disarm_owed());
        let written = port.all().len();
        thread::sleep(ms(50));
        assert_eq!(port.all().len(), written, "nothing after the stop");
        assert_eq!(
            link.check_gate(Instant::now()),
            Err(GateFailure::NotRunning)
        );
    }

    #[test]
    fn the_gate_thread_cuts_on_a_silent_loop() {
        let GateParts {
            link,
            opener,
            writer,
            runner,
        } = gate(Instant::now());
        let port = RecordingPort::default();
        let handle = runner.spawn(port.clone(), || false).unwrap();
        writer.beat(Instant::now());
        let epoch = open(&opener);
        let deadline = Instant::now() + Duration::from_secs(10);
        while link.state().is_open() {
            thread::sleep(ms(5));
            assert!(Instant::now() < deadline, "the gate must cut");
        }
        assert_eq!(
            link.state(),
            LatchState::Closed {
                generation: epoch + 1,
                reason: CutReason::LoopSilent
            }
        );
        while port.disarms() == 0 {
            thread::sleep(ms(1));
            assert!(Instant::now() < deadline);
        }
        handle.stop(Duration::from_secs(5)).expect("the gate ends");
        assert_eq!(
            port.disarms(),
            1,
            "one disarm for the cut, none more at stop"
        );
    }

    #[test]
    fn a_blocked_port_never_blocks_the_loop_and_the_loop_detects_the_silent_gate() {
        let GateParts {
            link,
            opener,
            mut writer,
            runner,
        } = gate(Instant::now());
        let blocked = Arc::new(AtomicBool::new(true));
        let port = BlockingPort {
            blocked: blocked.clone(),
            writes: Arc::new(AtomicUsize::new(0)),
        };
        let handle = runner.spawn(port.clone(), || false).unwrap();
        let epoch = open(&opener);
        let deadline = Instant::now() + Duration::from_secs(10);
        loop {
            let now = Instant::now();
            writer.beat(now);
            writer.publish(command(epoch, now));
            if port.writes.load(SeqCst) > 0 {
                break;
            }
            thread::sleep(ms(2));
            assert!(Instant::now() < deadline, "the gate must reach the port");
        }
        let mut slowest = Duration::ZERO;
        let mut detected = None;
        for _ in 0..100 {
            let now = Instant::now();
            writer.beat(now);
            let before = Instant::now();
            let outcome = writer.publish(command(epoch, now));
            slowest = slowest.max(before.elapsed());
            assert_ne!(outcome, PublishOutcome::Busy, "no lock held while writing");
            if let Err(failure) = link.check_gate(Instant::now()) {
                detected = Some(failure);
                break;
            }
            thread::sleep(ms(4));
        }
        assert!(slowest < ms(20), "publish took {slowest:?}");
        assert!(
            matches!(detected, Some(GateFailure::Silent { silent_for }) if silent_for > GATE_SILENCE_LIMIT),
            "{detected:?}"
        );
        assert_eq!(
            link.state(),
            LatchState::Closed {
                generation: epoch + 1,
                reason: CutReason::GateFailed
            }
        );
        // The cut is known, its disarm not written while the port blocks.
        assert_eq!(link.output(), GateOutput::DisarmOwed { epoch });
        blocked.store(false, SeqCst);
        handle.stop(Duration::from_secs(5)).expect("the gate ends");
        assert!(!link.disarm_owed(), "written once the port returned");
    }

    #[test]
    fn stopping_a_gate_stuck_in_its_port_times_out_and_can_be_finished_later() {
        let GateParts {
            link,
            opener,
            writer,
            runner,
        } = gate(Instant::now());
        let blocked = Arc::new(AtomicBool::new(true));
        let port = BlockingPort {
            blocked: blocked.clone(),
            writes: Arc::new(AtomicUsize::new(0)),
        };
        let handle = runner.spawn(port.clone(), || false).unwrap();
        writer.beat(Instant::now());
        open(&opener);
        // Let the gate see the open epoch, then cut: its disarm blocks in the port.
        thread::sleep(ms(50));
        link.cut(CutReason::ManualDisarm);
        let deadline = Instant::now() + Duration::from_secs(10);
        while port.writes.load(SeqCst) == 0 {
            thread::sleep(ms(2));
            assert!(Instant::now() < deadline, "the gate must reach the port");
        }
        assert!(link.disarm_owed(), "the disarm write has not returned");
        let StopTimeout(handle) = handle
            .stop(ms(50))
            .expect_err("the gate is stuck in its port");
        assert!(!link.state().is_open());
        blocked.store(false, SeqCst);
        handle.stop(Duration::from_secs(5)).expect("the gate ends");
        assert!(!link.disarm_owed());
    }

    #[test]
    fn a_gate_that_ends_unexpectedly_is_detected_and_cuts() {
        let start = Instant::now();
        let GateParts {
            link,
            opener,
            mut writer,
            runner,
        } = gate(start);
        assert_eq!(link.check_gate(start), Err(GateFailure::NotRunning));
        let handle = runner.spawn(PanickingPort, || false).unwrap();
        let epoch = open(&opener);
        let deadline = Instant::now() + Duration::from_secs(10);
        loop {
            let now = Instant::now();
            writer.beat(now);
            writer.publish(command(epoch, now));
            if link.check_gate(now) == Err(GateFailure::NotRunning) {
                break;
            }
            thread::sleep(ms(5));
            assert!(Instant::now() < deadline, "the end must be detected");
        }
        assert!(!link.state().is_open());
        handle.stop(Duration::from_secs(5)).expect("already ended");
    }

    #[test]
    fn dropping_the_handle_cuts_and_ends_the_gate() {
        let GateParts {
            link,
            opener,
            runner,
            ..
        } = gate(Instant::now());
        let handle = runner.spawn(DryRunPort, || false).unwrap();
        open(&opener);
        drop(handle);
        assert!(!link.state().is_open());
        let deadline = Instant::now() + Duration::from_secs(10);
        while link.check_gate(Instant::now()) != Err(GateFailure::NotRunning) {
            thread::sleep(ms(5));
            assert!(Instant::now() < deadline, "the gate must end");
        }
    }

    // ---- structure and limits ----

    #[test]
    fn the_dry_run_port_is_the_only_port_and_transmits_nothing() {
        let mut port = DryRunPort;
        assert_eq!(port.mode(), OperatingMode::DryRun);
        assert_eq!(port.write(&[0; MESSAGE_LEN]), Delivery::NotTransmitted);
    }

    #[test]
    fn the_gate_is_independent_of_the_async_runtime_the_log_the_status_and_the_loop() {
        // Production code only: the tests below the module line may use the paused clock.
        let forbidden = [
            ["to", "kio"].concat(),
            ["Control", "Log"].concat(),
            ["super::", "log"].concat(),
            ["super::", "status"].concat(),
            ["Status", "Cell"].concat(),
            ["super::", "runtime"].concat(),
            ["super::", "sender"].concat(),
            ["Pipe", "Port"].concat(),
            ["park", "_timeout"].concat(),
        ];
        let mut lines = 0;
        for (number, line) in production_code() {
            lines += 1;
            for needle in &forbidden {
                assert!(
                    !line.contains(needle.as_str()),
                    "control/gate.rs:{} mentions `{needle}`: {line}",
                    number + 1
                );
            }
        }
        assert!(lines > 500, "the production part was found ({lines} lines)");
    }

    #[test]
    fn the_limits_are_consistent() {
        assert_eq!(LOOP_SILENCE_LIMIT, ms(100));
        assert_eq!(GATE_PERIOD, ms(10));
        assert_eq!(MAX_COMMAND_AGE, ms(50));
        assert!(GATE_PERIOD < MAX_COMMAND_AGE);
        assert!(MAX_COMMAND_AGE < LOOP_SILENCE_LIMIT);
        assert!(LOOP_SILENCE_LIMIT < ms(150));
        assert!(GATE_SILENCE_LIMIT < ms(150));
    }
}
