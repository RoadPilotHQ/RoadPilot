//! The output gate (Phase 4.6.4c): the component that will become the sole owner and writer
//! of the output port. **Not integrated yet**: nothing in the application builds a gate, and
//! the only ports that exist are [`DryRunPort`] and the test fakes of this module. There is no
//! pipe port; the module-level proof in `control/mod.rs` scans this file like every other.
//!
//! The gate runs on a thread of its own, independent of the control loop. It does not use
//! tokio, the control log or the status mutex. It shares exactly three things with the rest
//! of the program, all of them below and none of them blocking the control loop:
//!
//! * the [`GateLatch`], one atomic word,
//! * the command slot, written by the single [`CommandWriter`] of the control loop,
//! * two heartbeats: the control loop's, read by the gate, and the gate's own, read by the
//!   control loop ([`GateLink::check_gate`]).
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
//!   dropped and counted ([`PublishOutcome::Busy`]); the gate then has nothing new, and a
//!   control loop that keeps failing to publish ends in the command age limit, never in a
//!   stale command. If an unread command is in the slot, the new one replaces it
//!   ([`PublishOutcome::Replaced`]): there is at most one command waiting, never a queue.
//! * **The gate never blocks either.** It takes the entry out (`Option::take`), so every
//!   command is seen at most once, and releases the lock **before** it writes to the port. A
//!   port that blocks therefore never holds the slot.
//! * **Poisoning** cannot occur (no panic is possible inside the lock). Should it ever be
//!   reported, both sides treat it as a failure and cut the latch ([`CutReason::SlotPoisoned`]).
//!
//! # The latch: one atomic word
//!
//! [`GateLatch`] is a single `AtomicU64`: `generation << 8 | code`. Code 0 means open; every
//! other code is the [`CutReason`] that closed it. The generation counts every cut and every
//! open. All operations are single loads or compare-and-swap loops with `SeqCst`, so every
//! cut and every open is one indivisible step in one total order.
//!
//! * [`GateLatch::cut`] is callable from any thread at any time, never waits and always
//!   advances the generation. On an open latch it closes it with its reason; on a closed one
//!   it keeps the first reason but still advances the generation, which invalidates every
//!   [`ArmTicket`] issued before it.
//! * Opening needs an [`ArmTicket`], issued by [`GateLatch::authorize`] only for a closed latch
//!   and only against a [`ManualArm`], which exists only for the supervisor's
//!   `ManualActivate` transition. The ticket records the generation it was issued for.
//!   [`GateLatch::open`] succeeds only by a compare-and-swap from exactly that closed
//!   generation. Any cut in between (a late open after a cut) makes it fail. The open epoch
//!   is the new generation; commands carry the epoch they were computed for.
//! * Nothing in the gate opens the latch: a loop timeout, a gate failure, a supervisor fault
//!   or a fault reset can only ever cut it, and a reset does not produce a [`ManualArm`].
//!
//! # What the gate does every period ([`GATE_PERIOD`])
//!
//! 1. Records its own liveness.
//! 2. Reads the latch. If it is open and the control loop's heartbeat is older than
//!    [`LOOP_SILENCE_LIMIT`], it cuts it ([`CutReason::LoopSilent`]).
//! 3. If it had seen the latch open with an epoch that is no longer the open one (a cut, or
//!    a cut and a new open within one period), it writes **exactly one** disarm.
//! 4. Closed: it empties the slot, so nothing computed before the cut can be written later.
//! 5. Open: it takes the newest command, if any, and writes it only if it belongs to the open
//!    epoch, is not older than [`MAX_COMMAND_AGE`], and the latch is still exactly the state
//!    it checked (re-read just before the write). Right after the write it reads the latch
//!    again and writes the disarm at once if a cut arrived meanwhile.
//!
//! A cut that happens while a command is already being written is ordered after that
//! write; the disarm follows it in the same period. No command whose check comes after the
//! cut is written, and no command is ever written twice.
//!
//! # Timing
//!
//! The limits are central constants. The gate sleeps between periods with
//! `thread::park_timeout`; on Windows the actual period depends on the system timer
//! resolution (typically up to about 16 ms) and on scheduling. The gate makes the reaction
//! *bounded by its checks*, not real-time: no reaction time is guaranteed on Windows.

use super::command::ControlCommand;
use super::protocol::{MESSAGE_LEN, WireMessage, encode};
use super::sink::{Delivery, OperatingMode};
use super::supervisor::{Reason, State, Transition};
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
}

impl CutReason {
    fn from_code(code: u8) -> Self {
        match code {
            2 => Self::ManualDisarm,
            3 => Self::SupervisorFault,
            4 => Self::LoopSilent,
            5 => Self::Shutdown,
            6 => Self::SlotPoisoned,
            7 => Self::GateFailed,
            8 => Self::GateEnded,
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
                reason: CutReason::from_code(u8::try_from(code).unwrap_or(1)),
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

/// Proof that the supervisor has just carried out a manual activation. The only way to obtain
/// an [`ArmTicket`].
#[derive(Debug)]
pub struct ManualArm(());

impl ManualArm {
    /// `Some` only for the supervisor's transition Armed -> Active with
    /// [`Reason::ManualActivate`]. A safety event, a timeout, a fault reset or a shutdown never
    /// produces one.
    pub fn from_activation(transition: &Transition) -> Option<Self> {
        (transition.reason == Reason::ManualActivate
            && transition.from == State::Armed
            && transition.to == State::Active)
            .then_some(Self(()))
    }
}

/// Permission to open the latch once, valid only while no cut or open happened since it was
/// issued. Neither `Clone` nor `Copy`: [`GateLatch::open`] consumes it.
#[derive(Debug, Eq, PartialEq)]
pub struct ArmTicket {
    generation: u64,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum AuthorizeError {
    /// The latch is already open; it must be cut before a new arm sequence.
    AlreadyOpen,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum OpenError {
    /// A cut or another open happened since the ticket was issued (a late open).
    Stale,
    /// The generation counter is exhausted; the latch stays closed for good.
    Exhausted,
}

/// The cut latch. See the module documentation for the exact semantics.
#[derive(Debug)]
pub struct GateLatch {
    word: AtomicU64,
}

impl GateLatch {
    fn new() -> Self {
        Self {
            word: AtomicU64::new(word(0, CutReason::Initial as u64)),
        }
    }

    pub fn state(&self) -> LatchState {
        LatchState::of(self.word.load(SeqCst))
    }

    fn raw(&self) -> u64 {
        self.word.load(SeqCst)
    }

    /// Closes the latch (or keeps it closed) and advances the generation. Never waits beyond
    /// a compare-and-swap retry when another thread changed the word at the same moment.
    pub fn cut(&self, reason: CutReason) -> CutOutcome {
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

    /// Issues a ticket for the current closed generation.
    pub fn authorize(&self, _proof: ManualArm) -> Result<ArmTicket, AuthorizeError> {
        match self.state() {
            LatchState::Open { .. } => Err(AuthorizeError::AlreadyOpen),
            LatchState::Closed { generation, .. } => Ok(ArmTicket { generation }),
        }
    }

    /// Opens the latch if nothing happened since the ticket was issued. Returns the open
    /// epoch, which every command for this activation must carry.
    pub fn open(&self, ticket: ArmTicket) -> Result<u64, OpenError> {
        let epoch = ticket.generation + 1;
        if epoch >= MAX_GENERATION {
            return Err(OpenError::Exhausted);
        }
        let current = self.word.load(SeqCst);
        if current >> CODE_BITS != ticket.generation || current & CODE_MASK == OPEN_CODE {
            return Err(OpenError::Stale);
        }
        self.word
            .compare_exchange(current, word(epoch, OPEN_CODE), SeqCst, SeqCst)
            .map(|_| epoch)
            .map_err(|_| OpenError::Stale)
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
    /// The latch epoch the command was computed for (the value [`GateLatch::open`] returned).
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
}

/// Counters of the gate, for diagnostics and tests. Never used for a decision.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct GateStats {
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
}

#[derive(Debug)]
struct Shared {
    latch: GateLatch,
    slot: Mutex<Option<SlotEntry>>,
    /// Beaten by the control loop through its [`CommandWriter`].
    loop_heartbeat: Heartbeat,
    /// Beaten by every gate step, and by nothing else.
    gate_alive: Heartbeat,
    /// True while a gate thread runs its loop.
    running: AtomicBool,
    stop: AtomicBool,
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

    fn stats(&self) -> GateStats {
        let c = &self.counters;
        GateStats {
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
        }
    }
}

/// A new gate: the link (latch, health, statistics), the control loop's single writer and the
/// runner that becomes the gate thread. `start` is the origin of both heartbeats: a control
/// loop or a gate that never runs is detected like one that stops.
pub fn gate(start: Instant) -> (GateLink, CommandWriter, GateRunner) {
    let shared = Arc::new(Shared {
        latch: GateLatch::new(),
        slot: Mutex::new(None),
        loop_heartbeat: Heartbeat::new(start),
        gate_alive: Heartbeat::new(start),
        running: AtomicBool::new(false),
        stop: AtomicBool::new(false),
        counters: Counters::default(),
    });
    (
        GateLink {
            shared: shared.clone(),
        },
        CommandWriter {
            shared: shared.clone(),
            sequence: 0,
        },
        GateRunner {
            shared,
            open_seen: None,
        },
    )
}

// ---- control loop side ----

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

/// Why the control loop considers the gate failed.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum GateFailure {
    /// No gate thread runs (never started, stopped, or ended).
    NotRunning,
    /// The gate ran no step for longer than [`GATE_SILENCE_LIMIT`].
    Silent { silent_for: Duration },
}

/// Shared access to the latch, the gate's health and its statistics. Cheap to clone; every
/// method is a few atomic operations and never waits.
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

    pub fn authorize(&self, proof: ManualArm) -> Result<ArmTicket, AuthorizeError> {
        self.shared.latch.authorize(proof)
    }

    pub fn open(&self, ticket: ArmTicket) -> Result<u64, OpenError> {
        self.shared.latch.open(ticket)
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
}

/// The gate's logic, owned by the gate thread ([`GateRunner::spawn`]) or, in tests, driven
/// step by step with explicit times ([`GateRunner::step`]).
#[derive(Debug)]
pub struct GateRunner {
    shared: Arc<Shared>,
    /// The open epoch the gate last saw. A disarm is owed while it differs from the current
    /// open epoch.
    open_seen: Option<u64>,
}

impl GateRunner {
    /// One gate period at `now`. See the module documentation for the order.
    pub fn step<P: OutputPort>(&mut self, now: Instant, port: &mut P) -> StepReport {
        // A second reference to the shared state, so `settle` may borrow the runner mutably.
        let shared_arc = self.shared.clone();
        let shared = &*shared_arc;
        let counters = &shared.counters;
        shared.gate_alive.beat(now);
        let mut report = StepReport::default();

        let mut raw = shared.latch.raw();
        if LatchState::of(raw).is_open()
            && shared.loop_heartbeat.silent_for(now) > LOOP_SILENCE_LIMIT
        {
            shared.latch.cut(CutReason::LoopSilent);
            counters.loop_silence_cuts.fetch_add(1, SeqCst);
            report.cut_loop_silent = true;
            raw = shared.latch.raw();
        }
        self.settle(LatchState::of(raw), port, &mut report);

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
        self.open_seen = Some(epoch);

        let entry = match shared.take() {
            SlotRead::Entry(entry) => entry,
            SlotRead::Empty => return report,
            SlotRead::Busy => {
                counters.read_busy.fetch_add(1, SeqCst);
                return report;
            }
            SlotRead::Poisoned => {
                shared.latch.cut(CutReason::SlotPoisoned);
                self.settle(shared.latch.state(), port, &mut report);
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
            self.settle(shared.latch.state(), port, &mut report);
            return report;
        }
        let bytes = encode(&WireMessage::Command(command.command));
        match port.write(&bytes) {
            Delivery::NotTransmitted => {}
        }
        counters.commands_written.fetch_add(1, SeqCst);
        report.command_written = true;
        // A cut that arrived during the write is answered at once.
        self.settle(shared.latch.state(), port, &mut report);
        report
    }

    /// Writes the owed disarm, once, if the open epoch the gate saw is no longer open.
    fn settle<P: OutputPort>(&mut self, state: LatchState, port: &mut P, report: &mut StepReport) {
        let Some(seen) = self.open_seen else {
            return;
        };
        if state == (LatchState::Open { epoch: seen }) {
            return;
        }
        self.open_seen = None;
        let bytes = encode(&WireMessage::Disarm);
        match port.write(&bytes) {
            Delivery::NotTransmitted => {}
        }
        self.shared.counters.disarms_written.fetch_add(1, SeqCst);
        report.disarm_written = true;
    }

    /// Starts the gate thread. It runs a step every [`GATE_PERIOD`] (at least) until
    /// [`GateHandle::stop`]; then it cuts the latch, writes the owed disarm and ends.
    pub fn spawn<P: OutputPort>(self, port: P) -> std::io::Result<GateHandle> {
        let shared = self.shared.clone();
        let (done_tx, done_rx) = mpsc::channel();
        shared.running.store(true, SeqCst);
        let spawned = thread::Builder::new()
            .name("roadpilot-gate".into())
            .spawn(move || run_gate(self, port, done_tx));
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

fn run_gate<P: OutputPort>(mut runner: GateRunner, mut port: P, done: mpsc::Sender<()>) {
    let _guard = RunningGuard {
        shared: runner.shared.clone(),
        done,
    };
    while !runner.shared.stop.load(SeqCst) {
        runner.step(Instant::now(), &mut port);
        thread::park_timeout(GATE_PERIOD);
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
    /// writes the owed disarm before it ends.
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
        if let Some(thread) = &self.thread {
            thread.thread().unpark();
        }
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
    use super::super::supervisor::SafetyEvent;
    use super::*;
    use std::sync::Barrier;
    use std::sync::atomic::AtomicUsize;

    fn ms(n: u64) -> Duration {
        Duration::from_millis(n)
    }

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

    impl RecordingPort {
        fn all(&self) -> Vec<[u8; MESSAGE_LEN]> {
            self.messages.lock().unwrap().clone()
        }
        fn disarms(&self) -> usize {
            let disarm = encode(&WireMessage::Disarm);
            self.all().iter().filter(|m| **m == disarm).count()
        }
        fn commands(&self) -> usize {
            self.all().len() - self.disarms()
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

    fn activation() -> Transition {
        Transition {
            from: State::Armed,
            to: State::Active,
            reason: Reason::ManualActivate,
        }
    }

    fn open(link: &GateLink) -> u64 {
        let ticket = link
            .authorize(ManualArm::from_activation(&activation()).unwrap())
            .unwrap();
        link.open(ticket).unwrap()
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

    /// A gate driven step by step on an explicit clock (no thread).
    struct Rig {
        t0: Instant,
        link: GateLink,
        writer: CommandWriter,
        runner: GateRunner,
        port: RecordingPort,
    }

    impl Rig {
        fn new() -> Self {
            let t0 = Instant::now();
            let (link, writer, runner) = gate(t0);
            Self {
                t0,
                link,
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

    // ---- latch and authorization ----

    #[test]
    fn the_gate_starts_closed_and_writes_nothing() {
        let mut rig = Rig::new();
        assert_eq!(
            rig.link.state(),
            LatchState::Closed {
                generation: 0,
                reason: CutReason::Initial
            }
        );
        // Even a command for the epoch the next open would have is not written.
        rig.publish(1, 0);
        for t in (0..500).step_by(10) {
            assert_eq!(rig.step(t), StepReport::default());
        }
        assert!(rig.port.all().is_empty());
        assert_eq!(rig.link.stats().discarded_closed, 1);
    }

    #[test]
    fn a_manual_activation_and_only_that_authorizes_an_open() {
        let mut rig = Rig::new();
        let epoch = open(&rig.link);
        assert_eq!(epoch, 1);
        assert_eq!(rig.link.state(), LatchState::Open { epoch: 1 });
        rig.publish(epoch, 5);
        assert!(rig.step(10).command_written);
        assert_eq!(rig.port.all(), vec![command_bytes()]);
        // Every other transition yields no proof.
        let others = [
            (State::Disabled, State::Armed, Reason::ManualArm),
            (State::Fault, State::Disabled, Reason::FaultReset),
            (State::Active, State::Disabled, Reason::ManualDisarm),
            (State::Active, State::Disabled, Reason::Shutdown),
            (
                State::Active,
                State::Fault,
                Reason::Safety(SafetyEvent::SupervisorTimeout {
                    silent_for: ms(150),
                }),
            ),
            // The right reason on the wrong states.
            (State::Disabled, State::Active, Reason::ManualActivate),
        ];
        for (from, to, reason) in others {
            let t = Transition { from, to, reason };
            assert!(ManualArm::from_activation(&t).is_none(), "{t:?}");
        }
    }

    #[test]
    fn an_open_latch_cannot_be_authorized_again_and_a_ticket_opens_once() {
        let rig = Rig::new();
        let proof = || ManualArm::from_activation(&activation()).unwrap();
        let ticket = rig.link.authorize(proof()).unwrap();
        let same = ArmTicket {
            generation: ticket.generation,
        };
        assert_eq!(rig.link.open(ticket), Ok(1));
        assert_eq!(
            rig.link.authorize(proof()),
            Err(AuthorizeError::AlreadyOpen)
        );
        // A second ticket for the same generation (a replay) is refused.
        assert_eq!(rig.link.open(same), Err(OpenError::Stale));
        assert_eq!(rig.link.state(), LatchState::Open { epoch: 1 });
    }

    #[test]
    fn a_late_open_never_overrides_a_cut() {
        let rig = Rig::new();
        let ticket = rig
            .link
            .authorize(ManualArm::from_activation(&activation()).unwrap())
            .unwrap();
        // The cut comes between the authorization and the open, on a closed latch.
        assert_eq!(
            rig.link.cut(CutReason::LoopSilent),
            CutOutcome::AlreadyClosed
        );
        assert_eq!(rig.link.open(ticket), Err(OpenError::Stale));
        assert_eq!(
            rig.link.state(),
            LatchState::Closed {
                generation: 1,
                reason: CutReason::Initial
            },
            "closed, first reason kept, generation advanced"
        );
    }

    #[test]
    fn a_cut_closes_with_its_reason_and_the_first_reason_is_kept() {
        let rig = Rig::new();
        let epoch = open(&rig.link);
        assert_eq!(
            rig.link.cut(CutReason::ManualDisarm),
            CutOutcome::Closed { epoch }
        );
        assert_eq!(
            rig.link.cut(CutReason::LoopSilent),
            CutOutcome::AlreadyClosed
        );
        assert_eq!(
            rig.link.state(),
            LatchState::Closed {
                generation: epoch + 2,
                reason: CutReason::ManualDisarm
            }
        );
        // The next manual activation opens a new, higher epoch.
        assert_eq!(open(&rig.link), epoch + 3);
    }

    #[test]
    fn concurrent_cuts_always_win_over_a_racing_late_open() {
        // Many threads cut while another opens with a ticket issued before the cuts. Whatever
        // the interleaving, the latch ends closed: an open after a cut fails, a cut after the
        // open closes.
        for _ in 0..300 {
            let rig = Rig::new();
            let link = rig.link.clone();
            let ticket = link
                .authorize(ManualArm::from_activation(&activation()).unwrap())
                .unwrap();
            let barrier = Arc::new(Barrier::new(5));
            let mut threads = Vec::new();
            for _ in 0..4 {
                let link = link.clone();
                let barrier = barrier.clone();
                threads.push(thread::spawn(move || {
                    barrier.wait();
                    link.cut(CutReason::SupervisorFault);
                }));
            }
            let opener = {
                let link = link.clone();
                let barrier = barrier.clone();
                thread::spawn(move || {
                    barrier.wait();
                    link.open(ticket)
                })
            };
            for t in threads {
                t.join().unwrap();
            }
            let opened = opener.join().unwrap();
            let state = link.state();
            assert!(!state.is_open(), "{opened:?} {state:?}");
            if let LatchState::Closed { generation, .. } = state {
                let expected = if opened.is_ok() { 5 } else { 4 };
                assert_eq!(generation, expected);
            }
        }
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
        ] {
            let w = word(42, reason as u64);
            assert_eq!(
                LatchState::of(w),
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
    }

    #[test]
    fn an_exhausted_generation_keeps_the_latch_closed() {
        let latch = GateLatch {
            word: AtomicU64::new(word(MAX_GENERATION - 1, CutReason::Initial as u64)),
        };
        let ticket = latch
            .authorize(ManualArm::from_activation(&activation()).unwrap())
            .unwrap();
        assert_eq!(latch.open(ticket), Err(OpenError::Exhausted));
        latch.cut(CutReason::LoopSilent);
        latch.cut(CutReason::LoopSilent);
        assert!(!latch.state().is_open());
        let ticket = latch
            .authorize(ManualArm::from_activation(&activation()).unwrap())
            .unwrap();
        assert_eq!(latch.open(ticket), Err(OpenError::Exhausted));
    }

    // ---- gate behaviour ----

    #[test]
    fn the_loop_heartbeat_is_watched_and_silence_cuts_with_one_disarm() {
        let mut rig = Rig::new();
        let epoch = open(&rig.link);
        rig.step(0);
        // The loop beats at 0 and goes silent. Exactly at the limit nothing happens.
        let silent_start = 0;
        for t in (10..=100).step_by(10) {
            assert_eq!(rig.step_silent(silent_start + t), StepReport::default());
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
        let epoch = open(&rig.link);
        for t in (0..100).step_by(10) {
            rig.publish(epoch, t);
            assert!(rig.step(t).command_written);
        }
        // Cut from several sources, several times.
        rig.link.cut(CutReason::SupervisorFault);
        rig.link.cut(CutReason::ManualDisarm);
        rig.link.cut(CutReason::GateFailed);
        for t in (100..600).step_by(10) {
            // The loop keeps publishing commands of the old epoch: none is written.
            rig.publish(epoch, t);
            rig.step(t);
        }
        assert_eq!(rig.port.commands(), 10);
        assert_eq!(rig.port.disarms(), 1);
        assert_eq!(
            *rig.port.all().last().unwrap(),
            encode(&WireMessage::Disarm)
        );
        assert_eq!(rig.link.stats().discarded_closed, 50);
    }

    #[test]
    fn a_command_of_an_old_epoch_is_discarded_after_a_new_open() {
        let mut rig = Rig::new();
        let first = open(&rig.link);
        rig.step(0);
        rig.link.cut(CutReason::ManualDisarm);
        let second = open(&rig.link);
        assert!(second > first);
        // A command computed for the first epoch arrives after the new open.
        rig.publish(first, 5);
        let report = rig.step(10);
        assert!(!report.command_written);
        // Cut and reopen happened within one period: the disarm for the first epoch is still
        // written, exactly once.
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
        let epoch = open(&rig.link);
        rig.publish(epoch, 100);
        assert!(rig.step(150).command_written, "exactly at the limit");
        rig.publish(epoch, 200);
        let report = rig.step(251);
        assert!(!report.command_written);
        assert_eq!(rig.link.stats().discarded_stale, 1);
        assert!(
            rig.link.state().is_open(),
            "a stale command alone is no cut"
        );
        // A stale command is not kept for later either.
        assert!(!rig.step(260).command_written);
        assert_eq!(rig.port.commands(), 1);
    }

    #[test]
    fn a_newer_command_replaces_an_unread_one_and_each_is_written_at_most_once() {
        let mut rig = Rig::new();
        let epoch = open(&rig.link);
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
        let epoch = open(&rig.link);
        rig.step(0);
        // Computed and published before the cut, not yet taken by the gate.
        rig.publish(epoch, 5);
        rig.link.cut(CutReason::SupervisorFault);
        let report = rig.step(10);
        assert!(!report.command_written);
        assert!(report.disarm_written);
        assert_eq!(rig.link.stats().discarded_closed, 1);
        // Nothing is left over for a later open either.
        let next = open(&rig.link);
        assert!(!rig.step(20).command_written);
        rig.publish(next, 25);
        assert!(rig.step(30).command_written);
        assert_eq!(rig.port.commands(), 1);
    }

    #[test]
    fn the_gate_never_opens_by_itself() {
        let mut rig = Rig::new();
        // Loop silent, loop alive, commands of every epoch, thousands of steps: still closed.
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
        let epoch = open(&rig.link);
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

    // ---- real threads ----

    #[test]
    fn concurrent_writes_and_reads_are_race_free_and_never_torn_or_reordered() {
        // The control loop's writer and a reader that takes as the gate does run on two
        // threads at full speed. Every field of every entry read must belong to the same
        // write (no tearing), sequences must strictly increase (no reordering, nothing read
        // twice), and every command must be accounted for.
        const N: u64 = 200_000;
        let base = Instant::now();
        let (_link, mut writer, runner) = gate(base);
        let shared = runner.shared.clone();
        let done = Arc::new(AtomicBool::new(false));
        let limits = ControlLimits::default();

        let reader = {
            let shared = shared.clone();
            let done = done.clone();
            thread::spawn(move || {
                let deadline = Instant::now() + Duration::from_secs(60);
                let (mut last, mut taken, mut busy) = (0u64, 0u64, 0u64);
                loop {
                    let finished = done.load(SeqCst);
                    match shared.take() {
                        SlotRead::Entry(e) => {
                            let s = e.sequence;
                            assert!(s > last, "sequence {s} after {last}");
                            last = s;
                            taken += 1;
                            // Every field derives from the same sequence number.
                            assert_eq!(e.command.epoch, s);
                            assert_eq!(
                                e.command.computed_at.duration_since(base),
                                Duration::from_nanos(s)
                            );
                            let brake = f32::from(u16::try_from(s % 1_000).unwrap()) / 1_000.0;
                            assert_eq!(e.command.command.brake(), brake);
                        }
                        SlotRead::Empty if finished => break,
                        SlotRead::Empty => std::hint::spin_loop(),
                        SlotRead::Busy => busy += 1,
                        SlotRead::Poisoned => panic!("poisoned"),
                    }
                    assert!(Instant::now() < deadline, "the reader must finish");
                }
                (taken, busy)
            })
        };

        let (mut stored, mut replaced, mut busy) = (0u64, 0u64, 0u64);
        for _ in 0..N {
            // The sequence number this write gets if it is stored (a busy write gets none).
            let s = writer.sequence + 1;
            let brake = f32::from(u16::try_from(s % 1_000).unwrap()) / 1_000.0;
            let outcome = writer.publish(GateCommand {
                command: ControlCommand::new(&limits, None, 0.0, brake).unwrap(),
                epoch: s,
                computed_at: base + Duration::from_nanos(s),
            });
            match outcome {
                PublishOutcome::Stored => stored += 1,
                PublishOutcome::Replaced => replaced += 1,
                PublishOutcome::Busy => busy += 1,
                PublishOutcome::Poisoned => panic!("poisoned"),
            }
        }
        done.store(true, SeqCst);
        let (taken, _read_busy) = reader.join().expect("the reader thread");
        // Every stored or replacing write put one command in; each was taken or replaced.
        assert_eq!(stored + replaced, taken + replaced);
        assert_eq!(stored + replaced + busy, N);
        assert_eq!(writer.sequence, stored + replaced);
        assert_eq!(shared.stats().replaced, replaced);
        assert_eq!(shared.stats().publish_busy, busy);
        assert!(taken > 0);
    }

    #[test]
    fn the_gate_thread_writes_commands_and_stops_with_one_disarm() {
        let start = Instant::now();
        let (link, mut writer, runner) = gate(start);
        let port = RecordingPort::default();
        let handle = runner.spawn(port.clone()).unwrap();
        let epoch = open(&link);
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
        assert_eq!(*port.all().last().unwrap(), encode(&WireMessage::Disarm));
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
        let start = Instant::now();
        let (link, writer, runner) = gate(start);
        let port = RecordingPort::default();
        let handle = runner.spawn(port.clone()).unwrap();
        writer.beat(Instant::now());
        let epoch = open(&link);
        // The loop never beats again.
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
        let start = Instant::now();
        let (link, mut writer, runner) = gate(start);
        let blocked = Arc::new(AtomicBool::new(true));
        let port = BlockingPort {
            blocked: blocked.clone(),
            writes: Arc::new(AtomicUsize::new(0)),
        };
        let handle = runner.spawn(port.clone()).unwrap();
        let epoch = open(&link);
        // Wait until the gate is stuck in its first write.
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
        // The loop keeps running at its own pace; no publish waits for the stuck gate.
        let mut slowest = Duration::ZERO;
        let mut detected = None;
        for _ in 0..100 {
            let now = Instant::now();
            writer.beat(now);
            let before = Instant::now();
            let outcome = writer.publish(command(epoch, now));
            slowest = slowest.max(before.elapsed());
            assert_ne!(
                outcome,
                PublishOutcome::Busy,
                "the gate holds no lock while writing"
            );
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
        // Release the port; the gate notices the cut, writes its disarm and stops.
        blocked.store(false, SeqCst);
        handle.stop(Duration::from_secs(5)).expect("the gate ends");
    }

    #[test]
    fn stopping_a_gate_stuck_in_its_port_times_out_and_can_be_finished_later() {
        let (link, _writer, runner) = gate(Instant::now());
        let blocked = Arc::new(AtomicBool::new(true));
        let port = BlockingPort {
            blocked: blocked.clone(),
            writes: Arc::new(AtomicUsize::new(0)),
        };
        let handle = runner.spawn(port.clone()).unwrap();
        open(&link);
        // Let the gate see the open epoch, then cut: its disarm blocks in the port.
        thread::sleep(ms(50));
        link.cut(CutReason::ManualDisarm);
        let deadline = Instant::now() + Duration::from_secs(10);
        while port.writes.load(SeqCst) == 0 {
            thread::sleep(ms(2));
            assert!(Instant::now() < deadline, "the gate must reach the port");
        }
        let StopTimeout(handle) = handle
            .stop(ms(50))
            .expect_err("the gate is stuck in its port");
        assert!(!link.state().is_open());
        blocked.store(false, SeqCst);
        handle.stop(Duration::from_secs(5)).expect("the gate ends");
    }

    #[test]
    fn a_gate_that_ends_unexpectedly_is_detected_and_cuts() {
        let start = Instant::now();
        let (link, mut writer, runner) = gate(start);
        // Before the gate runs, the loop sees it as not running.
        assert_eq!(link.check_gate(start), Err(GateFailure::NotRunning));
        let handle = runner.spawn(PanickingPort).unwrap();
        let epoch = open(&link);
        let deadline = Instant::now() + Duration::from_secs(10);
        // The first command makes the port panic and the gate thread end.
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
        let (link, _writer, runner) = gate(Instant::now());
        let handle = runner.spawn(DryRunPort).unwrap();
        open(&link);
        drop(handle);
        assert!(!link.state().is_open());
        let deadline = Instant::now() + Duration::from_secs(10);
        while link.check_gate(Instant::now()) != Err(GateFailure::NotRunning) {
            thread::sleep(ms(5));
            assert!(Instant::now() < deadline, "the gate must end");
        }
    }

    #[test]
    fn the_dry_run_port_is_the_only_port_and_transmits_nothing() {
        let mut port = DryRunPort;
        assert_eq!(port.mode(), OperatingMode::DryRun);
        assert_eq!(port.write(&[0; MESSAGE_LEN]), Delivery::NotTransmitted);
    }

    #[test]
    fn the_gate_is_independent_of_the_async_runtime_the_log_the_status_and_the_loop() {
        // Assembled from parts so that this list does not match itself.
        let forbidden = [
            ["to", "kio"].concat(),
            ["Control", "Log"].concat(),
            ["super::", "log"].concat(),
            ["super::", "status"].concat(),
            ["Status", "Cell"].concat(),
            ["super::", "runtime"].concat(),
            ["super::", "sender"].concat(),
            ["Pipe", "Port"].concat(),
        ];
        for (number, line) in include_str!("gate.rs").lines().enumerate() {
            if line.trim_start().starts_with("//") {
                continue;
            }
            for needle in &forbidden {
                assert!(
                    !line.contains(needle.as_str()),
                    "control/gate.rs:{} mentions `{needle}`: {line}",
                    number + 1
                );
            }
        }
    }

    #[test]
    fn the_limits_are_consistent() {
        assert_eq!(LOOP_SILENCE_LIMIT, ms(100));
        assert_eq!(GATE_PERIOD, ms(10));
        assert_eq!(MAX_COMMAND_AGE, ms(50));
        assert!(GATE_PERIOD < MAX_COMMAND_AGE);
        assert!(MAX_COMMAND_AGE < LOOP_SILENCE_LIMIT);
        // Within the input plugin's 150 ms steering timeout.
        assert!(LOOP_SILENCE_LIMIT < ms(150));
        assert!(GATE_SILENCE_LIMIT < ms(150));
    }
}
